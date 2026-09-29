// Offline deterministic phrase alignment (no speech model). The creator supplies the exact script, so we only need to
// find WHEN each ordered phrase is spoken:
//   1. 20 ms RMS energy frames of the mono signal -> adaptive speech/silence threshold (noise-floor vs speech quantiles)
//   2. speech regions = speech frames with gaps < MIN_PAUSE closed and blips < MIN_REGION removed
//   3. monotone DP maps phrases to regions: 1:1 (silence-guided), many regions -> 1 phrase (merged-regions) or
//      1 region -> many phrases split by word count (split-region); cost = duration mismatch vs word-count share
//   4. no usable contrast (continuous music bed, noise) -> word-count proportion over the speech span (word-proportional)
// Timing is PHRASE-level only; there is no word-level claim. Output is a pure function of (PCM, phrases).
import type { DecodedAudio } from './audio.ts';
import type { AlignmentMethod } from './schema.ts';

export interface AlignedPhrase { index: number; start: number; end: number; method: AlignmentMethod; confidence: number }
export interface AlignmentResult {
  aligner: string; phrases: AlignedPhrase[]; speechRegions: Array<{ start: number; end: number }>;
  level: 'high' | 'medium' | 'low'; confidence: number; estimatedPhrases: number; note: string;
}
/** provider seam: a future WhisperX / Montreal Forced Aligner / cloud aligner implements the same contract */
export interface NarrationAligner {
  readonly id: string;
  align(input: { audioPath: string | null; audio: DecodedAudio; phrases: string[]; seed: number }): Promise<AlignmentResult>;
}

const FRAME = 0.02, MIN_PAUSE = 0.15, MIN_REGION = 0.08, MIN_CONTRAST_DB = 12, TAIL_HOLD = 0.12;
export const wordCount = (s: string) => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length || 1;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const quantile = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))]; };

export function speechRegions(pcm: Float32Array, rate: number): { regions: Array<{ start: number; end: number }>; contrastDb: number } {
  const hop = Math.max(1, Math.round(rate * FRAME)), n = Math.floor(pcm.length / hop);
  const db: number[] = [];
  for (let f = 0; f < n; f++) { let e = 0; for (let i = f * hop; i < (f + 1) * hop; i++) e += pcm[i] * pcm[i]; db.push(10 * Math.log10(e / hop + 1e-12)); }
  if (!n) return { regions: [], contrastDb: 0 };
  const floor = quantile(db, 0.1), loud = quantile(db, 0.95), contrastDb = loud - floor;
  if (contrastDb < MIN_CONTRAST_DB) return { regions: [], contrastDb };
  const thr = floor + 0.3 * contrastDb;
  let regs: Array<{ a: number; b: number }> = [];
  for (let f = 0; f < n; f++) if (db[f] > thr) { const last = regs[regs.length - 1]; if (last && f - last.b <= Math.round(MIN_PAUSE / FRAME)) last.b = f + 1; else regs.push({ a: f, b: f + 1 }); }
  regs = regs.filter((r) => (r.b - r.a) * FRAME >= MIN_REGION);
  return { regions: regs.map((r) => ({ start: r3(r.a * FRAME), end: r3(r.b * FRAME) })), contrastDb };
}

interface Step { i: number; k: number; kind: 'one' | 'merge' | 'split' }
export function alignPhrases(audio: Pick<DecodedAudio, 'pcm' | 'analysisRate' | 'durationSeconds'>, phrases: string[]): AlignmentResult {
  const D = audio.durationSeconds, N = phrases.length, w = phrases.map(wordCount), W = w.reduce((a, b) => a + b, 0);
  const { regions, contrastDb } = speechRegions(audio.pcm, audio.analysisRate);
  const R = regions.length;
  let out: AlignedPhrase[];
  let note: string;
  if (!R || N === 0) {
    // no detectable pauses: allocate the whole file (minus a short lead-in) by word count
    const a0 = Math.min(0.1, D * 0.02), span = D - a0;
    let t = a0;
    out = w.map((x, k) => { const s = t; t += (span * x) / W; return { index: k, start: s, end: t, method: 'word-proportional' as const, confidence: 0.25 }; });
    note = R ? 'no phrases' : `no speech/silence contrast detected (${contrastDb.toFixed(1)} dB); timing is estimated from word counts only`;
  } else {
    const span = regions[R - 1].end - regions[0].start;
    const exp = (k0: number, k1: number) => (span * w.slice(k0, k1).reduce((a, b) => a + b, 0)) / W;
    const mis = (dur: number, e: number) => Math.log(Math.max(dur, 0.05) / Math.max(e, 0.05)) ** 2;
    // cost[i][k]: best cost using the first i regions for the first k phrases (monotone, every region and phrase used)
    const INF = 1e18, cost = Array.from({ length: R + 1 }, () => new Float64Array(N + 1).fill(INF)), back: (Step | null)[][] = Array.from({ length: R + 1 }, () => Array(N + 1).fill(null));
    cost[0][0] = 0;
    for (let i = 0; i < R; i++) for (let k = 0; k < N; k++) {
      if (cost[i][k] >= INF) continue;
      // regions i..j -> phrase k (j = i: one-to-one)
      for (let j = i; j < R && j < i + 12; j++) {
        const dur = regions[j].end - regions[i].start, c = cost[i][k] + mis(dur, exp(k, k + 1)) + 0.25 * (j - i);
        if (c < cost[j + 1][k + 1]) { cost[j + 1][k + 1] = c; back[j + 1][k + 1] = { i, k, kind: j === i ? 'one' : 'merge' }; }
      }
      // region i -> phrases k..m (m > k)
      for (let m = k + 1; m < N && m < k + 8; m++) {
        const dur = regions[i].end - regions[i].start, c = cost[i][k] + mis(dur, exp(k, m + 1)) + 0.6 * (m - k);
        if (c < cost[i + 1][m + 1]) { cost[i + 1][m + 1] = c; back[i + 1][m + 1] = { i, k, kind: 'split' }; }
      }
    }
    if (cost[R][N] >= INF) return alignPhrases({ ...audio, pcm: new Float32Array(0) }, phrases);
    const steps: Array<Step & { j: number; m: number }> = [];
    for (let i = R, k = N; i > 0 || k > 0;) { const s = back[i][k]!; steps.unshift({ ...s, j: i, m: k }); i = s.i; k = s.k; }
    out = [];
    for (const s of steps) {
      const a = regions[s.i].start, b = regions[s.j - 1].end;
      if (s.kind === 'split') {
        const ws = w.slice(s.k, s.m), tot = ws.reduce((x, y) => x + y, 0);
        let t = a;
        ws.forEach((x, q) => { const st = t; t += ((b - a) * x) / tot; out.push({ index: s.k + q, start: st, end: t, method: 'split-region', confidence: ws.length > 2 ? 0.35 : 0.45 }); });
      } else {
        const fit = Math.exp(-mis(b - a, exp(s.k, s.k + 1)));
        out.push({ index: s.k, start: a, end: b, method: s.kind === 'one' ? 'silence-guided' : 'merged-regions', confidence: s.kind === 'one' ? 0.6 + 0.35 * fit : 0.5 + 0.2 * fit });
      }
    }
    note = `${R} speech region(s) for ${N} phrase(s) (contrast ${contrastDb.toFixed(1)} dB)`;
  }
  // hold each caption briefly after speech ends, never into the next phrase or past the file; ms rounding; no overlaps
  out.sort((a, b) => a.index - b.index);
  for (let k = 0; k < out.length; k++) {
    const p = out[k], next = out[k + 1];
    p.start = r3(Math.max(0, Math.min(p.start, D - 0.05)));
    p.end = r3(Math.min(D, next ? Math.max(p.end, Math.min(p.end + TAIL_HOLD, next.start)) : p.end + TAIL_HOLD));
    if (k > 0 && p.start < out[k - 1].end) p.start = out[k - 1].end;
    if (p.end <= p.start) p.end = r3(Math.min(D, p.start + 0.05));
    p.confidence = r3(p.confidence);
  }
  const confidence = r3(out.reduce((a, p) => a + p.confidence, 0) / Math.max(1, out.length));
  const estimated = out.filter((p) => p.method === 'split-region' || p.method === 'word-proportional').length;
  const level = estimated > N / 2 || confidence < 0.55 ? 'low' : estimated > 0 || out.some((p) => p.method === 'merged-regions') || confidence < 0.8 ? 'medium' : 'high';
  return { aligner: 'silence-guided-v1', phrases: out, speechRegions: regions, level, confidence, estimatedPhrases: estimated, note };
}

export class SilenceGuidedAligner implements NarrationAligner {
  readonly id = 'silence-guided-v1';
  async align(input: { audioPath: string | null; audio: DecodedAudio; phrases: string[]; seed: number }): Promise<AlignmentResult> {
    // the seed is accepted for interface parity; alignment itself is seed-independent by design
    return alignPhrases(input.audio, input.phrases);
  }
}
