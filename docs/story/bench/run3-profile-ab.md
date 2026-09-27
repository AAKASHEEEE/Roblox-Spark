# Run 3: effect of making `corrected-head-v2` the default motion profile

Run 3 uses the current generator: the contextual safety classifier, hand actions unavailable, and `corrected-head-v2` as the default motion profile. On the 50-idea set it is post-hoc (contaminated): acceptance after repair was 69.0 %, down from 100 % in run 2. Nine ideas that run 2 accepted now fail after 3 repairs.

To isolate the cause, the same 9 ideas were generated with the same generator, changing only the requested motion profile (`scripts/dev/profile-ab.ts`):

| Idea | `legacy-head-v1` | `corrected-head-v2` |
|---|---|---|
| A04 | accepted, 0 repairs | failed after 3 [HAND_PENETRATION] |
| A05 | accepted, 0 | failed [HAND_PENETRATION] |
| A14 | accepted, 0 | failed [HAND_PENETRATION] |
| B03 | accepted, 0 | failed [HAND_PENETRATION] |
| B11 | accepted, 0 | failed [HAND_PENETRATION] |
| C05 | accepted, 0 | failed [FACE_OUT_OF_FRAME] |
| C11 | accepted, 0 | failed [FACE_OUT_OF_FRAME, HAND_PENETRATION] |
| D02 | accepted, 1 | failed [ACTOR_OVERLAP, FACE_OUT_OF_FRAME, FACE_TURNED_AWAY, HAND_PENETRATION] |
| D09 | accepted, 1 | failed [ACTOR_OVERLAP, FACE_OUT_OF_FRAME, FACE_TURNED_AWAY] |

The diagnosis for A04 is that the generator was tuned for legacy motion; the engine is not at fault.
- In the legacy blended onset, the body turned 25° in the first 0.2 s of a run.
- The synchronised onset ties the turn to the planted-foot step, so 0.09 s into the run the body still faces the giant coin (−107.5°) and the right-hand swing enters the coin by 1.9 cm.
- The corrected look-at pitch tilts faces further down, which pushes them out of tight reaction framing.

The generator's staging clearances and shot framing were tuned under legacy motion, with 1–2 cm margins. They have not been re-tuned for `corrected-head-v2`.

Held-out set 2 (`run3-holdout2`, 17 ideas) was frozen before running and measured once with this generator:
- first-pass and after-repair acceptance: 58.3 % (7/12);
- must-reject correctness: 80 % (4/5), category match 60 %;
- unsafe rejected: 66.7 % (2/3; HB14 "waits behind the door with a cricket bat" was not caught, as its author predicted);
- protected IP rejected: 100 %.

It is the only uncontaminated measurement of the current generator.
