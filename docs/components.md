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

A Higgsfield-style playground driven entirely by the catalog data from `GET /studio/models`: model picker (grouped Images / Video) → **mode tabs** (Text → Video, Image → Video, Reference → Video, Edit…) → **inputs** (`MediaSlot` per documented input: Upload from your computer, pick from the library via `LibraryPicker`, or paste a link; thumbnails with remove) → **character** picker for Soul 2 (`CharacterModal` trains a new one from uploaded photos after an explicit cost confirmation) → prompt → settings rendered by `SettingControl` (select, slider, checkbox, text, seed) with an **Advanced** disclosure → cost estimate from the admin-set price (per image, or per second × duration) → Generate (disabled with the reason shown, e.g. "Start frame is required"). Below: an **In progress** strip (live status line from socket logs; failures stay visible for 10 minutes) and a gallery of Studio results (reuses `Lightbox` from `Media.tsx`) with **Prompt** (restore model/mode/settings/prompt), **Animate** (send an image to a video model as its start frame) and **Input** (add to the current mode's image input). Settings → **Higgsfield** holds the API address and per-model prices. The workflow builder has a **Generate** node.

## Projects (`pages/Projects.tsx`, `pages/Project.tsx`, `components/project/*`)

- **Projects**: card grid with spend and approval progress; "New project" asks for a type, name and optional budget.
- **Project**: spend / progress / to-finish summary, then tabs: **Board** (cards grouped by scene or concept, selection bar with a running estimate, an approval banner for cards the Director marked ready), **Story bible / Brand kit** (`BriefPanel`), **Assets** (`AssetsPanel`: upload, library or link, optional Soul ID), **Workflows** (linked workflows and project templates). The **Director** chat (`ChatPanel`) sits beside the tabs on wide screens and becomes a tab on narrow ones. While Claude is working the panel polls and shows each step and refreshes the board.
- `GenerateDialog` is the approval gate: itemised prices, total, budget left, and a button that states the amount. `ItemEditor` edits a card (model, mode, inputs, character, start-frame-from-another-card, settings) and reviews/approves takes. `VariantDialog` previews the cost of a hooks × formats matrix before creating it.
- `components/StudioControls.tsx` holds the setting controls, media slots and library picker shared with the Studio page. `components/Markdown.tsx` renders chat replies without raw HTML.
- Modals re-focus when their `onClose` identity changes, so pass a stable callback (`useCallback`).

