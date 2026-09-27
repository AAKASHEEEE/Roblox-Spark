import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { muxMp4 } from '../packages/mp4/src/mux.ts';
import { inspectMp4 } from '../packages/mp4/src/inspect.ts';
import { probeBuiltin, checkProductionProfile } from '../packages/mp4/src/probe.ts';
import { fromFfprobeJson, ffprobeAvailable, probeFile } from '../apps/render-worker/lib/probe-node.ts';
import { encodeAacLc } from '../packages/audio/src/aac/encoder.ts';
import { ROOT } from './helpers.ts';

// real avcC (SPS/PPS) produced by the pinned Chromium H.264 encoder, taken from the committed PoC file
const poc = new Uint8Array(readFileSync(join(ROOT, 'docs/poc/free-coins-loop-001.mp4')));
function realAvcC(): Uint8Array {
  const s = Buffer.from(poc).indexOf('avcC'); const size = Buffer.from(poc).readUInt32BE(s - 4);
  return poc.slice(s + 4, s - 4 + size);
}
function aacMp4(seconds = 17): Uint8Array {
  const n = seconds * 48000; const z = new Float32Array(n); for (let i = 0; i < n; i++) z[i] = 0.1 * Math.sin(i * 0.05);
  const a = encodeAacLc([z, z], 160000);
  const samples = Array.from({ length: seconds * 30 }, (_, i) => ({ data: new Uint8Array([0, 0, 0, 1, 0x65]), duration: 1000, isKey: i % 60 === 0 }));
  return muxMp4({ video: { width: 1080, height: 1920, timescale: 30000, avcC: realAvcC(), samples }, audio: { codec: 'aac', sampleRate: 48000, channels: 2, asc: a.asc, priming: a.priming, inputSamples: n, avgBitrate: 160000, samples: a.frames.map((d) => ({ data: d, duration: 1024 })) } });
}

test('production profile PASSES for H.264 yuv420p 1080x1920 CFR30 + AAC-LC 48k stereo fast-start', () => {
  const p = probeBuiltin(aacMp4());
  const c = checkProductionProfile(p);
  assert.ok(c.ok, c.errors.join('; '));
  const a = p.streams.find((s) => s.codec_type === 'audio')!, v = p.streams.find((s) => s.codec_type === 'video')!;
  assert.equal(a.codec_name, 'aac'); assert.equal(a.profile, 'LC'); assert.equal(v.pix_fmt, 'yuv420p'); assert.equal(v.r_frame_rate, '30/1');
  assert.equal(inspectMp4(aacMp4()).tracks[1].editMediaTime, 1024, 'priming signalled in edit list');
});
test('production profile FAILS when the MP4 carries Opus instead of AAC', () => {
  const c = checkProductionProfile(probeBuiltin(poc));
  assert.ok(!c.ok);
  assert.ok(c.errors.some((e) => e.startsWith('audio codec: got opus')), c.errors.join('; '));
});
test('production profile FAILS on wrong resolution and missing audio', () => {
  const p = probeBuiltin(aacMp4());
  const bad = { ...p, streams: p.streams.map((s) => (s.codec_type === 'video' ? { ...s, width: 720, height: 1280 } : s)) };
  assert.ok(checkProductionProfile(bad).errors.some((e) => e.startsWith('resolution')));
  assert.ok(checkProductionProfile({ ...p, streams: p.streams.filter((s) => s.codec_type === 'video') }).errors.some((e) => e.startsWith('exactly one audio stream')));
});
test('ffprobe JSON is mapped and checked with the same rules (canned ffprobe output)', () => {
  const j = { format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '17.000000', size: '1', tags: { major_brand: 'isom' } }, streams: [
    { index: 0, codec_type: 'video', codec_name: 'h264', profile: 'Constrained Baseline', width: 1080, height: 1920, pix_fmt: 'yuv420p', r_frame_rate: '30/1', avg_frame_rate: '30/1', duration: '17.000000', nb_frames: '510' },
    { index: 1, codec_type: 'audio', codec_name: 'opus', sample_rate: '48000', channels: 2, duration: '17.000000' }] };
  const c = checkProductionProfile(fromFfprobeJson(j, aacMp4()));
  assert.ok(!c.ok && c.errors.some((e) => e.includes('opus')));
  j.streams[1] = { index: 1, codec_type: 'audio', codec_name: 'aac', profile: 'LC', sample_rate: '48000', channels: 2, duration: '17.000000' } as any;
  assert.ok(checkProductionProfile(fromFfprobeJson(j, aacMp4())).ok);
});
test('real ffprobe (runs only where ffprobe is installed, e.g. the Docker image)', { skip: !ffprobeAvailable() && 'ffprobe not installed in this environment' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'probe-')); const f = join(dir, 'a.mp4'); writeFileSync(f, aacMp4());
  const p = probeFile(f); assert.equal(p.tool, 'ffprobe');
  assert.equal(p.streams.find((s) => s.codec_type === 'audio')!.codec_name, 'aac');
});
