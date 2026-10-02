# BlockSpark Studio — production v4 status (2 October 2026)

## Current candidate

Use `production/competitor-v4`. This branch extends the existing Vignette/Director/render-worker systems; it does not replace them.

## Verified no-render canonical result

The approved free-coins classroom fixture currently has:

- 14 narration beats and exactly 41 camera compositions;
- 38 authored recipe cameras, 3 accepted safety fallbacks, and 0 blocked compositions;
- 55/55 cut-independent semantic/script-event requirements realized;
- 41/41 required composition subjects separately enforced and visible;
- 22/22 literal clauses, 11/11 required action clauses, and 1/1 prop-state clauses realized;
- exactly 2,075/2,075 output frames assigned and accepted after scene and S7 camera effects;
- deterministic leading, inter-beat-gap, tail, and final-frame holds;
- 0 staging errors and 0 staging warnings;
- unchanged approved narration text/timing and impact at 56.936 s;
- no Kira cut during “FLATTENS Zapp”, teacher/Kira return coverage, and readable button reset;
- narrator audio never drives actor mouths.

The multi-set fixture passes at 100% semantic coverage with 4 recipe cameras, 0 fallbacks, 0 blocked cameras, and 0 staging errors/warnings. Legacy narrated analysis remains exactly 47/47.

## Safety and trust boundaries

- Director output is deterministic and validates with `requireAvailable: true`.
- Director-origin BeatSheets require an exact, versioned semantic-requirements sidecar before staging or rendering.
- Unknown/unrealized content and unmodeled spatial relations block authorization rather than silently becoming idle/default scenery.
- Only explicitly approved set substitutions are permitted.
- OpenRouter remains optional and free-only (`openrouter/free` or exact `:free` IDs); its bearer credential is restricted to the OpenRouter HTTPS API origin.
- Trusted rendering requires input-manifest schema v3, worker-safe isolated output, authenticated input/runtime bytes, output-decoded representative frames, and an independently supplied Ed25519 worker attestation.
- Historical schema-v2 media remains retroactive integrity evidence only: `partial`, never trusted/current.

## Regression status

Latest completed checks before the final media pass:

- TypeScript typecheck: PASS.
- Root unit suite: 502 passed, 0 failed, 1 skipped.
- Captions suite: 35/35 passed.
- E2E suite: 3/3 passed.
- Asset lock: 70 locked, 0 added.
- Environment lock: 5/5 profiles unchanged.
- Generated set manifests: verified.
- Narrated integration: 47/47 gates pass.
- Canonical no-render stage: PASS, 100%, 38 recipe / 3 fallback / 0 blocked, 0 errors/warnings.
- Multi-set no-render stage: PASS, 100%, 4 / 0 / 0, 0 errors/warnings.

## Arbitrary-script truth

A final 40-script no-render evaluation returned and strictly validated all 40 Director results deterministically. All 20 deliberately broad unsupported scripts were rejected before staging by semantic authorization, which is the intended safe behavior. Of 20 catalog-oriented scripts, 19 were semantically authorized and 3 achieved the complete production-style no-render PASS. The remaining catalog scripts exposed real camera/action/prop-transition limitations and were not softened or hidden.

Therefore v4 is a strong safe canonical MVP and a fail-closed arbitrary-script foundation, but it is not yet a high-pass-rate arbitrary catalog production system. Visual superiority cannot be claimed from technical gates alone.

## Media status

A fresh v4 **visual-review** MP4 was generated after the no-render gates passed:

- `out/v4-review-render/s7-vignette.mp4`
- SHA-256 `df8dfab37f73674872bdacdb07793f938fec6564827e555d1877d701145fb0a3`
- 22,816,997 bytes; 540×960; H.264 High/yuv420p; 30 fps; exactly 2,075 frames; 69.167 s
- AAC-LC 48 kHz stereo; 0 ms measured A/V lag; independent playback/probe PASS; 0 dropped playback frames

The original approved narration MP3 was not present in the repository or release assets. This review file therefore uses an explicitly generated silent optional-audio bed plus the 19 authored original SFX cues and no music. It is suitable for visual review, but it is **not** trusted final narration evidence and must not be represented as such. A fully trusted release still requires the original approved voice bytes (or new human-approved voice), schema-v3 scheduler authorization, decoded-frame commitments, and the independent worker signature.

The checked PR #23 MP4 remains stale historical media and is not evidence for v4.

## IP and publication rules

Use only original/procedural, commissioned, licensed-commercial, or CC0 assets with exact provenance. Never copy competitor/Roblox avatars, maps, UI, scripts, footage, audio, logos, currencies, or trade dress. Human approval is required before publication.
