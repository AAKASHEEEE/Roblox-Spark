// Narrated Continuity Checkpoint 2 — integration of the three worker modules (narrated drafts ONLY).
//
// Pipeline order (per frame / per shot / per caption chunk):
//   approved storyboard -> audio hash check (caller) -> WorldPlan -> sampleWorld(t) -> NarratedEngineAdapter.applySnapshot
//   -> posed engine geometry -> CameraSafetyScene (posed, never stale) -> safe camera per shot (+ screen-direction carry)
//   -> projected occupied bounds over each caption chunk -> ONE stable caption placement per chunk (camera re-selected
//   when no hard-rule-safe band exists) -> blocking continuity / camera / caption / semantic gates -> render only if all pass.
// Cameras are read-only consumers of the posed scene: they never write actor or prop transforms. Caption placement is a
// read-only consumer of projected bounds: it never changes a camera or the world. Visual Comedy never reaches this file.
// Browser-safe (no node imports): the renderer page uses NarratedScene + the integrated timeline produced here.
import type { Production } from '../../packages/engine/src/production.ts';
import type { Rig } from '../../packages/engine/src/build.ts';
import type { Node } from '../../packages/engine/src/gl/scene.ts';
import type { CameraState, Lighting, PointLight } from '../../packages/engine/src/gl/renderer.ts';
import { m4TransformPoint, DEG, type Vec3 } from '../../packages/engine/src/math.ts';
import {
  evaluateCameraCandidate, buildSafeFallbackCandidates, nextScreenDirectionState, projectToScreen, cameraAxisSide, CAMERA_SAFETY_DEFAULTS,
  type Bounds3, type CameraCandidate, type CameraIntent, type CameraObstacle, type CameraSafetyResult, type CameraSafetyScene, type ProjectedEntity, type PropIdentity, type ScreenDirectionState,
} from '../../packages/engine/src/camera-safety.ts';
import { placeCaption, type CaptionPlacementResult, type OccupiedRegion, type Rect } from '../../packages/engine/src/caption-placement.ts';
import { sampleWorld, type WorldPlan, type WorldState } from '../../packages/narrated/src/world.ts';
import type { NarratedStoryboard, NarratedPhrase } from '../../packages/narrated/src/schema.ts';
import type { NarratedTimeline, CaptionEvent } from '../../packages/narrated/src/timeline.ts';
import { NarratedEngineAdapter, PENETRATION_TOLERANCE_M, type AdapterDiagnostics } from './narrated-world-adapter.ts';

export const INTEGRATED_TIMELINE_SCHEMA = 'blockspark.narrated-integrated-timeline/1';
export const ANALYSIS_SCHEMA = 'blockspark.narrated-continuity-analysis/1';
/** blocking minimum posed-scene Zapp/coin clearance (m); never lowered to pass */
export const MIN_COIN_CLEARANCE_M = 0.02;
export const MAX_HEAD_STEP_M = 0.08;
export const MAX_HEAD_STEP_DEG = 12;
export const MAX_COIN_BASE_DRIFT_M = 0.01;
export const MIN_JUMP_M = 0.25;
export const MAX_PRESS_HAND_GAP_M = 0.08;
export const KIRA_HAZARD_MARGIN_M = 0.5;
export const MIN_SHOT_SEC = 0.6;
/** planning samples: every CAMERA_SAMPLE_FRAMES frames (100 ms at 30 fps) + first/last + every event, mark and
 *  pose/expression transition frame; the chosen camera is then validated on EVERY frame of the shot */
export const CAMERA_SAMPLE_FRAMES = 3;
/** caption projection covers every frame of the chunk */
export const CAPTION_SAMPLE_FRAMES = 1;
/** fully validated alternatives kept per shot (for caption-conflict camera reselection) */
export const FULL_VALIDATED_PER_SHOT = 3;
/** tracking camera: max lens / aim step per frame (no teleport), smoothing half-window (frames) */
export const MAX_TRACK_STEP_M = 0.06;
export const TRACK_SMOOTH_FRAMES = 4;
export const PRIMARY_FACE_CAPTION_MAX = 0.08;
export const HERO_PROP_CAPTION_MAX = 0.5;

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const r3 = (x: number) => Math.round(x * 1e3) / 1e3;
const d2 = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[2] - b[2]);
const d3 = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const PROP_OBSTACLES = ['desk', 'button', 'coin'];
/** intents whose camera rules require the active/required faces to read (C03 scope) */
const FACE_REQUIRED_INTENTS = new Set<CameraIntent>(['medium', 'close', 'reaction', 'over_shoulder', 'extreme_close', 'three_quarter_profile', 'motivated_profile', 'offset_elevated_speaker_ots']);
/** prop_growth_sequence: a stage spans at most this growth ratio (a static camera keeps the prop 20%..50% of frame) */
export const GROWTH_STAGE_RATIO = 2.5;
export const MIN_SHOT_FRAMES = 18;

export interface CoverageSegment { id: string; start: number; end: number; frames: [number, number]; spec: ShotSpec; coverage: IntegratedShot['coverage'] }
/** deterministic prop-growth stage boundaries: first frame where the prop scale reaches s0 * RATIO^k (short stages merge) */
export function growthStageBoundaries(scales: number[], a: number): number[] {
  const s0 = Math.max(1e-6, scales[0]), cuts: number[] = [];
  let k = 1;
  for (let i = 0; i < scales.length; i++) while (scales[i] >= s0 * GROWTH_STAGE_RATIO ** k - 1e-9) { cuts.push(a + i); k++; }
  const kept: number[] = [];
  for (const c of [...new Set(cuts)]) if (c - (kept[kept.length - 1] ?? a) >= MIN_SHOT_FRAMES && a + scales.length - c >= MIN_SHOT_FRAMES) kept.push(c);
  return kept;
}
/**
 * Reusable coverage patterns selected from the beat's semantic events (never by shot id). Returns the sub-shots that
 * together own exactly the source shot's frames, or null for single coverage.
 */
export const IMPACT_LEAD_FRAMES = 8;
export function coverageSegments(geos: FrameGeo[], id: string, start: number, end: number, fr: [number, number], spec: ShotSpec, fps: number, contactFrame: number | null = null): CoverageSegment[] | null {
  // cut times are floored to 1e-4 s so that ceil(t*fps) maps each cut back to exactly its first frame
  const tAt = (k: number) => Math.floor((k / fps) * 1e4) / 1e4;
  const seg = (sfx: string, a: number, b: number, sp: ShotSpec, coverage: IntegratedShot['coverage']): CoverageSegment => ({ id: `${id}${sfx}`, start: a === fr[0] ? start : tAt(a), end: b === fr[1] ? end : tAt(b), frames: [a, b], spec: sp, coverage });
  const n = fr[1] - fr[0], mid = fr[0] + Math.floor(n / 2);
  if (spec.pattern === 'impact_sequence' && contactFrame !== null) {
    const cut = contactFrame - IMPACT_LEAD_FRAMES;
    if (cut - fr[0] >= MIN_SHOT_FRAMES && fr[1] - cut >= MIN_SHOT_FRAMES) return [
      seg('a', fr[0], cut, { ...spec, pattern: undefined, reason: 'impact 1/2: tip geography wide' }, 'impact_tip'),
      seg('b', cut, fr[1], { ...spec, pattern: undefined, subjects: ['zapp'], optional: [], reason: 'impact 2/2: tighter coin + patient framing through the contact and fall start' }, 'impact_contact'),
    ];
    return null;
  }
  if (spec.pattern === 'prop_growth_sequence') {
    const prop = spec.heroProps[0], scales = geos.slice(fr[0], fr[1]).map((g) => g.coinScale);
    const cuts = growthStageBoundaries(scales, fr[0]), edges = [fr[0], ...cuts, fr[1]];
    if (edges.length < 3) return null;
    // scale reference: the tallest actor's FULL height (feet to head top)
    const refH = Math.max(...Object.values(geos[fr[0]].actors).map((x) => Math.max(x.head.max[1], x.body.max[1]) - x.body.min[1]), 1);
    return edges.slice(0, -1).map((a, k) => {
      const b = edges[k + 1], sw = union(geos.slice(a, b).map((g) => g.props[prop]).filter((x): x is Bounds3 => !!x));
      const size = sw ? Math.max(sw.max[0] - sw.min[0], sw.max[1] - sw.min[1], sw.max[2] - sw.min[2]) : 0;
      const stage = size < 0.25 * refH ? 'small' : size < 0.6 * refH ? 'mid' : 'giant';
      const sp: ShotSpec = stage === 'small'
        ? { ...spec, intent: 'prop', optional: [...spec.subjects], scaleRefs: undefined, pattern: undefined, reason: `prop_growth_sequence ${k + 1}/${edges.length - 1} (small): close prop insert, face not required` }
        : stage === 'mid'
          ? { ...spec, intent: 'scale_reveal', optional: [...spec.subjects], scaleRefs: [], pattern: undefined, reason: `prop_growth_sequence ${k + 1}/${edges.length - 1} (mid): prop scale reveal, no face hidden by the prop` }
          : { ...spec, intent: 'scale_reveal', optional: spec.subjects.filter((x) => x !== spec.active), scaleRefs: [spec.active], pattern: undefined, reason: `prop_growth_sequence ${k + 1}/${edges.length - 1} (giant): scale reveal with ${spec.active} for scale` };
      return seg(`g${k + 1}`, a, b, sp, 'growth_stage');
    });
  }
  if ((spec.pattern === 'reaction_then_insert' || spec.pattern === 'consequence_sequence') && n >= 2 * MIN_SHOT_FRAMES) {
    const other = spec.subjects.find((x) => x !== spec.active);
    if (spec.pattern === 'reaction_then_insert') return [
      seg('a', fr[0], mid, { ...spec, intent: 'reaction', subjects: [spec.active, ...(other ? [other] : [])], optional: other ? [other] : [], heroProps: [], requiresHeroProp: false, scaleRefs: undefined, pattern: undefined, reason: `${spec.active} reaction (prop not required; supporting actor optional)` }, 'sequential_reaction'),
      seg('b', mid, fr[1], { ...spec, intent: 'scale_reveal', subjects: [spec.active], optional: [spec.active], scaleRefs: [], pattern: undefined, reason: `giant-prop scale insert (${spec.active} optional; supporting actor excluded)` }, 'sequential_insert'),
    ];
    return [
      seg('a', fr[0], mid, { ...spec, intent: 'medium', heroProps: [], requiresHeroProp: false, scaleRefs: undefined, propEdge: [...spec.heroProps], pattern: undefined, reason: `consequence 1/2: ${spec.active} close/medium, posture readable, prop thickness edge visible` }, 'consequence_subject'),
      seg('b', mid, fr[1], { ...spec, intent: 'elevated_consequence', pattern: undefined, reason: `consequence 2/2: elevated consequence (${spec.active} + prop emblem/thickness, geography)` }, 'consequence_elevated'),
    ];
  }
  return null;
}

// ───────────────────────────── posed scene ─────────────────────────────

/** Narrated-only runtime over a Production: WorldState (through the adapter) is the only writer of actor/prop transforms. */
export class NarratedScene {
  readonly adapter: NarratedEngineAdapter;
  readonly prod: Production;
  readonly plan: WorldPlan;
  constructor(prod: Production, plan: WorldPlan) {
    this.prod = prod; this.plan = plan;
    // WorldState prop transforms are absolute: the button must not inherit the desk transform twice
    const b = prod.props.get('button');
    if (b && b.inst.root.parent && b.inst.root.parent !== prod.root) { const p = b.inst.root.parent; p.children.splice(p.children.indexOf(b.inst.root), 1); b.inst.root.parent = null; prod.root.add(b.inst.root); }
    // static set dressing the world does not own (the desk) is placed once from its episode track
    for (const [id, p] of prod.props) if (id !== 'coin' && id !== 'button') p.track.apply(0);
    this.adapter = new NarratedEngineAdapter();
    this.adapter.initialize(plan, prod);
  }
  /** sample the authoritative world at t and apply it; the posed scene world matrices are up to date on return */
  pose(t: number, previous: WorldState | null): { world: WorldState; diag: AdapterDiagnostics } {
    const world = sampleWorld(this.plan, t);
    const diag = this.adapter.applySnapshot(world, previous, this.prod);
    this.prod.root.updateWorld();
    return { world, diag };
  }
  lighting(world: WorldState): Lighting {
    const L = this.prod.lighting(), pts: PointLight[] = [];
    const b = this.prod.props.get('button'), glow = world.props.button?.glow ?? 0;
    const g = b?.inst.anchors.glow;
    if (g && glow > 0.01) { const p = g.worldPos(); pts.push({ pos: [p[0], p[1] + 0.05, p[2] + 0.05], color: [1, 0.22, 0.18], intensity: 0.9 * glow, range: 0.45 }); }
    L.points = pts;
    return L;
  }
}

// ───────────────────────────── geometry extraction ─────────────────────────────

function nodeOBB(n: Node): { center: Vec3; axes: [Vec3, Vec3, Vec3]; half: Vec3 } | undefined {
  const h = n.geometry?.half;
  if (!h) return undefined;
  const w = n.world, col = (k: number): Vec3 => [w[k * 4], w[k * 4 + 1], w[k * 4 + 2]], l = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);
  const c = [col(0), col(1), col(2)], ls = c.map(l);
  if (ls.some((x) => x < 1e-9)) return undefined;
  return { center: [w[12], w[13], w[14]], axes: c.map((v, k) => [v[0] / ls[k], v[1] / ls[k], v[2] / ls[k]] as Vec3) as [Vec3, Vec3, Vec3], half: [h[0] * ls[0], h[1] * ls[1], h[2] * ls[2]] };
}
function nodeCorners(n: Node): Vec3[] | null {
  const h = n.geometry?.half;
  if (!h) return null;
  const w = n.world, out: Vec3[] = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) { const p = m4TransformPoint(w, [sx * h[0], sy * h[1], sz * h[2]]); out.push([p[0], p[1], p[2]]); }
  return out;
}
function nodeBox(n: Node): Bounds3 | null {
  const h = n.geometry?.half;
  if (!h) return null;
  const w = n.world;
  if (Math.hypot(w[0], w[1], w[2]) < 0.02) return null;
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    const p = m4TransformPoint(w, [sx * h[0], sy * h[1], sz * h[2]]);
    for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]); }
  }
  return { min, max };
}
const union = (bs: Bounds3[]): Bounds3 | null => bs.length ? { min: [0, 1, 2].map((k) => Math.min(...bs.map((b) => b.min[k]))) as Vec3, max: [0, 1, 2].map((k) => Math.max(...bs.map((b) => b.max[k]))) as Vec3 } : null;
const pad = (p: readonly number[], r: number): Bounds3 => ({ min: [p[0] - r, p[1] - r, p[2] - r], max: [p[0] + r, p[1] + r, p[2] + r] });

export interface ActorGeo { id: string; head: Bounds3; body: Bounds3; face: { center: Vec3; normal: Vec3; halfWidth: number; halfHeight: number }; root: Vec3; yawDeg: number; velocity: Vec3; posture: string; waistUp: boolean; waistY: number; handR: Vec3; handL: Vec3; chest: Vec3; headCorners: Vec3[]; lookTarget: string | null }
/** everything the camera and caption layers may read about one frame: extracted from the POSED scene only */
export interface FrameGeo { i: number; t: number; obstacles: CameraObstacle[]; actors: Record<string, ActorGeo>; props: Record<string, Bounds3 | null>; interaction: Vec3 | null; interactionKind: string | null; coinVisible: boolean; coinScale: number; coinIdentity: PropIdentity | null; lookTargets: Record<string, Vec3>; labels: Record<string, Bounds3[]> }

function rigGeo(id: string, rig: Rig, w: WorldState, diag: AdapterDiagnostics): { geo: ActorGeo; obs: CameraObstacle[] } {
  const obs: CameraObstacle[] = [], body: Bounds3[] = [], head: Bounds3[] = [], hair: Bounds3[] = [], headCorners: Vec3[] = [], hairNodes: Node[] = [];
  const f = rig.face.world, [hw, hh] = rig.manifest.body.headSize;
  const n = Math.hypot(f[8], f[9], f[10]) || 1;
  for (const m of rig.meshes) {
    if (!m.visible) continue;
    const b = nodeBox(m);
    if (!b) continue;
    // head-bone parts (hair, cap, brim) move rigidly with the head: they are part of the head volume, so an actor's own
    // hair AABB never counts as occluding the actor's own face; the crown above the face is ALSO kept as a 'hair' obstacle
    const onHead = m.name === 'head_mesh' || m.parent?.name === 'neck';
    const ob = nodeOBB(m);
    obs.push({ entityId: id, type: onHead ? 'head' : 'body', bounds: b, ...(ob ? { oriented: ob } : {}) });
    (onHead ? head : body).push(b);
    if (onHead) headCorners.push(...(nodeCorners(m) ?? []));
    if (onHead && m.name !== 'head_mesh') { hair.push(b); hairNodes.push(m); }
  }
  const faceTop = rig.face.worldPos()[1] + (hh / 2) * Math.abs(f[5] / (Math.hypot(f[4], f[5], f[6]) || 1)) + 0.02;
  const crown = union(hair.filter((b) => b.max[1] > faceTop).map((b) => ({ min: [b.min[0], Math.max(b.min[1], faceTop), b.min[2]] as Vec3, max: b.max })));
  // the union AABB of a yawed head's hair is up to ~40% wider than the hair: keep it as the (conservative) collision
  // envelope, and emit each hair part above the face, clipped at faceTop along its near-vertical axis, as the occluder
  const upright = hairNodes.every((m) => { const ob = nodeOBB(m); return !ob || ob.axes.some((a) => Math.abs(a[1]) > 0.95); });
  if (crown) obs.push({ entityId: id, type: 'hair', bounds: crown, ...(upright ? { occludes: false } : {}) });
  if (crown && upright) for (const m of hairNodes) {
    const b = nodeBox(m), ob = nodeOBB(m);
    if (!b || !ob || b.max[1] <= faceTop) continue;
    const k = ob.axes.findIndex((a) => Math.abs(a[1]) > 0.95), ax = ob.axes[k], sgn = ax[1] > 0 ? 1 : -1;
    const t0 = Math.max(-ob.half[k], (faceTop - ob.center[1]) / (ax[1] * sgn)), t1 = ob.half[k];
    if (t1 <= t0) continue;
    const mid = (t0 + t1) / 2, half: Vec3 = [...ob.half] as Vec3; half[k] = (t1 - t0) / 2;
    const center: Vec3 = [ob.center[0] + ax[0] * sgn * mid, ob.center[1] + ax[1] * sgn * mid, ob.center[2] + ax[2] * sgn * mid];
    obs.push({ entityId: id, type: 'hair', bounds: { min: [b.min[0], Math.max(b.min[1], faceTop), b.min[2]], max: b.max }, oriented: { center, axes: ob.axes, half } });
  }
  const a = w.actors[id], ad = diag.actors[id];
  const hips = rig.joints.hips.worldPos();
  const neck = rig.joints.neck.worldPos();
  return {
    obs,
    geo: {
      id, head: union(head.slice(0, 1).length ? head : body)!, body: union(body)!, root: [...ad.appliedRoot] as Vec3, yawDeg: a.yawDeg, velocity: [...a.velocity] as Vec3, posture: a.posture,
      face: { center: rig.face.worldPos(), normal: [f[8] / n, f[9] / n, f[10] / n], halfWidth: (hw / 2) * 0.9, halfHeight: (hh / 2) * 0.9 },
      waistUp: !!ad.framing.waist_up_required, waistY: hips[1] + 0.05, handR: rig.hand_r.worldPos(), handL: rig.hand_l.worldPos(), chest: [(hips[0] + neck[0]) / 2, (hips[1] + neck[1]) / 2, (hips[2] + neck[2]) / 2],
      headCorners, lookTarget: a.lookTarget ?? null,
    },
  };
}

export function extractFrameGeo(ns: NarratedScene, i: number, w: WorldState, diag: AdapterDiagnostics): FrameGeo {
  const prod = ns.prod, obstacles: CameraObstacle[] = [], actors: Record<string, ActorGeo> = {}, props: Record<string, Bounds3 | null> = {}, labels: Record<string, Bounds3[]> = {};
  for (const c of prod.env.colliders) if (c.id !== 'floor') obstacles.push({ entityId: `env:${c.id}`, type: 'environment', bounds: { min: [...c.min] as Vec3, max: [...c.max] as Vec3 } });
  for (const [id, rig] of prod.rigs) { if (!w.actors[id]) continue; const g = rigGeo(id, rig, w, diag); actors[id] = g.geo; obstacles.push(...g.obs); }
  for (const id of PROP_OBSTACLES) {
    const p = prod.props.get(id);
    if (!p || !p.inst.root.visible) { props[id] = null; continue; }
    const bs: Bounds3[] = [], lb: Bounds3[] = [];
    for (const [pn, n] of Object.entries(p.inst.parts)) if (n.visible && n.geometry && /label/i.test(pn)) { const b = nodeBox(n); if (b) lb.push(b); }
    labels[id] = lb;
    for (const n of Object.values(p.inst.parts)) { if (!n.geometry || n.decal || !n.visible) continue; const b = nodeBox(n); if (b) { bs.push(b); const ob = nodeOBB(n); obstacles.push({ entityId: id, type: 'prop', bounds: b, ...(ob ? { oriented: ob } : {}) }); } }
    props[id] = union(bs);
  }
  // causal interaction point: the press contact (hand -> press surface) or the coin/patient contact
  const P = ns.plan, pressT = P.button.pressT, tip = P.coin.tip;
  let interaction: Vec3 | null = null, interactionKind: string | null = null;
  if (pressT !== null && w.t >= pressT - 0.35 && w.t <= pressT + 0.25) { interaction = [...P.assets.button.pressSurface] as Vec3; interactionKind = 'press'; }
  else if (P.button.resetT !== null && w.t >= P.button.resetT - 0.05 && w.t <= P.button.resetT + 0.4) { interaction = [...P.assets.button.pressSurface] as Vec3; interactionKind = 'reset'; }
  else if (tip && w.t >= tip.tc - 0.35 && w.t <= tip.t1 && actors.zapp) { interaction = actors.zapp.chest; interactionKind = 'coin_contact'; }
  const coin = w.props.coin;
  // coin identity landmarks from the POSED disc: face normal (cylinder axis, audience/up side), emblem, rim, base
  let coinIdentity: PropIdentity | null = null;
  const cp = prod.props.get('coin');
  const disc = cp && cp.inst.root.visible ? Object.values(cp.inst.parts).find((n) => n.geometry && !n.decal && n.visible) : undefined;
  if (disc?.geometry) {
    const m = disc.world, h = disc.geometry.half;
    const col = (k: number): Vec3 => [m[k * 4], m[k * 4 + 1], m[k * 4 + 2]];
    const l = (v: Vec3) => Math.hypot(v[0], v[1], v[2]) || 1;
    const ax0 = col(1), R = h[0] * l(col(0)), th = h[1] * l(ax0);
    let ax: Vec3 = [ax0[0] / l(ax0), ax0[1] / l(ax0), ax0[2] / l(ax0)];
    if (ax[1] * 0.447 + ax[2] * 0.894 < 0) ax = [-ax[0], -ax[1], -ax[2]];
    const c: Vec3 = [m[12], m[13], m[14]];
    const u0 = col(0), u: Vec3 = [u0[0] / l(u0), u0[1] / l(u0), u0[2] / l(u0)];
    const v: Vec3 = [ax[1] * u[2] - ax[2] * u[1], ax[2] * u[0] - ax[0] * u[2], ax[0] * u[1] - ax[1] * u[0]];
    const rim: Vec3[] = Array.from({ length: 12 }, (_, k) => { const a = (k / 12) * 2 * Math.PI; return [c[0] + R * (u[0] * Math.cos(a) + v[0] * Math.sin(a)), c[1] + R * (u[1] * Math.cos(a) + v[1] * Math.sin(a)), c[2] + R * (u[2] * Math.cos(a) + v[2] * Math.sin(a))] as Vec3; });
    const base = rim.reduce((b, p) => (p[1] < b[1] ? p : b), rim[0]);
    coinIdentity = { center: c, frontNormal: ax, emblem: [c[0] + ax[0] * th, c[1] + ax[1] * th, c[2] + ax[2] * th], rim, base: [base[0], Math.max(base[1], 0.01), base[2]] };
  }
  const lookTargets: Record<string, Vec3> = {};
  const marks = P.assets.marks as Record<string, { pos: readonly number[] } | undefined>;
  for (const [id, mk] of Object.entries(marks)) if (mk) lookTargets[id] = [mk.pos[0], mk.pos[1] + 1.5, mk.pos[2]];
  return { i, t: w.t, obstacles, actors, props, interaction, interactionKind, coinVisible: !!coin?.visible, coinScale: coin?.scale ?? 0, coinIdentity, lookTargets, labels };
}

// ───────────────────────────── shot specs (motivated coverage) ─────────────────────────────

export interface ShotSpec {
  intent: CameraIntent; active: string; subjects: string[]; optional: string[]; heroProps: string[]; reason: string; requiresHeroProp: boolean; scaleRefs?: string[];
  /** reusable coverage pattern selected from the beat's semantic events (see coverageSegments) */
  pattern?: 'prop_growth_sequence' | 'reaction_then_insert' | 'consequence_sequence' | 'speaker_ots' | 'impact_sequence';
  /** speaker OTS: the listener whose shoulder is in the foreground */
  foreground?: string;
  /** props whose thickness edge must read in this shot */
  propEdge?: string[];
  /** props whose complete silhouette must stay inside the frame */
  propFull?: string[];
  /** characters that must be fully out of frame (no screen coverage) */
  excluded?: string[];
  /** a non-subject head partially attached to the frame edge rejects the camera (instead of ranking it last) */
  strictHeadEdge?: boolean;
  /** the beat's approved camera preset is a two-shot: every required face must read */
  twoShotPreset?: boolean;
  /** used (instead of sequential coverage) when no camera satisfies this spec */
  singleFallback?: ShotSpec;
}
export interface WindowFacts { jump: boolean; press: boolean; coinSpawn: boolean; grow: boolean; tip: boolean; kiraWalk: boolean; zappWalk: boolean; reset: boolean; seated: string[]; last: boolean; first: boolean;
  /** caption chunk names these characters; `safeBefore`: characters that reached a safe mark before the shot */
  chunkNames?: string[]; safeBefore?: string[];
  /** the shot starts after the coin/patient contact inside the affected actor's own phrase (0 = first such shot) */
  resultIdx?: number | null; contactInShot?: boolean;
  /** the shot is the last shot of its phrase (the hand-off into the next beat) */
  lastOfPhrase?: boolean }

function windowFacts(plan: WorldPlan, s: number, e: number, first: boolean, last: boolean): WindowFacts {
  const inW = (t: number | null | undefined) => t !== null && t !== undefined && t >= s - 1e-9 && t < e - 1e-9;
  const ev = (type: string) => plan.events.filter((x) => x.type === type).map((x) => x.t);
  const seg = (id: string, kind: string) => (plan.actors[id]?.segs ?? []).some((q) => q.kind === kind && q.t0 < e && q.t1 > s);
  const seated = Object.keys(plan.actors).filter((id) => plan.actors[id].segs.some((q) => q.posture === 'implied_seated' && q.t0 < e && q.t1 > s));
  const tip = plan.coin.tip;
  return {
    jump: seg('zapp', 'jump'), press: inW(plan.button.pressT), coinSpawn: ev('coin_spawn').some(inW) || ev('coin_land').some(inW), grow: ev('grow_step').some(inW) || ev('coin_stand').some(inW),
    tip: !!tip && tip.t0 < e && tip.t1 > s, kiraWalk: seg('kira', 'path'), zappWalk: seg('zapp', 'path'), reset: inW(plan.button.resetT), seated, first, last,
  };
}
const explicitlyNamed = (p: NarratedPhrase, who: string) => new RegExp(`\\b${who}\\b`, 'i').test(p.text) || (who === 'zapp' && /\b(him|his)\b/i.test(p.text) && p.actor !== 'zapp');

/** one visual intent per timeline shot, from the beat's semantics and the WORLD events inside the shot window */
export function shotSpec(p: NarratedPhrase, f: WindowFacts, geoMid: FrameGeo, phraseShotIndex: number): ShotSpec {
  const actor = p.actor, other = actor === 'zapp' ? 'kira' : 'zapp', both = [actor, other];
  const coinReady = geoMid.coinVisible;
  // impact: the tip is cut just before contact so the contact itself is seen in a tighter coin + patient framing
  if (f.tip && f.contactInShot) return { intent: 'wide', active: 'zapp', subjects: ['zapp', 'kira'], optional: ['kira'], heroProps: ['coin'], pattern: 'impact_sequence', reason: 'tip/contact/fall: tip geography, then a tighter coin + patient framing through the contact', requiresHeroProp: true };
  if (f.tip) return { intent: 'wide', active: 'zapp', subjects: ['zapp', 'kira'], optional: ['kira'], heroProps: ['coin'], reason: 'tip/contact/fall: impact geography wide (coin + patient; Kira outside the hazard, optional)', requiresHeroProp: true };
  // flattened result: every shot of the affected actor's phrase after the contact keeps the prop + prone patient framed
  if (f.resultIdx !== null && f.resultIdx !== undefined && coinReady) return f.resultIdx === 0
    ? { intent: 'medium', active: 'zapp', subjects: ['zapp'], optional: [], heroProps: [], propEdge: ['coin'], reason: 'flattened result 1: prone patient close/medium with the coin thickness edge', requiresHeroProp: false }
    : { intent: 'elevated_consequence', active: 'zapp', subjects: ['zapp'], optional: [], heroProps: ['coin'], scaleRefs: ['zapp'], reason: 'flattened result 2: elevated coin + prone patient (emblem, thickness, floor)', requiresHeroProp: true };
  // coin-scale narration while the actors walk: the growing coin stays fully framed with both actors for scale
  const coinGrowBeat = p.propEvents.some((e) => e.prop === 'spark_coin' && e.event === 'grow');
  if (coinGrowBeat && coinReady && (f.kiraWalk || f.zappWalk)) return { intent: 'wide', active: f.kiraWalk ? 'kira' : 'zapp', subjects: ['kira', 'zapp'], optional: [f.kiraWalk ? 'zapp' : 'kira'], heroProps: ['coin'], propFull: ['coin'], reason: 'coin scale passage: complete growing coin + both actors for scale (Kira walks to safety inside it)', requiresHeroProp: true };
  // the caption names the supporting character after she reached safety: establish her there with the hazard for context
  const named = (p.supportingCharacter && (f.chunkNames ?? []).includes(p.supportingCharacter) && (f.safeBefore ?? []).includes(p.supportingCharacter)) ? p.supportingCharacter : null;
  if (named && coinReady) return { intent: 'wide', active: named, subjects: [named, actor], optional: [actor], heroProps: ['coin'], reason: `${named} established safe: ${named} at her safe position with the coin / ${actor} hazard for context`, requiresHeroProp: true };
  if (f.kiraWalk) return { intent: 'wide', active: 'kira', subjects: ['kira', 'zapp'], optional: ['zapp'], heroProps: [], reason: 'Kira visibly walks (move safely / return): full-body wide on Kira', requiresHeroProp: false };
  if (f.press) return { intent: 'prop', active: 'zapp', subjects: ['zapp'], optional: [], heroProps: ['button'], reason: 'press: hand/button contact and interaction point visible', requiresHeroProp: true };
  if (f.jump) return { intent: 'wide', active: 'zapp', subjects: ['zapp', 'kira'], optional: ['kira'], heroProps: [], reason: 'jump: full-body framing so the vertical displacement reads', requiresHeroProp: false };
  if (f.coinSpawn && coinReady) return { intent: 'prop', active: 'zapp', subjects: ['zapp'], optional: ['zapp'], heroProps: ['coin'], reason: 'coin spawn visible', requiresHeroProp: true };
  if ((f.grow || f.zappWalk) && coinReady) return f.grow
    ? { intent: 'scale_reveal', active: 'zapp', subjects: ['zapp', 'kira'], optional: ['zapp', 'kira'], heroProps: ['coin'], scaleRefs: [], pattern: 'prop_growth_sequence', reason: 'coin growth: scale-staged coverage (prop insert -> mid-growth -> giant reveal) cut at prop-scale thresholds', requiresHeroProp: true }
    : { intent: 'scale_reveal', active: 'zapp', subjects: ['zapp', 'kira'], optional: ['kira'], heroProps: ['coin'], scaleRefs: ['zapp'], reason: 'giant-coin scale reveal with Zapp for scale (his face may turn to the coin)', requiresHeroProp: true };
  // consequence: prone Zapp + fallen coin are required; Kira is NOT required here (implied_seated waist-up framing is
  // then not demanded of this shot — she may appear only if her legs stay out of frame / hidden)
  if (f.last) return { intent: 'elevated_consequence', active: 'zapp', subjects: ['zapp'], optional: [], heroProps: ['coin'], scaleRefs: ['zapp'], pattern: 'consequence_sequence', reason: 'ending consequence: prone-Zapp close/medium (coin edge) then elevated consequence (emblem, thickness, geography); Kira not required', requiresHeroProp: true };
  if (f.reset) return { intent: 'neutral_top_down_prop_insert', active: 'zapp', subjects: ['zapp'], optional: ['zapp'], heroProps: ['button'], reason: 'button reset: neutral top-down insert (button + reset point only; no actor in frame; resets geography)', requiresHeroProp: true };
  // look_at beat whose narration names the button the actor looks at: its hand-off shot is a neutral top-down insert of
  // the button alone (reset-insert rules: no actor in frame, FREE COINS label kept clear of the caption); the neutral
  // insert resets screen-direction geography for the next beat
  const looksAtButton = p.semanticAction === 'look_at' && (p.target ?? '').split('.')[0] === 'button' && /\bbutton\b/i.test(p.text);
  if (looksAtButton && f.lastOfPhrase) return { intent: 'neutral_top_down_prop_insert', active: actor, subjects: [actor], optional: [actor], heroProps: ['button'], reason: `${actor} looks at the named button: neutral top-down insert (button only; no actor in frame; resets geography)`, requiresHeroProp: true };
  const seated = f.seated.includes(actor);
  if (seated) return { intent: 'close', active: actor, subjects: [actor, other], optional: [other], heroProps: [], reason: `${actor} implied_seated: waist-up close (no chair/legs shown)`, requiresHeroProp: false };
  if (f.first) return { intent: phraseShotIndex === 0 ? 'wide' : 'medium', active: actor, subjects: both, optional: [], heroProps: [], reason: 'opening comparison: both characters and the classroom geography (both required)', requiresHeroProp: false };
  const warning = p.semanticAction === 'head_shake' && !!p.supportingCharacter && explicitlyNamed(p, p.supportingCharacter);
  if (warning) return { intent: 'medium', active: actor, subjects: both, optional: [], heroProps: [], reason: `${actor} warns ${other}: speaker + listener required`, requiresHeroProp: false };
  if (p.actorRole === 'reactor' && p.propEvents.some((e) => e.prop === 'spark_coin') && coinReady) return { intent: 'scale_reveal', active: actor, subjects: both, optional: [other], heroProps: ['coin'], scaleRefs: [actor], pattern: 'reaction_then_insert', reason: 'reaction to the coin: actor reaction first, then a giant-coin scale insert (same narration interval)', requiresHeroProp: true };
  const intent: CameraIntent = phraseShotIndex % 2 === 1 ? 'reaction' : 'medium';
  // the beat's approved camera preset is a two-shot: its medium shots require BOTH characters (two-shot candidates, both
  // heads fully inside the safe margin); its reactions stay a single on the active actor with the other fully out of
  // frame. Fallback when no two-shot is valid: a tighter single on the active actor, the other fully out of frame.
  if (p.cameraPreset === 'two_shot') return intent === 'medium'
    ? { intent, active: actor, subjects: both, optional: [], heroProps: [], strictHeadEdge: true, twoShotPreset: true, reason: `${actor} ${p.semanticAction}: beat preset two_shot -> two-character medium (both required)`, requiresHeroProp: false,
        singleFallback: { intent: 'reaction', active: actor, subjects: both, optional: [other], heroProps: [], excluded: [other], strictHeadEdge: true, reason: `${actor} ${p.semanticAction}: two_shot preset fallback -> tighter ${actor} single (${other} fully out of frame)`, requiresHeroProp: false } }
    : { intent, active: actor, subjects: both, optional: [other], heroProps: [], excluded: [other], strictHeadEdge: true, reason: `${actor} ${p.semanticAction}: two_shot beat reaction -> ${actor} single (${other} fully out of frame)`, requiresHeroProp: false };
  return { intent, active: actor, subjects: both, optional: [other], heroProps: [], reason: `${actor} ${p.semanticAction}: active-character ${intent} (supporting actor optional)`, requiresHeroProp: false };
}

// ───────────────────────────── camera-safety scene from posed geometry ─────────────────────────────

export function cameraScene(g: FrameGeo, spec: ShotSpec, W: number, H: number, sd: ScreenDirectionState | undefined): CameraSafetyScene {
  const entities: ProjectedEntity[] = [];
  for (const a of Object.values(g.actors)) entities.push({ entityId: a.id, kind: 'character', face: a.face, facing: [Math.sin(a.yawDeg * DEG), 0, Math.cos(a.yawDeg * DEG)], headCorners: a.headCorners, ...(a.waistUp ? { waistUpRequired: true, waistY: a.waistY } : {}) });
  for (const id of spec.heroProps) { const b = g.props[id]; if (b) entities.push({ entityId: id, kind: 'prop', bounds: b, ...(id === 'coin' && g.coinIdentity ? { identity: g.coinIdentity } : {}), ...(g.interaction && ((id === 'button' && (g.interactionKind === 'press' || g.interactionKind === 'reset')) || (id === 'coin' && g.interactionKind === 'coin_contact')) ? { interactionPoint: g.interaction } : {}) }); }
  // off-screen look targets (marks such as the classroom door) and each actor's CURRENT eyeline target (from the world
  // look target at this frame): eyeline references only — never obstacles
  for (const [id, q] of Object.entries(g.lookTargets)) entities.push({ entityId: `look:${id}`, kind: 'environment', bounds: pad(q, 0.3) });
  for (const a of Object.values(g.actors)) {
    const lt = a.lookTarget, q: Vec3 | null = !lt ? null : g.actors[lt] ? g.actors[lt].face.center : g.props[lt] ? [(g.props[lt]!.min[0] + g.props[lt]!.max[0]) / 2, (g.props[lt]!.min[1] + g.props[lt]!.max[1]) / 2, (g.props[lt]!.min[2] + g.props[lt]!.max[2]) / 2] : g.lookTargets[lt] ?? null;
    if (q) entities.push({ entityId: `eyeline:${a.id}`, kind: 'environment', bounds: pad(q, 0.05) });
  }
  const ids = Object.keys(g.actors).sort();
  const actors = ['zapp', 'kira'].filter((id) => g.actors[id]).map((id) => ({ id, position: g.actors[id].root, facing: [Math.sin(g.actors[id].yawDeg * DEG), 0, Math.cos(g.actors[id].yawDeg * DEG)] as Vec3, movement: g.actors[id].velocity }));
  // optional supporting actors are shot subjects only in wides; single-character coverage keeps them as obstacles
  // (collision / occlusion still apply) and records them as optional drops, never as required ones
  const subjects = [spec.active, ...spec.subjects.filter((s) => s !== spec.active && (spec.intent === 'wide' || spec.intent === 'scale_reveal' || !spec.optional.includes(s)))].filter((s) => ids.includes(s));
  return {
    frameWidth: W, frameHeight: H, subjectIds: subjects, optionalSubjectIds: spec.optional.filter((s) => s !== spec.active), heroPropIds: spec.heroProps.filter((id) => g.props[id]),
    obstacles: g.obstacles, projectedEntities: entities, activeSubjectId: spec.active, screenDirection: { ...(sd ?? {}), actors },
  };
}

/** candidate family per intent: vetted geometry-solved shots plus deterministic orbit/distance variants */
export function candidatesFor(scene: CameraSafetyScene, spec: ShotSpec, shotId: string, env?: ShotEnvelope, eyeline?: string | null): CameraCandidate[] {
  const base = spec.intent === 'scale_reveal' || spec.intent === 'offset_elevated_speaker_ots' || spec.intent === 'neutral_top_down_prop_insert' || spec.intent === 'elevated_consequence' ? [] : buildSafeFallbackCandidates(scene);
  const want: Record<CameraIntent, string[]> = {
    wide: ['elevated_wide', 'two_character_medium'], medium: spec.optional.length < spec.subjects.length - 1 ? ['two_character_medium', 'frontal_medium'] : ['frontal_medium', 'two_character_medium'],
    close: ['reaction_close', 'frontal_medium'], reaction: ['reaction_close', 'frontal_medium'], extreme_close: ['reaction_close'], prop: ['prop_insert', 'frontal_medium', 'elevated_wide'], over_shoulder: ['two_character_medium', 'frontal_medium'],
    three_quarter_profile: [], motivated_profile: [], scale_reveal: [], offset_elevated_speaker_ots: [], neutral_top_down_prop_insert: [], elevated_consequence: [],
  };
  const out: CameraCandidate[] = generatedCandidates(scene, spec, shotId, env, eyeline ?? null);
  for (const b of base.filter((x) => want[spec.intent].includes(x.fallback))) {
    const { fallback, ...c } = b;
    // the vetted solver assumes ~0.3 m heads; the blocky cast has 0.52 m heads + hair, so distance variants reach further
    const ks = fallback === 'elevated_wide' ? [1, 0.85, 0.7, 0.55, 0.45] : fallback === 'prop_insert' ? [1, 1.4, 1.8, 2.4, 3] : [1, 1.35, 1.7, 2.1, 2.5];
    for (const yaw of [0, -20, 20, -40, 40, -60, 60]) for (const k of ks) {
      const v = [c.transform.position[0] - c.target[0], c.transform.position[1] - c.target[1], c.transform.position[2] - c.target[2]];
      const cs = Math.cos(yaw * DEG), sn = Math.sin(yaw * DEG);
      const rv: Vec3 = [(v[0] * cs + v[2] * sn) * k, v[1] * k, (-v[0] * sn + v[2] * cs) * k];
      out.push({ ...c, id: `${shotId}:${fallback}:y${yaw}:d${k}`, transform: { position: [c.target[0] + rv[0], c.target[1] + rv[1], c.target[2] + rv[2]] }, requiresHeroProp: spec.requiresHeroProp && scene.heroPropIds.length > 0 });
    }
  }
  if (spec.excluded?.length || spec.strictHeadEdge || spec.twoShotPreset) for (const c of out) { if (spec.excluded?.length) c.excludedSubjectIds = [...spec.excluded]; if (spec.strictHeadEdge) c.partialHeadsBlocking = true; if (spec.twoShotPreset) c.readableFaceIds = spec.subjects.filter((x) => !spec.optional.includes(x)); }
  return out;
}

/**
 * Deterministic candidates sized from the POSED bounds: the camera orbits the subject (face-normal side and audience
 * side), at distances derived from the intent's head-height band (portrait 9:16) or from the content bounds (wide/prop).
 */
function generatedCandidates(scene: CameraSafetyScene, spec: ShotSpec, shotId: string, env?: ShotEnvelope, eyeline: string | null = null): CameraCandidate[] {
  const heads = new Map<string, Bounds3>(), bodies = new Map<string, Bounds3>();
  for (const o of scene.obstacles) {
    if (o.type === 'head' || o.type === 'hair') heads.set(o.entityId, union([o.bounds, ...(heads.has(o.entityId) ? [heads.get(o.entityId)!] : [])])!);
    if (o.type !== 'environment') bodies.set(o.entityId, union([o.bounds, ...(bodies.has(o.entityId) ? [bodies.get(o.entityId)!] : [])])!);
  }
  const ent = new Map((scene.projectedEntities ?? []).map((e) => [e.entityId, e]));
  const active = spec.active, ah = heads.get(active);
  if (!ah) return [];
  const c = (b: Bounds3): Vec3 => [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
  // head height from the ORIENTED head corners (the AABB of a yawed block head is up to ~40% taller on screen)
  const hcs = ent.get(active)?.headCorners;
  const hc = c(ah), headH = hcs?.length ? Math.max(...hcs.map((q) => q[1])) - Math.min(...hcs.map((q) => q[1])) : ah.max[1] - ah.min[1];
  const fn = ent.get(active)?.face?.normal ?? [0, 0, 1];
  const faceYaw = Math.atan2(fn[0], fn[2]) / DEG, prone = Math.abs(fn[1]) > 0.6;
  const out: CameraCandidate[] = [];
  const push = (kind: string, intent: CameraIntent, target: Vec3, yawDeg: number, dist: number, dy: number, fov: number, extra: Partial<CameraCandidate> = {}) => {
    const p: Vec3 = [target[0] + Math.sin(yawDeg * DEG) * dist, target[1] + dy, target[2] + Math.cos(yawDeg * DEG) * dist];
    out.push({ id: `${shotId}:${kind}:a${Math.round(yawDeg)}:d${dist.toFixed(2)}:h${dy.toFixed(2)}${extra.fov === undefined && fov !== 38 ? `:f${fov}` : ''}`, intent, transform: { position: p }, target, fov, activeSubjectId: active, requiresHeroProp: spec.requiresHeroProp && scene.heroPropIds.length > 0, ...(spec.propEdge ? { propEdgeIds: [...spec.propEdge] } : {}), ...(spec.propFull ? { propFullFrameIds: [...spec.propFull] } : {}), ...extra });
  };
  const yaws = [...new Set((prone ? [0, 25, -25, 50, -50] : [faceYaw, faceYaw + 15, faceYaw - 15, faceYaw + 35, faceYaw - 35, faceYaw + 60, faceYaw - 60, faceYaw + 75, faceYaw - 75, 0, 25, -25]).map((y) => Math.round(y)))];
  const tanV = (fov: number) => Math.tan((fov * DEG) / 2);
  const required = spec.subjects.filter((s) => !spec.optional.includes(s) && heads.has(s));
  if (spec.intent === 'medium' || spec.intent === 'reaction' || spec.intent === 'close' || spec.intent === 'over_shoulder') {
    const seated = ent.get(active)?.waistUpRequired === true || env?.actors[active]?.seated === true;
    const two = spec.intent !== 'reaction' && spec.intent !== 'close' && required.length >= 2;
    if (two) {
      const bh = heads.get(required.find((s) => s !== active)!)!, m: Vec3 = [(hc[0] + c(bh)[0]) / 2, (hc[1] + c(bh)[1]) / 2 - 0.3, (hc[2] + c(bh)[2]) / 2];
      const sep = Math.hypot(hc[0] - c(bh)[0], hc[2] - c(bh)[2]), axisYaw = Math.atan2(c(bh)[0] - hc[0], c(bh)[2] - hc[2]) / DEG;
      for (const frac of [0.15, 0.17, 0.2]) for (const off of [90, -90, 70, -70, 110, -110]) {
        const d = Math.max(headH / (frac * 2 * tanV(38)), (sep / 2 + 0.45) / (tanV(38) * (9 / 16) * 0.9));
        push('two_shot', 'medium', m, axisYaw + off, d, 0.15, 38, { framedSubjectIds: required.slice(0, 2) });
      }
      // beat preset two_shot: a wider orbit / height family, and BOTH faces must read (not only the active one)
      if (spec.twoShotPreset) for (const frac of [0.15, 0.17, 0.2]) for (const off of [50, -50, 130, -130, 30, -30, 150, -150]) for (const lift of [0.15, 0.5, 0.9]) {
        const d = Math.max(headH / (frac * 2 * tanV(38)), (sep / 2 + 0.45) / (tanV(38) * (9 / 16) * 0.9));
        push('two_shot', 'medium', m, axisYaw + off, d, lift, 38, { framedSubjectIds: required.slice(0, 2) });
      }
    }
    // a single that must keep another actor fully out of frame may also go tighter (still inside the intent's band)
    const fracs = seated ? [0.28, 0.32, 0.36] : spec.intent === 'medium' ? [0.21, 0.25, 0.29] : spec.excluded?.length ? [0.32, 0.4, 0.48, 0.56, 0.64] : [0.32, 0.4, 0.48];
    const waistY = env?.actors[active]?.waistY ?? 0;
    // implied_seated: aim high enough that the frame bottom (at the subject) clears the waist line by 12 cm
    const seatAim = (frac: number) => Math.max(hc[1] - headH * 0.15, waistY + 0.12 + headH / (frac * 2));
    const intent: CameraIntent = seated ? 'close' : spec.intent === 'over_shoulder' ? 'medium' : spec.intent;
    for (const frac of fracs) for (const y of yaws) for (const lift of seated ? [0, 0.15, 0.3] : [0.1, 0.6, 1.1, 2.0]) {
      const d = headH / (frac * 2 * tanV(38));
      const t: Vec3 = seated ? [hc[0], seatAim(frac), hc[2]] : intent === 'medium' ? [hc[0], hc[1] - headH * 0.55, hc[2]] : [hc[0], hc[1] - headH * 0.2, hc[2]];
      push(seated ? 'seated_close' : intent, intent, t, y, d, lift, 38);
    }
    // offset/elevated speaker OTS: above and to the side of the listener's shoulder, looking at the speaker's face
    const lh = spec.foreground ? heads.get(spec.foreground) : undefined;
    if (spec.pattern === 'speaker_ots' && lh && eyeline) {
      // anchored on the SWEPT shot envelope (whole head-shake interval), not on one sample frame
      const sw = (id: string) => env?.actors[id]?.headSwept;
      const L = c(sw(spec.foreground!) ?? lh), F = ent.get(active)?.face?.center ?? hc, H0 = c(sw(active) ?? ah);
      const bk = [L[0] - F[0], L[2] - F[2]], bl = Math.hypot(bk[0], bk[1]) || 1, back: Vec3 = [bk[0] / bl, 0, bk[1] / bl], side: Vec3 = [-back[2], 0, back[0]];
      // aim at the speaker's head centre so the head (incl. hair) sits inside the safe frame
      const tgt: Vec3 = [H0[0], H0[1] - 0.05, H0[2]];
      // side-offset shoulder positions, plus high near-axis positions that look down over the listener's head
      const offs: Array<[number, number, number]> = [];
      for (const up of [0, 0.1, 0.2, 0.35, 0.5, 0.7]) for (const sd of [0.55, 0.65, 0.75, 0.85, 0.95, 1.05, 1.15, 1.3, 1.6, 1.85]) for (const bb of [0, 0.15, 0.3, 0.4, 0.6, 0.9, 1.2]) offs.push([up, sd, bb]);
      for (const up of [1.3, 1.6, 1.9]) for (const sd of [0, 0.25, 0.5]) for (const bb of [0.8, 1.2, 1.6]) offs.push([up, sd, bb]);
      // moderately elevated three-quarter positions just above the listener's hair line (brim-safe pitch)
      for (const up of [0.9, 1.1]) for (const sd of [0.45, 0.65, 0.85]) for (const bb of [0.4, 0.8, 1.2]) offs.push([up, sd, bb]);
      for (const sgn of [1, -1]) for (const [up, sd, bb] of offs) {
        if (sd === 0 && sgn < 0) continue;
        const pos: Vec3 = [L[0] + back[0] * bb + side[0] * sd * sgn, Math.min(3.9, L[1] + up), L[2] + back[2] * bb + side[2] * sd * sgn];
        const dist = Math.hypot(pos[0] - tgt[0], pos[1] - tgt[1], pos[2] - tgt[2]);
        for (const [scaleBand, frac] of [['close', 0.3], ['close', 0.36], ['medium', 0.26]] as const) {
          const fov = Math.round(Math.max(28, Math.min(64, (2 * Math.atan(headH / (frac * 2 * dist))) / DEG)));
          out.push({ id: `${shotId}:speaker_ots:s${sgn}:u${up}:o${sd}:b${bb}:${scaleBand}${frac}`, intent: 'offset_elevated_speaker_ots', transform: { position: pos }, target: tgt, fov, activeSubjectId: active, requiresHeroProp: false, foregroundSubjectId: spec.foreground, eyelineTargetId: eyeline, profileScale: scaleBand });
        }
      }
    }
    // visible-face-side coverage for an actor whose face is turned to its eyeline target (listening / warning / the
    // off-screen teacher): explicit three-quarter / motivated-profile intents at the SAME head-size band (never lower)
    if (eyeline && !prone) {
      const scaleBand: 'medium' | 'close' = !seated && spec.intent === 'medium' ? 'medium' : 'close';
      const pf = seated ? [0.28, 0.32, 0.36] : scaleBand === 'medium' ? [0.2, 0.24, 0.28] : [0.3, 0.38, 0.46];
      // reference: the face direction averaged over the whole shot (a head shake oscillates around it)
      const ref = env?.actors[active]?.meanFaceYawDeg ?? faceYaw;
      for (const off of [35, 50, 65, 80]) for (const sgn of [1, -1]) for (const frac of pf) for (const lift of seated ? [0.05, 0.25] : [-0.1, 0.3]) {
        const pi: CameraIntent = off <= 45 ? 'three_quarter_profile' : 'motivated_profile';
        const d = headH / (frac * 2 * tanV(38));
        const t: Vec3 = seated ? [hc[0], seatAim(frac), hc[2]] : scaleBand === 'medium' ? [hc[0], hc[1] - headH * 0.5, hc[2]] : [hc[0], hc[1] - headH * 0.15, hc[2]];
        push(pi === 'three_quarter_profile' ? 'three_quarter' : 'profile', pi, t, ref + sgn * off, d, lift, 38, { profileScale: scaleBand, eyelineTargetId: eyeline });
      }
    }
  } else if (spec.intent === 'neutral_top_down_prop_insert') {
    // steep top-down insert over the hero prop only (small oblique allowed); no actor may enter the frame
    const hb = scene.heroPropIds.map((id) => bodies.get(id)).filter((b): b is Bounds3 => !!b)[0];
    if (!hb) return out;
    const pc = c(hb);
    for (const pitch of [55, 65, 75, 85]) for (const y of [0, 45, 90, 135, 180, 225, 270, 315]) for (const d of [0.95, 1.2, 1.5]) {
      const cp = Math.cos(pitch * DEG);
      const pos: Vec3 = [pc[0] + Math.sin(y * DEG) * cp * d, pc[1] + Math.sin(pitch * DEG) * d, pc[2] + Math.cos(y * DEG) * cp * d];
      out.push({ id: `${shotId}:top_down_insert:p${pitch}:a${y}:d${d}`, intent: 'neutral_top_down_prop_insert', transform: { position: pos }, target: pc, fov: 38, activeSubjectId: active, requiresHeroProp: true });
    }
  } else if (spec.intent === 'elevated_consequence') {
    // consequence geography from above: the fallen prop's emblem faces up, so pitch is prioritised (up to the ceiling)
    const refs = spec.scaleRefs ?? required, ids = [...new Set([...refs, ...scene.heroPropIds])];
    const content = union(ids.map((id) => env?.bounds[id] ?? bodies.get(id)).filter((b): b is Bounds3 => !!b));
    if (!content) return out;
    const cc = c(content), half = [(content.max[0] - content.min[0]) / 2, (content.max[1] - content.min[1]) / 2, (content.max[2] - content.min[2]) / 2];
    const rad = Math.hypot(half[0], half[1], half[2]);
    for (const fov of [52, 62]) for (const pitch of [24, 32, 40, 50, 60]) for (let y = 0; y < 360; y += 30) {
      const dFit = (rad * 1.02) / Math.tan((fov * DEG * (9 / 16)) / 2), dMax = (3.9 - cc[1]) / Math.sin(pitch * DEG);
      for (const d of [...new Set([Math.min(dFit, dMax), dMax * 0.9].map((x) => Math.round(x * 100) / 100))]) {
        if (d < 1.5) continue;
        const cp = Math.cos(pitch * DEG), pos: Vec3 = [cc[0] + Math.sin(y * DEG) * cp * d, cc[1] + Math.sin(pitch * DEG) * d, cc[2] + Math.cos(y * DEG) * cp * d];
        out.push({ id: `${shotId}:elevated_consequence:p${pitch}:a${y}:d${d.toFixed(2)}:f${fov}`, intent: 'elevated_consequence', transform: { position: pos }, target: cc, fov, activeSubjectId: active, requiresHeroProp: true, scaleReferenceIds: [...refs] });
      }
    }
  } else if (spec.intent === 'scale_reveal') {
    // giant-prop scale reveal: frame the SWEPT prop + scale actor(s); orbit around the identity-face normal so the
    // emblem and the thickness edge both read (15-78 deg off the face), low three-quarter / elevated corner / side comparison
    const refs = spec.scaleRefs ?? required;
    const idn = (scene.projectedEntities ?? []).find((e) => e.identity)?.identity;
    if (!idn) return out;
    const fn = idn.frontNormal, flat = Math.abs(fn[1]) > 0.7;
    const baseYaw = flat ? 0 : Math.atan2(fn[0], fn[2]) / DEG;
    const ids = [...new Set([...refs, ...scene.heroPropIds])];
    for (const vk of env?.moves ? ['sw', 'mid'] : ['mid']) {
      const content = union(ids.map((id) => (vk === 'sw' ? env?.bounds[id] : undefined) ?? bodies.get(id)).filter((b): b is Bounds3 => !!b));
      if (!content) continue;
      const cc = c(content), half = [(content.max[0] - content.min[0]) / 2, (content.max[1] - content.min[1]) / 2, (content.max[2] - content.min[2]) / 2];
      for (const fov of [42, 62]) for (const k of [0.95, 1.2]) for (const off of [0, 15, -15, 35, -35, 60, -60]) for (const el of flat ? [0.7, 1.2] : [0.1, 0.3, 0.55]) {
        const y = baseYaw + off, sy = Math.abs(Math.cos(y * DEG)) * half[0] + Math.abs(Math.sin(y * DEG)) * half[2];
        const dist = Math.max((sy * k + 0.3) / (tanV(fov) * (9 / 16)), (half[1] * k + 0.3) / tanV(fov)) + Math.max(half[0], half[2]) * 0.7;
        push(`scale_${vk}_f${fov}`, 'scale_reveal', cc, Math.round(y), dist, Math.min(dist * el, 3.9 - cc[1]), fov, { scaleReferenceIds: [...refs] });
      }
    }
  } else {
    // wide / prop: fit the content (required actors + hero props, or the prop alone) over the SWEPT shot envelope
    const ids = spec.intent === 'prop' ? (scene.heroPropIds.length ? [...scene.heroPropIds, ...(spec.optional.includes(active) ? [] : [active])] : [active]) : [...new Set([...required, active, ...scene.heroPropIds])];
    const allIds = spec.intent === 'wide' ? [...new Set([...ids, ...spec.subjects])] : ids;
    // content variants: mid-frame, swept required (the whole movement), swept incl. optional subjects (fully in frame)
    const variants: Array<[string, Bounds3 | null]> = [['', union(ids.map((id) => bodies.get(id)).filter((b): b is Bounds3 => !!b))]];
    if (env?.moves) variants.push(['sw', union(ids.map((id) => env.bounds[id] ?? bodies.get(id)).filter((b): b is Bounds3 => !!b))], ['swall', union(allIds.map((id) => env.bounds[id] ?? bodies.get(id)).filter((b): b is Bounds3 => !!b))]);
    const fovs = spec.intent === 'wide' ? (spec.propFull?.length || spec.pattern === 'impact_sequence' || (spec.requiresHeroProp && spec.heroProps.length) ? [42, 52, 62] : [42]) : [38];
    for (const fov of fovs) for (const [vk, content] of variants) {
      if (!content) continue;
      const cc = c(content), half = [(content.max[0] - content.min[0]) / 2, (content.max[1] - content.min[1]) / 2, (content.max[2] - content.min[2]) / 2];
      // wider-lens hero-prop wides: tighter fits (the depth addend is only a conservative bound; the evaluator decides)
      const tight = fov > 42 && spec.intent === 'wide';
      for (const k of spec.intent === 'wide' ? (tight ? [0.9, 1.05, 1.2] : [1.05, 1.2, 1.4]) : [1.3, 1.7, 2.2]) for (const y of spec.intent === 'prop' ? [0, 20, -20, 40, -40, 65, -65, faceYaw, faceYaw + 30, faceYaw - 30] : [0, 20, -20, 40, -40, faceYaw, faceYaw + 30, faceYaw - 30]) for (const el of [0.25, 0.45]) {
        const sy = Math.abs(Math.cos(y * DEG)) * half[0] + Math.abs(Math.sin(y * DEG)) * half[2];
        const dist = Math.max((sy * k + 0.3) / (tanV(fov) * (9 / 16)), (half[1] * k + 0.3) / tanV(fov)) + Math.max(half[0], half[2]) * (tight ? 0.4 : 1);
        push(`${spec.intent === 'wide' ? 'wide' : 'prop'}${vk}${fov === 42 || fov === 38 ? '' : `_f${fov}`}`, spec.intent, cc, Math.round(y), dist, Math.min(dist * el, 3.7 - cc[1]), fov);
      }
    }
  }
  return out;
}

/**
 * Second-tier neutral top-down inserts (used only when no standard insert is valid): a longer lens from further up so
 * an actor standing right behind the prop stays out of frame (the prop's supporting surface fills the frame edge) and
 * the lens keeps its head clearance.
 */
export function longLensInsertCandidates(scene: CameraSafetyScene, spec: ShotSpec, shotId: string): CameraCandidate[] {
  const hb = unionBoundsOf(scene, spec.heroProps.filter((id) => scene.heroPropIds.includes(id)))[0];
  if (!hb) return [];
  const pc: Vec3 = [(hb.min[0] + hb.max[0]) / 2, (hb.min[1] + hb.max[1]) / 2, (hb.min[2] + hb.max[2]) / 2], out: CameraCandidate[] = [];
  for (const pitch of [50, 60, 70, 80, 88]) for (let y = 0; y < 360; y += 30) for (const d of [1.2, 1.6, 2.2, 3]) for (const fov of [12, 16, 20, 26]) {
    const cp = Math.cos(pitch * DEG), pos: Vec3 = [pc[0] + Math.sin(y * DEG) * cp * d, pc[1] + Math.sin(pitch * DEG) * d, pc[2] + Math.cos(y * DEG) * cp * d];
    out.push({ id: `${shotId}:top_down_insert_long:p${pitch}:a${y}:d${d}:f${fov}`, intent: 'neutral_top_down_prop_insert', transform: { position: pos }, target: pc, fov, activeSubjectId: spec.active, requiresHeroProp: true });
  }
  return out;
}
function unionBoundsOf(scene: CameraSafetyScene, ids: string[]): Bounds3[] {
  return ids.map((id) => union(scene.obstacles.filter((o) => o.entityId === id).map((o) => o.bounds))).filter((b): b is Bounds3 => !!b);
}

export interface ShotCamera {
  id: string; intent: CameraIntent; kind: string; position: Vec3; target: Vec3; fovDeg: number;
  /** static: one transform for the whole shot; tracking: one deterministic transform per owned frame */
  motion: 'static' | 'tracking';
  /** tracking only: [px, py, pz, tx, ty, tz] for every frame of `IntegratedShot.frames` (first → last) */
  track?: number[][];
  trackSubject?: string;
  /** candidate fields the evaluator needs to reproduce the planning decision exactly at every frame */
  eval: { activeSubjectId: string; requiresHeroProp: boolean; framedSubjectIds?: string[]; profileScale?: 'medium' | 'close'; eyelineTargetId?: string; scaleReferenceIds?: string[]; foregroundSubjectId?: string; propEdgeIds?: string[]; propFullFrameIds?: string[]; excludedSubjectIds?: string[]; partialHeadsBlocking?: boolean; readableFaceIds?: string[] };
}
/** a camera choice for one planned shot: static candidate, or a tracking trajectory over the shot's frames */
interface Ranked { cand: CameraCandidate; minScore: number; results: CameraSafetyResult[]; track: TrackFrame[] | null; trackSubject?: string }
export interface TrackFrame { position: Vec3; target: Vec3 }

// ───────────────────────────── frame ownership / envelope ─────────────────────────────

/** canonical frame ownership: frame i belongs to the shot with start <= i/fps < end (first frame = ceil(start*fps)) */
export const firstFrameAt = (t: number, fps: number) => Math.max(0, Math.ceil(t * fps - 1e-6));
export function shotFrames(start: number, end: number, fps: number, N: number, last = false): [number, number] {
  const a = Math.min(N, Math.max(0, firstFrameAt(start, fps))), b = last ? N : Math.min(N, Math.max(a, firstFrameAt(end, fps)));
  return [a, b];
}

/** swept geometry of one shot interval (every owned frame): what a static camera must stay valid for */
export interface ShotEnvelope {
  frames: [number, number];
  bounds: Record<string, Bounds3>;
  actors: Record<string, { bodySwept: Bounds3; headSwept: Bounds3; rootStart: Vec3; rootEnd: Vec3; displacementM: number; maxStepM: number; movementDir: Vec3 | null; postures: string[]; lookTargets: string[]; meanFaceYawDeg: number; faceYawRangeDeg: number; seated: boolean; waistY: number }>;
  props: Record<string, { swept: Bounds3 | null; scale: [number, number] }>;
  interaction: Bounds3 | null;
  requiredFaceVisibility: number | null;
  headHeightRange: [number, number] | null;
  moves: boolean;
}
export function shotEnvelope(geos: FrameGeo[], a: number, b: number, spec: ShotSpec): ShotEnvelope {
  const fr = geos.slice(a, b), bounds: Record<string, Bounds3> = {}, actors: ShotEnvelope['actors'] = {}, props: ShotEnvelope['props'] = {};
  for (const id of Object.keys(fr[0].actors).sort()) {
    const bs = fr.map((g) => g.actors[id]).filter(Boolean);
    const body = union(bs.map((x) => union([x.body, x.head])!))!, head = union(bs.map((x) => x.head))!;
    let step = 0;
    for (let k = 1; k < bs.length; k++) step = Math.max(step, d3(bs[k].root, bs[k - 1].root));
    const r0 = bs[0].root, r1 = bs[bs.length - 1].root, disp = d2(r0, r1);
    let sx = 0, sz = 0;
    const yaws = bs.map((x) => { const n = x.face.normal, l = Math.hypot(n[0], n[2]) || 1; sx += n[0] / l; sz += n[2] / l; return Math.atan2(n[0], n[2]) / DEG; });
    const meanYaw = Math.atan2(sx, sz) / DEG, dev = Math.max(...yaws.map((y) => Math.abs(((y - meanYaw + 540) % 360) - 180)));
    actors[id] = { bodySwept: body, headSwept: head, rootStart: [...r0] as Vec3, rootEnd: [...r1] as Vec3, displacementM: r4(disp), maxStepM: r4(step), movementDir: disp > 0.02 ? [r4((r1[0] - r0[0]) / disp), 0, r4((r1[2] - r0[2]) / disp)] : null, postures: [...new Set(bs.map((x) => x.posture))], lookTargets: [...new Set(bs.map((x) => x.lookTarget ?? 'none'))], meanFaceYawDeg: r3(meanYaw), faceYawRangeDeg: r3(dev), seated: bs.some((x) => x.waistUp), waistY: r4(Math.max(...bs.map((x) => x.waistY))) };
    bounds[id] = body;
  }
  for (const id of PROP_OBSTACLES) {
    const bs = fr.map((g) => g.props[id]).filter((x): x is Bounds3 => !!x);
    props[id] = { swept: union(bs), scale: id === 'coin' ? [r4(Math.min(...fr.map((g) => g.coinScale))), r4(Math.max(...fr.map((g) => g.coinScale)))] : [1, 1] };
    if (bs.length) bounds[id] = union(bs)!;
  }
  const ints = fr.map((g) => g.interaction).filter((x): x is Vec3 => !!x).map((q) => pad(q, 0.05));
  const band = CAMERA_SAFETY_DEFAULTS.headHeight[spec.intent];
  const moves = Object.values(actors).some((x) => x.displacementM > 0.05) || Object.values(props).some((x) => x.scale[1] - x.scale[0] > 0.01);
  return { frames: [a, b], bounds, actors, props, interaction: union(ints), requiredFaceVisibility: spec.intent === 'wide' || spec.intent === 'prop' || spec.intent === 'scale_reveal' ? null : CAMERA_SAFETY_DEFAULTS.minFaceVisibility, headHeightRange: band[1] > 5 ? null : band, moves };
}

/** planning sample frames: first, last, events, mark arrivals/departures, pose/expression transitions, every <=100 ms */
export function planSampleFrames(plan: WorldPlan, a: number, b: number): number[] {
  const fps = plan.fps, set = new Set<number>([a, b - 1]);
  for (let k = a; k < b; k += CAMERA_SAMPLE_FRAMES) set.add(k);
  const at = (t: number) => { const k = firstFrameAt(t, fps); if (k >= a && k < b) set.add(k); if (k - 1 >= a && k - 1 < b) set.add(k - 1); };
  for (const e of plan.events) at(e.t);
  for (const act of Object.values(plan.actors)) for (const q of act.segs) { at(q.t0); at(q.t1); }
  for (const x of plan.instances) { at(x.t0); at(x.t1); }
  return [...set].sort((x, y) => x - y);
}

/** per-candidate planning trace (diagnostics only; never changes a decision) */
export interface CandidateTrace {
  id: string; intent: CameraIntent; samplesPassed: number; failedAtFrame: number | null; accepted: boolean; reasons: string[];
  metrics: { faceVisibilityMin: number | null; headHeightPctMin: number | null; heroPropVisibilityMin: number | null; foregroundClutter: number; lensClearanceM: number; screenDirection: string };
}
export interface ShotTrace { shotId: string; sampleFrames: number[]; spec: ShotSpec; candidatesAttempted: number; candidates: CandidateTrace[] }
function candidateMetrics(r: CameraSafetyResult, spec: ShotSpec): CandidateTrace['metrics'] {
  const req = r.diagnostics.requiredSubjects.filter((id) => r.faceVisibility[id] !== undefined);
  const hh = Object.values(r.diagnostics.requiredHeadHeightPct);
  const pv = spec.heroProps.map((id) => r.propVisibility[id]).filter((v) => v !== undefined);
  return {
    faceVisibilityMin: req.length ? Math.min(...req.map((id) => r.faceVisibility[id])) : null, headHeightPctMin: hh.length ? Math.min(...hh) : null,
    heroPropVisibilityMin: pv.length ? Math.min(...pv) : null, foregroundClutter: r.foregroundCoverage, lensClearanceM: r.lensClearance, screenDirection: r.screenDirectionResult,
  };
}

/** exported for tests / diagnostics: the deterministic tracking trajectory builder */
export const buildTrackingTrajectory = (seed: CameraCandidate, geos: FrameGeo[], a: number, b: number, subject: string, sd: ScreenDirectionState | undefined) => trackFrom(seed, geos, a, b, subject, sd);

function inCameraVolume(prod: Production, p: Vec3): boolean {
  const cs = prod.env.manifest.cameraSafe;
  return p[0] >= cs.min[0] && p[0] <= cs.max[0] && p[1] >= cs.min[1] && p[1] <= cs.max[1] && p[2] >= cs.min[2] && p[2] <= cs.max[2];
}

/** the eyeline entity of an actor: its current world look target, re-resolved at every frame */
const lookEntity = (g: FrameGeo, id: string): string | null => (g.actors[id]?.lookTarget ? `eyeline:${id}` : null);
/** candidate for frame k of a choice (static: the same transform; tracking: that frame's transform + the lens path) */
function candAtFrame(r: Pick<Ranked, 'cand' | 'track'>, k: number, a: number): CameraCandidate {
  if (!r.track) return r.cand;
  const f = r.track[k - a];
  return { ...r.cand, transform: { position: f.position }, target: f.target, ...(k > a ? { lensPath: [r.track[k - a - 1].position] } : {}) };
}
/** evaluate a choice on the listed frames (first owned frame carries the previous shot's screen direction) */
function evalFrames(r: Pick<Ranked, 'cand' | 'track'>, frames: number[], geos: FrameGeo[], spec: ShotSpec, W: number, H: number, sd: ScreenDirectionState | undefined, a: number, counter: { n: number }): { ok: boolean; results: CameraSafetyResult[]; failedAt: number | null } {
  const results: CameraSafetyResult[] = [];
  for (const k of frames) {
    const res = evaluateCameraCandidate(cameraScene(geos[k], spec, W, H, k === a ? sd : { ...sd, previousCameraSide: undefined }), candAtFrame(r, k, a)); counter.n++;
    results.push(res);
    if (!res.accepted) return { ok: false, results, failedAt: k };
  }
  return { ok: true, results, failedAt: null };
}

/**
 * Deterministic tracking trajectory from a static seed camera: the seed's offset from the subject anchor (active actor
 * head, or hero-prop centre) is kept, the anchor is smoothed with a centred moving average, and for a growing prop the
 * offset scales with the (smoothed) prop size (pull-back). Rejected if any per-frame lens/aim step exceeds
 * MAX_TRACK_STEP_M (no teleport) or the camera changes side of the action axis (screen direction).
 */
function trackFrom(seed: CameraCandidate, geos: FrameGeo[], a: number, b: number, subject: string, sd: ScreenDirectionState | undefined): { track: TrackFrame[] | null; reason: string | null } {
  const anchorAt = (g: FrameGeo): Vec3 | null => { const x = g.actors[subject]; if (x) return [(x.head.min[0] + x.head.max[0]) / 2, (x.head.min[1] + x.head.max[1]) / 2, (x.head.min[2] + x.head.max[2]) / 2]; const q = g.props[subject]; return q ? [(q.min[0] + q.max[0]) / 2, (q.min[1] + q.max[1]) / 2, (q.min[2] + q.max[2]) / 2] : null; };
  const sizeAt = (g: FrameGeo): number => { const q = g.props[subject]; return !g.actors[subject] && q ? Math.max(q.max[0] - q.min[0], q.max[1] - q.min[1], q.max[2] - q.min[2]) : 1; };
  const raw: Vec3[] = [], size: number[] = [];
  for (let k = a; k < b; k++) { const p = anchorAt(geos[k]); if (!p) return { track: null, reason: 'TRACK_SUBJECT_MISSING' }; raw.push(p); size.push(sizeAt(geos[k])); }
  const isProp = !geos[a].actors[subject], W = isProp ? 15 : TRACK_SMOOTH_FRAMES, n = raw.length;
  const sm = raw.map((_, k) => { let x = 0, y = 0, z = 0, m = 0, sz = 0; for (let j = Math.max(0, k - W); j <= Math.min(n - 1, k + W); j++) { x += raw[j][0]; y += raw[j][1]; z += raw[j][2]; sz += size[j]; m++; } return { p: [x / m, y / m, z / m] as Vec3, s: sz / m }; });
  const mid = Math.floor(n / 2), s0 = sm[mid].s;
  const off: Vec3 = [seed.transform.position[0] - sm[mid].p[0], seed.transform.position[1] - sm[mid].p[1], seed.transform.position[2] - sm[mid].p[2]];
  const aim: Vec3 = [seed.target[0] - sm[mid].p[0], seed.target[1] - sm[mid].p[1], seed.target[2] - sm[mid].p[2]];
  // growing prop: pull back with the square root of the size ratio (the prop grows on screen but stays framed)
  const track: TrackFrame[] = sm.map(({ p, s: sz }) => { const k = Math.max(0.4, Math.min(2.5, Math.pow(sz / s0, 0.35))); return { position: [r4(p[0] + off[0] * k), r4(p[1] + off[1] * k), r4(p[2] + off[2] * k)] as Vec3, target: [r4(p[0] + aim[0] * k), r4(p[1] + aim[1] * k), r4(p[2] + aim[2] * k)] as Vec3 }; });
  for (let k = 1; k < n; k++) if (d3(track[k].position, track[k - 1].position) > MAX_TRACK_STEP_M || d3(track[k].target, track[k - 1].target) > MAX_TRACK_STEP_M) return { track: null, reason: `TRACKING_STEP_TOO_LARGE:frame ${a + k}` };
  let side: string | null = null;
  for (let k = 0; k < n; k++) {
    const g = geos[a + k], acts = ['zapp', 'kira'].filter((id) => g.actors[id]).map((id) => ({ id, position: g.actors[id].root }));
    const sNow = cameraAxisSide({ ...(sd ?? {}), actors: acts }, track[k].position);
    if (sNow === 'left' || sNow === 'right') { if (side && sNow !== side) return { track: null, reason: `TRACKING_SCREEN_DIRECTION_FLIP:frame ${a + k}` }; side = sNow; }
  }
  return { track, reason: null };
}


/**
 * Plan one shot over its WHOLE interval: candidates are ranked on the planning samples (first/last/events/marks/pose
 * transitions/<=100 ms), then validated on EVERY owned frame; only fully valid candidates survive. If no static camera
 * survives and the subject moves (swept envelope), deterministic tracking candidates are generated and validated the
 * same way (plus the lens path between consecutive frames).
 */
/** near-identical framing to the previous coin shot (same lens position / aim / focal length within tolerance) */
const dupFraming = (c: CameraCandidate, avoid: CameraCandidate) => d3(c.transform.position, avoid.transform.position) < 0.9 && d3(c.target, avoid.target) < 0.7 && Math.abs(c.fov - avoid.fov) < 8;
function rankOverShot(prod: Production, plan: WorldPlan, geos: FrameGeo[], a: number, b: number, spec: ShotSpec, W: number, H: number, sd: ScreenDirectionState | undefined, shotId: string, trace?: ShotTrace[], avoid: CameraCandidate | null = null): { ranked: Ranked[]; rejections: Record<string, number>; evaluated: number; envelope: ShotEnvelope; tracking: string } {
  const env = shotEnvelope(geos, a, b, spec);
  const samples = planSampleFrames(plan, a, b), all = Array.from({ length: b - a }, (_, k) => a + k);
  const midK = samples[Math.floor(samples.length / 2)], mid = geos[midK];
  const eyeline = lookEntity(mid, spec.active);
  const cands = candidatesFor(cameraScene(mid, spec, W, H, sd), spec, shotId, env, eyeline).filter((c) => inCameraVolume(prod, c.transform.position));
  const rejections: Record<string, number> = {};
  const counter = { n: 0 };
  const tr: ShotTrace | undefined = trace ? { shotId, sampleFrames: samples, spec, candidatesAttempted: 0, candidates: [] } : undefined;
  const note = (r: Ranked | { cand: CameraCandidate; track: TrackFrame[] | null }, e: { ok: boolean; results: CameraSafetyResult[]; failedAt: number | null }, stage: string) => {
    if (!e.ok) for (const x of e.results[e.results.length - 1].rejectionReasons) { const k = x.split(':')[0]; rejections[k] = (rejections[k] ?? 0) + 1; }
    if (tr) { const last = e.results[e.results.length - 1]; tr.candidatesAttempted++; tr.candidates.push({ id: `${r.cand.id}${r.track ? ':tracking' : ''}@${stage}`, intent: r.cand.intent, samplesPassed: e.results.length - (e.ok ? 0 : 1), failedAtFrame: e.failedAt, accepted: e.ok, reasons: e.ok ? [] : last.rejectionReasons, metrics: candidateMetrics(last, spec) }); }
  };
  const run = (list: Array<{ cand: CameraCandidate; track: TrackFrame[] | null; trackSubject?: string }>): Ranked[] => {
    const sparse: Ranked[] = [];
    for (const r of list) {
      const e = evalFrames(r, [midK, ...samples.filter((k) => k !== midK)], geos, spec, W, H, sd, a, counter);
      if (!e.ok) { note(r, e, 'samples'); continue; }
      sparse.push({ ...r, minScore: Math.min(...e.results.map((x) => x.score)), results: e.results });
    }
    sparse.sort((x, y) => y.minScore - x.minScore || (x.cand.id < y.cand.id ? -1 : 1));
    // clean composition first: a candidate that leaves any visible head partially attached to the frame edge is used only
    // when no clean candidate is fully valid (stable partition keeps the score order within each group)
    { const partial = (r: Ranked) => r.results.some((x) => x.diagnostics.partialHeads.length > 0); const ok = sparse.filter((r) => !partial(r)), bad = sparse.filter(partial); sparse.splice(0, sparse.length, ...ok, ...bad); }
    // consecutive coin shots: a distinct framing is preferred; a near-duplicate is used only if nothing else is valid
    if (avoid) { const fresh = sparse.filter((r) => !dupFraming(r.cand, avoid)), dup = sparse.filter((r) => dupFraming(r.cand, avoid)); sparse.splice(0, sparse.length, ...fresh, ...dup); }
    const full: Ranked[] = [];
    for (const r of sparse) {
      if (full.length >= FULL_VALIDATED_PER_SHOT) break;
      const e = evalFrames(r, all, geos, spec, W, H, sd, a, counter);
      note(r, e, 'every-frame');
      if (e.ok) full.push({ ...r, minScore: Math.min(...e.results.map((x) => x.score)), results: e.results });
    }
    return full.sort((x, y) => y.minScore - x.minScore || (x.cand.id < y.cand.id ? -1 : 1));
  };
  const statics = cands.sort((x, y) => (x.id < y.id ? -1 : 1)).map((cand) => ({ cand, track: null }));
  let ranked = run(statics), tracking = 'not needed';
  if (!ranked.length && spec.intent === 'neutral_top_down_prop_insert') {
    ranked = run(longLensInsertCandidates(cameraScene(mid, spec, W, H, sd), spec, shotId).filter((c) => inCameraVolume(prod, c.transform.position)).map((cand) => ({ cand, track: null })));
    if (ranked.length) tracking = 'not needed (long-lens top-down insert: standard inserts invalid)';
  }
  if (!ranked.length && env.moves) {
    // static coverage failed on a moving subject: follow the active actor (or the growing hero prop for prop-led beats)
    const subject = (spec.intent === 'scale_reveal' || spec.intent === 'prop') && spec.heroProps.length && (env.props[spec.heroProps[0]]?.scale[1] ?? 1) - (env.props[spec.heroProps[0]]?.scale[0] ?? 1) > 0.01 ? spec.heroProps[0] : spec.active;
    const tracks: Array<{ cand: CameraCandidate; track: TrackFrame[]; trackSubject: string }> = [];
    const why: Record<string, number> = {};
    for (const { cand } of statics) {
      const t = trackFrom(cand, geos, a, b, subject, sd);
      if (!t.track) { const k = t.reason!.split(':')[0]; why[k] = (why[k] ?? 0) + 1; continue; }
      if (!t.track.every((f) => inCameraVolume(prod, f.position))) { why.TRACK_OUTSIDE_CAMERA_VOLUME = (why.TRACK_OUTSIDE_CAMERA_VOLUME ?? 0) + 1; continue; }
      tracks.push({ cand: { ...cand, id: `${cand.id}:track:${subject}`, transform: { position: t.track[0].position }, target: t.track[0].target }, track: t.track, trackSubject: subject });
    }
    ranked = run(tracks);
    tracking = ranked.length ? `tracking ${subject} (static failed on moving subject)` : `tracking attempted on ${subject}: ${tracks.length} trajectories, none valid${Object.keys(why).length ? ` (${Object.entries(why).map(([k, v]) => `${k}×${v}`).join(', ')})` : ''}`;
    for (const [k, v] of Object.entries(why)) rejections[k] = (rejections[k] ?? 0) + v;
  }
  if (tr) trace!.push(tr);
  return { ranked, rejections, evaluated: counter.n, envelope: env, tracking };
}

// ───────────────────────────── caption projection ─────────────────────────────

function projRect(cand: CameraCandidate, pts: Vec3[], W: number, H: number): Rect | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { const q = projectToScreen(cand, p, W / H); if (!(q.z > 0.05) || !Number.isFinite(q.x)) continue; x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); }
  if (!Number.isFinite(x0)) return null;
  return { x: x0 * W, y: y0 * H, w: Math.max(1, (x1 - x0) * W), h: Math.max(1, (y1 - y0) * H) };
}
const boxPts = (b: Bounds3): Vec3[] => [0, 1, 2, 3, 4, 5, 6, 7].map((k) => [k & 1 ? b.max[0] : b.min[0], k & 2 ? b.max[1] : b.min[1], k & 4 ? b.max[2] : b.min[2]] as Vec3);
function facePts(f: ActorGeo['face']): Vec3[] {
  const n = f.normal, up: Vec3 = [0, 1, 0];
  let r: Vec3 = [up[1] * n[2] - up[2] * n[1], up[2] * n[0] - up[0] * n[2], up[0] * n[1] - up[1] * n[0]];
  const l = Math.hypot(...r) || 1; r = [r[0] / l, r[1] / l, r[2] / l];
  const u: Vec3 = [n[1] * r[2] - n[2] * r[1], n[2] * r[0] - n[0] * r[2], n[0] * r[1] - n[1] * r[0]];
  return [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([a, b]) => [f.center[0] + r[0] * a * f.halfWidth + u[0] * b * f.halfHeight, f.center[1] + r[1] * a * f.halfWidth + u[1] * b * f.halfHeight, f.center[2] + r[2] * a * f.halfWidth + u[2] * b * f.halfHeight] as Vec3);
}
/** projected occupied regions of one posed frame through one camera (primary face, supporting face, hero prop, interaction, bodies) */
export function occupiedRegions(g: FrameGeo, spec: ShotSpec, cand: CameraCandidate, W: number, H: number): OccupiedRegion[] {
  const out: OccupiedRegion[] = [];
  for (const a of Object.values(g.actors)) {
    const isActive = a.id === spec.active, framed = spec.subjects.includes(a.id);
    const fr = projRect(cand, facePts(a.face), W, H);
    if (fr) out.push({ entityId: a.id, type: isActive ? 'primary_face' : 'supporting_face', rect: fr, importance: isActive ? 1 : 0.6 });
    const br = projRect(cand, boxPts(a.body), W, H);
    if (br) out.push({ entityId: a.id, type: 'body', rect: br, importance: isActive ? 0.8 : framed ? 0.4 : 0.2 });
  }
  for (const id of spec.heroProps) { const b = g.props[id]; if (!b) continue; const r = projRect(cand, boxPts(b), W, H); if (r) out.push({ entityId: id, type: 'hero_prop', rect: r, importance: 1 }); }
  // printed identity labels on hero props (e.g. FREE COINS) must stay readable: a caption may not cover them (hard)
  for (const id of spec.heroProps) for (const lb of g.labels?.[id] ?? []) { const r = projRect(cand, boxPts(lb), W, H); if (r) out.push({ entityId: `label:${id}`, type: 'interaction', rect: r, importance: 1 }); }
  if (g.interaction) { const r = projRect(cand, boxPts(pad(g.interaction, 0.05)), W, H); if (r) out.push({ entityId: `interaction:${g.interactionKind}`, type: 'interaction', rect: r, importance: 1 }); }
  return out;
}

// ───────────────────────────── camera / caption co-ordination ─────────────────────────────

/**
 * Pick one safe camera per shot of a caption chunk such that ONE caption band has no hard violation. Cameras are tried
 * in ranked order (odometer, last shot fastest); caption placement never changes a camera, it can only reject it.
 * No safe camera for a shot => camera blocked (null); every combination violating => CAPTION_CAMERA_COMPOSITION_BLOCKED.
 */
export function coordinateChunk<T>(lists: T[][], place: (choice: T[]) => CaptionPlacementResult, maxTries = 64): { chosen: T[] | null; placement: CaptionPlacementResult | null; retries: number; blocked: 'CAPTION_CAMERA_COMPOSITION_BLOCKED' | null } {
  if (!lists.length || !lists.every((l) => l.length)) return { chosen: null, placement: null, retries: 0, blocked: null };
  const idx = lists.map(() => 0);
  let first: CaptionPlacementResult | null = null, retries = 0;
  for (let guard = 0; guard < maxTries; guard++) {
    const choice = idx.map((k, j) => lists[j][k]);
    const res = place(choice);
    first ??= res;
    if (!res.violations.length) return { chosen: choice, placement: res, retries, blocked: null };
    retries++;
    let j = idx.length - 1;
    while (j >= 0 && idx[j] + 1 >= lists[j].length) { idx[j] = 0; j--; }
    if (j < 0) break;
    idx[j]++;
  }
  return { chosen: null, placement: first, retries, blocked: 'CAPTION_CAMERA_COMPOSITION_BLOCKED' };
}

// ───────────────────────────── integrated timeline ─────────────────────────────

export interface IntegratedShot { id: string; sourceShot: string; start: number; end: number; frames: [number, number]; phraseId: string; chunkId: string; spec: ShotSpec; camera: ShotCamera | null; coverage: 'single' | 'sequential_speaker' | 'sequential_listener' | 'growth_stage' | 'sequential_reaction' | 'sequential_insert' | 'consequence_subject' | 'consequence_elevated' | 'impact_tip' | 'impact_contact'; blocked: string | null; screenDirection: string; minScore: number | null; droppedOptional: string[];
  /** non-subject heads left partially attached to the frame edge by the chosen camera (union over every owned frame) */
  partialHeads: string[];
  /** max screen coverage of each character that is not a required subject of the shot (0 = fully out of frame) */
  offSubjectCoverage: Record<string, number>; cameraRejections: Record<string, number>; tracking: string; envelope: { moves: boolean; actors: Record<string, { displacementM: number; maxStepM: number; postures: string[] }>; coinScale: [number, number] } }
export type IntegratedCaption = CaptionEvent;
export interface IntegratedTimeline {
  schema: typeof INTEGRATED_TIMELINE_SCHEMA; storyboardId: string; storyboardSha256: string; audioHash: string; seed: number; fps: number; frames: number; width: number; height: number;
  shots: IntegratedShot[]; captions: IntegratedCaption[]; captionPlacements: Array<{ chunkId: string; band: string; centerY: number; violations: string[]; warnings: string[]; overlap: Record<string, number>; cameraRetries: number; blocked: string | null }>;
  sequentialCoverage: Array<{ sourceShot: string; phraseId: string; reason: string; split: [string, string] | null; outcome: string }>;
  /** reusable coverage patterns (prop_growth_sequence / reaction_then_insert / consequence_sequence) */
  coveragePatterns: Array<{ sourceShot: string; phraseId: string; pattern: string; segments: string[]; boundaries: number[]; outcome: string }>;
}

export interface IntegrationInput { sb: NarratedStoryboard; tl: NarratedTimeline; plan: WorldPlan; prod: Production; width: number; height: number; onProgress?: (stage: string, done: number, total: number) => void; trace?: ShotTrace[] }
export interface IntegrationResult { timeline: IntegratedTimeline; analysis: ReturnType<typeof analyze>; geos: FrameGeo[] }

export function integrateNarrated(inp: IntegrationInput): IntegrationResult {
  const { sb, tl, plan, prod, width: W, height: H } = inp;
  const ns = new NarratedScene(prod, plan), N = plan.frames, fps = plan.fps;
  // ---- pass 1: every frame through the adapter, in order (WorldState is the only transform writer) ----
  const geos: FrameGeo[] = [], diags: AdapterDiagnostics[] = [], worlds: WorldState[] = [];
  const hands: Array<{ t: number; gap: number }> = [];
  const boundary = new Set(tl.shots.map((s) => Math.round(s.start * fps)));
  const fresh = new NarratedEngineAdapter(); fresh.initialize(plan, prod);
  const resetDev: Array<{ frame: number; t: number; maxRootDevM: number; maxPropDevM: number }> = [];
  let prev: WorldState | null = null;
  for (let i = 0; i < N; i++) {
    let { world, diag } = ns.pose(i / fps, prev);
    if (boundary.has(i) && i > 0) {
      // shot-boundary reset probe: a fresh random-access evaluation must equal the sequential one exactly
      const f = fresh.applySnapshot(world, null, prod);
      let rd = 0, pd = 0;
      for (const [id, a] of Object.entries(diag.actors)) rd = Math.max(rd, d3(a.appliedRoot, f.actors[id].appliedRoot));
      for (const [id, q] of Object.entries(diag.props)) pd = Math.max(pd, d3(q.measuredPos, f.props[id].measuredPos));
      resetDev.push({ frame: i, t: r3(world.t), maxRootDevM: r4(rd), maxPropDevM: r4(pd) });
      ({ world, diag } = ns.pose(i / fps, prev)); // restore the sequential application (pure: identical transforms)
    }
    const g = extractFrameGeo(ns, i, world, diag);
    if (plan.button.pressT !== null && Math.abs(world.t - plan.button.pressT) <= 0.2 && g.actors.zapp) hands.push({ t: world.t, gap: Math.min(d3(g.actors.zapp.handR, plan.assets.button.pressSurface), d3(g.actors.zapp.handL, plan.assets.button.pressSurface)) });
    geos.push(g); diags.push(diag); worlds.push(world); prev = world;
    if (i % 300 === 0) inp.onProgress?.('pose', i, N);
  }
  // ---- pass 2+3: shots -> safe cameras, chunk by chunk with caption co-ordination ----
  const phrase = new Map(sb.script.phrases.map((p) => [p.id, p]));
  const shots: IntegratedShot[] = [], placements: IntegratedTimeline['captionPlacements'] = [], seq: IntegratedTimeline['sequentialCoverage'] = [], pats: IntegratedTimeline['coveragePatterns'] = [];
  const captions: IntegratedCaption[] = [];
  let sd: ScreenDirectionState | undefined;
  const lastSrc = tl.shots[tl.shots.length - 1];
  const framesOf = (s0: number, e0: number, last = false) => shotFrames(s0, e0, fps, N, last);
  const byPhraseIdx = new Map<string, number>(), resultCount = new Map<string, number>();
  const tcW = plan.coin.tip?.tc ?? null, contactFrame = tcW !== null ? firstFrameAt(tcW, fps) : null;
  const coinCam = (x: IntegratedShot | undefined) => (x && x.camera && x.spec.heroProps.includes('coin') ? cameraForFrame(x, x.frames[1] - 1) : null);
  const chunkIds = [...new Set(tl.shots.map((s) => s.chunkId))];
  let chunkNo = 0;
  const shotCam = (r: Ranked, spec: ShotSpec): ShotCamera => {
    const c = r.cand;
    return {
      id: c.id, intent: c.intent, kind: c.id.split(':')[1], position: (r.track ? r.track[0].position : c.transform.position).map(r4) as Vec3, target: (r.track ? r.track[0].target : c.target).map(r4) as Vec3, fovDeg: c.fov,
      motion: r.track ? 'tracking' : 'static', ...(r.track ? { track: r.track.map((f) => [...f.position, ...f.target].map(r4)), trackSubject: r.trackSubject } : {}),
      eval: { activeSubjectId: c.activeSubjectId ?? spec.active, requiresHeroProp: !!c.requiresHeroProp, ...(c.framedSubjectIds ? { framedSubjectIds: [...c.framedSubjectIds] } : {}), ...(c.profileScale ? { profileScale: c.profileScale } : {}), ...(c.eyelineTargetId ? { eyelineTargetId: c.eyelineTargetId } : {}), ...(c.scaleReferenceIds ? { scaleReferenceIds: [...c.scaleReferenceIds] } : {}), ...(c.foregroundSubjectId ? { foregroundSubjectId: c.foregroundSubjectId } : {}), ...(c.propEdgeIds ? { propEdgeIds: [...c.propEdgeIds] } : {}), ...(c.propFullFrameIds ? { propFullFrameIds: [...c.propFullFrameIds] } : {}), ...(c.excludedSubjectIds ? { excludedSubjectIds: [...c.excludedSubjectIds] } : {}), ...(c.partialHeadsBlocking ? { partialHeadsBlocking: true } : {}), ...(c.readableFaceIds ? { readableFaceIds: [...c.readableFaceIds] } : {}) },
    };
  };
  for (const chunkId of chunkIds) {
    inp.onProgress?.('cameras', chunkNo++, chunkIds.length);
    const src = tl.shots.filter((s) => s.chunkId === chunkId);
    const cap = tl.captions.find((c) => c.chunkId === chunkId)!;
    // build the shot list for this chunk (sequential coverage may split a source shot in two)
    type Plan = { id: string; sourceShot: string; start: number; end: number; frames: [number, number]; phraseId: string; spec: ShotSpec; coverage: IntegratedShot['coverage']; ranked: Ranked[]; rej: Record<string, number>; env: ShotEnvelope; tracking: string };
    const planned: Plan[] = [];
    let sdLocal = sd;
    for (const s of src) {
      const p = phrase.get(s.phraseId)!, k = byPhraseIdx.get(p.id) ?? 0; byPhraseIdx.set(p.id, k + 1);
      const isLast = s === lastSrc, fr = framesOf(s.start, s.end, isLast);
      const facts = windowFacts(plan, s.start, s.end, p.id === sb.script.phrases[0].id, isLast);
      facts.chunkNames = ['zapp', 'kira'].filter((n) => new RegExp(`\\b${n}\\b`, 'i').test(cap.lines.join(' ')));
      facts.safeBefore = plan.events.filter((e) => e.type === 'reached_safe' && e.t <= s.start + 1e-9).map((e) => e.source);
      facts.contactInShot = contactFrame !== null && contactFrame >= fr[0] && contactFrame < fr[1];
      facts.lastOfPhrase = tl.shots.filter((x) => x.phraseId === s.phraseId).at(-1) === s;
      if (p.actorRole === 'affected' && tcW !== null && s.start >= tcW - 1e-9) { facts.resultIdx = resultCount.get(p.id) ?? 0; resultCount.set(p.id, facts.resultIdx + 1); } else facts.resultIdx = null;
      let spec = shotSpec(p, facts, geos[Math.floor((fr[0] + fr[1] - 1) / 2)], k);
      // previous coin framing (previous planned shot of this chunk, else the last emitted shot) for de-duplication
      const avoidFor = (sp: ShotSpec): CameraCandidate | null => {
        if (!sp.heroProps.includes('coin')) return null;
        const q = planned[planned.length - 1];
        if (q) return q.spec.heroProps.includes('coin') && q.ranked[0] ? candAtFrame(q.ranked[0], q.frames[1] - 1, q.frames[0]) : null;
        return coinCam(shots[shots.length - 1]);
      };
      const segs = coverageSegments(geos, s.id, s.start, s.end, fr, spec, fps, contactFrame);
      if (segs) {
        let sdSeg = sdLocal;
        for (const g2 of segs) {
          const rr = rankOverShot(prod, plan, geos, g2.frames[0], g2.frames[1], g2.spec, W, H, sdSeg, g2.id, inp.trace, avoidFor(g2.spec));
          planned.push({ id: g2.id, sourceShot: s.id, start: g2.start, end: g2.end, frames: g2.frames, phraseId: s.phraseId, spec: g2.spec, coverage: g2.coverage, ranked: rr.ranked, rej: rr.rejections, env: rr.envelope, tracking: rr.tracking });
          if (rr.ranked[0]) sdSeg = nextScreenDirectionState(cameraScene(geos[g2.frames[1] - 1], g2.spec, W, H, sdSeg), candAtFrame(rr.ranked[0], g2.frames[1] - 1, g2.frames[0]));
        }
        const bad = planned.slice(-segs.length).filter((q) => !q.ranked.length).map((q) => q.id);
        pats.push({ sourceShot: s.id, phraseId: p.id, pattern: spec.pattern!, segments: segs.map((x) => x.id), boundaries: segs.slice(1).map((x) => x.frames[0]), outcome: bad.length ? `blocked: ${bad.join(', ')}` : 'accepted' });
        sdLocal = sdSeg;
        continue;
      }
      let rk = rankOverShot(prod, plan, geos, fr[0], fr[1], spec, W, H, sdLocal, s.id, inp.trace, avoidFor(spec));
      if (!rk.ranked.length && spec.singleFallback) { spec = spec.singleFallback; rk = rankOverShot(prod, plan, geos, fr[0], fr[1], spec, W, H, sdLocal, s.id, inp.trace, avoidFor(spec)); }
      const required = spec.subjects.filter((x) => !spec.optional.includes(x));
      if (rk.ranked.length || required.length < 2 || s.end - s.start < 2 * MIN_SHOT_SEC) {
        planned.push({ id: s.id, sourceShot: s.id, start: s.start, end: s.end, frames: fr, phraseId: s.phraseId, spec, coverage: 'single', ranked: rk.ranked, rej: rk.rejections, env: rk.envelope, tracking: rk.tracking });
        if (!rk.ranked.length && required.length >= 2) seq.push({ sourceShot: s.id, phraseId: p.id, reason: 'two required actors; no safe simultaneous camera', split: null, outcome: 'blocked: shot too short for sequential coverage' });
      } else {
        // sequential coverage inside the same interval (same caption/audio, same continuous world): speaker/active
        // first, listener/affected reaction second — each individually meets its own head-size and visibility rules
        const midT = r3((s.start + s.end) / 2), other = required.find((x) => x !== spec.active)!;
        const frA = framesOf(s.start, midT), frB = framesOf(midT, s.end, isLast);
        const a: ShotSpec = { ...spec, intent: spec.intent === 'wide' ? 'wide' : 'medium', subjects: [spec.active, other], optional: [other], ...(spec.intent === 'wide' ? {} : { pattern: 'speaker_ots' as const, foreground: other }), reason: `${spec.reason} — sequential 1/2: ${spec.active}` };
        const b: ShotSpec = { ...spec, intent: 'reaction', active: other, subjects: [other, spec.active], optional: [spec.active], heroProps: [], requiresHeroProp: false, reason: `${spec.reason} — sequential 2/2: ${other} reaction` };
        const ra = rankOverShot(prod, plan, geos, frA[0], frA[1], a, W, H, sdLocal, `${s.id}a`, inp.trace);
        const sdMid = ra.ranked[0] ? nextScreenDirectionState(cameraScene(geos[frA[1] - 1], a, W, H, sdLocal), candAtFrame(ra.ranked[0], frA[1] - 1, frA[0])) : undefined;
        const rb = rankOverShot(prod, plan, geos, frB[0], frB[1], b, W, H, sdMid, `${s.id}b`, inp.trace);
        const ok = ra.ranked.length > 0 && rb.ranked.length > 0;
        seq.push({ sourceShot: s.id, phraseId: p.id, reason: `two required actors (${spec.active}, ${other}); no readable simultaneous portrait medium (rejections: ${Object.entries(rk.rejections).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([k2, v]) => `${k2}×${v}`).join(', ') || 'none'})`, split: [`${s.id}a`, `${s.id}b`], outcome: ok ? 'sequential coverage accepted' : 'blocked: no safe sequential coverage' });
        planned.push({ id: `${s.id}a`, sourceShot: s.id, start: s.start, end: midT, frames: frA, phraseId: s.phraseId, spec: a, coverage: 'sequential_speaker', ranked: ra.ranked, rej: ra.rejections, env: ra.envelope, tracking: ra.tracking });
        planned.push({ id: `${s.id}b`, sourceShot: s.id, start: midT, end: s.end, frames: frB, phraseId: s.phraseId, spec: b, coverage: 'sequential_listener', ranked: rb.ranked, rej: rb.rejections, env: rb.envelope, tracking: rb.tracking });
      }
      const q = planned[planned.length - 1], best = q.ranked[0];
      if (best) sdLocal = nextScreenDirectionState(cameraScene(geos[q.frames[1] - 1], q.spec, W, H, sdLocal), candAtFrame(best, q.frames[1] - 1, q.frames[0]));
    }
    // caption co-ordination over EVERY frame of the chunk, each frame projected through the camera active at that frame
    const [ca, cb] = framesOf(cap.start, cap.end, cap === tl.captions[tl.captions.length - 1]);
    const owner = (k: number) => planned.findIndex((q) => k >= q.frames[0] && k < q.frames[1]);
    const tryPlace = (choice: Ranked[]): CaptionPlacementResult => {
      const frames = [];
      for (let k = ca; k < cb; k += CAPTION_SAMPLE_FRAMES) {
        const j = owner(k);
        if (j < 0) continue;
        frames.push({ time: k / fps, occupied: occupiedRegions(geos[k], planned[j].spec, candAtFrame(choice[j], k, planned[j].frames[0]), W, H) });
      }
      return placeCaption({ frameWidth: W, frameHeight: H, lines: cap.lines, chunkStart: cap.start, chunkEnd: cap.end, frames });
    };
    const co = coordinateChunk(planned.map((q) => q.ranked), tryPlace);
    const chosen = co.chosen, retries = co.retries, capBlocked = co.blocked;
    const pl = co.placement;
    placements.push({ chunkId, band: pl?.band ?? 'none', centerY: pl?.centerY ?? NaN, violations: pl?.violations ?? [], warnings: pl?.warnings ?? [], overlap: pl?.overlapMetrics ?? {}, cameraRetries: retries, blocked: capBlocked });
    captions.push(pl && !capBlocked && chosen ? { ...cap, lines: [...cap.lines], emphasisWords: [...cap.emphasisWords], placement: { centerY: pl.centerY } } : { ...cap, lines: [...cap.lines], emphasisWords: [...cap.emphasisWords] });
    planned.forEach((q, j) => {
      // a camera is kept only when its chunk has a hard-rule-safe caption band (no unresolved CAPTION_PLACEMENT_CONFLICT)
      const r = chosen ? chosen[j] : null;
      const sdRes = r ? evaluateCameraCandidate(cameraScene(geos[q.frames[0]], q.spec, W, H, sd), candAtFrame(r, q.frames[0], q.frames[0])).screenDirectionResult : 'n/a';
      shots.push({
        id: q.id, sourceShot: q.sourceShot, start: q.start, end: q.end, frames: q.frames, phraseId: q.phraseId, chunkId, spec: q.spec, coverage: q.coverage,
        camera: r ? shotCam(r, q.spec) : null,
        blocked: r ? null : q.ranked.length ? 'CAPTION_CAMERA_COMPOSITION_BLOCKED' : 'CAMERA_SAFETY_BLOCKED', screenDirection: sdRes, minScore: r ? r4(r.minScore) : null,
        droppedOptional: r ? [...new Set(r.results.flatMap((x) => x.diagnostics.droppedOptionalSubjects))].sort() : [], cameraRejections: q.rej, tracking: q.tracking,
        partialHeads: r ? [...new Set(r.results.flatMap((x) => x.diagnostics.partialHeads))].sort() : [],
        offSubjectCoverage: r ? Object.fromEntries(Object.keys(geos[q.frames[0]].actors).filter((id) => !q.spec.subjects.filter((x) => !q.spec.optional.includes(x) || x === q.spec.active).includes(id)).sort().map((id) => [id, r4(Math.max(0, ...r.results.map((x) => x.diagnostics.entityCoverage[id] ?? 0)))])) : {},
        envelope: { moves: q.env.moves, actors: Object.fromEntries(Object.entries(q.env.actors).map(([id, v]) => [id, { displacementM: v.displacementM, maxStepM: v.maxStepM, postures: v.postures }])), coinScale: q.env.props.coin?.scale ?? [0, 0] },
      });
      if (r) sd = nextScreenDirectionState(cameraScene(geos[q.frames[1] - 1], q.spec, W, H, sd), candAtFrame(r, q.frames[1] - 1, q.frames[0]));
    });
  }
  const timeline: IntegratedTimeline = { schema: INTEGRATED_TIMELINE_SCHEMA, storyboardId: sb.id, storyboardSha256: tl.storyboardSha256, audioHash: tl.audioHash, seed: sb.seed, fps, frames: N, width: W, height: H, shots, captions, captionPlacements: placements, sequentialCoverage: seq, coveragePatterns: pats };
  inp.onProgress?.('gates', 0, 1);
  const analysis = analyze({ sb, tl, plan, prod, W, H, geos, diags, worlds, timeline, hands, resetDev });
  return { timeline, analysis, geos };
}

// ───────────────────────────── analysis + blocking gates ─────────────────────────────

export interface Gate { id: string; group: 'world' | 'camera' | 'caption' | 'semantic'; name: string; pass: boolean; detail: string }

function quatAngleDeg(a: readonly number[], b: readonly number[]): number { const d = Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])); return (2 * Math.acos(d)) / DEG; }

function analyze(x: { sb: NarratedStoryboard; tl: NarratedTimeline; plan: WorldPlan; prod: Production; W: number; H: number; geos: FrameGeo[]; diags: AdapterDiagnostics[]; worlds: WorldState[]; timeline: IntegratedTimeline; hands: Array<{ t: number; gap: number }>; resetDev: Array<{ frame: number; t: number; maxRootDevM: number; maxPropDevM: number }> }) {
  const { plan, diags, worlds, geos, timeline, W, H } = x, fps = plan.fps, N = plan.frames, M = plan.assets.marks;
  const gates: Gate[] = [];
  const g = (id: string, group: Gate['group'], name: string, pass: boolean, detail: string) => gates.push({ id, group, name, pass, detail });
  const ev = (type: string) => plan.events.filter((e) => e.type === type).map((e) => e.t);
  // ---- world / motion ----
  const applied = diags.filter((d, i) => Math.abs(d.t - worlds[i].t) < 1e-9 && Object.values(d.actors).every((a) => a.rootDeviationM <= 1e-5)).length;
  const maxRootDev = Math.max(...diags.flatMap((d) => Object.values(d.actors).map((a) => a.rootDeviationM)));
  const unplanned = Math.max(...diags.map((d) => d.maxUnplannedDeltaM));
  const resetFlags = diags.filter((d) => d.transformResetByShot).length;
  const maxResetDev = Math.max(0, ...x.resetDev.map((r) => Math.max(r.maxRootDevM, r.maxPropDevM)));
  const kiraSafe = Math.min(...diags.map((d) => d.actors.kira ? d2(d.actors.kira.appliedRoot, M.kira_safe.pos) : Infinity));
  const zappImpact = Math.min(...diags.filter((d) => d.t <= (plan.coin.tip?.tc ?? Infinity)).map((d) => d2(d.actors.zapp.appliedRoot, M.zapp_impact.pos)));
  const jumpSeg = plan.actors.zapp.segs.find((s) => s.kind === 'jump');
  const jumpH = jumpSeg ? Math.max(...diags.filter((d) => d.t >= jumpSeg.t0 && d.t <= jumpSeg.t1).map((d) => d.actors.zapp.appliedRoot[1] - d.actors.zapp.groundOffsetM - jumpSeg.p0[1])) : 0;
  const pressGap = x.hands.length ? Math.min(...x.hands.map((h) => h.gap)) : Infinity, pressGapT = x.hands.find((h) => h.gap === pressGap)?.t ?? null;
  const growFrom = (plan.coin.stand?.t0 ?? Infinity) + 0.34, tipT0 = plan.coin.tip?.t0 ?? Infinity;
  const drift = diags.filter((d) => d.t >= growFrom && d.t < tipT0 - 1e-3 && d.props.coin?.lowestPoint).map((d) => d3(d.props.coin.lowestPoint!, plan.coin.base!));
  const coinDrift = drift.length ? Math.max(...drift) : 0;
  const onsets = diags.filter((d) => d.contacts.onsetThisFrame).map((d) => r3(d.t)), falls = diags.filter((d) => d.contacts.fallStartedThisFrame).map((d) => r3(d.t));
  const pen = diags.filter((d) => d.penetration.checked);
  const minGap = pen.length ? Math.min(...pen.map((d) => d.penetration.zappMinGapM ?? Infinity)) : Infinity;
  const minGapAt = pen.find((d) => d.penetration.zappMinGapM === minGap);
  const maxDepth = pen.length ? Math.max(...pen.map((d) => d.penetration.zappMaxDepthM)) : 0;
  const headInside = pen.some((d) => d.penetration.headInsideCoin);
  const kiraGap = pen.length ? Math.min(...pen.map((d) => d.penetration.kiraMinGapM ?? Infinity)) : Infinity;
  const tc = plan.coin.tip?.tc ?? null;
  const kiraAtContact = tc !== null ? diags[Math.min(N - 1, Math.ceil(tc * fps))].penetration.kiraMinGapM : null;
  const proneFrom = ev('patient_prone')[0] ?? Infinity;
  const notProne = worlds.filter((w) => w.t >= proneFrom + 1e-6 && w.actors.zapp.posture !== 'prone').map((w) => r3(w.t));
  const resetT = plan.button.resetT ?? Infinity;
  const stoodAfterReset = diags.filter((d) => d.t >= resetT && d.actors.zapp.posture !== 'prone').length;
  const coinThk = diags.filter((d) => d.props.coin?.visible && d.props.coin.thicknessM !== null).map((d) => d.props.coin.thicknessM! / Math.max(1e-9, d.props.coin.radiusM!));
  const thkDev = coinThk.length ? Math.max(...coinThk) - Math.min(...coinThk) : 0;
  const coinFinal = diags[N - 1].props.coin;
  let headStep = 0, headAng = 0, headStepAt = 0, headAngAt = 0;
  for (let i = 1; i < N; i++) for (const [id, a] of Object.entries(diags[i].actors)) {
    const p = diags[i - 1].actors[id];
    if (!p) continue;
    for (let k = 0; k < Math.min(a.headLocal.length, p.headLocal.length); k++) { const s = d3(a.headLocal[k], p.headLocal[k]); if (s > headStep) { headStep = s; headStepAt = diags[i].t; } }
    const ang = quatAngleDeg(a.headQuatLocal, p.headQuatLocal); if (ang > headAng) { headAng = ang; headAngAt = diags[i].t; }
  }
  const adapterBlocking = [...new Set(diags.flatMap((d) => d.blocking.map((b) => b.code)))];
  g('W01', 'world', 'WorldState applied at every sampled frame', applied === N, `${applied}/${N} frames, max root deviation ${maxRootDev} m`);
  g('W02', 'world', 'no unexplained actor/prop teleport', unplanned <= 1e-5, `max |applied - planned| per-frame delta ${unplanned} m`);
  g('W03', 'world', 'no shot-boundary transform reset', resetFlags === 0 && maxResetDev <= 1e-6, `${x.resetDev.length} boundaries probed, max deviation ${maxResetDev} m, reset flags ${resetFlags}`);
  g('W04', 'world', 'Kira reaches kira_safe', kiraSafe <= 0.02, `min distance ${r4(kiraSafe)} m (event ${ev('reached_safe')[0] ?? 'none'} s)`);
  g('W05', 'world', 'Zapp reaches zapp_impact', zappImpact <= 0.02, `min distance before contact ${r4(zappImpact)} m (event ${ev('reached_mark').find((t) => t < (tc ?? Infinity)) ?? 'none'} s)`);
  g('W06', 'world', 'jump has real vertical displacement', jumpH >= MIN_JUMP_M, `peak ${r4(jumpH)} m (>= ${MIN_JUMP_M})`);
  g('W07', 'world', 'press has valid hand/button contact', pressGap <= MAX_PRESS_HAND_GAP_M, `min hand/press-surface gap ${r4(pressGap)} m at ${pressGapT} s (<= ${MAX_PRESS_HAND_GAP_M})`);
  g('W08', 'world', 'coin base drift <= 0.01 m while growing', coinDrift <= MAX_COIN_BASE_DRIFT_M, `max drift ${r4(coinDrift)} m over ${drift.length} frames`);
  g('W09', 'world', 'exactly one coin/Zapp contact', onsets.length === 1, `contacts at ${onsets.join(', ') || 'none'} (planned ${tc !== null ? r3(tc) : 'none'})`);
  g('W10', 'world', 'fall begins on contact', onsets.length === 1 && falls.length === 1 && falls[0] === onsets[0], `fall start ${falls.join(', ') || 'none'}`);
  g('W11', 'world', 'no Zapp/coin penetration', maxDepth <= PENETRATION_TOLERANCE_M && !headInside && !adapterBlocking.includes('COIN_BODY_PENETRATION'), `max depth ${maxDepth} m, head inside ${headInside}`);
  g('W12', 'world', `actual posed Zapp/coin clearance >= ${MIN_COIN_CLEARANCE_M} m`, minGap >= MIN_COIN_CLEARANCE_M, `min ${minGap === Infinity ? 'n/a' : r4(minGap)} m at t=${minGapAt ? r3(minGapAt.t) : 'n/a'} (frame ${minGapAt ? Math.round(minGapAt.t * fps) : 'n/a'})`);
  g('W13', 'world', 'Kira outside the hazard', kiraGap > 0 && (kiraAtContact ?? Infinity) >= KIRA_HAZARD_MARGIN_M, `min Kira/coin gap ${r4(kiraGap)} m; at contact ${kiraAtContact === null ? 'n/a' : r4(kiraAtContact)} m (>= ${KIRA_HAZARD_MARGIN_M})`);
  g('W14', 'world', 'Zapp prone through episode end', notProne.length === 0 && worlds[N - 1].actors.zapp.posture === 'prone', `prone from ${proneFrom} s; non-prone frames after: ${notProne.length}`);
  g('W15', 'world', 'button reset does not stand Zapp up', stoodAfterReset === 0, `reset at ${plan.button.resetT} s; non-prone frames after reset ${stoodAfterReset}`);
  g('W16', 'world', `local head displacement <= ${MAX_HEAD_STEP_M} m/frame`, headStep <= MAX_HEAD_STEP_M, `max ${r4(headStep)} m at ${r3(headStepAt)} s`);
  g('W17', 'world', `local head angular change <= ${MAX_HEAD_STEP_DEG} deg/frame`, headAng <= MAX_HEAD_STEP_DEG, `max ${r3(headAng)} deg at ${r3(headAngAt)} s`);
  g('W18', 'world', 'coin keeps its thickness (uniform scale)', thkDev <= 1e-4 && !adapterBlocking.includes('NON_UNIFORM_PROP_SCALE'), `thickness/radius ratio spread ${thkDev.toExponential(2)} (diagnostics rounded to 1e-6 m); final thickness ${coinFinal?.thicknessM} m`);
  g('W19', 'world', 'no adapter blocking diagnostics', adapterBlocking.length === 0, adapterBlocking.join(', ') || 'none');
  // ---- camera: the chosen camera re-evaluated on the posed scene at EVERY frame ----
  // canonical frame ownership (the same ceil(start*fps) rule the planner and cameraAt use): every frame has one owner
  const ownerOf: number[] = new Array(N).fill(-1);
  const overlaps: number[] = [];
  timeline.shots.forEach((s, k) => { for (let i = s.frames[0]; i < s.frames[1]; i++) { if (ownerOf[i] >= 0) overlaps.push(i); ownerOf[i] = k; } });
  const gaps = ownerOf.map((o, i) => (o < 0 ? i : -1)).filter((i) => i >= 0);
  const fc = { totalFrames: N, assigned: N - gaps.length, withCamera: 0, evaluated: 0, passing: 0, failing: 0, firstFailingFrame: null as number | null, lastFailingFrame: null as number | null, failuresByShot: {} as Record<string, number>, gaps: gaps.slice(0, 20), gapCount: gaps.length, overlapCount: overlaps.length, ownership: 'frame i -> shot with start <= i/fps < end (first frame = ceil(start*fps)); last shot owns through the final frame', trackingFrames: 0 };
  const failFrame = (i: number, shot: string) => { fc.failing++; fc.firstFailingFrame ??= i; fc.lastFailingFrame = i; fc.failuresByShot[shot] = (fc.failuresByShot[shot] ?? 0) + 1; };
  const cam = { nonFaceMin: Infinity, collisions: 0, pathCollisions: 0, faceMin: Infinity, faceMinAt: 0, propMin: Infinity, propMinAt: 0, clutterMax: 0, clutterAt: 0, headCropped: 0, subjectSmall: 0, screenDir: 0, requiredDropped: 0, occlusion: 0, frames: 0, rejectedFrames: [] as Array<{ t: number; shot: string; reasons: string[] }>, headHeights: {} as Record<string, { min: number; max: number }> };
  let sdState: ScreenDirectionState | undefined, lastShot = '';
  for (let i = 0; i < N; i++) {
    if (ownerOf[i] < 0) { failFrame(i, 'unassigned'); continue; }
    const s = timeline.shots[ownerOf[i]];
    if (!s.camera) { failFrame(i, s.id); continue; }
    fc.withCamera++;
    const c = cameraForFrame(s, i);
    if (s.camera.motion === 'tracking') fc.trackingFrames++;
    const first = s.id !== lastShot;
    const sc = cameraScene(geos[i], s.spec, W, H, first ? sdState : { ...sdState, previousCameraSide: undefined });
    const r = evaluateCameraCandidate(sc, c);
    cam.frames++; fc.evaluated++;
    if (r.accepted) fc.passing++; else failFrame(i, s.id);
    const R = r.rejectionReasons.join(' ');
    if (/COLLISION|LENS/i.test(R) && !/PATH/i.test(R)) cam.collisions++;
    if (/PATH/i.test(R)) cam.pathCollisions++;
    if (/OCCLU/i.test(R)) cam.occlusion++;
    if (/HEAD_CROP|CROP/i.test(R)) cam.headCropped++;
    if (/TOO_SMALL|TOO_LARGE/i.test(R)) cam.subjectSmall++;
    if (/SCREEN_DIRECTION|reversed_unmotivated/i.test(R) || r.screenDirectionResult.startsWith('reversed_unmotivated')) cam.screenDir++;
    cam.requiredDropped += r.diagnostics.droppedRequiredSubjects.length ? 1 : 0;
    // faces are required only by face-carrying intents (medium/close/reaction/OTS/ECU/profile): prop inserts, wides and
    // scale reveals of a falling / walking / turned-away actor carry no face requirement (they still may not hide it)
    if (FACE_REQUIRED_INTENTS.has(c.intent)) for (const id of r.diagnostics.requiredSubjects) { const v = r.faceVisibility[id]; if (v !== undefined && v < cam.faceMin) { cam.faceMin = v; cam.faceMinAt = i / fps; } }
    else for (const id of r.diagnostics.requiredSubjects) { const v = r.faceVisibility[id]; if (v !== undefined && v < cam.nonFaceMin) cam.nonFaceMin = v; }
    for (const id of sc.heroPropIds) { const v = r.propVisibility[id]; if (v !== undefined && v < cam.propMin) { cam.propMin = v; cam.propMinAt = i / fps; } }
    if (r.foregroundCoverage > cam.clutterMax) { cam.clutterMax = r.foregroundCoverage; cam.clutterAt = i / fps; }
    for (const [id, hh] of Object.entries(r.diagnostics.requiredHeadHeightPct)) { const m = (cam.headHeights[`${s.spec.intent}:${id}`] ??= { min: Infinity, max: -Infinity }); m.min = Math.min(m.min, hh); m.max = Math.max(m.max, hh); }
    if (!r.accepted) cam.rejectedFrames.push({ t: r3(i / fps), shot: s.id, reasons: r.rejectionReasons.slice(0, 4) });
    if (first) lastShot = s.id;
    const nextIsNew = i + 1 >= N || ownerOf[i + 1] !== ownerOf[i];
    if (nextIsNew) sdState = nextScreenDirectionState(sc, c);
  }
  const blockedShots = timeline.shots.filter((s) => !s.camera);
  const seqBlocked = [...timeline.sequentialCoverage, ...timeline.coveragePatterns].filter((q) => q.outcome.startsWith('blocked'));
  const requiredInFrames = timeline.shots.every((s) => s.camera && s.spec.subjects.filter((q) => !s.spec.optional.includes(q)).every((q) => !s.droppedOptional.includes(q)));
  // every beat's required actors appear in at least one of its shots (sequential coverage splits them, never drops them)
  const bySource = new Map<string, IntegratedShot[]>();
  for (const s of timeline.shots) bySource.set(s.sourceShot, [...(bySource.get(s.sourceShot) ?? []), s]);
  g('C01', 'camera', 'no lens/body/head/hair/prop collision', cam.collisions === 0, `${cam.collisions} frames with lens collision over ${cam.frames} evaluated frames`);
  g('C02', 'camera', 'no camera path collision', cam.pathCollisions === 0, `${cam.pathCollisions} frames (static cameras: path = lens position)`);
  g('C03', 'camera', 'required face visibility threshold', cam.faceMin >= CAMERA_SAFETY_DEFAULTS.ecuMinFaceVisibility && cam.rejectedFrames.every((f) => !f.reasons.some((q) => /FACE/i.test(q))), `min required-face visibility ${cam.faceMin === Infinity ? 'n/a' : r3(cam.faceMin)} at ${r3(cam.faceMinAt)} s over face-carrying intents (floor ${CAMERA_SAFETY_DEFAULTS.ecuMinFaceVisibility}: motivated profile/ECU; 0.8 elsewhere per camera); wide/scale-reveal/prop min ${cam.nonFaceMin === Infinity ? 'n/a' : r3(cam.nonFaceMin)} (no face requirement)`);
  g('C04', 'camera', 'hero-prop visibility threshold', cam.propMin === Infinity || cam.propMin >= CAMERA_SAFETY_DEFAULTS.minHeroPropVisibility, `min hero-prop visibility ${cam.propMin === Infinity ? 'n/a' : r3(cam.propMin)} at ${r3(cam.propMinAt)} s`);
  g('C05', 'camera', 'foreground clutter <= 35%', cam.clutterMax <= CAMERA_SAFETY_DEFAULTS.maxForegroundCoverage, `max ${r3(cam.clutterMax)} at ${r3(cam.clutterAt)} s`);
  g('C06', 'camera', 'non-ECU head not cropped', cam.headCropped === 0, `${cam.headCropped} frames`);
  g('C07', 'camera', 'required subject size appropriate for intent', cam.subjectSmall === 0, `${cam.subjectSmall} frames outside the intent head-size band`);
  g('C08', 'camera', 'no unmotivated screen-direction reversal', cam.screenDir === 0, `${cam.screenDir} frames`);
  g('C09', 'camera', 'no required actor silently dropped', cam.requiredDropped === 0 && requiredInFrames && seqBlocked.length === 0, `${cam.requiredDropped} frames; sequential-coverage blocks ${seqBlocked.length}`);
  const covered = fc.assigned === N && fc.evaluated === N && fc.gapCount === 0 && fc.overlapCount === 0 && fc.failing === 0;
  g('C10', 'camera', 'no camera safety fallback failure (every frame assigned one camera and accepted)', blockedShots.length === 0 && cam.rejectedFrames.length === 0 && covered, blockedShots.length ? `${blockedShots.map((s) => `${s.blocked}: ${s.id}`).join(', ')}; frames ${fc.evaluated}/${N} evaluated` : `${fc.assigned}/${N} frames assigned, ${fc.evaluated}/${N} evaluated, ${fc.passing} passing, ${fc.failing} failing${cam.rejectedFrames[0] ? ` (first ${cam.rejectedFrames[0].t} s ${cam.rejectedFrames[0].shot}: ${cam.rejectedFrames[0].reasons.join('; ')})` : ''}`);
  g('C11', 'camera', 'head/face/prop occlusion', cam.occlusion === 0, `${cam.occlusion} frames with an occlusion rejection`);
  // ---- captions ----
  const pls = timeline.captionPlacements;
  const typed = timeline.captions.every((c) => typeof c.placement?.centerY === 'number' && Number.isFinite(c.placement.centerY));
  const inSafe = timeline.captions.every((c) => c.placement && c.placement.centerY >= 0.08 && c.placement.centerY <= 0.84);
  const faceMax = Math.max(0, ...pls.map((p) => p.overlap.primary_face_max ?? 0)), propMax = Math.max(0, ...pls.map((p) => p.overlap.hero_prop_max ?? 0));
  const inter = pls.filter((p) => (p.overlap.interaction_clearance_hit ?? 0) > 0 || p.violations.includes('INTERACTION')).length;
  const conflicts = pls.filter((p) => p.warnings.includes('CAPTION_PLACEMENT_CONFLICT') && p.violations.length), blocked = pls.filter((p) => p.blocked);
  const cap0 = x.tl.captions;
  const unchanged = cap0.length === timeline.captions.length && cap0.every((c, k) => { const d = timeline.captions[k]; return d.start === c.start && d.end === c.end && d.lines.join('|') === c.lines.join('|') && d.emphasisWords.join('|') === c.emphasisWords.join('|'); });
  g('K01', 'caption', 'placement declared in typed render data', typed, `${timeline.captions.filter((c) => c.placement).length}/${timeline.captions.length} chunks carry placement.centerY`);
  g('K02', 'caption', 'caption inside the safe area', inSafe && pls.every((p) => (p.overlap.bottom_ui_overlap_px ?? 0) === 0 && (p.overlap.edge_overflow_px ?? 0) === 0), `centres ${[...new Set(pls.map((p) => p.band))].join('/')}`);
  g('K03', 'caption', 'caption covers <= 8% of the primary face', faceMax <= PRIMARY_FACE_CAPTION_MAX, `max ${r4(faceMax)}`);
  g('K04', 'caption', 'caption avoids the interaction point', inter === 0, `${inter} chunks`);
  g('K05', 'caption', 'caption covers <= 50% of the hero prop', propMax <= HERO_PROP_CAPTION_MAX, `max ${r4(propMax)}`);
  g('K06', 'caption', 'caption stable through each chunk', timeline.captions.every((c) => !!c.placement), 'one placement per chunk (placeCaption: stableForWholeChunk)');
  g('K07', 'caption', 'no unresolved CAPTION_PLACEMENT_CONFLICT', conflicts.length === 0, conflicts.map((p) => p.chunkId).join(', ') || 'none');
  g('K08', 'caption', 'no CAPTION_CAMERA_COMPOSITION_BLOCKED', blocked.length === 0, blocked.map((p) => p.chunkId).join(', ') || 'none');
  g('K09', 'caption', 'caption text, line breaks, emphasis and timing unchanged', unchanged, `${cap0.length} chunks compared`);
  // ---- semantic ----
  const byGate = (id: string) => gates.find((q) => q.id === id)!.pass;
  const kiraMoved = d2(diags[0].actors.kira.appliedRoot, M.kira_safe.pos) >= 1.0 && byGate('W04');
  const kiraWalkShots = timeline.shots.filter((s) => s.spec.active === 'kira' && s.spec.intent === 'wide' && s.camera);
  const pressShots = timeline.shots.filter((s) => s.spec.heroProps.includes('button') && s.spec.intent === 'prop' && s.camera && plan.button.pressT !== null && plan.button.pressT >= s.start && plan.button.pressT < s.end);
  const jumpShot = jumpSeg ? timeline.shots.find((s) => s.camera && jumpSeg.t0 < s.end && jumpSeg.t1 > s.start && s.spec.intent === 'wide') : null;
  const tip = plan.coin.tip;
  const tipRot = tip ? diags.filter((d) => d.t >= tip.t0 && d.t <= tip.t1).map((d) => d.props.coin.rotDeg[0]) : [];
  const monotonic = tipRot.every((v, k) => !k || v >= tipRot[k - 1] - 1e-6);
  g('S01', 'semantic', '"jump" visibly moves vertically', byGate('W06') && !!jumpShot, `peak ${r4(jumpH)} m; covering wide ${jumpShot?.id ?? 'none'}`);
  g('S02', 'semantic', '"move safely" visibly changes Kira\'s location', kiraMoved && kiraWalkShots.length > 0, `Kira desk->safe ${r4(d2(diags[0].actors.kira.appliedRoot, M.kira_safe.pos))} m; shots ${kiraWalkShots.map((s) => s.id).join(', ') || 'none'}`);
  g('S03', 'semantic', '"press" shows reachable contact', byGate('W07') && pressShots.length > 0, `press shot ${pressShots.map((s) => s.id).join(', ') || 'none'}`);
  g('S04', 'semantic', '"grow" retains a fixed base', byGate('W08'), `drift ${r4(coinDrift)} m`);
  g('S05', 'semantic', '"tip" uses continuous rotation', tipRot.length > 2 && monotonic, `${tipRot.length} frames, ${r3(tipRot[0] ?? 0)} -> ${r3(tipRot[tipRot.length - 1] ?? 0)} deg, monotonic ${monotonic}`);
  g('S06', 'semantic', '"flatten/fall" has one visible contact and coherent end positions', byGate('W09') && byGate('W10') && byGate('W14') && timeline.shots.some((s) => s.camera && tc !== null && tc >= s.start && tc < s.end && s.spec.heroProps.includes('coin')), `contact ${onsets.join(', ')}; end Zapp ${worlds[N - 1].actors.zapp.posture}, coin ${coinFinal?.phase}`);
  g('S07', 'semantic', '"reset" preserves the consequence', byGate('W15') && coinFinal?.visible === true && worlds[N - 1].props.coin.phase === 'resting', `final coin ${worlds[N - 1].props.coin.phase} visible=${coinFinal?.visible}, Zapp ${worlds[N - 1].actors.zapp.posture}`);
  g('S08', 'semantic', 'no teacher character instantiated', !x.prod.rigs.has('teacher') && Object.keys(plan.actors).every((a) => a === 'zapp' || a === 'kira') && Object.values(plan.offscreen).every((o) => o.cues.length >= 0), `rigs: ${[...x.prod.rigs.keys()].join(', ')}`);
  const failed = gates.filter((q) => !q.pass).map((q) => q.id);
  const shotDur = timeline.shots.map((s) => s.end - s.start);
  return {
    schema: ANALYSIS_SCHEMA, frames: N, fps, resolution: [W, H], storyboardId: x.sb.id, audioHash: x.tl.audioHash,
    summary: { total: gates.length, passed: gates.length - failed.length, failed, blocking: failed.length > 0 },
    world: {
      framesApplied: applied, maxRootDeviationM: maxRootDev, maxUnplannedDeltaM: unplanned, shotResetDeviations: x.resetDev, maxShotResetDeviationM: maxResetDev,
      coinBaseDriftM: r4(coinDrift), contact: { count: onsets.length, times: onsets, planned: tc !== null ? r3(tc) : null, fallStart: falls },
      coinZappClearance: { minM: minGap === Infinity ? null : r4(minGap), t: minGapAt ? r3(minGapAt.t) : null, frame: minGapAt ? Math.round(minGapAt.t * fps) : null, maxDepthM: maxDepth, headInsideCoin: headInside, thresholdM: MIN_COIN_CLEARANCE_M },
      kira: { reachedSafeMinDistM: r4(kiraSafe), safeAt: ev('reached_safe')[0] ?? null, returnedDeskAt: ev('reached_mark').find((t) => t > (tc ?? 0)) ?? null, minHazardGapM: kiraGap === Infinity ? null : r4(kiraGap), hazardGapAtContactM: kiraAtContact === null ? null : r4(kiraAtContact), displacementDeskToSafeM: r4(d2(diags[0].actors.kira.appliedRoot, M.kira_safe.pos)) },
      zapp: { reachedImpactMinDistM: r4(zappImpact), jumpPeakM: r4(jumpH), pressHandGapM: r4(pressGap), pressHandGapT: pressGapT, finalPosture: worlds[N - 1].actors.zapp.posture, proneFrom, nonProneAfter: notProne.length },
      head: { maxLocalDisplacementM: r4(headStep), atT: r3(headStepAt), maxAngularDeltaDeg: r3(headAng), angularAtT: r3(headAngAt) },
      coinFinal: coinFinal ? { phase: worlds[N - 1].props.coin.phase, thicknessM: coinFinal.thicknessM, radiusM: coinFinal.radiusM, rotDeg: coinFinal.rotDeg } : null,
      adapterBlocking,
    },
    frameCoverage: fc,
    camera: { nonFaceIntentFaceVisibilityMin: cam.nonFaceMin === Infinity ? null : r3(cam.nonFaceMin), evaluatedFrames: cam.frames, collisions: cam.collisions, pathCollisions: cam.pathCollisions, occlusionFrames: cam.occlusion, faceVisibilityMin: r3(cam.faceMin), faceVisibilityMinAt: r3(cam.faceMinAt), heroPropVisibilityMin: cam.propMin === Infinity ? null : r3(cam.propMin), heroPropVisibilityMinAt: r3(cam.propMinAt), foregroundClutterMax: r3(cam.clutterMax), foregroundClutterAt: r3(cam.clutterAt), headCroppedFrames: cam.headCropped, subjectSizeFrames: cam.subjectSmall, screenDirectionViolations: cam.screenDir, requiredActorDropFrames: cam.requiredDropped, subjectHeadHeights: Object.fromEntries(Object.entries(cam.headHeights).map(([k, v]) => [k, { min: r4(v.min), max: r4(v.max) }])), rejectedFrames: cam.rejectedFrames.slice(0, 60), rejectedFrameCount: cam.rejectedFrames.length, blockedShots: blockedShots.map((s) => ({ id: s.id, spec: s.spec.reason, rejections: s.cameraRejections })) },
    captions: { chunks: pls.length, primaryFaceMax: r4(faceMax), heroPropMax: r4(propMax), interactionHits: inter, conflicts: conflicts.map((p) => p.chunkId), compositionBlocked: blocked.map((p) => p.chunkId), cameraRetries: pls.reduce((a, p) => a + p.cameraRetries, 0), bands: Object.fromEntries(['upper', 'middle', 'lower'].map((b) => [b, pls.filter((p) => p.band === b).length])) },
    shotTable: timeline.shots.map((s) => ({ id: s.id, start: s.start, end: s.end, frames: s.frames, intent: s.spec.intent, camera: s.camera?.id ?? null, screenDirection: s.screenDirection, partialHeads: s.partialHeads, offSubjectCoverage: s.offSubjectCoverage, blocked: s.blocked })),
    shots: { count: timeline.shots.length, meanSec: r3(shotDur.reduce((a, b) => a + b, 0) / shotDur.length), minSec: r3(Math.min(...shotDur)), maxSec: r3(Math.max(...shotDur)), sequentialCoverage: timeline.sequentialCoverage, coveragePatterns: timeline.coveragePatterns, requiredActorDrops: timeline.shots.filter((s) => !s.camera).length },
    gates,
  };
}

// ───────────────────────────── render-time camera ─────────────────────────────

/** the camera candidate of an integrated shot at owned frame i (static transform, or that frame's tracking transform) */
export function cameraForFrame(s: IntegratedShot, i: number): CameraCandidate {
  const c = s.camera!, e = c.eval;
  const base: CameraCandidate = { id: c.id, intent: c.intent, transform: { position: c.position }, target: c.target, fov: c.fovDeg, activeSubjectId: e.activeSubjectId, requiresHeroProp: e.requiresHeroProp, ...(e.framedSubjectIds ? { framedSubjectIds: e.framedSubjectIds } : {}), ...(e.profileScale ? { profileScale: e.profileScale } : {}), ...(e.eyelineTargetId ? { eyelineTargetId: e.eyelineTargetId } : {}), ...(e.scaleReferenceIds ? { scaleReferenceIds: e.scaleReferenceIds } : {}), ...(e.foregroundSubjectId ? { foregroundSubjectId: e.foregroundSubjectId } : {}), ...(e.propEdgeIds ? { propEdgeIds: e.propEdgeIds } : {}), ...(e.propFullFrameIds ? { propFullFrameIds: e.propFullFrameIds } : {}), ...(e.excludedSubjectIds ? { excludedSubjectIds: e.excludedSubjectIds } : {}), ...(e.partialHeadsBlocking ? { partialHeadsBlocking: true } : {}), ...(e.readableFaceIds ? { readableFaceIds: e.readableFaceIds } : {}) };
  if (c.motion !== 'tracking' || !c.track) return base;
  const k = Math.max(0, Math.min(c.track.length - 1, i - s.frames[0])), f = c.track[k], prev = k > 0 ? c.track[k - 1] : null;
  return { ...base, transform: { position: [f[0], f[1], f[2]] }, target: [f[3], f[4], f[5]], ...(prev ? { lensPath: [[prev[0], prev[1], prev[2]] as Vec3] } : {}) };
}

/** the integrated camera for frame time t (frame i = round(t*fps) -> its owning shot; cameras never touch the world) */
export function cameraAt(tl: Pick<IntegratedTimeline, 'shots' | 'fps'>, t: number): CameraState {
  const i = Math.round(t * tl.fps);
  const s = tl.shots.find((x) => i >= x.frames[0] && i < x.frames[1]) ?? tl.shots[tl.shots.length - 1];
  if (!s.camera) throw new Error(`CAMERA_SAFETY_BLOCKED: shot ${s.id} has no safe camera; refusing to render`);
  const c = cameraForFrame(s, i);
  return { pos: [...c.transform.position] as Vec3, target: [...c.target] as Vec3, fovY: c.fov * DEG };
}
