// Comedy acting curves: anticipation, overshoot, settle, squash & stretch and hops.
// Every function here is a pure function of its arguments (no clocks, no state, no randomness), so poses built from
// them are deterministic and can be sampled in any order.
import { clamp, type Vec3 } from '../math.ts';
import { K } from './pose.ts';

const ss = (x: number): number => { const c = clamp(x, 0, 1); return c * c * (3 - 2 * c); };

/**
 * Shape of a comedic move from 0 to 1:
 *   0 -> -anticipation (wind-up, eased, peaks at antAt)
 *     -> 1 + overshoot (fast strike, reached at strikeAt)
 *     -> damped wobble that lands on exactly 1 at u = 1.
 */
export interface ActingShape {
  /** wind-up depth as a fraction of the move (0.1-0.3 reads well) */
  anticipation: number;
  /** normalized time the wind-up peaks */
  antAt: number;
  /** normalized time the strike reaches its overshoot peak */
  strikeAt: number;
  /** overshoot past the target as a fraction of the move */
  overshoot: number;
  /** half-cycles of the settle wobble after the strike (1 = one swing back, 3 = rubbery) */
  wobble: number;
}
export const ACTING = {
  /** default comedic move */
  snappy: { anticipation: 0.18, antAt: 0.3, strikeAt: 0.45, overshoot: 0.14, wobble: 2 },
  /** large wind-up, big bounce (slams, throws, scream onsets) */
  broad: { anticipation: 0.3, antAt: 0.35, strikeAt: 0.48, overshoot: 0.22, wobble: 3 },
  /** small, quick (shrugs, waves) */
  light: { anticipation: 0.1, antAt: 0.2, strikeAt: 0.38, overshoot: 0.1, wobble: 1 },
} as const satisfies Record<string, ActingShape>;

/** acting curve value at normalized time u (see ActingShape). acting(0) = 0, acting(1) = 1, continuous. */
export function acting(u: number, o: ActingShape = ACTING.snappy): number {
  const x = clamp(u, 0, 1);
  const A = o.anticipation, O = o.overshoot;
  const antAt = clamp(o.antAt, 1e-3, 0.98), strikeAt = clamp(o.strikeAt, antAt + 1e-3, 0.99);
  if (x <= antAt) return -A * ss(x / antAt) + 0; // + 0: never -0
  if (x <= strikeAt) {
    // strike: leave the wind-up and hit the overshoot peak with zero velocity (smoothstep: peak speed 1.5x the mean,
    // so short strikes read as a snap without popping more than a smear frame)
    const s = (x - antAt) / (strikeAt - antAt);
    return -A + (1 + O + A) * s * s * (3 - 2 * s);
  }
  const s = (x - strikeAt) / (1 - strikeAt);
  // damped cosine that starts at the peak (1 + O) and is exactly 1 at s = 1
  return 1 + O * (1 - s) ** 2 * Math.cos(Math.PI * Math.max(1, o.wobble) * s);
}
/** from + (to - from) * acting(u) */
export const strike = (u: number, from: number, to: number, o: ActingShape = ACTING.snappy): number => from + (to - from) * acting(u, o);

/** ease-out with overshoot (back-out), 0 -> 1; amount 0 = plain ease-out cubic, larger = bigger overshoot */
export function overshootOut(u: number, amount = 0.12): number {
  const x = clamp(u, 0, 1);
  const s = amount * 10; // back-ease constant
  return 1 + (s + 1) * (x - 1) ** 3 + s * (x - 1) ** 2;
}

/** decaying oscillation around 0 that is exactly 0 at x = 1 (settles after a hit); amplitude at x = 0 is `amount` */
export function settle(x: number, amount: number, halfCycles = 3): number {
  const c = clamp(x, 0, 1);
  return amount * (1 - c) ** 2 * Math.cos(Math.PI * halfCycles * c) + 0;
}

/** volume-preserving squash/stretch scale: y = s, x = z = 1 / sqrt(s) */
export function squashStretch(s: number): Vec3 {
  const y = clamp(s, 0.2, 3), w = 1 / Math.sqrt(y);
  return [w, y, w];
}
/** vertical scale after a landing, x = normalized time since contact (0..1): squash, small rebound stretch, rest */
export function landingSquash(x: number, depth = 0.22): number {
  if (x <= 0 || x >= 1) return 1;
  return K(x, [[0, 1], [0.22, 1 - depth], [0.55, 1 + depth * 0.3], [0.8, 1 - depth * 0.08], [1, 1]]);
}

export interface HopShape {
  /** normalized time the feet leave the floor */
  takeoff: number;
  /** normalized time the feet land */
  land: number;
  /** apex height (m) */
  height: number;
  /** squash depth at the crouch and the landing (0 = none) */
  squash: number;
  /** stretch at takeoff / before landing */
  stretch: number;
}
export interface HopSample { lift: number; /** 0..1 how deep the legs bend (anticipation crouch, landing compression) */ crouch: number; /** 0..1 legs tucked in the air */ tuck: number; scale: Vec3; airborne: boolean }

/** A cartoon hop: anticipation crouch -> stretched takeoff -> parabolic arc -> squashed landing -> settle. */
export function hop(u: number, o: HopShape): HopSample {
  const x = clamp(u, 0, 1);
  const { takeoff: t0, land: t1 } = o;
  if (x < t0) {
    const c = ss(x / t0);
    return { lift: 0, crouch: c, tuck: 0, scale: squashStretch(1 - o.squash * 0.6 * c), airborne: false };
  }
  if (x < t1) {
    const a = (x - t0) / (t1 - t0);
    const lift = o.height * 4 * a * (1 - a);
    // stretch with vertical speed |1 - 2a|, blended out of the crouch squash over the first 20 % of the flight
    // (the stretch eases off over the last 15 % so the contact squash does not pop)
    const air = 1 + o.stretch * Math.abs(1 - 2 * a) * (1 - ss((a - 0.85) / 0.15));
    const k = ss(a / 0.2);
    const sy = (1 - o.squash * 0.6) * (1 - k) + air * k;
    return { lift, crouch: 1 - k, tuck: Math.sin(Math.PI * a), scale: squashStretch(sy), airborne: true };
  }
  const l = (x - t1) / Math.max(1e-6, 1 - t1);
  // leave the flight scale continuously, then squash on contact and settle
  const pre = 1;
  const land = landingSquash(l, o.squash);
  const k = ss(l / 0.3);
  return { lift: 0, crouch: K(l, [[0, 0], [0.3, 1], [0.65, 0.15], [1, 0]]), tuck: 0, scale: squashStretch(pre * (1 - k) + land * k), airborne: false };
}

/** deterministic per-seed phase in [0, 1) for staggering loops (dance moves, sobs) */
export function seedPhase(seed: number, k = 0): number {
  let h = (seed ^ Math.imul(k + 1, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** amplitude envelope for a looping action of duration d: eases in over `inSec` and out over `outSec` */
export function loopEnvelope(lt: number, d: number, inSec = 0.25, outSec = 0.25): number {
  return ss(lt / Math.max(1e-6, inSec)) * ss((d - lt) / Math.max(1e-6, outSec));
}
