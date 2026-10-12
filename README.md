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

**On Windows, double-click `start.bat`** in the project folder: it opens the back end and front end in two windows (leave them open) and then the app at http://localhost:5173. Close the two windows to stop. If either half is already running it leaves it alone.

Other commands: `npm test` (backend tests) · `npm run typecheck` · `npm run build`.

## What's in it

| Area | Highlights |
|---|---|
| **Overview** | KPI cards with period‑over‑period deltas, monthly budget bar, stacked spend chart, usage breakdown by model / workflow / provider, recent runs, live status, CSV + PDF export |
| **Studio** | A Higgsfield-style playground. 19 real Higgsfield models, each with its documented modes (text → image/video, image → video, reference → video, edit, motion control): Soul 2, Grok Imagine, Ideogram 4, Recraft 4.1, Qwen Image 3, Z-Image Turbo, Kling 3.0 (Standard/Pro/4K/Turbo/Motion Control), Seedance 2.5 and 2.0, Wan 3.0, MiniMax H3, Genjutsu Motion Transfer, LTX 2.5. Inputs: **upload from your computer**, pick from your library, or paste a link, for start/end frames, reference images, video and audio. **Characters (Soul ID)**: train a character from photos and reuse it in Soul 2. "Animate" any generated image into a video. Live progress, gallery, "use this prompt". Results land in the media timeline, count as spend, show in Monitoring, and are available as a **Generate** node in workflows |
| **Projects** | Make a **micro drama** or an **ad campaign** in one place. Each project has a brief (story bible or brand kit), a **board** of shots or ad units grouped by scene or concept, shared **assets** (characters with Soul IDs, products, logos), a **budget**, and a **chat with Claude (the Director)** that writes the brief, drafts the board, picks models, prices everything and builds workflows. Review the cost, approve takes, and **export** the script, a shot list and the approved clips as a ZIP. Ads add a **variant matrix** (hooks × formats) with the total cost shown before anything is created |
| **Workflows** | React Flow editor with Trigger / LLM / **For each** / Generate / Transform / Action / Output nodes, a **Project cards** trigger, `{{project.*}}` variables, **a cost estimate and confirmation before any run that spends money**, connection rules (no cycles, no inputs into triggers…), live validation, save to backend, run with live per‑node status + logs, run history, template library, scheduled triggers |
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

Verified in development: backend typecheck + **105 automated tests** (auth/RBAC, CORS, queue + workflow engine, media pagination/filters, budgets, secrets encryption, exports…), production build of the frontend, and a manual run‑through of the UI against the live backend (overview, prompt run, workflow run with live node status, monitoring, media + lightbox, tablet layout).

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
- **No SSO/SCIM, audit log, or per‑project permissions**: everyone in an organisation can see all of its projects.
- Running (not queued) jobs can't be cancelled.

## Projects, the Director and spending safeguards

A **project** holds one piece of work (a micro drama or an ad campaign). The chat panel is a Claude assistant (the **Director**) that can read the project and use tools to change it: write the brief, add and edit board cards, choose models from the real Higgsfield catalog, price a set of cards, create ad variants, save workflows and note which characters or products you still need. It is told to keep prompts self-contained and to repeat character and style details, because every generation starts from scratch.

**It can never spend Higgsfield credits.** It has no generate tool. When a set of cards is ready it can mark them "ready to approve"; only a person pressing **Generate** in the cost dialog starts anything. Details:

- The cost dialog lists every item with its model, duration and price, the total, and the project budget left. The server **re-prices** on submit and refuses (409) if the cost went up since you looked, and refuses (402) if the batch would exceed the project budget. Only float rounding is tolerated.
- Workflows that generate media show the same estimate in the Run dialog and need the shown total to be confirmed (the API returns 409 `cost_confirmation_required` otherwise). A for-each step is priced per item; when the list length isn't known up front the figure is a stated ceiling.
- **Scheduled runs never spend.** A scheduled workflow that would generate media is skipped, and an alert tells you to run it by hand.
- The Director's own Claude usage is billed to the project too (shown as "chat" in the spend card).
- Export fetches approved clips only from public https addresses, never the server's own network, and lists anything it couldn't download in `MISSING.txt`.

Verified live: the Director was run against a real Anthropic key (it filled a story bible, added four shots on the cheapest video model, priced them at $0.765, marked them ready, and generated nothing; the turn cost about $0.09 with Sonnet 5.5). **Not run live**: generating a whole board or a for-each workflow against real Higgsfield (the logic is covered by tests against a fake Higgsfield server and the simulated mode), ZIP export of real Higgsfield URLs, and Higgsfield's Marketing Studio / Ads Studio, which this app does not use. Ad variants are produced with the same Studio models as everything else.

## Design & theming

- **Brand colour `#99577A`** (a muted mauve) drives the whole UI: sidebar, buttons, links, charts and highlights. The interface is **light by default** (white rounded cards, soft tinted background, a colored sidebar with a white active pill) with a **dark theme** one click away (moon/sun button in the header; your choice is remembered).
- All colours are CSS variables generated into `frontend/src/theme.css`. To change the brand colour, edit the `brand` scale in `frontend/scripts/generate-theme.cjs` and run `npm --prefix frontend run theme`. Components use theme-aware classes, so nothing else needs touching. Restart `npm run dev:frontend` after changing Tailwind or theme files.
- A muted teal is the secondary colour (second chart series, some badges). White text on the brand colour meets WCAG AA contrast (5.2:1).

## Costs, prices and credit

- **Prices come from Higgsfield itself.** Before you approve a generation, the app asks Higgsfield's estimate endpoint (`POST /estimate/{model}`, a free lookup) for the price of exactly those settings, because price depends on things like sound, resolution and duration. That quote is what the approval dialog shows, what the 409/402 spending gates compare against, and what is recorded as spend. Answers are cached for ten minutes.
- **Fallbacks.** Some models (Seedance, Wan, Genjutsu) are priced by length or tokens, so Higgsfield returns a written description instead of one number. For those, and whenever the lookup fails or you're not connected, the app uses a saved snapshot of list prices (`LIST_PRICES` in `backend/src/services/studioCatalog.ts`, dated `PRICES_AS_OF`). An admin flat price in Settings → Higgsfield always wins.
- **Check prices** (Settings → Higgsfield) compares every model with Higgsfield's current quote and lists what differs. After the launch promotion date passes, the app raises one alert (bell icon) reminding you to run it.
- **Credit left** (Overview): neither service lets this app read a balance with an ordinary key (Anthropic's usage API needs a separate admin key and only reports usage; Higgsfield shows usage in its Console). So you type in the balance you see in each console, and the dashboard subtracts the real spend it records afterwards. It only knows about spend made through this dashboard, demo data is ignored, and a warning is raised when it looks low (under 15% or $2).
- **Live Overview.** The server announces every recorded cost (`usage:new` over Socket.IO), so the Overview, credit figures and charts refresh the moment money is spent, including Director chat.
- The seeded demo data still counts in the Overview's headline spend figure (the notice at the top says so); the credit cards use real spend only.

