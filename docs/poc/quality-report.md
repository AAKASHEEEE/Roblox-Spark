# Quality report — Free Coins? (`free-coins-loop-001`)

**23/23 gates passed.** No failures.

- Output: `out/free-coins-loop-001/free-coins-loop-001.mp4` — 22.43 MB, sha256 `f8c0a2bdc15305e4e84614e38af7090b42df166ee3dde13fbf18b4c7af2d2609`
- 1080x1920 @ 30 fps, 510 frames; render 429.7 ms/frame (12.89x real-time), total 230.2 s
- Renderer: WebKit WebGL; host 8x Intel(R) Xeon(R) Platinum 8488C; GPU: no (SwiftShader CPU)

| Gate | Result | Kind | Evidence |
|---|---|---|---|
| G01 Playable MP4 produced automatically (no screen recording) | PASS | measured | Chromium decoded 90 frames in 2.96s real-time playback, 0 dropped; errors: none |
| G02 Resolution 1080x1920 | PASS | measured | container 1080x1920, decoded 1080x1920 |
| G03 Duration 14-18 s | PASS | measured | video 17.000s, audio 17.020s (incl. 312-sample Opus pre-skip) |
| G04 Stable frame rate | PASS | measured | 510 samples (expected 510), unique sample durations 1000 @ timescale 30000 => 30.000 fps constant |
| G05 Audio present, decodable, length matches video | PASS | measured | codec Opus, 2ch 48000 Hz; decoded 395291 bytes; /audio-video/ = 13.5 ms |
| G06 Audio synchronised to visual events (<= 1 frame) | PASS | measured | synced cues are pinned to computed contact/impact times; repairs: none needed |
| G07 Premise (hero prop) visible within 1 s | PASS | measured | opening shot s01 prop_ecu on "button" from t=0; hard framing issues in first second: 0 |
| G08 Protagonist and hero prop identifiable | PASS | measured | zapp is a framed subject in 6 shots; face/framing issues on zapp: 0 |
| G09 No unexplained teleportation (actors/props) | PASS | measured | checked 510 consecutive frames: max plausible speed thresholds 7 m/s (actors) / 14 m/s (props) |
| G10 Cause -> effect: contact happens and triggers the event | PASS | measured | zapp.press_button@3.828s hand-to-target 0.0 cm; press/spawn causality validated |
| G11 Facial change at every information-change beat | PASS | static | every non-hook/loop information beat contains an expression change or emote |
| G12 Meaningful visual change every <= 1.5 s | PASS | static | longest interval without a new cut/action/expression/prop/VFX event: 1.2s |
| G13 No shot > 3 s without a cut | PASS | static | shot lengths: 1.20, 1.05, 1.05, 1.30, 1.20, 1.40, 1.25, 1.55, 1.30, 1.30, 2.30, 1.00, 1.10 |
| G14 Largest physical reversal in the final 3 s | PASS | measured | largest impact coin:tip_over strength 16.7 at 14.25s (window starts 14s) |
| G15 Ending loops into the opening | PASS | measured | decoded last-vs-first frame mean abs diff 2.62% (a mid-episode control frame differs by 33.81%) |
| G16 Character identity locked (versioned manifests + hash lock) | PASS | static | zapp@1.0.0 sha256 558834f42521; kira@1.0.0 sha256 54c5948d437e; episodes cannot contain appearance fields (strict schema) |
| G17 All assets licensed/owned with metadata | PASS | static | every environment/character/prop/audio manifest carries license.source/author/license; all are original-procedural |
| G18 No protected branding or third-party IP | PASS | static | banned-term scan clean; no external meshes/textures/sounds are loaded by the engine at all |
| G19 Family-safe (no gore/sexual/weapons/real-money giveaways) | PASS | static | In-world fictional coins only; no real currency, no platform currency names, no calls to action. |
| G20 Shot validation (screen-space bounds, face visibility, hand-vs-geometry penetration) | PASS | measured | 170 sampled frames: hard issues 0, soft issues 1; {"CAMERA_ADJUSTED":38,"SUBJECT_OUTSIDE_ACTION_SAFE":1} |
| G21 Planted feet do not slide during locomotion | PASS | measured | 40 planted-foot samples while moving: median 0.005 m/s, p95 0.041 m/s vs root speed 1.2-2.7 m/s. Excluded: 8 touchdown frames (max 2.94 m/s) and 13 run flight-phase frames |
| G22 Loudness normalised, no clipping | PASS | measured | integrated -14.1 LUFS (target -14), approx true peak -1.5 dBFS, limiter max GR -6.56 dB |
| G23 Story readable while muted | PASS | proxy | PROXY ONLY: every beat has a shot, causal chain is on screen, emotes/expressions carry the reactions and no dialogue is needed. A human viewing test is still required to confirm comprehension. |

## Notes
- Gates marked "proxy" approximate creative judgement and need human review.
- Frame issues are sampled every 3rd frame from the deterministic timeline before pixels are rendered.
