import { registerBuilder } from '../build-dispatch.ts';
import { CLASSROOM_SET } from './classroom.ts';
import { PLAYGROUND_SET } from './playground.ts';
import { SCHOOL_HALLWAY_SET } from './school-hallway.ts';

export { CLASSROOM_SET } from './classroom.ts';
export { PLAYGROUND_SET } from './playground.ts';
export { SCHOOL_HALLWAY_SET } from './school-hallway.ts';
export { CLASSROOM_MANIFEST, PLAYGROUND_MANIFEST, SCHOOL_HALLWAY_MANIFEST } from './generated-manifests.ts';

export const BUILT_IN_SET_BUILDERS = Object.freeze([CLASSROOM_SET, SCHOOL_HALLWAY_SET, PLAYGROUND_SET]);

/** Explicit, idempotent bootstrap for S6/browser callers; avoids import-time global registration. */
export function registerSetBuilders(): void {
  for (const builder of BUILT_IN_SET_BUILDERS) registerBuilder(builder);
}
