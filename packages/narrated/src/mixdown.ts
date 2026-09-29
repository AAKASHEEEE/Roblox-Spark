// Narrated draft audio: the uploaded voice-over is the primary track (never cut, stretched or delayed), placed equally in
// both channels at 48 kHz; registered procedural SFX at low level, ducked under the voice; integrated loudness
// normalised (BS.1770) and a -2 dBFS lookahead limiter; true peak estimated with 4x windowed-sinc oversampling.
import { SR, PATCHES } from '../../audio/src/synth.ts';
import { integratedLoudness } from '../../audio/src/mix.ts';

export interface VoMixReport { integratedLufs: number; truePeakDbtp: number; samplePeakDbfs: number; gainAppliedDb: number; limiterReductionDb: number; sfxCues: number; missing: string[]; durationSec: number; sampleRate: number }
const db = (x: number) => Math.pow(10, x / 20);

/** linear-phase resampler (windowed sinc) to 48 kHz; exact output length = round(duration * 48000) */
export function resampleTo48k(x: Float32Array, rate: number): Float32Array {
  if (rate === SR) return x;
  const n = Math.round((x.length * SR) / rate), out = new Float32Array(n), ratio = rate / SR, cut = Math.min(1, SR / rate), taps = 16;
  for (let i = 0; i < n; i++) {
    const p = i * ratio, k0 = Math.floor(p);
    let acc = 0, wsum = 0;
    for (let k = k0 - taps + 1; k <= k0 + taps; k++) {
      const d = p - k, w = 0.5 + 0.5 * Math.cos((Math.PI * d) / taps), s = d === 0 ? 1 : Math.sin(Math.PI * d * cut) / (Math.PI * d * cut);
      const v = k >= 0 && k < x.length ? x[k] : 0;
      acc += v * s * w; wsum += s * w;
    }
    out[i] = wsum ? acc / wsum : 0;
  }
  return out;
}

/** 4x oversampled peak (windowed-sinc interpolation between samples) in dBTP */
export function truePeakDbtp(L: Float32Array, R: Float32Array): number {
  let pk = 0;
  for (const x of [L, R]) for (let i = 0; i < x.length; i++) {
    pk = Math.max(pk, Math.abs(x[i]));
    if (Math.abs(x[i]) < 0.25 && Math.abs(x[i + 1] ?? 0) < 0.25) continue; // inter-sample overs only occur near loud samples
    for (const f of [0.25, 0.5, 0.75]) {
      let acc = 0;
      for (let k = -7; k <= 8; k++) { const j = i + k, d = f - k, w = 0.5 + 0.5 * Math.cos((Math.PI * d) / 8); acc += (x[j] ?? 0) * (Math.sin(Math.PI * d) / (Math.PI * d)) * w; }
      pk = Math.max(pk, Math.abs(acc));
    }
  }
  return +(20 * Math.log10(pk + 1e-12)).toFixed(2);
}

export function mixVoiceOver(vo48k: Float32Array, cues: Array<{ sfx: string; at: number; gainDb: number }>, assets: Record<string, { synth: string; params: Record<string, number> }>, o: { loudnessLufs: number; duckingDb: number }): { left: Float32Array; right: Float32Array; report: VoMixReport } {
  const N = vo48k.length;
  const sfx = new Float32Array(N), missing: string[] = [];
  for (const c of cues) {
    const a = assets[c.sfx];
    if (!a || !PATCHES[a.synth]) { missing.push(c.sfx); continue; }
    const s = PATCHES[a.synth](a.params), g = db(c.gainDb), s0 = Math.round(c.at * SR);
    for (let i = 0; i < s.length && s0 + i < N; i++) sfx[s0 + i] += s[i] * g;
  }
  // duck SFX under the voice: 10 ms attack / 250 ms release envelope of the voice-over
  const att = Math.exp(-1 / (0.01 * SR)), rel = Math.exp(-1 / (0.25 * SR)), duck = db(-o.duckingDb);
  let env = 0;
  const L = new Float32Array(N), R = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const a = Math.abs(vo48k[i]);
    env = a > env ? att * env + (1 - att) * a : rel * env + (1 - rel) * a;
    const g = env > 0.02 ? duck : 1;
    L[i] = R[i] = vo48k[i] + sfx[i] * g;
  }
  // loudness: iterate gain -> limiter -> measure (the limiter only touches rare peaks)
  const ceil = db(-2.0), look = Math.round(0.005 * SR), relG = Math.exp(-1 / (0.08 * SR));
  const limit = (gain: number) => {
    const oL = new Float32Array(N), oR = new Float32Array(N); let gr = 1, minGr = 1;
    for (let i = 0; i < N; i++) {
      let pk = 0;
      for (let k = 0; k <= look && i + k < N; k += 4) pk = Math.max(pk, Math.abs(L[i + k] * gain));
      const need = pk > ceil ? ceil / pk : 1;
      gr = need < gr ? need : relG * gr + (1 - relG) * need; minGr = Math.min(minGr, gr);
      oL[i] = oR[i] = Math.max(-ceil, Math.min(ceil, L[i] * gain * gr));
    }
    return { L: oL, R: oR, red: -20 * Math.log10(minGr) };
  };
  const pre = integratedLoudness(L, R);
  let gainDb = Number.isFinite(pre) ? o.loudnessLufs - pre : 0, out = limit(db(gainDb));
  for (let it = 0; it < 4; it++) { const got = integratedLoudness(out.L, out.R); if (!Number.isFinite(got) || Math.abs(got - o.loudnessLufs) < 0.2) break; gainDb += o.loudnessLufs - got; out = limit(db(gainDb)); }
  let sp = 0; for (let i = 0; i < N; i++) sp = Math.max(sp, Math.abs(out.L[i]));
  return { left: out.L, right: out.R, report: { integratedLufs: +integratedLoudness(out.L, out.R).toFixed(2), truePeakDbtp: truePeakDbtp(out.L, out.R), samplePeakDbfs: +(20 * Math.log10(sp + 1e-12)).toFixed(2), gainAppliedDb: +gainDb.toFixed(2), limiterReductionDb: +out.red.toFixed(2), sfxCues: cues.length, missing, durationSec: N / SR, sampleRate: SR } };
}
