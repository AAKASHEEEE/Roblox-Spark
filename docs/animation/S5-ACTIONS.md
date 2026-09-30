# S5 actions and talking

Code lives in `packages/engine/src/animation/` (S5-owned). Frame strips: [strips/README.md](strips/README.md) (regenerate with `node scripts/action-strips.ts`). Tests: `tests/lib-actions.test.ts`.

## What is there

| Module | Contents |
|---|---|
| `lib/registry.ts` | `LIB_ACTIONS`: every library action ID as an S0 `ActionDef`. It has the 29 engine actions, the 21 planned ones, and `enter_door` / `exit_door`. |
| `lib/body-actions.ts` | sit, stand_up, celebrate, dance, cry, scream, tug, push, sleep (standing or `lying`), flattened, look_around, shrug, wave, clap, sneak |
| `lib/prop-actions.ts` | grab, throw, drink, eat, use_phone, type_laptop. Each has a `PropCue` for the hand attachment, release and prop state. |
| `lib/door-actions.ts` | open_door, slam_door, enter_door, exit_door. `door(ctx)` returns the door's open fraction, synced with the hand contact. |
| `lib/track.ts` | `LibraryTrack`: plays library actions on a rig. It covers root motion, travel windows, holds and blends, layers, look-at, IK, squash & stretch and grounding. |
| `lib/attach.ts` | `attachToHand` places the grip anchor on the hand. `throwVelocity` and `flightAt` give a closed-form flight with bounces. |
| `lib/anchors.ts` | Anchor roles (`grip`, `door_handle`, `screen`, `keyboard`, `bite`, `lip`, `contact`, `door_hinge`), each mapped to accepted names. |
| `comedy.ts` | `acting` (anticipation → overshoot → settle), `overshootOut`, `settle`, `squashStretch`, `landingSquash`, `hop`. `ActionPose.scale` carries the squash. |
| `talking.ts` | Mouth flaps from phrase timing (`PhraseMouth`, syllables from the text) or from the VO envelope (`EnvelopeMouth`, `envelopeFromPcm`). |
| `face-track.ts` | `FaceTrack`: one expression per beat (resolved per character), a forced blink on every change, deterministic blinks, the talking mouth, and action face cues. |

Everything is a pure function of `t` (and the seed), so random-access sampling equals sequential playback.

`ActorTrack` and `ACTION_DEFS` are unchanged, because the Visual Comedy path is byte-frozen by the test suite. `pose.ts` gains an optional `scale`, and `narrated-motion.ts` applies it when present. Neither affects engine poses.

## Requests to other sessions

- **S0**
  - Flip the 21 planned action IDs to `available`, with source `packages/engine/src/animation/lib/registry.ts`.
  - Reserve `enter_door` and `exit_door`, which are door-mark entrances and exits.
  - Add the new IDs to the episode `ACTIONS` enum if episodes should use them.
- **S3**
  - Call `setFaceRenderer(fn)` to draw the mouth from `FaceFrame.mouth` (`closed | small | open | wide | round`, plus `open` 0..1).
  - Until then, `applyFace` swaps to an existing face state with an open mouth, which also changes the eyes.
  - Add the expressions that actions request: `crying`, `scream`, `shocked`.
- **S4**
  - Confirm the anchor names in `lib/anchors.ts`: `grip`, `handle`, `screen`, `keyboard`, `bite`, `rim`, `hinge`.
  - Confirm the prop states the actions request:
    - door `open` u
    - cup `tilt` u
    - food `bitten` u
    - phone `screen_on`
    - laptop `open`
- **S6**
  - Stage with `LibraryTrack`, or with `LIB_ACTIONS` directly. Resolve `targetRole` to `<prop>.<anchor>` with `anchorRef`.
  - Apply `props(ctx)` with `attachToHand` / `blendPlacement` and `flightAt` after `releaseU`.
  - Drive the door from `door(ctx)`.
  - For entering through a door, start the actor at `SetDoor.position` and set `to` to `entryMarkId`. For leaving, set `to` to the door.
