# Clearance and framing under the declared motion profile

Run 3 failed because staging and framing were tuned for legacy-head-v1 motion. Under corrected-head-v2, poses move differently: the onset pivots about the planted foot, arms swing from the first step, and the gaze turns yaw-then-pitch. The fix is a **fit pass** between compile (Stage F) and validation (Stage G), `packages/story/src/fit.ts`.

The fit pass evaluates the compiled episode with the real engine, headless, under the episode's declared `render.motionProfile`. This is the same `Production`/`ActorTrack`/camera code the renderer runs (`packages/engine/src/headless.ts`); headless and browser poses differ by 0.

From the sampled animation it chooses generic knobs (`FitKnobs`), which are input to `compileEpisode`. So compile stays a pure function, and a record replays byte-identically from `rec.fitKnobs`. Nothing is keyed to an episode, idea or id.

## 1. Staging clearance (`packages/story/src/envelope.ts`)

**What is sampled:**
- Every locomotion window: onset (0.35 s before start to the first 1.0 s), arrival (0.3 s before end to 0.4 s after) and dive. Sampled at 4 substeps per frame (120 Hz).
- Every moving-prop event (hop, grow, stand-up, wobble, tip, spawn), sampled the same way.
- Every video frame of the whole episode.

**What is tested:**
- Limbs: upper arm, forearm (+1 cm to the hand box end), thigh and shin, as capsules. Tested against the exact part shapes of the props (box, cylinder, sphere) and against the environment colliders.
- Body: head, torso, knee and sole probes, which are exact mesh corners.
- Actor-to-actor root spacing.
- Moving props must stay inside the room's walls and ceiling line.

**Enforced (the generator must clear it):**
- limb or body vs a **moving** prop while its event is active (+0.25 s settle), or while the prop is scaled ≥ 3;
- actor spacing;
- room bounds.

**Reported only:**
- Near-contacts with **static** furniture the actor is staged at, such as the desk. These are profile-independent, within the render QA tolerances, and present in the hand-authored, visually reviewed PoC.
- Legs are checked against moving props only.

**Exempt:**
- **Contact actions** (the engine's contact points): the acting arms vs the target prop family.
- **Spawn:** the presser's arms vs the prop being spawned.
- **Victim flattening:** the victim vs the tipping prop after its tip starts.

### Padding and how it is derived

| Constant | Value | Derivation |
|---|---|---|
| Limb capsule radius | half-width of the limb box + 5 mm | The box faces are exact. With samples every 3 cm along the segment, the largest gap between sample spheres is 1.5 mm at r = 7.5 cm; 2 mm covers it, plus 3 mm numeric margin. |
| `limbTolerance` | 1.5 cm on the capsule, i.e. ≤ 1.0 cm into the box faces | This is the render QA's 1 cm hand-point tolerance, applied to the complete limb. |
| Sampling rate | 120 Hz in windows, 30 Hz elsewhere | Measured per-sample hand displacement at 120 Hz: p50 1.2 cm, p99 5.8 cm, p99.9 6.0 cm. That is well below the 15 cm arm capsule diameter, so consecutive samples overlap. At 30 Hz the same motion moves up to ~24 cm. |
| `bodyMargin` | 2 cm outside every probe | The render QA flags probes > 3 cm inside a prop. |
| `actorMin`, `ACTOR_PATH_MIN` | 0.55 m | The QA hard limit is 0.45 m. The measured root deviation from the straight mark-to-mark line in the first 1 s of a move is at most 8.6 cm under corrected-head-v2 (0.0 under legacy); +0.10 m covers it. The stager checks waiting marks against move segments with the same value. |
| `contactBlend` | 0.3 s | The engine blends a finished non-holding action out over 0.3 s. Contact-action blend-ins are ≤ 0.15 s. |
| `largeScale` | 3 | From scale 3 on, the escalated coin is ≥ 54 cm across and moves between events (wobble, settle). |
| `boundsTolerance` | 0 | Room shell from the environment manifest: the walls, plus the ceiling line at 4.2 m. The floor and the open audience side are not bounds. |
| Leap arc ladder | 1.5 → 1.9 → 2.3 → 2.8 → 3.4 m | 1.5 m is the template default. The apex of the scale-6 coin's top is 2.98 / 3.38 / 3.78 / 4.27 / 4.87 m. In the classroom, 2.8 and 3.4 therefore exceed the 4.2 m ceiling line; the bounds check steps the arc back and caps the ladder. |
| `TAKEOFF_HOLD` | 0.3 s | At the 1.9 m default fitted arc, the coin centre passes a standing actor's head top (≈ 2.06 m) about 0.125 s after takeoff (sampled). 0.3 s is more than twice that. |

**Remedies** (each derived from the sampled contact that triggered it; applied one round at a time, then re-measured; up to 12 rounds):
1. **Pre-align.** An onset envelope collision gets an in-place `turn_toward`, ending at the move start. The compiler budgets 0.3 s for it inside the move's beat.
2. **Leap collision.** When a leaping prop hits an actor who stands idle after a held reaction (`shock_recoil`, `cower`), that reaction is kept through the takeoff (`holdReaction`). Otherwise the arc goes up one rung, capped by the room.
3. **Actor spacing.** When both actors are moving at the contact, the later-starting move is delayed by 0.2 s steps, up to 1.2 s.

A remedy that makes the plan uncompilable is withdrawn, and the compiler's duration constraint goes to the repair loop. Anything left becomes a repair constraint (`field: stagingVariant`); nothing is dropped.

## 2. Swept hand volume (render QA, gate M01)

`Production.sweptHandIssues` is the continuous-time version of the per-frame hand check:
- Inside every locomotion onset, arrival and dive window, the scene is evaluated 4× per frame, including the transition samples between video frames.
- The path of each hand point between consecutive samples is tested at ≤ 1 cm spacing against every visible prop and collider.
- Reported above 1 cm, with the same exemptions as the per-frame check.

It runs in the analyzer (`HAND_SWEEP_PENETRATION`, a hard pipeline issue) and as quality gate **M01** of every render. Rendering is unaffected.

**Why the path is swept, not just sampled:**
- Poses can step discontinuously within a frame. The measured case: the engine's hand-over-furniture avoidance engages when a hand crosses a furniture footprint edge and lifts it 12–16 cm in one 1/120 s sample.
- These steps occur in 4.1 % of hand/head point-samples in locomotion windows, under both profiles and in the PoC.
- The padded limb envelope is sampled, not swept, so it can step over thin geometry. The hand paths are swept.
- The avoidance behaviour itself is an engine limitation. Changing it would change pixels under both profiles, so it needs a new `motionProfile` or renderer version.

## 3. Framing over the complete shot

The fit samples every frame of every shot once (`sampleShot`) and re-solves the camera for each candidate parameter set on all of them (`solveShot` + shake). This covers head yaw and pitch, look-at changes, recoil and expression beats.

**Why every frame:** in face-framed shots, the face normal turns relative to the shot's first frame by a median of 30–33°, p90 66° and at most 88° (both profiles). A camera solved from the shot-start pose cannot keep such a face readable.

| Check | Fit target (padded) | Render QA |
|---|---|---|
| Face feature region (eyes, brows, mouth, from the face manifest) | inside the frame by 0.03 | face centre inside 0.02 |
| Whole head in frame | required, except `reaction_punch_in` (deliberately tight) | not checked |
| Face readability, cos(face normal, direction to camera) | ≥ 0.20 (78.5°) | flags < 0.15 (81.4°) |
| Subject centre | inside the action-safe box shrunk by 0.01 | inside the action-safe box |
| Camera to any visible prop | ≥ 0.15 m | flags < 0.05 m |
| Emote billboard | inside 0.02, only in two-shot, over-shoulder and wides | not checked |
| Hard shot QA (out of frame, behind camera, face occluded, camera in prop) | none | same |
| Hero press surface | unoccluded on every frame and at every press contact | same, at sampled frames and contacts |

**Why the camera-to-prop margin is 0.15 m:** a growing prop's radius changes by up to 22 cm per video frame (p99 19.5 cm). The fit checks every frame, so 0.15 m is three times the QA margin, not a per-frame prediction.

**Candidate search.** Candidates are small deterministic ladders per preset (distance, solve time, bias, yaw, fill, height, fov, margin), ordered by size of change, at most 240 per shot. The first candidate meeting the padded target wins. Otherwise the best QA-acceptable candidate is used, with a warning. Otherwise the result is `FRAMING_UNFIT`: a repair constraint that disallows the preset. `final_loop` mirrors the opening and is checked only.

## 4. Verification

| What | Where |
|---|---|
| Every Run 3 mechanism (M1–M7) reproduced from the frozen records, profile coupling shown where it exists, removed by the current generator under both profiles | `tests/retune-regressions.test.ts` |
| Swept check catches a between-frame pass-through that per-frame QA misses | `tests/retune-regressions.test.ts` (fixture `gen-example-free-coins.json`) |
| Fit determinism and replay from knobs | `tests/retune-regressions.test.ts`, `tests/compiler.test.ts` |
| legacy-head-v1 goldens unchanged | `node scripts/golden.ts check --all-frames`: 510/510 for every golden |
| Tuned v2 fixture reproduces across processes | `tests/render-golden.integration.test.ts` |

The derivation numbers above come from the frozen Run 3 episodes (`scripts/dev/padding-derivation.ts`). They are tuning data, not benchmark results.

## 5. Known limits

- **Box-edge protrusion.** At 45° a limb box edge can protrude beyond its capsule by (√2 − 1) × half-width: ≤ 3.1 cm for arms, ≤ 4.8 cm for legs. The exact-corner probes (2 cm margin) and the swept hand check bound this on the body and hands.
- **Static furniture near-contacts** are reported, not enforced. They are within the QA tolerances.
- **Room bounds** are the environment's axis-aligned shell. Props are not tested against interior décor above head height (none is collidable).
- **Tuning data only.** The ladders and thresholds were tuned on development data only (the frozen Run 3 sets and the dev sets). The fresh held-out benchmark (Run 4) is the measurement.
