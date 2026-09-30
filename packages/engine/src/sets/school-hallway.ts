import type { SetBuilder } from '../../../library/src/types.ts';
import type { Vec3 } from '../math.ts';
import { authoredMarks, buildAuthoredSet } from './common.ts';
import { SCHOOL_HALLWAY_MANIFEST } from './generated-manifests.ts';

const marks = authoredMarks(SCHOOL_HALLWAY_MANIFEST, {
  lockers: ['stand', 'crouch'], water_fountain: ['stand', 'crouch'],
});

/** Long school corridor with authored locker, classroom-door, notice-board and fountain staging. */
export const SCHOOL_HALLWAY_SET: SetBuilder = {
  kind: 'set',
  id: 'school_hallway',
  version: '1.0.0',
  manifest: SCHOOL_HALLWAY_MANIFEST,
  build(opts) {
    return buildAuthoredSet(SCHOOL_HALLWAY_MANIFEST, marks, [{
      id: 'hall_door',
      position: [0, 0, -8.05] as Vec3,
      facingDeg: 0,
      propId: 'door',
      entryMarkId: 'hall_door_inside',
    }], opts, [0, 1.9, 0], 9.8);
  },
};
