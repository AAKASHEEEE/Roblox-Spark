import { test } from 'node:test';
import assert from 'node:assert/strict';
import { muxMp4 } from '../packages/mp4/src/mux.ts';
import { inspectMp4 } from '../packages/mp4/src/inspect.ts';
import { mix, integratedLoudness } from '../packages/audio/src/mix.ts';
import { rng, hashSeed } from '../packages/engine/src/math.ts';
import { lib } from './helpers.ts';

test('mp4 mux -> inspect round trip (fast-start, CFR, audio edit list)', () => {
  const samples = Array.from({ length: 60 }, (_, i) => ({ data: new Uint8Array([0, 0, 0, 1, i]), duration: 1000, isKey: i % 30 === 0 }));
  const audio = Array.from({ length: 100 }, () => ({ data: new Uint8Array([1, 2, 3]), duration: 960 }));
  const mp4 = muxMp4({ video: { width: 1080, height: 1920, timescale: 30000, avcC: new Uint8Array([1, 100, 0, 40, 255]), samples }, audio: { sampleRate: 48000, channels: 2, preSkip: 312, inputSampleRate: 48000, samples: audio } });
  const i = inspectMp4(mp4);
  const v = i.tracks.find((t) => t.handler === 'vide')!, a = i.tracks.find((t) => t.handler === 'soun')!;
  assert.ok(i.fastStart);
  assert.equal(v.width, 1080); assert.equal(v.height, 1920); assert.equal(v.sampleCount, 60);
  assert.deepEqual([...new Set(v.sampleDurations)], [1000]); assert.deepEqual(v.keyframes, [1, 31]);
  assert.equal(a.codec, 'Opus'); assert.equal(a.editMediaTime, 312);
  assert.deepEqual(muxMp4({ video: { width: 1080, height: 1920, timescale: 30000, avcC: new Uint8Array([1]), samples } }), muxMp4({ video: { width: 1080, height: 1920, timescale: 30000, avcC: new Uint8Array([1]), samples } }));
});
test('audio mix is deterministic and normalised to target loudness', () => {
  const assets = Object.fromEntries(Object.values(lib.audio).map((a) => [a.id, a]));
  const input = { duration: 6, cues: [{ sfx: 'sfx_click', at: 1, gainDb: -4 }, { sfx: 'sfx_thud_big', at: 3, gainDb: 0 }], music: { id: 'mus_spark_bounce', gainDb: -20 }, loudnessLufs: -14, duckingDb: 6, loop: true };
  const a = mix(input, assets), b = mix(input, assets);
  assert.deepEqual(a.left, b.left);
  assert.ok(Math.abs(a.report.integratedLufs + 14) <= 1, String(a.report.integratedLufs));
  assert.ok(a.report.truePeakDbfsApprox <= -1);
  assert.ok(Math.abs(integratedLoudness(a.left, a.right) - a.report.integratedLufs) < 0.01);
  assert.deepEqual(a.report.missing, []);
});
test('seeded PRNG is stable across runs', () => {
  const r = rng(hashSeed('zapp') ^ 424242);
  assert.deepEqual(Array.from({ length: 3 }, r).map((x) => x.toFixed(8)), (() => { const q = rng(hashSeed('zapp') ^ 424242); return Array.from({ length: 3 }, q).map((x) => x.toFixed(8)); })());
});
