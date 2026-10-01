import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { directScript } from '../packages/director/src/pipeline.ts';
import { DIRECTOR_ALGORITHM_VERSION, DIRECTOR_EDIT_PLAN_POLICY, DirectorInputError, normalizeDirectorRequest, splitDirectorClauses } from '../packages/director/src/offline.ts';
import { LIBRARY, lookup } from '../packages/library/src/ids.ts';
import { ENVIRONMENT_CATALOG } from '../packages/environments/src/index.ts';
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
  assert.deepEqual(a.sheet.beats[0].cast.map((c) => c.characterId.split('@')[0]), ['zapp']);
  assert.deepEqual(a.sheet.beats[1].cast.map((c) => c.characterId.split('@')[0]), ['kira']);
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
  assert.ok(result.report.editPlan.coverage.entityFramingCoverage.required >= 3);
  assert.ok(result.report.editPlan.coverage.actionRealizationCoverage.required >= 4);
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

test('beat-local cast includes only named, pronoun-resolved, or interaction-required actors', async () => {
  const result = await directScript({
    script: [
      'Zapp waits in the classroom.',
      'Kira runs past the desk.',
      'She drops the phone while Zapp watches.',
      'The teacher laughs.',
    ],
    duration: 12,
    seed: 31,
  }, { provider: 'offline' });
  assert.deepEqual(result.sheet.beats.map((beat) => beat.cast.map((member) => member.characterId.split('@')[0])), [
    ['zapp'], ['kira'], ['kira', 'zapp'], ['teacher'],
  ]);
  assert.equal(result.sheet.beats[2].cast[0].actionId, 'put_down');
  assert.ok(result.sheet.beats[2].props.some((prop) => prop.propId.startsWith('phone@')), 'object pronoun retains only its local antecedent prop');
});

test('Director consumes environment metadata and never places actors on prop, waypoint, offscreen, or hazard marks', async () => {
  for (const script of ['Zapp and Kira wait in the classroom.', 'Zapp waits in the hallway.', 'Kira waits at the playground.']) {
    const result = await directScript({ script, duration: 4, seed: 19 }, { provider: 'offline' });
    const beat = result.sheet.beats[0];
    const [setId, version] = beat.setId.split('@');
    const profile = ENVIRONMENT_CATALOG.profiles.find((item) => item.id === setId && item.version === version)!;
    assert.ok(profile);
    for (const member of beat.cast) {
      const mark = profile.marks.find((item) => item.id === member.placement)!;
      assert.equal(mark.kind, 'actor');
      assert.equal(mark.hazard.kind, 'none');
      assert.ok(mark.occupancy > 0 && mark.postures.includes('stand'));
    }
  }
});

test('broad deterministic corpus diagnoses at least 90% of unsupported visible concepts', async () => {
  const expected = ['drone', 'microwave', 'skateboard', 'spaceship', 'robot', 'airplane', 'dragon', 'violin', 'warehouse', 'penguin'];
  const script = [
    'A drone hovers.',
    'Kira opens a microwave.',
    'Zapp rides a skateboard.',
    'A spaceship appears.',
    'The robot waves.',
    'An airplane arrives.',
    'A dragon dances.',
    'Kira finds a violin.',
    'Zapp waits inside a warehouse.',
    'A penguin jumps.',
  ];
  const first = await directScript({ script, duration: 30, seed: 41 }, { provider: 'offline' });
  const second = await directScript({ script, duration: 30, seed: 41 }, { provider: 'offline' });
  assert.deepEqual(first, second);
  const diagnosed = new Set(first.report.conceptDiagnostics.map((item) => item.term));
  const diagnosedCount = expected.filter((term) => diagnosed.has(term)).length;
  assert.ok(diagnosedCount / expected.length >= 0.9, `diagnosed ${diagnosedCount}/${expected.length}: ${[...diagnosed].join(', ')}`);
  for (const required of ['drone', 'microwave', 'skateboard', 'spaceship', 'robot', 'airplane', 'dragon']) assert.ok(diagnosed.has(required));
  assert.ok(first.report.conceptDiagnostics.every((item) => ['missing', 'approved_substitution', 'authorization_blocker'].includes(item.disposition)));
  assert.equal(first.report.editPlan.coverage.unresolvedConceptCoverage.pct, 1);
  assert.equal(first.report.editPlan.coverage.unresolvedConceptCoverage.diagnosed, first.report.conceptDiagnostics.length);
});

test('planned visible places record an approved substitution rather than disappearing', async () => {
  const result = await directScript({ script: 'Kira cooks in the kitchen.', duration: 4, seed: 2 }, { provider: 'offline' });
  assert.ok(result.report.conceptDiagnostics.some((item) => item.term === 'kitchen' && item.category === 'place'
    && item.disposition === 'approved_substitution' && item.substitute === 'classroom'));
});

test('coverage separates framing, action realization, prop state, and unresolved diagnosis without false claims', async () => {
  const result = await directScript({
    script: 'Kira grabs the phone, then Zapp jumps beside a drone.',
    duration: 7,
    seed: 13,
  }, { provider: 'offline' });
  const coverage = result.report.editPlan.coverage;
  assert.ok(coverage.entityFramingCoverage.required >= 2);
  assert.ok(coverage.entityFramingCoverage.realized >= 1);
  assert.ok(coverage.actionRealizationCoverage.required >= 2);
  assert.ok(coverage.actionRealizationCoverage.realized < coverage.actionRealizationCoverage.required, 'one emitted lead action cannot realize both narrated actions');
  assert.ok(coverage.propStateRealizationCoverage.required >= 1);
  assert.equal(coverage.propStateRealizationCoverage.realized, 0, 'an idle prop state cannot claim a grab transition');
  assert.equal(coverage.unresolvedConceptCoverage.unresolved, 1);
  const grabClause = result.report.editPlan.beats[0].clauses.find((clause) => clause.cues.actions.includes('grab'))!;
  assert.equal(grabClause.entityFramed, false, 'framing Kira without the phone cannot cover the grab clause');
  assert.equal(grabClause.propStateRealized, false);
});

test('Director duration boundary is 300 seconds', async () => {
  const accepted = await directScript({ script: 'Zapp waits.', duration: 300, seed: 0 }, { provider: 'offline' });
  assert.equal(accepted.sheet.beats[0].end, 300);
  await assert.rejects(directScript({ script: 'Zapp waits.', duration: 300.000001, seed: 0 }, { provider: 'offline' }),
    (error: unknown) => error instanceof DirectorInputError && /at most 300 seconds/.test(error.message));
});

test('main recipe selection rejects prop-only framing without a local prop', async () => {
  const noProp = await directScript({ script: 'Kira stands for a close shot.', duration: 4, seed: 6 }, { provider: 'offline' });
  assert.ok(!['prop_ecu', 'insert_prop', 'top_down_insert'].includes(noProp.sheet.beats[0].camera.recipeId));
  assert.equal(noProp.sheet.beats[0].camera.subject, 'kira');
  const requested = noProp.report.substitutions.find((item) => item.kind === 'cameraRecipes');
  assert.equal(requested?.reason, 'requested recipe is incompatible with local subject, cast, motion, set dimensions, or required prop');
});

test('per-beat recognition is not corrupted by global roster truncation', async () => {
  const names = ['Crowd Kid', 'Dad', 'Friend Boy', 'Friend Girl', 'Kira', 'Mom', 'Noob', 'Pro', 'Teacher', 'Zapp'];
  const result = await directScript({ script: names.map((name) => `${name} waits.`), duration: 30, seed: 5 }, { provider: 'offline' });
  assert.deepEqual(result.sheet.beats.map((beat) => beat.cast[0].characterId.split('@')[0]),
    ['crowd_kid', 'dad', 'friend_boy', 'friend_girl', 'kira', 'mom', 'noob', 'pro', 'teacher', 'zapp']);
});

test('local named antecedents beat later possessives and discourse tracks the last named person', async () => {
  const local = await directScript({ script: ['Zapp waits.', 'Kira grabs her phone.'], duration: 8, seed: 4 }, { provider: 'offline' });
  assert.deepEqual(local.sheet.beats[1].cast.map((member) => member.characterId.split('@')[0]), ['kira']);
  const discourse = await directScript({ script: ['Zapp watches Kira.', 'She runs.'], duration: 8, seed: 4 }, { provider: 'offline' });
  assert.equal(discourse.sheet.beats[1].cast[0].characterId.split('@')[0], 'kira');
});

test('actor allocation honors set capacity, aliases, and exclusions', async () => {
  const result = await directScript({ script: 'Zapp, Kira, and the teacher wait in the classroom.', duration: 5, seed: 26 }, { provider: 'offline' });
  const beat = result.sheet.beats[0];
  const profile = ENVIRONMENT_CATALOG.profiles.find((item) => `${item.id}@${item.version}` === beat.setId)!;
  assert.ok(beat.cast.length <= profile.cast.max);
  const selected = beat.cast.map((member) => profile.marks.find((mark) => mark.id === member.placement)!);
  const physical = selected.map((mark) => mark.aliasOf ?? mark.id);
  assert.equal(new Set(physical).size, physical.length);
  for (const mark of selected) for (const other of selected) if (mark !== other) {
    assert.equal(mark.exclusiveWith.includes(other.id) || other.exclusiveWith.includes(mark.id), false);
  }
});

test('concept diagnosis avoids known adjectives and catches bare objects and destinations', async () => {
  const result = await directScript({ script: ['A happy Kira jumps.', 'Kira plays violin.', 'Kira enters warehouse.', 'A penguin jumps.'], duration: 12, seed: 9 }, { provider: 'offline' });
  const diagnostics = new Map(result.report.conceptDiagnostics.map((item) => [item.term, item]));
  assert.equal(diagnostics.has('happy'), false);
  assert.equal(diagnostics.get('violin')?.category, 'prop');
  assert.equal(diagnostics.get('warehouse')?.category, 'place');
  assert.equal(diagnostics.get('penguin')?.category, 'entity');
  assert.equal(result.report.editPlan.coverage.unresolvedConceptCoverage.required, 3);
  assert.equal(result.report.editPlan.coverage.unresolvedConceptCoverage.diagnosed, 3);
});

test('entity framing requires every named clause entity, not any one subject', async () => {
  const result = await directScript({ script: 'Zapp watches Kira beside the teacher.', duration: 5, seed: 3 }, { provider: 'offline' });
  const clause = result.report.editPlan.beats[0].clauses[0];
  assert.deepEqual(new Set(clause.cues.people), new Set(['zapp', 'kira', 'teacher']));
  assert.equal(clause.entityFramed, false);
  assert.equal(result.report.editPlan.coverage.entityFramingCoverage.realized, 0);
});