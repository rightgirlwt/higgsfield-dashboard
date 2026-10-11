# Frontend components

`frontend/src` layout:

```
main.tsx            entry
App.tsx             providers + routes (heavy pages lazy-loaded), top-level error boundary
auth/               AuthGate (picks dev login vs Clerk from /health), ClerkAuth (lazy), context (useAuth, useCan)
state/              Toast (aria-live), Realtime (Socket.IO: snapshot, history, logs, jobs, ticks)
lib/                api (fetch wrapper, ApiError, download), hooks (useApi, useDebounced, useInView), format, types
components/         ui.tsx (design system), Shell (layout), SearchPalette
pages/              Overview, PromptStudio, Workflows, WorkflowBuilder, Media, Monitoring, Settings
```

## Providers & data flow

`ToastProvider → AuthGate → RealtimeProvider → BrowserRouter`.

- **`AuthGate`** probes `GET /health`; `auth: "dev"` shows the seeded‑account picker (token in `localStorage`), `auth: "clerk"` lazy‑loads `ClerkAuth`. Either way it provides `{me, signOut, getToken}` via `AuthContext` and configures `lib/api` (token provider + sign‑out on 401).
- **`useCan(role)`** is a UI convenience; the server enforces permissions.
- **`RealtimeProvider`** opens the socket with a token *function* (fresh token on reconnect) and exposes `connected`, `snapshot`, `history` (60 pts), `logs` (500), `jobs` (by run id), plus `runTick`/`alertTick` counters pages use to refetch.
- **`useApi<T>(path|null)`** → `{data, error, loading, reload, setData}`; aborts stale requests.

## Shared UI (`components/ui.tsx`)

| Component | Notes |
|---|---|
| `Card`, `CardHeader`, `PageHeader` | Layout primitives (slate‑900 surfaces, rounded‑2xl) |
| `Button` (`primary/secondary/ghost/danger`, `loading`, `size`) / `IconButton` (requires `label`) | |
| `Badge`, `StatusBadge` | Status is always text + colour |
| `Skeleton`, `Spinner`, `ErrorState` (with retry), `EmptyState` | Every data view uses loading / error / empty states |
| `Modal` | `role="dialog"`, `aria-modal`, focus on open, Tab trap, Escape, focus restore |
| `Field`, `Input`, `Textarea`, `Select` | Labelled controls (width classes override the default `w-full`) |
| `Tabs` (`role=tablist`), `ProgressBar` (`role=progressbar`) | |

## Pages

- **Overview** – range tabs; KPIs (`Kpi`, `Delta`); stacked `BarChart` (Recharts) with an `aria-label` summary; breakdown bars; recent runs; live status; CSV/PDF export through `api.download`.
- **PromptStudio** – library (search + templates filter) / editor / result + history columns. Detects `{{variables}}` and renders inputs; temperature slider disabled when `model.supportsTemperature` is false; `CompareModal` runs variants across models or editor‑vs‑saved‑version. Saving creates version *n+1* (or the first version of a new prompt).
- **Workflows** – list/search, template library modal, create/delete.
- **WorkflowBuilder** – `ReactFlow` with a single custom `FlowNode` for all five node types; `Inspector` forms per type; `isValidConnection` blocks self/duplicate/cyclic edges, inputs into triggers, and edges out of outputs; debounced `POST /workflows/validate`; dirty tracking + `beforeunload` guard; run modal; run panel merges fetched logs with live socket logs and derives per‑node status (`▶`/`✓` log markers). Read‑only for viewers.
- **Media** – keyset‑paginated infinite scroll (`useInView` sentinel + "Load more" fallback), day grouping, filters, `Lightbox` (←/→/Esc, `<video controls>`), `AddMedia` (URL or presigned upload), exports.
- **Monitoring** – status tiles, rolling latency/queue `LineChart`, alerts (ack), jobs table, log stream with filters (server‑side for history, client‑side for live lines) and pause/resume (freezes the view while events keep buffering).
- **Settings** – tabs: API keys (masked, test, remove), Models (defaults + price table), Storage, Team (roles, invite), Billing & alerts, Data export. Admin‑only sections show a notice to other roles.

## Accessibility (WCAG 2.1 oriented)

Skip link and landmarks (`nav`, `main`, `aside`), visible focus ring on every control, labelled form fields, `aria-live` regions for toasts/results/log counts, dialogs with focus management, tables with captions and `scope`, keyboard‑operable lightbox, charts with text alternatives, `prefers-reduced-motion` respected, status never conveyed by colour alone. Not yet audited with a screen reader or automated tooling (axe/Lighthouse) – run one before claiming conformance.

## Studio page (`pages/Studio.tsx`)

Prompt + model picker (grouped Images / Video), settings rendered from the catalog metadata (`SettingControl`: enum → select, range → slider, boolean → checkbox), per-role media slots (`MediaSlot`: paste a public URL or pick a library image via `LibraryPicker`), cost estimate from the admin-set price, **In progress** strip (live status line from socket logs; failures stay visible for 10 minutes), gallery of Studio results (reuses `Lightbox` from `Media.tsx`, "Use this prompt" restores model/settings/prompt). Settings → **Higgsfield** holds the API address and per-model prices. Workflow builder gained a **Generate** node.
