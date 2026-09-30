// Voice-over + SFX mix (S7). NO MUSIC: the editor adds music later, so music refs are never mixed (see plan.ts).
//
//   1. voice-over is the primary track: never cut, stretched or delayed; gained so the voice alone sits at the target
//   2. every SFX cue is loudness-matched (its loudest 400 ms window) to `sfxRefBelowVoiceDb` under the target, then
//      trimmed by SfxDef.gainDb + the event's gainDb, and panned slightly (deterministic per cue)
//   3. SFX are ducked under the voice (smooth 10 ms / 300 ms envelope; no gating clicks)
//   4. guard: in every 400 ms window with speech the SFX bus stays >= speechMarginDb below the voice; in pauses it
//      stays >= gapMarginDb below the target. Violations are trimmed with a smoothed gain curve (lookahead-free: the
//      trim covers the whole window, so it lands before the transient)
//   5. integrated loudness (ITU-R BS.1770-4, gated) normalised to targetLufs, then a true-peak limiter: 4x oversampled
//      windowed-sinc peak detection, 1.5 ms lookahead, 60 ms release; iterated until loudness and true peak both hit
// Deterministic: the output depends only on (voice, cues, assets, options).
import { SR } from '../../audio/src/synth.ts';
import { integratedLoudness } from '../../audio/src/mix.ts';
import { truePeakDbtp } from '../../narrated/src/mixdown.ts';
import { renderSfx, SFX_DEFS, type AudioAssets } from './sfx.ts';

export { SR };
export interface SfxCueIn { sfxId: string; at: number; gainDb?: number }
export interface MixOptions {
  /** integrated loudness target (LUFS); default -14 */
  targetLufs?: number;
  /** true-peak ceiling (dBTP); default -1 */
  truePeakDbtp?: number;
  /** SFX reference level under the target (dB); default 6 */
  sfxRefBelowVoiceDb?: number;
  /** extra SFX attenuation while the voice is speaking (dB); default 4 */
  duckDb?: number;
  /** min voice-to-SFX momentary loudness margin in speech windows (dB); default 6 */
  speechMarginDb?: number;
  /** min margin below the target for SFX in pauses (dB); default 3 */
  gapMarginDb?: number;
  seed?: number;
}
export interface CueReport { sfxId: string; at: number; source: string | null; pitch: number; levelDb: number; status: 'mixed' | 'unknown_sfx' | 'unresolved_source' | 'outside_voice' }
export interface MixReport {
  sampleRate: number; channels: 2; durationSec: number;
  targetLufs: number; integratedLufs: number;
  truePeakTargetDbtp: number; truePeakDbtp: number; samplePeakDbfs: number;
  gainAppliedDb: number; limiterMaxReductionDb: number; limiterCeilingDbtp: number;
  voice: { integratedLufsIn: number; gainDb: number };
  sfxUnderVoice: { speechWindows: number; minSpeechMarginDb: number | null; requiredSpeechMarginDb: number; maxSfxMomentaryLufs: number | null; guardTrimMaxDb: number };
  music: 'none';
  cues: CueReport[];
}

const db = (x: number) => Math.pow(10, x / 20);
const toDb = (x: number) => 20 * Math.log10(Math.max(x, 1e-12));
const r2 = (x: number) => Math.round(x * 100) / 100;

/** BS.1770 K-weighting (48 kHz coefficients), the same filter packages/audio/src/mix.ts uses */
function kWeight(x: Float32Array): Float32Array {
  const stages = [{ b: [1.53512485958697, -2.69169618940638, 1.19839281085285], a: [-1.69065929318241, 0.73248077421585] }, { b: [1.0, -2.0, 1.0], a: [-1.99004745483398, 0.99007225036621] }];
  let y = x;
  for (const s of stages) { const o = new Float32Array(y.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0; for (let i = 0; i < y.length; i++) { const v = s.b[0] * y[i] + s.b[1] * x1 + s.b[2] * x2 - s.a[0] * y1 - s.a[1] * y2; x2 = x1; x1 = y[i]; y2 = y1; y1 = v; o[i] = v; } y = o; }
  return y;
}
/** momentary loudness (400 ms windows every `hop` s) of a stereo pair; windows start at 0 */
export function momentary(L: Float32Array, R: Float32Array, hop = 0.05): Float64Array {
  const kl = kWeight(L), kr = R === L ? kl : kWeight(R), W = Math.round(0.4 * SR), H = Math.round(hop * SR);
  const n = Math.max(1, Math.floor((kl.length - W) / H) + 1), out = new Float64Array(n);
  // prefix sums of power for O(1) windows
  const ps = new Float64Array(kl.length + 1);
  for (let i = 0; i < kl.length; i++) ps[i + 1] = ps[i] + kl[i] * kl[i] + kr[i] * kr[i];
  for (let k = 0; k < n; k++) { const a = k * H, b = Math.min(kl.length, a + W); out[k] = -0.691 + 10 * Math.log10((ps[b] - ps[a]) / W + 1e-12); }
  return out;
}

// 4x oversampling kernels (16-tap Hann-windowed sinc) for fractions 0.25 / 0.5 / 0.75, as in narrated truePeakDbtp
const FRAC = [0.25, 0.5, 0.75].map((f) => { const w: number[] = []; for (let k = -7; k <= 8; k++) { const d = f - k; w.push((0.5 + 0.5 * Math.cos((Math.PI * d) / 8)) * (Math.sin(Math.PI * d) / (Math.PI * d))); } return w; });
/** per-sample true-peak estimate of max(|L|, |R|) including the 3 inter-sample points after i */
function tpEnvelope(L: Float32Array, R: Float32Array, g: number, floor: number): Float32Array {
  const N = L.length, out = new Float32Array(N);
  for (const x of [L, R]) for (let i = 0; i < N; i++) {
    let pk = Math.abs(x[i] * g);
    const nx = Math.abs((x[i + 1] ?? 0) * g);
    if (pk > floor || nx > floor) for (const w of FRAC) { let acc = 0; for (let k = -7; k <= 8; k++) acc += (x[i + k] ?? 0) * w[k + 7]; pk = Math.max(pk, Math.abs(acc * g)); }
    if (pk > out[i]) out[i] = pk;
  }
  return out;
}
/** true-peak limiter: gain curve never lets the oversampled peak exceed `ceil` (linear) */
function limit(L: Float32Array, R: Float32Array, g: number, ceil: number): { L: Float32Array; R: Float32Array; minGain: number } {
  const N = L.length, look = Math.max(1, Math.round(0.0015 * SR)), rel = Math.exp(-1 / (0.06 * SR));
  const pk = tpEnvelope(L, R, g, ceil * 0.5);
  const need = new Float32Array(N);
  for (let i = 0; i < N; i++) need[i] = pk[i] > ceil ? ceil / pk[i] : 1;
  // sliding minimum over [i, i + look] (monotone deque)
  const m = new Float32Array(N), dq = new Int32Array(N + look + 1); let h = 0, t = 0;
  for (let i = N - 1 + look; i >= 0; i--) {
    if (i < N) { while (t > h && need[dq[t - 1]] >= need[i]) t--; dq[t++] = i; }
    while (t > h && dq[h] > i + look) h++;
    if (i < N) m[i] = t > h ? need[dq[h]] : 1;
  }
  // instant attack / exponential release, then a `look`-long moving average (keeps gain <= need at every peak)
  const y = new Float32Array(N); let prev = 1;
  for (let i = 0; i < N; i++) { prev = m[i] < prev ? m[i] : rel * prev + (1 - rel) * m[i]; y[i] = prev; }
  const oL = new Float32Array(N), oR = new Float32Array(N); let acc = 0, minGain = 1;
  for (let i = 0; i < N; i++) {
    acc += y[i]; if (i >= look) acc -= y[i - look];
    const gi = Math.min(y[i], acc / Math.min(i + 1, look));
    minGain = Math.min(minGain, gi);
    oL[i] = L[i] * g * gi; oR[i] = R[i] * g * gi;
  }
  return { L: oL, R: oR, minGain };
}

/** smooth a per-sample gain with a centred moving average (two passes of `sec`) without ever raising it above the input */
function smoothGain(gn: Float32Array, sec: number): void {
  const n = Math.max(1, Math.round(sec * SR));
  for (let pass = 0; pass < 2; pass++) {
    const src = gn.slice(), ps = new Float64Array(src.length + 1);
    for (let i = 0; i < src.length; i++) ps[i + 1] = ps[i] + src[i];
    for (let i = 0; i < src.length; i++) { const a = Math.max(0, i - n), b = Math.min(src.length, i + n + 1); gn[i] = Math.min(src[i], (ps[b] - ps[a]) / (b - a)); }
  }
}

/** Mix a voice-over with per-event SFX. `voice.right` defaults to `voice.left` (mono VO, centred). */
export function mixVoiceSfx(voice: { left: Float32Array; right?: Float32Array }, cues: readonly SfxCueIn[], assets: AudioAssets, o: MixOptions = {}): { left: Float32Array; right: Float32Array; report: MixReport } {
  const target = o.targetLufs ?? -14, tpTarget = o.truePeakDbtp ?? -1, ref = o.sfxRefBelowVoiceDb ?? 6, duckDb = o.duckDb ?? 4;
  const speechMargin = o.speechMarginDb ?? 6, gapMargin = o.gapMarginDb ?? 3, seed = o.seed ?? 0;
  const vL = voice.left, vR = voice.right ?? voice.left, N = vL.length;
  if (vR.length !== N) throw new Error('voice channels differ in length');
  // 1. voice alone at the target
  const vIn = integratedLoudness(vL, vR), vGainDb = Number.isFinite(vIn) && vIn > -69 ? target - vIn : 0, vg = db(vGainDb);
  const VL = new Float32Array(N), VR = new Float32Array(N);
  for (let i = 0; i < N; i++) { VL[i] = vL[i] * vg; VR[i] = vR[i] * vg; }
  // 2. SFX bus, loudness-matched per cue
  const SL = new Float32Array(N), SR_ = new Float32Array(N), reports: CueReport[] = [];
  cues.forEach((c, idx) => {
    const d = SFX_DEFS[c.sfxId.split('@')[0]];
    if (!d) { reports.push({ sfxId: c.sfxId, at: c.at, source: null, pitch: 1, levelDb: 0, status: 'unknown_sfx' }); return; }
    const s0 = Math.round(c.at * SR);
    if (s0 < 0 || s0 >= N) { reports.push({ sfxId: c.sfxId, at: c.at, source: null, pitch: 1, levelDb: 0, status: 'outside_voice' }); return; }
    const r = renderSfx(c.sfxId, assets, seed, idx);
    if (!r) { reports.push({ sfxId: c.sfxId, at: c.at, source: null, pitch: 1, levelDb: 0, status: 'unresolved_source' }); return; }
    const pad = new Float32Array(Math.max(r.pcm.length, Math.round(0.4 * SR))); pad.set(r.pcm);
    const mMax = Math.max(...momentary(pad, pad, 0.01));
    const levelDb = target - ref + d.gainDb + (c.gainDb ?? 0);
    const g = db(levelDb - mMax);
    let h = 2166136261; for (const ch of `${c.sfxId}:${idx}:${seed}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
    const pan = (((h >>> 0) % 1000) / 999 * 2 - 1) * 0.25, gl = g * Math.cos(((pan + 1) * Math.PI) / 4) * Math.SQRT2, gr = g * Math.sin(((pan + 1) * Math.PI) / 4) * Math.SQRT2;
    for (let i = 0; i < r.pcm.length && s0 + i < N; i++) { SL[s0 + i] += r.pcm[i] * gl; SR_[s0 + i] += r.pcm[i] * gr; }
    reports.push({ sfxId: c.sfxId, at: c.at, source: r.source, pitch: r.pitch, levelDb: r2(levelDb), status: 'mixed' });
  });
  // 3. duck under the voice
  const att = Math.exp(-1 / (0.01 * SR)), rel = Math.exp(-1 / (0.3 * SR)), W20 = Math.round(0.02 * SR);
  let env = 0, pw = 0;
  for (let i = 0; i < N; i++) {
    const x = (VL[i] * VL[i] + VR[i] * VR[i]) / 2; pw += x; if (i >= W20) pw -= (VL[i - W20] ** 2 + VR[i - W20] ** 2) / 2;
    const rms = Math.sqrt(Math.max(0, pw) / W20);
    env = rms > env ? att * env + (1 - att) * rms : rel * env + (1 - rel) * rms;
    const a = Math.min(1, Math.max(0, (toDb(env) + 45) / 12)), g = db(-duckDb * a);
    SL[i] *= g; SR_[i] *= g;
  }
  // 4. keep the SFX underneath the voice
  const HOP = 0.05, Wn = Math.round(0.4 * SR), Hn = Math.round(HOP * SR);
  const vM = momentary(VL, VR, HOP);
  let trimMax = 0;
  for (let it = 0; it < 4; it++) {
    const sM = momentary(SL, SR_, HOP), gn = new Float32Array(N).fill(1);
    let worst = 0;
    for (let k = 0; k < sM.length; k++) {
      if (sM[k] < -70) continue;
      const allowed = vM[k] > -40 ? Math.min(vM[k] - speechMargin, target - gapMargin) : target - gapMargin;
      const over = sM[k] - allowed + (it ? 0.15 : 0.3);
      if (over <= 0) continue;
      worst = Math.max(worst, over);
      const g = db(-over);
      for (let i = k * Hn; i < Math.min(N, k * Hn + Wn); i++) if (g < gn[i]) gn[i] = g;
    }
    if (worst <= 0) break;
    smoothGain(gn, 0.01);
    for (let i = 0; i < N; i++) { SL[i] *= gn[i]; SR_[i] *= gn[i]; }
    trimMax = Math.max(trimMax, worst);
  }
  const sM = momentary(SL, SR_, HOP);
  let speechWindows = 0, minMargin = Infinity, maxS = -Infinity;
  for (let k = 0; k < sM.length; k++) { if (sM[k] < -70) continue; maxS = Math.max(maxS, sM[k]); if (vM[k] > -40) { speechWindows++; minMargin = Math.min(minMargin, vM[k] - sM[k]); } }
  // 5. sum, normalise, true-peak limit
  const ML = new Float32Array(N), MR = new Float32Array(N);
  for (let i = 0; i < N; i++) { ML[i] = VL[i] + SL[i]; MR[i] = VR[i] + SR_[i]; }
  let ceilDb = tpTarget - 0.2, gainDb = target - integratedLoudness(ML, MR), out = limit(ML, MR, db(gainDb), db(ceilDb)), tp = 0;
  for (let pass = 0; pass < 4; pass++) {
    for (let it = 0; it < 6; it++) { const got = integratedLoudness(out.L, out.R); if (Math.abs(got - target) < 0.05) break; gainDb += target - got; out = limit(ML, MR, db(gainDb), db(ceilDb)); }
    tp = truePeakDbtp(out.L, out.R);
    if (tp <= tpTarget - 0.05) break;
    ceilDb -= tp - (tpTarget - 0.1);
    out = limit(ML, MR, db(gainDb), db(ceilDb));
  }
  let sp = 0; for (let i = 0; i < N; i++) sp = Math.max(sp, Math.abs(out.L[i]), Math.abs(out.R[i]));
  return {
    left: out.L, right: out.R,
    report: {
      sampleRate: SR, channels: 2, durationSec: N / SR,
      targetLufs: target, integratedLufs: r2(integratedLoudness(out.L, out.R)),
      truePeakTargetDbtp: tpTarget, truePeakDbtp: tp, samplePeakDbfs: r2(toDb(sp)),
      gainAppliedDb: r2(gainDb), limiterMaxReductionDb: r2(-toDb(out.minGain)), limiterCeilingDbtp: r2(ceilDb),
      voice: { integratedLufsIn: r2(vIn), gainDb: r2(vGainDb) },
      sfxUnderVoice: { speechWindows, minSpeechMarginDb: Number.isFinite(minMargin) ? r2(minMargin) : null, requiredSpeechMarginDb: speechMargin, maxSfxMomentaryLufs: Number.isFinite(maxS) ? r2(maxS + gainDb) : null, guardTrimMaxDb: r2(trimMax) },
      music: 'none',
      cues: reports,
    },
  };
}
