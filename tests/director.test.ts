import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { directScript } from '../packages/director/src/pipeline.ts';
import { DIRECTOR_ALGORITHM_VERSION, DirectorInputError, normalizeDirectorRequest } from '../packages/director/src/offline.ts';
import { validateBeatSheet } from '../packages/director/src/beat-sheet.ts';
import { NodeDirectorCache, type DirectorCacheDescriptor } from '../packages/director/node/cache.ts';

const REQUEST = {
  script: 'At school, Zapp grabs a phone.\nKira runs past the classroom desk.',
  duration: 8,
  seed: 7,
};

test('offline Director is deterministic, available-only, timed, and preserves every caption word', async () => {
  const a = await directScript(REQUEST, { provider: 'offline' });
  const b = await directScript(REQUEST, { provider: 'offline' });
  assert.deepEqual(a, b);
  assert.equal(validateBeatSheet(a.sheet, { requireAvailable: true }).ok, true);
  assert.equal(a.sheet.beats.length, 2);
  assert.equal(a.sheet.beats[0].start, 0);
  assert.equal(a.sheet.beats[1].end, 8);
  assert.equal(a.sheet.beats[0].end, a.sheet.beats[1].start);
  assert.match(a.sheet.beats[0].setId, /^classroom@/);
  assert.ok(a.sheet.beats[0].cast.some((c) => c.characterId.startsWith('zapp@')));
  assert.ok(a.sheet.beats[0].cast.some((c) => c.characterId.startsWith('kira@')));
  assert.ok(a.sheet.beats[0].props.some((p) => p.propId.startsWith('phone@')));
  assert.ok(a.sheet.beats[1].props.some((p) => p.propId.startsWith('student_desk@')));
  assert.equal(a.sheet.beats[1].cast[0].actionId, 'run');
  for (const beat of a.sheet.beats) {
    assert.equal(beat.captions.map((c) => c.text).join(' '), beat.text);
    assert.equal(beat.captions[0].start, beat.start);
    assert.equal(beat.captions.at(-1)!.end, beat.end);
    for (const caption of beat.captions) {
      assert.ok(caption.text.split(' ').length >= 1 && caption.text.split(' ').length <= 4);
      assert.ok(caption.text.length <= 48);
    }
  }
  assert.equal(a.report.provider.used, 'offline');
  assert.equal(a.report.missingAssets.length, 0);
});

test('planned tag matches are explicitly reported and replaced with an available asset', async () => {
  const result = await directScript({ script: 'Zapp cooks dinner in the kitchen.', duration: 4, seed: 3 }, { provider: 'offline' });
  assert.equal(result.report.validation.ok, true);
  assert.match(result.sheet.beats[0].setId, /^classroom@/);
  assert.ok(result.report.missingAssets.some((x) => x.kind === 'sets' && x.requested === 'home_kitchen'));
  assert.ok(result.report.substitutions.some((x) => x.kind === 'sets' && x.requested === 'home_kitchen' && x.used === 'classroom'));
});

test('caption limits fail explicitly instead of dropping script words', async () => {
  const tooManyWords = Array.from({ length: 49 }, (_, i) => `w${i}`).join(' ');
  await assert.rejects(directScript({ script: tooManyWords, duration: 5, seed: 0 }, { provider: 'offline' }), (error: unknown) => error instanceof DirectorInputError && /BeatSheet limit is 12/.test(error.message));
  await assert.rejects(directScript({ script: 'x'.repeat(49), duration: 5, seed: 0 }, { provider: 'offline' }), /48-character caption limit/);
});

test('Node Director cache is content-addressed, verified, and stores no descriptor or credential', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spark-director-cache-'));
  try {
    const result = await directScript(REQUEST, { provider: 'offline' });
    const descriptor: DirectorCacheDescriptor = {
      algorithmVersion: DIRECTOR_ALGORITHM_VERSION,
      request: normalizeDirectorRequest(REQUEST),
      provider: 'offline', models: [], timeoutMs: null, openRouterConfigured: false,
    };
    const cache = new NodeDirectorCache(root);
    const digest = cache.put(descriptor, result);
    assert.match(digest, /^[a-f0-9]{64}$/);
    assert.deepEqual(cache.get(descriptor), { digest, value: result });
    const bucket = readdirSync(root)[0];
    const text = readFileSync(join(root, bucket, readdirSync(join(root, bucket))[0]), 'utf8');
    assert.doesNotMatch(text, /OPENROUTER_API_KEY|super-secret/);
    assert.doesNotMatch(text, /"request"\s*:/); // descriptor is addressed by hash, not persisted
  } finally { rmSync(root, { recursive: true, force: true }); }
});
