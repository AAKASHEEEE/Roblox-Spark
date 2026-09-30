# BlockSpark Vignette MVP — product status

> **Snapshot:** `integration/vignette-v1` / `chore/vignette-handoff` at `617e8fa` (`feat: ship passing script-relevant vignette MVP`). This document describes that commit, not `main`. Re-run the checks below after every integration.

## Bottom line

BlockSpark Vignette is an **MVP beat-sheet validation, staging, camera-safety, coverage-analysis, and still-rendering pipeline**. The reference classroom fixture currently passes those gates and renders review stills. It is **not competitor-level, production-ready, or a complete script-to-video product**: the Director does not yet generate beat sheets, S7/audio are partial, Vignette has no video encoder/final-MP4 path, Studio has no Vignette mode, and the bulk package is an orchestration core without a real rendering adapter.

Do not infer Vignette final-video support from the older Episode renderer. That renderer can produce verified MP4s from Episode JSON, but it is not wired to `BeatSheet`, `StagePlan`, or `VignetteScene`.

## Current architecture

```text
narration script + phrase timings
  -> Director output contract (implemented) / Director generator (missing)
  -> BeatSheet 1.0
  -> strict schema + semantic/library/phrase validation
  -> deterministic staging and multi-set world plan
  -> runtime set/character/prop/action resolution
  -> per-beat camera recipes + camera-safety fallback
  -> script-visibility coverage gate (90%)
  -> analysis-report.{md,json} + shots.json + PNG stills
  -> production frame-sequence capture (missing) -> audio/encode/mux (missing)
```

| Layer | Current implementation |
|---|---|
| Contract and validation | `packages/director/src/beat-sheet.ts`: strict `BeatSheet` 1.0 schema, unknown/planned ID handling, set marks/doors, events, captions, carry-over, and optional one-to-one narration phrase checks. `requireAvailable` exists in the API but is not enabled by the staging CLI. |
| Shared library | `packages/library/src/ids.ts` and `types.ts`: versioned sets, characters, props, actions, expressions, cameras, VFX, text, SFX, and music with `available`/`planned` state. |
| Runtime assets | S2 sets, S3 characters/faces, S4 props, and S5 actions are registered through `packages/vignette/src/runtime-library.ts` and engine builders. |
| Staging | `packages/vignette/src/stage.ts`, `sets.ts`, and `path.ts`: placements, entrances/exits, doors, prop spans, action contracts, paths, cuts, carry-over, and multi-set layout. |
| Scene and cameras | `packages/vignette/src/scene.ts` builds the staged world. `camera.ts` and `camera-recipes.ts` solve and safety-check each beat. |
| Coverage and verdict | `packages/vignette/src/coverage.ts` and `pipeline.ts`: visual script coverage must be at least 90%; validation errors, staging errors, or blocked cameras also block the run. |
| CLI and stills | `scripts/vignette-stage.ts`: loads a sheet and locked assets, runs the pipeline, optionally builds the web bundle and drives `packages/vignette/web/stills.html` in Chromium, then writes reports, solved shots, and stills. |
| Existing reusable infrastructure | `apps/render-worker/` already has generic H.264/AAC encoding, MP4 muxing, probing, playback verification, manifests, and quality reports. An adapter from Vignette is still missing. |
| Bulk | `packages/bulk/` provides deterministic 1–20 job validation, seeds, persistence, leases, retries, resume, and manifests. It deliberately delegates real work to an injected `EpisodePipeline`; no production Vignette adapter exists. |

## Integrated branches and commits

These are ancestors of `617e8fa` and are integrated on `integration/vignette-v1`; they are **not merged to `main`** (`main` was `5a8bd64` at this snapshot).

| Area | Branch / commits | Truthful status |
|---|---|---|
| Environment catalog | `feature/environment-catalog`: `864cd65`, `fb118e7`, `952cd1c`; merge `55e4bb1` | Versioned catalog, validation, and locks integrated. |
| Character reference profiles | `feature/character-reference-profiles`: `be052d2`, `796a90c`, `7501967`, `ac57811`; merge `bd98ae6` | Locked profiles and provenance checks integrated. |
| Bulk core | `feature/bulk-generator-core`: `6e501f5`, `1c5b15f`, `4799a48`, `4fda83a`; merge `9931ac6` | Queue/orchestration core integrated; no real renderer adapter. |
| S0 contracts | `2d22d91` | Library contracts, ID manifest, strict beat-sheet schema/validator, and reference fixture integrated. |
| S3 characters/faces | `feature/lib-characters` `3c075b9`; merge `790c828` | Cast recipes, face set v2, and talking mouths integrated. |
| S4 props | `feature/lib-props` `1141fdf`; merge `2948522` | 25 procedural props, states, and anchors integrated. |
| S5 actions | `feature/lib-actions` `7aada6c`; merge `683ae79` | Action registry, prop/door interactions, talking, and face tracks integrated. |
| S6 staging/cameras | `feature/vignette-stage` `1252cab`; merge `ff7745e` | Staging, cameras, coverage, reports, and still renderer integrated. |
| S2 sets | `feature/lib-sets` `b656d65`; merge `8f44bef` | Three procedural sets integrated. Its classroom mark defect is corrected only in `617e8fa`; do not merge draft PR #16 at `b656d65` unchanged. |
| Integration seams | `f68d46c`, `427991a`, `9ff2394` | Prop/action/door alignment, real S3–S6 runtime wiring, and cross-layer tests. |
| MVP fixes | `617e8fa` | Correct set coordinates/locks, camera-axis and coverage fixes, S7 `caption_bold`/`ui_popup`, and regression assertions. |

`feature/director-fast` points at `617e8fa` and has no unique Director implementation. It is not a completed feature branch.

## Quality status at this snapshot

| Check | Result |
|---|---|
| `npm run typecheck` | **PASS** at `617e8fa`. |
| Focused set/runtime/caption tests | **PASS**, 17 tests: `node --test --test-reporter=spec tests/lib-sets.test.ts tests/vignette-runtime-integration.test.ts tests/vignette-caption.test.ts`. |
| Default analysis-only run | **PASS**: 98.2% coverage, 14 recipe cameras, 0 fallback, 0 blocked, 0 staging errors/warnings. |
| Default full still run | **PASS** with 14 PNG stills and the same verdict. |
| Multi-set analysis-only run | **BLOCKED** (exit 2): 87.5% coverage; cameras `p02` and `p04` blocked; 0 staging errors/warnings. |
| Full `npm test` | **Inconclusive in this handoff**: it reached at least 158 passing tests without a reported failure, but the command exceeded a 300-second execution limit before its final summary. Do not call the full suite green until it completes. |
| Hosted CI/checks | No check runs were attached to `617e8fa` or draft PR #16 at this snapshot. |
| Committed reports | `docs/vignette/stage/**` were generated before the latest integration fixes and still say BLOCKED. They are historical evidence, not the current default-fixture verdict. |

This is a useful MVP baseline, not release evidence. There is no Vignette AV-sync test, frame-sequence render, encoded video, final MP4, Studio workflow, operational bulk run, load test, or competitor comparison.

## Exact quickstart

Run from the repository root. Node `>=22.18` is required because the project executes `.ts` files directly.

```bash
npm install
npx playwright install chromium
npm run setup
```

`npm run setup` performs broader browser/codec/library checks. Chromium is unnecessary for `--no-stills` runs. If a usable browser is already installed, `CHROMIUM_PATH=/absolute/path/to/chromium` is supported; `PLAYWRIGHT_BROWSERS_PATH` selects a Playwright browser cache, while `PLAYWRIGHT_CORE_PATH` selects an alternate Playwright Node module.

### 1. Author or obtain a beat sheet

There is **no beat-sheet generation command yet**. `packages/director/src/beat-sheet.ts` defines and validates Director output, but no Director implementation writes it. Start with one of the committed inputs or author JSON against `BeatSheetSchema`:

- Reference classroom: `packages/director/fixtures/free-coins-classroom.beats.json`
- Multi-set example: `packages/vignette/fixtures/multi-set-demo.beats.json`

A valid sheet needs `schemaVersion: "1.0"`, ID/title/seed/source, music spans, and one non-overlapping beat per narration phrase. Keep `source.narrated` pointed at the real narrated JSON when phrase matching is required.

### 2. Validate and stage without a browser

There is no standalone `vignette:validate` script. The exact validation path is the staging command with stills disabled; it performs schema/semantic validation, runtime staging, camera safety, and coverage:

```bash
npm run vignette:stage -- --no-stills

npm run vignette:stage -- \
  --sheet packages/vignette/fixtures/multi-set-demo.beats.json \
  --out out/vignette/multi_set_demo-check \
  --no-stills
```

For a custom sheet:

```bash
npm run vignette:stage -- \
  --sheet path/to/custom.beats.json \
  --out out/vignette/custom-check \
  --no-stills
```

Exit codes: `0` means all current staging gates passed; `2` means the completed report is blocked; malformed/missing JSON or a structurally unusable sheet normally exits `1`. A PASS does **not** prove final render readiness because this CLI does not set `requireAvailable: true` and does not render audio/video.

### 3. Stage and render review stills

```bash
npm run vignette:stage

npm run vignette:stage -- \
  --sheet path/to/custom.beats.json \
  --out out/vignette/custom-run \
  --width 540 \
  --height 960 \
  --extra 0.5,3.2
```

The second form creates one representative PNG per beat plus optional stills at 0.5 and 3.2 seconds. The CLI builds `tsconfig.web.json` automatically before launching headless Chromium.

### 4. View outputs

A completed run writes:

```text
out/vignette/<sheet-id-or-selected-output>/
├── analysis-report.md      # human review; embeds generated stills
├── analysis-report.json    # machine-readable verdict and staging details
├── shots.json              # solved camera choices
└── stills/
    ├── p01.png             # one per beat
    └── t0.50.png           # optional --extra frame
```

Open `analysis-report.md` in a Markdown-capable viewer and inspect `stills/*.png`. There is no `vignette:view` command and the current Studio does not serve these artifacts. A simple local file server can expose the raw files when needed:

```bash
python3 -m http.server 8000 --directory out/vignette/free_coins_classroom
```

Then open `http://127.0.0.1:8000/stills/p01.png` or the JSON/Markdown files. `packages/vignette/web/stills.html` is an internal headless render host, not a persistent product viewer.

## OpenRouter free-key setup with a $0 cap

This is optional and applies only to the existing **story benchmark**, not Vignette Director or Studio. The repository has no native `openrouter` provider; its `openai` provider is OpenAI-compatible and can be pointed at OpenRouter. The repository also has **no internal dollar cap**, so the dedicated OpenRouter key limit is the spending boundary.

1. Create a dedicated OpenRouter API key. In its key settings set **Credit limit = `$0`** (not “no limit”), leave auto top-up disabled for this experiment, and verify the saved limit before use. If the service will not save a `$0` cap, stop—there is no authorized paid fallback. OpenRouter documents per-key credit limits and rejects requests after a limit is used: [API authentication](https://openrouter.ai/docs/api-reference/authentication).
2. Select only `openrouter/free`, which routes among zero-cost models that support requested capabilities, or an exact catalog model whose ID ends in `:free`. Free routes can be rate-limited or temporarily unavailable: [Free Models Router](https://openrouter.ai/docs/guides/routing/routers/free-router) and [`:free` variants](https://openrouter.ai/docs/guides/routing/model-variants/free).
3. Keep the key in the process environment. This project does not load `.env` files and expects the compatible provider key in `OPENAI_API_KEY`.

```bash
read -rsp "OpenRouter API key: " OPENROUTER_API_KEY; echo
export OPENROUTER_API_KEY
export OPENAI_API_KEY="$OPENROUTER_API_KEY"
export BLOCKSPARK_LLM_PROVIDER=openai
export BLOCKSPARK_LLM_BASE_URL=https://openrouter.ai/api/v1
export BLOCKSPARK_LLM_MODEL=openrouter/free
export BLOCKSPARK_LLM_MAX_RETRIES=0
export BLOCKSPARK_LLM_TIMEOUT_MS=45000
```

Create a one-item benchmark set so a smoke test cannot iterate the full dataset:

```bash
node --input-type=module -e "import{readFileSync,writeFileSync,mkdirSync}from'node:fs';const x=JSON.parse(readFileSync('bench/ideas.json','utf8'));mkdirSync('out/bench',{recursive:true});writeFileSync('out/bench/openrouter-smoke-set.json',JSON.stringify({...x,ideas:x.ideas.slice(0,1)},null,2))"

node scripts/bench-generate.ts \
  --provider openai \
  --set out/bench/openrouter-smoke-set.json \
  --out out/bench/openrouter-free-smoke \
  --static
```

The adapter appends `/chat/completions`; do not include that suffix in `BLOCKSPARK_LLM_BASE_URL`. `--static` skips browser analysis but not model calls. Transport retries are disabled above, while up to three semantic repair calls remain hard-coded. The benchmark records token counts but reports real-provider dollar cost as `null`; reconcile usage with OpenRouter. A free route may still reject this code's JSON-schema `response_format`, so this is a compatibility smoke test, not a supported production integration. Never commit or paste the key into logs.

_OpenRouter behavior above is paraphrased from the linked official documentation; verify its current UI, model availability, limits, and terms before each run._

## Troubleshooting

| Symptom | Cause and action |
|---|---|
| `npm: command not found` | Activate a Node `>=22.18` installation. With nvm: `source "$NVM_DIR/nvm.sh" && nvm use 22`. |
| Beat sheet exits before a report | Check `--sheet`, JSON syntax, and the strict schema. Unknown keys are rejected. |
| Exit code `2` | Read `analysis-report.md`: validation, staging, blocked camera, or coverage `<90%` made the run non-shippable. This is expected for the current multi-set fixture. |
| Phrase edits are not caught | `source.narrated` must resolve to an existing JSON file with a non-empty `script.phrases` array. Otherwise the CLI still validates the sheet but skips one-to-one phrase matching. |
| PASS contains placeholders/planned IDs | Staging intentionally permits `planned` IDs. Use `validateBeatSheet(..., { requireAvailable: true })` in the eventual render gate; the CLI has no switch for it today. |
| Chromium/Playwright launch fails | Run `npx playwright install chromium`, or set `CHROMIUM_PATH`; confirm with `npm run setup`. Use `--no-stills` to isolate non-browser logic. |
| Old stills remain after a rerun | The CLI overwrites named files but does not clear the output directory. Remove the selected `out/vignette/<id>` directory before a clean evidence run. |
| Committed report disagrees with a fresh run | `docs/vignette/stage/**` is stale historical evidence. Trust a report generated from the exact SHA under test and commit a refreshed evidence set only deliberately. |
| `unknown provider "openrouter"` | Use `--provider openai`; there is no native OpenRouter provider name. |
| `OPENAI_API_KEY is not set` | Map the OpenRouter secret into `OPENAI_API_KEY` as shown above. |
| OpenRouter 404 | Use base URL `https://openrouter.ai/api/v1`, not the full completion endpoint. |
| OpenRouter 400/422 or malformed content | The selected free route may not support JSON-schema response formatting or JSON-only content. Choose a compatible `:free` model or remain on the offline `rules` provider. |
| OpenRouter 429/5xx | Free capacity is limited. Wait or choose another free route; do not remove the `$0` key cap. |

## Safety and IP rules

1. Use only original/procedural, commissioned, licensed-commercial, or CC0 assets with complete manifest provenance and lock hashes. Unknown/unlicensed sources must remain blocked.
2. Do not use Roblox or competitor avatars, maps, logos, fonts, UI, sounds, footage, platform currency, protected characters, brands, or real-person likenesses. Do not imply endorsement or affiliation.
3. Rename the internal **RBLX SPARK** code name before launch; “RBLX” creates trademark and false-endorsement risk. Keep BlockSpark visually distinct: no studs, classic “noob” palette, copied platform UI, or trade dress.
4. Treat model output as untrusted data. Keep strict local schema, library, safety, license, camera, coverage, and render validation; never execute provider output.
5. Keep API keys out of Git, browser/client code, reports, and logs. Use dedicated environment-scoped keys and a `$0` provider-side cap for free-model experiments.
6. Preserve mandatory human approval before publication. Keyword/context checks are not comprehensive moderation, and this engineering document is not legal advice.

See [`LEGAL_AND_ASSET_SAFETY.md`](LEGAL_AND_ASSET_SAFETY.md) for the fuller risk assessment.

## Known gaps

- No deterministic Director implementation or beat-sheet generation command; the primary fixture is hand-authored.
- No standalone validation CLI and no staging CLI option for `requireAvailable`.
- Multi-set fixture still fails camera and coverage gates.
- S7 is partial: `caption_bold`, `ui_popup`, and several generic VFX/audio assets exist, while semantic VFX/text styles/SFX aliases/music beds remain planned.
- No BeatSheet/StagePlan audio adapter, narration mix, segmented music spans, event-to-SFX timeline, or Vignette AV-sync gates.
- The existing `packages/vignette/src/web-entry.ts` can render a PNG at an exact time with solved shots, but there is no production frame-sequence/binary capture adapter, Vignette video encoder, muxing adapter, final MP4, or Vignette render manifest/quality report.
- The browser still entry is not a render authorization boundary: final rendering needs Node-side phrase/semantic/availability validation and an approved, hashed input manifest.
- No Vignette Studio/API flow for generation, review, approval, staging blockers, render progress, playback, or download.
- Bulk core uses mocked/injected handlers; no operational Vignette adapter, CLI/API/dashboard, or real bulk render test. Two processes can also race while breaking the same stale lock, so it remains a single-host MVP rather than a multi-process-safe queue.
- `source.narrated` is a local path string; an API must replace it with content-addressed upload IDs and constrain any CLI path to an allowed root.
- No end-to-end `runVignette` regression test around camera/coverage verdicts; hosted CI is absent.
- Full fast-suite result at this snapshot is unconfirmed; committed reports are stale.
- There is no committed npm lockfile or pinned browser/FFmpeg toolchain, limiting cross-machine reproducibility.
- Output folders are not cleaned automatically; no retention policy exists.

## Prioritized next work

1. **P0 — Lock a green baseline.** Make the multi-set fixture pass without weakening the 90% or camera-safety gates; add positive and deliberately blocked end-to-end `runVignette` verdict tests; complete `npm test`; add CI. Publish generated reports/stills as CI artifacts tied to the source SHA, or record that source SHA explicitly in a later evidence commit. Leave draft PR #16 unmerged; with repository-owner approval, close or supersede its pre-fix revision.
2. **P1 — Build Director.** Add strict `DirectorRequest`/`DirectorResult` contracts around the nested `BeatSheet`; deterministically transform script + phrase timings + selected/pinned resources into the sheet; select sets/cast/props/actions/expressions/cameras/events/captions/carry-over; return explicit substitutions/failures/resource locks/policy provenance; enforce available assets for render; add golden, availability, multi-set, and determinism tests.
3. **P2 — Finish S7 and audio.** Implement remaining semantic overlays/VFX/SFX/music IDs and a timed Vignette audio plan. Mix narration, segmented beds, and cue-aligned effects with ducking, loudness, limiting, and missing-cue failures.
4. **P3 — Produce verified video.** Extend the existing exact-time `web-entry.ts` still renderer into deterministic frame-sequence capture using pre-solved shots, then reuse the existing H.264/AAC encoder, MP4 muxer, probe, playback verifier, manifests, and quality reports. Make an approved Node-side manifest—not arbitrary browser input—the render gate. Define draft versus final duration/resolution gates and test AV sync.
5. **P4 — Add Vignette Studio mode.** Support content-addressed script/audio inputs, Director generation, beat/staging review, immutable approval, blocker display, draft/final render, progress, playback, and downloads. Never enable render while required gates fail.
6. **P5 — Connect bulk.** Implement the real pipeline adapter, persistent API/CLI controls, resume/cancel/retry, artifact hashes and retention; fix the simultaneous stale-lock-break race before claiming multi-process safety; add at least one real diagnostic bulk render before exposing 1–20 episode batches in Studio.

Use [`RESUME_KIRO_PROMPT.md`](RESUME_KIRO_PROMPT.md) as the self-contained continuation brief.