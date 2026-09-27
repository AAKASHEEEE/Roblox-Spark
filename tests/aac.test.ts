import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Mdct, mdctDirect, imdctIso } from '../packages/audio/src/aac/mdct.ts';
import { AacLcEncoder, encodeAacLc } from '../packages/audio/src/aac/encoder.ts';
import { SPECTRAL_BITS, SPECTRAL_CODES, SF_BITS, SF_CODES, SWB_OFFSET_LONG_48K } from '../packages/audio/src/aac/tables.ts';
import { aacRoundTrip } from '../apps/render-worker/lib/aac-check.ts';

test('AAC Huffman tables are complete prefix codes (ISO 14496-3 sizes)', () => {
  const sizes = [81, 81, 81, 81, 81, 81, 64, 64, 169, 169, 289];
  const kraft = (b: readonly number[]) => b.reduce((a, x) => a + 2 ** -x, 0);
  SPECTRAL_BITS.forEach((b, i) => { assert.equal(b.length, sizes[i]); assert.ok(Math.abs(kraft(b) - 1) < 1e-12, `cb${i + 1}`); SPECTRAL_CODES[i].forEach((c, k) => assert.ok(c < 2 ** b[k])); });
  assert.equal(SF_BITS.length, 121); assert.equal(SF_BITS[60], 1); assert.equal(SF_CODES[60], 0); assert.ok(Math.abs(kraft(SF_BITS) - 1) < 1e-12);
  assert.equal(SWB_OFFSET_LONG_48K.length, 50); assert.equal(SWB_OFFSET_LONG_48K[49], 1024);
});
test('FFT-based MDCT equals the direct definition and reconstructs with the ISO synthesis (TDAC)', () => {
  const M = 64; const x = Float64Array.from({ length: 2 * M }, (_, i) => Math.sin(i * 0.37) + 0.3 * Math.cos(i * 1.7));
  const a = new Float64Array(M); new Mdct(M).forward(x, a); const b = mdctDirect(x, M);
  assert.ok(Math.max(...a.map((v, i) => Math.abs(v - b[i]))) < 1e-9);
  const sig = Float64Array.from({ length: 4 * M }, (_, i) => Math.sin(i * 0.21)); const y = new Float64Array(4 * M);
  const w = (n: number) => Math.sin((Math.PI / (2 * M)) * (n + 0.5));
  for (let f = 0; f < 3; f++) { const blk = Float64Array.from({ length: 2 * M }, (_, n) => sig[f * M + n] * w(n)); const X = mdctDirect(blk, M).map((v) => 2 * v); const r = imdctIso(X, M); for (let n = 0; n < 2 * M; n++) y[f * M + n] += r[n] * w(n); }
  for (let i = M; i < 3 * M; i++) assert.ok(Math.abs(y[i] - sig[i]) < 1e-9);
});
test('encoder: AudioSpecificConfig, frame count, priming and byte-determinism', () => {
  assert.deepEqual([...AacLcEncoder.asc(2)], [0x11, 0x90]);
  const n = 48000; const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) { L[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / 48000); R[i] = 0.2 * Math.sin((2 * Math.PI * 880 * i) / 48000); }
  const a = encodeAacLc([L, R], 160000), b = encodeAacLc([L, R], 160000);
  assert.equal(a.frames.length, Math.ceil(n / 1024) + 1);
  assert.equal(a.priming, 1024);
  assert.deepEqual(a.frames, b.frames);
  assert.ok(a.stats.maxBits <= 6144 * 2, 'AAC-LC per-frame limit');
});
test('encoder output decodes in Chromium\'s AAC decoder with bounded error', { timeout: 120000 }, async () => {
  const n = 48000; const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) { const t = i / 48000; L[i] = 0.25 * Math.sin(2 * Math.PI * 440 * t) + 0.05 * Math.sin(2 * Math.PI * 5000 * t); R[i] = 0.3 * Math.sin(2 * Math.PI * (200 + 2000 * t) * t); }
  const e = encodeAacLc([L, R], 160000);
  const r = await aacRoundTrip(e.frames, e.asc, [L, R], e.priming);
  assert.ok(r.ok, r.error);
  assert.equal(r.bestLag, 1024, 'decoder delay equals signalled priming');
  assert.ok(Math.min(...r.snrDb) > 20, `SNR ${r.snrDb}`);
});
