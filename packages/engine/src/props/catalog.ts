// Prop catalog (S4): the 25 vignette props authored with ./kit.ts (new versions remain alongside immutable old
// manifests), plus 1.1.0 revisions of the three original props that add the shared grip/surface/floor anchors.
import type { PropManifest } from '../../../schema/src/assets.ts';
import { HOME_PROPS } from './catalog-home.ts';
import { ITEM_PROPS } from './catalog-items.ts';
import { car } from './catalog-vehicle.ts';

/** The 25 planned props (library ids.ts, owner S4), in manifest order. */
export const PLANNED_PROP_IDS = [
  'door', 'phone', 'laptop', 'book', 'backpack', 'chair', 'table', 'bed', 'couch', 'fridge', 'stove', 'tv', 'car', 'ball', 'pizza',
  'drink_cup', 'trophy', 'cash_stack', 'ban_hammer', 'broom', 'plate', 'lamp', 'trash_can', 'sign_board', 'gift_box',
] as const;
export const LEGACY_PROP_IDS = ['spark_coin', 'student_desk', 'suspicious_button'] as const;

const byId = new Map([...HOME_PROPS, ...ITEM_PROPS, car].map((m) => [m.id, m]));
/** current authored manifests, in PLANNED_PROP_IDS order */
export const NEW_PROPS: PropManifest[] = PLANNED_PROP_IDS.map((id) => {
  const m = byId.get(id);
  if (!m) throw new Error(`catalog: planned prop ${id} is not authored`);
  return m;
});

type V3 = [number, number, number];
/** anchors added in the 1.1.0 revisions; everything else is copied verbatim from 1.0.0 */
const LEGACY_ANCHORS: Record<(typeof LEGACY_PROP_IDS)[number], { grips: Record<string, V3>; anchors: Record<string, V3> }> = {
  // centred origin (collision offset y = 0): the floor contact is half the thickness below the origin
  spark_coin: { grips: { grip: [0.09, 0, 0] }, anchors: { surface: [0, 0.015, 0], floor: [0, -0.015, 0] } },
  student_desk: { grips: { grip: [0, 0.74, 0.31] }, anchors: { surface: [0, 0.76, 0], floor: [0, 0, 0] } },
  suspicious_button: { grips: { grip: [0, 0.02, 0] }, anchors: { surface: [0, 0.152, -0.01], floor: [0, 0, 0] } },
};
export function legacyRevision(v100: PropManifest): PropManifest {
  const add = LEGACY_ANCHORS[v100.id as keyof typeof LEGACY_ANCHORS];
  if (!add || v100.version !== '1.0.0') throw new Error(`legacyRevision: expected a 1.0.0 legacy prop, got ${v100.id}@${v100.version}`);
  const m = JSON.parse(JSON.stringify(v100)) as PropManifest;
  m.version = '1.1.0';
  m.grips = { ...m.grips, ...add.grips };
  m.anchors = { ...m.anchors, ...add.anchors };
  return m;
}
