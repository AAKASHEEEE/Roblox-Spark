// E2E: generated fixture -> automated render (diagnostic 270x480) with AAC-LC audio, production-profile probe,
// independent AAC decode, quality report and render manifest declaring the motion profile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderEpisode } from '../../apps/render-worker/render.ts';
import { ROOT } from '../helpers.ts';

test('automated render: H.264 + AAC-LC, production profile PASS, gates, manifest', { timeout: 600000 }, async () => {
  const out = 'out/e2e-render-aac';
  const r = await renderEpisode({ episode: 'tests/fixtures/episodes/gen-example-free-coins.json', out, scale: 0.25 });
  assert.ok(r.mp4, 'no MP4');
  const probe = JSON.parse(readFileSync(join(ROOT, out, 'probe.json'), 'utf8'));
  assert.equal(probe.production.ok, true, JSON.stringify(probe.production.errors));
  const a = probe.probe.streams.find((s: any) => s.codec_type === 'audio');
  assert.equal(a.codec_name, 'aac'); assert.equal(a.profile, 'LC'); assert.equal(Number(a.sample_rate), 48000);
  const q = r.report!;
  for (const id of ['P01', 'P02', 'G01', 'G04', 'G05', 'G21']) assert.equal(q.gates.find((g: any) => g.id === id)?.pass, true, id);
  const m = JSON.parse(readFileSync(join(ROOT, out, 'render-manifest.json'), 'utf8'));
  assert.deepEqual([m.rendererVersion, m.motionProfile, m.audioCodec], ['1.0.0', 'corrected-head-v2', 'aac']);
});
