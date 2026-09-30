import type { SetBuilder } from '../../../library/src/types.ts';
import { authoredMarks, buildAuthoredSet } from './common.ts';
import { PLAYGROUND_MANIFEST } from './generated-manifests.ts';

const marks = authoredMarks(PLAYGROUND_MANIFEST, {
  slide: ['stand', 'crouch'], swings: ['stand', 'sit'], sandpit: [], bench: ['stand', 'sit'],
});

/** Original outdoor playground silhouettes and staging; no doorway is claimed for this open set. */
export const PLAYGROUND_SET: SetBuilder = {
  kind: 'set',
  id: 'playground',
  version: '1.0.0',
  manifest: PLAYGROUND_MANIFEST,
  build(opts) {
    return buildAuthoredSet(PLAYGROUND_MANIFEST, marks, [], opts, [0, 1.8, 0.5], 11.0);
  },
};
