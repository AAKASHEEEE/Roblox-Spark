// Hand attachment and thrown-prop flight: the two engine pieces prop interactions need.
// Pure math over already-posed nodes; nothing here reads a clock or keeps state.
import type { Rig } from '../../build.ts';
import { add, clamp, qFromMat, qMul, qRotate, qSlerp, scale, sub, type Quat, type Vec3 } from '../../math.ts';

export interface PropPlacement { pos: Vec3; rot: Quat }

/** world pose of a hand: wrist point and a quaternion whose -y runs down the forearm (from the elbow's world matrix) */
export function handFrame(rig: Rig, hand: 'l' | 'r'): PropPlacement {
  const n = hand === 'l' ? rig.hand_l : rig.hand_r;
  return { pos: n.worldPos(), rot: qFromMat(n.world) };
}

/**
 * Root placement that puts a prop's anchor (local point, prop scale applied) exactly on the hand.
 * `offsetRot` orients the prop relative to the hand (default identity: the prop's up axis points from the fingertips
 * toward the elbow, so a cup stands upright when the forearm hangs down, and its +z faces where the palm faces).
 */
export function attachToHand(rig: Rig, hand: 'l' | 'r', anchorLocal: Vec3, propScale = 1, offsetRot: Quat = [0, 0, 0, 1]): PropPlacement {
  const h = handFrame(rig, hand);
  const rot = qMul(h.rot, offsetRot);
  const pos = sub(h.pos, qRotate(rot, scale(anchorLocal, propScale)));
  return { pos, rot };
}

/** blend a free placement toward the hand attachment (w = 0 free, 1 attached); used for pick-up and release frames */
export function blendPlacement(free: PropPlacement, held: PropPlacement, w: number): PropPlacement {
  const k = clamp(w, 0, 1);
  return { pos: add(free.pos, scale(sub(held.pos, free.pos), k)), rot: qSlerp(free.rot, held.rot, k) };
}

// ---------------------------------------------------------------- thrown props

export const GRAVITY = 9.81;
/** launch velocity that carries a prop from `from` to `to` in `flightSec` under gravity */
export function throwVelocity(from: Vec3, to: Vec3, flightSec: number, g = GRAVITY): Vec3 {
  const T = Math.max(0.05, flightSec);
  return [(to[0] - from[0]) / T, (to[1] - from[1] + 0.5 * g * T * T) / T, (to[2] - from[2]) / T];
}

export interface FlightOpts {
  g?: number;
  /** floor height the prop bounces on (its anchor height above the floor at rest) */
  floorY?: number;
  /** vertical speed kept per bounce (0 = sticks, 0.45 = cartoon bounce) */
  restitution?: number;
  /** horizontal speed kept per bounce */
  friction?: number;
  maxBounces?: number;
  /** tumble speed (deg/s) about the prop's x axis while airborne */
  spinDegPerSec?: number;
}
export interface FlightSample { pos: Vec3; spinDeg: number; airborne: boolean; bounces: number; /** times (s after release) of every floor contact up to now */ impacts: number[]; resting: boolean }

/**
 * Closed-form ballistic flight with floor bounces, `tau` seconds after release. Deterministic and random-access:
 * each bounce is solved analytically, no integration.
 */
export function flightAt(from: Vec3, vel: Vec3, tau: number, o: FlightOpts = {}): FlightSample {
  const g = o.g ?? GRAVITY, floor = o.floorY ?? 0, e = o.restitution ?? 0.4, fr = o.friction ?? 0.6, maxB = o.maxBounces ?? 3, spin = o.spinDegPerSec ?? 540;
  let p: Vec3 = [...from] as Vec3, v: Vec3 = [...vel] as Vec3, t0 = 0, spinDeg = 0;
  const impacts: number[] = [];
  const t = Math.max(0, tau);
  for (let b = 0; b <= maxB; b++) {
    // time until the floor: p.y + v.y s - g s^2 / 2 = floor
    const a = -0.5 * g, bb = v[1], c = p[1] - floor;
    const disc = bb * bb - 4 * a * c;
    const s = disc < 0 ? Infinity : (-bb - Math.sqrt(disc)) / (2 * a);
    const hit = Number.isFinite(s) && s >= 0 ? s : Infinity;
    const rem = t - t0;
    const spinRate = b === 0 ? spin : spin * Math.pow(e, b);
    if (rem <= hit) {
      return { pos: [p[0] + v[0] * rem, p[1] + v[1] * rem - 0.5 * g * rem * rem, p[2] + v[2] * rem], spinDeg: spinDeg + spinRate * rem, airborne: true, bounces: b, impacts, resting: false };
    }
    p = [p[0] + v[0] * hit, floor, p[2] + v[2] * hit];
    spinDeg += spinRate * hit;
    t0 += hit;
    impacts.push(t0);
    const vy = -(v[1] - g * hit) * e;
    v = [v[0] * fr, vy, v[2] * fr];
    if (vy < 0.25) break;
  }
  // resting: slides to a stop along the floor (constant deceleration) after the last bounce
  const rem = t - t0, speed = Math.hypot(v[0], v[2]), decel = 6;
  const stopT = speed / decel, s = rem >= stopT ? stopT : rem;
  const dist = speed * s - 0.5 * decel * s * s;
  const dir: Vec3 = speed > 1e-6 ? [v[0] / speed, 0, v[2] / speed] : [0, 0, 0];
  return { pos: [p[0] + dir[0] * dist, floor, p[2] + dir[2] * dist], spinDeg, airborne: false, bounces: impacts.length, impacts, resting: rem >= stopT };
}
