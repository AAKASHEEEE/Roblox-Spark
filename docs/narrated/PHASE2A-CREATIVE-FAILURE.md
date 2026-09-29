# Phase 2A draft — creative and spatial-continuity failure analysis

Subject: `draft-540x960.mp4` from commit `de012e1` (approval `na-76a6b5f26af5f9e0`, 69.167 s, 39 shots, 26 caption chunks). It passed 18/18 technical gates and **fails creative and spatial-continuity review**.

Evidence comes only from the existing draft; nothing was re-rendered:
- frames extracted from the MP4 at 12 / 50 / 88 % of each interval;
- the job's `analysis.json` (per-frame shot issues on every 3rd frame, actor probes);
- the job's `render-timeline.json` and `episode.json`;
- headless state evaluation of that same `episode.json`, with no pixels (actor and prop world positions, poses and camera positions).

## Core finding
**Each shot and each beat is staged independently. Actor and prop world state is never modelled, so it does not stay semantically continuous across shots.**

The engine itself is time-continuous: a cut never resets its state. But the timeline compiler writes one isolated action per phrase and one isolated camera per chunk, with no world state, preconditions or spatial relations. The result is continuous nonsense:
- things the narration moves never move;
- things that interact are metres apart;
- poses snap;
- cameras are placed without regard to the bodies around them.

## Per-interval findings

| # | Interval (s) | Narration (abridged) | What the draft shows | Failures | Evidence |
|---|---|---|---|---|---|
| 1 | 0.00–4.30 | "…difference between Zapp and Kira when the teacher leaves" | s001: Zapp's head cropped, looking away toward `enter_back_left` (not a door: the classroom has no door geometry). s002 over-the-shoulder: lens 0.86 m behind Kira's head, so her black hair covers about half the frame. s003 two-shot is the only readable frame. | F5, F6, F11 | FACE_TURNED_AWAY ×9 and SUBJECT_OUTSIDE_ACTION_SAFE ×17 frames |
| 2 | 4.60–9.32 | "The second the door closes, Zapp thinks the classroom belongs to him" | Three near-identical Zapp close-ups (medium, punch-in, medium). `curious_lean` toward Kira does not express "belongs to him". No door-close cue. | F7, F1 | 3 cuts, 1 subject, no change of composition |
| 3 | 9.58–15.44 | "He jumps up, celebrates…" | The jump (0.49 m sole height at 10.10 s) happens inside a tight punch-in, so the face leaves frame and feet/floor are never visible. "Celebrates" is not staged: only one action per phrase. | F6, F1 | FACE_OUT_OF_FRAME ×5 |
| 4 | 15.68–20.26 | "Kira stays at her desk because she knows the teacher could return" | Kira looks back toward the "door" inside a frontal shot, so we see the back of her head. She stands with arms crossed: there is no sit action and no desk at `kira_desk`. | F6, F1 (sit n/a) | FACE_TURNED_AWAY ×8 |
| 5 | 20.96–25.62 | "Zapp notices a suspicious free-coins button" | Button close-up twice. s014 over-the-shoulder: lens **0.43 m from Kira's face**, and the frame is a solid blue hoodie. Not flagged. | F5, F7 | Camera (0.81, 1.56, −0.51); 0 issues logged |
| 6 | 25.94–31.30 | "Kira tells him not to touch it, which makes him want to press it" | Two-shots are fine. s017 punch-in crops Kira to eyes and mouth. Zapp's "want to press it" is not acted. | F6, F12 | — |
| 7 | 31.52–34.90 | "He slams the button, and one shiny coin appears" | Best beat: press contact at 31.948, coin pops from the button to `desk.coin_spot` and lands at 32.54. The button close-up shows only a sleeve, so the "slam" is not readable. | F6 (minor) | Hand–button contact 5.7 cm |
| 8 | 35.20–39.86 | "Zapp celebrates so loudly…" | `victory_pose` reads in the medium shot. The punch-in crops the head. | F6 (minor) | FACE_OUT_OF_FRAME ×1 |
| 9 | 40.24–43.96 | "the button flashes again, and the coin begins growing" | The coin stands and grows ×3 → ×6 **on the desk, 0.64 m in front of Zapp**, so his hands penetrate it. In s024 the lens is 0.56 m from the coin surface, so the rim fills the frame. The shock reaction (40.29) comes before the growth (40.64). | F4, F5, F10 | HAND_PENETRATION ×13 |
| 10 | 44.22–49.50 | "taller than the desk, wider than Zapp, almost fills the room" | The ×6 coin **hops by itself over Zapp's head** (apex 2.11 m) to `coin_floor` (−1.70, −1.20), then grows to ×16.7 (3.0 m). Scale reads in the coin close-up. Kira should start moving here and does not. | F2, F1, F5 | CAMERA_ADJUSTED ×15, FACE_OCCLUDED ×2 |
| 11 | 49.86–54.70 | "Zapp tries to look confident, but Kira has already moved safely out of the way" | Zapp crosses his arms at his desk, 2.2 m from the coin's future landing zone. **Kira never moved**: her root is (1.30, −0.35) for all 69 s and `kira_safe` is unused. s030 over-the-shoulder is filled with coin rim and hair. | F1, F5, F12 | Kira root constant |
| 12 | 55.06–59.48 | "The giant coin tips forward and flattens Zapp against the floor" | The coin tips toward +z over 55.11–55.76 and comes to rest with its centre at (−1.70, 0.53), radius 1.50 m. **Zapp's fall starts at 55.11, before any contact**, at `zapp_desk`: 2.22 m from the coin centre, **0.72 m outside its footprint**. He ends supine behind his desk and is invisible in both wide shots. There is no contact frame. The coin, seen edge-on, reads as a **flat yellow slab** even though its 0.50 m thickness is kept. | F2, F8, F10 | CAMERA_ADJUSTED ×23 |
| 13 | 59.86–64.94 | "the teacher returns and sees Kira sitting perfectly still" | Kira again looks away inside a frontal shot (back of her head). She is standing, not sitting. The low-angle shot shows the coin as a slab. | F6, F1 | FACE_TURNED_AWAY ×8 |
| 14 | 65.30–69.08 | "the free-coins button quietly resets for its next victim" | Reset and flash are fine. **At 65.37–65.50 Zapp's face height goes 0.53 → 1.70 m in 4 frames**: the "flattened" victim pops up standing behind the button. The video ends on the empty coin slab with no characters. | F3, F7 | Face y per frame: 0.53, 0.69, 1.19, 1.57, 1.70 |

## Cross-cutting failures
- **F1 — World state is static and semantically wrong.**
  - Neither actor ever leaves its start mark: Zapp stays at (0.25, −0.52), Kira at (1.30, −0.35).
  - Locomotion is replaced by in-place jumps.
  - Movement the narration requires ("moved safely out of the way") and states it describes ("sitting", "at her desk") are not staged, and are not flagged as unavailable.
- **F2 — Cause and effect are spatially decoupled.**
  - Coin positions come from fixed anchors (`desk.coin_spot`, `coin_floor`), and actor positions from fixed start marks. Nothing relates the tip trajectory to Zapp.
  - The coin moves itself (the hop) without cause.
- **F3 — Pose discontinuity.** A held end pose (`fall`, supine) is blended into the next action in 0.12–0.15 s. There is no get-up transition and no precondition check.
- **F4 — Interpenetration.** Props grow into an actor's space with no clearance check.
- **F5 — Camera inside or against geometry.** Over-the-shoulder and prop close-ups put the lens 0.43–0.86 m from heads (inside the block-hair volume) or 0.56 m from a coin surface. Characters and hair are not camera colliders, and prop occlusion is never evaluated during analysis.
- **F6 — Face framing.**
  - Frontal presets are used while the actor looks away (the back of the head is on screen).
  - Tight punch-ins are used for actions with vertical travel.
  - There are extreme crops.
- **F7 — Monotony and weak payoff.** There are runs of three near-identical close-ups and repeated button close-ups, and the last shot has no characters.
- **F8 — "Flat slab".** A 3.0 m disc (0.50 m thick) lies at 86°, far from everyone, and is shown edge-on from low angles. Its face and emblem are never visible after the fall.
- **F9 — Captions** sit at a fixed 72 % height and fall on chins in punch-ins (#3, #6). There is no face or prop avoidance.
- **F10 — Emotion and cause timing** is keyed to phrase starts, not to events: shock precedes the growth, and the fall precedes the impact.
- **F11 — Off-screen teacher.** Characters look at `enter_back_left`, which is not a door. The creak cue plays, but the looks read as "turns away", not "someone is at the door".
- **F12 — Supporting characters** are framed without purpose (Kira in the background of Zapp beats), or are omitted when their action is the point ("Kira has already moved").

## Why 18/18 technical gates passed
The draft gates (`apps/studio/narrated-draft.ts`, `narratedGates`) measure format, timing and captions. N05 only checks that in at least one shot per phrase the first subject is **not entirely out of frame** in more than 10 % of analysed frames. Everything else went ungated:
- FACE_TURNED_AWAY, FACE_OUT_OF_FRAME, FACE_OCCLUDED, HAND_PENETRATION and CAMERA_ADJUSTED were logged but not gated;
- PROP_OCCLUDED is never computed, because `analyze` runs without occlusion options;
- there are no continuity, semantic or camera-geometry gates.

## Root cause in code

| Module | Function | Responsibility for the failure |
|---|---|---|
| `packages/narrated/src/timeline.ts` | `compileNarratedTimeline` | One action per phrase at `phrase.start + 0.05`, with no world state, preconditions or end state. `busyUntil` only prevents overlap. Locomotion becomes `jump`. The prop chain is hard-coded (`[3, 6]` on the desk, `hop_to coin_floor`, `[11, 16.7]`, `tip_over endDeg 86`), using fixed anchors unrelated to actor positions. Reactions fire at phrase start, not on events. |
| `packages/narrated/src/timeline.ts` | shot loop + `normalize` | Each chunk's camera is picked from that phrase's own fields, plus a seeded choice that only avoids repeating the previous preset. There is no action-line side, no face-direction check, no body-part framing requirement and no geometry check. |
| `packages/narrated/src/timeline.ts` | `draftEpisode` | Cast is fixed at `zapp_desk` / `kira_desk` for the whole episode. There are no staging marks for impact, safety or door, and no `to` destinations. |
| `packages/narrated/src/semantics.ts` | `interpretPhrase` | Extracts one verb → action for one actor. It keeps no arguments: no destination ("out of the way"), no patient or agent geometry for "flattens", and no action for the supporting character. |
| `packages/engine/src/camera.ts` | `solveShot` | Solves each preset from subject points at a solve time. Only environment colliders and the camera-safe box are considered. Over-the-shoulder offsets (0.75 m back, 0.42 m to the side) land inside other characters' heads and hair. |
| `packages/engine/src/production.ts` | `validateFrame` / analysis | Camera checks cover props and environment only. There is no camera-inside-character check, no foreground-coverage measure and no face-visibility fraction. |
| `packages/engine/src/animation/animator.ts` | segment blending | A `holds: true` pose (fall, dive_prone) blends into the next action over `blendIn` (0.12–0.15 s). There is no transition contract (get up). |
| `packages/engine/src/props.ts` | `tip_over` | Always tips toward +z, pivoting on its own bottom edge, with a fixed `endDeg` and a bounce. It has no target, no contact solve against actors and no coupled actor response. |
| `packages/engine/src/capture.ts` | `drawCaption` | Placement is fixed at `centerY` 0.72; faces and props are ignored. |
| `apps/studio/narrated-draft.ts` | `narratedGates` | Gates staging only through the weak N05 check (see above). |
