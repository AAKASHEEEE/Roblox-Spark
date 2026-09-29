# Quality report — Too Many Coins (`gen-ooe-zapp-has-a-baseball-fr9-s4042`)

**37/37 applicable gates passed** (core 23/23, production 2/2, motion 1/1, story 11/11). No failures.

Validation profile: `story-episode`. Duration target: 14-22 s.

> **Diagnostic profile** (270x480): low-resolution QA render — not a production output.

- Output: `out/bench-renders/run4-diag/HC42/gen-ooe-zapp-has-a-baseball-fr9-s4042.mp4` — 1.91 MB, sha256 `de7f4dae108478afd8dad07be0154f0340143f9ee92637f09fcdad122df52517`
- 270x480 @ 30 fps, 510 frames; render 201.8 ms/frame (6.05x real-time), total 119.6 s
- Renderer: WebKit WebGL; host 8x Intel(R) Xeon(R) Platinum 8488C; GPU: no (SwiftShader CPU); audio codec: aac

| Gate | Group | Result | Kind | Evidence |
|---|---|---|---|---|
| G01 Playable MP4 produced automatically (no screen recording) | core | PASS | measured | Chromium decoded 90 frames in 2.96s real-time playback, 0 dropped; errors: none |
| G02 Resolution (diagnostic profile 270x480) | core | PASS | measured | container 270x480, decoded 270x480 — DIAGNOSTIC render, not a production output |
| G03 Duration within the channel production boundary 14-22 s | core | PASS | measured | video 17.000s, audio presented 17.005s (edit list skips 1024 AAC priming samples) |
| G04 Stable frame rate | core | PASS | measured | 510 samples (expected 510), unique sample durations 1000 @ timescale 30000 => 30.000 fps constant |
| G05 Audio present, decodable, length matches video | core | PASS | measured | codec mp4a, 2ch 48000 Hz; decoded 344714 bytes; /audio-video/ = 5.0 ms |
| G06 Audio synchronised to visual events (<= 1 frame) | core | PASS | measured | synced cues are pinned to computed contact/impact times; repairs: none needed |
| G07 Premise (hero prop) visible within 1 s | core | PASS | measured | opening shot s01 prop_ecu on "button" from t=0; hard framing issues in first second: 0 |
| G08 Protagonist and hero prop identifiable | core | PASS | measured | zapp is a framed subject in 7 shots; face/framing issues on zapp: 0 |
| G09 No unexplained teleportation (actors/props) | core | PASS | measured | checked 510 consecutive frames: max plausible speed thresholds 7 m/s (actors) / 14 m/s (props) |
| G10 Cause -> effect: contact happens and triggers the event | core | PASS | measured | zapp.press_button@3.810s hand-to-target 0.0 cm; press/spawn causality validated |
| G11 Facial change at every information-change beat | core | PASS | static | every non-hook/loop information beat contains an expression change or emote |
| G12 Meaningful visual change every <= 1.5 s | core | PASS | static | longest interval without a new cut/action/expression/prop/VFX event: 1.231s |
| G13 No shot > 3 s without a cut | core | PASS | static | shot lengths: 1.05, 1.09, 1.15, 1.38, 1.14, 1.43, 1.20, 1.59, 0.95, 1.63, 1.61, 0.69, 1.00, 1.10 |
| G14 Largest physical reversal in the final 3 s | core | PASS | measured | largest impact coin:tip_over strength 16.7 at 14.26s (window starts 14.004999999999999s) |
| G15 Ending loops into the opening | core | PASS | measured | decoded last-vs-first frame mean abs diff 2.80% (a mid-episode control frame differs by 33.89%) |
| G16 Character identity locked (versioned manifests + hash lock) | core | PASS | static | zapp@1.0.0 sha256 558834f42521; kira@1.1.0 sha256 a928effc30ff; episodes cannot contain appearance fields (strict schema) |
| G17 All assets licensed/owned with metadata | core | PASS | static | every environment/character/prop/audio manifest carries license.source/author/license; all are original-procedural |
| G18 No protected branding or third-party IP | core | PASS | static | banned-term scan clean; no external meshes/textures/sounds are loaded by the engine at all |
| G19 Family-safe (no gore/sexual/weapons/real-money giveaways) | core | PASS | static | Generated from a user idea by the BlockSpark story pipeline; safety classification: safe. Fictional in-world coins only. |
| G20 Shot validation (screen-space bounds, face visibility, hand-vs-geometry penetration) | core | PASS | measured | 170 sampled frames: hard issues 0, soft issues 0; {"CAMERA_ADJUSTED":32} |
| G21 Planted feet do not slide during locomotion | core | PASS | measured | 66 planted-foot samples while moving: median 0.003 m/s, p95 0.007 m/s vs root speed 1.2-2.7 m/s. Excluded: 10 touchdown frames (max 0.93 m/s) and 12 run flight-phase frames |
| G22 Loudness normalised, no clipping | core | PASS | measured | integrated -14.19 LUFS (target -14), approx true peak -1.5 dBFS, limiter max GR -6.47 dB |
| G23 Story readable while muted | core | PASS | proxy | PROXY ONLY: every beat has a shot, causal chain is on screen, emotes/expressions carry the reactions and no dialogue is needed. A human viewing test is still required to confirm comprehension. |
| P01 Production export profile via builtin (H.264 yuv420p, CFR 30, AAC-LC 48 kHz stereo, fast-start) | production | PASS | measured | ok container=mov,mp4,m4a,3gp,3g2,mj2; ok fast-start (moov before mdat)=true; ok exactly one video stream=1; ok exactly one audio stream=1; ok video codec=h264; ok pixel format=yuv420p; ok resolution=270x480; ok constant frame rate=30/1 (avg 30/1); ok duration=17.000; ok audio codec=aac; ok audio profile=LC; ok audio sample rate=48000; ok audio channels=2; ok A/V duration match=5.0 ms |
| P02 AAC decodes in an independent decoder and is sample-aligned with the source mix | production | PASS | measured | Chromium AAC decoder SNR 23.22/23.26 dB vs source mix; MP4 decode (edit list applied) offset 0 samples (0.00 ms), 816240 samples decoded |
| M01 Swept hand volume clear during locomotion onsets/arrivals (4 substeps per frame, 1 cm tolerance) | motion | PASS | measured | no hand point entered a prop or collider by more than 1 cm between or on video frames |
| S01 Opening readability (premise prop fills the first second) | story | PASS | measured | opening shot prop_ecu on button for 1.049s; button covers 38.9% of frame at t=0.40 |
| S02 Causal prop visible at every cause (press contact) | story | PASS | measured | 3.81s s04 ok |
| S03 Characters introduced before they matter | story | PASS | static | protagonist zapp first framed at 1.05s (<= 3.0); foil kira at 2.14s (<= 7.65) |
| S04 Every cause precedes its result (press->coin->growth->impact) | story | PASS | static | press 3.81 -> spawn 3.88; spawn -> land 8.98 -> impact 14.26 |
| S05 Reaction within 0.9 s of every information change | story | PASS | static | 6 information events all followed by a reaction |
| S06 Largest reversal lands in the final 3 s (and before the payoff) | story | PASS | static | impact 14.26s, window [14.00, 16.20] |
| S07 Final composition matches the opening (loop) | story | PASS | measured | last shot final_loop on button; camera position difference first/last analysed frame 0.1 cm |
| S08 No long static interval (events <= 1.5 s apart, no frozen motion > 1 s) | story | PASS | measured | longest event gap 1.23s after t=6.00; longest fully static run 0.00s |
| S09 Shot variety (no repeated consecutive setup, >= 5 presets, none > 40%) | story | PASS | static | 14 shots, 8 presets, max share 21% |
| S10 No excessive character travel (<= 10 m per actor) | story | PASS | measured | zapp 5.1 m, kira 0.8 m |
| S11 Actions compatible with props (no carry/throw/drink without attachment) | story | PASS | static | all actions registered and prop-compatible |

## Notes
- Gates marked "proxy" approximate creative judgement and need human review.
- Frame issues are sampled every 3rd frame from the deterministic timeline before pixels are rendered.
