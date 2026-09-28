# RBLX SPARK Video Factory — validation proof of concept

Original, blocky-style, vertical (1080×1920) comedy shorts. The pipeline goes from **episode JSON to a verified MP4** with no screen recording, no manual animation and no editing.

- Sample output: [`docs/poc/free-coins-loop-001.mp4`](docs/poc/free-coins-loop-001.mp4) (17 s, 23/23 quality gates, byte-identical on re-render).
- Recommendation: **MODIFY** — build on this architecture with named compromises. See [`docs/VALIDATION_REPORT.md`](docs/VALIDATION_REPORT.md).

> Not affiliated with or endorsed by Roblox Corporation. The "RBLX" code name should be replaced before release (see legal doc).

## Requirements
- Node **22.18 or newer** (runs `.ts` natively).
- TypeScript **5.8 or newer**.
- `playwright-core` plus a Chromium build.
- **No** GPU, FFmpeg or Python is needed.

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

The form and the current storyboard, approval and render job survive a browser refresh and a server restart. A render interrupted by a restart is marked failed and needs a manual retry. Screenshots: `docs/studio/`.

**Known limitations**
- Single local user; no accounts.
- One render at a time. A final render takes several minutes on CPU.
- Rules provider only (no LLM). One environment and two characters.
- Storyboards are review-only by design.
- You must discard an approval before generating a new storyboard.
- `out/studio/` is never cleaned automatically.
- The previous episode player is at `/apps/studio/player.html` (developer use).

## Documents
- [VALIDATION_REPORT](docs/VALIDATION_REPORT.md) — results, measurements, limitations, recommendation
- [DECISION_MATRIX](docs/DECISION_MATRIX.md) — Roblox Studio vs web vs Blender vs hybrid
- [ARCHITECTURE](docs/ARCHITECTURE.md)
- [LEGAL_AND_ASSET_SAFETY](docs/LEGAL_AND_ASSET_SAFETY.md)
- [MVP_SCOPE](docs/MVP_SCOPE.md)
- [IMPLEMENTATION_LOG](docs/IMPLEMENTATION_LOG.md)
- Render-quality report: [docs/poc/quality-report.md](docs/poc/quality-report.md)
