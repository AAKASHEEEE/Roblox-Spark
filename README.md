# RBLX SPARK Video Factory — validation proof of concept

Original, blocky-style, vertical (1080×1920) comedy shorts. The pipeline goes from **episode JSON to a verified MP4** with no screen recording, no manual animation and no editing.

- Sample output: [`docs/poc/free-coins-loop-001.mp4`](docs/poc/free-coins-loop-001.mp4) (17 s, 23/23 quality gates, byte-identical on re-render).
- Recommendation: **MODIFY** — build on this architecture with named compromises. See [`docs/VALIDATION_REPORT.md`](docs/VALIDATION_REPORT.md).

> Not affiliated with or endorsed by Roblox Corporation. The "RBLX" code name should be replaced before release (see legal doc).

## Requirements
- Node **22.18 or newer** (runs `.ts` natively).
- TypeScript **5.8 or newer**.
- `playwright-core` plus a Chromium build.
- **No** GPU or Python is needed.
- FFmpeg is **optional**. Only Narrated Story MP3/M4A voice-overs need it (see *Narrated Storyboard — Phase 1*). Everything else, including WAV voice-overs, works without it.

## Setup
```bash
npm install                          # typescript + playwright-core (devDependencies)
npx playwright install chromium      # skip if a Chromium already exists (CHROMIUM_PATH=... also works)
npm run setup                        # doctor: checks WebGL2 + WebCodecs H.264/Opus, builds dist/
```

## One-command usage
| Command | What it does |
|---|---|
| `npm start` | Supervised Studio at http://localhost:5173: idea, storyboard, approve, render, download (see *Supervised Studio (MVP)*). The developer episode player is at `/apps/studio/player.html` |
| `npm run render:poc` | Final 1080×1920 MP4 plus reports in `out/free-coins-loop-001/` (about 4 min on 8 CPU cores) |
| `npm run render:preview` | 540×960 preview render (about 80 s) |
| `npm run render:determinism` | Renders twice from scratch and compares every frame's pixels and the MP4 bytes |
| `npm test` | 24 tests: schema, validator, asset lock, muxer, audio, and a headless-browser integration test |
| `npm run stills -- 0.5 3.8 14.5` | QA stills and a contact sheet at given times |
| `npm run assets:lock` | Registers new asset versions. Refuses edits to locked ones. |

Each render writes to `out/<episode>/`:
- `<id>.mp4`, `thumbnail.png`, `contact-sheet.png`;
- `episode.json` (validated), `validation.json`;
- `render-log.json` (timings, memory, hashes, host), `quality-report.{md,json}`, `mix.wav`.

## Supervised Studio (MVP)

**Start:** `npm start`, then open http://localhost:5173. The first start builds the browser bundle; rendering needs the Chromium from *Setup*.

**Create an episode**
1. Type an idea in plain text. Choose a comedy engine (or *Auto*), a duration (14–22 s, default 17) and a seed. The seed is random by default; the same idea, settings and seed always give the same storyboard.
2. **Generate Storyboard** runs the existing story pipeline: rules provider, then safety, protected IP and asset/action availability checks, then the compiler with its shot and collision checks. A blocked idea shows the primary reason, and approval stays disabled.
3. Review the beat cards: time range, character, action, target, face, camera, story purpose, sound and VFX. A read-only JSON view is under *Developer*.
4. **Approve storyboard** freezes that exact episode. It is content-addressed and written once. To replace it, use *Back to storyboard generation*.

**Render:** **Render Video** renders only the approved episode, as the final 1080×1920 MP4 or a quick 540×960 preview. It goes through the existing render worker: validation, H.264 + AAC-LC encoding, playback checks and quality gates.
- Progress: while frames render, the bar shows real frame counts; the other steps show an indeterminate bar.
- On success: video preview, duration, resolution, frame rate, codecs, quality gates, **Download MP4** and **Download Episode JSON**.
- On failure: the actual error, the unchanged approval, and a manual **Retry**.

**Output location:** `out/studio/` (not in Git).
- `approved/<approval>/episode.json` and `approval.json`
- `renders/<approval>/<job>/<episode-id>.mp4`, plus its quality report, probe and render manifest
- `generations/` and `jobs.json`

The form and the current storyboard, approval and render job survive a browser refresh and a server restart. A render interrupted by a restart is marked failed and needs a manual retry. Screenshots and one demo render (`demo-final-1080x1920.mp4`: 17 s, 1080×1920, 26/26 quality gates): `docs/studio/`.

**Known limitations**
- Single local user; no accounts.
- One render at a time. A final render takes several minutes on CPU.
- Rules provider only (no LLM). One environment and two characters.
- Storyboards are review-only by design.
- You must discard an approval before generating a new storyboard.
- `out/studio/` is never cleaned automatically.
- The previous episode player is at `/apps/studio/player.html` (developer use).

## Narrated Storyboard — Phase 1

A second Studio mode. It takes a script and your uploaded voice-over and produces phrase-timed captions and a constrained storyboard, downloadable as JSON. **Narrated Story rendering is not implemented yet**: this mode produces no MP4. Visual Comedy is unchanged.

**Start:** `npm start`, open http://localhost:5173, then choose **Narrated Story** in the header.

**Workflow**
1. **Input.**
   - Enter the title and the script, with **one narration/caption phrase per non-empty line**. Blank lines separate story sections.
   - Upload the voice-over.
   - Choose registered characters (Zapp and/or Kira), a story pattern, a seed and the caption style.
   - Click **Generate Narrated Storyboard**.
2. **Alignment review.** Shows the file facts, the number of phrases and detected speech regions, the project confidence, a timeline, and each phrase's caption, time range, confidence, words per second, emphasis words and warnings.
3. **Storyboard.**
   - One beat card per phrase: narration, time range, actor (plus supporting character), action, face, environment, camera, visual intent, caption, confidence and warnings.
   - Buttons: **Back to input**, **Regenerate with same seed**, **Generate with new seed**.
   - **Download Narrated Storyboard JSON** (`/api/narrated/generations/<id>/storyboard.json`).

**Audio**
- Accepted formats:
  - **WAV** (PCM 16/24/32-bit or float 32), decoded natively.
  - **MP3** and **M4A** (AAC/ALAC), only when FFmpeg is available (see *FFmpeg* below).
- **Record a dry voice-over** (voice only, no music bed) and pause briefly (about 0.2 s or more) between script lines. Pauses are what the aligner detects; add music later.
- Validation:
  - Maximum upload 30 MB; duration 1–300 s (35–60 s is the target and only warns).
  - The file must be a safe plain filename, and its content must match its extension.
  - The codec reported by the decoder must be allowed; executables are rejected.
- Uploads are stored content-addressed (SHA-256) in `.scratch/narrated-uploads/`. This folder is not in Git and not publicly served.

**FFmpeg (MP3/M4A only)**
- The Studio never installs FFmpeg and has no bundled copy. It uses exactly one of these:
  - `FFMPEG_PATH=/absolute/path/to/ffmpeg npm start`. If `FFMPEG_PATH` is set but not an absolute path to a runnable FFmpeg, MP3/M4A stay disabled; there is no fallback.
  - Otherwise, `ffmpeg` on `PATH`, e.g. from `apt install ffmpeg`, `dnf install ffmpeg` or `brew install ffmpeg`.
- The build needs the `mp3` and `mov` demuxers and the `mp3`/`aac` decoders; standard builds include them. Tested with FFmpeg 7.0.2.
- FFmpeg is checked once at Studio start (`ffmpeg -version`); restart the Studio after installing it.
- Without FFmpeg, the Narrated Story screen says *WAV only* and shows these setup steps. MP3/M4A uploads are refused with the same message (API code `DECODER_UNAVAILABLE`).
- FFmpeg runs with an argument list (never a shell) on the Studio's own hash-named copy of the upload. The input format is forced and only file access is allowed.

**Fresh machine**
```bash
npm install                               # Node >= 22.18; installs typescript + playwright-core only
npm run typecheck                         # tsc --noEmit
node --test tests/narrated.test.ts        # the 8 Narrated Story tests (in-memory WAV fixtures; no FFmpeg or browser)
npm test                                  # the fast suite; render integration tests need Chromium (see Setup)
npm start                                 # Studio at http://localhost:5173 (Narrated Story needs no server-side browser)
FFMPEG_PATH=/usr/bin/ffmpeg npm start     # optional: enable MP3/M4A (or just have ffmpeg on PATH)
```

**How alignment works** (offline and deterministic; no speech model):
- Speech/silence regions are detected from 20 ms energy frames with an adaptive threshold.
- Script phrases are mapped to those regions in order by a monotone dynamic-programming pass that compares each region's duration with the phrase's share of the words. Adjacent regions can be merged, or one region split by word count.
- With no usable pauses, phrase timing is distributed by word count.
- Timing is **phrase-level only**; no word-level accuracy is claimed. The seed changes the visual choices, never the timings.

**Confidence**
- **High**: detected pauses match the phrases one-to-one.
- **Medium**: some regions had to be merged or split.
- **Low**: timing is mostly estimated from word counts (for example, speech over a continuous music bed). A warning is shown; check the timings.

**Known limitations**
- Voice-overs with music or noise under the voice usually align with low confidence.
- There is no manual timestamp editing.
- There is only one environment (the classroom). Places, vehicles and handheld objects in the script become declared substitutions or warnings.
- There is one caption preset. Captions are not burned in.
- The mode is single-user and local.
- Only the metadata and hash of the voice-over are remembered across a refresh. If the file is gone, the UI asks you to re-upload the same file and verifies its hash.

## Documents
- [VALIDATION_REPORT](docs/VALIDATION_REPORT.md) — results, measurements, limitations, recommendation
- [DECISION_MATRIX](docs/DECISION_MATRIX.md) — Roblox Studio vs web vs Blender vs hybrid
- [ARCHITECTURE](docs/ARCHITECTURE.md)
- [LEGAL_AND_ASSET_SAFETY](docs/LEGAL_AND_ASSET_SAFETY.md)
- [MVP_SCOPE](docs/MVP_SCOPE.md)
- [IMPLEMENTATION_LOG](docs/IMPLEMENTATION_LOG.md)
- Render-quality report: [docs/poc/quality-report.md](docs/poc/quality-report.md)
