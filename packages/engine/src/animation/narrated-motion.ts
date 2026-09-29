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
}
export interface MotionResult { rootWorld: Vec3; groundOffset: number; stance: 'l' | 'r' | undefined; soleL: Vec3; soleR: Vec3; handError?: number; expressionApplied: boolean }

function rotInv(q: Quat, v: Vec3): Vec3 { const c = qConj(q), p = qMul(qMul(c, [v[0], v[1], v[2], 0]), q); return [p[0], p[1], p[2]]; }

/** Apply one motion frame to a rig (overwrites every root / joint transform; world matrices are updated). */
export function applyMotionFrame(rig: Rig, f: MotionFrame): MotionResult {
  const pose = f.pose, x = f.root[0], z = f.root[2];
  rig.root.pos = [x, 0, z];
  rig.root.rot = qMul(qEuler(f.pitchDeg * DEG, 0, 0), qEuler(0, f.yawDeg * DEG, 0));
  const il = f.idle ? idleLayer(f.t, f.seed % 1000, f.idle) : {};
  const layer: JointPose = {};
  for (const l of f.layers ?? []) for (const [j, e] of Object.entries(l)) { const c = layer[j as Joint] ?? [0, 0, 0]; layer[j as Joint] = [c[0] + e![0], c[1] + e![1], c[2] + e![2]]; }
  const sum = (...v: Array<Vec3 | undefined>): Vec3 => v.reduce<Vec3>((a, b) => [a[0] + (b?.[0] ?? 0), a[1] + (b?.[1] ?? 0), a[2] + (b?.[2] ?? 0)], [0, 0, 0]);
  // look-at fades out continuously as the body pitches (no snap when a fall starts)
  const lookW = f.lookAt ? clamp(f.lookWeight ?? 1, 0, 1) * (1 - smoothstep(Math.abs(f.pitchDeg) / 25)) : 0;
  for (const j of JOINTS) { const e = j === 'neck' && lookW > 0.01 ? sum(pose.joints[j], il[j]) : sum(pose.joints[j], il[j], layer[j]); rig.joints[j].rot = qEuler(e[0] * DEG, e[1] * DEG, e[2] * DEG); }
  rig.root.updateWorld();
  if (lookW > 0.01 && f.lookAt) {
    // yaw about the spine's up axis, then pitch about the turned head's x axis; additive neck layers ride on top
    const neck = rig.joints.neck, hp = add(neck.worldPos(), [0, rig.dims.headH * 0.5, 0]);
    const local = rotInv(qFromMat(rig.joints.spine.world), sub(f.lookAt, hp));
    const yaw = clamp(Math.atan2(local[0], local[2]) / DEG, -LOOK_LIMITS.yaw, LOOK_LIMITS.yaw);
    const pit = clamp(-Math.atan2(local[1], Math.hypot(local[0], local[2])) / DEG, -LOOK_LIMITS.pitchUp, LOOK_LIMITS.pitchDown);
    const from = sum(pose.joints.neck, il.neck), look = qMul(qEuler(0, yaw * DEG, 0), qEuler(pit * DEG, 0, 0));
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
  return { rootWorld: [...rig.root.pos] as Vec3, groundOffset, stance: pose.stance, soleL: rig.sole_l.worldPos(), soleR: rig.sole_r.worldPos(), handError, expressionApplied };
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
