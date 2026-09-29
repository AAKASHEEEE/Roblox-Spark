// Generic procedural motion applier: puts a rig into a pose whose ROOT is dictated by an external authority (e.g. the
// narrated WorldState) instead of by ActorTrack's own root-motion compiler. Joint poses come from the existing
// procedural action library (actions.ts); no authored clips. Root x/z, yaw, planned vertical offset and body pitch are
// applied verbatim; the only engine-side root change is the vertical grounding offset (lowest foot / body probe on y=0).
// Pure function of its input: the previous state of the rig nodes never influences the result.
import type { Joint, Rig } from '../build.ts';
import { JOINTS } from '../build.ts';
import { DEG, clamp, qConj, qEuler, qFromMat, qMul, qRotate, qSlerp, add, sub, type Quat, type Vec3 } from '../math.ts';
import type { ActionName } from '../../../schema/src/episode.ts';
import { ACTION_DEFS, IDLE_POSE, idleLayer, unmetRequirements, type ActionCtx } from './actions.ts';
import { blendAction, type ActionPose, type JointPose } from './pose.ts';
import { LOOK_LIMITS, solveArmIk } from './animator.ts';

/** minimum procedural transition between two body actions (replaces the 0.05-0.15 s blendIn snaps) */
export const MIN_BLEND_SEC = 0.3;
/** transition back to idle after a non-holding action ends (same as ActorTrack) */
export const RELEASE_BLEND_SEC = 0.3;
/** look-target switches cross-fade over this window */
export const LOOK_BLEND_SEC = 0.35;

export const smoothstep = (x: number): number => { const c = clamp(x, 0, 1); return c * c * (3 - 2 * c); };
/** deterministic transition weight for an action that started lt seconds ago */
export function transitionWeight(lt: number, blendSec: number): number { return blendSec <= 1e-9 ? 1 : smoothstep(lt / blendSec); }
/** blend window for an action of duration d: never shorter than MIN_BLEND_SEC, never more than 40 % of the action */
export function blendWindow(action: string, d: number): number {
  const def = ACTION_DEFS[action as ActionName];
  return Math.min(Math.max(def?.blendIn ?? 0, MIN_BLEND_SEC), Math.max(0.05, 0.4 * d));
}

/** true when the procedural library can play `action` with the engine features that exist (no hand attachment etc.) */
export function hasProceduralAction(action: string): boolean {
  const def = ACTION_DEFS[action as ActionName];
  return !!def && unmetRequirements(action as ActionName).length === 0;
}

export interface PoseCtx { lt: number; d: number; t: number; seed: number; target?: Vec3; params?: Record<string, number | string | boolean>; legLen: number }
/** evaluate a procedural action pose (throws for unknown actions: callers must check hasProceduralAction) */
export function actionPose(action: string, c: PoseCtx): ActionPose {
  const def = ACTION_DEFS[action as ActionName];
  if (!def) throw new Error(`procedural action ${action} does not exist`);
  const d = Math.max(c.d, 1e-4), lt = clamp(c.lt, 0, d);
  const ctx: ActionCtx = { lt, d, u: lt / d, t: c.t, seed: c.seed, target: c.target, params: c.params ?? {}, loco: { dist: 0, speed: 0, run: false, legLen: c.legLen, total: 0 } };
  return def.pose(ctx);
}

/**
 * Distance-driven walk gait. `dist` is the distance travelled along the path (the ONLY phase driver), `total` the
 * whole path length (whole stances: the gait starts and ends at mid-stance with the feet under the hips).
 */
export function gaitPose(dist: number, total: number, speed: number, legLen: number, t: number, seed: number): ActionPose {
  return ACTION_DEFS.walk.pose({ lt: 0, d: 1, u: 0, t, seed, params: {}, loco: { dist, speed, run: false, legLen, total } });
}

/**
 * Belly-down prone pose for a body lying along its root's +y axis once pitched 90 deg: legs straight and flat (no bent
 * knees poking upward), arms forward beside the head, head raised so the face stays readable. Root pitch is applied
 * separately (by the caller, from the world state).
 */
export function pronePose(): ActionPose {
  return {
    joints: {
      hips: [0, 0, 0], spine: [6, 0, 0], neck: [-55, 0, 0],
      shoulder_l: [-165, 0, 18], shoulder_r: [-165, 0, -18], elbow_l: [-12, 0, 0], elbow_r: [-12, 0, 0],
      hip_l: [0, 0, 4], hip_r: [0, 0, -4], knee_l: [2, 0, 0], knee_r: [2, 0, 0],
    },
    ground: 'all', still: true,
  };
}
/** pushed-forward pose used while the body pitches into the fall (chest and head lead, away from a load behind) */
export function fallLeadPose(): ActionPose {
  return { joints: { ...IDLE_POSE, spine: [18, 0, 0], neck: [14, 0, 0], shoulder_l: [-70, 0, 30], shoulder_r: [-70, 0, -30], elbow_l: [-30, 0, 0], elbow_r: [-30, 0, 0] }, still: true };
}
/** additive flinch: spine and neck flex forward (keeps the head clear of a load arriving from behind); arms keep their IK */
export function braceLayer(pose: ActionPose, w: number): ActionPose {
  if (w <= 0) return pose;
  const j = { ...pose.joints }, s = j.spine ?? [0, 0, 0], n = j.neck ?? [0, 0, 0];
  j.spine = [s[0] + 20 * w, s[1] * (1 - w), s[2] * (1 - w)]; j.neck = [n[0] + 16 * w, n[1] * (1 - w), n[2] * (1 - w)];
  return { ...pose, joints: j, still: true };
}
/**
 * Time fraction of a fall whose planned pitch follows 90 * smoothstep(u) (world.ts fall_prone): the exact inverse of
 * smoothstep, so head motion can be spread evenly over the fall without reading any clock or history.
 */
export function fallTimeFraction(pitchDeg: number): number { const x = clamp(pitchDeg / 90, 0, 1); return 0.5 - Math.sin(Math.asin(1 - 2 * x) / 3); }
/** fall pose at blend u (0 = start of the fall, 1 = prone): lead forward first, then settle into prone */
export function fallPose(from: ActionPose, u: number): ActionPose {
  const x = clamp(u, 0, 1);
  const lead = blendPoses(from, fallLeadPose(), smoothstep(x / 0.35));
  return blendPoses(lead, pronePose(), smoothstep((x - 0.35) / 0.65));
}
/**
 * Procedural jump matched to a planned parabolic root: no pre-crouch (the planned root leaves the floor at once),
 * legs tuck and arms rise with sin(pi u), so feet leave and return to the floor exactly with the planned root.
 */
export function jumpPose(u: number): ActionPose {
  const a = Math.sin(Math.PI * clamp(u, 0, 1));
  return {
    joints: {
      ...IDLE_POSE, spine: [6 * a, 0, 0], neck: [-6 * a, 0, 0],
      hip_l: [-28 * a, 0, 3], knee_l: [48 * a, 0, 0], hip_r: [-28 * a, 0, -3], knee_r: [48 * a, 0, 0],
      shoulder_l: [-120 * a, 0, 10 + 25 * a], shoulder_r: [-120 * a, 0, -10 - 25 * a], elbow_l: [-20, 0, 0], elbow_r: [-20, 0, 0],
    },
  };
}
/** safe neutral upper-body pose used when an authored posture (e.g. seated) does not exist */
export function neutralUpperBodyPose(): ActionPose { return { joints: { ...IDLE_POSE }, still: true }; }

export const blendPoses = (a: ActionPose, b: ActionPose, w: number): ActionPose => (w <= 0 ? a : w >= 1 ? b : blendAction(a, b, w));

export interface MotionFrame {
  t: number;
  seed: number;
  /** authoritative root (feet) position; y is the PLANNED vertical displacement (0 on the floor, jump height in the air) */
  root: Vec3;
  yawDeg: number;
  /** body pitch about the WORLD x axis (+ tips the body toward +z, pivoting on the feet) */
  pitchDeg: number;
  /** joint pose; its lift / pitch fields are ignored (the root is authoritative) */
  pose: ActionPose;
  /** additive joint layers (e.g. head_shake) */
  layers?: JointPose[];
  lookAt?: Vec3 | null;
  lookWeight?: number;
  /** idle breathing amount (0 = none) */
  idle?: number;
  /** 'feet' grounds the stance foot (or both feet), 'all' grounds the lowest body probe (falling / lying) */
  ground: 'feet' | 'all';
  expression?: string;
  /**
   * filtered head drive (see filterHeadDrive). When present it REPLACES the pose's spine / neck joints, the idle layer on
   * them and lookAt / lookWeight; neck layers (head_shake) are still added on top.
   */
  head?: HeadDrive;
}
export interface MotionResult {
  rootWorld: Vec3; groundOffset: number; stance: 'l' | 'r' | undefined; soleL: Vec3; soleR: Vec3; handError?: number; expressionApplied: boolean;
  /** the 8 head-box corners in the ROOT frame (root position incl. grounding, root yaw + pitch removed) */
  headLocal: Vec3[];
  /** head (neck joint) orientation relative to the root frame */
  headQuatLocal: Quat;
}

// ---------- deterministic head / look filter ----------
/**
 * The upper chain that moves the head relative to the root: spine and neck Euler targets (pose + idle breathing) and
 * the look direction expressed in the ROOT frame (so root travel / turning is never mistaken for a head move).
 */
export interface HeadDrive {
  spine: Vec3; neck: Vec3; lookYaw: number; lookPitch: number; lookWeight: number; hasLook: boolean;
  /** additive neck layer (head_shake), rate-limited without easing so the gesture keeps its phase */
  layerNeck?: Vec3;
  /**
   * world-timed body motion (falling / prone): spine and neck pass through unfiltered so the contact-driven fall, the
   * grounding and the coin clearance are never delayed (see fallHeadDrive for how the fall itself stays smooth)
   */
  direct?: boolean;
  /** explicit neck orientation (spine-local); replaces neck Euler + look-at when present */
  neckQuat?: Quat;
}
export const HEAD_FILTER = {
  /** fixed evaluation grid (Hz): results depend only on t, never on the order frames are sampled in */
  hz: 60,
  /** finite memory: the filter is replayed over this window before t (pure function of t, no mutable history) */
  windowSec: 2.0,
  /** first-order ease time constant: a new target moves the head on the very next grid step, ~95 % after 3 tau */
  tauSec: 0.07,
  /** angular speed limits (deg/s) */
  maxSpineDegPerSec: 50,
  maxNeckDegPerSec: 110,
  maxLookDegPerSec: 150,
  maxLookWeightPerSec: 3,
  maxLayerDegPerSec: 300,
  /** fraction of the gaze speed yielded while spine / neck move at their limit */
  lookYield: 0.6,
} as const;
export type HeadFilterConfig = { [K in keyof typeof HEAD_FILTER]: number };

const wrap180 = (d: number): number => { let x = d % 360; if (x > 180) x -= 360; if (x < -180) x += 360; return x; };
/** look direction toward `target` from a head at `headY` above the root, as (yaw, pitch-down) degrees in the root frame */
export function lookAnglesInRoot(root: Vec3, yawDeg: number, headY: number, target: Vec3): { yaw: number; pitch: number } {
  const d: Vec3 = [target[0] - root[0], target[1] - (root[1] + headY), target[2] - root[2]];
  const l = qRotate(qEuler(0, -yawDeg * DEG, 0), d);
  // clamped to the neck limits HERE (before filtering): a target passing behind the actor then eases from one limit to
  // the other instead of flipping +75 -> -75 deg in a single frame after the filter
  return { yaw: clamp(Math.atan2(l[0], l[2]) / DEG, -LOOK_LIMITS.yaw, LOOK_LIMITS.yaw), pitch: clamp(-Math.atan2(l[1], Math.hypot(l[0], l[2])) / DEG, -LOOK_LIMITS.pitchUp, LOOK_LIMITS.pitchDown) };
}
function limitVec(from: Vec3, to: Vec3, k: number, maxStep: number): Vec3 {
  const m: Vec3 = [(to[0] - from[0]) * k, (to[1] - from[1]) * k, (to[2] - from[2]) * k], n = Math.hypot(m[0], m[1], m[2]);
  const s = n > maxStep ? maxStep / n : 1;
  return [from[0] + m[0] * s, from[1] + m[1] * s, from[2] + m[2] * s];
}
function stepHead(x: HeadDrive, d: HeadDrive, dt: number, c: HeadFilterConfig): HeadDrive {
  const k = 1 - Math.exp(-dt / c.tauSec);
  const spine: Vec3 = d.direct ? [...d.spine] as Vec3 : limitVec(x.spine, d.spine, k, c.maxSpineDegPerSec * dt), neck: Vec3 = d.direct ? [...d.neck] as Vec3 : limitVec(x.neck, d.neck, k, c.maxNeckDegPerSec * dt);
  // shared budget: while the body reaction (spine / neck) is moving fast, the gaze turn yields up to half its speed, so
  // a simultaneous recoil + look never adds up to a head snap; a look on its own keeps its full speed
  const busy = Math.max(Math.hypot(spine[0] - x.spine[0], spine[1] - x.spine[1], spine[2] - x.spine[2]) / (c.maxSpineDegPerSec * dt), Math.hypot(neck[0] - x.neck[0], neck[1] - x.neck[1], neck[2] - x.neck[2]) / (c.maxNeckDegPerSec * dt));
  const lookBudget = c.maxLookDegPerSec * dt * (1 - c.lookYield * clamp(busy, 0, 1));
  let lookYaw = x.lookYaw, lookPitch = x.lookPitch;
  if (d.hasLook) {
    if (x.lookWeight < 0.02) { lookYaw = d.lookYaw; lookPitch = d.lookPitch; } // invisible while the weight is ~0
    else {
      const dy = wrap180(d.lookYaw - x.lookYaw) * k, dp = (d.lookPitch - x.lookPitch) * k, n = Math.hypot(dy, dp), mx = lookBudget, s = n > mx ? mx / n : 1;
      lookYaw = wrap180(x.lookYaw + dy * s); lookPitch = x.lookPitch + dp * s;
    }
  }
  if (d.direct) return { spine, neck, lookYaw: d.hasLook ? d.lookYaw : lookYaw, lookPitch: d.hasLook ? d.lookPitch : lookPitch, lookWeight: d.lookWeight, hasLook: d.hasLook || d.lookWeight > 1e-3, direct: true, layerNeck: d.layerNeck };
  const dw = clamp((d.lookWeight - x.lookWeight) * k, -c.maxLookWeightPerSec * dt, c.maxLookWeightPerSec * dt);
  const layerNeck = limitVec(x.layerNeck ?? [0, 0, 0], d.layerNeck ?? [0, 0, 0], 1, c.maxLayerDegPerSec * dt);
  return { spine, neck, lookYaw, lookPitch, lookWeight: clamp(x.lookWeight + dw, 0, 1), hasLook: d.hasLook || x.lookWeight + dw > 1e-3, direct: d.direct, layerNeck };
}
/**
 * Effective neck orientation (spine-local) of a head drive, computed without forward kinematics: the look direction is
 * given in the root frame and the spine's frame is root * hips * spine, with hips at rest (true for every narrated pose
 * that uses a head drive). Same yaw-then-pitch look model and joint limits as applyMotionFrame.
 */
export function headNeckQuat(d: HeadDrive): Quat {
  if (d.neckQuat) return d.neckQuat;
  const neck = qEuler(d.neck[0] * DEG, d.neck[1] * DEG, d.neck[2] * DEG);
  if (!d.hasLook || d.lookWeight <= 0.01) return neck;
  const y = d.lookYaw * DEG, p = d.lookPitch * DEG;
  const l = rotInv(qEuler(d.spine[0] * DEG, d.spine[1] * DEG, d.spine[2] * DEG), [Math.sin(y) * Math.cos(p), -Math.sin(p), Math.cos(y) * Math.cos(p)]);
  const yaw = clamp(Math.atan2(l[0], l[2]) / DEG, -LOOK_LIMITS.yaw, LOOK_LIMITS.yaw), pit = clamp(-Math.atan2(l[1], Math.hypot(l[0], l[2])) / DEG, -LOOK_LIMITS.pitchUp, LOOK_LIMITS.pitchDown);
  const look = qMul(qEuler(0, yaw * DEG, 0), qEuler(pit * DEG, 0, 0));
  return d.lookWeight >= 0.999 ? look : qSlerp(neck, look, d.lookWeight);
}
/**
 * Head drive through a world-timed fall: from the (filtered) head at the contact instant to the prone head at CONSTANT
 * angular speed over the fall's time (recovered from the planned pitch), so the eased body pitch and the fading look-at
 * never combine into a late whip. Pure function of (head at contact, pitch).
 */
export function fallHeadDrive(atContact: HeadDrive, pitchDeg: number): HeadDrive {
  const e = Math.min(1, fallTimeFraction(pitchDeg) / 0.92), p = pronePose().joints, s0 = atContact.spine, s1 = p.spine!;
  return {
    spine: [s0[0] + (s1[0] - s0[0]) * e, s0[1] + (s1[1] - s0[1]) * e, s0[2] + (s1[2] - s0[2]) * e], neck: [...p.neck!] as Vec3,
    lookYaw: atContact.lookYaw, lookPitch: atContact.lookPitch, lookWeight: 0, hasLook: false, direct: true,
    neckQuat: qSlerp(headNeckQuat(atContact), qEuler(p.neck![0] * DEG, p.neck![1] * DEG, p.neck![2] * DEG), e),
  };
}
/**
 * Deterministic, rate-limited, eased head drive at time t. `driveAt` must be a pure function of time (callers may cache
 * it by time). The filter restarts from the raw drive at a fixed grid point windowSec before t and replays the grid up
 * to t, so direct sampling of t and sequential playback give bit-identical results and seeking has no hidden state.
 * Responds on the first grid step after a change; eases over ~3 tau; per-step change never exceeds the speed limits.
 */
export function filterHeadDrive(driveAt: (t: number) => HeadDrive, t: number, cfg: HeadFilterConfig = HEAD_FILTER): HeadDrive {
  const h = 1 / cfg.hz, j1 = Math.floor(t * cfg.hz + 1e-6), j0 = Math.max(0, j1 - Math.round(cfg.windowSec * cfg.hz));
  let x = driveAt(j0 * h);
  for (let j = j0 + 1; j <= j1; j++) x = stepHead(x, driveAt(j * h), h, cfg);
  const rem = t - j1 * h;
  return rem > 1e-9 ? stepHead(x, driveAt(t), rem, cfg) : x;
}

function rotInv(q: Quat, v: Vec3): Vec3 { const c = qConj(q), p = qMul(qMul(c, [v[0], v[1], v[2], 0]), q); return [p[0], p[1], p[2]]; }

/** Apply one motion frame to a rig (overwrites every root / joint transform; world matrices are updated). */
export function applyMotionFrame(rig: Rig, f: MotionFrame): MotionResult {
  const pose = f.pose, x = f.root[0], z = f.root[2];
  rig.root.pos = [x, 0, z];
  rig.root.rot = qMul(qEuler(f.pitchDeg * DEG, 0, 0), qEuler(0, f.yawDeg * DEG, 0));
  const il = f.idle ? idleLayer(f.t, f.seed % 1000, f.idle) : {};
  const layer: JointPose = {};
  for (const l of f.layers ?? []) for (const [j, e] of Object.entries(l)) { const c = layer[j as Joint] ?? [0, 0, 0]; layer[j as Joint] = [c[0] + e![0], c[1] + e![1], c[2] + e![2]]; }
  if (f.head) { if (f.head.layerNeck && Math.hypot(...f.head.layerNeck) > 1e-9) layer.neck = [...f.head.layerNeck] as Vec3; else delete layer.neck; }
  const sum = (...v: Array<Vec3 | undefined>): Vec3 => v.reduce<Vec3>((a, b) => [a[0] + (b?.[0] ?? 0), a[1] + (b?.[1] ?? 0), a[2] + (b?.[2] ?? 0)], [0, 0, 0]);
  const hd = f.head;
  // look-at fades out continuously as the body pitches (no snap when a fall starts); a head drive carries its own weight
  const lookW = hd ? (hd.hasLook ? clamp(hd.lookWeight, 0, 1) : 0) : f.lookAt ? clamp(f.lookWeight ?? 1, 0, 1) * (1 - smoothstep(Math.abs(f.pitchDeg) / 25)) : 0;
  const base = (j: Joint): Vec3 => (hd && j === 'spine' ? hd.spine : hd && j === 'neck' ? hd.neck : sum(pose.joints[j], il[j]));
  for (const j of JOINTS) { const e = j === 'neck' && lookW > 0.01 ? base(j) : sum(base(j), layer[j]); rig.joints[j].rot = qEuler(e[0] * DEG, e[1] * DEG, e[2] * DEG); }
  rig.root.updateWorld();
  // look direction: from the head drive (root-frame angles) or from a world look-at point
  let lookDir: Vec3 | null = null;
  if (hd?.neckQuat) { rig.joints.neck.rot = layer.neck ? qMul(hd.neckQuat, qEuler(layer.neck[0] * DEG, layer.neck[1] * DEG, layer.neck[2] * DEG)) : hd.neckQuat; rig.root.updateWorld(); }
  else if (lookW > 0.01 && hd) { const y = hd.lookYaw * DEG, p = hd.lookPitch * DEG; lookDir = qRotate(rig.root.rot, [Math.sin(y) * Math.cos(p), -Math.sin(p), Math.cos(y) * Math.cos(p)]); } // root frame incl. planned pitch: a fading look never swings the head as the body tips
  else if (lookW > 0.01 && f.lookAt) { const hp = add(rig.joints.neck.worldPos(), [0, rig.dims.headH * 0.5, 0]); lookDir = sub(f.lookAt, hp); }
  if (lookDir) {
    // yaw about the spine's up axis, then pitch about the turned head's x axis; additive neck layers ride on top
    const neck = rig.joints.neck;
    const local = rotInv(qFromMat(rig.joints.spine.world), lookDir);
    const yaw = clamp(Math.atan2(local[0], local[2]) / DEG, -LOOK_LIMITS.yaw, LOOK_LIMITS.yaw);
    const pit = clamp(-Math.atan2(local[1], Math.hypot(local[0], local[2])) / DEG, -LOOK_LIMITS.pitchUp, LOOK_LIMITS.pitchDown);
    const from = base('neck'), look = qMul(qEuler(0, yaw * DEG, 0), qEuler(pit * DEG, 0, 0));
    let q = lookW >= 0.999 ? look : qSlerp(qEuler(from[0] * DEG, from[1] * DEG, from[2] * DEG), look, lookW);
    if (layer.neck) q = qMul(q, qEuler(layer.neck[0] * DEG, layer.neck[1] * DEG, layer.neck[2] * DEG));
    neck.rot = q;
    rig.root.updateWorld();
  }
  let handError: number | undefined;
  // IK keeps running while the body pitches (e.g. crossed arms blending into the fall): local targets ride the root
  for (const ik of pose.ik ?? []) {
    if (ik.weight <= 0.001) continue;
    const tgt: Vec3 = ik.local ? add([x, 0, z], qRotate(rig.root.rot, ik.target)) : ik.target;
    const err = solveArmIk(rig, ik.arm, tgt, ik.weight, ik.pole ?? [0, -0.5, -1], f.yawDeg);
    if (ik.weight > 0.95) handError = err;
  }
  let minY = Infinity;
  for (const p of rig.probes) {
    if (f.ground !== 'all' && !(p.name.includes('toe') || p.name.includes('heel'))) continue;
    if (f.ground !== 'all' && pose.stance && !p.name.endsWith(`_${pose.stance}`)) continue;
    minY = Math.min(minY, p.worldPos()[1]);
  }
  const groundOffset = -minY;
  rig.root.pos = [x, groundOffset + f.root[1], z];
  rig.root.updateWorld();
  let expressionApplied = false;
  if (f.expression && rig.manifest.face.states[f.expression]) { rig.setFace(f.expression, 0); expressionApplied = true; }
  // head measured in the root frame: root travel, turning, grounding and planned body pitch are all removed
  const rq = qConj(rig.root.rot), rp = rig.root.pos, b = rig.manifest.body, hw = b.headSize[0] / 2, hh = b.headSize[1], hdp = b.headSize[2] / 2, nm = rig.joints.neck.world;
  const headLocal: Vec3[] = [];
  for (const cx of [-hw, hw]) for (const cy of [0, hh]) for (const cz of [-hdp, hdp]) {
    const w: Vec3 = [nm[0] * cx + nm[4] * cy + nm[8] * cz + nm[12], nm[1] * cx + nm[5] * cy + nm[9] * cz + nm[13], nm[2] * cx + nm[6] * cy + nm[10] * cz + nm[14]];
    headLocal.push(qRotate(rq, sub(w, rp)));
  }
  const headQuatLocal = qMul(rq, qFromMat(rig.joints.neck.world));
  return { rootWorld: [...rig.root.pos] as Vec3, groundOffset, stance: pose.stance, soleL: rig.sole_l.worldPos(), soleR: rig.sole_r.worldPos(), handError, expressionApplied, headLocal, headQuatLocal };
}

/**
 * Body sample points of a posed rig (world): torso and head box grids in their joint frames, plus limb probes.
 * Used for deterministic prop-penetration checks. `head` marks which points belong to the head.
 */
export function bodySamplePoints(rig: Rig): Array<{ p: Vec3; head: boolean; name: string }> {
  const b = rig.manifest.body, out: Array<{ p: Vec3; head: boolean; name: string }> = [];
  const grid = (node: { world: Float32Array }, w: number, h: number, d: number, y0: number, head: boolean) => {
    for (let i = 0; i <= 2; i++) for (let j = 0; j <= 3; j++) for (let k = 0; k <= 2; k++) {
      const l: Vec3 = [(i / 2 - 0.5) * w, y0 + (j / 3) * h, (k / 2 - 0.5) * d], m = node.world;
      out.push({ name: `${head ? 'head' : 'torso'}_${i}${j}${k}`, p: [m[0] * l[0] + m[4] * l[1] + m[8] * l[2] + m[12], m[1] * l[0] + m[5] * l[1] + m[9] * l[2] + m[13], m[2] * l[0] + m[6] * l[1] + m[10] * l[2] + m[14]], head });
    }
  };
  grid(rig.joints.spine, b.torso[0], b.torso[1], b.torso[2], 0, false);
  grid(rig.joints.neck, b.headSize[0], b.headSize[1], b.headSize[2], 0, true);
  for (const p of rig.probes) if (!p.name.startsWith('probe:head') && !p.name.startsWith('probe:torso')) out.push({ p: p.worldPos(), head: false, name: p.name });
  return out;
}
