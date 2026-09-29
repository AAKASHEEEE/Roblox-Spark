# Quality report — Action reel reel3-locomotion (`diag-reel3-locomotion`)

**15/15 applicable gates passed** (core 13/13, production 2/2). No failures.

Validation profile: `action-reel` — not applicable: G03, G07, G08, G10, G11, G12, G13, G14, G15, G23. Duration target: 14-22 s.

> **Diagnostic profile** (540x960): low-resolution QA render — not a production output.

- Output: `out/action-reel/reel3-locomotion/diag-reel3-locomotion.mp4` — 4.04 MB, sha256 `087baff995139d6432a8a7f4fcb2a8ff55037fa62d04f86b2232a1f040c4e7d2`
- 540x960 @ 30 fps, 474 frames; render 112.6 ms/frame (3.38x real-time), total 64.6 s
- Renderer: WebKit WebGL; host 8x Intel(R) Xeon(R) Platinum 8488C; GPU: no (SwiftShader CPU); audio codec: aac

| Gate | Group | Result | Kind | Evidence |
|---|---|---|---|---|
| G01 Playable MP4 produced automatically (no screen recording) | core | PASS | measured | Chromium decoded 90 frames in 2.96s real-time playback, 0 dropped; errors: none |
| G02 Resolution (diagnostic profile 540x960) | core | PASS | measured | container 540x960, decoded 540x960 — DIAGNOSTIC render, not a production output |
| G03 Duration within the channel production boundary 14-22 s | core | n/a | measured | not applicable under validation profile action-reel (story-only gate). Measured anyway: video 15.800s, audio presented 15.800s (edit list skips 1024 AAC priming samples) |
| G04 Stable frame rate | core | PASS | measured | 474 samples (expected 474), unique sample durations 1000 @ timescale 30000 => 30.000 fps constant |
| G05 Audio present, decodable, length matches video | core | PASS | measured | codec mp4a, 2ch 48000 Hz; decoded 230284 bytes; /audio-video/ = 0.0 ms |
| G06 Audio synchronised to visual events (<= 1 frame) | core | PASS | measured | synced cues are pinned to computed contact/impact times; repairs: none needed |
| G07 Premise (hero prop) visible within 1 s | core | n/a | measured | not applicable under validation profile action-reel (story-only gate). Measured anyway: opening shot s01 wide_environment on "button" from t=0; hard framing issues in first second: 0 |
| G08 Protagonist and hero prop identifiable | core | n/a | measured | not applicable under validation profile action-reel (story-only gate). Measured anyway: zapp is a framed subject in 6 shots; face/framing issues on zapp: 0 |
| G09 No unexplained teleportation (actors/props) | core | PASS | measured | checked 474 consecutive frames: max plausible speed thresholds 7 m/s (actors) / 14 m/s (props) |
| G10 Cause -> effect: contact happens and triggers the event | core | n/a | measured | not applicable under validation profile action-reel (story-only gate). Measured anyway: ; press/spawn causality validated |
| G11 Facial change at every information-change beat | core | n/a | static | not applicable under validation profile action-reel (story-only gate). Measured anyway: every non-hook/loop information beat contains an expression change or emote |
| G12 Meaningful visual change every <= 1.5 s | core | n/a | static | not applicable under validation profile action-reel (story-only gate). Measured anyway: longest interval without a new cut/action/expression/prop/VFX event: 2.7s |
| G13 No shot > 3 s without a cut | core | n/a | static | not applicable under validation profile action-reel (story-only gate). Measured anyway: shot lengths: 3.10, 2.50, 2.50, 2.50, 2.50, 2.70 |
| G14 Largest physical reversal in the final 3 s | core | n/a | measured | not applicable under validation profile action-reel (story-only gate). Measured anyway: no impacts |
| G15 Ending loops into the opening | core | n/a | measured | not applicable under validation profile action-reel (story-only gate). Measured anyway: decoded last-vs-first frame mean abs diff 12.66% (a mid-episode control frame differs by 5.19%) |
| G16 Character identity locked (versioned manifests + hash lock) | core | PASS | static | zapp@1.0.0 sha256 558834f42521; kira@1.1.0 sha256 a928effc30ff; episodes cannot contain appearance fields (strict schema) |
| G17 All assets licensed/owned with metadata | core | PASS | static | every environment/character/prop/audio manifest carries license.source/author/license; all are original-procedural |
| G18 No protected branding or third-party IP | core | PASS | static | banned-term scan clean; no external meshes/textures/sounds are loaded by the engine at all |
| G19 Family-safe (no gore/sexual/weapons/real-money giveaways) | core | PASS | static | diagnostic reel |
| G20 Shot validation (screen-space bounds, face visibility, hand-vs-geometry penetration) | core | PASS | measured | 158 sampled frames: hard issues 0, soft issues 0; {"CAMERA_ADJUSTED":16} |
| G21 Planted feet do not slide during locomotion | core | PASS | measured | 181 planted-foot samples while moving: median 0.002 m/s, p95 0.003 m/s vs root speed 1.2-2.7 m/s. Excluded: 6 touchdown frames (max 0.00 m/s) and 86 run flight-phase frames |
| G22 Loudness normalised, no clipping | core | PASS | measured | integrated -20.23 LUFS (target -20), approx true peak -1.5 dBFS, limiter max GR -8.07 dB |
| G23 Story readable while muted | core | n/a | proxy | not applicable under validation profile action-reel (story-only gate). Measured anyway: PROXY ONLY: every beat has a shot, causal chain is on screen, emotes/expressions carry the reactions and no dialogue is needed. A human viewing test is still required to confirm comprehension. |
| P01 Production export profile via builtin (H.264 yuv420p, CFR 30, AAC-LC 48 kHz stereo, fast-start) | production | PASS | measured | ok container=mov,mp4,m4a,3gp,3g2,mj2; ok fast-start (moov before mdat)=true; ok exactly one video stream=1; ok exactly one audio stream=1; ok video codec=h264; ok pixel format=yuv420p; ok resolution=540x960; ok constant frame rate=30/1 (avg 30/1); ok duration=15.800; ok audio codec=aac; ok audio profile=LC; ok audio sample rate=48000; ok audio channels=2; ok A/V duration match=0.0 ms |
| P02 AAC decodes in an independent decoder and is sample-aligned with the source mix | production | PASS | measured | Chromium AAC decoder SNR 24.22/24.32 dB vs source mix; MP4 decode (edit list applied) offset 0 samples (0.00 ms), 758400 samples decoded |

## Notes
- Gates marked "proxy" approximate creative judgement and need human review.
- Frame issues are sampled every 3rd frame from the deterministic timeline before pixels are rendered.
