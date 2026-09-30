// Prop rigs: turn a flat PropInstance (build.ts buildProp) into a posable prop with pivots (hinges, lids, wheels),
// named states, screens that switch on/off, lit parts and painted decals.
//
// Manifest side: a part whose `attach` is not 'root' rides the pivot of that name; parts keep prop-space positions in the
// manifest (authored pose), the rig converts them to pivot-local. Pivot origins are manifest anchors (e.g. hinge_axis).
// A flat buildProp() of the same manifest still renders the authored pose, so episodes that never pose a prop are unchanged.
//
// applyState(rig, state, u, from?) is PURE in (state, u, from): it sets every pivot/screen/lit part from the two poses and
// does not depend on previously applied frames, so random-access rendering stays deterministic.
import type { PropManifest } from '../../../schema/src/assets.ts';
import { buildProp, type PropInstance } from '../build.ts';
import { Node, hex, type RGB } from '../gl/scene.ts';
import type { PropState } from '../props.ts';
import { DEG, clamp, easeInCubic, easeOutBack, easeOutCubic, lerp, m4, m4Mul, m4TRS, m4TransformPoint, qEuler, qMul, smooth, type Mat4, type Quat, type Vec3 } from '../math.ts';
import { propTexture } from './screens.ts';

export type Ease = 'linear' | 'smooth' | 'out' | 'in' | 'back';
export interface PivotSpec {
  id: string;
  /** manifest anchor (prop space) the pivot origin sits on */
  at: string;
  /** parent pivot (nested: steering -> wheel spin) */
  parent?: string;
  /** anchors / grips that ride this pivot (handles, lid edges) */
  anchors?: string[];
  /** continuous spinner (wheels): the from-pose angle is taken mod 360, so leaving a spinning state never unwinds */
  wrap?: boolean;
}
export interface PivotPose { rot?: Vec3; off?: Vec3 }
export interface Pose {
  /** Euler degrees relative to the authored pose, prop convention (Ry * Rx * Rz); off = translation in parent space */
  pivots?: Record<string, PivotPose>;
  /** part id -> 0..1 emission of its lit colour */
  lit?: Record<string, number>;
  /** part id -> 0..1 screen brightness (0 = off: dark glass) */
  screens?: Record<string, number>;
  /** part id -> visible (switches at u = 0.5) */
  visible?: Record<string, boolean>;
  /** numeric PropState fields returned to the caller (e.g. button capDepth) */
  state?: Partial<Pick<PropState, 'capDepth' | 'glow'>>;
}
export interface StateSpec { pose: Pose; /** default state this one transitions from */ from: string; ease?: Ease; description: string }
export interface RigSpec {
  pivots?: PivotSpec[];
  /** part id -> emission colour when lit (sRGB hex) */
  lit?: Record<string, string>;
  /** part id -> screen painter (screens.ts) */
  screens?: Record<string, string>;
  /** part id -> static decal painter; 'sign' is painted with the instance text */
  decals?: Record<string, string>;
  states: Record<string, StateSpec>;
  defaultState: string;
}

export interface RiggedProp {
  instance: PropInstance;
  states: string[];
  id: string;
  spec: RigSpec;
  pivots: Record<string, Node>;
  /** rest (authored) local position of each pivot */
  rest: Record<string, Vec3>;
  /** instance text for painted decals (sign_board) */
  text?: string;
  /** last applied (state, u), informational only */
  current: { state: string; u: number; from: string };
  base: Map<string, { color: RGB; emissive: RGB; sheen: number }>;
  /** pivots declared wrap: true */
  wrap: Set<string>;
}

const EASE: Record<Ease, (u: number) => number> = { linear: (u) => clamp(u, 0, 1), smooth, out: easeOutCubic, in: easeInCubic, back: (u) => easeOutBack(u, 1.6) };
const ZERO: Vec3 = [0, 0, 0];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
/** prop Euler convention (same as PropTrack.apply / prop-transform.ts): Ry * Rx * Rz */
export const pivotQuat = (r: Vec3): Quat => qMul(qEuler(0, r[1] * DEG, 0), qMul(qEuler(r[0] * DEG, 0, 0), qEuler(0, 0, r[2] * DEG)));

function reparent(n: Node, to: Node, pivotAbs: Vec3): void {
  const from = n.parent;
  if (from) from.children = from.children.filter((c) => c !== n);
  n.pos = sub(n.pos, pivotAbs);
  to.add(n);
}

/** Build a rigged prop from its manifest. `text` paints 'sign' decals (sign_board). */
export function buildRig(m: PropManifest, spec: RigSpec, instanceId: string, opts: { seed: number; text?: string } = { seed: 0 }): RiggedProp {
  const inst = buildProp(m, instanceId);
  const pivots: Record<string, Node> = {}, abs: Record<string, Vec3> = {}, rest: Record<string, Vec3> = {};
  for (const pv of spec.pivots ?? []) {
    const at = m.anchors[pv.at];
    if (!at) throw new Error(`${m.id}: pivot ${pv.id} anchor ${pv.at} missing`);
    const parentAbs = pv.parent ? abs[pv.parent] : ZERO;
    if (pv.parent && !pivots[pv.parent]) throw new Error(`${m.id}: pivot ${pv.id} parent ${pv.parent} must be declared first`);
    const n = new Node(`pivot:${pv.id}`);
    n.pos = sub(at as Vec3, parentAbs);
    (pv.parent ? pivots[pv.parent] : inst.root).add(n);
    pivots[pv.id] = n; abs[pv.id] = [...at] as Vec3; rest[pv.id] = [...n.pos] as Vec3;
  }
  for (const p of m.parts) {
    if (p.attach === 'root') continue;
    const pv = pivots[p.attach];
    if (!pv) throw new Error(`${m.id}: part ${p.id} attaches to unknown pivot ${p.attach}`);
    reparent(inst.parts[p.id], pv, abs[p.attach]);
  }
  for (const pv of spec.pivots ?? []) for (const a of pv.anchors ?? []) {
    const n = inst.anchors[a];
    if (!n) throw new Error(`${m.id}: pivot ${pv.id} carries unknown anchor ${a}`);
    reparent(n, pivots[pv.id], abs[pv.id]);
  }
  const base = new Map<string, { color: RGB; emissive: RGB; sheen: number }>();
  for (const [id, n] of Object.entries(inst.parts)) base.set(id, { color: [...n.material!.color] as RGB, emissive: [...(n.material!.emissive ?? [0, 0, 0])] as RGB, sheen: n.material!.sheen ?? 0.25 });
  const rig: RiggedProp = { instance: inst, states: Object.keys(spec.states), id: m.id, spec, pivots, rest, text: opts.text, current: { state: spec.defaultState, u: 1, from: spec.defaultState }, base, wrap: new Set((spec.pivots ?? []).filter((p) => p.wrap).map((p) => p.id)) };
  for (const [partId, painter] of Object.entries(spec.decals ?? {})) {
    const n = inst.parts[partId];
    if (!n) throw new Error(`${m.id}: decal part ${partId} missing`);
    const tex = propTexture(painter, painter === 'sign' ? (opts.text ?? 'NOTICE') : undefined);
    if (tex) { n.material!.texture = tex; n.material!.color = [1, 1, 1]; }
  }
  applyRigState(rig, spec.defaultState, 1);
  return rig;
}

function setScreen(rig: RiggedProp, partId: string, k: number): void {
  const n = rig.instance.parts[partId], b = rig.base.get(partId)!;
  const mat = n.material!;
  const tex = k > 0.001 ? propTexture(rig.spec.screens![partId]) : null;
  if (k > 0.001 && tex) {
    const v = 0.06 + 0.94 * k;
    mat.texture = tex; mat.unlit = true; mat.color = [v, v, v]; mat.emissive = [0, 0, 0];
  } else if (k > 0.001) { // no canvas (node): brightness as emission only
    mat.texture = undefined; mat.unlit = false; mat.color = b.color; mat.emissive = [0.35 * k, 0.55 * k, 0.8 * k];
  } else {
    mat.texture = undefined; mat.unlit = false; mat.color = b.color; mat.emissive = b.emissive; mat.sheen = b.sheen;
  }
}

/**
 * Pose the prop for `state` at progress u (0..1) of the transition into it, starting from `from` (default: the state's
 * declared `from`). Returns the numeric PropState fields the state drives (e.g. capDepth); pivots/screens/lights are
 * written to the rig's nodes directly because PropState has no field for them.
 */
export function applyRigState(rig: RiggedProp, state: string, u: number, from?: string): Partial<PropState> {
  const to = rig.spec.states[state];
  if (!to) throw new Error(`${rig.id}: unknown state "${state}" (states: ${rig.states.join(', ')})`);
  const fromName = from ?? to.from;
  const fr = rig.spec.states[fromName];
  if (!fr) throw new Error(`${rig.id}: unknown from-state "${fromName}"`);
  const uc = clamp(u, 0, 1), e = EASE[to.ease ?? 'smooth'](uc), ec = clamp(e, 0, 1);
  const A = fr.pose, B = to.pose;
  for (const [id, n] of Object.entries(rig.pivots)) {
    const a = A.pivots?.[id] ?? {}, b = B.pivots?.[id] ?? {};
    const ar = a.rot ?? ZERO, from3: Vec3 = rig.wrap.has(id) ? [ar[0] % 360, ar[1] % 360, ar[2] % 360] : ar;
    n.rot = pivotQuat(lerp3(from3, b.rot ?? ZERO, e));
    const off = lerp3(a.off ?? ZERO, b.off ?? ZERO, e);
    const r = rig.rest[id];
    n.pos = [r[0] + off[0], r[1] + off[1], r[2] + off[2]];
  }
  for (const [partId, hexCol] of Object.entries(rig.spec.lit ?? {})) {
    const k = lerp(A.lit?.[partId] ?? 0, B.lit?.[partId] ?? 0, ec);
    const c = hex(hexCol), b = rig.base.get(partId)!;
    const mat = rig.instance.parts[partId].material!;
    // emission alone washes out on sunlit pale faces: a lit part takes the light colour and, past half-on, renders
    // self-illuminated (unlit), so "on" always reads as a light source
    mat.color = [lerp(b.color[0], c[0], k), lerp(b.color[1], c[1], k), lerp(b.color[2], c[2], k)];
    mat.unlit = k > 0.5;
    mat.emissive = mat.unlit ? [c[0] * 0.25 * k, c[1] * 0.25 * k, c[2] * 0.25 * k] : [b.emissive[0] + c[0] * k, b.emissive[1] + c[1] * k, b.emissive[2] + c[2] * k];
  }
  for (const partId of Object.keys(rig.spec.screens ?? {})) setScreen(rig, partId, lerp(A.screens?.[partId] ?? 0, B.screens?.[partId] ?? 0, ec));
  const vis = new Set([...Object.keys(A.visible ?? {}), ...Object.keys(B.visible ?? {})]);
  for (const partId of vis) rig.instance.parts[partId].visible = (uc < 0.5 ? A.visible?.[partId] : B.visible?.[partId]) ?? true;
  const out: Partial<PropState> = {};
  for (const k of ['capDepth', 'glow'] as const) {
    if (A.state?.[k] === undefined && B.state?.[k] === undefined) continue;
    out[k] = lerp(A.state?.[k] ?? 0, B.state?.[k] ?? 0, ec);
  }
  rig.current = { state, u: uc, from: fromName };
  return out;
}

/** Set one pivot directly (continuous controls such as wheel roll / steering), relative to the authored pose. */
export function setPivot(rig: RiggedProp, pivot: string, rotDeg: Vec3, off: Vec3 = ZERO): void {
  const n = rig.pivots[pivot];
  if (!n) throw new Error(`${rig.id}: unknown pivot ${pivot}`);
  const r = rig.rest[pivot];
  n.rot = pivotQuat(rotDeg); n.pos = [r[0] + off[0], r[1] + off[1], r[2] + off[2]];
}

/**
 * Current prop-space position of an anchor/grip, following the pivots it rides (a door handle moves with the leaf).
 * Multiply by the prop root's world matrix for world space. Production.propAnchor() reads manifest anchors only (static).
 */
export function anchorLocal(rig: RiggedProp, name: string): Vec3 {
  const n = rig.instance.anchors[name];
  if (!n) throw new Error(`${rig.id}: unknown anchor ${name}`);
  let m: Mat4 = m4();
  const chain: Node[] = [];
  for (let c: Node | null = n; c && c !== rig.instance.root; c = c.parent) chain.push(c);
  for (const c of chain.reverse()) m = m4Mul(m, m4TRS(c.pos, c.rot, c.scl));
  const p = m4TransformPoint(m, ZERO);
  return [p[0], p[1], p[2]];
}
