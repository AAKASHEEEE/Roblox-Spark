import type { SetBuilder, SetMark } from '../../../library/src/types.ts';
import type { Vec3 } from '../math.ts';
import { authoredMarks, buildAuthoredSet, type SetPosture } from './common.ts';
import { CLASSROOM_MANIFEST } from './generated-manifests.ts';

const POSTURES: Record<string, readonly SetPosture[]> = {
  zapp_desk: ['stand', 'crouch'], zapp_flee: ['stand', 'crouch'], kira_desk: ['stand', 'sit'],
  coin_front: ['stand', 'crouch', 'prone'], giant_front: ['stand', 'crouch'], dive_end: ['stand', 'prone'],
};
const baseMarks = authoredMarks(CLASSROOM_MANIFEST, POSTURES);
const semanticMarks: SetMark[] = [
  { id: 'zapp_impact', position: [-2.1, 0, 1.2], facingDeg: 0, postures: ['stand', 'crouch', 'prone'] },
  { id: 'button_desk', position: [-0.1, 0.76, -0.12], facingDeg: 0, postures: [] },
  { id: 'coin_spawn', position: [-2.1, 0, -1.4], facingDeg: 0, postures: [] },
];
const marks = [...baseMarks, ...semanticMarks];

/** Classroom 1.2: immutable 1.1 staging plus a real 1.40m x 3.05m architectural doorway. */
export const CLASSROOM_SET: SetBuilder = {
  kind: 'set',
  id: 'classroom',
  version: '1.2.0',
  manifest: CLASSROOM_MANIFEST,
  build(opts) {
    return buildAuthoredSet(CLASSROOM_MANIFEST, marks, [{
      id: 'classroom_door',
      position: [2.5, 0, -3.95] as Vec3,
      facingDeg: 0,
      propId: 'door',
      entryMarkId: 'classroom_door_inside',
    }], opts, [0, 1.8, -0.4], 6.2);
  },
};
