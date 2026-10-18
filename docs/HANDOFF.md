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
- **Billing**: spend is tracked against whatever key is connected. Elle's key bills Elle's account.

## Spending rules (do not bypass)
- Elle approves every paid generation. Ask first, state the price.
- The dashboard enforces this: cost dialog before any generation, a changed price blocks the run, scheduled workflows that spend are skipped, the Director chat has no generate tool.
- Prices come from Higgsfield's own quote when available, else a saved list (as of 2026-10-12). **The Seedance 2.5 promo ended 2026-10-18, so the saved list prices need refreshing** (Settings, price check).

## Current state
- **Nya's Story** (micro drama): all 7 shots (S1 to S7) are approved. Spend so far about $40.16 ($35.71 generation, $4.45 chat).
- Earlier S2 and S4 runs timed out while still running at Higgsfield and may have been charged. Elle was to check Higgsfield console usage for request ids 410b19b3... and 9862b820... (unresolved).
- Dialogue approach ("Flow B"): supplying audio does not drive speech in Seedance 2.5 reference mode (tested). A voice-over mixed under the clips is not built.
- Not built: "Make a voice line" button on cards; mixing VO under clips with ffmpeg.
- Higgsfield support was asked whether voices are available through the API. No answer yet.
- Elle has not entered her API credit balances on Overview (it shows a balance minus tracked spend).

## Characters and voices (ElevenLabs, model eleven_v4 with auto audio tags)
- Marcus: voice named "Marcus". Nya: voice named "NYA _ Ai Clone_2".
- Match voices **by name** each time. Ids change when a voice is edited.
- Higgsfield web-account Soul IDs are not usable by the API key. Character consistency uses reference images (Grok Imagine accepts up to 5).

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
