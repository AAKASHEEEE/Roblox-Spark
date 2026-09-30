// LibraryTrack: plays library actions (registry.ts) on a rig. It has the same model as the engine's ActorTrack (which is
// byte-frozen for the Visual Comedy path): root-motion segments with trapezoid travel, arrival facing, holds / blends,
// additive layers, look-at (yaw then pitch), arm IK and grounding. On top of that it adds library travel windows
// (door transits), squash & stretch (ActionPose.scale) and LibActionCtx (root + body proportions for the poses).
// A pure function of t: random access and sequential playback give identical results.
import type { Joint, Rig } from '../../build.ts';
import { JOINTS } from '../../build.ts';
import { DEG, add, clamp, hashSeed, noise1, qConj, qEuler, qFromMat, qMul, qRotate, qSlerp, sub, type Quat, type Vec3 } from '../../math.ts';
import { IDLE_POSE, idleLayer } from '../actions.ts';
import { LOOK_LIMITS, solveArmIk, type PointResolver } from '../animator.ts';
import { blendAction, type ActionPose } from '../pose.ts';
import { libActionDef, type ActionResolver } from './registry.ts';
import type { LibActionCtx, LibActionDef } from './types.ts';

export interface LibTrackAction { actor?: string; action: string; start: number; duration: number; to?: string; target?: string; params?: Record<string, number | string | boolean> }
export interface LibSegment { a: LibTrackAction; def: LibActionDef; start: number; end: number; fromPos: Vec3; toPos: Vec3; dist: number; fromYaw: number; travelYaw: number; endYaw: number; run: boolean }
export interface LibDiag { handError?: number; stance?: 'l' | 'r'; grounded: boolean; scale: Vec3 }
export interface LibRootOverride { pos: Vec3; yaw: number }

const yawTo = (a: Vec3, b: Vec3): number => Math.atan2(b[0] - a[0], b[2] - a[2]) / DEG;
const wrap = (d: number): number => { let x = ((d + 180) % 360 + 360) % 360 - 180; if (x === -180) x = 180; return x; };
const lerpAngle = (a: number, b: number, t: number): number => a + wrap(b - a) * t;
const smooth01 = (x: number): number => { const c = clamp(x, 0, 1); return c * c * (3 - 2 * c); };
/** trapezoid travel (same profile as ActorTrack): distance and speed at local time lt of a d-second move */
function travel(lt: number, d: number, dist: number): { s: number; v: number } {
  if (dist <= 1e-6 || d <= 1e-6) return { s: lt >= d ? dist : 0, v: 0 };
  const ta = Math.min(0.25, d * 0.25), v = dist / (d - ta);
  if (lt <= 0) return { s: 0, v: 0 };
  if (lt >= d) return { s: dist, v: 0 };
  if (lt < ta) return { s: (0.5 * v * lt * lt) / ta, v: (v * lt) / ta };
  if (lt < d - ta) return { s: 0.5 * v * ta + v * (lt - ta), v };
  const r = d - lt;
  return { s: dist - (0.5 * v * r * r) / ta, v: (v * r) / ta };
}
function rotInv(q: Quat, v: Vec3): Vec3 { const c = qConj(q), p = qMul(qMul(c, [v[0], v[1], v[2], 0]), q); return [p[0], p[1], p[2]]; }

export class LibraryTrack {
  readonly segs: LibSegment[] = [];
  readonly layers: Array<{ a: LibTrackAction; def: LibActionDef }> = [];
  readonly seed: number;
  readonly id: string;
  readonly rig: Rig;
  private readonly res: PointResolver;
  private readonly startPos: Vec3;
  private readonly startYaw: number;
  constructor(id: string, rig: Rig, actions: LibTrackAction[], startPos: Vec3, startYaw: number, res: PointResolver, episodeSeed: number, defs: ActionResolver = libActionDef) {
    this.id = id; this.rig = rig; this.res = res; this.startPos = startPos; this.startYaw = startYaw;
    this.seed = (hashSeed(id) ^ episodeSeed) >>> 0;
    const all = actions.filter((a) => a.actor === undefined || a.actor === id).sort((x, y) => x.start - y.start);
    let pos = startPos;
    for (const a of all) {
      const def = defs(a.action);
      if (!def) throw new Error(`action ${a.action} not in the library`);
      if (def.layer) { this.layers.push({ a, def }); continue; }
      const to = def.locomotion && a.to ? res.point(a.to, a.start) : undefined;
      const toPos: Vec3 = to ? [to[0], 0, to[2]] : pos;
      this.segs.push({ a, def, start: a.start, end: a.start + a.duration, fromPos: pos, toPos, dist: Math.hypot(toPos[0] - pos[0], toPos[2] - pos[2]), fromYaw: 0, travelYaw: 0, endYaw: 0, run: !!def.run });
      pos = toPos;
    }
    // yaw pass: travel heading, arrival facing applied as an in-place turn after the stop, explicit turns to targets
    let yaw = startYaw, pending: number | undefined;
    for (const s of this.segs) {
      s.fromYaw = yaw;
      const tgt = s.a.target ? res.point(s.a.target, s.start) : undefined;
      if (s.def.locomotion && s.dist > 0.05) { s.travelYaw = s.endYaw = yawTo(s.fromPos, s.toPos); pending = s.a.to ? res.markFacing(s.a.to) : undefined; }
      else if ((s.a.action === 'turn_toward' || s.a.params?.turn === true) && tgt) { s.travelYaw = s.endYaw = yawTo(s.fromPos, tgt); pending = undefined; }
      else { s.travelYaw = s.endYaw = pending ?? yaw; pending = undefined; }
      yaw = s.endYaw;
    }
  }

  segAt(t: number): { cur?: LibSegment; prev?: LibSegment } {
    let cur: LibSegment | undefined, prev: LibSegment | undefined;
    for (const s of this.segs) { if (t >= s.start && t < s.end) cur = s; else if (s.end <= t) prev = s; }
    return { cur, prev };
  }

  rootAt(t: number): { pos: Vec3; yaw: number; speed: number; dist: number } {
    const { cur, prev } = this.segAt(t);
    if (!cur) {
      if (!prev) return { pos: this.segs[0]?.fromPos ?? this.startPos, yaw: this.segs[0]?.fromYaw ?? this.startYaw, speed: 0, dist: 0 };
      return { pos: prev.toPos, yaw: prev.endYaw, speed: 0, dist: prev.dist };
    }
    const lt = t - cur.start, d = cur.end - cur.start;
    if (cur.def.locomotion && cur.dist > 0.05) {
      const w = cur.def.travelWindow;
      const tl = w ? clamp(lt - w[0] * d, 0, (w[1] - w[0]) * d) : lt, td = w ? (w[1] - w[0]) * d : d;
      const { s, v } = travel(tl, td, cur.dist), f = s / cur.dist;
      return { pos: [cur.fromPos[0] + (cur.toPos[0] - cur.fromPos[0]) * f, 0, cur.fromPos[2] + (cur.toPos[2] - cur.fromPos[2]) * f], yaw: lerpAngle(cur.fromYaw, cur.travelYaw, smooth01(tl / 0.2)), speed: v, dist: s };
    }
    return { pos: cur.fromPos, yaw: lerpAngle(cur.fromYaw, cur.endYaw, smooth01(lt / Math.min(d, 0.35))), speed: 0, dist: 0 };
  }

  /** ctx the segment's pose / cues see at t */
  ctxAt(s: LibSegment, t: number, rootOverride?: LibRootOverride): LibActionCtx {
    const d = s.end - s.start, lt = clamp(t - s.start, 0, d), computedRoot = this.rootAt(Math.min(t, s.end - 1e-4));
    const root = rootOverride ? { ...computedRoot, ...rootOverride } : computedRoot;
    const r = this.rig.dims;
    return {
      lt, d, u: lt / d, t, seed: this.seed, target: s.a.target ? this.res.point(s.a.target, t) : undefined, params: s.a.params ?? {},
      loco: { dist: t >= s.end ? s.dist : computedRoot.dist, speed: t >= s.end ? 0 : computedRoot.speed, run: s.run, legLen: r.legLen, total: s.dist },
      root: { pos: root.pos, yaw: root.yaw },
      body: { legLen: r.legLen, torsoH: r.torsoH, headH: r.headH, headD: this.rig.manifest.body.headSize[2], upperArm: r.upperArm, lowerArm: r.lowerArm, shoulderX: r.shoulderX, shoulderY: r.shoulderY },
    };
  }
  /** the body action (and its ctx) at t: the current segment, else the last one (holding / releasing) */
  activeAt(t: number, rootOverride?: LibRootOverride): { s: LibSegment; c: LibActionCtx } | undefined {
    const { cur, prev } = this.segAt(t), s = cur ?? prev;
    return s ? { s, c: this.ctxAt(s, t, rootOverride) } : undefined;
  }

  poseAt(t: number, rootOverride?: LibRootOverride): ActionPose {
    const { cur, prev } = this.segAt(t);
    const idle: ActionPose = { joints: IDLE_POSE };
    const rest = (s?: LibSegment): ActionPose => (s && s.def.holds ? s.def.pose(this.ctxAt(s, s.end, rootOverride)) : idle);
    if (cur) {
      const p = cur.def.pose(this.ctxAt(cur, t, rootOverride)), w = smooth01((t - cur.start) / Math.max(1e-6, cur.def.blendIn));
      return w >= 1 ? p : blendAction(rest(prev), p, w);
    }
    if (prev && !prev.def.holds) {
      const w = smooth01((t - prev.end) / 0.3);
      return w >= 1 ? idle : blendAction(prev.def.pose(this.ctxAt(prev, prev.end, rootOverride)), idle, w);
    }
    return rest(prev);
  }

  /** Pose the rig at t using either compiled root motion or an authoritative external root. */
  private applyWithRoot(t: number, rootOverride?: LibRootOverride): LibDiag {
    const rig = this.rig, pose = this.poseAt(t, rootOverride), compiled = this.rootAt(t);
    const root = rootOverride ? { ...compiled, ...rootOverride } : compiled, pitch = pose.pitch ?? 0;
    rig.root.pos = [root.pos[0], 0, root.pos[2]];
    rig.root.rot = qMul(qEuler(0, root.yaw * DEG, 0), qEuler(pitch * DEG, 0, 0));
    rig.root.scl = [1, 1, 1];
    const joints = { ...pose.joints };
    let layerNeck: Vec3 | undefined;
    for (const { a, def } of this.layers) {
      if (t < a.start || t >= a.start + a.duration) continue;
      const lp = def.pose({ lt: t - a.start, d: a.duration, u: (t - a.start) / a.duration, t, seed: this.seed, params: a.params ?? {} });
      for (const [j, e] of Object.entries(lp.joints) as Array<[Joint, Vec3]>) {
        if (j === 'neck') { layerNeck = add(layerNeck ?? [0, 0, 0], e); continue; }
        const c = joints[j] ?? [0, 0, 0]; joints[j] = [c[0] + e[0], c[1] + e[1], c[2] + e[2]];
      }
    }
    const il = idleLayer(t, this.seed % 1000, pose.still ? 0.15 : 1), tr = pose.tremble ?? 0;
    for (const j of JOINTS) {
      const p = joints[j] ?? [0, 0, 0], i = il[j] ?? [0, 0, 0];
      let e: Vec3 = [p[0] + i[0], p[1] + i[1], p[2] + i[2]];
      if (j === 'neck' && layerNeck) e = add(e, layerNeck);
      if (tr && (j === 'spine' || j === 'neck' || j.startsWith('shoulder'))) e = [e[0] + noise1(t * 22, this.seed + j.length) * tr, e[1] + noise1(t * 19, this.seed + 7 * j.length) * tr, e[2]];
      rig.joints[j].rot = qEuler(e[0] * DEG, e[1] * DEG, e[2] * DEG);
    }
    rig.root.updateWorld();
    // look-at (upright only): yaw about the spine's up axis, then pitch about the turned head; neck layers ride on top
    if (pose.lookAt && Math.abs(pitch) < 5 && (pose.lookWeight ?? 0) > 0.01) {
      const neck = rig.joints.neck, hp = add(neck.worldPos(), [0, rig.dims.headH * 0.5, 0]);
      const local = rotInv(qFromMat(rig.joints.spine.world), sub(pose.lookAt, hp));
      const yaw = clamp(Math.atan2(local[0], local[2]) / DEG, -LOOK_LIMITS.yaw, LOOK_LIMITS.yaw);
      const pit = clamp(-Math.atan2(local[1], Math.hypot(local[0], local[2])) / DEG, -LOOK_LIMITS.pitchUp, LOOK_LIMITS.pitchDown);
      const from = joints.neck ?? [0, 0, 0], w = pose.lookWeight ?? 1, look = qMul(qEuler(0, yaw * DEG, 0), qEuler(pit * DEG, 0, 0));
      let q = w >= 0.999 ? look : qSlerp(qEuler(from[0] * DEG, from[1] * DEG, from[2] * DEG), look, w);
      if (layerNeck) q = qMul(q, qEuler(layerNeck[0] * DEG, layerNeck[1] * DEG, layerNeck[2] * DEG));
      neck.rot = q;
      rig.root.updateWorld();
    }
    let handError: number | undefined;
    for (const ik of pose.ik ?? []) {
      if (ik.weight <= 0.001) continue;
      const tgt: Vec3 = ik.local ? add([root.pos[0], 0, root.pos[2]], qRotate(qEuler(0, root.yaw * DEG, 0), ik.target)) : ik.target;
      const err = solveArmIk(rig, ik.arm, tgt, ik.weight, ik.pole ?? [0, -0.5, -1], root.yaw);
      if (ik.weight > 0.95) handError = err;
    }
    // squash & stretch about the feet, then ground the scaled body (lowest stance-foot probe, or any probe when lying)
    if (pose.scale) { rig.root.scl = [pose.scale[0], pose.scale[1], pose.scale[2]]; rig.root.updateWorld(); }
    let minY = Infinity;
    for (const p of rig.probes) {
      if (pose.ground !== 'all' && !(p.name.includes('toe') || p.name.includes('heel'))) continue;
      if (pose.ground !== 'all' && pose.stance && !p.name.endsWith(`_${pose.stance}`)) continue;
      minY = Math.min(minY, p.worldPos()[1]);
    }
    rig.root.pos = [root.pos[0], -minY + (pose.lift ?? 0), root.pos[2]];
    rig.root.updateWorld();
    return { handError, stance: pose.stance, grounded: !(pose.lift && pose.lift > 0.01), scale: [...rig.root.scl] as Vec3 };
  }

  /** Original standalone behavior: LibraryTrack owns root motion. */
  apply(t: number): LibDiag { return this.applyWithRoot(t); }
  /** Vignette behavior: LibraryTrack owns the body pose while the staged WorldPlan remains authoritative for the root. */
  applyAtRoot(t: number, pos: Vec3, yaw: number): LibDiag { return this.applyWithRoot(t, { pos, yaw }); }
}
