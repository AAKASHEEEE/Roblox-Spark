// S4 prop library entry point: PropBuilder implementations (packages/library/src/types.ts) for every catalog prop.
// Manifests come from the loaded asset library (locked JSON in assets/props); the authoring catalog is the fallback
// for tools/tests that run without the library.
import type { PropManifest } from '../../../schema/src/assets.ts';
import type { BuiltProp, PropBuilder } from '../../../library/src/types.ts';
import type { PropState } from '../props.ts';
import { NEW_PROPS, PLANNED_PROP_IDS, LEGACY_PROP_IDS } from './catalog.ts';
import { rigFor } from './rigs.ts';
import { applyRigState, buildRig, type RiggedProp } from './rig.ts';

export { PLANNED_PROP_IDS, LEGACY_PROP_IDS, NEW_PROPS, legacyRevision } from './catalog.ts';
export { RIGS, rigFor } from './rigs.ts';
export { buildRig, applyRigState, setPivot, anchorLocal, type RiggedProp, type RigSpec, type StateSpec, type Pose } from './rig.ts';
export { DOOR, doorPlacement, doorMarks, doorHandle, doorPassable, doorwayWall } from './door.ts';
export { rollWheels, steer, wheelSpinDeg } from './car.ts';
export { checkPropCatalog, checkPropManifest, SCALE_REF, ZAPP } from './check.ts';

export interface PropBuildOpts { seed: number; /** sign_board text */ text?: string }
export interface RiggedPropBuilder extends PropBuilder {
  manifest: PropManifest;
  build(instanceId: string, opts: PropBuildOpts): RiggedProp;
  /** `from` overrides the state's declared from-state */
  applyState(p: BuiltProp, state: string, u: number, from?: string): Partial<PropState>;
}

export function propBuilder(m: PropManifest): RiggedPropBuilder {
  const spec = rigFor(m.id);
  return {
    kind: 'prop', id: m.id, version: m.version, manifest: m,
    build: (instanceId, opts) => buildRig(m, spec, instanceId, opts),
    applyState: (p, state, u, from) => applyRigState(p as RiggedProp, state, u, from),
  };
}

const semver = (v: string) => v.split('.').map(Number);
const newer = (a: string, b: string) => { const x = semver(a), y = semver(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };

/**
 * Builders keyed by prop id. `props` is a loaded library map ("id@x.y.z" -> manifest); `pins` selects exact versions
 * (render-time use must pin, e.g. from the beat sheet / episode); unpinned ids resolve to the highest published version.
 */
export function propBuilders(props: Record<string, PropManifest> = {}, pins: Record<string, string> = {}): Record<string, RiggedPropBuilder> {
  const best = new Map<string, PropManifest>();
  for (const m of [...NEW_PROPS, ...Object.values(props)]) {
    const pin = pins[m.id];
    const cur = best.get(m.id);
    if (pin) { if (m.version === pin) best.set(m.id, m); continue; }
    if (!cur || newer(m.version, cur.version)) best.set(m.id, m);
  }
  for (const [id, v] of Object.entries(pins)) if (best.get(id)?.version !== v) throw new Error(`propBuilders: ${id}@${v} is not in the library`);
  return Object.fromEntries([...best].map(([id, m]) => [id, propBuilder(m)]));
}
/** ids this library builds (planned + legacy) */
export const PROP_IDS: readonly string[] = [...PLANNED_PROP_IDS, ...LEGACY_PROP_IDS];
