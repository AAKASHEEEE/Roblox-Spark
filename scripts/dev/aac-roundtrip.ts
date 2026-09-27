import { readFileSync } from 'node:fs';
import { encodeAacLc } from '../../packages/audio/src/aac/encoder.ts';
import { Mdct, mdctDirect, imdctIso } from '../../packages/audio/src/aac/mdct.ts';
import { aacRoundTrip } from '../../apps/render-worker/lib/aac-check.ts';
// 1) MDCT correctness + TDAC scaling
const M = 64; const x = Float64Array.from({ length: 2 * M }, (_, i) => Math.sin(i * 0.37) + 0.3 * Math.cos(i * 1.7));
const a = new Float64Array(M); new Mdct(M).forward(x, a); const b = mdctDirect(x, M);
console.log('mdct max err', Math.max(...a.map((v, i) => Math.abs(v - b[i]))).toExponential(2));
const sig = Float64Array.from({ length: 4 * M }, (_, i) => Math.sin(i * 0.21));
const w = (n: number) => Math.sin((Math.PI / (2 * M)) * (n + 0.5));
const y = new Float64Array(4 * M);
for (let f = 0; f < 3; f++) { const blk = Float64Array.from({ length: 2 * M }, (_, n) => sig[f * M + n] * w(n)); const X = mdctDirect(blk, M).map((v) => 2 * v); const r = imdctIso(X, M); for (let n = 0; n < 2 * M; n++) y[f * M + n] += r[n] * w(n); }
console.log('TDAC recon err (middle)', Math.max(...Array.from({ length: 2 * M }, (_, i) => Math.abs(y[M + i] - sig[M + i]))).toExponential(2));
// 2) synthetic stereo signal
const N = 48000 * 2;
const L = new Float32Array(N), R = new Float32Array(N);
for (let i = 0; i < N; i++) { const t = i / 48000; L[i] = 0.25 * Math.sin(2 * Math.PI * 440 * t) + 0.08 * Math.sin(2 * Math.PI * 3000 * t); const f = 100 + 3950 * t; R[i] = 0.3 * Math.sin(2 * Math.PI * f * t) + 0.01 * (((i * 2654435761) >>> 0) / 4294967296 - 0.5); }
let t0 = Date.now(); const e = encodeAacLc([L, R], 160000); console.log('encode ms', Date.now() - t0, 'frames', e.frames.length, 'asc', Buffer.from(e.asc).toString('hex'), e.stats);
console.log('synthetic', JSON.stringify(await aacRoundTrip(e.frames, e.asc, [L, R], 1024)));
// 3) real PoC mix
const wav = readFileSync('out/free-coins-loop-001/mix.wav'); const n = (wav.length - 44) / 4; const ML = new Float32Array(n), MR = new Float32Array(n);
for (let i = 0; i < n; i++) { ML[i] = wav.readInt16LE(44 + i * 4) / 32768; MR[i] = wav.readInt16LE(46 + i * 4) / 32768; }
t0 = Date.now(); const e2 = encodeAacLc([ML, MR], 160000); console.log('mix encode ms', Date.now() - t0, 'frames', e2.frames.length, e2.stats, 'bytes', e2.frames.reduce((a2, f) => a2 + f.length, 0));
console.log('poc mix', JSON.stringify(await aacRoundTrip(e2.frames, e2.asc, [ML, MR], 1024)));
