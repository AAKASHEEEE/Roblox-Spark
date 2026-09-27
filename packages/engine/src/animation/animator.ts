// Actor animator: compiles semantic actions into a continuous root-motion track and evaluates poses at any t.
// Pure function of t (random access) => deterministic renders and scrubbable previews.
import type { ActionName, EpisodeAction } from '../../../schema/src/episode.ts';
import { LOCOMOTION_ACTIONS } from '../../../schema/src/episode.ts';
import type { Joint, Rig } from '../build.ts';
import { JOINTS } from '../build.ts';
import { DEG, clamp, cross, dot, hashSeed, len, noise1, norm, qEuler, qFromBasis, qFromMat, qMul, qConj, qSlerp, qAxisAngle, scale, sub, add, type Quat, type Vec3, rng } from '../math.ts';
import { ACTION_DEFS, IDLE_POSE, idleLayer, type ActionCtx } from './actions.ts';
import { blendAction, type ActionPose } from './pose.ts';

export interface Segment {
  a: EpisodeAction;
  start: number;
  end: number;
  fromPos: Vec3;
  toPos: Vec3;
  dist: number;
  travelYaw: number;
  fromYaw: number;
  endYaw: number;
  run: boolean;
}

export interface PointResolver {
  /** world point for a mark / anchor / prop / actor id at time t */
  point(id: string, t: number): Vec3 | undefined;
  /** facing (deg) if id is a mark */
  markFacing(id: string): number | undefined;
}

export interface ActorDiag { handError?: number; soleSlip?: number; grounded: boolean; minY: number; stance?: 'l' | 'r' }

const yawTo = (from: Vec3, to: Vec3): number => Math.atan2(to[0] - from[0], to[2] - from[2]) / DEG;
const wrap = (d: number): number => { let x = ((d + 180) % 360 + 360) % 360 - 180; if (x === -180) x = 180; return x; };
const lerpAngle = (a: number, b: number, t: number): number => a + wrap(b - a) * t;
const smooth01 = (x: number): number => { const c = clamp(x, 0, 1); return c * c * (3 - 2 * c); };

function travel(lt: number, d: number, dist: number): { s: number; v: number } {
  if (dist <= 1e-6) return { s: 0, v: 0 };
  const ta = Math.min(0.25, d * 0.25);
  const v = dist / (d - ta);
  if (lt <= 0) return { s: 0, v: 0 };
  if (lt >= d) return { s: dist, v: 0 };
  if (lt < ta) return { s: (0.5 * v * lt * lt) / ta, v: (v * lt) / ta };
  if (lt < d - ta) return { s: 0.5 * v * ta + v * (lt - ta), v };
  const r = d - lt;
  return { s: dist - (0.5 * v * r * r) / ta, v: (v * r) / ta };
}

export class ActorTrack {
  readonly segs: Segment[] = [];
  layers: EpisodeAction[] = [];
  lastStance: 'l' | 'r' | undefined;
  /** arms under intentional IK contact this frame (exempt from collision avoidance) */
  lastIkArms = new Set<'l' | 'r'>();
  readonly seed: number;
  private blinks: number[] = [];
  expressionTrack: Array<{ at: number; state: string }> = [];

  readonly id: string;
  readonly rig: Rig;
  private res: PointResolver;
  constructor(id: string, rig: Rig, actions: EpisodeAction[], startPos: Vec3, startYaw: number, res: PointResolver, episodeSeed: number, duration: number) { this.id = id; this.rig = rig; this.res = res;
    this.seed = (hashSeed(id) ^ episodeSeed) >>> 0;
    this._startPos = startPos; this._startYaw = startYaw;
    const all = actions.filter((a) => a.actor === id).sort((x, y) => x.start - y.start);
    this.layers = all.filter((a) => ACTION_DEFS[a.action]?.layer);
    const mine = all.filter((a) => !ACTION_DEFS[a.action]?.layer);
    let pos = startPos;
    for (const a of mine) {
      const loco = LOCOMOTION_ACTIONS.includes(a.action);
      const to = loco && a.to ? res.point(a.to, a.start) : undefined;
      const toPos: Vec3 = to ? [to[0], 0, to[2]] : pos;
      const d = sub(toPos, pos);
      this.segs.push({ a, start: a.start, end: a.start + a.duration, fromPos: pos, toPos, dist: Math.hypot(d[0], d[2]), travelYaw: 0, fromYaw: 0, endYaw: 0, run: a.action === 'run' || a.action === 'chase' || a.action === 'dive_prone' || a.action === 'exit_frame' });
      pos = toPos;
    }
    // pass 2: yaw (positions of all actors are known via resolver)
    let yaw = startYaw;
    // arrival facing is applied as an in-place turn AFTER the stop (turning while moving would drag the planted foot)
    let pendingFacing: number | undefined;
    for (const s of this.segs) {
      s.fromYaw = yaw;
      const tgt = s.a.target ? res.point(s.a.target, s.start) : undefined;
      if (LOCOMOTION_ACTIONS.includes(s.a.action) && s.dist > 0.05) {
        s.travelYaw = yawTo(s.fromPos, s.toPos);
        s.endYaw = s.travelYaw;
        pendingFacing = s.a.action === 'dive_prone' || !s.a.to ? undefined : res.markFacing(s.a.to);
      } else if ((s.a.action === 'turn_toward' || s.a.params?.turn === true) && tgt) {
        s.travelYaw = s.endYaw = yawTo(s.fromPos, tgt); pendingFacing = undefined;
      } else { s.travelYaw = s.endYaw = pendingFacing ?? yaw; pendingFacing = undefined; }
      yaw = s.endYaw;
    }
    // deterministic blink schedule
    const r = rng(this.seed);
    for (let t = 0.6 + r() * 1.5; t < duration + 2; t += 2.2 + r() * 2.4) this.blinks.push(t);
  }

  segAt(t: number): { cur?: Segment; prev?: Segment } {
    let cur: Segment | undefined, prev: Segment | undefined;
    for (const s of this.segs) {
      if (t >= s.start && t < s.end) cur = s;
      else if (s.end <= t) prev = s;
    }
    return { cur, prev };
  }

  rootAt(t: number): { pos: Vec3; yaw: number; speed: number; dist: number } {
    const { cur, prev } = this.segAt(t);
    if (!cur) {
      const s = prev;
      if (!s) {
        const first = this.segs[0];
        return { pos: first ? first.fromPos : this.startPos(), yaw: first ? first.fromYaw : this.startYaw(), speed: 0, dist: 0 };
      }
      return { pos: s.toPos, yaw: s.endYaw, speed: 0, dist: s.dist };
    }
    const lt = t - cur.start, d = cur.end - cur.start;
    if (LOCOMOTION_ACTIONS.includes(cur.a.action) && cur.dist > 0.05) {
      const { s, v } = travel(lt, d, cur.dist);
      const f = s / cur.dist;
      const pos: Vec3 = [cur.fromPos[0] + (cur.toPos[0] - cur.fromPos[0]) * f, 0, cur.fromPos[2] + (cur.toPos[2] - cur.fromPos[2]) * f];
      const yaw = lerpAngle(cur.fromYaw, cur.travelYaw, smooth01(lt / 0.2));
      return { pos, yaw, speed: v, dist: s };
    }
    const turnDur = Math.min(d, 0.35);
    return { pos: cur.fromPos, yaw: lerpAngle(cur.fromYaw, cur.endYaw, smooth01(lt / turnDur)), speed: 0, dist: 0 };
  }
  private startPos(): Vec3 { return this._startPos; }
  private startYaw(): number { return this._startYaw; }
  _startPos: Vec3 = [0, 0, 0];
  _startYaw = 0;

  private actionPose(s: Segment, t: number): ActionPose {
    const def = ACTION_DEFS[s.a.action as ActionName];
    if (!def) throw new Error(`action ${s.a.action} not implemented`);
    const d = s.end - s.start;
    const lt = clamp(t - s.start, 0, d);
    const root = this.rootAt(Math.min(t, s.end - 1e-4));
    const ctx: ActionCtx = {
      lt, d, u: lt / d, t, seed: this.seed,
      target: s.a.target ? this.res.point(s.a.target, t) : undefined,
      params: (s.a.params ?? {}) as Record<string, number | string | boolean>,
      loco: { dist: t >= s.end ? s.dist : root.dist, speed: t >= s.end ? 0 : root.speed, run: s.run, legLen: this.rig.dims.legLen, total: s.dist },
    };
    return def.pose(ctx);
  }

  /** Full pose at time t including blending between semantic actions. */
  poseAt(t: number): ActionPose {
    const { cur, prev } = this.segAt(t);
    const idle: ActionPose = { joints: IDLE_POSE };
    const rest = (s?: Segment): ActionPose => (s && ACTION_DEFS[s.a.action].holds ? this.actionPose(s, s.end) : idle);
    if (cur) {
      const def = ACTION_DEFS[cur.a.action];
      const lt = t - cur.start;
      const p = this.actionPose(cur, t);
      const w = smooth01(lt / def.blendIn);
      return w >= 1 ? p : blendAction(rest(prev), p, w);
    }
    if (prev && !ACTION_DEFS[prev.a.action].holds) {
      const w = smooth01((t - prev.end) / 0.3);
      return w >= 1 ? idle : blendAction(this.actionPose(prev, prev.end), idle, w);
    }
    return rest(prev);
  }

  expressionAt(t: number): string {
    let st = this.expressionTrack[0]?.state ?? this.rig.manifest.allowedExpressions[0];
    for (const e of this.expressionTrack) if (e.at <= t) st = e.state;
    return st;
  }
  blinkAt(t: number): number {
    for (const b of this.blinks) { const x = (t - b) / 0.14; if (x >= 0 && x <= 1) return Math.sin(Math.PI * x); }
    return 0;
  }

  /** Apply pose at t to the rig nodes (world matrices updated). Returns diagnostics. */
  apply(t: number): ActorDiag {
    const rig = this.rig;
    const pose = this.poseAt(t);
    const root = this.rootAt(t);
    const pitch = pose.pitch ?? 0;
    rig.root.pos = [root.pos[0], 0, root.pos[2]];
    rig.root.rot = qMul(qEuler(0, root.yaw * DEG, 0), qEuler(pitch * DEG, 0, 0));
    const add3 = (a: Vec3 | undefined, b: Vec3 | undefined): Vec3 => [(a?.[0] ?? 0) + (b?.[0] ?? 0), (a?.[1] ?? 0) + (b?.[1] ?? 0), (a?.[2] ?? 0) + (b?.[2] ?? 0)];
    for (const la of this.layers) {
      if (t < la.start || t >= la.start + la.duration) continue;
      const lp = ACTION_DEFS[la.action].pose({ lt: t - la.start, d: la.duration, u: (t - la.start) / la.duration, t, seed: this.seed, params: (la.params ?? {}) as Record<string, number | string | boolean> });
      for (const [j, e] of Object.entries(lp.joints)) {
        const cur = pose.joints[j as Joint] ?? [0, 0, 0];
        pose.joints = { ...pose.joints, [j]: [cur[0] + e![0], cur[1] + e![1], cur[2] + e![2]] };
      }
    }
    const idleAmt = pose.still ? 0.15 : 1;
    const il = idleLayer(t, this.seed % 1000, idleAmt);
    const tr = pose.tremble ?? 0;
    for (const j of JOINTS) {
      let e = add3(pose.joints[j], il[j]);
      if (tr && (j === 'spine' || j === 'neck' || j.startsWith('shoulder'))) {
        e = [e[0] + noise1(t * 22, this.seed + j.length) * tr, e[1] + noise1(t * 19, this.seed + 7 * j.length) * tr, e[2]];
      }
      rig.joints[j].rot = qEuler(e[0] * DEG, e[1] * DEG, e[2] * DEG);
    }
    rig.root.updateWorld();
    // look-at (only when upright)
    if (pose.lookAt && Math.abs(pitch) < 5 && (pose.lookWeight ?? 0) > 0.01) {
      const neck = rig.joints.neck;
      const hp = add(neck.worldPos(), [0, rig.dims.headH * 0.5, 0]);
      const d = sub(pose.lookAt, hp);
      const spineQ = qFromMat(rig.joints.spine.world);
      const local = rotInv(spineQ, d);
      const yaw = clamp(Math.atan2(local[0], local[2]) / DEG, -75, 75);
      const pitchL = clamp(-Math.atan2(local[1], Math.hypot(local[0], local[2])) / DEG, -35, 40);
      const cur = pose.joints.neck ?? [0, 0, 0];
      const w = pose.lookWeight ?? 1;
      const e: Vec3 = [cur[0] + (pitchL - cur[0]) * w, cur[1] + (yaw - cur[1]) * w, cur[2] * (1 - w)];
      neck.rot = qEuler(e[0] * DEG, e[1] * DEG, e[2] * DEG);
      rig.root.updateWorld();
    }
    // IK
    let handError: number | undefined;
    this.lastIkArms.clear();
    for (const ik of pose.ik ?? []) {
      if (ik.weight <= 0.001) continue;
      if (ik.weight > 0.05) this.lastIkArms.add(ik.arm);
      const tgt: Vec3 = ik.local ? add([root.pos[0], 0, root.pos[2]], rot(qEuler(0, root.yaw * DEG, 0), ik.target)) : ik.target;
      const err = solveArmIk(rig, ik.arm, tgt, ik.weight, ik.pole ?? [0, -0.5, -1], root.yaw);
      if (ik.weight > 0.95) handError = err;
    }
    // grounding: lowest relevant probe touches y=0, then add lift
    let minY = Infinity;
    for (const p of rig.probes) {
      if (pose.ground !== 'all' && !(p.name.includes('toe') || p.name.includes('heel'))) continue;
      if (pose.ground !== 'all' && pose.stance && !p.name.endsWith(`_${pose.stance}`)) continue;
      minY = Math.min(minY, p.worldPos()[1]);
    }
    rig.root.pos = [root.pos[0], -minY + (pose.lift ?? 0), root.pos[2]];
    rig.root.updateWorld();
    rig.setFace(this.expressionAt(t), this.blinkAt(t));
    this.lastStance = pose.stance;
    return { handError, grounded: !(pose.lift && pose.lift > 0.01), minY: -minY, stance: pose.stance };
  }
}

function rotInv(q: Quat, v: Vec3): Vec3 {
  const c = qConj(q);
  const p = qMul(qMul(c, [v[0], v[1], v[2], 0]), q);
  return [p[0], p[1], p[2]];
}
function rot(q: Quat, v: Vec3): Vec3 {
  const p = qMul(qMul(q, [v[0], v[1], v[2], 0]), qConj(q));
  return [p[0], p[1], p[2]];
}

/** Analytic two-bone IK for an arm. Returns resulting hand-to-target distance (m). */
export function solveArmIk(rig: Rig, arm: 'l' | 'r', target: Vec3, weight: number, poleLocal: Vec3, yawDeg: number): number {
  const sh = rig.joints[arm === 'l' ? 'shoulder_l' : 'shoulder_r'];
  const el = rig.joints[arm === 'l' ? 'elbow_l' : 'elbow_r'];
  const hand = arm === 'l' ? rig.hand_l : rig.hand_r;
  const L1 = rig.dims.upperArm, L2 = rig.dims.lowerArm;
  const S = sh.worldPos();
  const toT = sub(target, S);
  const dRaw = len(toT);
  const d = clamp(dRaw, 0.05, L1 + L2 - 1e-3);
  const dir = norm(toT);
  const poleW = rot(qAxisAngle([0, 1, 0], yawDeg * DEG), [poleLocal[0] * (arm === 'l' ? -1 : 1), poleLocal[1], poleLocal[2]]);
  let perp = sub(poleW, scale(dir, dot(poleW, dir)));
  if (len(perp) < 1e-4) perp = [0, -1, 0];
  perp = norm(perp);
  const a1 = Math.acos(clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1));
  const a2 = Math.acos(clamp((L1 * L1 + L2 * L2 - d * d) / (2 * L1 * L2), -1, 1));
  const upper = norm(add(scale(dir, Math.cos(a1)), scale(perp, Math.sin(a1))));
  const elbowP = add(S, scale(upper, L1));
  const fore = norm(sub(add(S, scale(dir, d)), elbowP));
  const yAxis = scale(upper, -1);
  let zAxis = sub(fore, scale(upper, dot(fore, upper)));
  zAxis = len(zAxis) < 1e-5 ? norm(cross(yAxis, [1, 0, 0])) : norm(zAxis);
  const xAxis = norm(cross(yAxis, zAxis));
  const worldQ = qFromBasis(xAxis, yAxis, cross(xAxis, yAxis));
  const parentQ = qFromMat(sh.parent!.world);
  const localSh = qMul(qConj(parentQ), worldQ);
  const localEl = qEuler(-(Math.PI - a2), 0, 0);
  sh.rot = qSlerp(sh.rot, localSh, weight);
  el.rot = qSlerp(el.rot, localEl, weight);
  rig.root.updateWorld();
  return len(sub(hand.worldPos(), target));
}

export type { Joint };
