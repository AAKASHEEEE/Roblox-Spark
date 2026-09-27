// Deterministic procedural sound design (48 kHz mono float). All sounds are original, generated from math.
export const SR = 48000;
type Params = Record<string, number>;

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1; };
}
const buf = (sec: number) => new Float32Array(Math.max(1, Math.round(sec * SR)));
const env = (t: number, a: number, d: number) => (t < a ? t / a : Math.exp(-(t - a) / d));
/** one-pole lowpass in place */
function lp(x: Float32Array, hz: number): Float32Array { const k = 1 - Math.exp((-2 * Math.PI * hz) / SR); let y = 0; for (let i = 0; i < x.length; i++) { y += k * (x[i] - y); x[i] = y; } return x; }
function hp(x: Float32Array, hz: number): Float32Array { const k = Math.exp((-2 * Math.PI * hz) / SR); let py = 0, px = 0; for (let i = 0; i < x.length; i++) { const y = k * (py + x[i] - px); px = x[i]; py = y; x[i] = y; } return x; }
/** state-variable bandpass with time-varying centre */
function bp(x: Float32Array, hzAt: (i: number) => number, q = 4): Float32Array {
  let low = 0, band = 0; const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) { const f = 2 * Math.sin((Math.PI * Math.min(hzAt(i), SR / 6)) / SR); low += f * band; const high = x[i] - low - band / q; band += f * high; out[i] = band; }
  return out;
}
const tri = (ph: number) => 1 - 4 * Math.abs(((ph / (2 * Math.PI)) % 1 + 1) % 1 - 0.5);
const sq = (ph: number) => (Math.sin(ph) >= 0 ? 1 : -1);

export const PATCHES: Record<string, (p: Params) => Float32Array> = {
  beep: (p) => { const d = p.dur ?? 0.09, f = p.freq ?? 1760; const o = buf(d); for (let i = 0; i < o.length; i++) { const t = i / SR; o[i] = 0.35 * (0.6 * Math.sin(2 * Math.PI * f * t) + 0.4 * sq(2 * Math.PI * f * t) * 0.5) * env(t, 0.004, d / 3); } return lp(o, 6000); },
  click: (p) => { const o = buf(0.08); const r = prng(p.seed ?? 1); for (let i = 0; i < o.length; i++) { const t = i / SR; o[i] = (r() * Math.exp(-t / 0.004) * 0.9 + Math.sin(2 * Math.PI * 2100 * t) * Math.exp(-t / 0.012) * 0.6 + Math.sin(2 * Math.PI * 380 * t) * Math.exp(-t / 0.02) * 0.5); } return o; },
  coin_pop: () => { const d = 0.16; const o = buf(d); let ph = 0; for (let i = 0; i < o.length; i++) { const t = i / SR; const f = 380 + 1400 * (t / d) ** 0.6; ph += (2 * Math.PI * f) / SR; o[i] = 0.5 * Math.sin(ph) * env(t, 0.005, 0.05); } return o; },
  coin_ding: (p) => { const d = p.dur ?? 1.1, f = p.freq ?? 1318.5; const o = buf(d); const parts = [[1, 1, 0.5], [2.76, 0.45, 0.22], [5.4, 0.25, 0.1], [8.93, 0.12, 0.06], [2.0, 0.3, 0.35]]; for (let i = 0; i < o.length; i++) { const t = i / SR; let s = 0; for (const [m, a, dd] of parts) s += a * Math.sin(2 * Math.PI * f * m * t) * Math.exp(-t / dd); o[i] = 0.32 * s * Math.min(1, t / 0.002); } return o; },
  coin_spin: () => { const d = 0.9; const o = buf(d); let ph = 0; for (let i = 0; i < o.length; i++) { const t = i / SR; const rate = 8 + 30 * (t / d) ** 2; ph += (2 * Math.PI * rate) / SR; const am = 0.5 + 0.5 * Math.cos(ph); o[i] = 0.25 * am * Math.sin(2 * Math.PI * 2637 * t) * Math.exp(-t / 0.6) * (1 - t / d); } return o; },
  sparkle: (p) => { const d = 0.7; const o = buf(d); const r = prng(p.seed ?? 5); for (let k = 0; k < 9; k++) { const t0 = ((r() + 1) / 2) * 0.5, f = 3000 + ((r() + 1) / 2) * 3500; const s0 = Math.round(t0 * SR); for (let i = 0; i < 0.12 * SR && s0 + i < o.length; i++) { const t = i / SR; o[s0 + i] += 0.12 * Math.sin(2 * Math.PI * f * (1 + t * 2) * t) * Math.exp(-t / 0.03); } } return o; },
  tada: () => { const notes = [523.25, 659.25, 783.99, 1046.5]; const o = buf(1.1); notes.forEach((f, k) => { const s0 = Math.round(k * 0.075 * SR); for (let i = 0; s0 + i < o.length; i++) { const t = i / SR; o[s0 + i] += 0.2 * (tri(2 * Math.PI * f * t) * 0.7 + Math.sin(2 * Math.PI * f * 2 * t) * 0.2) * env(t, 0.006, k === 3 ? 0.4 : 0.15); } }); return o; },
  whoosh: (p) => { const d = p.dur ?? 0.38; const o = buf(d); const r = prng(p.seed ?? 9); for (let i = 0; i < o.length; i++) o[i] = r(); const f0 = p.from ?? 400, f1 = p.to ?? 2600; const b = bp(o, (i) => f0 + (f1 - f0) * Math.sin((Math.PI * i) / o.length), 2.2); for (let i = 0; i < b.length; i++) { const u = i / b.length; b[i] *= 0.9 * Math.sin(Math.PI * u) ** 1.5; } return b; },
  boing: (p) => { const d = 0.55; const o = buf(d); let ph = 0; for (let i = 0; i < o.length; i++) { const t = i / SR; const f = (160 + 380 * (1 - Math.exp(-t / 0.05))) * (1 + 0.18 * Math.sin(2 * Math.PI * (9 + 10 * t) * t) * Math.exp(-t / 0.25)) * (p.base ?? 1); ph += (2 * Math.PI * f) / SR; o[i] = 0.45 * (Math.sin(ph) * 0.8 + tri(ph * 2) * 0.2) * env(t, 0.005, 0.18); } return o; },
  thud_small: (p) => { const d = 0.45; const o = buf(d); const r = prng(p.seed ?? 3); let ph = 0; for (let i = 0; i < o.length; i++) { const t = i / SR; ph += (2 * Math.PI * (95 * Math.exp(-t / 0.08) + 45)) / SR; o[i] = 0.8 * Math.sin(ph) * env(t, 0.002, 0.09) + 0.25 * r() * Math.exp(-t / 0.02); } return lp(o, 2500); },
  thud_big: (p) => { const d = 1.6; const o = buf(d); const r = prng(p.seed ?? 4); let ph = 0; const n = new Float32Array(o.length); for (let i = 0; i < o.length; i++) n[i] = r(); lp(n, 500); for (let i = 0; i < o.length; i++) { const t = i / SR; ph += (2 * Math.PI * (80 * Math.exp(-t / 0.12) + 28)) / SR; const s = Math.sin(ph) * env(t, 0.002, 0.35) + 2.2 * n[i] * env(t, 0.003, 0.4) + 0.5 * r() * Math.exp(-t / 0.015); o[i] = Math.tanh(1.8 * s) * 0.9; } return o; },
  scrape: (p) => { const d = 0.5; const o = buf(d); const r = prng(p.seed ?? 12); for (let i = 0; i < o.length; i++) o[i] = r() * (0.6 + 0.4 * Math.sin(i / 90)); const b = bp(o, (i) => 900 + 300 * Math.sin(i / 1500), 3); for (let i = 0; i < b.length; i++) { const u = i / b.length; b[i] *= 1.2 * Math.sin(Math.PI * u) * (1 - u * 0.5); } return b; },
  rumble: (p) => { const d = p.dur ?? 3.5; const o = buf(d); const r = prng(p.seed ?? 21); for (let i = 0; i < o.length; i++) o[i] = r(); lp(o, 120); lp(o, 160); for (let i = 0; i < o.length; i++) { const u = i / o.length; o[i] *= 7 * Math.min(1, u * 1.6) * (1 - u) ** 0.4; } return o; },
  creak: (p) => { const d = 0.7; const o = buf(d); let ph = 0; for (let i = 0; i < o.length; i++) { const t = i / SR; const f = 70 + 30 * Math.sin(2 * Math.PI * 3 * t) + 20 * Math.sin(2 * Math.PI * 11 * t); ph += (2 * Math.PI * f * (p.base ?? 1)) / SR; o[i] = ((ph / Math.PI) % 2) - 1; } const b = bp(o, (i) => 700 + 200 * Math.sin(i / 3000), 6); for (let i = 0; i < b.length; i++) { const u = i / b.length; b[i] *= 1.4 * Math.sin(Math.PI * u); } return b; },
  deflate_slide: () => { const d = 1.0; const o = buf(d); let ph = 0; for (let i = 0; i < o.length; i++) { const t = i / SR; const f = 880 * Math.pow(0.35, t / d) * (1 + 0.02 * Math.sin(2 * Math.PI * 6 * t)); ph += (2 * Math.PI * f) / SR; o[i] = 0.35 * (Math.sin(ph) + 0.25 * Math.sin(2 * ph)) * env(t, 0.02, 0.6) * (1 - t / d); } return o; },
  ding_reset: () => { const o = buf(0.9); for (const [f, t0] of [[1567.98, 0], [2093, 0.1]] as const) { const s0 = Math.round(t0 * SR); for (let i = 0; s0 + i < o.length; i++) { const t = i / SR; o[s0 + i] += 0.25 * (Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(2 * Math.PI * f * 3 * t) * Math.exp(-t / 0.05)) * Math.exp(-t / 0.3); } } return o; },
  blip_question: () => { const o = buf(0.28); for (const [f, t0] of [[660, 0], [990, 0.1]] as const) { const s0 = Math.round(t0 * SR); for (let i = 0; i < 0.12 * SR && s0 + i < o.length; i++) { const t = i / SR; o[s0 + i] += 0.28 * tri(2 * Math.PI * f * (1 + t * 1.5) * t) * env(t, 0.004, 0.04); } } return o; },
  blip_dots: () => { const o = buf(0.42); for (let k = 0; k < 3; k++) { const s0 = Math.round(k * 0.12 * SR); for (let i = 0; i < 0.06 * SR; i++) { const t = i / SR; o[s0 + i] += 0.22 * tri(2 * Math.PI * 520 * t) * env(t, 0.003, 0.02); } } return o; },
  footstep: (p) => { const o = buf(0.12); const r = prng(p.seed ?? 77); for (let i = 0; i < o.length; i++) { const t = i / SR; o[i] = r() * Math.exp(-t / 0.018) * 0.6 + Math.sin(2 * Math.PI * 140 * t) * Math.exp(-t / 0.03) * 0.4; } return lp(o, 1800); },
};

/** Original 8-bar loop, tempo chosen so the loop length equals the episode length exactly. */
export function music(durationSec: number, p: Params): Float32Array {
  const bars = p.bars ?? 8, beats = bars * 4;
  const spb = durationSec / beats;
  const o = buf(durationSec + 1);
  // progression (semitones from C4): C - Am - F - G, each 2 bars
  const roots = [0, -3, -7, -5];
  const chord = (r: number) => [r, r + (r === -3 ? 3 : 4), r + 7];
  const hz = (semi: number, oct = 0) => 261.63 * Math.pow(2, semi / 12 + oct);
  const note = (f: number, t0: number, dur: number, amp: number, kind: 'pluck' | 'bass' | 'hat', seed = 0) => {
    const s0 = Math.round(t0 * SR); const n = Math.round((dur + 0.3) * SR); const r = prng(seed + s0);
    for (let i = 0; i < n && s0 + i < o.length; i++) {
      const t = i / SR;
      let s: number;
      if (kind === 'pluck') s = (tri(2 * Math.PI * f * t) * 0.6 + Math.sin(2 * Math.PI * f * 2 * t) * 0.25) * env(t, 0.004, 0.12);
      else if (kind === 'bass') s = (Math.sin(2 * Math.PI * f * t) + 0.3 * sq(2 * Math.PI * f * t) * 0.3) * env(t, 0.006, 0.18) * (t < dur ? 1 : Math.exp(-(t - dur) / 0.03));
      else s = r() * env(t, 0.001, 0.012);
      o[s0 + i] += amp * s;
    }
  };
  for (let b = 0; b < beats; b++) {
    const bar = Math.floor(b / 4), root = roots[Math.floor(bar / 2) % 4], t = b * spb;
    note(hz(root, -2), t, spb * 0.7, 0.32, 'bass');
    const ch = chord(root);
    note(hz(ch[b % 3], 1), t + spb * 0.5, spb * 0.4, 0.13, 'pluck');
    note(hz(ch[(b + 1) % 3], 1), t, spb * 0.4, 0.1, 'pluck');
    note(0, t + spb * 0.5, 0.02, 0.05, 'hat', 1);
    if (b % 2 === 1) note(0, t, 0.02, 0.07, 'hat', 2);
  }
  return hp(o, 40);
}

export function ambience(durationSec: number, p: Params): Float32Array {
  const o = buf(durationSec + 1); const r = prng(p.seed ?? 99);
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < o.length; i++) { const w = r(); b0 = 0.997 * b0 + w * 0.029; b1 = 0.985 * b1 + w * 0.032; b2 = 0.95 * b2 + w * 0.048; o[i] = (b0 + b1 + b2) * 0.5; }
  lp(o, 900);
  // soft clock ticks (the room clock), 1 Hz
  for (let s = 0.25; s < durationSec + 1; s += 1) { const s0 = Math.round(s * SR); for (let i = 0; i < 0.01 * SR && s0 + i < o.length; i++) o[s0 + i] += 0.05 * Math.sin(2 * Math.PI * 3000 * (i / SR)) * Math.exp(-i / SR / 0.002); }
  return o;
}
