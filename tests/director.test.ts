import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { directScript } from '../packages/director/src/pipeline.ts';
import { DIRECTOR_ALGORITHM_VERSION, DIRECTOR_EDIT_PLAN_POLICY, DirectorInputError, normalizeDirectorRequest, splitDirectorClauses } from '../packages/director/src/offline.ts';
import { LIBRARY, lookup } from '../packages/library/src/ids.ts';
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

test('clause splitter uses punctuation, conjunctions, and action changes without dropping words', () => {
  const text = 'Zapp runs, then Kira jumps and she falls.';
  const clauses = splitDirectorClauses(text);
  assert.equal(clauses.map((clause) => clause.text).join(' '), text);
  assert.ok(clauses.some((clause) => clause.boundary.includes('punctuation')));
  assert.ok(clauses.some((clause) => clause.boundary.includes('conjunction')));

  const actionChanges = splitDirectorClauses('Zapp runs jumps falls.');
  assert.equal(actionChanges.map((clause) => clause.text).join(' '), 'Zapp runs jumps falls.');
  assert.equal(actionChanges.filter((clause) => clause.boundary.includes('action_change')).length, 2);

  const actorChanges = splitDirectorClauses('Zapp runs Kira jumps phone drops.');
  assert.deepEqual(actorChanges.map((clause) => clause.text), ['Zapp runs', 'Kira jumps', 'phone drops.']);
});

test('clause edit plan is deterministic, absolute, floor-compliant, available-only, and framing-diverse', async () => {
  const request = {
    script: 'Zapp waits quietly.\nKira runs across the classroom, then she grabs the phone, but it drops; Zapp jumps and Kira falls.',
    duration: 12,
    seed: 17,
  };
  const first = await directScript(request, { provider: 'offline' });
  const second = await directScript(request, { provider: 'offline' });
  assert.deepEqual(first, second);
  assert.deepEqual(first.report.editPlan.policy, DIRECTOR_EDIT_PLAN_POLICY);
  assert.equal(first.report.editPlan.coverage.version, DIRECTOR_EDIT_PLAN_POLICY.coverageVersion);

  const beat = first.sheet.beats[1];
  const subShots = beat.camera.subShots ?? [];
  assert.ok(beat.start > 0);
  assert.ok(subShots.length > 0 && subShots.length <= DIRECTOR_EDIT_PLAN_POLICY.maximumSubShots);
  assert.ok(subShots.every((shot) => shot.from > beat.start && shot.from < beat.end), 'all starts are absolute and interior');
  const boundaries = [beat.start, ...subShots.map((shot) => shot.from), beat.end];
  for (let i = 1; i < boundaries.length; i++) assert.ok(boundaries[i] - boundaries[i - 1] >= DIRECTOR_EDIT_PLAN_POLICY.minimumSegmentSeconds - 1e-9);
  const reportedSegments = first.report.editPlan.beats[1].segments;
  assert.deepEqual(reportedSegments.map((segment) => [segment.start, segment.end]), boundaries.slice(0, -1).map((start, index) => [start, boundaries[index + 1]]));
  assert.deepEqual(reportedSegments.map((segment) => segment.recipeId), [beat.camera.recipeId, ...subShots.map((shot) => shot.recipeId)]);
  const average = (beat.end - beat.start) / (subShots.length + 1);
  assert.ok(average >= DIRECTOR_EDIT_PLAN_POLICY.targetAverageSeconds.min && average <= DIRECTOR_EDIT_PLAN_POLICY.targetAverageSeconds.max);

  const entities = new Set([
    ...beat.cast.map((member) => member.characterId.split('@')[0]),
    ...beat.props.map((prop) => prop.instanceId ?? prop.propId.split('@')[0]),
  ]);
  const cameras = [beat.camera, ...subShots];
  for (const camera of cameras) {
    assert.equal(lookup('cameraRecipes', camera.recipeId)?.status, 'available');
    assert.ok(entities.has(camera.subject));
    if (camera.secondary) assert.ok(entities.has(camera.secondary) && camera.secondary !== camera.subject);
  }
  const family = (recipe: string) => ['prop_ecu', 'hook_closeup', 'insert_prop', 'reaction_punch_in'].includes(recipe) ? 'close'
    : ['establishing_wide', 'wide_environment', 'two_shot', 'top_down', 'top_down_insert'].includes(recipe) ? 'wide'
      : ['chase_cam', 'whip_pan', 'slow_push_in', 'final_loop'].includes(recipe) ? 'moving' : 'medium';
  for (let i = 1; i < cameras.length; i++) {
    assert.notEqual(cameras[i].recipeId, cameras[i - 1].recipeId);
    if (cameras[i].subject === cameras[i - 1].subject) assert.notEqual(family(cameras[i].recipeId), family(cameras[i - 1].recipeId));
  }
  assert.equal(validateBeatSheet(first.sheet, { requireAvailable: true }).ok, true);
});

test('short phrases and single visual clauses retain the original one-camera shape', async () => {
  const short = await directScript({ script: 'Zapp runs, then jumps.', duration: 2, seed: 5 }, { provider: 'offline' });
  assert.equal(short.sheet.beats[0].camera.subShots, undefined);
  assert.equal(short.report.editPlan.beats[0].actualSegments, 1);

  const noUsefulSecondShot = await directScript({ script: 'Zapp waits quietly', duration: 8, seed: 5 }, { provider: 'offline' });
  assert.equal(noUsefulSecondShot.sheet.beats[0].camera.subShots, undefined);
  assert.equal(noUsefulSecondShot.report.editPlan.beats[0].candidateCuts, 0);
});

test('literal people, objects, actions, and pronouns drive only valid local subjects', async () => {
  const result = await directScript({
    script: 'Kira waits, then she runs, but the phone falls, and Zapp jumps.',
    duration: 8,
    seed: 23,
  }, { provider: 'offline' });
  const plan = result.report.editPlan.beats[0];
  assert.ok(plan.clauses.some((clause) => clause.subjectBasis === 'pronoun' && clause.cues.pronouns.includes('she') && clause.cues.actions.includes('run')));
  assert.ok(plan.clauses.some((clause) => clause.subjectBasis === 'object' && clause.cues.objects.includes('phone')));
  assert.ok(plan.clauses.some((clause) => clause.cues.people.includes('zapp') && clause.cues.actions.includes('jump')));
  assert.ok(plan.clauses.every((clause) => clause.text.length > 0));
  assert.ok(result.report.editPlan.coverage.visualClauses >= 4);
  assert.equal(validateBeatSheet(result.sheet, { requireAvailable: true }).ok, true);

  const mixed = await directScript({ script: 'Kira grabs the phone, then she drops it.', duration: 6, seed: 23 }, { provider: 'offline' });
  const mixedClause = mixed.report.editPlan.beats[0].clauses.find((clause) => clause.cues.pronouns.includes('she') && clause.cues.pronouns.includes('it'))!;
  assert.equal(mixedClause.subjectBasis, 'pronoun');
  assert.equal(mixedClause.shot.subject, 'kira', 'the first pronoun controls a mixed-pronoun clause');
});

test('a generated multi-shot BeatSheet validates and stages without fixture changes', async () => {
  const result = await directScript({
    script: 'Zapp waits.\nKira runs, then she grabs the phone, but it drops; Zapp jumps.',
    duration: 10,
    seed: 9,
  }, { provider: 'offline' });
  assert.equal(validateBeatSheet(result.sheet, { requireAvailable: true }).ok, true);
  assert.ok(result.sheet.beats.some((beat) => (beat.camera.subShots?.length ?? 0) > 0));

  const [{ loadLibrary }, { registerRuntimeLibrary }, { stageBeatSheet }] = await Promise.all([
    import('../apps/render-worker/lib/library.ts'),
    import('../packages/vignette/src/runtime-library.ts'),
    import('../packages/vignette/src/stage.ts'),
  ]);
  const library = loadLibrary();
  assert.deepEqual(library.errors, []);
  registerRuntimeLibrary(library);
  const staged = stageBeatSheet(result.sheet, library);
  assert.equal(staged.beats.length, result.sheet.beats.length);
  assert.deepEqual(staged.beats.map((beat) => beat.camera.subShots ?? []), result.sheet.beats.map((beat) => beat.camera.subShots ?? []));
  assert.deepEqual(staged.issues.filter((issue) => issue.severity === 'error'), []);
  assert.equal(LIBRARY.cameraRecipes.every((recipe) => recipe.status === 'available'), true);
});
