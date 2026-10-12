# Higgsfield Studio

Dashboard and studio for managing Higgsfield API spend, engineering prompts with Claude, building automated workflows, browsing generated media, and monitoring everything in real time.

- **Frontend:** React 18 · TypeScript · Vite · Tailwind (dark, slate‑950) · React Router · Recharts · React Flow · Socket.IO client
- **Backend:** Node 20+ · Express · TypeScript · Socket.IO · Zod · PostgreSQL (`pg`; embedded PGlite for zero‑setup dev)
- **Integrations:** Anthropic SDK (Claude), Clerk (auth), S3‑compatible storage (presigned uploads), Higgsfield (adapter – see [Status](#status--honest-limits))

## Quick start (dev)

Requires Node 20+. No database, accounts or API keys are needed to try it.

```bash
npm run install:all          # installs backend + frontend
cp backend/.env.example backend/.env
npm run dev:backend          # http://localhost:4000  (embedded Postgres + demo data on first boot)
npm run dev:frontend         # http://localhost:5173  (proxies /api and /socket.io to :4000)
```

Open http://localhost:5173 and pick a demo account on the sign‑in screen:

| Account | Role | Can |
|---|---|---|
| Demo Admin | admin | everything: API keys, team, billing, settings |
| Demo User | user | create/run prompts & workflows, manage media |
| Demo Viewer | viewer | read‑only |

Until you add an Anthropic key (**Settings → API keys**, or `ANTHROPIC_API_KEY`), prompt and workflow runs return **clearly labelled simulated responses** (and the demo data is flagged as simulated everywhere it's shown). Add a key and the same screens run real, billable Claude calls.

Other commands: `npm test` (backend tests) · `npm run typecheck` · `npm run build`.

## What's in it

| Area | Highlights |
|---|---|
| **Overview** | KPI cards with period‑over‑period deltas, monthly budget bar, stacked spend chart, usage breakdown by model / workflow / provider, recent runs, live status, CSV + PDF export |
| **Studio** | A Higgsfield-style playground. 19 real Higgsfield models, each with its documented modes (text → image/video, image → video, reference → video, edit, motion control): Soul 2, Grok Imagine, Ideogram 4, Recraft 4.1, Qwen Image 3, Z-Image Turbo, Kling 3.0 (Standard/Pro/4K/Turbo/Motion Control), Seedance 2.5 and 2.0, Wan 3.0, MiniMax H3, Genjutsu Motion Transfer, LTX 2.5. Inputs: **upload from your computer**, pick from your library, or paste a link, for start/end frames, reference images, video and audio. **Characters (Soul ID)**: train a character from photos and reuse it in Soul 2. "Animate" any generated image into a video. Live progress, gallery, "use this prompt". Results land in the media timeline, count as spend, show in Monitoring, and are available as a **Generate** node in workflows |
| **Studio** | A Higgsfield-style playground. 19 real Higgsfield models, each with its documented modes (text → image/video, image → video, reference → video, edit, motion control): Soul 2, Grok Imagine, Ideogram 4, Recraft 4.1, Qwen Image 3, Z-Image Turbo, Kling 3.0 (Standard/Pro/4K/Turbo/Motion Control), Seedance 2.5 and 2.0, Wan 3.0, MiniMax H3, Genjutsu Motion Transfer, LTX 2.5. Inputs: **upload from your computer**, pick from your library, or paste a link, for start/end frames, reference images, video and audio. **Characters (Soul ID)**: train a character from photos and reuse it in Soul 2. "Animate" any generated image into a video. Live progress, gallery, "use this prompt". Results land in the media timeline, count as spend, show in Monitoring, and are available as a **Generate** node in workflows |
| **Workflows** | React Flow editor with Trigger / LLM / Transform / Action / Output nodes, connection rules (no cycles, no inputs into triggers…), live validation, save to backend, run with live per‑node status + logs, run history, template library, scheduled triggers |
| **Media** | Day‑grouped timeline with infinite scroll (keyset pagination), filters (date range, type, tag, workflow, text), accessible lightbox with video player and keyboard nav, CSV/JSON export, add by URL or upload to S3 |
| **Monitoring** | Live Socket.IO log stream with level/type/status/workflow/text filters + pause, active jobs, alerts, health/latency/queue tiles, rolling performance chart |
| **Settings** | Encrypted API keys, model defaults, S3 config, team & roles, budget + alert threshold, data export |
| **Platform** | Role‑based access (admin/user/viewer), org‑scoped data, Postgres schema + migrations, job queue + execution engine, cost tracking, budget alerts, global search (Ctrl/⌘+K) |

## Configuration

Copy `backend/.env.example` → `backend/.env` (and `frontend/.env.example` → `frontend/.env` if needed). Every variable is documented in those files. The important ones:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string. Empty = embedded PGlite (dev only; required in production) |
| `AUTH_PROVIDER` | `dev` (seeded accounts; refuses to start in production) or `clerk` |
| `CLERK_SECRET_KEY`, `VITE_CLERK_PUBLISHABLE_KEY` | Clerk backend/frontend keys when `AUTH_PROVIDER=clerk` |
| `SECRETS_ENCRYPTION_KEY` | 32‑byte key (hex) that encrypts API keys at rest. **Required in production; back it up** |
| `ANTHROPIC_API_KEY` | Optional global fallback; orgs can store their own in Settings |
| `HIGGSFIELD_API_KEY`, `HIGGSFIELD_API_BASE` | Optional server‑level fallbacks. Normally set in the app instead: key under **Settings → API keys** (format `id:secret`), API address under **Settings → Higgsfield** |
| `CLIENT_ORIGIN` | Allowed browser origins for cross‑origin API use |

### Database

Migrations are append‑only TypeScript in `backend/src/db/migrations.ts` and run automatically at boot (`npm --prefix backend run migrate` runs them standalone). Point `DATABASE_URL` at any Postgres 14+ (needs `gen_random_uuid()`, built in since 13).

### Authentication (Clerk)

Set `AUTH_PROVIDER=clerk`, `CLERK_SECRET_KEY`, and build the frontend with `VITE_CLERK_PUBLISHABLE_KEY`. The Clerk session JWT is the bearer token for REST and Socket.IO. **Roles live in this app's database**: the first user to sign in bootstraps a new organisation as its admin; admins invite teammates by email (Settings → Team) and the invite is linked when that person signs in with the same email.

## Deployment

Environments: **dev** (above), **staging** and **production** via Docker Compose:

```bash
cp deploy/env.production.example deploy/.env.production   # fill in; see comments
docker compose --env-file deploy/.env.production up -d --build
# → http://localhost:8080 (nginx serves the SPA and proxies /api + /socket.io to the backend)
```

Production checklist: managed Postgres + backups · `SECRETS_ENCRYPTION_KEY` stored in a secrets manager · TLS in front of nginx · `CLIENT_ORIGIN` set to your public origin · `AUTH_PROVIDER=clerk` · a single backend replica (see scaling notes in [docs/architecture.md](docs/architecture.md)). CI (`.github/workflows/ci.yml`) typechecks, tests and builds both halves.

## Documentation

- [Architecture](docs/architecture.md) – components, data model, flows, security, scaling
- [API reference](docs/api.md) – every endpoint, roles, and Socket.IO events
- [Frontend components](docs/components.md) – pages, shared UI, state

## Status & honest limits

Verified in development: backend typecheck + **57 automated tests** (auth/RBAC, CORS, queue + workflow engine, media pagination/filters, budgets, secrets encryption, exports…), production build of the frontend, and a manual run‑through of the UI against the live backend (overview, prompt run, workflow run with live node status, monitoring, media + lightbox, tablet layout).

**Not verified against live third‑party services** (no credentials were available when this was built), so test these before relying on them:

- **Anthropic calls with a real key** – code follows the current SDK usage, but only the simulated path was exercised end to end.
- **Clerk sign‑in** (frontend + backend verification + first‑login org bootstrap).
- **S3 presigned uploads** (needs a bucket with a CORS rule allowing `PUT` from your origin).
- **Higgsfield platform coverage.** Studio follows Higgsfield's own API docs and per-model API reference pages (open.higgsfield.ai, read 2026-10-12): `POST api.higgsfield.ai/{model-path}` with `Authorization: Key id:secret`, polling `GET /requests/{id}/status`, uploads via `POST /files/generate-upload-url`, characters via `/v1/custom-references`. **Verified live** with a real account: connection and auth, a real Soul 2 image generation, a real file upload, and listing characters. **Not yet run live**: video models, image-to-image/edit modes, and character training (each costs money; training is about $2.50), so treat those as built from the documentation but unproven. Where the docs don't state a limit (e.g. how many reference images some models accept) the catalog uses a cautious value and says so in the model note. The platform API doesn't report cost, so **you enter a price** per image or per second of video (Settings → Higgsfield); unpriced models are recorded at $0. Higgsfield deletes uploaded inputs after a retention period and keeps outputs for at least 7 days, so download anything you need to keep. There's no API to list past generations, so the gallery shows what was generated through this app.
- **Docker/compose files** were written but not run.

Known gaps / design notes:

- **Models & temperature.** Current Claude models reject non‑default `temperature`, and the API range is 0–1 (not 0–2), so the slider is 0–1 and disabled for models that don't accept it. The 3.x models named in the original brief are retired; the model list (`backend/src/lib/pricing.ts`) is the current lineup. **Prices there are estimates – verify against Anthropic's pricing page.** Costs shown are estimates from reported token usage.
- **Job queue is in‑process** (persisted run state, bounded concurrency). Queued/running jobs are marked failed if the server restarts. Run it as one replica, or swap `services/jobs.ts` for BullMQ/pg‑boss to scale out.
- **No email/Slack alert delivery** – alerts appear in‑app (bell, Monitoring) only.
- **Search is substring (`ILIKE`)**, not full‑text.
- **No SSO/SCIM, audit log, or per‑project permissions**; "projects" exist in the schema but aren't surfaced in the UI.
- Running (not queued) jobs can't be cancelled.
