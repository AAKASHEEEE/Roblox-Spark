import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLibrary } from '../apps/render-worker/lib/library.ts';
import { ROOT } from './helpers.ts';

test('editing a locked character without a version bump is detected', () => {
  // edit a private COPY of the library: editing the repo file raced with other test files loading it in parallel
  const root = mkdtempSync(join(tmpdir(), 'bs-assets-'));
  cpSync(join(ROOT, 'assets'), join(root, 'assets'), { recursive: true });
  const f = join(root, 'assets/characters/zapp@1.0.0.json');
  const m = JSON.parse(readFileSync(f, 'utf8')); m.body.torsoColor = '#ff0000';
  writeFileSync(f, JSON.stringify(m, null, 2));
  const lib = loadLibrary({ root });
  assert.ok(lib.errors.some((e) => e.includes('characters/zapp@1.0.0') && e.includes('without a version bump')));
  rmSync(root, { recursive: true, force: true });
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

test('trusted library consumes authenticated asset-lock bytes instead of reopening the path', () => {
  const root = mkdtempSync(join(tmpdir(), 'bs-assets-lock-'));
  cpSync(join(ROOT, 'assets'), join(root, 'assets'), { recursive: true });
  const lockPath = join(root, 'assets/asset-lock.json');
  const authenticated = new Uint8Array(readFileSync(lockPath));
  writeFileSync(lockPath, '{"assets":{}}\n');
  const trusted = loadLibrary({ root, lockBytes: authenticated });
  const reopened = loadLibrary({ root });
  assert.deepEqual(trusted.errors, []);
  assert.ok(reopened.errors.some((error) => error.startsWith('LOCK:')));
  rmSync(root, { recursive: true, force: true });
});