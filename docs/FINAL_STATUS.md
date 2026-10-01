# BlockSpark Studio — final handoff (30 September 2026)

## Current release candidate

Use branch `integration/vignette-v1`. It supersedes the individual S2–S7 branches and the historical status snapshot in `PRODUCT_STATUS.md`.

### Working now

- **Script → BeatSheet:** deterministic offline Director plus optional free-only OpenRouter intent hints. Provider output is locally validated and can never introduce unregistered IDs.
- **Original asset library:** classroom with a physical door, school hallway, playground, 10 characters, expressive faces, 25 props, 50+ actions, prop/door states and camera recipes.
- **BeatSheet → staged review:** deterministic staging, movement, real hinged door, multi-set switching, camera safety, 90% script-visibility gate, captions, UI popup, reports and PNG stills.
- **Reference classroom fixture:** PASS — 98.2% coverage, 14/14 recipe cameras, zero fallback/blocked shots, zero staging errors/warnings.
- **Multi-set fixture:** PASS — 100% coverage, 4/4 recipe cameras, zero fallback/blocked shots, zero staging errors/warnings.
- **Regression baseline:** typecheck and full fast unit suite pass; legacy narrated continuity remains 47/47.
- **S7 modules:** richer caption/VFX primitives and deterministic voice+SFX mixing exist. Music is intentionally omitted because it is added in editing.

### Not finished

- Vignette's exact-time scene is not yet connected to the production H.264/AAC/MP4 worker. PR #21 is a historical S7/narrated proof and must not be presented as the integrated Vignette final render.
- The offline Director uses deterministic tag heuristics; free OpenRouter improves hints but is not guaranteed available and was not live-benchmarked in this handoff.
- Studio has no Vignette mode, approval screen or render/download controls.
- Bulk Core exists but has no production Vignette `EpisodePipeline` adapter.
- The current review stills are a strong MVP proof, not competitor-level video quality. Several beats use wide coverage; future direction should add safe multi-shot coverage within a beat.

## Quick start

Requirements: Node 22.18+ and Chromium for stills.

```bash
npm install
npm run typecheck
```

### 1. Generate a BeatSheet from a script (offline/free)

Put one narration phrase per line in `script.txt`:

```bash
npm run director -- \
  --script script.txt --duration 30 --seed 7 --provider offline \
  --out out/my-story.beats.json --report out/my-story.director-report.json
```

Optional OpenRouter (zero paid spend): create a dedicated key with provider-side credit limit `$0`, disable auto top-up, and use only `openrouter/free` or an exact `:free` model.

```bash
export OPENROUTER_API_KEY='<dedicated-$0-capped-key>'
npm run director -- \
  --script script.txt --duration 30 --seed 7 --provider auto \
  --models openrouter/free \
  --out out/my-story.beats.json --report out/my-story.director-report.json
```

`auto` falls back to the deterministic offline Director if the free route is missing, rate-limited or invalid. Never commit the key.

### 2. Validate/stage without rendering pixels

```bash
npm run vignette:stage -- \
  --sheet out/my-story.beats.json --out out/my-story-stage --no-stills
```

Exit `0` means schema, staging, camera and 90% coverage gates passed. Exit `2` means the report completed but blocked; read `analysis-report.md` rather than bypassing the gate.

### 3. Render review stills

```bash
npm run vignette:stage -- \
  --sheet out/my-story.beats.json --out out/my-story-stage \
  --width 540 --height 960
```

Review `out/my-story-stage/analysis-report.md`, `shots.json` and `stills/*.png` before any video render.

## Verified review artifacts

- `docs/vignette/stage/free_coins_classroom/` — current passing classroom report, 14 captioned stills and a 1575×852 contact sheet.
- `docs/vignette/stage/multi_set_demo/` — current passing hallway → classroom → playground report and stills.
- `docs/characters/`, `assets/props/stills/`, `docs/animation/strips/`, `docs/vignette/sets/` — asset/action review sheets.

## Safety and product rules

- Use only original/procedural, commissioned, licensed-commercial or CC0 assets with exact hashes/provenance. Never copy Roblox/competitor maps, avatars, UI, scripts or branded content.
- Keep all user/provider inputs untrusted. Never execute model output; never expose provider keys to the browser or logs.
- Do not lower camera/coverage/licensing gates to pass a demo.
- Require human review of BeatSheet and stills before final rendering/publication.
- Rename the old internal `RBLX SPARK` code name before a public launch to avoid confusion or implied affiliation.

## Next priority order

1. Connect `VignetteScene.pose(t)` to the existing production frame encoder and S7 audio plan; issue a digest-bound render manifest and verified MP4.
2. Add Vignette Studio generate → review → approve → render → download flow.
3. Connect Bulk Core through a real Vignette adapter and run a resumable 3-episode batch.
4. Add the remaining six sets and improve Director semantic/event planning.
5. Add multi-shot coverage per beat, then run competitor-style visual review rounds.

See `RESUME_KIRO_PROMPT.md` for the exact continuation prompt.
