// Procedural SFX patches for the planned S7 SFX IDs (48 kHz mono float). Original, synthesised from math: no samples,
// no recordings. Deterministic per params.seed. Complements packages/audio/src/synth.ts (which stays untouched).
import { SR } from '../../audio/src/synth.ts';

type Params = Record<string, number>;
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1; };
}
const buf = (sec: number) => new Float32Array(Math.max(1, Math.round(sec * SR)));
const env = (t: number, a: number, d: number) => (t < 0 ? 0 : t < a ? t / a : Math.exp(-(t - a) / d));
function lp(x: Float32Array, hz: number): Float32Array { const k = 1 - Math.exp((-2 * Math.PI * hz) / SR); let y = 0; for (let i = 0; i < x.length; i++) { y += k * (x[i] - y); x[i] = y; } return x; }
function hp(x: Float32Array, hz: number): Float32Array { const k = Math.exp((-2 * Math.PI * hz) / SR); let py = 0, px = 0; for (let i = 0; i < x.length; i++) { const y = k * (py + x[i] - px); px = x[i]; py = y; x[i] = y; } return x; }
/** state-variable band-pass with a time-varying centre */
function bp(x: Float32Array, hzAt: (i: number) => number, q = 4): Float32Array {
  let low = 0, band = 0; const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) { const f = 2 * Math.sin((Math.PI * Math.min(hzAt(i), SR / 6)) / SR); low += f * band; const high = x[i] - low - band / q; band += f * high; out[i] = band; }
  return out;
}
const noise = (n: number, seed: number) => { const r = prng(seed), o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = r(); return o; };
const addAt = (dst: Float32Array, src: Float32Array, at: number, g = 1) => { const s0 = Math.round(at * SR); for (let i = 0; i < src.length && s0 + i < dst.length; i++) if (s0 + i >= 0) dst[s0 + i] += src[i] * g; };
/** struck metal/wood partials: [ratio, amp, decay s] */
function modal(dur: number, f: number, parts: ReadonlyArray<readonly [number, number, number]>): Float32Array {
  const o = buf(dur);
  for (let i = 0; i < o.length; i++) { const t = i / SR; let s = 0; for (const [m, a, d] of parts) s += a * Math.sin(2 * Math.PI * f * m * t) * Math.exp(-t / d); o[i] = s * Math.min(1, t / 0.0015); }
  return o;
}
function latch(seed: number): Float32Array {
  const o = buf(0.06), r = prng(seed);
  for (let i = 0; i < o.length; i++) { const t = i / SR; o[i] = 0.7 * r() * Math.exp(-t / 0.0025) + 0.35 * Math.sin(2 * Math.PI * 2900 * t) * Math.exp(-t / 0.008) + 0.25 * Math.sin(2 * Math.PI * 1700 * t) * Math.exp(-t / 0.012); }
  return o;
}
function step(seed: number, level: number, bright: number): Float32Array {
  const o = buf(0.16), n = noise(o.length, seed);
  lp(n, 1400 + 900 * bright);
  for (let i = 0; i < o.length; i++) { const t = i / SR; o[i] = level * (0.9 * n[i] * env(t, 0.001, 0.02) + 0.5 * Math.sin(2 * Math.PI * (110 + 30 * bright) * t) * env(t, 0.002, 0.03) + 0.25 * n[i] * env(t - 0.035, 0.002, 0.015)); }
  return o;
}

export const S7_PATCHES: Record<string, (p: Params) => Float32Array> = {
  /** latch click, then a hinge creak that swells and fades; a little air movement underneath */
  door_open: (p) => {
    const d = p.dur ?? 1.0, o = buf(d), seed = p.seed ?? 31;
    addAt(o, latch(seed), 0, 0.8);
    const saw = buf(d); let ph = 0;
    for (let i = 0; i < saw.length; i++) { const t = i / SR; const f = (190 + 60 * Math.sin(2 * Math.PI * 1.7 * t) + 25 * Math.sin(2 * Math.PI * 7.3 * t)) * (p.base ?? 1); ph += f / SR; saw[i] = ((ph % 1) * 2 - 1) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 23 * t)); }
    const creak = bp(saw, (i) => 1100 + 350 * Math.sin(i / 5200), 7);
    for (let i = 0; i < creak.length; i++) { const t = i / SR; const u = Math.max(0, (t - 0.08) / (d - 0.12)); creak[i] *= u > 1 ? 0 : 2.2 * Math.sin(Math.PI * u) ** 1.2; }
    addAt(o, creak, 0, 1);
    const air = lp(noise(o.length, seed + 1), 500);
    for (let i = 0; i < air.length; i++) { const u = i / air.length; o[i] += 0.5 * air[i] * Math.sin(Math.PI * u); }
    return o;
  },
  /** door hitting the frame: low wooden thump, knock, latch rattle and a short room tail */
  door_slam: (p) => {
    const d = 1.1, o = buf(d), seed = p.seed ?? 32, r = prng(seed);
    const n = lp(noise(o.length, seed), 900);
    let ph = 0;
    for (let i = 0; i < o.length; i++) {
      const t = i / SR; ph += (2 * Math.PI * (72 * Math.exp(-t / 0.06) + 44)) / SR;
      o[i] = 0.95 * Math.sin(ph) * env(t, 0.0015, 0.16) + 1.3 * n[i] * env(t, 0.001, 0.05) + 0.4 * r() * Math.exp(-t / 0.004) + 0.35 * n[i] * env(t - 0.02, 0.01, 0.28);
    }
    for (const [at, g] of [[0.035, 0.35], [0.07, 0.22], [0.115, 0.12]] as const) addAt(o, modal(0.12, 3150 + r() * 200, [[1, 1, 0.02], [1.52, 0.5, 0.015]]), at, g);
    for (let i = 0; i < o.length; i++) o[i] = Math.tanh(1.5 * o[i]) * 0.85;
    return o;
  },
  /** four sneaker steps, alternating foot character, the last one softer */
  footsteps: (p) => {
    const n = p.steps ?? 4, gap = p.gap ?? 0.3, o = buf(gap * n + 0.2), seed = p.seed ?? 33, r = prng(seed);
    for (let k = 0; k < n; k++) addAt(o, step(seed + k * 7, (k === n - 1 ? 0.6 : 0.85) * (0.9 + 0.1 * r()), k % 2), k * gap + 0.012 * r());
    return o;
  },
  /** bubbly pop: fast downward sine chirp plus a tiny click */
  pop: (p) => {
    const d = 0.14, o = buf(d), r = prng(p.seed ?? 34); let ph = 0;
    for (let i = 0; i < o.length; i++) { const t = i / SR; const f = 250 + 750 * Math.exp(-t / 0.018); ph += (2 * Math.PI * f * (p.base ?? 1)) / SR; o[i] = 0.7 * Math.sin(ph) * env(t, 0.001, 0.035) + 0.2 * r() * Math.exp(-t / 0.0015); }
    return o;
  },
  /** sharp inhale: breathy noise through two rising formants */
  gasp: (p) => {
    const d = 0.6, n = noise(Math.round(d * SR), p.seed ?? 35);
    const f1 = bp(n, (i) => 750 + 500 * Math.min(1, i / (0.3 * SR)), 5), f2 = bp(n, (i) => 1500 + 900 * Math.min(1, i / (0.3 * SR)), 6), h = hp(n.slice(), 3000);
    const o = buf(d);
    for (let i = 0; i < o.length; i++) { const t = i / SR; const e = t < 0.05 ? t / 0.05 : t < 0.32 ? 1 - 0.25 * (t - 0.05) / 0.27 : 0.75 * Math.exp(-(t - 0.32) / 0.07); o[i] = e * (1.1 * f1[i] + 0.8 * f2[i] + 0.12 * h[i]); }
    return o;
  },
  /** small crowd laughing: many voices of "ha" syllables with their own pitch, rate and formants */
  crowd_laugh: (p) => {
    const d = p.dur ?? 1.9, voices = p.voices ?? 12, o = buf(d), r = prng(p.seed ?? 36);
    for (let v = 0; v < voices; v++) {
      const f0 = 140 + (r() + 1) * 110, rate = 4.6 + (r() + 1) * 1.4, t0 = (r() + 1) * 0.15, fA = 700 + r() * 150, fB = 1150 + r() * 200, lvl = 0.5 + 0.25 * r();
      const src = buf(d); let ph = 0;
      for (let i = 0; i < src.length; i++) {
        const t = i / SR - t0; if (t < 0) continue;
        const syl = (t * rate) % 1, k = Math.floor(t * rate);
        ph += (f0 * (1 - 0.12 * syl) * (1 - 0.03 * k)) / SR;
        const pulse = Math.max(0, Math.sin(2 * Math.PI * ph)) ** 3;
        const e = (syl < 0.12 ? syl / 0.12 : Math.exp(-(syl - 0.12) / 0.2)) * Math.exp(-t / (d * 0.55));
        src[i] = (pulse - 0.2) * e;
      }
      const a = bp(src, () => fA, 6), b = bp(src, () => fB, 7);
      for (let i = 0; i < o.length; i++) o[i] += lvl * (a[i] + 0.6 * b[i]) * 0.9;
    }
    hp(o, 120);
    return o;
  },
  /** electric school bell: a clapper striking at ~22 Hz, bell partials ringing on, then a tail */
  bell: (p) => {
    const ring = p.ring ?? 1.2, d = ring + 0.8, o = buf(d), f = p.freq ?? 1480, r = prng(p.seed ?? 37);
    const strike = modal(0.5, f, [[1, 0.6, 0.35], [2.76, 0.3, 0.12], [5.4, 0.15, 0.05], [0.5, 0.25, 0.5]]);
    for (let t = 0; t < ring; t += 1 / 22) addAt(o, strike, t + 0.002 * r(), 0.28);
    for (let i = 0; i < o.length; i++) o[i] = Math.tanh(o[i] * 1.2);
    return o;
  },
  /** phone ring: two bursts of a bright two-tone trill */
  phone_ring: (p) => {
    const d = 2.0, o = buf(d);
    for (const b0 of [0, 1.0]) for (let i = 0; i < 0.75 * SR; i++) {
      const t = i / SR, sel = Math.floor(t * 18) % 2, f = sel ? 1760 : 1318.5;
      const s = Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(2 * Math.PI * f * 2 * t) + 0.12 * Math.sin(2 * Math.PI * f * 3 * t);
      const e = Math.min(1, t / 0.01) * Math.min(1, (0.75 - t) / 0.03);
      o[Math.round(b0 * SR) + i] += 0.35 * s * e;
    }
    return lp(o, 7000);
  },
  /** app notification: two quick chime notes (E6 -> B6) */
  notification: () => {
    const o = buf(0.6);
    addAt(o, modal(0.5, 1318.5, [[1, 0.5, 0.18], [2, 0.18, 0.08], [3.01, 0.08, 0.04]]), 0, 0.8);
    addAt(o, modal(0.5, 1975.5, [[1, 0.5, 0.22], [2, 0.16, 0.09], [3.01, 0.06, 0.05]]), 0.09, 0.8);
    return o;
  },
};
