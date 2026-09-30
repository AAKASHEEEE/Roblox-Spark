# Resume BlockSpark Studio in a future Kiro session

Copy the prompt below into the next subscription/session.

```text
Resume BlockSpark Studio in GitHub repository AAKASHEEEE/Roblox-Spark. This is an existing project: do not restart, redesign, or replace working modules.

FIRST — DISCOVER CURRENT TRUTH
1. Clone/fetch the repository over HTTPS. Check current branch, status, remote refs and all PRs using GitHub REST. Do not discard a dirty tree.
2. Read docs/FINAL_STATUS.md, docs/vignette-pipeline.md, packages/vignette/README.md, and this prompt.
3. Identify the newest verified commit containing integration/vignette-v1. The last known passing integration included:
   - `617e8fa` passing script-relevant still MVP;
   - `c7c18c9` offline-first/free-OpenRouter Director;
   - `0968cce` browser builder bootstrap plus refreshed passing evidence;
   - later documentation/release commits may exist on main.
4. Treat individual PRs #9–#17 and their feature branches as already integrated/superseded if their commits are ancestors of the selected branch. Never merge artifact/WIP branches. PR #21 (`feature/captions-vfx-full-render` at `0f0ab66`) was reviewed as stale historical S7/narrated proof: do not merge or call its MP4 the integrated Vignette final render unless it is rebased, rerendered and evidence-bound.
5. Create one new feature branch from the newest verified main/integration tip. Commit and push small milestones; open PRs via REST. Keep progress updates every 15 minutes and time-box experiments.

CURRENT WORKING PRODUCT — REVERIFY
- `npm run director -- --script <file> --duration <seconds> --seed <n> --provider offline|auto|openrouter --out <beats.json> --report <report.json>` deterministically generates an available-only BeatSheet. `auto` optionally uses validated free OpenRouter hints and falls back offline.
- Available original library: physical-door classroom, school hallway, playground, characters/faces/mouths, props/states, actions, cameras, captions/UI popup and S7 VFX/audio modules.
- `npm run vignette:stage -- --sheet <beats.json> --out <dir> [--no-stills]` validates, stages, solves safe cameras, enforces 90% script visibility, and renders captioned review stills.
- Canonical classroom fixture should report PASS: 98.2% coverage, 14/14 recipe cameras, zero fallback/blocked cameras, zero staging errors/warnings.
- Multi-set hallway→classroom→playground fixture should report PASS: 100% coverage, 4/4 recipe cameras, zero fallback/blocked cameras, zero staging errors/warnings.
- Browser `web-entry.load()` must call `registerRuntimeLibrary(lib)` before `stageBeatSheet`; this keeps pixels consistent with Node camera analysis and makes real hinged-door states work.
- Typecheck/full fast tests should pass and legacy narrated analysis must remain 47/47.

QUALITY TRUTH
This is a strong staging/stills MVP, not yet a finished competitor-level script-to-video product. A previous competitor review scored the old video about 3/10; the new still pipeline fixes literal script coverage (teacher leaves/returns, visible door, real actions/props/sets) and should be evaluated again only after the integrated MP4 exists. Do not claim 8/10, production readiness, or visual excellence from automated gates alone.

MISSION 1 — VERIFIED VIGNETTE VIDEO (highest priority)
1. Add a Node-side immutable render manifest containing exact hashes for BeatSheet, narration bytes, solved shots, code version, schema versions and every character/environment/prop asset pin. It is the only render authorization boundary. Require `validateBeatSheet(..., {requireAvailable:true})`, stage PASS, 0 unknown/planned required resources, 0 blocked cameras and coverage >=90% before browser launch.
2. Extend the existing `packages/vignette/src/web-entry.ts` exact-time renderer; do not build a second scene path or re-solve cameras per frame. Add deterministic binary/frame capture for `frame / fps`, preserving real builders, captions, VFX and UI overlays.
3. Reuse the existing render worker’s WebCodecs H.264, AAC-LC, MP4 mux, fast-start, cancellation, probing, playback verification, hashes and cleanup. Do not write a second encoder/muxer.
4. Wire the S7 BeatSheet audio plan: approved voice-over is primary; timed SFX from events/action contacts; no music because the user adds it during editing. Target roughly -14 LUFS and <=-1 dBTP. Missing required narration/SFX must fail closed.
5. Add `npm run vignette:render -- --sheet ... --voice ... --out ... --profile draft|final`. Draft: 540x960/30 fps. Final: 1080x1920/30 or 60 fps after draft visual approval.
6. Required evidence: manifest + quality report + frame count + codec/pixel format + AAC 48 kHz + AV drift + independent decode + caption/VFX counts + contact sheet <=1800 px + representative full frames. Bind every generated evidence file to input/output/source hashes; never trust a self-authored JSON claim without recomputation.
7. Add a short diagnostic render test first. Then render the canonical 69-second video exactly once after all no-render gates pass. Review the actual MP4 frame by frame before calling it final.

MISSION 2 — VISUAL QUALITY PASS
- Check literal relevance for every narration phrase, not just average coverage. Each named person/place/object/event must appear at the correct moment.
- Add multi-shot coverage within long beats so scale/reaction/action can each read without reverting everything to distant wides.
- Faces must be unobscured and expressive; actions must visibly change; entrances/exits must pass through open doors; interactions use dynamic anchors; no teleporting or partial heads.
- Captions stay 1–4 words, preserve every narration word and timing, highlight one useful word, avoid faces/hero props and use readable safe margins.
- Compare the MP4 against the three saved competitor references for hook, literal shot choice, expressions, set variety, props, pacing and payoff. Score category-by-category; make only measured corrections.

MISSION 3 — STUDIO/API
Add a Vignette mode without breaking Visual Comedy/Narrated:
- content-addressed script/voice/reference uploads (no arbitrary server paths);
- free/offline Director generation and substitutions report;
- BeatSheet/storyboard editor and still preview;
- compatibility, camera and coverage blockers;
- immutable human approval tied to all hashes;
- draft/final render jobs, progress/cancel/retry, playback and MP4/JSON/manifest downloads.
Keep provider keys server-side and out of Git/browser/logs.

MISSION 4 — BULK
Implement the production `EpisodePipeline` adapter over Director→validation→approval→Vignette render. Support 1–20 jobs, exact pins, persistent queue, resume/cancel/retry, concurrency and manifests. Fix the documented simultaneous stale-lock-break race before claiming multi-process safety. Run a dry 3-episode batch, then three real diagnostic renders only with explicit authorization.

FREE MODEL POLICY
- Default is deterministic offline Director—zero cost and fully reproducible.
- Optional OpenRouter: dedicated key, provider-side credit limit `$0`, auto top-up disabled, only `openrouter/free` or exact `:free` models. Never commit/log/return the key. No paid fallback.
- Treat model JSON as untrusted suggestions. Strict local schema/library/availability/safety validation remains authoritative; never execute model output.

SAFETY/IP
Only original/procedural, commissioned, licensed-commercial or CC0 content with exact hashes/provenance. No copied Roblox/competitor maps, avatars, scripts, UI, logos, sounds, currency or protected characters. Rename the old internal `RBLX SPARK` code name before public launch. Require human approval before publication.

MANDATORY BASELINE COMMANDS
- `npm run typecheck`
- `node --test --test-reporter=dot tests/*.test.ts` (obtain final exit/result)
- `node scripts/assets-lock.ts`
- `node scripts/environment-lock.ts`
- `node scripts/generate-lib-set-manifests.ts --check`
- `node scripts/narrated-integration-analysis.ts` → exactly 47/47
- classroom `vignette:stage --no-stills` → PASS >=98.2%, 14/14, 0 errors/warnings
- multi-set `vignette:stage --no-stills` → PASS 100%, 4/4, 0 errors/warnings

Never lower gates, hide planned IDs, merge stale artifact branches, or call a still animatic/fixture-specific proof a final product. At each milestone report commit, exact files, tests, media links, candid visual defects and smallest next action. Update docs/FINAL_STATUS.md with verified facts only.
```
