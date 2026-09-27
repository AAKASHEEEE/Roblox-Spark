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
| `npm start` | Studio at http://localhost:5173: storyboard, live preview with audio, validation, **Generate episode** button, downloads |
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

## Documents
- [VALIDATION_REPORT](docs/VALIDATION_REPORT.md) — results, measurements, limitations, recommendation
- [DECISION_MATRIX](docs/DECISION_MATRIX.md) — Roblox Studio vs web vs Blender vs hybrid
- [ARCHITECTURE](docs/ARCHITECTURE.md)
- [LEGAL_AND_ASSET_SAFETY](docs/LEGAL_AND_ASSET_SAFETY.md)
- [MVP_SCOPE](docs/MVP_SCOPE.md)
- [IMPLEMENTATION_LOG](docs/IMPLEMENTATION_LOG.md)
- Render-quality report: [docs/poc/quality-report.md](docs/poc/quality-report.md)
