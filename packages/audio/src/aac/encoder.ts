// Minimal, deterministic AAC-LC encoder (MPEG-4 Audio Object Type 2), pure TypeScript.
// Scope: 48 kHz, mono/stereo (SCE/CPE, common_window = 0), ONLY_LONG_SEQUENCE with sine window, no TNS/PNS/M-S,
// per-frame rate control by binary search on a (mildly energy-shaped) scalefactor field, Huffman codebook choice per
// band, section merging. Output: raw access units (one raw_data_block per 1024 samples) + AudioSpecificConfig.
// Encoder delay ("priming") is exactly 1024 samples; muxers must signal it with an edit list.
import { SF_BITS, SF_CODES, SPECTRAL_BITS, SPECTRAL_CODES, SWB_OFFSET_LONG_48K } from './tables.ts';
import { Mdct } from './mdct.ts';

export const AAC_FRAME = 1024;
export const AAC_PRIMING = 1024;

export interface AacEncoded { frames: Uint8Array[]; asc: Uint8Array; sampleRate: number; channels: number; priming: number; inputSamples: number; bitrate: number; stats: { avgBits: number; maxBits: number; clippedCoefficients: number } }

class BitWriter {
  private buf = new Uint8Array(1024);
  private pos = 0; // bit position
  write(value: number, bits: number): void {
    if (bits === 0) return;
    if (bits > 24) { this.write(Math.floor(value / 2 ** 16), bits - 16); this.write(value & 0xffff, 16); return; }
    if (((this.pos + bits) >> 3) + 4 > this.buf.length) { const n = new Uint8Array(this.buf.length * 2); n.set(this.buf); this.buf = n; }
    for (let i = bits - 1; i >= 0; i--) {
      if ((value >>> i) & 1) this.buf[this.pos >> 3] |= 0x80 >> (this.pos & 7);
      this.pos++;
    }
  }
  get bits(): number { return this.pos; }
  bytes(): Uint8Array { return this.buf.slice(0, (this.pos + 7) >> 3); }
}

// codebook metadata: [dimension, signed, largest absolute value]
const CB: Array<[number, boolean, number]> = [[0, false, 0], [4, true, 1], [4, true, 1], [4, false, 2], [4, false, 2], [2, true, 4], [2, true, 4], [2, false, 7], [2, false, 7], [2, false, 12], [2, false, 12], [2, false, 16]];
const ESC_CB = 11;

function tupleIndex(cb: number, q: Int32Array, k: number): number {
  const [dim, signed, lav] = CB[cb];
  if (dim === 4) {
    if (signed) return 27 * (q[k] + 1) + 9 * (q[k + 1] + 1) + 3 * (q[k + 2] + 1) + (q[k + 3] + 1);
    return 27 * Math.abs(q[k]) + 9 * Math.abs(q[k + 1]) + 3 * Math.abs(q[k + 2]) + Math.abs(q[k + 3]);
  }
  if (signed) return 9 * (q[k] + 4) + (q[k + 1] + 4);
  const mod = lav + 1;
  if (cb === ESC_CB) return 17 * Math.min(16, Math.abs(q[k])) + Math.min(16, Math.abs(q[k + 1]));
  return mod * Math.abs(q[k]) + Math.abs(q[k + 1]);
}
const escBits = (a: number): number => (a < 16 ? 0 : 2 * Math.floor(Math.log2(a)) - 3); // prefix (N-4 ones + 0) + N bits

/** bits to code band [s, e) with codebook cb (Infinity if not representable) */
function bandBits(cb: number, q: Int32Array, s: number, e: number): number {
  if (cb === 0) { for (let k = s; k < e; k++) if (q[k] !== 0) return Infinity; return 0; }
  const [dim, signed, lav] = CB[cb];
  const bits = SPECTRAL_BITS[cb - 1];
  let total = 0;
  for (let k = s; k < e; k += dim) {
    for (let j = 0; j < dim; j++) if (Math.abs(q[k + j]) > lav && cb !== ESC_CB) return Infinity;
    total += bits[tupleIndex(cb, q, k)];
    if (!signed) for (let j = 0; j < dim; j++) { const a = Math.abs(q[k + j]); if (a) total += 1; if (cb === ESC_CB) total += escBits(a); }
  }
  return total;
}

function writeBand(w: BitWriter, cb: number, q: Int32Array, s: number, e: number): void {
  const [dim, signed] = CB[cb];
  const codes = SPECTRAL_CODES[cb - 1], bits = SPECTRAL_BITS[cb - 1];
  for (let k = s; k < e; k += dim) {
    const idx = tupleIndex(cb, q, k);
    w.write(codes[idx], bits[idx]);
    if (!signed) {
      for (let j = 0; j < dim; j++) if (q[k + j] !== 0) w.write(q[k + j] < 0 ? 1 : 0, 1);
      if (cb === ESC_CB) for (let j = 0; j < 2; j++) {
        const a = Math.abs(q[k + j]);
        if (a >= 16) { const n = Math.floor(Math.log2(a)); for (let i = 0; i < n - 4; i++) w.write(1, 1); w.write(0, 1); w.write(a - (1 << n), n); }
      }
    }
  }
}

interface ChannelPlan { globalGain: number; maxSfb: number; sfs: Int32Array; cbs: Int32Array; q: Int32Array; bits: number; clipped?: number }

const NBANDS = SWB_OFFSET_LONG_48K.length - 1;
const MAGIC = 0.4054;
/** 0 = flat noise (max SNR); >0 lets loud bands carry proportionally more noise */
export let SHAPING = 0; // flat noise measured best SNR (docs/story/IMPLEMENTATION_LOG.md)
export function setShaping(v: number): void { SHAPING = v; }

export class AacLcEncoder {
  readonly channels: number;
  readonly bitrate: number;
  private mdct = new Mdct(AAC_FRAME);
  private win = new Float64Array(2 * AAC_FRAME);
  private maxBandForCutoff: number;
  private clipped = 0;

  constructor(channels: number, bitrate: number, cutoffHz = 16000) {
    if (channels !== 1 && channels !== 2) throw new Error('AAC encoder supports mono or stereo');
    this.channels = channels; this.bitrate = bitrate;
    for (let n = 0; n < 2 * AAC_FRAME; n++) this.win[n] = Math.sin((Math.PI / (2 * AAC_FRAME)) * (n + 0.5));
    const cutBin = Math.floor((cutoffHz / 24000) * AAC_FRAME);
    let mb = 0; while (mb < NBANDS && SWB_OFFSET_LONG_48K[mb] < cutBin) mb++;
    this.maxBandForCutoff = mb;
  }

  static asc(channels: number): Uint8Array {
    // audioObjectType=2 (5b) samplingFrequencyIndex=3 (48000, 4b) channelConfiguration (4b) GASpecificConfig=000
    const v = (2 << 11) | (3 << 7) | (channels << 3);
    return new Uint8Array([(v >> 8) & 255, v & 255]);
  }

  private quantize(X: Float64Array, sfs: Int32Array, maxSfb: number, q: Int32Array): number {
    q.fill(0);
    let clipped = 0;
    for (let b = 0; b < maxSfb; b++) {
      const inv = 2 ** (-0.25 * (sfs[b] - 100));
      for (let k = SWB_OFFSET_LONG_48K[b]; k < SWB_OFFSET_LONG_48K[b + 1]; k++) {
        const a = Math.abs(X[k]) * inv;
        let v = Math.floor(Math.pow(a, 0.75) + MAGIC);
        if (v > 8191) { v = 8191; clipped++; }
        q[k] = X[k] < 0 ? -v : v;
      }
    }
    return clipped;
  }

  /** choose codebooks + count bits for a quantized channel */
  private plan(q: Int32Array, sfs: Int32Array, globalGain: number, maxSfbIn: number): ChannelPlan {
    let maxSfb = maxSfbIn;
    const cbs = new Int32Array(NBANDS);
    let spectral = 0;
    for (let b = 0; b < maxSfb; b++) {
      const s = SWB_OFFSET_LONG_48K[b], e = SWB_OFFSET_LONG_48K[b + 1];
      let maxAbs = 0; for (let k = s; k < e; k++) maxAbs = Math.max(maxAbs, Math.abs(q[k]));
      if (maxAbs === 0) { cbs[b] = 0; continue; }
      let best = -1, bestBits = Infinity;
      for (let cb = 1; cb <= 11; cb++) { if (CB[cb][2] < maxAbs && cb !== ESC_CB) continue; const nb = bandBits(cb, q, s, e); if (nb < bestBits) { bestBits = nb; best = cb; } }
      cbs[b] = best; spectral += bestBits;
    }
    while (maxSfb > 0 && cbs[maxSfb - 1] === 0) maxSfb--;
    // sections
    let sectionBits = 0;
    for (let b = 0; b < maxSfb;) { let e = b; while (e < maxSfb && cbs[e] === cbs[b]) e++; sectionBits += 4 + 5 * (Math.floor((e - b) / 31) + 1); b = e; }
    // scalefactors (differential from global gain; zero-codebook bands carry none)
    let sfBits = 0, last = globalGain;
    for (let b = 0; b < maxSfb; b++) { if (cbs[b] === 0) continue; const d = sfs[b] - last; sfBits += SF_BITS[d + 60]; last = sfs[b]; }
    const bits = 8 + 11 + sectionBits + sfBits + 3 + spectral;
    return { globalGain, maxSfb, sfs, cbs, q, bits };
  }

  /** rate control: binary search the smallest base scalefactor that fits the bit budget WITHOUT clipping any
   *  coefficient at the ESC limit (both conditions are monotone in the base step size) */
  private encodeChannel(X: Float64Array, budget: number): ChannelPlan {
    const maxSfb = this.maxBandForCutoff;
    // mild energy shaping: louder bands tolerate proportionally more noise (offset in 1.5 dB steps, clamped)
    const energy = new Float64Array(maxSfb);
    let meanLog = 0, nz = 0;
    for (let b = 0; b < maxSfb; b++) {
      let e = 0; const s = SWB_OFFSET_LONG_48K[b], t = SWB_OFFSET_LONG_48K[b + 1];
      for (let k = s; k < t; k++) e += X[k] * X[k];
      energy[b] = e / (t - s);
      if (energy[b] > 1) { meanLog += Math.log2(energy[b]); nz++; }
    }
    meanLog = nz ? meanLog / nz : 0;
    const offs = new Int32Array(maxSfb);
    for (let b = 0; b < maxSfb; b++) offs[b] = energy[b] > 1 ? Math.max(-8, Math.min(8, Math.round(SHAPING * (Math.log2(energy[b]) - meanLog) * 2))) : 0;
    const q = new Int32Array(AAC_FRAME);
    const sfs = new Int32Array(NBANDS);
    const tryBase = (base: number): ChannelPlan => {
      for (let b = 0; b < maxSfb; b++) sfs[b] = Math.max(0, Math.min(255, base + offs[b]));
      const clipped = this.quantize(X, sfs, maxSfb, q);
      // keep scalefactor differences inside the codebook range (+-60) and anchor global gain on first coded band
      const p0 = this.plan(q, sfs, sfs[0], maxSfb);
      let first = -1; for (let b = 0; b < p0.maxSfb; b++) if (p0.cbs[b] !== 0) { first = b; break; }
      const gg = first >= 0 ? sfs[first] : 100;
      let last = gg;
      for (let b = 0; b < p0.maxSfb; b++) { if (p0.cbs[b] === 0) continue; sfs[b] = Math.max(last - 60, Math.min(last + 60, sfs[b])); last = sfs[b]; }
      return { ...this.plan(q, sfs, gg, maxSfb), clipped };
    };
    let lo = 60, hi = 255, best: ChannelPlan | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const p = tryBase(mid);
      if (p.bits <= budget && !p.clipped) { best = { ...p, sfs: Int32Array.from(p.sfs), q: Int32Array.from(p.q), cbs: Int32Array.from(p.cbs) }; hi = mid - 1; } else lo = mid + 1;
    }
    if (!best) { const p = tryBase(255); best = { ...p, sfs: Int32Array.from(p.sfs), q: Int32Array.from(p.q), cbs: Int32Array.from(p.cbs) }; }
    this.clipped += best.clipped ?? 0;
    return best;
  }

  private writeIcs(w: BitWriter, p: ChannelPlan): void {
    w.write(p.globalGain, 8);
    // ics_info: reserved 0, ONLY_LONG_SEQUENCE, sine window, max_sfb, no prediction
    w.write(0, 1); w.write(0, 2); w.write(0, 1); w.write(p.maxSfb, 6); w.write(0, 1);
    for (let b = 0; b < p.maxSfb;) {
      let e = b; while (e < p.maxSfb && p.cbs[e] === p.cbs[b]) e++;
      w.write(p.cbs[b], 4);
      let len = e - b; while (len >= 31) { w.write(31, 5); len -= 31; } w.write(len, 5);
      b = e;
    }
    let last = p.globalGain;
    for (let b = 0; b < p.maxSfb; b++) { if (p.cbs[b] === 0) continue; const d = p.sfs[b] - last; w.write(SF_CODES[d + 60], SF_BITS[d + 60]); last = p.sfs[b]; }
    w.write(0, 1); w.write(0, 1); w.write(0, 1); // pulse, tns, gain control
    for (let b = 0; b < p.maxSfb; b++) if (p.cbs[b] !== 0) writeBand(w, p.cbs[b], p.q, SWB_OFFSET_LONG_48K[b], SWB_OFFSET_LONG_48K[b + 1]);
  }

  /** Encode planar float PCM in [-1, 1] at 48 kHz. */
  encode(pcm: Float32Array[]): AacEncoded {
    const n = pcm[0].length;
    const frames: Uint8Array[] = [];
    const nFrames = Math.ceil(n / AAC_FRAME) + 1; // +1 flushes the overlap of the last block
    const frameBudget = Math.floor((this.bitrate * AAC_FRAME) / 48000);
    const perChannel = Math.floor((frameBudget - 11) / this.channels);
    const buf = new Float64Array(2 * AAC_FRAME), X = new Float64Array(AAC_FRAME);
    let sumBits = 0, maxBits = 0;
    for (let f = 0; f < nFrames; f++) {
      const plans: ChannelPlan[] = [];
      for (let c = 0; c < this.channels; c++) {
        const x = pcm[c];
        const start = (f - 1) * AAC_FRAME;
        for (let i = 0; i < 2 * AAC_FRAME; i++) { const j = start + i; buf[i] = j >= 0 && j < n ? x[j] * 65536 * this.win[i] : 0; } // AAC analysis MDCT is 2*sum (x2) on 16-bit-scale PCM
        this.mdct.forward(buf, X);
        plans.push(this.encodeChannel(X, perChannel));
      }
      const w = new BitWriter();
      if (this.channels === 2) { w.write(1, 3); w.write(0, 4); w.write(0, 1); } else { w.write(0, 3); w.write(0, 4); }
      for (const p of plans) this.writeIcs(w, p);
      w.write(7, 3); // ID_END
      sumBits += w.bits; maxBits = Math.max(maxBits, w.bits);
      frames.push(w.bytes());
    }
    return { frames, asc: AacLcEncoder.asc(this.channels), sampleRate: 48000, channels: this.channels, priming: AAC_PRIMING, inputSamples: n, bitrate: this.bitrate, stats: { avgBits: Math.round(sumBits / frames.length), maxBits, clippedCoefficients: this.clipped } };
  }
}

export function encodeAacLc(channels: Float32Array[], bitrate = 160000, cutoffHz = 16000): AacEncoded {
  return new AacLcEncoder(channels.length, bitrate, cutoffHz).encode(channels);
}
