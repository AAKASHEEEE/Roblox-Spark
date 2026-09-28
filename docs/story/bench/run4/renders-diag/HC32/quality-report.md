# Quality report — The Smart Way (`gen-nvs-kira-thinks-she-has-a2v-s4032`)

**37/37 applicable gates passed** (core 23/23, production 2/2, motion 1/1, story 11/11). No failures.

Validation profile: `story-episode`. Duration target: 14-22 s.

> **Diagnostic profile** (270x480): low-resolution QA render — not a production output.

- Output: `out/bench-renders/run4-diag/HC32/gen-nvs-kira-thinks-she-has-a2v-s4032.mp4` — 2.09 MB, sha256 `11c5449fb9e94a7ebee275334ab29814c424ef2d83c64de2f08f7e0d6beff4ef`
- 270x480 @ 30 fps, 555 frames; render 204.5 ms/frame (6.14x real-time), total 143.6 s
- Renderer: WebKit WebGL; host 8x Intel(R) Xeon(R) Platinum 8488C; GPU: no (SwiftShader CPU); audio codec: aac

| Gate | Group | Result | Kind | Evidence |
|---|---|---|---|---|
| G01 Playable MP4 produced automatically (no screen recording) | core | PASS | measured | Chromium decoded 90 frames in 2.96s real-time playback, 0 dropped; errors: none |
| G02 Resolution (diagnostic profile 270x480) | core | PASS | measured | container 270x480, decoded 270x480 — DIAGNOSTIC render, not a production output |
| G03 Duration within the channel production boundary 14-22 s | core | PASS | measured | video 18.500s, audio presented 18.499s (edit list skips 1024 AAC priming samples) |
| G04 Stable frame rate | core | PASS | measured | 555 samples (expected 555), unique sample durations 1000 @ timescale 30000 => 30.000 fps constant |
| G05 Audio present, decodable, length matches video | core | PASS | measured | codec mp4a, 2ch 48000 Hz; decoded 330060 bytes; /audio-video/ = 1.0 ms |
| G06 Audio synchronised to visual events (<= 1 frame) | core | PASS | measured | synced cues are pinned to computed contact/impact times; repairs: none needed |
| G07 Premise (hero prop) visible within 1 s | core | PASS | measured | opening shot s01 prop_ecu on "button" from t=0; hard framing issues in first second: 0 |
| G08 Protagonist and hero prop identifiable | core | PASS | measured | zapp is a framed subject in 5 shots; face/framing issues on zapp: 0 |
| G09 No unexplained teleportation (actors/props) | core | PASS | measured | checked 555 consecutive frames: max plausible speed thresholds 7 m/s (actors) / 14 m/s (props) |
| G10 Cause -> effect: contact happens and triggers the event | core | PASS | measured | zapp.press_button@2.570s hand-to-target 0.0 cm; kira.press_button@6.705s hand-to-target 0.0 cm; kira.press_button@7.705s hand-to-target 0.0 cm; press/spawn causality validated |
| G11 Facial change at every information-change beat | core | PASS | static | every non-hook/loop information beat contains an expression change or emote |
| G12 Meaningful visual change every <= 1.5 s | core | PASS | static | longest interval without a new cut/action/expression/prop/VFX event: 1.1s |
| G13 No shot > 3 s without a cut | core | PASS | static | shot lengths: 0.90, 1.14, 1.25, 1.30, 1.25, 2.89, 1.15, 1.61, 0.95, 1.66, 1.61, 0.69, 1.00, 1.10 |
| G14 Largest physical reversal in the final 3 s | core | PASS | measured | largest impact coin:tip_over strength 16.7 at 15.75s (window starts 15.498999999999999s) |
| G15 Ending loops into the opening | core | PASS | measured | decoded last-vs-first frame mean abs diff 3.08% (a mid-episode control frame differs by 27.35%) |
| G16 Character identity locked (versioned manifests + hash lock) | core | PASS | static | zapp@1.0.0 sha256 558834f42521; kira@1.1.0 sha256 a928effc30ff; episodes cannot contain appearance fields (strict schema) |
| G17 All assets licensed/owned with metadata | core | PASS | static | every environment/character/prop/audio manifest carries license.source/author/license; all are original-procedural |
| G18 No protected branding or third-party IP | core | PASS | static | banned-term scan clean; no external meshes/textures/sounds are loaded by the engine at all |
| G19 Family-safe (no gore/sexual/weapons/real-money giveaways) | core | PASS | static | Generated from a user idea by the BlockSpark story pipeline; safety classification: safe. Fictional in-world coins only. |
| G20 Shot validation (screen-space bounds, face visibility, hand-vs-geometry penetration) | core | PASS | measured | 185 sampled frames: hard issues 0, soft issues 0; {"CAMERA_ADJUSTED":33} |
| G21 Planted feet do not slide during locomotion | core | PASS | measured | 118 planted-foot samples while moving: median 0.003 m/s, p95 0.006 m/s vs root speed 1.2-2.7 m/s. Excluded: 15 touchdown frames (max 0.45 m/s) and 12 run flight-phase frames |
| G22 Loudness normalised, no clipping | core | PASS | measured | integrated -14.23 LUFS (target -14), approx true peak -1.5 dBFS, limiter max GR -6.78 dB |
| G23 Story readable while muted | core | PASS | proxy | PROXY ONLY: every beat has a shot, causal chain is on screen, emotes/expressions carry the reactions and no dialogue is needed. A human viewing test is still required to confirm comprehension. |
| P01 Production export profile via builtin (H.264 yuv420p, CFR 30, AAC-LC 48 kHz stereo, fast-start) | production | PASS | measured | ok container=mov,mp4,m4a,3gp,3g2,mj2; ok fast-start (moov before mdat)=true; ok exactly one video stream=1; ok exactly one audio stream=1; ok video codec=h264; ok pixel format=yuv420p; ok resolution=270x480; ok constant frame rate=30/1 (avg 30/1); ok duration=18.500; ok audio codec=aac; ok audio profile=LC; ok audio sample rate=48000; ok audio channels=2; ok A/V duration match=1.0 ms |
| P02 AAC decodes in an independent decoder and is sample-aligned with the source mix | production | PASS | measured | Chromium AAC decoder SNR 22.77/22.74 dB vs source mix; MP4 decode (edit list applied) offset 0 samples (0.00 ms), 888000 samples decoded |
| M01 Swept hand volume clear during locomotion onsets/arrivals (4 substeps per frame, 1 cm tolerance) | motion | PASS | measured | no hand point entered a prop or collider by more than 1 cm between or on video frames |
| S01 Opening readability (premise prop fills the first second) | story | PASS | measured | opening shot prop_ecu on button for 0.9s; button covers 39.5% of frame at t=0.40 |
| S02 Causal prop visible at every cause (press contact) | story | PASS | measured | 2.57s s03 ok; 6.71s s06 ok; 7.71s s06 ok |
| S03 Characters introduced before they matter | story | PASS | static | protagonist zapp first framed at 0.90s (<= 3.0); foil kira at 3.29s (<= 8.32) |
| S04 Every cause precedes its result (press->coin->growth->impact) | story | PASS | static | press 2.57 -> spawn 2.64; spawn -> land 10.43 -> impact 15.75 |
| S05 Reaction within 0.9 s of every information change | story | PASS | static | 6 information events all followed by a reaction |
| S06 Largest reversal lands in the final 3 s (and before the payoff) | story | PASS | static | impact 15.75s, window [15.50, 17.70] |
| S07 Final composition matches the opening (loop) | story | PASS | measured | last shot final_loop on button; camera position difference first/last analysed frame 0.0 cm |
| S08 No long static interval (events <= 1.5 s apart, no frozen motion > 1 s) | story | PASS | measured | longest event gap 1.10s after t=3.49; longest fully static run 0.00s |
| S09 Shot variety (no repeated consecutive setup, >= 5 presets, none > 40%) | story | PASS | static | 14 shots, 6 presets, max share 29% |
| S10 No excessive character travel (<= 10 m per actor) | story | PASS | measured | zapp 3.9 m, kira 4.9 m |
| S11 Actions compatible with props (no carry/throw/drink without attachment) | story | PASS | static | all actions registered and prop-compatible |

## Notes
- Gates marked "proxy" approximate creative judgement and need human review.
- Frame issues are sampled every 3rd frame from the deterministic timeline before pixels are rendered.
