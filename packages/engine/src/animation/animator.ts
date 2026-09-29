// Actor animator: compiles semantic actions into a continuous root-motion track and evaluates poses at any t.
// Pure function of t (random access) => deterministic renders and scrubbable previews.
import type { ActionName, EpisodeAction } from '../../../schema/src/episode.ts';
import { LOCOMOTION_ACTIONS } from '../../../schema/src/episode.ts';
import type { Joint, Rig } from '../build.ts';
import { JOINTS } from '../build.ts';
import { DEG, clamp, cross, dot, hashSeed, len, noise1, norm, qEuler, qFromBasis, qFromMat, qMul, qConj, qRotate, qSlerp, qAxisAngle, scale, sub, add, type Quat, type Vec3, rng } from '../math.ts';
import { ACTION_DEFS, IDLE_POSE, idleLayer, type ActionCtx } from './actions.ts';
import type { MotionBehaviour } from '../../../schema/src/render-compat.ts';
import { blendAction, blendPose, type ActionPose, type JointPose } from './pose.ts';

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
  /** corrected-head-v2 only: synchronised locomotion onset (see planOnset) */
  onset?: OnsetPlan;
  /** why a synchronised onset was not planned for this locomotion segment (QA transparency) */
  onsetSkip?: string;
}

/**
 * Synchronised locomotion onset (motion behaviour locomotionOnset = 'synchronized').
 * Root translation, gait phase and the planted foot share ONE state during the first stance:
 *  - the stance foot is chosen on the inside of the turn and its world position (the anchor) is where that foot stood
 *    in the pre-locomotion pose;
 *  - the gait phase starts at that foot's mid-stance and advances only with gait distance s(t) (same trapezoid timing);
 *  - the body pivots about the anchor while stepping off: yaw progresses with s, and the root is derived from the
 *    anchor (root = anchor - R(yaw) * stanceFootLocal), made FK-exact in apply();
 *  - when the stance foot lifts off (s = S/2) the straight path continues from exactly that root position, in exactly
 *    that heading (fixed-point solved so heading == direction to the target mark).
 */
export interface OnsetPlan {
  stance: 'l' | 'r';
  /** gait phase at gait distance 0 (0.25 = left mid-stance, 0.75 = right mid-stance) */
  cyc0: number;
  /** gait distance of the whole segment (curved onset + straight remainder) */
  G: number;
  /** gait distance at which the onset stance foot lifts off (S / 2) */
  sOn: number;
  /** whole stances over G (gait ends at mid-stance on arrival) */
  stances: number;
  yaw0: number;
  yaw1: number;
  /** signed turn from yaw0 to yaw1 in the direction chosen at planning (may exceed 180 by a few degrees) */
  turn: number;
  /** world position of the planted stance sole during the onset stance */
  anchor: Vec3;
  /** stance sole in the root frame: pre-onset pose / gait pose at cyc0 */
  footPre: Vec3;
  footGait0: Vec3;
  /** root position and heading when the onset stance ends */
  pOn: Vec3;
  dir: Vec3;
  blendIn: number;
  /** swing foot: lifts off from where it stood and lands where the gait expects it (world xz, root-frame y) */
  swing: 'l' | 'r';
  swingStartW: Vec3;
  swingEndW: Vec3;
  swingStartY: number;
  swingEndY: number;
  clearance: number;
}

/**
 * Sagittal two-link leg IK: hip + knee flexion angles (deg) that put the sole point at (y, z) relative to the hip joint
 * (root frame, rotation about x as qEuler uses it). The sole sits `soleFwd` forward of the shin axis.
 */
function legIk(y: number, z: number, U: number, Lw: number, soleFwd: number): { hip: number; knee: number } {
  const Ls = Math.hypot(Lw, soleFwd), beta = -Math.atan2(soleFwd, Lw);
  const D = clamp(Math.hypot(y, z), Math.abs(U - Ls) + 1e-4, U + Ls - 1e-4);
  const gamma = Math.atan2(-z, -y); // angle of the hip->sole vector from straight down (+ = backward)
  const delta = Math.acos(clamp((U * U + D * D - Ls * Ls) / (2 * U * D), -1, 1));
  const eps = Math.acos(clamp((Ls * Ls + D * D - U * U) / (2 * Ls * D), -1, 1));
  const th = gamma - delta, psi = gamma + eps; // thigh forward of the target line, shin behind it (knee flexes)
  return { hip: th / DEG, knee: (psi - beta - th) / DEG };
}

export interface PointResolver {
  /** world point for a mark / anchor / prop / actor id at time t */
  point(id: string, t: number): Vec3 | undefined;
  /** facing (deg) if id is a mark */
  markFacing(id: string): number | undefined;
}

export interface ActorDiag { handError?: number; soleSlip?: number; grounded: boolean; minY: number; stance?: 'l' | 'r' }

/** neck look-at joint limits in degrees, relative to the spine frame (QA reports residual gaze error beyond these) */
export const LOOK_LIMITS = { yaw: 75, pitchDown: 40, pitchUp: 35 } as const;

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

/** inverse of travel(): local time at which gait distance sq is reached */
function travelTime(sq: number, d: number, dist: number): number {
  const ta = Math.min(0.25, d * 0.25);
  const v = dist / (d - ta);
  const s1 = 0.5 * v * ta, s2 = dist - 0.5 * v * ta;
  if (sq <= s1) return Math.sqrt((2 * sq * ta) / v);
  if (sq <= s2) return ta + (sq - s1) / v;
  return d - Math.sqrt(Math.max(0, (2 * (dist - sq) * ta) / v));
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
  /** behaviour switches of the episode's DECLARED motion profile (render-compat.ts); never inferred */
  readonly behaviour: MotionBehaviour;
  private res: PointResolver;
  constructor(id: string, rig: Rig, actions: EpisodeAction[], startPos: Vec3, startYaw: number, res: PointResolver, episodeSeed: number, duration: number, behaviour: MotionBehaviour) { this.id = id; this.rig = rig; this.res = res; this.behaviour = behaviour;
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
    // pass 2: yaw (targets resolved through the resolver; see resolveYaw)
    this.resolveYaw(startYaw);
    // deterministic blink schedule
    const r = rng(this.seed);
    for (let t = 0.6 + r() * 1.5; t < duration + 2; t += 2.2 + r() * 2.4) this.blinks.push(t);
  }

  /**
   * Yaw pass over the segments. Idempotent (depends only on segments, start yaw and the resolver). Production calls it
   * again once every actor track exists, because a turn toward an actor cast LATER cannot resolve during construction.
   */
  resolveYaw(startYaw: number = this._startYaw): void {
    this._startYaw = startYaw;
    let yaw = startYaw;
    // arrival facing is applied as an in-place turn AFTER the stop (turning while moving would drag the planted foot)
    let pendingFacing: number | undefined;
    for (let k = 0; k < this.segs.length; k++) {
      const s = this.segs[k];
      s.fromYaw = yaw;
      const tgt = s.a.target ? this.res.point(s.a.target, s.start) : undefined;
      if (LOCOMOTION_ACTIONS.includes(s.a.action) && s.dist > 0.05) {
        s.travelYaw = yawTo(s.fromPos, s.toPos);
        s.endYaw = s.travelYaw;
        pendingFacing = s.a.action === 'dive_prone' || !s.a.to ? undefined : this.res.markFacing(s.a.to);
      } else if ((s.a.action === 'turn_toward' || s.a.params?.turn === true) && tgt) {
        s.travelYaw = s.endYaw = yawTo(s.fromPos, tgt); pendingFacing = undefined;
      } else { s.travelYaw = s.endYaw = pendingFacing ?? yaw; pendingFacing = undefined; }
      s.onset = undefined; s.onsetSkip = undefined;
      if (this.behaviour.locomotionOnset === 'synchronized' && LOCOMOTION_ACTIONS.includes(s.a.action) && s.dist > 0.05) {
        const o = this.planOnset(s, k > 0 && this.segs[k - 1].end <= s.start + 1e-9 ? this.segs[k - 1] : undefined);
        if (typeof o === 'string') s.onsetSkip = o;
        else { s.onset = o; s.travelYaw = s.endYaw = o.yaw1; }
      }
      yaw = s.endYaw;
    }
  }

  /** stance sole position in the root frame (yaw 0, before grounding) for a leg pose — the rig's exact chain */
  private soleLocal(joints: JointPose, side: 'l' | 'r'): Vec3 {
    const d = this.rig.dims;
    const q = (e: Vec3 | undefined) => qEuler((e?.[0] ?? 0) * DEG, (e?.[1] ?? 0) * DEG, (e?.[2] ?? 0) * DEG);
    const knee = add([0, -d.upperLeg, 0], qRotate(q(joints[side === 'l' ? 'knee_l' : 'knee_r']), [0, -d.lowerLeg, 0.045]));
    const hip = add([(side === 'l' ? 1 : -1) * d.hipX, 0, 0], qRotate(q(joints[side === 'l' ? 'hip_l' : 'hip_r']), knee));
    return add([0, d.legLen, 0], qRotate(q(joints.hips), hip));
  }

  private planOnset(s: Segment, prev: Segment | undefined): OnsetPlan | string {
    const def = ACTION_DEFS[s.a.action as ActionName];
    const restPose = prev && ACTION_DEFS[prev.a.action].holds ? this.actionPose(prev, prev.end) : { joints: IDLE_POSE } as ActionPose;
    // only a standing pre-locomotion pose has a planted foot to synchronise with (get-ups from lying poses keep the blend)
    if (Math.abs(restPose.pitch ?? 0) > 5 || restPose.ground === 'all') return 'pre-locomotion pose is not standing (no planted foot)';
    const d = s.end - s.start;
    // turn direction is decided ONCE here: the shortest way, except near-reversals (> 170 deg) turn through the
    // audience-facing heading (+z) so the face stays readable; the fixed point below may move the final heading by a few
    // degrees but never flips the direction. +yaw turns toward the actor's left (+x local): pivot on the inside foot.
    const est = wrap(yawTo(s.fromPos, s.toPos) - s.fromYaw);
    let dirSign = est >= 0 ? 1 : -1;
    if (Math.abs(est) > 170) {
      const alt = est - 360 * Math.sign(est);
      dirSign = Math.cos((s.fromYaw + est / 2) * DEG) >= Math.cos((s.fromYaw + alt / 2) * DEG) ? Math.sign(est) : Math.sign(alt);
    }
    const stance: 'l' | 'r' = dirSign > 0 ? 'l' : 'r';
    const cyc0 = stance === 'l' ? 0.25 : 0.75;
    const footPre = this.soleLocal(restPose.joints, stance);
    const a0 = add(s.fromPos, qRotate(qEuler(0, s.fromYaw * DEG, 0), footPre));
    const anchor: Vec3 = [a0[0], 0, a0[2]];
    const gaitJoints = (sq: number, G: number, lt: number): JointPose => def.pose({ lt, d, u: lt / d, t: s.start + lt, seed: this.seed, params: (s.a.params ?? {}) as Record<string, number | string | boolean>, loco: { dist: sq, speed: 1, run: s.run, legLen: this.rig.dims.legLen, total: G, phase0: cyc0, stances: n } }).joints;
    const baseS = s.run ? 0.62 : 0.4;
    let yaw1 = yawTo(s.fromPos, s.toPos), G = s.dist, sOn = 0, pOn: Vec3 = s.fromPos, footGait0: Vec3 = footPre;
    // whole number of stances fixed from the planned distance (re-rounding inside the fixed point could oscillate)
    const n = Math.max(1, Math.round(s.dist / baseS));
    for (let it = 0; it < 12; it++) {
      sOn = G / n / 2;
      const tOn = travelTime(sOn, d, G);
      if (s.a.action === 'dive_prone' && tOn / d >= Number(s.a.params?.diveAt ?? 0.55)) return `leaps (u=${Number(s.a.params?.diveAt ?? 0.55)}) before the first step lands (u=${(tOn / d).toFixed(3)})`;
      const w = smooth01(tOn / def.blendIn);
      const jOn = gaitJoints(sOn, G, tOn);
      const footLO = this.soleLocal(w >= 1 ? jOn : blendPose(restPose.joints, jOn, w), stance);
      footGait0 = this.soleLocal(gaitJoints(0, G, 0), stance);
      const p = sub(anchor, qRotate(qEuler(0, yaw1 * DEG, 0), footLO));
      pOn = [p[0], 0, p[2]];
      const ny = yawTo(pOn, s.toPos), nG = sOn + Math.hypot(s.toPos[0] - pOn[0], s.toPos[2] - pOn[2]);
      const settled = Math.abs(wrap(ny - yaw1)) < 1e-7 && Math.abs(nG - G) < 1e-9;
      yaw1 = ny; G = nG;
      if (settled) break;
    }
    const rest = Math.hypot(s.toPos[0] - pOn[0], s.toPos[2] - pOn[2]);
    if (rest < 1e-4) return 'path shorter than the first step';
    let turnDeg = wrap(yaw1 - s.fromYaw);
    if (Math.sign(turnDeg) !== dirSign && Math.abs(turnDeg) > 90) turnDeg += 360 * dirSign;
    const swing: 'l' | 'r' = stance === 'l' ? 'r' : 'l';
    const sw0 = this.soleLocal(restPose.joints, swing);
    const swStart = add(s.fromPos, qRotate(qEuler(0, s.fromYaw * DEG, 0), sw0));
    const tOn = travelTime(sOn, d, G);
    const jOn = gaitJoints(sOn, G, tOn);
    const w = smooth01(tOn / def.blendIn);
    const sw1 = this.soleLocal(w >= 1 ? jOn : blendPose(restPose.joints, jOn, w), swing);
    const swEnd = add(pOn, qRotate(qEuler(0, yaw1 * DEG, 0), sw1));
    return {
      stance, cyc0, G, sOn, stances: n, yaw0: s.fromYaw, yaw1, turn: turnDeg, anchor, footPre, footGait0, pOn, dir: [(s.toPos[0] - pOn[0]) / rest, 0, (s.toPos[2] - pOn[2]) / rest], blendIn: def.blendIn,
      swing, swingStartW: [swStart[0], 0, swStart[2]], swingEndW: [swEnd[0], 0, swEnd[2]], swingStartY: sw0[1], swingEndY: sw1[1], clearance: s.run ? 0.1 : 0.07,
    };
  }

  /** onset stance in progress at t (the planted foot must stay on its anchor) */
  private onsetAt(t: number): { s: Segment; o: OnsetPlan; u: number } | undefined {
    const { cur } = this.segAt(t);
    if (!cur?.onset) return undefined;
    const { s } = travel(t - cur.start, cur.end - cur.start, cur.onset.G);
    return s < cur.onset.sOn ? { s: cur, o: cur.onset, u: s / cur.onset.sOn } : undefined;
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
    if (cur.onset) {
      const o = cur.onset;
      const { s, v } = travel(lt, d, o.G);
      if (s < o.sOn) {
        // pivot about the planted stance foot while stepping off (FK-exact correction in apply())
        const yaw = o.yaw0 + o.turn * smooth01(s / o.sOn);
        const w = smooth01(lt / o.blendIn);
        const f: Vec3 = [o.footPre[0] + (o.footGait0[0] - o.footPre[0]) * w, 0, o.footPre[2] + (o.footGait0[2] - s - o.footPre[2]) * w];
        const p = sub(o.anchor, qRotate(qEuler(0, yaw * DEG, 0), f));
        return { pos: [p[0], 0, p[2]], yaw, speed: v, dist: s };
      }
      return { pos: [o.pOn[0] + o.dir[0] * (s - o.sOn), 0, o.pOn[2] + o.dir[2] * (s - o.sOn)], yaw: o.yaw1, speed: v, dist: s };
    }
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
      loco: s.onset
        ? { dist: t >= s.end ? s.onset.G : root.dist, speed: t >= s.end ? 0 : root.speed, run: s.run, legLen: this.rig.dims.legLen, total: s.onset.G, phase0: s.onset.cyc0, stances: s.onset.stances }
        : { dist: t >= s.end ? s.dist : root.dist, speed: t >= s.end ? 0 : root.speed, run: s.run, legLen: this.rig.dims.legLen, total: s.dist },
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
      if (w >= 1) return p;
      const b = blendAction(rest(prev), p, w);
      if (cur.onset) b.stance = p.stance;
      return b;
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
    // neck before additive layers: the look-at below blends from THIS pose and re-adds the layer afterwards, otherwise a
    // look-at of weight w scales a head_shake layer by (1 - w) (action-reel finding: 22 deg shake measured as 4 deg)
    const baseNeck = pose.joints.neck;
    let layerNeck: Vec3 | undefined;
    for (const la of this.layers) {
      if (t < la.start || t >= la.start + la.duration) continue;
      const lp = ACTION_DEFS[la.action].pose({ lt: t - la.start, d: la.duration, u: (t - la.start) / la.duration, t, seed: this.seed, params: (la.params ?? {}) as Record<string, number | string | boolean> });
      for (const [j, e] of Object.entries(lp.joints)) {
        const cur = pose.joints[j as Joint] ?? [0, 0, 0];
        pose.joints = { ...pose.joints, [j]: [cur[0] + e![0], cur[1] + e![1], cur[2] + e![2]] };
        if (j === 'neck') layerNeck = add3(layerNeck, e);
      }
    }
    const on = this.behaviour.locomotionOnset === 'synchronized' ? this.onsetAt(t) : undefined;
    if (on) {
      // swing leg: lift off from where the foot stood, arc to where the gait lands it (no toe drag, no pop at hand-off)
      const o = on.o, k = smooth01(on.u);
      const wx = o.swingStartW[0] + (o.swingEndW[0] - o.swingStartW[0]) * k, wz = o.swingStartW[2] + (o.swingEndW[2] - o.swingStartW[2]) * k;
      const inv = qEuler(0, -root.yaw * DEG, 0);
      const lp = qRotate(inv, [wx - root.pos[0], 0, wz - root.pos[2]]);
      const ly = o.swingStartY + (o.swingEndY - o.swingStartY) * k + o.clearance * Math.sin(Math.PI * on.u);
      const d = rig.dims, hj = o.swing === 'l' ? 'hip_l' : 'hip_r', kj = o.swing === 'l' ? 'knee_l' : 'knee_r';
      // no ankle joint: the foot tilts with the shin, so the toe (or heel) dips by halfFoot * |sin(shin angle)|; raise the
      // sole target by that amount so the lowest point of the shoe follows the lift curve instead of scraping the floor
      const halfFoot = (rig.manifest.body.legWidth + 0.11) / 2;
      let ik = legIk(ly - d.legLen, lp[2], d.upperLeg, d.lowerLeg, 0.045);
      for (let it = 0; it < 3; it++) ik = legIk(ly + halfFoot * Math.abs(Math.sin((ik.hip + ik.knee) * DEG)) - d.legLen, lp[2], d.upperLeg, d.lowerLeg, 0.045);
      const hand = smooth01((on.u - 0.8) / 0.2); // last 20 %: hand the leg back to the gait's own touchdown pose
      const gh = pose.joints[hj] ?? [0, 0, 0], gk = pose.joints[kj] ?? [0, 0, 0];
      pose.joints = { ...pose.joints, [hj]: [ik.hip + (gh[0] - ik.hip) * hand, gh[1], gh[2]], [kj]: [ik.knee + (gk[0] - ik.knee) * hand, gk[1], gk[2]] };
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
    if (on) {
      // the planted stance sole stays exactly on its anchor: shift the body, never the foot
      const sole = (on.o.stance === 'l' ? rig.sole_l : rig.sole_r).worldPos();
      rig.root.pos = [rig.root.pos[0] + on.o.anchor[0] - sole[0], 0, rig.root.pos[2] + on.o.anchor[2] - sole[2]];
      rig.root.updateWorld();
    }
    // look-at (only when upright)
    if (pose.lookAt && Math.abs(pitch) < 5 && (pose.lookWeight ?? 0) > 0.01) {
      const neck = rig.joints.neck;
      const hp = add(neck.worldPos(), [0, rig.dims.headH * 0.5, 0]);
      const d = sub(pose.lookAt, hp);
      const spineQ = qFromMat(rig.joints.spine.world);
      const local = rotInv(spineQ, d);
      const yaw = clamp(Math.atan2(local[0], local[2]) / DEG, -LOOK_LIMITS.yaw, LOOK_LIMITS.yaw);
      const pitchL = clamp(-Math.atan2(local[1], Math.hypot(local[0], local[2])) / DEG, -LOOK_LIMITS.pitchUp, LOOK_LIMITS.pitchDown);
      const w = pose.lookWeight ?? 1;
      const layered = this.behaviour.headLayersOverLookAt;
      // legacy blends from the neck INCLUDING additive layers, so a look-at of weight w scales head_shake by (1 - w);
      // corrected blends from the pose's own neck and re-applies the layers on top afterwards
      const from = (layered ? baseNeck : pose.joints.neck) ?? [0, 0, 0];
      if (this.behaviour.lookAt === 'euler-spine-pitch') {
        // legacy-head-v1 (frozen): the pre-versioning math, unchanged. qEuler(pitch, yaw) is Rx * Ry, i.e. the pitch is
        // applied about the SPINE's x axis: with the head turned by psi the gaze only drops asin(cos psi * sin theta).
        const e: Vec3 = [from[0] + (pitchL - from[0]) * w, from[1] + (yaw - from[1]) * w, from[2] * (1 - w)];
        if (layered && layerNeck) { e[0] += layerNeck[0]; e[1] += layerNeck[1]; e[2] += layerNeck[2]; }
        neck.rot = qEuler(e[0] * DEG, e[1] * DEG, e[2] * DEG);
      } else {
        // corrected: yaw about the spine's up axis THEN pitch about the turned head's own x axis (Ry * Rx)
        // (action reel: 30 deg needed, 17.1 deg reached under legacy with the head turned 54 deg; 30.1 deg here)
        const look = qMul(qEuler(0, yaw * DEG, 0), qEuler(pitchL * DEG, 0, 0));
        let q = w >= 0.999 ? look : qSlerp(qEuler(from[0] * DEG, from[1] * DEG, from[2] * DEG), look, w);
        // additive layers (head_shake) ride on top of the gaze, in the head's own frame
        if (layered && layerNeck) q = qMul(q, qEuler(layerNeck[0] * DEG, layerNeck[1] * DEG, layerNeck[2] * DEG));
        neck.rot = q;
      }
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
