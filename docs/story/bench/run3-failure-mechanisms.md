# Run 3 failure mechanisms (catalogue for the corrected-head-v2 re-tune)

Built from the frozen records in `run3-holdout2/`, `run3-holdout-posthoc/` and `run3-rules-posthoc/`. Every failed or repaired idea is listed under the mechanism(s) that produced its constraints. Each mechanism gets at least one regression test (`tests/retune-regressions.test.ts`, `tests/safety-intent.test.ts`).

| # | Mechanism (profile coupling) | Constraint code | Ideas (final failure / needed repair) |
|---|---|---|---|
| M1 | Run/walk onset under the synchronised onset: the body keeps facing the giant coin while the arms swing, so a hand enters the coin. The generator's clearances assumed the legacy onset, where the body had already turned. | HAND_PENETRATION | failed: A04 A05 A12 A14 B03 B11 C11 HB02 HB03; contributing: D02 HB11 H10 |
| M2 | Corrected look-down gaze (yaw-then-pitch) drops the face out of a tight reaction shot solved at shot start: framing assumed the legacy (shallower) head pitch. | FACE_OUT_OF_FRAME | failed: C05 D02 D09 HB10 HB11 H07 H10; contributing: C11; repaired: C01 |
| M3 | Face turned away over part of a shot (full-amplitude head layers, corrected gaze): the camera yaw is solved from the face direction at shot start only. | FACE_TURNED_AWAY | failed: HB12; contributing: D02 D09 HB10 HB11 H10; repaired: D03 D04 D08 D10 H11 |
| M4 | Actors pass within 41–44 cm: the synchronised onset pivots the body about the planted foot, so the root path departs from the straight mark-to-mark line assumed by staging. | ACTOR_OVERLAP | contributing: D02 D09 HB10 HB11 HB12 H10; repaired: D03 D04 D08 D10 H11 |
| M5 | Head or body enters the coin (corrected look-up pitch / recoil moves the head-top corners behind the root). | BODY_PROP_INTERSECTION | failed: H05; contributing: A12 HB12 |
| M6 | Hero prop occluded by an actor in a shot. | PROP_OCCLUDED | contributing: HB12 |
| M7 | Subject outside the action-safe area. | SUBJECT_OUTSIDE_ACTION_SAFE | contributing: H05; repaired: B04 B12 |
| S1 | Weapon plus ambush with no harm verb: "waits behind the door with a cricket bat for Zapp". The sentence-local rule needs a harm or pursuit verb aimed at a person. | safety | HB14 (classified safe; rejected only as "door unavailable") |
| S2 | Person-directed dangerous physical harm without an object: "pushes Kira down the stairs". | safety | HB17 (ACCEPTED) |
| N1 | Not profile- or safety-related: the rejection category reports the first reason found ("impossible" explosion before "unavailable" hammer/router). Present since run 1. | category | D06 |

M1–M7 appear only in the combination "corrected-head-v2 motion + staging and framing tuned for legacy motion" (`run3-profile-ab.md`: the same 9 ideas are accepted under legacy-head-v1).
