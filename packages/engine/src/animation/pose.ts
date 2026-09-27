import type { Joint } from '../build.ts';
import type { Vec3 } from '../math.ts';

/** Euler degrees per joint (XYZ). Absolute pose (not additive). */
export type JointPose = Partial<Record<Joint, Vec3>>;

export interface IkRequest { arm: 'l' | 'r'; target: Vec3; weight: number; /** pole hint in actor-local space */ pole?: Vec3; /** target is in actor-local space (x = actor's left, y = up from feet, z = forward) */ local?: boolean }

export interface ActionPose {
  joints: JointPose;
  ik?: IkRequest[];
  /** extra height above grounded position (jumps, hops) */
  lift?: number;
  /** root pitch in degrees (+ = fall forward onto the belly, - = fall backward) */
  pitch?: number;
  /** how the rig is grounded: feet (default), all probes (lying), none (airborne handled by lift) */
  ground?: 'feet' | 'all';
  /** locomotion: which foot is planted (grounding uses only this foot => no sliding) */
  stance?: 'l' | 'r';
  /** amplitude of nervous tremble (deg) */
  tremble?: number;
  /** suppress idle breathing */
  still?: boolean;
  /** world point the head should aim at (null = keep pose) */
  lookAt?: Vec3 | null;
  /** 0..1 how strongly the look-at overrides the pose's neck */
  lookWeight?: number;
}

/** keyframe interpolation on normalized time u with smoothstep easing between keys */
export function K(u: number, keys: Array<[number, number]>): number {
  if (u <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (u <= keys[i][0]) {
      const [t0, v0] = keys[i - 1], [t1, v1] = keys[i];
      const x = (u - t0) / Math.max(1e-6, t1 - t0);
      const s = x * x * (3 - 2 * x);
      return v0 + (v1 - v0) * s;
    }
  }
  return keys[keys.length - 1][1];
}
export function KV(u: number, keys: Array<[number, Vec3]>): Vec3 {
  return [0, 1, 2].map((i) => K(u, keys.map(([t, v]) => [t, v[i]] as [number, number]))) as Vec3;
}

export function blendPose(a: JointPose, b: JointPose, w: number): JointPose {
  const out: JointPose = {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<Joint>;
  for (const k of keys) {
    const x = a[k] ?? [0, 0, 0], y = b[k] ?? [0, 0, 0];
    out[k] = [x[0] + (y[0] - x[0]) * w, x[1] + (y[1] - x[1]) * w, x[2] + (y[2] - x[2]) * w];
  }
  return out;
}
export function blendAction(a: ActionPose, b: ActionPose, w: number): ActionPose {
  const lerp = (x = 0, y = 0) => x + (y - x) * w;
  const ik: IkRequest[] = [
    ...(a.ik ?? []).map((r) => ({ ...r, weight: r.weight * (1 - w) })),
    ...(b.ik ?? []).map((r) => ({ ...r, weight: r.weight * w })),
  ].filter((r) => r.weight > 0.001);
  const groundAll = (a.ground === 'all' ? 1 - w : 0) + (b.ground === 'all' ? w : 0);
  return {
    joints: blendPose(a.joints, b.joints, w),
    ik,
    lift: lerp(a.lift, b.lift),
    pitch: lerp(a.pitch, b.pitch),
    ground: groundAll > 0.5 ? 'all' : 'feet',
    stance: w > 0.5 ? b.stance : a.stance,
    tremble: lerp(a.tremble, b.tremble),
    still: w > 0.5 ? b.still : a.still,
    lookAt: w > 0.5 ? (b.lookAt ?? a.lookAt) : (a.lookAt ?? b.lookAt),
    lookWeight: lerp(a.lookAt ? (a.lookWeight ?? 1) : 0, b.lookAt ? (b.lookWeight ?? 1) : 0),
  };
}
