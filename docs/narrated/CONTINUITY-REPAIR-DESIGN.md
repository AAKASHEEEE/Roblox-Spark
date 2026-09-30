# Narrated drafts — continuity repair design (not implemented)

Status: design for review. Nothing here is implemented; no code, render or asset has changed. It fixes the failures in `PHASE2A-CREATIVE-FAILURE.md`. The approach is to make **world state an explicit, authoritative model** that every beat, shot, caption and gate reads, instead of staging each shot on its own.

Units are metres, degrees and seconds. Classroom axes: +x = stage right, +y = up, +z = toward the audience.

## 1. World state model (persistent across beats and cuts)

```ts
interface ActorState {
  pos: Vec3; yawDeg: number;                  // root on the floor
  mark: MarkId | null;                        // null while travelling
  posture: 'standing' | 'crouching' | 'seated' | 'prone' | 'supine' | 'airborne';
  pose: string;                               // held end pose of the last contract (e.g. 'dive_prone:end')
  lookAt: Ref | null; expression: Expression;
}
interface PropState {
  visible: boolean; parent: 'floor' | 'desk' | PropInstance;
  baseAnchor: Vec3;                           // world bottom-contact point (fixed while growing)
  pos: Vec3; scale: number; rotDeg: [x: number, y: number, z: number]; upright: number;
  phase: 'hidden' | 'airborne' | 'resting' | 'growing' | 'tipping' | 'fallen';
  capDepth?: number; glow?: number;           // the button
}
interface WorldState {
  t: number; actors: Record<ActorId, ActorState>; props: Record<PropInstance, PropState>;
  contacts: Array<{ a: EntityRef; b: EntityRef; since: number }>;
  offscreen: Record<string, { at: 'classroom_door'; state: 'outside' | 'at_door' | 'inside_offscreen' }>;
}
```

- The compiler **folds** approved beats through action contracts (section 3). This produces a keyframed `WorldTrack`: the state at every contract boundary plus the contract trajectories between them.
- Engine actions and prop events are *emitted from* those transitions, never chosen per beat on their own.
- **Camera cuts never touch world state.** A shot is a read-only view of `WorldTrack(t)`; the camera solver receives positions from it.

## 2. Named staging marks
The names below are required. Four already exist in `classroom@1.1.0`; the rest are added as marks only, in a **new asset version `classroom@1.2.0`** (same geometry and lighting, new lock hash via `npm run assets:lock`). This is not a new environment.

| Mark | World position / facing | Source | Notes |
|---|---|---|---|
| `zapp_desk` | (0.25, 0, −0.52), 0° | existing | Behind the hero desk (desk at the origin) |
| `kira_desk` | (1.30, 0, −0.35), −50° | existing | No chair exists here (see section 11) |
| `button_desk` | desk anchor `button_spot` → (−0.10, 0.76, −0.12) | alias of a prop anchor | Press target `button.press_surface` |
| `coin_spawn` | (−2.10, 0, −1.40) | **new** | Floor landing spot of the pop; clear of the desks (bg_desk_1 is at z −3.06…−2.44) and the hero desk (x ≥ −0.5) for a 3.0 m coin |
| `kira_safe` | (2.50, 0, 0.60), 20° | existing | Outside every coin footprint and sweep (x ≥ 1.0) |
| `zapp_impact` | (−2.10, 0, 1.20), facing 0° (to the audience) | **new** | 2.35 m in front of the tip pivot; see section 7 |
| `classroom_door` | (−4.40, 0, −3.40) | **new**, off-screen | There is no door geometry: this is a look and sound target only and must never be framed |

Walk waypoints are existing marks where possible. For Zapp: `zapp_desk` → (−0.90, 0, −0.52) → (−0.90, 0, 1.20) → `zapp_impact`. That path stays behind and beside the desk (desk z −0.30…0.30) and in front of the coin's front face (z = −1.15).

## 3. Action contracts
Every semantic action is data, following this format:

```ts
interface ActionContract {
  id: string;                                  // 'jump', 'walk_to', 'press', 'grow', 'tip_onto', 'flatten', 'reset', 'sit', ...
  entities: { agent?: Role; patient?: Role; instrument?: Role; place?: MarkId };
  emit: Array<{ engineAction?: ActionName; propEvent?: PropEventName; params?: Record<string, number | string> }>;
  pre: Predicate[];        // must hold in WorldState at start (else: insert a bridging contract or block the beat)
  start: StateSpec;        // required start state (posture, position, visibility)
  trajectory: { kind: 'in_place' | 'path' | 'ballistic' | 'pivot_bottom_edge' | 'scale_about_base' | 'pose_blend' | 'coupled';
                path?: MarkId[]; pivot?: Ref; toward?: Ref; durationSec: [number, number]; maxSpeed?: number };
  contact?: { between: [Role, Role]; atU: number; tolerance: number; once: true };
  end: StateSpec;          // handed to the next beat and shot
  affects: Role[];         // entities whose state changes
  measure: Check[];        // semantic validation (section 6)
  framing: Array<'full_body' | 'feet' | 'face' | 'hands' | 'prop' | 'patient'>; // what a shot must show while it happens
}
```

| Contract | Preconditions | Trajectory | Contact | End state handed on | Emits (registered only) |
|---|---|---|---|---|---|
| `jump` | agent standing | root rises ≥ 0.25 m and returns to the same spot | feet leave and re-touch the floor | standing, same mark | `jump` |
| `walk_to(mark)` | standing; path clear by 0.25 m | path through waypoints, ≤ 1.1 m/s | — | standing at mark, yaw = mark facing | `walk` (`to`) |
| `move_safely_to(mark)` | as `walk_to`; mark outside every hazard footprint and sweep | path | — | standing at mark; `safe = true` | `walk` (or `run`) |
| `notice(x)` | x visible from the agent | head and torso turn toward x | — | lookAt x | `look_at` |
| `press(button)` | agent within 0.6 m of `button_desk`; standing | hand to `button.press_surface` | hand–button at `contactU` 0.42, ≤ 3 cm | button pressed | `press_button` + `press` / `flash` |
| `spawn_coin` | a press contact in the last 0.2 s | ballistic from `button.spawn_point` to `coin_spawn` | lands once, settles ≤ 0.4 s | coin resting, visible, scale 1 | `spawn` (`to: coin_spawn`) |
| `grow(k)` | coin resting or upright; clearance at scale k ≥ 0.10 m to all actors and environment | scale about the **base anchor** (bottom point fixed) | — | scale k, same base anchor | `stand_up` then `grow` |
| `tip_onto(target)` | coin upright; the target in the tip direction within 2R of the pivot | rotation about the bottom front edge toward the target | coin–target, once | coin fallen at the solved rest angle | `tip_over` (with the section 7 solution) |
| `flatten(patient)` | a tip contact scheduled on the patient; patient standing at `zapp_impact` | coupled pose blend from standing to prone under the coin face | continuous after the first contact, never penetrating | prone at `zapp_impact` (feet fixed), head out of the coin | `dive_prone`-style procedural blend (section 11) |
| `reset(button)` | button pressed earlier | cap returns, glow resumes | — | button idle and armed | `reset` + `flash` |
| `get_up` | prone or supine | ≥ 0.8 s transition | — | standing | **missing (authored)** |
| `sit(seat)` | a seat exists at the mark | sit-down transition | seat contact | seated | **missing (authored + chair asset)** |

- A precondition that fails is **never ignored**. The compiler inserts a bridging contract (for example `walk_to` before `press`) when the script permits it; otherwise the beat is marked *unavailable* with a reason.
- A prone Zapp cannot "look at the button" standing: that needs `get_up`, which the script never asks for, so he stays prone and only his head turns (section 11).

## 4. Shot staging on top of world state
- Every caption chunk still gets at least one cut, and no shot runs over 2.8 s.
- Candidates come from the contract's `framing` needs. A jump needs feet, so it can't be a punch-in. A press needs hands plus the button.
- **Action-line rule:** consecutive shots with the same subject pair stay on one side of the line joining them, unless a neutral or moving shot sits between them.
- **Face-direction rule:** frontal presets are rejected when the subject's look target is behind the subject. An over-the-shoulder shot from the side of the look target is used instead.
- Each candidate must pass the camera-safety checks in section 5. The first passing candidate in preference order is chosen by seeded choice. If none passes, the shot falls back to a vetted safe medium or wide shot of that mark, and the fallback is logged.
- Wide shots are used only when the contract needs spatial clarity: scale, a walk, the impact, or the final shot.

## 5. Camera safety checks (headless: evaluated in Node before any render)
- **Collision:** a lens sphere of r = 0.12 m must be outside every collider, each inflated by 0.10 m:
  - environment boxes (exists today);
  - props at their current transform (exists as CAMERA_IN_PROP);
  - **characters (new):** body capsule plus head and hair boxes built from the rig's hair and head part bounds at time t.
  - The check samples every frame of a moving shot.
- **Occlusion:** five rays (centre plus four corners) to each required part: face box, hands for a press, prop anchor. The visible fraction must be ≥ 0.8 for a face and ≥ 0.6 for a prop. Occluders are all non-subject geometry, including hair and other props.
- **Foreground coverage:** non-subject geometry may cover at most 35 % of the frame. This catches the hoodie-filled, hair-filled and coin-rim frames.
- **Full-face safe framing:**
  - the face box lies inside the frame with at least 3 % headroom;
  - the face centre is within 10–90 % horizontally and 12–60 % vertically;
  - the angle between the face's forward direction and the direction to the camera is ≤ 70°.
  - An explicit `extreme_close_up` intent may crop the crown and chin, but both eyes and the mouth must stay in frame.
- These checks become engine `validateFrame` codes: `CAMERA_IN_CHARACTER`, `FOREGROUND_COVERAGE`, `FACE_NOT_SAFE`, and a gated `PROP_OCCLUDED` (occlusion options enabled).

## 6. Semantic validation (measured on the headless world track)

| Action | Pass condition |
|---|---|
| jump | Root or sole height ≥ 0.25 m; landing within 0.05 m of take-off; feet visible in ≥ 1 shot covering the apex |
| sit | Seated end pose, pelvis within 0.08 m of the seat anchor at the desk (blocked while no seat exists) |
| move safely away | Displacement from the start mark ≥ 1.0 m; ends within 0.15 m of `kira_safe`; ≥ 0.5 m clearance from every hazard footprint and the tip sweep for the rest of the episode |
| press | Hand-to-surface ≤ 0.03 m at the contact frame; press event within 0.1 s of contact |
| grow | Base anchor drift ≤ 0.01 m across every step; no penetration; overshoot ≤ 5 % |
| tip | Monotonic rotation about the declared bottom-edge pivot; pivot drift ≤ 0.01 m; no rotation jump over 12° per frame |
| flatten | Exactly one first-contact frame; after it the gap stays ≤ 0.02 m and there is no penetration; end positions match `zapp_impact` (feet drift ≤ 0.05 m) |
| reset | Cap depth returns to 0 and glow resumes; no world consequence contradicts it (the coin stays fallen, Zapp stays prone) |

## 7. Coin-impact sequence: exact physical state progression
Inputs: coin manifest 0.18 × 0.03 × 0.18 m and final scale **16.7**, so radius R = 1.503 m, diameter 3.006 m and **thickness 0.501 m**. Approved narration times are p07 31.52, p09 40.24, p10 44.22, p11 49.86 and p12 55.06.

| Step | Time (s) | Entity | State |
|---|---|---|---|
| S1 appear | contact 31.95 → land ≈ 32.70 | coin | Press contact at 31.95. Pops from `button.spawn_point` (−0.10, 0.96, −0.13) at 32.05 on a ballistic path (0.65 s) away from both actors. Lands flat at `coin_spawn` (−2.10, 0.015, −1.40); settles ≤ 0.4 s. Visible, scale 1, base anchor (−2.10, 0, −1.40). |
| S2 stand | 40.30 → 40.60 | coin | Rotates onto its edge about the base anchor, then upright, face to the audience. |
| S3 grow | 40.64 → 45.80 | coin | Scale 1 → 3 → 6 (p09), then 6 → 11 at about 44.9 (taller than the desk: 1.98 m) and 11 → 16.7 at about 45.8 (3.0 m: wider than Zapp). Each step lasts 0.35–0.45 s. **The base anchor stays at (−2.10, 0, −1.40).** Footprint x −3.61…−0.60, front face z −1.15. Clearance ≥ 0.10 m at every step. |
| S4 Kira safe | 46.20 → ≈ 47.90 | Kira | `move_safely_to(kira_safe)`: 1.53 m walk from (1.30, −0.35) to (2.50, 0.60) at ≤ 1.1 m/s. Turns toward the coin and ends arms crossed (smug) by 48.2. Stays at `kira_safe` to the end. |
| S5 Zapp to impact | 47.00 → ≈ 50.50 | Zapp | `walk_to(zapp_impact)` along the section 2 path (about 3.8 m). Turns to the audience, then arms crossed ("tries to look confident") at 50.5–55.1, coin behind him. |
| S6 tip | 55.10 → contact t_c ≈ 55.95 | coin | Continuous rotation about the bottom front edge (pivot line y 0, z = −1.40 + 0.25 = **−1.15**, along x) toward +z, accelerating over a 1.0 s free phase. |
| S6 Zapp | 55.30 / 55.50 | Zapp | Looks up at the coin top at 55.30 (the tip start is the information change), shock face at 55.50. Feet stay on `zapp_impact`. |
| S7 contact | **t_c ≈ 55.95** (θ ≈ 53.3°) | coin + Zapp | Zapp stands at z 1.20, so the distance from the pivot is d = 2.35 m, and his head top is at 1.75 m. First contact happens when the underside height d·cot θ = 1.75, i.e. θc = atan(2.35 / 1.75) ≈ 53.3°. **This is the only contact frame.** |
| S7 flatten | 55.95 → 56.40 | coin + Zapp | Coupled and damped: the coin goes from 53.3° to the rest angle θr while Zapp's pose blends from standing to prone, falling forward with his feet fixed at `zapp_impact`. Every frame keeps body height ≤ the underside height at his body (gap ≤ 0.02 m, no penetration, no bounce away). |
| S8 rest | from 56.40 | coin | The underside rests on Zapp's hips (top 0.30 m) at about 2.60 m from the pivot, so θr = 90° − atan(0.30 / 2.60) ≈ **83.4°**. The coin face tilts about 6.6° off the floor, with the far rim raised about 0.34 m at z ≈ 1.83. **Thickness stays 0.50 m.** |
| S8 rest | from 56.40 | Zapp | Prone, feet near z 1.2 (under the coin), head raised at z ≈ 2.7 (**out of the coin**, toward the camera), regret face. He never stands on, teleports through, or is enclosed by the coin. |
| S9 hold | 56.40 → 69.167 | all | The coin stays fallen and Zapp stays prone. There is no get-up, and posture continuity is gated. p13: Kira at `kira_safe` looks toward `classroom_door` (creak cue), then goes still. p14: the button resets. Zapp's head turns toward the button while he stays prone (head-only layer). |
| S10 final wide | ≈ 67.2 → 69.167 | camera | Elevated three-quarter view from the audience side, for example at (0.8, 2.6, 5.2) aimed at (−0.9, 0.4, 0.6), inside the camera-safe box. It shows Kira at `kira_safe`, the fallen coin **face-on enough to read the emblem** (view to coin normal ≥ 35°), and Zapp's head and arms out from under the rim. Both faces are visible (≥ 0.8) and the reset button is in frame. |

**Anti-slab rule:** in any shot that shows the fallen coin, its face must project ≥ 2.5× the area of its rim, with a raised rest angle (≥ 5°) and an elevated camera. A low-angle, edge-on view of the fallen coin is rejected.

The engine needs `tip_over` to accept a solved `endDeg`, a damped post-contact phase and no bounce while in contact. The coupled `flatten` pose also has to be driven from the coin's angle (section 11).

## 8. Shot-boundary continuity gates (headless; every frame plus every cut)

| Gate | Fails when |
|---|---|
| `ACTOR_TELEPORT` | Root moves > 3 m/s × dt + 1 cm between frames without an active travel contract, or a mark changes without a path |
| `PROP_TELEPORT` | Prop moves without an active spawn, hop, slide or tip contract |
| `SCALE_JUMP` | Scale changes outside a `grow` contract, or faster than its rate |
| `ORIENTATION_JUMP` | Actor yaw changes > 180°/s outside a turn; prop rotation changes > 12° per frame outside its contract; **pose pop** (face height changes > 0.20 m per frame outside fall, jump or flatten — the 65.37–65.50 pop moved 0.38–0.50 m per frame) |
| `POSTURE_CONTINUITY` | Posture changes without a contract (prone → standing needs `get_up`) |
| `CAMERA_IN_GEOMETRY` | Lens inside an environment, prop or character collider (section 5) |
| `FACE_HIDDEN_BY_PROP` | A required face's visible fraction < 0.8 for > 20 % of a shot's frames because of a prop |
| `SAFE_ZONE` | A character is inside a hazard footprint or sweep when the narration says it is safe |
| `SCREEN_DIRECTION` | Action-line side flips between consecutive shots with the same subject pair |

## 9. Dynamic caption placement
- Three bands, in order: **lower-middle** (centre at 72 % of height), **upper-middle** (24 %) and **mid-lower** (62 %). All stay clear of the bottom UI-safe 16 % and the top 10 %.
- For each chunk, the headless projection samples every 3rd frame and gives face boxes (expanded 8 %) and the hero-prop box.
- The chosen band is the first whose caption rectangle, built from font metrics and the planned lines, never intersects them. The previous chunk's band is kept when still valid, and a chunk never changes band mid-way.
- The band is stored per chunk in the timeline, and `capture.ts` draws there.
- Gate `CAPTION_OVER_FACE`: 0 frames with overlap.

## 10. Emotion scheduling
- Expression changes are triggered by **information-change events** from the world track: press contact, coin landing, each grow step crossing a size threshold, tip start, contact, the off-screen creak, and the button reset.
- A reaction starts 0.15–0.35 s after its event and holds ≥ 0.6 s.
- Caption chunks never trigger emotions.
- Gate `REACTION_BEFORE_CAUSE`: no reaction may precede its cause, unless the cause is already visible (anticipation). In the draft, shock at 40.29 preceded the growth at 40.64, and the fall at 55.11 preceded any impact.

## 11. Supporting characters, and what needs authored animation
- **Framing a supporting character:** only when the phrase names them (or refers to them by pronoun), when the comparison pattern needs the other side in this beat, or when a scheduled reaction payoff falls inside the shot. Otherwise they stay at their mark in world state and may appear incidentally in wides, but are not framed as a subject.
- **Authored animation needed** (not procedural code):
  - `get_up` from prone or supine (≥ 0.8 s);
  - `sit` down, seated idle and stand up, **plus a chair asset** at `kira_desk` (none exists). Until then, "sitting" beats are flagged unavailable with the substitution "standing still";
  - a squashed or flattened prone pose with arms splayed (`dive_prone`'s end pose approximates it);
  - optionally a forceful "slam" press variant.
- **Procedural** (engine code, no authoring): the coupled flatten blend (standing → cower → prone, driven by the coin angle); a head-only look layer while prone (like the existing additive head layer used by `head_shake`); chaining two registered actions in one phrase (`jump` then `victory_pose`).

## 12. Smallest implementation sequence
1. **World and contracts:** new `packages/narrated/src/world.ts` (state, fold, predicates) and `contracts.ts` (the section 3 table). Unit tests on folds, with no engine.
2. **Marks:** `assets/environments/classroom@1.2.0.json` adds marks only, plus an asset-lock update. Visual Comedy is unaffected (1.1.0 stays valid).
3. **Timeline compiler:** `timeline.ts` emits engine actions and prop events from contract transitions. It schedules reactions on events, applies the supporting-character rules, and stores the caption band per chunk. `semantics.ts` gains arguments: destination (safely to or out of the way), patient and agent for affect verbs, and supporting-character actions.
4. **Engine physics:** `props.ts` `tip_over` accepts `endDeg` from the contact solve, a damped post-contact phase and no in-contact bounce. The coupled flatten blend goes in `animator.ts` / `actions.ts`.
5. **Camera safety:** character colliders, multi-ray visibility, foreground coverage, face-safe framing and face-direction-aware preset choice in `camera.ts` / `production.ts`, with fallback to vetted safe shots.
6. **Gates:** continuity, semantic, camera and caption gates evaluated **headless in Node before rendering** (the fit pass already runs a headless engine). `narratedGates` is extended; any failure blocks the render.
7. **Tests:** focused tests on the coin sequence, teleport and pose-pop detection, camera-in-character, anti-slab and caption bands, all headless.
8. Only then, **one** new 540×960 draft.

**Estimate:**
- about 12 files: 3 new (`world.ts`, `contracts.ts`, `classroom@1.2.0.json`), 8 modified (`timeline.ts`, `semantics.ts`, `props.ts`, `animator.ts`/`actions.ts`, `camera.ts`, `production.ts`, `capture.ts`, `narrated-draft.ts`) and 2 test files;
- about 7–10 hours of implementation plus one about 5-minute draft render;
- the authored `get_up`, `sit` and flattened pose are extra, and are needed only if the script keeps those beats.
