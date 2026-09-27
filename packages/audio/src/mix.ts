// Automatic mix: cue placement, pitch, sidechain ducking, circular (loop-safe) tails,
// ITU-R BS.1770-4 integrated loudness normalisation and a peak limiter.
import { PATCHES, SR, ambience, music } from './synth.ts';

export interface AudioAsset { id: string; category: 'sfx' | 'music' | 'ambience'; synth: string; params: Record<string, number> }
export interface MixCue { sfx: string; at: number; gainDb: number; pitch?: number; pan?: number }
export interface MixInput { duration: number; cues: MixCue[]; music?: { id: string; gainDb: number }; ambience?: { id: string; gainDb: number }; loudnessLufs: number; duckingDb: number; loop: boolean }
export interface MixReport { integratedLufsPre: number; integratedLufs: number; truePeakDbfsApprox: number; gainAppliedDb: number; cues: number; missing: string[]; limiterReductionDbMax: number }

const db = (x: number) => Math.pow(10, x / 20);

function resample(x: Float32Array, rate: number): Float32Array {
  if (Math.abs(rate - 1) < 1e-6) return x;
  const n = Math.floor(x.length / rate); const o = new Float32Array(n);
  for (let i = 0; i < n; i++) { const p = i * rate, k = Math.floor(p), f = p - k; o[i] = (x[k] ?? 0) * (1 - f) + (x[k + 1] ?? 0) * f; }
  return o;
}

/** BS.1770 K-weighting biquads at 48 kHz (coefficients from the spec). */
function kWeight(x: Float32Array): Float32Array {
  const stages = [
    { b: [1.53512485958697, -2.69169618940638, 1.19839281085285], a: [-1.69065929318241, 0.73248077421585] },
    { b: [1.0, -2.0, 1.0], a: [-1.99004745483398, 0.99007225036621] },
  ];
  let y = x;
  for (const s of stages) {
    const o = new Float32Array(y.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < y.length; i++) { const v = s.b[0] * y[i] + s.b[1] * x1 + s.b[2] * x2 - s.a[0] * y1 - s.a[1] * y2; x2 = x1; x1 = y[i]; y2 = y1; y1 = v; o[i] = v; }
    y = o;
  }
  return y;
}
export function integratedLoudness(L: Float32Array, R: Float32Array): number {
  const kl = kWeight(L), kr = kWeight(R);
  const block = Math.round(0.4 * SR), hop = Math.round(0.1 * SR);
  const zs: number[] = [];
  for (let s = 0; s + block <= kl.length; s += hop) { let sum = 0; for (let i = s; i < s + block; i++) sum += kl[i] * kl[i] + kr[i] * kr[i]; zs.push(sum / block); }
  const lk = (z: number) => -0.691 + 10 * Math.log10(z + 1e-12);
  const abs = zs.filter((z) => lk(z) > -70);
  if (!abs.length) return -70;
  const rel = lk(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const g = abs.filter((z) => lk(z) > rel);
  return lk(g.reduce((a, b) => a + b, 0) / g.length);
}

export function mix(input: MixInput, assets: Record<string, AudioAsset>): { left: Float32Array; right: Float32Array; report: MixReport } {
  const N = Math.round(input.duration * SR);
  const pad = SR * 3;
  const sfxL = new Float32Array(N + pad), sfxR = new Float32Array(N + pad);
  const bedL = new Float32Array(N + pad), bedR = new Float32Array(N + pad);
  const missing: string[] = [];
  for (const c of input.cues) {
    const a = assets[c.sfx];
    if (!a || !PATCHES[a.synth]) { missing.push(c.sfx); continue; }
    const s = resample(PATCHES[a.synth](a.params), c.pitch ?? 1);
    const g = db(c.gainDb), pan = c.pan ?? 0;
    const gl = g * Math.cos(((pan + 1) * Math.PI) / 4) * Math.SQRT2, gr = g * Math.sin(((pan + 1) * Math.PI) / 4) * Math.SQRT2;
    const s0 = Math.round(c.at * SR);
    for (let i = 0; i < s.length && s0 + i < N + pad; i++) { sfxL[s0 + i] += s[i] * gl; sfxR[s0 + i] += s[i] * gr; }
  }
  const addBed = (ref: { id: string; gainDb: number } | undefined, width: number) => {
    if (!ref) return;
    const a = assets[ref.id];
    if (!a) { missing.push(ref.id); return; }
    const x = a.category === 'music' ? music(input.duration, a.params) : ambience(input.duration, a.params);
    const y = a.category === 'ambience' ? ambience(input.duration, { ...a.params, seed: (a.params.seed ?? 99) + 1 }) : x;
    const g = db(ref.gainDb);
    for (let i = 0; i < Math.min(x.length, N + pad); i++) { bedL[i] += x[i] * g; bedR[i] += (x[i] * (1 - width) + y[i] * width) * g; }
  };
  addBed(input.music, 0.15);
  addBed(input.ambience, 1);
  // sidechain ducking: bed follows SFX envelope
  const att = Math.exp(-1 / (0.01 * SR)), rel = Math.exp(-1 / (0.25 * SR));
  let e = 0; const duck = db(-input.duckingDb);
  for (let i = 0; i < N + pad; i++) {
    const lvl = Math.max(Math.abs(sfxL[i]), Math.abs(sfxR[i]));
    e = lvl > e ? att * e + (1 - att) * lvl : rel * e + (1 - rel) * lvl;
    const k = Math.min(1, e / 0.05);
    const g = 1 - (1 - duck) * k;
    bedL[i] *= g; bedR[i] *= g;
  }
  let L: Float32Array = new Float32Array(N), R: Float32Array = new Float32Array(N);
  for (let i = 0; i < N + pad; i++) {
    const j = input.loop ? i % N : i; // circular: tails past the end wrap into the head => seamless loop
    if (!input.loop && i >= N) break;
    L[j] += sfxL[i] + bedL[i]; R[j] += sfxR[i] + bedR[i];
  }
  // tiny edge fades only when not looping
  if (!input.loop) for (let i = 0; i < 480; i++) { const g = i / 480; L[i] *= g; R[i] *= g; L[N - 1 - i] *= g; R[N - 1 - i] *= g; }
  const pre = integratedLoudness(L, R);
  let gain = input.loudnessLufs - pre;
  // limiter removes loudness on peaky material: iterate gain until post-limiter loudness hits target
  for (let it = 0; it < 4; it++) {
    const trial = limit(L, R, db(gain), N).L;
    const got = integratedLoudness(trial, limit(L, R, db(gain), N).R);
    if (Math.abs(got - input.loudnessLufs) < 0.2) break;
    gain += input.loudnessLufs - got;
  }
  const lim = limit(L, R, db(gain), N);
  const maxRed = lim.maxRed;
  L = lim.L; R = lim.R;
  let peak = 0;
  for (let i = 0; i < N - 1; i++) for (let k = 0; k < 4; k++) { const f = k / 4; peak = Math.max(peak, Math.abs(L[i] * (1 - f) + L[i + 1] * f), Math.abs(R[i] * (1 - f) + R[i + 1] * f)); }
  return {
    left: L, right: R,
    report: { integratedLufsPre: +pre.toFixed(2), integratedLufs: +integratedLoudness(L, R).toFixed(2), truePeakDbfsApprox: +(20 * Math.log10(peak + 1e-12)).toFixed(2), gainAppliedDb: +gain.toFixed(2), cues: input.cues.length, missing, limiterReductionDbMax: +(20 * Math.log10(maxRed)).toFixed(2) },
  };
}

function limit(L: Float32Array, R: Float32Array, g: number, N: number): { L: Float32Array; R: Float32Array; maxRed: number } {
  // lookahead peak limiter at -1.5 dBFS (circular lookahead keeps the loop seam clean)
  const ceil = db(-1.5), look = Math.round(0.005 * SR), relL = Math.exp(-1 / (0.08 * SR));
  let gr = 1, maxRed = 1;
  const outL = new Float32Array(N), outR = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let pk = 0;
    for (let k = 0; k <= look; k += 8) { const j = (i + k) % N; pk = Math.max(pk, Math.abs(L[j] * g), Math.abs(R[j] * g)); }
    const need = pk > ceil ? ceil / pk : 1;
    gr = need < gr ? need : relL * gr + (1 - relL) * need;
    maxRed = Math.min(maxRed, gr);
    outL[i] = Math.max(-ceil, Math.min(ceil, L[i] * g * gr)); outR[i] = Math.max(-ceil, Math.min(ceil, R[i] * g * gr));
  }
  return { L: outL, R: outR, maxRed };
}

export function interleave(L: Float32Array, R: Float32Array): Float32Array { const o = new Float32Array(L.length * 2); for (let i = 0; i < L.length; i++) { o[2 * i] = L[i]; o[2 * i + 1] = R[i]; } return o; }

export function wav16(L: Float32Array, R: Float32Array): Uint8Array {
  const n = L.length, o = new Uint8Array(44 + n * 4), dv = new DataView(o.buffer);
  const w = (p: number, s: string) => { for (let i = 0; i < 4; i++) o[p + i] = s.charCodeAt(i); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + n * 4, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 2, true);
  dv.setUint32(24, SR, true); dv.setUint32(28, SR * 4, true); dv.setUint16(32, 4, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * 4, true);
  for (let i = 0; i < n; i++) { dv.setInt16(44 + i * 4, Math.round(Math.max(-1, Math.min(1, L[i])) * 32767), true); dv.setInt16(46 + i * 4, Math.round(Math.max(-1, Math.min(1, R[i])) * 32767), true); }
  return o;
}
