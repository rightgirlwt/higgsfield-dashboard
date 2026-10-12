# Architecture

## Overview

```
┌────────────────────────── Browser (React SPA) ──────────────────────────┐
│ Pages: Overview · Prompt Studio · Workflows(+builder) · Media · Monitor │
│ State: AuthGate → Toast → Realtime(Socket.IO) → Router                  │
└───────────────┬───────────────────────────────────────┬─────────────────┘
        REST /api (Bearer token)                  Socket.IO (token in handshake)
┌───────────────▼───────────────────────────────────────▼─────────────────┐
│ Express app (app.ts)  helmet · CORS · rate limits · zod validation       │
│  authenticate → writesRequireUser → requireRole(...) → routes/*          │
│                                                                          │
│  services/                                                               │
│   claude.ts ──► Anthropic SDK        higgsfield.ts ──► Higgsfield (adapter)
│   jobs.ts (queue + run lifecycle)    workflowEngine.ts (validate + execute)
│   monitoring.ts (snapshots)          scheduler.ts (schedule triggers)    │
│   alerts.ts / usage.ts (budgets)     secrets.ts (AES-256-GCM)            │
└───────────────┬──────────────────────────────────────────────────────────┘
                │ SQL ($1 params)
        ┌───────▼────────┐        ┌───────────────────┐
        │ PostgreSQL     │        │ S3-compatible      │ (presigned PUT, browser → bucket)
        │ (or PGlite dev)│        └───────────────────┘
        └────────────────┘
```

The browser never talks to Anthropic, Higgsfield, or S3 with a secret: API keys live encrypted in Postgres and are only decrypted inside the backend process; uploads use short‑lived presigned URLs.

## Multi‑tenancy and access control

- Every table carries `org_id`; every query filters on `req.user.orgId`. Cross‑org access returns 404 (tested).
- Roles: `viewer < user < admin`. Enforced server‑side in two places: a global rule (non‑GET requires ≥ `user`) and `requireRole('admin')` on settings/secrets/team/billing writes. The UI hides what a role can't do, but the server is the authority.
- **Auth providers.** `AUTH_PROVIDER=dev` resolves `Bearer dev:<user-id>` against seeded users and is refused at startup when `NODE_ENV=production`. `clerk` verifies the Clerk session JWT, then maps `sub` → local user (linking an invited email, or bootstrapping an org + admin on first sign‑in). Sockets use the same resolver and join only `org:<id>`.

## Data model (migration `001_initial_schema`)

| Table | Purpose |
|---|---|
| `organizations` | Tenant; monthly budget + alert threshold |
| `users` | `org_id`, optional `clerk_id`, email (unique), role |
| `org_settings` | JSON key/value per org (`defaults`, `storage`) |
| `secrets` | Encrypted API keys (`ciphertext`, `last4`) |
| `projects` | Grouping for workflows (schema only; not yet surfaced in UI) |
| `prompts` / `prompt_versions` | Prompt identity (+`is_template`, tags) and **immutable** numbered versions |
| `workflows` | `definition` JSONB `{nodes, edges}`, status (`draft/active/paused`), version |
| `job_runs` | One row per prompt or workflow execution: status, tokens, cost, latency, `simulated`, error, input/output JSON |
| `run_logs` | Per‑run log lines (optionally tied to a workflow node) |
| `media_assets` | Photo/video metadata, tags, source workflow/run |
| `usage_events` | Cost ledger rows (provider, model, tokens/units, cost) – the source for all spend charts |
| `alerts` | In‑app notices; a partial unique index makes budget alerts fire once per period |

Costs are `double precision` (estimates, not accounting‑grade money). Counts are cast to `int` in SQL so both `pg` and PGlite return numbers.

## Execution model

1. A route creates a `job_runs` row (`queued`) and calls `queue.enqueue(orgId, runId, work)`.
2. The in‑process queue (`QUEUE_CONCURRENCY`, default 2) atomically claims the run (`queued → running`; a run cancelled while waiting is skipped), runs `work`, then writes `completed`/`failed` with tokens, cost and latency.
3. Every state change emits `job:update`; every log line is persisted and emitted as `log:new`; `monitoring:update` snapshots are pushed every 5 s to orgs with connected sockets.
4. **Prompt runs** await completion (the REST call returns the finished run). **Workflow runs** return `202` immediately and stream progress.
5. `recordUsage` writes a `usage_events` row and runs the budget check (`>= threshold` → warning, `>= 100%` → critical; once per month each).
6. On boot, anything still `queued/running` is marked failed ("Interrupted by server restart").

### Workflow engine

- Definition is validated (`validateWorkflow`): exactly one trigger, known node types, edges reference real nodes, no cycles, no edges into triggers/out of outputs, LLM nodes need a prompt, unreachable nodes warn. The same validator runs on save (`PUT`), activate, run, and live in the builder.
- Execution is a topological walk (Kahn). A node's input is its single predecessor's output (or an object keyed by node id when it has several). Templates can reference `{{input}}`, `{{vars.x}}`, and `{{nodes.<id>.output}}`.
- Node types: **trigger** (manual / schedule / Higgsfield recent generations) · **llm** (Claude call, usage recorded per node) · **transform** (fixed menu: template, JSON parse, pick path, regex, case/trim, split/join – *no code evaluation by design*) · **action** (`log`, `notify` → alert, `save_media` → media timeline) · **output** (sets the run result).
- A failing node fails the run; the error is stored and logged. Schedule triggers run only for `active` workflows (checked every minute).

## Real‑time

Socket.IO events (server → client): `monitoring:update`, `job:update`, `log:new`, `alert:new`. The client (`state/Realtime.tsx`) keeps a bounded log buffer (500) and a rolling 60‑point performance history, and uses a token function in the handshake so reconnects pick up fresh credentials.

## Security notes

- Helmet, strict CORS (allow‑list + same‑origin), JSON body limit 1 MB, rate limits (600/min general, 60/min for run endpoints).
- Zod validation on every body; UUID path params validated; LIKE wildcards escaped; CSV cells neutralised against formula injection; `save_media`/media URLs must be http(s).
- API keys: AES‑256‑GCM with random IV, never returned (only `last4`); `SECRETS_ENCRYPTION_KEY` required in production.
- Prototype‑safe template lookups (own properties only); regex transforms have length caps (a pathological pattern could still be slow – treat workflow authoring as a trusted‑user capability).
- Errors: typed `HttpError`s, Postgres unique violations → 409, everything else → generic 500 with the stack logged server‑side only.

## Scaling and known constraints

- The queue, scheduler and monitoring broadcaster are per‑process. Run **one backend replica** or replace `services/jobs.ts` with a durable queue (BullMQ / pg‑boss) and use the Socket.IO Redis adapter for multi‑instance fan‑out.
- Dashboard queries aggregate `usage_events` directly; add rollup tables if an org reaches millions of events.
- `PGlite` is for development and tests only.

## Studio (Higgsfield generation)

- **Contract.** `services/higgsfield.ts` follows Higgsfield's API docs (docs.higgsfield.ai, open.higgsfield.ai): `POST {base}/{model-path}` with `Authorization: Key <id:secret>` and an `Idempotency-Key`, `GET {base}/requests/{id}/status` (terminal: `completed`, `failed`, `nsfw`, `canceled`; outputs in `images[].url` / `video.url`), uploads via `POST /files/generate-upload-url` + a presigned PUT, and Soul ID characters under `/v1/custom-references`. The base URL is only the host (`https://api.higgsfield.ai`); a pasted model path is trimmed. Network failures surface as clear 502 errors without echoing credentials. Covered by tests against a fake platform server.
- **Catalog is data.** `services/studioCatalog.ts` lists models → modes → `{path, params, media}`, transcribed from each model's API reference page. The same data drives request building (`buildRequest`: numeric enums, on/off and yes/no flags, URL vs URL-list inputs), validation (`resolveSettings`, `resolveMedia`: unknown keys, ranges, required inputs, per-role limits), mode selection (`pickMode`: a start frame selects image-to-video, references select reference-to-video), the browser form, and per-second vs per-image pricing. To add a model, add an entry; nothing else changes.
- **Inputs.** Local files are uploaded server-side to Higgsfield storage (`POST /studio/uploads`) and the returned public URL is used as an input; generated results and uploads are kept in the media library so they can be reused ("Animate" turns an image into a video start frame). Characters are listed from the account and passed as `custom_reference_id` (with strength); creating one requires explicit cost confirmation and is recorded as usage.
- **Execution.** `POST /studio/generate` creates a `job_runs` row (`kind=generation`) and enqueues on a separate wider lane (`generationQueue`, `GENERATION_CONCURRENCY`) so long polls never block prompt/workflow jobs. `runStudioGeneration` submits N requests (or one native batch, e.g. Soul `batch_size`), polls every `STUDIO_POLL_MS` (4 s) up to 10 minutes, tolerates two failed status checks per request, stores each returned URL as a `media_assets` row (`metadata.source='studio'`, with prompt, model, mode and settings), then records one `usage_events` row (`provider='higgsfield'`, units = outputs, cost = admin-set price × outputs × seconds for per-second models). It throws only when nothing was produced; partial success completes with warnings.
- **Simulated mode.** With no key or base URL, requests are fabricated and "complete" after three polls with placeholder media, flagged `simulated`; nothing is billed. Uploads and characters require a real connection.
- **Workflows.** The `generate` node calls the same function inside a workflow run (media is attached to the workflow; spend is recorded against it). The "Higgsfield" trigger reads the most recent Studio results from the database.
- **Retention.** Higgsfield keeps outputs for at least 7 days and marks uploaded inputs temporary, so result and reference URLs can expire; download anything you need to keep.

## Projects and the Director

**Data** (migration 3): `projects` gains `type`, `brief` (jsonb), `budget_usd`, `aspect`; new tables `project_items` (the board: cards with prompt, model, settings, media, status, approved take), `project_assets` (characters/products/logos, optional Soul ID), `chat_threads` and `chat_messages` (the stored Anthropic message blocks, one thread per project). Takes are not a table: a generated asset carries `metadata.projectId/itemId`, so the media library stays the single store.

**Project types are data** (`services/projectTypes.ts`): brief fields, wording and the guidance given to Claude. Adding a type means adding an entry and widening the `projects.type` check in a new migration.

**One way to spend.** Board generation (`services/projects.ts: startGeneration`), workflow generate/for-each steps and the Studio page all end in `runStudioGeneration`, which prices from `LIST_PRICES` or the admin override and records usage. Spending is gated before queueing: the board re-prices and compares with the total the person approved; workflows do the same with `estimateWorkflow`; the scheduler refuses to run a workflow that would spend. A card's status (`draft → ready → generating → review → approved`) is maintained by `generateCard`, which both the board and the for-each node use.

**The Director** (`services/director.ts`) is a manual tool-use loop on the Messages API. The long instructions and tool list are cached (`cache_control`); a per-turn snapshot of the project (brief, assets, board with prices) follows. Stored history is trimmed to start at a plain user message and to never contain a `tool_use` without its `tool_result`. Tool errors go back to Claude as `is_error` results so it can correct itself; a tool call cut off by the token limit is never executed. Costs use cache-aware rates and are recorded as usage and counted against the project. Each turn can be at most 8 rounds.

**Workflow additions.** `foreach` runs a few generations at a time and carries on past item failures; `project` trigger outputs board cards as JSON; `{{project.*}}` variables come from the workflow's project. `estimateWorkflow` prices a run without running it (list length unknown ⇒ `maxItems` ceiling, flagged `upTo`).

**Export** streams a ZIP with `fflate` (flat memory); URLs are only fetched when public https (resolved addresses checked against private, loopback, link-local and IPv4-mapped ranges).
