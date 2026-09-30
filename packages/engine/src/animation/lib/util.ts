// Small helpers shared by the library action poses (pure; no state).
import { DEG, clamp, qEuler, qRotate, type Vec3 } from '../../math.ts';
import type { ActionCtx } from '../actions.ts';
import type { BodyDims, LibActionCtx } from './types.ts';
import type { JointPose } from '../pose.ts';

export const ss = (x: number): number => { const c = clamp(x, 0, 1); return c * c * (3 - 2 * c); };
/** 0 before a, 1 after b, smooth in between */
export const ramp = (u: number, a: number, b: number): number => ss((u - a) / Math.max(1e-6, b - a));
/** 1 inside [a, b] with smooth edges of width e (0 outside) */
export const window = (u: number, a: number, b: number, e: number): number => ramp(u, a - e, a) * (1 - ramp(u, b, b + e));
export const frac = (x: number): number => x - Math.floor(x);

export const num = (c: ActionCtx, k: string, d: number): number => { const v = c.params[k]; return typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'boolean' ? (v ? 1 : 0) : d; };
export const flag = (c: ActionCtx, k: string): boolean => { const v = c.params[k]; return v === true || (typeof v === 'number' && v > 0) || v === 'true'; };

/** fallback proportions (zapp) when the ctx does not carry the rig's */
export const DEFAULT_BODY: BodyDims = { legLen: 0.8, torsoH: 0.6, headH: 0.52, headD: 0.5, upperArm: 0.32, lowerArm: 0.3, shoulderX: 0.35, shoulderY: 0.515 };
export const bodyOf = (c: ActionCtx): BodyDims => (c as LibActionCtx).body ?? { ...DEFAULT_BODY, legLen: c.loco?.legLen ?? DEFAULT_BODY.legLen };

/**
 * Actor-local point on the head (x = actor's left, y = up from the feet, z = forward) for a given spine / neck pitch
 * (deg, + = forward), by sagittal forward kinematics of the rig (hips at legLen, neck at the top of the torso).
 * `up` / `fwd` are in the head's own frame from the neck joint (e.g. the mouth: up = 0.3 headH, fwd = headD / 2).
 */
export function headPoint(c: ActionCtx, spineX: number, neckX: number, up: number, fwd: number, x = 0): Vec3 {
  const b = bodyOf(c), n = b.torsoH + 0.012, s = spineX * DEG, a = (spineX + neckX) * DEG;
  return [x, b.legLen + n * Math.cos(s) + up * Math.cos(a) - fwd * Math.sin(a), n * Math.sin(s) + up * Math.sin(a) + fwd * Math.cos(a)];
}
/** mouth point (slightly in front of the lips) for the given spine / neck pitch */
export const mouthPoint = (c: ActionCtx, spineX: number, neckX: number, ahead = 0.06): Vec3 => { const b = bodyOf(c); return headPoint(c, spineX, neckX, b.headH * 0.16, b.headD / 2 + ahead); };
/** eye-level point in front of the face (hands to eyes when crying) */
export const eyePoint = (c: ActionCtx, spineX: number, neckX: number, x: number, ahead = 0.05): Vec3 => { const b = bodyOf(c); return headPoint(c, spineX, neckX, b.headH * 0.55, b.headD / 2 + ahead, x); };
/** chest-height point in front of the torso, spine pitch applied */
export function chestPoint(c: ActionCtx, spineX: number, x: number, fwd: number, upFrac = 0.62): Vec3 {
  const b = bodyOf(c), s = spineX * DEG, h = b.torsoH * upFrac;
  return [x, b.legLen + h * Math.cos(s) - fwd * Math.sin(s), h * Math.sin(s) + fwd * Math.cos(s)];
}

/** world offset along the actor's own left (+) / right (-) axis */
export function sideways(c: ActionCtx, p: Vec3, dx: number, dy = 0, dz = 0): Vec3 {
  const yaw = (c as LibActionCtx).root?.yaw ?? 0, o = qRotate(qEuler(0, yaw * DEG, 0), [dx, dy, dz]);
  return [p[0] + o[0], p[1] + o[1], p[2] + o[2]];
}

/** joint-wise a + (b - a) * w (absent joints = 0); w outside 0..1 extrapolates (overshoot past the target pose) */
export function mix(a: JointPose, b: JointPose, w: number): JointPose {
  if (w === 0) return { ...a };
  if (w === 1) return { ...b };
  const out: JointPose = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof JointPose>) {
    const x = a[k] ?? [0, 0, 0], y = b[k] ?? [0, 0, 0];
    out[k] = [x[0] + (y[0] - x[0]) * w, x[1] + (y[1] - x[1]) * w, x[2] + (y[2] - x[2]) * w];
  }
  return out;
}
/** joint-wise sum (additive layers on top of a base pose) */
export function plus(a: JointPose, b: JointPose): JointPose {
  const out: JointPose = { ...a };
  for (const [k, v] of Object.entries(b) as Array<[keyof JointPose, Vec3]>) { const x = out[k] ?? [0, 0, 0]; out[k] = [x[0] + v[0], x[1] + v[1], x[2] + v[2]]; }
  return out;
}
