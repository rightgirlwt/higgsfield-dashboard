# API reference

Base path `/api`. JSON in/out. All routes except `GET /health` and (dev only) `GET /dev/users` require `Authorization: Bearer <token>`.

Errors are `{ "error": { "code": string, "message": string, "details"?: any } }`. Common statuses: `400` validation (`details` = Zod flatten), `401` unauthenticated, `403` role or origin, `404` not found / other org, `409` conflict, `429` rate limited, `502` a prompt run that failed upstream (body still contains the run).

**Roles:** `viewer` = read‑only (all `GET`s) · `user` = + all writes except below · `admin` = + settings, secrets, team, billing writes.

## Meta

| Method & path | Role | Notes |
|---|---|---|
| `GET /health` | public | `{status, db, auth, time}` |
| `GET /dev/users` | public, dev only | Seeded accounts + dev tokens; not mounted in production |
| `GET /me` | any | Current user + `authProvider` |
| `GET /models` | any | Model registry with per‑MTok prices, `supportsTemperature`, limits |

## Dashboard

`range` = `7d` \| `30d` \| `90d` (default `30d`).

| Path | Returns |
|---|---|
| `GET /dashboard/summary?range` | Spend, tokens, prompt runs, active workflows, media (each with period‑over‑period `deltaPct`), budget (`monthToDateUsd`, `pct`), `includesSimulatedData` |
| `GET /dashboard/spend?range` | Daily series `[{date, claude, higgsfield, total}]` (zero‑filled) |
| `GET /dashboard/breakdown?by=model\|workflow\|provider&range` | `[{key,label,costUsd,events,tokens}]` |
| `GET /dashboard/recent-runs` | Latest 6 runs |

## Prompts

| Method & path | Role | Notes |
|---|---|---|
| `GET /prompts?q=&template=true` | any | Library list (searches name, description, prompt text) |
| `POST /prompts` | user | Create prompt + version 1. Body: `name, description?, isTemplate?, tags?, system, user, model, temperature?, maxTokens, variables, note?` |
| `GET /prompts/:id` | any | Prompt + all versions + detected `variableNames` |
| `POST /prompts/:id/versions` | user | New immutable version (same body shape minus name) |
| `PATCH /prompts/:id` | user | `name, description, isTemplate, tags` |
| `DELETE /prompts/:id` | user | |
| `POST /prompts/run` | user | **Test runner.** Body: `system?, user, model, temperature?(0–1), maxTokens(1–128000), variables, promptId?`. Renders `{{vars}}`, runs through the queue, returns `{run, missingVariables, temperatureIgnored}`. `run.output.text`, token counts, `costUsd`, `latencyMs`, `simulated` |
| `POST /prompts/compare` | user | Body as run + `variants: [{model, label?, system?, user?}]` (2–4). Runs each as its own billed run; returns `{results:[{label, run, missingVariables}]}` |
| `GET /prompts/runs?limit` | any | Recent prompt runs |

Requests are capped at 16,000 output tokens per call (non‑streaming). Models that don't accept sampling parameters never receive `temperature`.

## Workflows & runs

| Method & path | Role | Notes |
|---|---|---|
| `GET /workflows?q=` | any | List with node/run counts and last run status |
| `GET /workflows/templates` | any | Template library |
| `POST /workflows/from-template` | user | `{templateId, name?, projectId?}` |
| `POST /workflows` | user | `{name, description?, definition, projectId?}`; `projectId` must be a project in your organisation |
| `GET /workflows/:id` | any | Includes `issues` (validation) |
| `PUT /workflows/:id` | user | Partial update. `version` bumps only when `definition` changes. Setting `status:"active"` with validation errors → 400 |
| `DELETE /workflows/:id` | user | |
| `POST /workflows/validate` | user | `{definition}` → `{issues:[{level,message,nodeId?}]}` |
| `POST /workflows/:id/estimate` | user | What a run would cost on Higgsfield: `{totalUsd, upTo, steps:[{nodeId,label,items,costUsd,note?}], unpriced, problems[], budget:{budgetUsd,spentUsd,leftUsd}\|null}` |
| `POST /workflows/:id/run` | user | `{input?: {text?...}, expectedTotalUsd?}` → `202 {run}`; progress via sockets or `GET /runs/:id`. If the workflow generates media, `expectedTotalUsd` is **required** and must cover the current estimate: otherwise `409 cost_confirmation_required` (details carry the estimate). `400` if the estimate lists `problems`; `402 over_budget` when it would exceed the project budget |
| `GET /workflows/:id/runs` | any | Run history (50) |
| `GET /runs?kind&status&workflowId&limit` | any | |
| `GET /runs/:id` | any | `{run, logs}` |
| `POST /runs/:id/cancel` | user | Queued runs only (`409` otherwise) |

Definition: `{nodes:[{id,type,position?,data}], edges:[{id,source,target}]}`, `type ∈ trigger|llm|generate|foreach|transform|action|output`. Trigger `source` may be `manual|schedule|higgsfield|project` (project: `{statuses?, group?}` selects board cards). `foreach`: `{mode:'cards'|'prompt', maxItems≤50, concurrency 1-4, model?, prompt?, settings?, startUrl?}`. In a project workflow, `{{project.name}}`, `{{project.aspect}}` and `{{project.brief.<field>}}` resolve. Scheduled runs are skipped (with an alert) when the workflow would spend money.

## Media

| Method & path | Role | Notes |
|---|---|---|
| `GET /media` | any | Filters: `type=photo\|video`, `tag`, `workflowId`, `from`, `to` (inclusive `YYYY-MM-DD`), `q`; `limit` (≤60), `cursor`. Returns `{items, total, nextCursor}` (keyset pagination) |
| `GET /media/tags` | any | `[{tag,n}]` |
| `GET /media/export?format=csv\|json` + same filters | any | Download |
| `POST /media` | user | `{type,title,url(http/s),thumbUrl?,tags?,workflowId?,metadata?}` |
| `POST /media/upload-url` | user | `{filename, contentType}` → presigned `PUT` (`uploadUrl, publicUrl, headers`). Requires storage config + S3 keys |
| `DELETE /media/:id` | user | |

## Monitoring

| Path | Notes |
|---|---|
| `GET /monitoring` | Snapshot: `apiHealthPct, latencyMs, latencyP95Ms, queueSize, activeJobs, runsLastHour, failuresLastHour, tokensLastHour, spendToday, claudeConfigured, higgsfieldConfigured` |
| `GET /monitoring/logs?level&kind&status&workflowId&runId&q&limit` | Log history (newest first) |
| `GET /monitoring/jobs` | Queued/running + finished in last 15 min |
| `GET /monitoring/alerts` | Latest 50 |
| `POST /monitoring/alerts/:id/ack`, `POST /monitoring/alerts/ack-all` | user |

## Settings, team, billing (admin unless noted)

| Method & path | Notes |
|---|---|
| `GET /settings` (any) | Org name, `defaults`, `storage`, `billing`, `models` |
| `PUT /settings/defaults` | `{model, maxTokens, temperature\|null}` |
| `PUT /settings/storage` | `{endpoint, region, bucket, publicBaseUrl, forcePathStyle}` |
| `PUT /settings/billing` | `{monthlyBudgetUsd, alertThresholdPct}` |
| `GET /settings/secrets` | Status only: `{name, configured, source: stored\|environment\|none, last4, updatedAt}` |
| `PUT /settings/secrets/:name` | `{value}`; names: `anthropic, higgsfield, s3_access_key_id, s3_secret_access_key` |
| `DELETE /settings/secrets/:name` | |
| `POST /settings/secrets/anthropic/test` | Validates the key with a free `models.list` call |
| `GET /team` (any) | Members |
| `POST /team/invite` | `{email, name?, role}` – linked when they sign in with that email |
| `PATCH /team/:id` | `{role}`; cannot demote the last admin |
| `DELETE /team/:id` | Cannot remove yourself |

## Export & search

| Path | Notes |
|---|---|
| `GET /export/usage.csv?range` · `GET /export/runs.csv?range` | CSV (formula‑injection safe) |
| `GET /export/report.pdf?range` | Summary report; flags simulated data |
| `GET /search?q=` | `{prompts, workflows, media}` (≥ 2 chars, 6 each) |

## Socket.IO

Connect with `io(origin, { auth: { token } })` (same token as REST). Server → client events:

| Event | Payload |
|---|---|
| `monitoring:update` | Snapshot (on connect, then every 5 s) |
| `job:update` | Run without `input`/`output` – on queue, start, finish |
| `log:new` | `{id, runId, level, message, nodeId, ts, kind, refId, refName}` |
| `alert:new` | `{id, kind, severity, message, …}` |
| `usage:new` | `{provider, costUsd, simulated}`: sent whenever spend is recorded |

## Studio (Higgsfield generation)

| Method & path | Role | Notes |
|---|---|---|
| `GET /studio/models` | any | `{connected, baseUrlSet, soulIdPriceUsd, models:[{id,label,surface,family,description,priceUnit,priceUsd,note,modes:[{id,label,path,promptRequired,params,media}]}]}`. The catalog is pure data: `params` describe each setting (`enum`/`int`/`number`/`boolean`/`text`/`seed`/`character`), `media` lists the inputs (images, video, audio) with their role, limit and whether they are required. `connected=false` = simulated mode |
| `POST /studio/generate` | user | `{modelId, mode?, prompt, settings?, media?:{start,end,reference,video,audio: url[]}, count?(1-4)}` → `202 {run}` (run `kind:"generation"`). `mode` is inferred from the media when omitted (a start frame selects image-to-video). Everything is validated against the chosen mode (unknown settings, ranges, required inputs, per-role file limits, http(s)-only URLs) → `400`. Results are saved to the media timeline (`GET /media?source=studio&runId=`) |
| `POST /studio/uploads?filename=` | user | Raw file body with `Content-Type` of `image/jpeg\|png\|webp\|gif`, `video/mp4` or `audio/wav` (limits: images 20 MB, audio 30 MB, video 100 MB). Hosts the file on Higgsfield storage and returns `{url, kind, name, bytes, mediaId}`; images/videos are also added to the media library (`source=upload`). Requires a Higgsfield connection. Higgsfield marks uploads temporary |
| `GET /studio/characters` | any | `{connected, characters:[{id,name,status,thumbnailUrl}]}` (Soul IDs on the connected account) |
| `POST /studio/characters` | user | `{name, imageUrls[1-30], confirmedCost:true}` trains a Soul ID (billed by Higgsfield, about $2.50; recorded as usage). Refused without `confirmedCost` |
| `GET /studio/characters/:id` | any | Status of one character |
| `PUT /settings/higgsfield` | admin | `{baseUrl}`; for higgsfield.ai hosts any pasted path is trimmed to the host; https required in production; no credentials in the URL |
| `POST /settings/higgsfield/check-prices` | admin | Asks Higgsfield's estimate endpoint for every model/mode at default settings and compares with the snapshot: `{checkedAt, rows:[{modelId,modeId,snapshotUsd,liveUsd,diffPct,status:match\|changed\|info\|error,description?,note?}], counts}`. `info` = Higgsfield priced it in words. Stored and returned by `GET /settings` as `higgsfield.priceCheck`. Free; nothing is generated |
| `PUT /settings/credits/:provider`, `DELETE …` | admin | `provider` = `claude`\|`higgsfield`; `{balanceUsd}` is the balance read from that provider's console |
| `GET /dashboard/credits` | any | `[{provider, set, startingUsd, asOf, usedSinceUsd, lifetimeUsedUsd, remainingUsd, low}]`: entered balance minus real (non-demo) spend recorded since |
| `PUT /settings/studio-prices` | admin | `{prices:{modelId: usd\|null}}`, USD per generated image (image models) or per second of video (video models) |

`GET /settings` also returns `higgsfield:{baseUrl, baseUrlFromEnv, prices}`; `GET /settings/secrets` includes a safe shape check for the Higgsfield key (lengths and the first 8 characters of the public key ID, never the secret). Runs of `kind=generation` appear in `GET /runs`, Monitoring and the job table. Workflow definitions may contain `generate` nodes (`data: {model, prompt, startUrl?, endUrl?, count?}`); a start/end URL switches the node to the model's image mode.

## Projects, board and Director chat

A project belongs to one organisation; every route is scoped to it and writes need role `user`.

| Method & path | Role | Notes |
|---|---|---|
| `GET /projects/types` | any | The project types (micro drama, ad campaign): brief fields, wording, starter prompts |
| `GET /projects?q=` | any | List with item/approved counts and spend |
| `POST /projects` | user | `{name, type, description?, aspect?, budgetUsd?}` (`budgetUsd: 0` = no cap) |
| `GET /projects/:id` | any | One call for the whole page: project, type, items (each with `estimate`, newest `takes`), assets, linked workflows, `spend`, `totalEstimateUsd` |
| `PUT /projects/:id` | user | `{name?, description?, aspect?, budgetUsd?, brief?, status?}`; `brief` merges, and unknown fields → 400 |
| `DELETE /projects/:id` | user | |
| `POST /projects/:id/items` | user | One item or `{items:[…]}` (≤100): `{group?, title, prompt?, notes?, modelId?, mode?, settings?, media?, meta?}`. Every item is validated against the Studio catalog **before any is saved** |
| `PUT /projects/:id/items/:itemId` | user | Partial update. Changing the model clears settings/mode unless sent; `approvedAssetId` approves a take of this item; `status:"rejected"` clears the approval. `meta.startFromItemId` animates another card's approved image; `meta.count` = takes per generation |
| `PUT /projects/:id/items/reorder` | user | `{ids:[…]}` |
| `POST /projects/:id/items/:itemId/duplicate`, `DELETE …/:itemId` | user | A generating item can't be deleted |
| `POST /projects/:id/estimate` | any* | `{ids?}` → per-item estimates, `totalUsd`, `blocked[]`, budget left (*POST, but read-only; still needs role `user`) |
| `POST /projects/:id/variants` | user | Ads: `{baseItemId, hooks?, aspects?, create?}`. Always returns the count and total cost; creates the cards only with `create:true` (≤60). A format the model can't make → 400 |
| `POST /projects/:id/generate` | user | `{ids, expectedTotalUsd}` → `202 {runs, totalUsd}`. **The approval gate**: re-prices server-side; `409` if the cost is above `expectedTotalUsd` (only float rounding is forgiven), `402 over_budget` if the project budget would be exceeded, `400` if any item can't be generated (no model, a start-from card with no image yet…), nothing is queued in those cases |
| `POST/PUT/DELETE /projects/:id/assets[/:assetId]` | user | Reference assets: `{kind: character\|product\|logo\|location\|style\|reference, name, url?, notes?, characterId? (Soul ID), mediaId? (copy a library item's URL)}` |
| `GET /projects/:id/chat` | any | The conversation as the UI shows it: text blocks plus one chip per tool call |
| `POST /projects/:id/chat` | user | `{message, model?}` → `{messages, changed:{board,brief,workflows,assets}, costUsd, simulated}`. Runs Claude with tools in a loop (≤8 rounds); each step is saved as it happens. Without an Anthropic key it replies `simulated` and changes nothing |
| `DELETE /projects/:id/chat` | user | Clears the conversation (not the brief or board) |
| `GET /projects/:id/export/script.md`, `shot-list.csv`, `clips.zip` | any | Script, spreadsheet (UTF‑8 with BOM), and a streamed ZIP of the approved takes in board order plus the other two files. `clips.zip` → 400 when nothing is approved; clips that can't be fetched are listed in `MISSING.txt` |

Director tools (Claude → server, not HTTP): `list_models`, `get_project`, `update_brief`, `add_items`, `update_item`, `delete_items`, `estimate_cost`, `request_approval` (marks cards `ready`; spends nothing), `expand_variants`, `create_workflow` (saved as a draft linked to the project), `add_asset`. There is deliberately no tool that generates.
