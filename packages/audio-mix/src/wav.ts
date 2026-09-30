// Stereo WAV I/O for the mix (S7): 24-bit PCM writer with TPDF dither, and a reader that keeps channels separate
// (packages/narrated decodeWav downmixes to mono for alignment, which loudness measurement must not do).
const rngU32 = (seed: number) => { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };

export function encodeWavStereo(L: Float32Array, R: Float32Array, sampleRate: number, bits: 16 | 24 = 24, ditherSeed = 1): Uint8Array {
  const n = L.length, bps = bits / 8, out = new Uint8Array(44 + n * 2 * bps), dv = new DataView(out.buffer);
  const w = (at: number, s: string) => { for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2 * bps, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); dv.setUint16(22, 2, true); dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2 * bps, true); dv.setUint16(32, 2 * bps, true); dv.setUint16(34, bits, true);
  w(36, 'data'); dv.setUint32(40, n * 2 * bps, true);
  const full = bits === 24 ? 8388607 : 32767, r = rngU32(ditherSeed);
  let p = 44;
  for (let i = 0; i < n; i++) for (const x of [L[i], R[i]]) {
    const v = Math.max(-full - 1, Math.min(full, Math.round(x * full + (r() - r())))); // TPDF dither, 1 LSB
    if (bits === 16) { dv.setInt16(p, v, true); p += 2; }
    else { dv.setUint8(p, v & 255); dv.setUint8(p + 1, (v >> 8) & 255); dv.setUint8(p + 2, (v >> 16) & 255); p += 3; }
  }
  return out;
}

export function decodeWavStereo(b: Uint8Array): { sampleRate: number; bits: number; left: Float32Array; right: Float32Array } {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength), tag = (o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a RIFF/WAVE file');
  let off = 12, fmt: { tag: number; ch: number; sr: number; bits: number } | null = null;
  while (off + 8 <= b.length) {
    const id = tag(off), len = dv.getUint32(off + 4, true), body = off + 8;
    if (id === 'fmt ') fmt = { tag: dv.getUint16(body, true), ch: dv.getUint16(body + 2, true), sr: dv.getUint32(body + 4, true), bits: dv.getUint16(body + 14, true) };
    else if (id === 'data' && fmt) {
      const bps = fmt.bits / 8, fr = bps * fmt.ch, n = Math.floor(Math.min(len, b.length - body) / fr);
      const L = new Float32Array(n), R = new Float32Array(n);
      const rd = (p: number) => fmt!.tag === 3 ? dv.getFloat32(p, true) : fmt!.bits === 16 ? dv.getInt16(p, true) / 32768 : fmt!.bits === 24 ? (dv.getUint8(p) | (dv.getUint8(p + 1) << 8) | (dv.getInt8(p + 2) << 16)) / 8388608 : dv.getInt32(p, true) / 2147483648;
      for (let i = 0; i < n; i++) { const p = body + i * fr; L[i] = rd(p); R[i] = fmt.ch > 1 ? rd(p + bps) : L[i]; }
      return { sampleRate: fmt.sr, bits: fmt.bits, left: L, right: R };
    }
    off = body + len + (len & 1);
  }
  throw new Error('WAV has no fmt/data chunk');
}
