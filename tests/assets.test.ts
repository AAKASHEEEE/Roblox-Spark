import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadLibrary } from '../apps/render-worker/lib/library.ts';
import { ROOT } from './helpers.ts';

test('editing a locked character without a version bump is detected', () => {
  const f = join(ROOT, 'assets/characters/zapp@1.0.0.json');
  const orig = readFileSync(f, 'utf8');
  try {
    const m = JSON.parse(orig); m.body.torsoColor = '#ff0000';
    writeFileSync(f, JSON.stringify(m, null, 2));
    const lib = loadLibrary();
    assert.ok(lib.errors.some((e) => e.includes('characters/zapp@1.0.0') && e.includes('without a version bump')));
  } finally { writeFileSync(f, orig); }
  assert.deepEqual(loadLibrary().errors, []);
});
test('locked cast matches the brief', () => {
  const lib = loadLibrary();
  const z = lib.characters['zapp@1.0.0'], k = lib.characters['kira@1.0.0'];
  assert.deepEqual([...z.allowedExpressions].sort(), ['curious', 'determined', 'neutral', 'regret', 'shock']);
  assert.deepEqual([...k.allowedExpressions].sort(), ['laughing', 'skeptical', 'smug', 'surprised']);
  assert.equal(z.face.hasNose, false);
  assert.ok(z.parts.some((p) => p.id === 'wristband_r' && p.attach === 'forearm_r'));
  assert.equal(z.parts.filter((p) => p.id.startsWith('spike_')).length, 3);
  assert.ok(z.face.states.neutral.browL[0] > z.face.states.neutral.browR[0], 'neutral left brow higher');
});
test('every asset has license metadata from an allowed source', () => {
  const lib = loadLibrary();
  const all = [...Object.values(lib.characters), ...Object.values(lib.props), ...Object.values(lib.environments), ...Object.values(lib.audio)];
  assert.ok(all.length >= 27);
  for (const a of all) assert.equal(a.license.source, 'original-procedural', a.id);
});
