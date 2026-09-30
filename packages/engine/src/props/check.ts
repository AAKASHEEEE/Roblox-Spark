// Catalog self-check: schema, anchor contract, geometry vs declared dimensions, scale against Zapp, rig consistency and
// library registration. Returns human-readable issues (empty = clean). Pure: usable from node scripts and tests.
import { PropManifestSchema, type PropManifest } from '../../../schema/src/assets.ts';
import { LIBRARY } from '../../../library/src/ids.ts';
import { qEuler, qRotate, type Vec3 } from '../math.ts';
import { REQUIRED_ANCHORS, REQUIRED_GRIP } from './kit.ts';
import { PLANNED_PROP_IDS } from './catalog.ts';
import { rigFor } from './rigs.ts';

/** Zapp reference (assets/characters/zapp@1.0.0.json): joint heights in meters. */
export const ZAPP = { height: 1.932, hairTop: 2.12, hip: 0.8, knee: 0.4, shoulder: 1.315, shoulderSpan: 0.85, handWidth: 0.13, torsoWidth: 0.54 } as const;

type Metric = 'w' | 'h' | 'd' | 'max' | `anchor:${string}`;
/** Believable-scale bands, relative to Zapp. */
export const SCALE_REF: Record<string, Array<{ metric: Metric; min: number; max: number; why: string }>> = {
  door: [{ metric: 'h', min: 2.9, max: 3.1, why: '2.90 m clear opening clears the full adult cast' }, { metric: 'w', min: 1.4, max: 1.6, why: '1.25 m clear opening exceeds adult shoulder width' }],
  chair: [{ metric: 'anchor:seat', min: 0.4, max: 0.5, why: 'seat at knee height (0.40 m)' }],
  table: [{ metric: 'anchor:surface', min: 0.7, max: 0.8, why: 'top at hip height (0.80 m), same as the student desk' }],
  bed: [{ metric: 'anchor:surface', min: 0.45, max: 0.6, why: 'mattress a little above the knee' }, { metric: 'd', min: 2.2, max: 2.6, why: 'longer than Zapp lying down (2.12 m with hair)' }],
  couch: [{ metric: 'anchor:seat_l', min: 0.4, max: 0.5, why: 'seat at knee height' }, { metric: 'w', min: 1.8, max: 2.4, why: 'two seats wide' }],
  fridge: [{ metric: 'h', min: 1.8, max: 2.1, why: 'about his head height' }],
  stove: [{ metric: 'anchor:surface', min: 0.85, max: 0.95, why: 'counter height, just above the hip' }],
  tv: [{ metric: 'w', min: 1.0, max: 1.6, why: 'living-room TV, about 1.5x his shoulder span' }],
  car: [{ metric: 'h', min: 1.3, max: 1.7, why: 'roof at chest/neck height' }, { metric: 'd', min: 3.2, max: 4.2, why: 'compact car ~1.9x his height' }],
  lamp: [{ metric: 'h', min: 1.4, max: 1.8, why: 'floor lamp below his head' }],
  trash_can: [{ metric: 'h', min: 0.55, max: 0.8, why: 'below the hip' }],
  sign_board: [{ metric: 'anchor:text_center', min: 1.1, max: 1.5, why: 'text at chest/face height' }],
  backpack: [{ metric: 'w', min: 0.3, max: 0.5, why: 'narrower than his torso (0.54 m)' }, { metric: 'h', min: 0.4, max: 0.6, why: 'covers most of his back (torso 0.60 m)' }],
  broom: [{ metric: 'h', min: 1.2, max: 1.5, why: 'reaches his shoulder (1.32 m)' }],
  ban_hammer: [{ metric: 'h', min: 0.9, max: 1.3, why: 'cartoon oversize: waist-to-chest when held' }],
  laptop: [{ metric: 'w', min: 0.3, max: 0.4, why: 'about 2.5 hand widths' }],
  phone: [{ metric: 'd', min: 0.13, max: 0.2, why: 'a little longer than his hand is wide' }],
  book: [{ metric: 'max', min: 0.22, max: 0.32, why: 'textbook' }],
  ball: [{ metric: 'max', min: 0.2, max: 0.3, why: 'about half his torso width' }],
  pizza: [{ metric: 'max', min: 0.3, max: 0.45, why: 'whole pie' }],
  drink_cup: [{ metric: 'h', min: 0.15, max: 0.3, why: 'fits in his hand' }, { metric: 'w', min: 0.07, max: 0.13, why: 'narrower than his hand' }],
  trophy: [{ metric: 'h', min: 0.3, max: 0.5, why: 'held in two hands' }],
  cash_stack: [{ metric: 'max', min: 0.14, max: 0.22, why: 'bill-sized bundles' }],
  plate: [{ metric: 'max', min: 0.2, max: 0.3, why: 'dinner plate' }],
  gift_box: [{ metric: 'max', min: 0.3, max: 0.5, why: 'carried in two hands' }],
};

type Part = PropManifest['parts'][number];
/** axis-aligned box of a part in prop space (authored pose) */
export function partAabb(p: Part): { min: Vec3; max: Vec3 } {
  const s = p.size;
  let lo: Vec3, hi: Vec3;
  switch (p.shape) {
    case 'cylinder': lo = [-s[0], -s[1] / 2, -s[0]]; hi = [s[0], s[1] / 2, s[0]]; break;
    case 'sphere': lo = [-s[0], -s[0], -s[0]]; hi = [s[0], s[0], s[0]]; break;
    case 'plane': lo = [-s[0] / 2, -s[1] / 2, 0]; hi = [s[0] / 2, s[1] / 2, 0]; break;
    case 'wedge': lo = [-s[0] / 2, 0, -s[2] / 2]; hi = [s[0] / 2, s[1], s[2] / 2]; break;
    default: lo = [-s[0] / 2, -s[1] / 2, -s[2] / 2]; hi = [s[0] / 2, s[1] / 2, s[2] / 2];
  }
  const r = p.rotDeg ?? [0, 0, 0];
  const q = qEuler(r[0] * Math.PI / 180, r[1] * Math.PI / 180, r[2] * Math.PI / 180); // partNode convention
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 8; i++) {
    const c = qRotate(q, [i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]]);
    for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], c[k] + p.pos[k]); max[k] = Math.max(max[k], c[k] + p.pos[k]); }
  }
  return { min, max };
}
export function propAabb(m: PropManifest): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of m.parts) { const b = partAabb(p); for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], b.min[k]); max[k] = Math.max(max[k], b.max[k]); } }
  return { min, max };
}
const distToBox = (p: number[], b: { min: Vec3; max: Vec3 }): number => Math.hypot(...[0, 1, 2].map((k) => Math.max(b.min[k] - p[k], 0, p[k] - b.max[k])));

/** States a prop must offer (the S4 brief). */
export const REQUIRED_STATES: Record<string, string[]> = {
  door: ['closed', 'open'], phone: ['screen_on', 'screen_off'], laptop: ['open', 'closed'], fridge: ['door_open', 'door_closed'], tv: ['on', 'off'], car: ['parked', 'driving'],
};

export function checkPropManifest(m: PropManifest): string[] {
  const out: string[] = [];
  const at = `${m.id}@${m.version}`;
  const r = PropManifestSchema.parse(m);
  if (!r.ok) out.push(...r.issues.map((i) => `${at} schema ${i.path}: ${i.message}`));
  // anchor contract
  if (!m.grips[REQUIRED_GRIP]) out.push(`${at}: missing grips.${REQUIRED_GRIP}`);
  for (const a of REQUIRED_ANCHORS) if (!m.anchors[a]) out.push(`${at}: missing anchors.${a}`);
  const ids = new Set<string>();
  for (const p of m.parts) { if (ids.has(p.id)) out.push(`${at}: duplicate part ${p.id}`); ids.add(p.id); }
  const names = [...Object.keys(m.grips), ...Object.keys(m.anchors), ...Object.keys(m.effectAnchors)];
  if (new Set(names).size !== names.length) out.push(`${at}: grip/anchor/effectAnchor names collide`);
  for (const t of m.allowedTransformations) if ((m.forbiddenTransformations as string[]).includes(t)) out.push(`${at}: ${t} both allowed and forbidden`);
  // geometry vs declared metrics
  const bb = propAabb(m);
  const size = [0, 1, 2].map((k) => bb.max[k] - bb.min[k]);
  const floor = m.anchors.floor;
  if (floor && Math.abs(bb.min[1] - floor[1]) > 0.006) out.push(`${at}: anchors.floor y=${floor[1]} but the lowest part is at ${bb.min[1].toFixed(4)}`);
  size.forEach((s, k) => { if (Math.abs(s - m.dimensions[k]) > 0.025) out.push(`${at}: dimensions[${k}]=${m.dimensions[k]} but parts span ${s.toFixed(3)}`); });
  const boxes = m.parts.map(partAabb);
  const near = (p: number[]) => Math.min(...boxes.map((b) => distToBox(p, b)));
  for (const [k, p] of Object.entries(m.grips)) if (near(p) > 0.03) out.push(`${at}: grip ${k} is ${near(p).toFixed(3)} m from any part`);
  for (const k of ['surface']) { const p = m.anchors[k]; if (p && near(p) > 0.03) out.push(`${at}: anchor ${k} is ${near(p).toFixed(3)} m from any part`); }
  // scale vs Zapp
  for (const s of SCALE_REF[m.id] ?? []) {
    const v = s.metric === 'w' ? m.dimensions[0] : s.metric === 'h' ? m.dimensions[1] : s.metric === 'd' ? m.dimensions[2] : s.metric === 'max' ? Math.max(...m.dimensions) : m.anchors[s.metric.slice(7)]?.[1];
    if (v === undefined) out.push(`${at}: scale metric ${s.metric} missing`);
    else if (v < s.min - 1e-9 || v > s.max + 1e-9) out.push(`${at}: ${s.metric}=${v} outside ${s.min}-${s.max} m (${s.why})`);
  }
  // rig
  const rig = rigFor(m.id);
  const pivots = new Set((rig.pivots ?? []).map((p) => p.id));
  for (const pv of rig.pivots ?? []) {
    if (!m.anchors[pv.at]) out.push(`${at}: pivot ${pv.id} anchor ${pv.at} missing`);
    if (pv.parent && !pivots.has(pv.parent)) out.push(`${at}: pivot ${pv.id} parent ${pv.parent} unknown`);
    for (const a of pv.anchors ?? []) if (!m.anchors[a] && !m.grips[a] && !m.effectAnchors[a]) out.push(`${at}: pivot ${pv.id} carries unknown anchor ${a}`);
  }
  for (const p of m.parts) if (p.attach !== 'root' && !pivots.has(p.attach)) out.push(`${at}: part ${p.id} attaches to unknown pivot ${p.attach}`);
  for (const pv of pivots) if (!m.parts.some((p) => p.attach === pv) && !(rig.pivots ?? []).some((c) => c.parent === pv)) out.push(`${at}: pivot ${pv} moves nothing`);
  if (!rig.states[rig.defaultState]) out.push(`${at}: default state ${rig.defaultState} missing`);
  for (const [name, st] of Object.entries(rig.states)) {
    if (!rig.states[st.from]) out.push(`${at}: state ${name} from unknown state ${st.from}`);
    for (const pv of Object.keys(st.pose.pivots ?? {})) if (!pivots.has(pv)) out.push(`${at}: state ${name} poses unknown pivot ${pv}`);
    for (const group of ['lit', 'screens', 'visible'] as const) for (const pid of Object.keys(st.pose[group] ?? {})) if (!ids.has(pid)) out.push(`${at}: state ${name} ${group} part ${pid} missing`);
  }
  for (const group of ['lit', 'screens', 'decals'] as const) for (const pid of Object.keys(rig[group] ?? {})) if (!ids.has(pid)) out.push(`${at}: rig ${group} part ${pid} missing`);
  for (const s of REQUIRED_STATES[m.id] ?? []) if (!rig.states[s]) out.push(`${at}: required state ${s} missing`);
  return out;
}

/** Whole-catalog check: every planned id authored once, registered in the library manifest as an S4 prop. */
export function checkPropCatalog(manifests: PropManifest[]): string[] {
  const out = manifests.flatMap(checkPropManifest);
  const lib = new Map(LIBRARY.props.map((e) => [e.id, e]));
  for (const id of PLANNED_PROP_IDS) {
    if (!manifests.some((m) => m.id === id)) out.push(`${id}: planned prop not in catalog`);
    const e = lib.get(id);
    if (!e) out.push(`${id}: not in LIBRARY.props (ids.ts)`);
    else if (e.owner !== 'S4') out.push(`${id}: LIBRARY owner is ${e.owner}, expected S4`);
  }
  if (manifests.some((m) => m.id === 'car')) {
    const car = manifests.find((m) => m.id === 'car')!;
    for (const w of ['fl', 'fr', 'rl', 'rr']) if (!car.parts.some((p) => p.attach === `wheel_${w}`)) out.push(`car: wheel ${w} has no parts`);
  }
  return out;
}
