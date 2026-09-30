// Posed vignette scene -> camera-safety geometry (obstacles, face anchors, head corners, prop identity) and a
// line-of-sight visibility measure for the script coverage check. Generic over any set / cast / prop (the narrated
// extractor is classroom-specific); the rig rules are the narrated ones: head-bone parts belong to the head volume,
// the hair crown above the face is a separate 'hair' obstacle, visibility uses oriented part boxes.
import type { Bounds3, CameraObstacle, CameraSafetyScene, OrientedBox, ProjectedEntity, PropIdentity, ScreenDirectionState } from '../../engine/src/camera-safety.ts';
import type { Rig, PropInstance } from '../../engine/src/build.ts';
import type { Node } from '../../engine/src/gl/scene.ts';
import { DEG, m4TransformPoint, type Vec3 } from '../../engine/src/math.ts';
import type { CameraSubject } from '../../library/src/types.ts';
import type { PosedFrame, VignetteScene } from './scene.ts';

export interface ActorGeo {
  kind: 'character'; id: string; head: Bounds3; body: Bounds3; bounds: Bounds3; face: { center: Vec3; normal: Vec3; halfWidth: number; halfHeight: number };
  headCorners: Vec3[]; yawDeg: number; posture: string; waistUp: boolean; waistY: number; chest: Vec3; handR: Vec3;
  /** line-of-sight sample points (head corners + face + rig probes) */
  points: Vec3[]; headPoints: number;
}
export interface PropGeo { kind: 'prop'; id: string; bounds: Bounds3; identity: PropIdentity | null; points: Vec3[] }
export interface FrameGeometry { t: number; setId: string; beat: string; obstacles: CameraObstacle[]; actors: Record<string, ActorGeo>; props: Record<string, PropGeo>; interaction: Record<string, Vec3> }

// ---------------------------------------------------------------- node boxes (same math as the narrated extractor)
function nodeOBB(n: Node): OrientedBox | undefined {
  const h = n.geometry?.half;
  if (!h) return undefined;
  const w = n.world, col = (k: number): Vec3 => [w[k * 4], w[k * 4 + 1], w[k * 4 + 2]], l = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);
  const c = [col(0), col(1), col(2)], ls = c.map(l);
  if (ls.some((x) => x < 1e-9)) return undefined;
  return { center: [w[12], w[13], w[14]], axes: c.map((v, k) => [v[0] / ls[k], v[1] / ls[k], v[2] / ls[k]] as Vec3) as [Vec3, Vec3, Vec3], half: [h[0] * ls[0], h[1] * ls[1], h[2] * ls[2]] };
}
function nodeCorners(n: Node): Vec3[] {
  const h = n.geometry?.half;
  if (!h) return [];
  const out: Vec3[] = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) { const p = m4TransformPoint(n.world, [sx * h[0], sy * h[1], sz * h[2]]); out.push([p[0], p[1], p[2]]); }
  return out;
}
function nodeBox(n: Node): Bounds3 | null {
  const w = n.world;
  if (!n.geometry?.half || Math.hypot(w[0], w[1], w[2]) < 0.02) return null;
  return boundsOf(nodeCorners(n));
}
export function boundsOf(pts: Vec3[]): Bounds3 {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of pts) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]); }
  return { min, max };
}
const union = (bs: Bounds3[]): Bounds3 => ({ min: [0, 1, 2].map((k) => Math.min(...bs.map((b) => b.min[k]))) as Vec3, max: [0, 1, 2].map((k) => Math.max(...bs.map((b) => b.max[k]))) as Vec3 });
const center = (b: Bounds3): Vec3 => [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];

function rigGeo(id: string, rig: Rig, posture: string): { geo: ActorGeo; obs: CameraObstacle[] } {
  const obs: CameraObstacle[] = [], body: Bounds3[] = [], head: Bounds3[] = [], hair: Bounds3[] = [], headCorners: Vec3[] = [], hairNodes: Node[] = [];
  const f = rig.face.world, [hw, hh] = rig.manifest.body.headSize, nn = Math.hypot(f[8], f[9], f[10]) || 1;
  for (const m of rig.meshes) {
    if (!m.visible) continue;
    const b = nodeBox(m);
    if (!b) continue;
    const onHead = m.name === 'head_mesh' || m.parent?.name === 'neck';
    const ob = nodeOBB(m);
    obs.push({ entityId: id, type: onHead ? 'head' : 'body', bounds: b, ...(ob ? { oriented: ob } : {}) });
    (onHead ? head : body).push(b);
    if (onHead) headCorners.push(...nodeCorners(m));
    if (onHead && m.name !== 'head_mesh') { hair.push(b); hairNodes.push(m); }
  }
  const faceTop = rig.face.worldPos()[1] + (hh / 2) * Math.abs(f[5] / (Math.hypot(f[4], f[5], f[6]) || 1)) + 0.02;
  const crownParts = hair.filter((b) => b.max[1] > faceTop).map((b) => ({ min: [b.min[0], Math.max(b.min[1], faceTop), b.min[2]] as Vec3, max: b.max }));
  const upright = hairNodes.every((m) => { const ob = nodeOBB(m); return !ob || ob.axes.some((a) => Math.abs(a[1]) > 0.95); });
  if (crownParts.length) obs.push({ entityId: id, type: 'hair', bounds: union(crownParts), ...(upright ? { occludes: false } : {}) });
  if (crownParts.length && upright) for (const m of hairNodes) {
    const b = nodeBox(m), ob = nodeOBB(m);
    if (!b || !ob || b.max[1] <= faceTop) continue;
    const k = ob.axes.findIndex((a) => Math.abs(a[1]) > 0.95), ax = ob.axes[k], sgn = ax[1] > 0 ? 1 : -1;
    const t0 = Math.max(-ob.half[k], (faceTop - ob.center[1]) / (ax[1] * sgn)), t1 = ob.half[k];
    if (t1 <= t0) continue;
    const mid = (t0 + t1) / 2, half: Vec3 = [...ob.half] as Vec3; half[k] = (t1 - t0) / 2;
    obs.push({ entityId: id, type: 'hair', bounds: { min: [b.min[0], Math.max(b.min[1], faceTop), b.min[2]], max: b.max }, oriented: { center: [ob.center[0] + ax[0] * sgn * mid, ob.center[1] + ax[1] * sgn * mid, ob.center[2] + ax[2] * sgn * mid], axes: ob.axes, half } });
  }
  const hips = rig.joints.hips.worldPos(), neck = rig.joints.neck.worldPos(), fc = rig.face.worldPos();
  const probes = rig.probes.map((p) => p.worldPos());
  const hb = union(head.length ? head : body), bb = union(body.length ? body : head);
  return {
    obs,
    geo: {
      kind: 'character', id, head: hb, body: bb, bounds: union([hb, bb]), face: { center: fc, normal: [f[8] / nn, f[9] / nn, f[10] / nn], halfWidth: (hw / 2) * 0.9, halfHeight: (hh / 2) * 0.9 },
      headCorners, yawDeg: Math.atan2(f[8], f[10]) / DEG, posture, waistUp: posture === 'implied_seated', waistY: hips[1] + 0.05, chest: [(hips[0] + neck[0]) / 2, (hips[1] + neck[1]) / 2, (hips[2] + neck[2]) / 2], handR: rig.hand_r.worldPos(),
      points: [...headCorners.slice(0, 8), fc, ...probes], headPoints: Math.min(8, headCorners.length) + 1,
    },
  };
}

/** identity landmarks: the coin disc (emblem face) or a box prop's audience-facing face */
function propIdentity(inst: PropInstance): PropIdentity | null {
  const parts = Object.values(inst.parts).filter((n) => n.geometry && !n.decal && n.visible);
  if (!parts.length) return null;
  const disc = inst.manifest.collision.shape === 'cylinder' ? parts[0] : undefined;
  if (disc?.geometry) {
    const m = disc.world, h = disc.geometry.half, col = (k: number): Vec3 => [m[k * 4], m[k * 4 + 1], m[k * 4 + 2]], l = (v: Vec3) => Math.hypot(v[0], v[1], v[2]) || 1;
    const ax0 = col(1), R = h[0] * l(col(0)), th = h[1] * l(ax0);
    let ax: Vec3 = [ax0[0] / l(ax0), ax0[1] / l(ax0), ax0[2] / l(ax0)];
    if (ax[1] * 0.447 + ax[2] * 0.894 < 0) ax = [-ax[0], -ax[1], -ax[2]];
    const c: Vec3 = [m[12], m[13], m[14]], u0 = col(0), u: Vec3 = [u0[0] / l(u0), u0[1] / l(u0), u0[2] / l(u0)];
    const v: Vec3 = [ax[1] * u[2] - ax[2] * u[1], ax[2] * u[0] - ax[0] * u[2], ax[0] * u[1] - ax[1] * u[0]];
    const rim: Vec3[] = Array.from({ length: 12 }, (_, k) => { const a = (k / 12) * 2 * Math.PI; return [c[0] + R * (u[0] * Math.cos(a) + v[0] * Math.sin(a)), c[1] + R * (u[1] * Math.cos(a) + v[1] * Math.sin(a)), c[2] + R * (u[2] * Math.cos(a) + v[2] * Math.sin(a))] as Vec3; });
    const base = rim.reduce((b, p) => (p[1] < b[1] ? p : b), rim[0]);
    return { center: c, frontNormal: ax, emblem: [c[0] + ax[0] * th, c[1] + ax[1] * th, c[2] + ax[2] * th], rim, base: [base[0], Math.max(base[1], 0.01), base[2]] };
  }
  // box prop: the root's local +z face (turned toward the audience) is the identity face
  const b = union(parts.map((n) => nodeBox(n)).filter(Boolean) as Bounds3[]);
  const w = inst.root.world, zl = Math.hypot(w[8], w[9], w[10]) || 1;
  let n: Vec3 = [w[8] / zl, w[9] / zl, w[10] / zl];
  if (n[2] < 0) n = [-n[0], -n[1], -n[2]];
  const c = center(b), hx = (b.max[0] - b.min[0]) / 2, hy = (b.max[1] - b.min[1]) / 2, hz = (b.max[2] - b.min[2]) / 2;
  const depth = Math.abs(n[0]) * hx + Math.abs(n[2]) * hz, lat = Math.abs(n[2]) * hx + Math.abs(n[0]) * hz;
  const r: Vec3 = [n[2], 0, -n[0]];
  const emblem: Vec3 = [c[0] + n[0] * depth, c[1], c[2] + n[2] * depth];
  const rim: Vec3[] = [];
  for (const [a, e] of [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]]) rim.push([emblem[0] + r[0] * lat * a, c[1] + hy * e, emblem[2] + r[2] * lat * a]);
  return { center: c, frontNormal: n, emblem, rim, base: [c[0], Math.max(b.min[1], 0.01), c[2]] };
}

export function frameGeometry(scene: VignetteScene, f: PosedFrame): FrameGeometry {
  const obstacles: CameraObstacle[] = [], actors: Record<string, ActorGeo> = {}, props: Record<string, PropGeo> = {};
  for (const c of f.set.colliders) if (c.id !== 'floor') obstacles.push({ entityId: `env:${c.id}`, type: 'environment', bounds: { min: [...c.min] as Vec3, max: [...c.max] as Vec3 } });
  for (const [id, rig] of scene.rigs) {
    if (!rig.root.visible) continue;
    const g = rigGeo(id, rig, f.world.actors[id]?.posture ?? 'standing');
    actors[id] = g.geo; obstacles.push(...g.obs);
  }
  for (const [id, p] of scene.props) {
    if (!p.inst.root.visible || (p.setId && p.setId !== f.set.id)) continue;
    const bs: Bounds3[] = [], pts: Vec3[] = [];
    for (const n of Object.values(p.inst.parts)) {
      if (!n.geometry || n.decal || !n.visible) continue;
      const b = nodeBox(n);
      if (!b) continue;
      const ob = nodeOBB(n);
      bs.push(b); obstacles.push({ entityId: id, type: 'prop', bounds: b, ...(ob ? { oriented: ob } : {}) });
      const cs = nodeCorners(n); pts.push(center(b), ...cs.map((q) => [q[0] * 0.9 + center(b)[0] * 0.1, q[1] * 0.9 + center(b)[1] * 0.1, q[2] * 0.9 + center(b)[2] * 0.1] as Vec3));
    }
    if (!bs.length) continue;
    const identity = propIdentity(p.inst);
    props[id] = { kind: 'prop', id, bounds: union(bs), identity, points: identity && p.inst.manifest.collision.shape === 'cylinder' ? [identity.center, identity.emblem, ...identity.rim.map((q) => [q[0] * 0.92 + identity.center[0] * 0.08, q[1] * 0.92 + identity.center[1] * 0.08, q[2] * 0.92 + identity.center[2] * 0.08] as Vec3)] : pts };
  }
  // causal interaction points: the press contact window (hand -> press surface), the coin / patient contact
  const interaction: Record<string, Vec3> = {};
  const W = scene.plan.world, btn = scene.plan.adapter.propInstances.button, coin = scene.plan.adapter.propInstances.coin;
  if (btn && W.button.pressT !== null && f.t >= W.button.pressT - 0.35 && f.t <= W.button.pressT + 0.25) interaction[btn] = [...W.assets.button.pressSurface] as Vec3;
  if (btn && W.button.resetT !== null && f.t >= W.button.resetT - 0.05 && f.t <= W.button.resetT + 0.4) interaction[btn] = [...W.assets.button.pressSurface] as Vec3;
  const tip = W.coin.tip, pat = scene.plan.world.instances.find((x) => x.contract === 'tip_coin_onto')?.params.patient as string | undefined;
  if (coin && tip && pat && actors[pat] && f.t >= tip.tc - 0.35 && f.t <= tip.t1) interaction[coin] = actors[pat].chest;
  return { t: f.t, setId: f.set.id, beat: f.beat.phraseId, obstacles, actors, props, interaction };
}

/** CameraSubject (library contract) of an entity at this frame */
export function subjectOf(g: FrameGeometry, id: string): CameraSubject | undefined {
  const a = g.actors[id];
  if (a) { const b = a.bounds, c = center(b); return { center: c, head: a.face.center, top: [c[0], b.max[1], c[2]], bottom: [c[0], b.min[1], c[2]], radius: Math.max(b.max[0] - b.min[0], b.max[2] - b.min[2], 0.5) / 2, facingYaw: a.yawDeg }; }
  const p = g.props[id];
  if (p) { const b = p.bounds, c = center(b); return { center: c, top: [c[0], b.max[1], c[2]], bottom: [c[0], b.min[1], c[2]], radius: Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) / 2, ...(p.identity ? { facingYaw: Math.atan2(p.identity.frontNormal[0], p.identity.frontNormal[2]) / DEG } : {}) }; }
  return undefined;
}

export interface SafetySpec { active: string; subjects: string[]; optional: string[]; heroProps: string[]; screenDirection?: ScreenDirectionState; waistUp: boolean }
export function safetyScene(g: FrameGeometry, spec: SafetySpec, W: number, H: number): CameraSafetyScene {
  const entities: ProjectedEntity[] = [];
  for (const a of Object.values(g.actors)) entities.push({ entityId: a.id, kind: 'character', face: a.face, facing: [Math.sin(a.yawDeg * DEG), 0, Math.cos(a.yawDeg * DEG)], headCorners: a.headCorners, ...(spec.waistUp && a.waistUp ? { waistUpRequired: true, waistY: a.waistY } : {}) });
  for (const id of spec.heroProps) { const p = g.props[id]; if (p) entities.push({ entityId: id, kind: 'prop', bounds: p.bounds, ...(p.identity ? { identity: p.identity } : {}), ...(g.interaction[id] ? { interactionPoint: g.interaction[id] } : {}) }); }
  const present = (id: string) => !!g.actors[id] || !!g.props[id];
  const subjects = spec.subjects.filter(present);
  const actorsIn = Object.values(g.actors).filter((a) => subjects.includes(a.id));
  return {
    frameWidth: W, frameHeight: H, subjectIds: subjects, optionalSubjectIds: spec.optional.filter(present), heroPropIds: spec.heroProps.filter((id) => !!g.props[id]), obstacles: g.obstacles, projectedEntities: entities, activeSubjectId: present(spec.active) ? spec.active : subjects[0],
    ...(spec.screenDirection && actorsIn.length >= 2 ? { screenDirection: { ...spec.screenDirection, actors: actorsIn.map((a) => ({ id: a.id, position: [(a.body.min[0] + a.body.max[0]) / 2, 0, (a.body.min[2] + a.body.max[2]) / 2] as Vec3, facing: [Math.sin(a.yawDeg * DEG), 0, Math.cos(a.yawDeg * DEG)] as Vec3 })) } } : {}),
  };
}

// ---------------------------------------------------------------- visibility (script coverage)
export interface CamPose { pos: Vec3; target: Vec3; fovDeg: number; roll?: number }
interface Basis { pos: Vec3; f: Vec3; r: Vec3; u: Vec3; tanV: number; tanH: number }
function basis(c: CamPose, aspect: number): Basis {
  const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], nrm = (v: Vec3): Vec3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
  const f = nrm(sub(c.target, c.pos));
  let r = nrm([f[1] * 0 - f[2] * 1, f[2] * 0 - f[0] * 0, f[0] * 1 - f[1] * 0]);
  if (!isFinite(r[0]) || Math.hypot(...r) < 1e-6) r = [1, 0, 0];
  let u: Vec3 = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  const a = (c.roll ?? 0) * DEG;
  if (a) { const cs = Math.cos(a), s = Math.sin(a); const r2: Vec3 = [r[0] * cs + u[0] * s, r[1] * cs + u[1] * s, r[2] * cs + u[2] * s]; u = [u[0] * cs - r[0] * s, u[1] * cs - r[1] * s, u[2] * cs - r[2] * s]; r = r2; }
  const tanV = Math.tan((c.fovDeg * DEG) / 2);
  return { pos: c.pos, f, r, u, tanV, tanH: tanV * aspect };
}
export function projectPoint(b: Basis, p: Vec3): { x: number; y: number; z: number } {
  const d: Vec3 = [p[0] - b.pos[0], p[1] - b.pos[1], p[2] - b.pos[2]], z = d[0] * b.f[0] + d[1] * b.f[1] + d[2] * b.f[2];
  if (z <= 0.05) return { x: NaN, y: NaN, z };
  return { x: 0.5 + ((d[0] * b.r[0] + d[1] * b.r[1] + d[2] * b.r[2]) / (z * b.tanH)) / 2, y: 0.5 - ((d[0] * b.u[0] + d[1] * b.u[1] + d[2] * b.u[2]) / (z * b.tanV)) / 2, z };
}
function rayHits(o: CameraObstacle, org: Vec3, d: Vec3): boolean {
  const slab = (lo: Vec3, ld: Vec3, min: Vec3, max: Vec3) => {
    let t0 = 1e-4, t1 = 1 - 1e-3;
    for (let i = 0; i < 3; i++) {
      if (Math.abs(ld[i]) < 1e-12) { if (lo[i] < min[i] || lo[i] > max[i]) return false; continue; }
      let a = (min[i] - lo[i]) / ld[i], c = (max[i] - lo[i]) / ld[i];
      if (a > c) [a, c] = [c, a];
      t0 = Math.max(t0, a); t1 = Math.min(t1, c);
      if (t0 > t1) return false;
    }
    return true;
  };
  if (!slab(org, d, o.bounds.min, o.bounds.max)) return false;
  const ob = o.oriented;
  if (!ob) return true;
  const r: Vec3 = [org[0] - ob.center[0], org[1] - ob.center[1], org[2] - ob.center[2]];
  const dt = (v: Vec3, a: Vec3) => v[0] * a[0] + v[1] * a[1] + v[2] * a[2];
  return slab([dt(r, ob.axes[0]), dt(r, ob.axes[1]), dt(r, ob.axes[2])], [dt(d, ob.axes[0]), dt(d, ob.axes[1]), dt(d, ob.axes[2])], [-ob.half[0], -ob.half[1], -ob.half[2]], [ob.half[0], ob.half[1], ob.half[2]]);
}

export interface Visibility { points: number; inFrame: number; visible: number; headVisible: boolean; screenHeight: number; visibleFrac: number; ok: boolean }
/**
 * Line-of-sight visibility of an entity from a camera: sample points inside the frame (2 % margin) that no OTHER
 * entity's part (or the set) hides. A character reads when a head point is seen, or >= 25 % of its body points, with
 * >= 4 % of frame height on screen; a prop when >= 25 % of its points are seen and it spans >= 2 % of the frame.
 */
export function visibilityOf(g: FrameGeometry, cam: CamPose, aspect: number, id: string, extraPoints?: Vec3[]): Visibility {
  const a = g.actors[id], p = g.props[id];
  const pts = extraPoints ?? a?.points ?? p?.points ?? [];
  const b = basis(cam, aspect);
  let inF = 0, vis = 0, headVis = false, y0 = Infinity, y1 = -Infinity, x0 = Infinity, x1 = -Infinity;
  pts.forEach((q, k) => {
    const s = projectPoint(b, q);
    if (!(s.z > 0.05) || s.x < 0.02 || s.x > 0.98 || s.y < 0.02 || s.y > 0.98) return;
    inF++;
    const d: Vec3 = [q[0] - cam.pos[0], q[1] - cam.pos[1], q[2] - cam.pos[2]];
    if (g.obstacles.some((o) => o.entityId !== id && o.occludes !== false && rayHits(o, cam.pos, d))) return;
    vis++; if (a && k < a.headPoints) headVis = true;
    y0 = Math.min(y0, s.y); y1 = Math.max(y1, s.y); x0 = Math.min(x0, s.x); x1 = Math.max(x1, s.x);
  });
  const screenHeight = vis ? Math.max(y1 - y0, a ? 0 : x1 - x0) : 0, frac = pts.length ? vis / pts.length : 0;
  const ok = a ? (headVis || frac >= 0.25) && screenHeight >= 0.04 : frac >= 0.25 && screenHeight >= 0.02;
  return { points: pts.length, inFrame: inF, visible: vis, headVisible: headVis, screenHeight: Math.round(screenHeight * 1e4) / 1e4, visibleFrac: Math.round(frac * 1e4) / 1e4, ok };
}

/** projected height (fraction of frame height) of a point set seen from a camera pose (points behind the lens ignored) */
export function projectedHeightFrac(cam: CamPose, pts: Vec3[], aspect: number): number {
  const b = basis(cam, aspect);
  let y0 = Infinity, y1 = -Infinity;
  for (const p of pts) { const s = projectPoint(b, p); if (!(s.z > 0.05)) continue; y0 = Math.min(y0, s.y); y1 = Math.max(y1, s.y); }
  return isFinite(y0) ? y1 - y0 : 0;
}

/** normalised screen position of a world point from a camera pose */
export function projectPointFrom(cam: CamPose, p: Vec3, aspect: number): { x: number; y: number; z: number } { return projectPoint(basis(cam, aspect), p); }
