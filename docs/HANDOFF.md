# Handoff: Higgsfield dashboard (Elle's install)

Written 2026-10-18. Single-user tool for Elle. Not hosted, not for sharing over a network.

## Run it
- Needs Node. ffmpeg is optional (only for converting MP3/M4A audio uploads to WAV).
- `start.bat` opens the backend (port 4000) and frontend (port 5173) and skips any that are already running.
- Open http://localhost:5173. Sign-in is a local dev screen with no password: Demo Admin, Demo User, Demo Viewer.
  - **Viewer** can look but not generate. **User/Admin** can generate (real spend).
- Branch: `full-dashboard-build`. Everything is committed and pushed except this note.

## What is NOT in the repo (by design)
- **API keys** (Higgsfield, ElevenLabs, Anthropic). Entered in Settings, stored in the local database. Never paste them into chat. A new machine needs its own keys.
- **Project data** (`backend/.data`, git-ignored): Nya's Story, shot board, media library, usage history. A fresh clone starts empty.
- **Local copies of media** (`backend/.data/files`, git-ignored): **Higgsfield deletes uploads and generated files after about a week**, so the dashboard keeps its own copy of every upload and result and re-uploads any expired input before a generation. Anything made before 2026-10-25 has no copy, so expired references from before then must be uploaded again. Back this folder up with the rest of `.data`.
- **Billing**: spend is tracked against whatever key is connected. Elle's key bills Elle's account.

## Spending rules (do not bypass)
- Elle approves every paid generation. Ask first, state the price.
- The dashboard enforces this: cost dialog before any generation, a changed price blocks the run, scheduled workflows that spend are skipped, the Director chat has no generate tool.
- Prices come from Higgsfield's own quote when available, else a saved list. The launch promotion ended 2026-10-18 and the saved list was refreshed on 2026-10-25 (Seedance 2.5 is now $0.2056, $0.4622 and $1.1372 per second at 480p, 720p and 1080p, in every mode). Run Settings, Check prices now and then; Seedance 2.0 reference mode and Kling's saved fallbacks have not been re-based.

## Current state
- **Nya's Story** (micro drama): all 7 shots (S1 to S7) are approved. Spend so far about $40.16 ($35.71 generation, $4.45 chat).
- **Episode 5 is started** ("S1 · Seven Days"), still a draft. It failed twice on 2026-10-25 because its Nya and Marcus reference images had expired (nothing was charged). The originals must be uploaded again in Assets: the Nya sheet (file `hf_20261016_031312_ce9c5eea-2981-4edd-a9ed-2fcc0831f49f.png`) and the Marcus image (`d39ddfe8-28a4-489c-aaaf-2c3577b13920.png`). Replacing an asset image now also updates the shots that use it. Seasons are just board labels, for example "Season 2 · Ep 1 · Scene 1".
- Earlier S2 and S4 runs timed out while still running at Higgsfield and may have been charged. Elle was to check Higgsfield console usage for request ids 410b19b3... and 9862b820... (unresolved).
- Dialogue approach ("Flow B"): supplying audio does not drive speech in Seedance 2.5 reference mode (tested). A voice-over mixed under the clips is not built.
- Not built: "Make a voice line" button on cards; mixing VO under clips with ffmpeg.
- Higgsfield support was asked whether voices are available through the API. No answer yet.
- Elle has not entered her API credit balances on Overview (it shows a balance minus tracked spend).

## Characters and voices (ElevenLabs, model eleven_v4 with auto audio tags)
- Marcus: voice named "Marcus". Nya: voice named "NYA _ Ai Clone_2".
- Match voices **by name** each time. Ids change when a voice is edited.
- Higgsfield web-account Soul IDs are not usable by the API key. Character consistency uses reference images (Grok Imagine accepts up to 5).

## Workspaces and roles (added 2026-10-28)
- **Workspaces:** Right Girl Media (first, the default) and Greene Legal Group. One login sees both through the switcher at the top of the sidebar. Projects, the media library and uploaded edit videos are kept per workspace. Content saved before workspaces existed belongs to Right Girl Media. Spend totals, prompts and workflows are still shared across workspaces.
- **Roles:** Admin and Team (stored as `admin` and `user`; the old `viewer` role still exists but is no longer offered). Team can create, edit and generate in every workspace and sees prices, charges, the monthly budget and account balances for reports. Only Admin sees keys and can change keys, prices, budget and balances.
- **Spending rule:** Ruth knows what needs Elle's approval; the dashboard does not queue her runs for approval.
- A copy of the database was saved in `backend/.data/backups` before the workspace change was applied.

## Video effects (added 2026-10-28)
- The **Editing** page adds effects from the Claude "effects" skill (45 of them, by @vibha.in.progress, MIT licence) to a video: gallery, per-effect start, end, text and colour, a single-frame preview (about 20 to 30 seconds), and a full render. Everything runs on this computer and costs nothing. Results are saved in the Media library of the current workspace.
- **Best on a person facing the camera.** The effects follow the face; text can be cut off at the edges on other footage, such as wide AI-generated scenes.
- **Optional label:** a toggle ("Add the dramatization label for the whole video", not one of the 45 effects) adds a solid bar across the bottom with editable text, default `DRAMATIZATION | AI-GENERATED VIDEO`. It is off unless turned on and can be used alone with no effects. On Greene Legal Group the page warns when it is off. Effects are listed alphabetically. The page is called Editing (`/edit`).
- **Setup on a new computer:** clone `https://github.com/Vibha-Ramprakash/claude-video-effects` into `~/.claude/skills/effects`, install Python 3.12 (`winget install Python.Python.3.12`) and ffmpeg, then in that folder run `python -m venv .venv` and `.venv\Scripts\python.exe -m pip install -r requirements.txt`. Set `EFFECTS_DIR` if it lives elsewhere. Uploaded videos and results are in `backend/.data/edit` (back it up with the rest of `.data`).
- Finished edits are served from `/api/edit/files/<random id>.mp4` without a login (the browser's video player cannot send one). The names cannot be guessed, but do not host this publicly without changing that.

- **Review beat by beat:** each video is split into beats (hook, tips, CTA) with a status (draft, in review, changes needed, approved). Ruth edits and submits; only the admin login approves or requests changes, and each line of a change request becomes a checklist item. Editing an approved beat sends it back to draft. Tables: `video_beats` (migration 5).
- **Suggest beats:** the Editing page can propose beats from what is said. Step one transcribes on this computer (the skill's `scripts/words.py`, faster-whisper; the first run installs it and downloads a small speech model, about a minute) and shows the Claude price (Sonnet 5.5, a few cents). Nothing is spent until the button "Confirm and suggest" is pressed. Needs the Anthropic key in Settings. The transcript is kept beside the video as `<id>.words.json`.

- **Captions:** a toggle on the Editing page draws the spoken words on the video, 1 to 6 at a time (default 3), capitals, current word in yellow, above the label bar. Built in `services/captions.ts` as an ASS subtitle file from the transcript and burned in with ffmpeg in the same pass as the label (order: effects, captions, label). Free; uses the same transcript as Suggest beats. Not yet editable: a mis-heard word needs a transcript editor (planned).
- **Caption look and fonts:** colours, italic, size, position, capitals and font are chosen per video; each workspace starts from its own look (Right Girl Media: cream, gold, mauve outline, Trirong; Greene Legal Group: white, red, navy outline). The presets are constants at the top of `frontend/src/pages/Edit.tsx`. **To add a font, drop a .ttf or .otf into the project's `fonts/` folder** (Trirong Medium is there) and restart; it appears in the Font list. The name in the list is the font file's own family name (for example "Trirong Medium"), which is what ffmpeg matches on. Only add fonts whose licence allows it (Google Fonts are OFL).

- **Timeline:** one time axis under the beats with rows Beats (coloured by status, click to review), Titles & Cards, Zoom, Looks (only when used), Captions, and Your cuts (detected). Effects are sorted into rows by name (`ZOOM_FX`, `LOOK_FX` in `Edit.tsx`; everything else is a title or card). Cuts come from ffmpeg scene detection (threshold 0.35, free) and are cached as `<id>.cuts.json` beside the video; the Captions row shows where speech runs once the video has been transcribed.

- **Numbered drafts:** every render is kept as a draft (v1, v2, ...) in the video's record (`drafts`), with who rendered it, when, the settings used, and a plain-words list of what changed from the draft before (`services/drafts.ts`). Under "Drafts" on the Editing page: Watch, Compare (tick two to play side by side), Submit for review (anyone on the team), Approve or Request changes (admin only; the note shows on the draft). Statuses match beats: draft, in review, changes needed, approved. The edits list shows the latest draft and its status. Drafts made before this change do not exist; the first render after it becomes v1.

- **Transcript editor:** the "Transcript" card on the Editing page shows the spoken words in lines with their start times. Each word is editable; there is find and replace (whole words, any case), add a word, join two words, delete, Save, Discard, and "Back to the original". The first save keeps the transcriber's version as `<id>.words.original.json`; the corrected one replaces `<id>.words.json`, so captions, the Captions timeline row and Suggest beats all use it. Timing is not editable (new words are placed in the gap). Drafts already rendered keep their old captions. A video that was never transcribed has a "Listen to the video" button (free). Routes: GET/PUT `/videos/:id/words`, POST `/videos/:id/transcribe`, POST `/videos/:id/words/reset`. Not yet run in the browser.
- **Video beside the transcript:** the Transcript card has a player (sticky on the right). Click a line's time to play from there, click a word to jump to it, and the word being said lights up. Uploaded source videos are played through a signed link (`GET /videos/:id/stream-url` returns `/api/edit/source/:id?exp=&sig=`), HMAC-signed with a secret made when the server starts and valid 2 hours, so source videos are NOT open like the result files; a server restart just means the page asks for a new link (`services/sourceLinks.ts`).

- **Transcriber setup gotcha (found 2026-10-29):** faster-whisper 1.2.1 fails with `open() got an unexpected keyword argument 'metadata_errors'` if the effects skill's venv has `av` 19.x. Fix: `.venv\Scripts\python.exe -m pip install "av==15.1.0"` in `~/.claude/skills/effects`. The first transcription also downloads the Whisper "base" model from Hugging Face (needs internet once).
- **Browser test pass (2026-10-29, Demo Admin, a generated 11 second spoken clip):** transcribe, find and replace, save (original kept), restore original, player play/seek/word highlight, captions render with corrected spelling in Trirong with the Right Girl Media colours, drafts v1/v2, change list, compare, submit, request changes, approve all worked. Not tested: the Team (Demo User) login being refused on approve, a real client video, Suggest beats with a real Anthropic key, the Greene Legal Group workspace look.

## Content Vault (added 2026-10-30)
The "Vault" page (`/vault`, `routes/vault.ts`, `services/vault.ts`, `pages/Vault.tsx`, migration 6 `vault_clips` and `vault_reels`) organizes raw footage and plans reels from it.
- **Adding footage (free):** admin only: "Read folder" takes a full path on this computer and reads every MP4/MOV/M4V/WebM in it and its sub-folders (up to 5000; dot-folders skipped; files stay where they are and are never deleted). Anyone on the Team: "Upload clips" (several at once, 500 MB each, saved to `backend/.data/vault/clips`). For each clip it reads length, size, played orientation, when it was filmed (iPhone local time first, then the file's creation_time, then the file's modified time), whether it has sound (average loudness above -35 dB) and a thumbnail (`.data/vault/thumbs`). A copy of a clip already there (same size plus first and last 64 KB) is kept but marked a duplicate and not counted.
- **Sorting (paid, price first):** Claude Haiku 5.5 looks at 3 frames per clip and picks one of the folders in `VAULT_FOLDERS` (Talking head, Desk, Studio, Close-ups, On the go, Outdoors, Events, Food & drink, Screen recording, Other), 3 to 6 tags and a one-line description. `POST /vault/sort {approved:false}` is free and returns the price and whether the key is missing; `{approved:true}` starts it. One run does at most the newest 500 unsorted clips and stops at the quoted maximum. About $0.00016 a clip, so roughly 7 cents for 400. Filing a clip by hand counts as sorted. The page shows the ball of unsorted thumbnails and folder boxes that fill as clips are sorted.
- **Days:** clips group by the day filmed ("By day" tab). A day with 3 or more clips can be sent to reel planning.
- **Reel ideas (paid, price first):** Claude Sonnet 5.5 plans up to 8 reels from the sorted clips: "vlog" (one day's clips in the order filmed) and "topic" (any days, one hook). Each beat names a real clip; invented clip ids and reels with fewer than 3 real beats are dropped; a beat never runs longer than its clip. Voice is chosen by workspace name (GLG gets the compliance rules: no case results or amounts, DRAMATIZATION label on anything staged). Saved in `vault_reels` with Save, Mark used, Delete.
- **Playing a clip:** signed link like source videos (`/api/vault/clip/:id?exp=&sig=`, `signVaultLink`; a vault link never opens an edit video or the reverse).
- **Tested:** 17 new tests (`tests/vault.test.ts`, with real ffmpeg clips); browser pass against a mock of the Anthropic API (`ANTHROPIC_BASE_URL`) with 22 clips over 5 days: scan, duplicate, ball, sorting progress, folder boxes, By day, reel planning, clip player. NOT tested with a real Anthropic key (image requests and the reel prompt have only been run against the mock), nor with a real iPhone export, nor with hundreds of clips.
- **Not built yet:** pulling vault clips into the Editing page as B-roll cutaways on a beat; a Vault clip is not yet copied into the editor. Folder list is a code constant.

## Instagram carousel (separate from the dashboard)
- Topic: why unused Higgsfield credits do not roll over, and Elle built her own studio on the API.
- Slide 1 is Elle's own finished graphic. Slides 2 to 7 were made in Studio with the copy written inside a dark holographic panel. Cost about $1.26 on top of earlier tests ($0.12 per new image, $0.09 per text edit).
- Elle finished the carousel herself. The Canva draft "Right Girl Media Higgsfield carousel" in "RGM Content 2026" is the older cream-panel version and can be ignored.

## Preset: "Holographic panel" (optional, not the default look)
This is one saved preset among others. It is **not** Elle's house style and should not be applied unless she asks for it or the brief calls for it. Pick the look per piece. What carries over to any look of Elle: face likeness needs reference images, not a text description.
- **Model:** Grok Imagine 2.0 (image), mode Generate / Edit, settings quality medium, resolution 2k, aspect ratio 3:4. About $0.12 per new image and $0.09 per edit.
- **References (4, in this order):** two Elle portraits, then two images of her office. Pass them as the `reference` media role. Reference URLs are on Higgsfield storage and may expire, so re-upload from the Studio media library if they stop loading. Canva locked elements for the same look: `char_elle_V1` (4699fc9e-b979-41b3-8b51-739d571e4135) and `elles-office` (f8057461-209b-4d4f-9434-b228def49c32).
- **Prompt skeleton:** "Photoreal vertical editorial photo. The woman from the first two reference images (same face, long dark wavy hair, black rectangular glasses, gold hoop earrings, thin gold necklace with a small cross, plain white t-shirt) sits at the dark desk with the silver laptop in the warm home office from the last two reference images. She is in the RIGHT half of the frame, face in the upper right, looking at the camera. [expression]. Her arm reaches left, hand open palm up, and above it a LARGE futuristic holographic panel floats in the upper-left 45 percent: dark smoked glass, glowing lilac and pink neon edge, a warm glow rising from her palm. The panel is completely blank. Warm natural light, shallow depth of field, photorealistic skin."
- **Words in the panel:** a second pass. Run the finished image back through the same model as the single reference with: keep everything the same and only write the exact text in white bold sans-serif (headline) and light lilac (supporting line), left-aligned, perfectly spelled. Check every word. All six slides came back spelled correctly on the first try.
- **Rules for this preset:** no text on or near her face; keep the left 45 percent clear for the panel. For the Higgsfield carousel Elle wanted the words inside the image, not added in Canva. Other pieces may differ, so ask.

## Working preferences
- Vertical 9:16 by default. Zero em dashes in written content. Real numbers in public posts only.
- Ads will be for clients, so keep client work separate.
