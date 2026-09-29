import { readFileSync } from 'node:fs';
import { encodeAacLc, setShaping } from '../../packages/audio/src/aac/encoder.ts';
import { aacRoundTrip } from '../../apps/render-worker/lib/aac-check.ts';
import { launchBrowser } from '../../apps/render-worker/lib/browser.ts';
import { startServer } from '../../apps/render-worker/lib/server.ts';
const wav = readFileSync('out/free-coins-loop-001/mix.wav'); const n = (wav.length - 44) / 4; const L = new Float32Array(n), R = new Float32Array(n);
for (let i = 0; i < n; i++) { L[i] = wav.readInt16LE(44 + i * 4) / 32768; R[i] = wav.readInt16LE(46 + i * 4) / 32768; }
const { server, url } = await startServer(0); const b = await launchBrowser(); const p = await b.newPage(); await p.goto(url + '/apps/studio/blank.html');
for (const sh of [0, 0.2, 0.35]) for (const br of [160000, 192000, 256000]) {
  setShaping(sh); const e = encodeAacLc([L, R], br);
  const r = await aacRoundTrip(e.frames, e.asc, [L, R], 1024, p);
  console.log(`shaping ${sh} ${br / 1000}k -> SNR ${r.snrDb.join('/')} dB, bytes ${e.frames.reduce((a, f) => a + f.length, 0)}, maxBits ${e.stats.maxBits}`);
}
await b.close(); server.close();
