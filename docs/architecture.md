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
