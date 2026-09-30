# Resume BlockSpark Vignette in Kiro

Copy the single prompt below into a new Kiro subscription/session.

```text
You are resuming the BlockSpark Vignette work in GitHub repository AAKASHEEEE/Roblox-Spark. Work from the repository checkout and treat repository source/tests—not branch names or old reports—as truth. The intended integration base is `integration/vignette-v1`; its last known tip was `617e8fa` (`feat: ship passing script-relevant vignette MVP`), but do not assume that is still current.

MISSION
Complete the end-to-end Vignette product in dependency order: (1) truthful green integration baseline, (2) deterministic Director, (3) remaining S7 plus audio, (4) Vignette video and verified final MP4, (5) Vignette Studio/API UI, and (6) a real bulk adapter/workflow. Implement and test working vertical slices; do not stop at plans or placeholder documentation. Treat P0–P5 as separate reviewable milestones/PRs with their own passing tests and handoff; the final system acceptance follows their integration.

FIRST: DISCOVER WHAT CHANGED
1. Confirm the repo, clean worktree, current branch, remotes, Node version, and contribution rules. Never discard existing user changes.
2. Record the current local/remote refs before network changes, then fetch without pruning: `git fetch origin`. Inspect `integration/vignette-v1`, relevant newer remote branch tips, and ancestry before creating or merging anything:
   - `git log --oneline --decorate --graph --all --date-order -80`
   - `git branch -r --format='%(refname:short) %(objectname:short) %(committerdate:iso8601)'`
   - classify each candidate in both directions with `git merge-base --is-ancestor <candidate> origin/integration/vignette-v1` and the reverse, then inspect `git rev-list --left-right --count` and the diff. A negative ancestry result alone does not mean “newer.” Prune only after useful refs are classified.
3. Read `docs/PRODUCT_STATUS.md`, `docs/vignette-pipeline.md`, `packages/vignette/README.md`, and this prompt. Compare their snapshot claims with current source and update only when evidence changes.
4. Inspect relevant Vignette PRs through GitHub REST (`gh api 'repos/AAKASHEEEE/Roblox-Spark/pulls?state=all&per_page=100'`) plus reviews, inline/discussion comments, checks, and commit status. Check whether a newer handoff/docs branch or PR should be integrated.
5. Do not duplicate or blindly merge ancestor branches. At the last snapshot, PRs #9–#16 were already ancestors of integration and must not be merged into it again. Draft PR #16 (`feature/lib-sets` at `b656d65`) was not safe to merge to its old base unchanged: its classroom semantic coordinates were wrong, and the canonical corrections existed later in `617e8fa`. Leave it unmerged; with repository-owner authorization, close/comment as superseded or replace it with a focused corrected change. If `classroom@1.2.0` was ever published externally, preserve it and mint a new version rather than changing published bytes/locks again.
6. If integration moved beyond `617e8fa`, review the delta and use the newest verified integration tip. Any working branch must descend from that selected tip; if a supplied task branch does not, stop and get approval before merge/rebase. Never switch, stash, reset, merge, or rebase a dirty worktree automatically. Follow the repo's branch policy, commit in small reviewable units, push, and open/update PRs via REST.
7. Use parallel context/review agents for independent areas, but keep one integration owner and run cross-layer tests after every merge.

KNOWN BASELINE AT 617e8fa (RE-VERIFY; DO NOT OVERSTATE)
- Implemented: strict BeatSheet 1.0 contract/semantic validator; shared versioned library; S2 procedural sets; S3 characters/faces/mouths; S4 props; S5 actions; S6 staging/pathing/multi-set scene/camera recipes/camera safety/90% coverage/reports/stills; partial S7 `caption_bold` and `ui_popup`; deterministic bulk queue core.
- Missing: Director generator, strict render-availability CLI gate, complete S7/audio adapter, production Vignette frame-sequence/video worker integration and final MP4, Vignette Studio flow, and real bulk pipeline adapter. Exact-time PNG rendering already exists in `packages/vignette/src/web-entry.ts`; extend it rather than duplicating it.
- `npm run typecheck` passed.
- Seventeen focused set/runtime/caption tests passed: `node --test --test-reporter=spec tests/lib-sets.test.ts tests/vignette-runtime-integration.test.ts tests/vignette-caption.test.ts`.
- `npm run vignette:stage -- --no-stills` passed the classroom fixture: 98.2% coverage, 14 recipe cameras, 0 fallback/blocked, 0 staging errors/warnings.
- Full default staging also rendered all 14 PNG stills and passed.
- The multi-set fixture remained BLOCKED: 87.5% coverage and blocked cameras on `p02`/`p04`.
- A full `npm test` reached at least 158 passing tests but exceeded a 300-second task limit before a final summary; this is inconclusive, not a pass or failure.
- `docs/vignette/stage/**` reports predate the integration fixes and were stale/BLOCKED. Hosted check runs were absent.
- This was only a staging-and-stills MVP. It was not competitor-level and did not produce a Vignette MP4.
- `docs/vignette-pipeline.md` still says to branch from `develop/vignette`; that ownership/branching text is historical and must not override the selected `integration/vignette-v1` tip.

ARCHITECTURE TO PRESERVE AND EXTEND
`script + phrase timings -> Director -> BeatSheet -> validateBeatSheet -> stageBeatSheet -> VignetteScene -> solveBeatCamera -> coverageCheck -> reports/stills -> audio plan -> frame capture -> encode/mux/probe/verify -> Studio/bulk`.

Key files:
- `packages/director/src/beat-sheet.ts`: authoritative strict output contract and semantic validator.
- `packages/library/src/ids.ts` / `types.ts`: all available/planned resource contracts and tags.
- `packages/vignette/src/pipeline.ts`, `stage.ts`, `scene.ts`, `camera.ts`, `coverage.ts`: current execution and blocker rules.
- `scripts/vignette-stage.ts`: only current Vignette CLI; analysis/stills, no audio/video.
- `packages/library/src/ids.ts`: partial S7 state; do not mark IDs available without implementation, source, version/lock where applicable, and tests.
- `apps/render-worker/`: reusable browser capture, H.264/AAC, MP4 mux/probe/playback/quality infrastructure for generic Episode JSON.
- `apps/studio/`: existing Visual Comedy and Narrated flows; no Vignette flow at the snapshot.
- `packages/bulk/`: real deterministic queue core whose `EpisodePipeline` handlers were still mocked/injected.

P0 — ESTABLISH A TRUTHFUL GREEN INTEGRATION
1. Install/use Node >=22.18. There was no committed npm lockfile at the snapshot: decide and commit a package-manager lock strategy, then prefer reproducible installs (`npm ci`). Record/pin Node/npm, Chromium, FFmpeg/ffprobe, encoder settings, and relevant software-renderer versions for media evidence. Run `npm run typecheck`, focused tests, and the complete `npm test` with enough timeout to get a final summary. Diagnose hangs rather than reporting a partial run green.
2. Run both current fixtures with `--no-stills`, then with stills. Preserve a deliberately blocked negative fixture, and fix the positive multi-set `p02`/`p04` camera safety and 87.5% coverage without lowering the 90% threshold, suppressing safety failures, or weakening content requirements.
3. Add end-to-end tests around `runVignette` asserting validation, staging errors, camera blocked/fallback counts, coverage, deterministic shots, and expected positive/negative verdicts.
4. Add CI for typecheck, fast tests, deterministic headless Vignette analysis, and an appropriately scoped browser smoke. Prefer generated evidence as a CI artifact tied to the source commit. If reports/stills are committed in a later evidence commit, record the source commit/tree/input hashes explicitly; do not claim the evidence was generated from its own evidence commit.
5. Constrain local CLI `source.narrated` paths to an allowed root with traversal/symlink tests. API jobs must use content-addressed upload IDs and hashes, never client-supplied server paths.
6. Remove documentation drift (for example old placeholder claims), but keep historical evidence clearly labeled.

P1 — IMPLEMENT THE DIRECTOR, NOT JUST ITS SCHEMA
Create deterministic production code under `packages/director/` and a supported CLI/API. Define strict `DirectorRequest` and `DirectorResult` contracts: the request carries narration, exact phrase IDs/timings, seed, selected/pinned resources and policy; the result wraps a BeatSheet 1.0 plus substitutions, failures, resource locks, policy decisions, and generator version. If changing BeatSheet itself, version and migrate it deliberately.

The Director must:
- emit exactly one beat per phrase with exact text/timing;
- choose set/lighting/cast/roles/placements/props/states/actions/expressions/look targets/events/cameras/captions/carry-over/music from the registered library;
- use availability, versions, tags, set marks/doors, action/prop affordances, and continuity constraints;
- remain deterministic for identical inputs/locks/seed;
- return explicit substitutions and precise failures instead of invented IDs, and include exact resource content hashes/policy provenance outside the nested BeatSheet;
- support multi-set transitions and script-salient camera subjects;
- validate its result locally and enforce `requireAvailable: true` before rendering;
- define exactly which request/result/resource/audio fields enter immutable approval hashes;
- never execute model output.

Prefer a deterministic/rules baseline. If an LLM is optional, keep it behind the existing provider abstraction and validate/repair its untrusted data. Add unit, property/edge, golden, semantic, determinism, planned-vs-available, and multi-set tests. Add exact commands such as `vignette:generate` and a standalone `vignette:validate`; preserve the current `vignette:stage` behavior or migrate it compatibly.

P2 — FINISH S7 AND VIGNETTE AUDIO
1. Audit every S7 library entry. Implement only the IDs the Director and fixtures need first; flip `planned` to `available` only with real source/version/lock/registry wiring and tests. Include remaining semantic VFX, `world_text_3d`/`title_card` if required, door/bell/gasp/notification aliases, and the requested music beds or explicit substitutions to existing `sfx_*`/`mus_*` assets.
2. Build a deterministic BeatSheet/StagePlan audio timeline:
   - phrase narration/voice-over as primary audio when supplied;
   - timed SFX mapped from events and action contacts;
   - footsteps derived from actual movement/contact timing;
   - multiple music spans (the schema allows up to eight), ambience, fades, ducking, limiting, and target loudness;
   - hard failures for missing required cues, invalid spans, or unavailable locked assets.
3. Reuse `packages/audio*` and existing mixer/encoder where possible. Add tests for cue timing, segmented beds, determinism, loudness, clipping, silence, missing assets, and AV duration/sync.

P3 — CAPTURE VIDEO AND PRODUCE A VERIFIED FINAL MP4
1. Extend `packages/vignette/src/web-entry.ts`—which already poses `VignetteScene` at an exact time and renders a PNG using pre-solved shots—into deterministic frame-sequence/binary capture. Do not build a duplicate entry or re-solve cameras per frame.
2. Make an approved Node-side render manifest the authorization boundary: require phrase/semantic validation, zero unknowns, `requireAvailable: true`, locked resources, and matching sheet/audio/shot hashes before browser launch. The browser must verify IDs/hashes and must not authorize arbitrary sheet/library/shot objects itself.
3. Reuse the existing render worker rather than building a second encoder: frame batching, H.264, AAC-LC, MP4 muxing, fast-start, probing, playback verification, hashes, manifests, thumbnails/contact sheets, cancellation, cleanup, and quality reports.
4. Define explicit draft/final profiles with measurable FPS/frame rounding, codec/profile/pixel format, audio sample rate/channels, LUFS/true-peak limits, cue/silence policy, caption margins/contrast/minimum size, AV-sync tolerance, decode tolerance, duration rules, and CPU/memory/time ceilings. Final target is vertical 1080x1920. Do not apply the 14–22 s Visual Comedy duration gate to the 69 s narrated fixture without a product decision.
5. Add Vignette gates for stage PASS, availability, frame count/duration, camera safety, captions, narration/SFX/music presence, AV sync, codec/resolution, decode/playback, and no stale output reuse. Scope cross-machine determinism to canonical plans, PCM, selected diagnostic frames, and normalized media metadata unless the full toolchain is pinned.
6. Produce and verify at least one small diagnostic MP4 in tests, then the reference final MP4. Do not call it final merely because muxing succeeded.

P4 — ADD A VIGNETTE STUDIO/API FLOW
Extend the current Studio with a clearly separated Vignette mode:
- accept content-addressed script/audio upload IDs and hashes—never client-provided server paths—and exact phrase timing sources;
- select/pin resources and seed;
- run Director and show beat-sheet substitutions/planned/unavailable IDs;
- review beats, stage report, stills, camera/coverage blockers, and machine-readable details;
- immutable content-addressed approval tied to beat sheet, audio hash, resource locks, solved shots, and code/schema versions;
- draft/final render jobs with real progress, cancellation/retry, playback, reports, and downloads;
- disabled approval/render controls whenever required gates fail;
- safe upload handling and restart persistence consistent with the existing Narrated flow.

Add API, persistence, and browser tests. Keep the current Visual Comedy and Narrated workflows working.

P5 — CONNECT THE BULK CORE
Implement a production `EpisodePipeline` adapter that calls Vignette Director, validation, approval, draft render, final render, and artifact verification. Add CLI/API/Studio controls for 1–20 requests, concurrency, resume, cancel, retry, stop-on-first-error, and per-job progress. Preserve exact character/environment pins and hashes. Add output manifests, artifact hashes, cleanup/retention, crash recovery, and one real diagnostic end-to-end bulk render test. Resolve the documented simultaneous stale-lock-break race before claiming multi-process safety.

ZERO-COST MODEL POLICY
No paid model spend is authorized. Offline `rules` remains the default. For optional OpenRouter experiments, use a dedicated OpenRouter key with its provider-side credit limit explicitly set to `$0`, no auto top-up, and only `openrouter/free` or an exact `:free` model. The repository's compatible path is `--provider openai` with:
- `OPENAI_API_KEY=<OpenRouter key>` (the code does not read `OPENROUTER_API_KEY` directly),
- `BLOCKSPARK_LLM_BASE_URL=https://openrouter.ai/api/v1`,
- `BLOCKSPARK_LLM_MODEL=openrouter/free` or a verified structured-output-capable `:free` ID,
- `BLOCKSPARK_LLM_MAX_RETRIES=0` for bounded smoke tests.
Use a one-item dataset first. Never commit/log the key. Treat 400/422 format failures and free-capacity 429s as compatibility/capacity failures; never fall back to a paid model or remove the `$0` cap. Add native configuration/capability checks before exposing OpenRouter in UI or Director.

SAFETY, IP, AND ENGINEERING CONSTRAINTS
- Preserve strict schemas, unknown-key rejection, asset/library availability, exact version/hash locks, camera/coverage gates, and immutable approvals. Do not weaken a gate to make a demo pass.
- Use only original/procedural, commissioned, licensed-commercial, or CC0 assets with auditable provenance. No Roblox/competitor avatars, maps, logos, UI, sounds, footage, currency names, protected characters/brands, or real-person likenesses; do not imply affiliation. Rename the RBLX SPARK code name before launch.
- Treat all provider/user input as untrusted data. No eval, dynamic code execution, shell construction from input, path traversal, secret exposure, or client-side provider keys.
- Require human approval before publication. Deterministic safety scans are not comprehensive moderation.
- Preserve deterministic output for fixed input, seed, code, and locked assets. Record hashes and versions in manifests.
- Keep changes focused, tests close to behavior, and docs concise. Never claim competitor parity, production readiness, or final quality without measured acceptance evidence.

DEFINITION OF DONE
The final integration milestone is complete only when a supported command and Studio flow can take a script that passes defined automated policy gates plus recorded human approval, along with phrase-timed voice-over/resources; deterministically generate and validate an available-only BeatSheet; pass staging/camera/coverage gates on both positive reference fixtures while preserving negative fail-closed tests; mix timed audio; render and verify a final 1080x1920 H.264/AAC MP4; and repeat that workflow through a real resumable bulk adapter. Typecheck, full fast tests, targeted browser/render tests, fixture verdict tests, AV/probe/playback gates, and CI must pass from the final source tree. Update `docs/PRODUCT_STATUS.md` with exact commands/results and residual gaps, commit/push each coherent milestone, and provide PR links plus a candid final quality statement.
```