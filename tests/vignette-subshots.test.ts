import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadLibrary } from '../apps/render-worker/lib/library.ts';
import { MIN_SUB_SHOT_DURATION, validateBeatSheet, type BeatSheet } from '../packages/director/src/beat-sheet.ts';
import { directScript } from '../packages/director/src/pipeline.ts';
import { splitDirectorClauses } from '../packages/director/src/offline.ts';
import { LIBRARY, type Library } from '../packages/library/src/ids.ts';
import { CAMERA_RECIPES } from '../packages/vignette/src/camera-recipes.ts';
import { vfxEventsFromBeats } from '../packages/engine/src/vfx/index.ts';
import {
  auditFinalCameraSafety,
  beatSamples,
  evaluateFinalCameraAt,
  sampleBeat,
  solveBeatCamera,
  type CameraComposition,
  type ShotChoice,
} from '../packages/vignette/src/camera.ts';
import { coverageCheck } from '../packages/vignette/src/coverage.ts';
import { ensureHeadlessCanvas } from '../packages/vignette/src/headless.ts';
import {
  runVignette,
  summarizeCompositionCameras,
  VignetteValidationError,
} from '../packages/vignette/src/pipeline.ts';
import type { StagedBeat } from '../packages/vignette/src/stage.ts';
import { ROOT } from './helpers.ts';

ensureHeadlessCanvas();
const lib = loadLibrary();
const fixturePath = join(ROOT, 'packages/director/fixtures/free-coins-classroom.beats.json');
const fixture = (): BeatSheet => JSON.parse(readFileSync(fixturePath, 'utf8')) as BeatSheet;
const canonical = runVignette(fixture(), lib);

const issuesFor = (sheet: BeatSheet) => validateBeatSheet(sheet).issues.map((i) => `${i.path} ${i.message}`);

test('valid sub-shot cuts produce ordered, bounded, minimum-duration compositions', () => {
  const sheet = fixture();
  const validation = validateBeatSheet(sheet);
  assert.equal(validation.ok, true, JSON.stringify(validation.issues));
  assert.equal(canonical.compositions.length, 41);
  assert.equal(canonical.report.compositions, canonical.compositions.length);
  for (const beat of sheet.beats) {
    const comps = canonical.compositions.filter((c) => c.beat === beat.phraseId);
    assert.equal(comps.length, 1 + (beat.camera.subShots?.length ?? 0));
    assert.equal(comps[0].start, beat.start);
    assert.equal(comps.at(-1)?.end, beat.end);
    for (let i = 0; i < comps.length; i++) {
      assert.ok(comps[i].end > comps[i].start);
      if (beat.camera.subShots?.length) assert.ok(comps[i].end - comps[i].start >= MIN_SUB_SHOT_DURATION - 1e-6);
      if (i) assert.equal(comps[i - 1].end, comps[i].start);
    }
  }
  assert.ok(canonical.compositions.every((c) => c.shot.recipeKnown));
  assert.equal(canonical.report.summary.camerasAccepted, 38);
  assert.equal(canonical.report.summary.camerasFallback, 3);
  assert.equal(canonical.report.summary.camerasBlocked, 0);
  assert.equal(canonical.report.summary.camerasAccepted + canonical.report.summary.camerasFallback, canonical.compositions.length);
});

test('sub-shot validation rejects ordering, bounds, and every short leading/trailing window', () => {
  const descending = fixture();
  descending.beats[0].camera.subShots![1].from = descending.beats[0].camera.subShots![0].from;
  assert.ok(issuesFor(descending).some((x) => x.includes('after the previous cut')));

  const outside = fixture();
  outside.beats[0].camera.subShots![0].from = outside.beats[0].start;
  assert.ok(issuesFor(outside).some((x) => x.includes('strictly inside the beat')));

  const shortLeading = fixture();
  shortLeading.beats[0].camera.subShots![0].from = shortLeading.beats[0].start + MIN_SUB_SHOT_DURATION / 2;
  assert.ok(issuesFor(shortLeading).some((x) => x.includes(`minimum is ${MIN_SUB_SHOT_DURATION.toFixed(3)} s`)));

  const shortTrailing = fixture();
  const b = shortTrailing.beats[0];
  b.camera.subShots!.at(-1)!.from = b.end - MIN_SUB_SHOT_DURATION / 2;
  assert.ok(issuesFor(shortTrailing).some((x) => x.includes(`minimum is ${MIN_SUB_SHOT_DURATION.toFixed(3)} s`)));
});

test('camera subjects and secondaries must overlap their authored temporal window', () => {
  const beforeEnter = fixture();
  // Reintroduce an unsafe teacher-primary window and end it before the canonical 60.6 entrance.
  beforeEnter.beats[12].camera.subject = 'teacher';
  beforeEnter.beats[12].camera.subShots![0].from = 60.4;
  assert.ok(issuesFor(beforeEnter).some((x) => x.includes('$.beats[12].camera.subject') && x.includes('not present during camera window')));

  const postExit = fixture();
  // Teacher exits p01 at 3.9; this final composition begins after the exit.
  postExit.beats[0].camera.subShots![1] = { from: 4.0, recipeId: 'medium_single', subject: 'teacher', secondary: 'kira' };
  assert.ok(issuesFor(postExit).some((x) => x.includes('$.beats[0].camera.subShots[1].subject') && x.includes('not present during camera window')));

  const absentSecondary = fixture();
  absentSecondary.beats[0].camera.subShots![1] = { from: 4.0, recipeId: 'two_shot', subject: 'zapp', secondary: 'teacher' };
  assert.ok(issuesFor(absentSecondary).some((x) => x.includes('$.beats[0].camera.subShots[1].secondary') && x.includes('not present during camera window')));
});

test('pipeline rejects semantic, unknown, planned, and runtime-unresolved recipes before staging', () => {
  const semantic = fixture();
  semantic.beats[0].camera.subShots![0].subject = 'missing_actor';
  assert.throws(() => runVignette(semantic, lib), (e: unknown) => e instanceof VignetteValidationError && /rejected before staging/.test(e.message));

  const unknown = fixture();
  unknown.beats[0].camera.subShots![0].recipeId = 'unknown_recipe';
  assert.throws(() => runVignette(unknown, lib), (e: unknown) => e instanceof VignetteValidationError && /unknown cameraRecipes id/.test(e.message));

  const plannedLibrary = structuredClone(LIBRARY) as Library;
  plannedLibrary.cameraRecipes.find((x) => x.id === 'medium_single')!.status = 'planned';
  assert.throws(() => runVignette(fixture(), lib, { library: plannedLibrary }), (e: unknown) => e instanceof VignetteValidationError && /planned, not available/.test(e.message));

  const implementation = CAMERA_RECIPES.medium_single;
  try {
    delete CAMERA_RECIPES.medium_single;
    assert.throws(() => runVignette(fixture(), lib), (e: unknown) => e instanceof VignetteValidationError && /no available runtime implementation/.test(e.message));
  } finally {
    CAMERA_RECIPES.medium_single = implementation;
  }
});

test('camera solving fails closed for empty samples and absent required targets', () => {
  const source = canonical.stage.beats[0];
  const noSamples = solveBeatCamera({ scene: canonical.scene, beat: source, samples: [], waistUp: false });
  assert.equal(noSamples.shot.accepted, false);
  assert.equal(noSamples.shot.source, 'blocked_best_effort');
  assert.deepEqual(noSamples.shot.samples[0].reasons, ['CAMERA_SAMPLES_EMPTY']);

  const unresolvedBeat: StagedBeat = { ...source, camera: { recipeId: 'unknown_recipe', subject: source.camera.subject } };
  const unresolved = solveBeatCamera({ scene: canonical.scene, beat: unresolvedBeat, samples: [], waistUp: false });
  assert.equal(unresolved.shot.recipeKnown, false);
  assert.equal(unresolved.shot.source, 'blocked_best_effort');
  assert.match(unresolved.shot.samples[0].reasons[0], /^CAMERA_RECIPE_UNRESOLVED:/);

  const postExit: StagedBeat = {
    ...source,
    start: 4.0,
    end: 4.2,
    camera: { recipeId: 'medium_single', subject: 'teacher' },
    keyTimes: [],
  };
  const absent = solveBeatCamera({ scene: canonical.scene, beat: postExit, samples: sampleBeat(canonical.scene, postExit, beatSamples(postExit)), waistUp: false });
  assert.equal(absent.shot.accepted, false);
  assert.match(absent.shot.samples[0].reasons[0], /^CAMERA_SUBJECT_ABSENT:teacher$/);

  const tiny: StagedBeat = { ...source, start: 1, end: 1.02, keyTimes: [] };
  const times = beatSamples(tiny);
  assert.ok(times.length > 0);
  assert.ok(times.every((t) => t >= tiny.start && t <= tiny.end));
});

test('composition lookup is half-open at cuts and rejects gaps/out-of-range times', () => {
  const first = canonical.compositions[0];
  const second = canonical.compositions[1];
  assert.equal(canonical.compositionAt(first.start), first);
  assert.equal(canonical.compositionAt(first.end), second, 'new composition owns the exact cut');
  assert.equal(canonical.compositionAt(first.end - 1e-9), first);
  assert.equal(canonical.compositionAt(4.4), undefined, 'inter-beat gap has no active composition');
  assert.equal(canonical.compositionAt(-1), undefined);
  assert.equal(canonical.compositionAt(canonical.compositions.at(-1)!.end), canonical.compositions.at(-1));
  assert.equal(canonical.compositionAt(canonical.compositions.at(-1)!.end + 1e-6), undefined);
});

test('render ownership holds one deterministic camera through pads, gaps, and the final output frame', () => {
  const first = canonical.compositions[0];
  const p01Final = canonical.compositions.filter((c) => c.beat === 'p01').at(-1)!;
  const p02First = canonical.compositions.find((c) => c.beat === 'p02' && c.index === 0)!;
  const final = canonical.compositions.at(-1)!;

  assert.deepEqual(canonical.renderCompositionAt(0), { composition: first, kind: 'leading-hold' });
  assert.deepEqual(canonical.renderCompositionAt(4.4), { composition: p01Final, kind: 'gap-hold' });
  assert.deepEqual(canonical.renderCompositionAt(p02First.start), { composition: p02First, kind: 'authored' });
  assert.deepEqual(canonical.renderCompositionAt(2074 / 30), { composition: final, kind: 'tail-hold' });
  assert.equal(canonical.renderCompositionAt(-1), undefined);
  assert.equal(canonical.renderCompositionAt(Number.NaN), undefined);
});

test('canonical no-render audit evaluates exactly all 2,075 post-effect output frames and fails closed', () => {
  const sheet = fixture();
  const dense = auditFinalCameraSafety(canonical.scene, canonical.compositions, {
    fps: 30,
    frameCount: 2075,
    supplementalVfx: vfxEventsFromBeats(sheet.beats),
  });
  assert.equal(dense.frames, 2075);
  assert.equal(dense.samples.length, 2075);
  assert.equal(new Set(dense.samples.map((sample) => sample.t)).size, 2075);
  assert.deepEqual(
    Object.fromEntries(['authored', 'leading-hold', 'gap-hold', 'tail-hold', 'unowned'].map((kind) =>
      [kind, dense.samples.filter((sample) => sample.ownership === kind).length])),
    { authored: 1937, 'leading-hold': 2, 'gap-hold': 134, 'tail-hold': 2, unowned: 0 },
  );
  assert.equal(dense.samples[2074].t, 2074 / 30);
  assert.equal(dense.samples[2074].beat, 'p14');
  assert.equal(dense.samples[2074].composition, 2);
  assert.equal(dense.samples[2074].ownership, 'tail-hold');
  assert.equal(dense.acceptedFrames, 2075, dense.samples.filter((sample) => !sample.accepted)
    .map((sample) => `${sample.beat}[${sample.composition}]@${sample.t.toFixed(3)} ${sample.reasons.join(',')}`).slice(0, 12).join('; '));
  assert.equal(dense.accepted, true);
  assert.ok(dense.samples.every((sample) => sample.result !== undefined));

  const p03 = dense.samples.filter((sample) => sample.beat === 'p03' && sample.t >= 10.9 && sample.t <= 11.2);
  assert.ok(p03.length > 0 && p03.every((sample) => sample.accepted));
  assert.ok(p03.every((sample) => (sample.result?.faceVisibility.zapp ?? 0) >= 0.8), 'Zapp face stays readable through the celebration/confetti beat');
  const p07 = dense.samples.filter((sample) => sample.beat === 'p07');
  assert.ok(p07.every((sample) => !sample.reasons.some((reason) => reason.startsWith('PROP_SHOT_UPSTAGED_BY_BODY'))));
  const p13 = dense.samples.filter((sample) => sample.beat === 'p13');
  assert.ok(p13.every((sample) => sample.accepted));

  const unowned = auditFinalCameraSafety(canonical.scene, [], { fps: 30, frameCount: 3 });
  assert.equal(unowned.frames, 3);
  assert.equal(unowned.acceptedFrames, 0);
  assert.equal(unowned.accepted, false);
  assert.ok(unowned.samples.every((sample) => sample.ownership === 'unowned' && sample.reasons.includes('FINAL_CAMERA_FRAME_UNOWNED')));
});

test('blocked and fallback reporting counts every composition, not one shot per beat', () => {
  const original = canonical.compositions[0].shot;
  const recipe = { ...original, source: 'recipe', accepted: true, recipeKnown: true } as ShotChoice;
  const fallback = { ...original, source: 'fallback', fallback: 'safe_wide', accepted: true, recipeKnown: true } as ShotChoice;
  const blocked = { ...original, source: 'blocked_best_effort', accepted: false, recipeKnown: true } as ShotChoice;
  const unknown = { ...original, source: 'recipe', accepted: true, recipeKnown: false } as ShotChoice;
  const compositions: CameraComposition[] = [recipe, fallback, blocked, unknown].map((shot, index) => ({ beat: index < 3 ? 'p01' : 'p02', index, start: index, end: index + 1, shot }));
  const summary = summarizeCompositionCameras(compositions);
  assert.deepEqual({ accepted: summary.accepted, fallback: summary.fallback, blocked: summary.blocked }, { accepted: 1, fallback: 1, blocked: 2 });
  assert.deepEqual(summary.blockedCompositions.map((c) => `${c.beat}[${c.index}]`), ['p01[2]', 'p02[3]']);
});

test('coverage is clause/composition scoped, fail-closed, and retains the 90% full-video gate', () => {
  const coverage = canonical.coverage;
  assert.equal(coverage.threshold, 0.9);
  assert.equal(canonical.report.summary.coverageThreshold, 0.9);
  assert.equal(coverage.blocking, false);
  assert.deepEqual(coverage.fullVideoCoverage, { required: 55, realized: 55, pct: 1 });
  assert.deepEqual(coverage.literalCoverage, { required: 22, realized: 22, pct: 1 });
  assert.deepEqual(coverage.actionRealization, { required: 11, realized: 11, pct: 1 });
  assert.deepEqual(coverage.propStateRealization, { required: 1, realized: 1, pct: 1 });
  assert.equal(coverage.clauses.length, 31);
  assert.equal(coverage.audioOnly, 19);

  const subjects = coverage.items.filter((item) => item.basis === 'composition-subject');
  assert.ok(subjects.length >= canonical.compositions.length);
  for (const composition of canonical.compositions) {
    const primary = composition.subject ?? composition.shot.subjects.active;
    const primaryItem = subjects.find((item) => item.beat === composition.beat && item.composition === composition.index && item.witness[0] === primary)!;
    assert.ok(primaryItem, `${composition.beat}[${composition.index}] primary ${primary}`);
    assert.deepEqual(primaryItem.window, [composition.start, composition.end]);
    if (composition.secondary && composition.shot.subjects.required.includes(composition.secondary)) {
      assert.ok(subjects.some((item) => item.beat === composition.beat && item.composition === composition.index && item.witness[0] === composition.secondary),
        `${composition.beat}[${composition.index}] required secondary ${composition.secondary}`);
    }
  }
  for (const item of coverage.items.filter((candidate) => candidate.basis === 'clause-literal')) {
    const composition = canonical.compositions.find((candidate) => candidate.beat === item.beat && candidate.index === item.composition)!;
    assert.ok(item.window[0] >= composition.start && item.window[1] <= composition.end);
  }
  assert.ok(coverage.items.filter((item) => item.basis === 'diagnostic').every((item) => !item.counted));

  const emote = coverage.items.find((item) => item.label.startsWith('vfx emote_exclaim@6.2'))!;
  const text = coverage.items.find((item) => item.label.startsWith('text ui_popup@36'))!;
  const entrance = coverage.items.find((item) => item.label.startsWith('enter teacher classroom_door@60.6'))!;
  assert.deepEqual(emote.window, [6.2, 7.3], 'VFX uses its exact runtime default duration and tail');
  assert.deepEqual(text.window, [36, 37.6], 'text graphic uses its complete authored duration');
  assert.deepEqual(entrance.window, [60.6, 62.0636], 'entrance uses the exact staged movement interval');
  for (const item of coverage.items.filter((candidate) => candidate.space === 'world' && candidate.basis !== 'diagnostic')) {
    assert.equal(item.samples, item.sampleTimes.length);
    for (const time of item.sampleTimes) {
      assert.ok(Math.abs(time * canonical.stage.fps - Math.round(time * canonical.stage.fps)) < 1e-3, `${item.id}@${time} is not an emitted frame`);
      assert.ok(time >= item.window[0] - 1e-4 && time < item.window[1] + 1e-4, `${item.id}@${time} outside ${item.window}`);
    }
  }

  const secondaryComposition = canonical.compositions.find((composition) => composition.secondary)!;
  assert.ok(secondaryComposition);
  const hiddenSecondary = canonical.compositions.map((composition) => composition === secondaryComposition ? {
    ...composition, secondary: 'missing_target', shot: {
      ...composition.shot,
      subjects: { ...composition.shot.subjects, required: [...composition.shot.subjects.required, 'missing_target'] },
    },
  } : composition);
  const hiddenSecondaryCoverage = coverageCheck(canonical.scene, canonical.stage, hiddenSecondary);
  assert.equal(hiddenSecondaryCoverage.blocking, true);
  assert.ok(hiddenSecondaryCoverage.items.some((item) => item.basis === 'composition-subject' && item.witness[0] === 'missing_target' && !item.covered));

  const requiredOnly = canonical.compositions.map((composition) => composition === secondaryComposition ? {
    ...composition, shot: { ...composition.shot, subjects: { ...composition.shot.subjects, required: [...composition.shot.subjects.required, 'required_only_missing'] } },
  } : composition);
  const requiredOnlyCoverage = coverageCheck(canonical.scene, canonical.stage, requiredOnly);
  assert.equal(requiredOnlyCoverage.blocking, true);
  assert.ok(requiredOnlyCoverage.items.some((item) => item.basis === 'composition-subject' && item.witness[0] === 'required_only_missing' && !item.covered));

  const noPress = structuredClone(canonical.stage);
  noPress.world.button.pressT = null;
  const noPressCoverage = coverageCheck(canonical.scene, noPress, canonical.compositions);
  assert.equal(noPressCoverage.propStateRealization.realized, 0, 'requested pressed label cannot replace an emitted press transition');
  assert.ok(noPressCoverage.fullVideoCoverage.realized < coverage.fullVideoCoverage.realized);

  const subframeAction = structuredClone(canonical.stage);
  const subframeKira = subframeAction.beats.find((beat) => beat.phraseId === 'p13')!.cast.find((cast) => cast.id === 'kira')!;
  subframeKira.actionT0 = 64.001; subframeKira.actionT1 = 64.01;
  const subframeCoverage = coverageCheck(canonical.scene, subframeAction, canonical.compositions);
  const subframeItem = subframeCoverage.items.find((item) => item.basis === 'clause-action' && item.beat === 'p13' && item.label.includes('sitting perfectly still'))!;
  assert.equal(subframeItem.covered, false);
  assert.equal(subframeItem.sampleTimes.length, 0, 'no output frame exists inside the staged action interval');
  assert.equal(subframeCoverage.blocking, true);

  const mixedIntent = structuredClone(canonical.stage);
  mixedIntent.beats.find((beat) => beat.phraseId === 'p03')!.text = 'Zapp celebrates because he wants to leave.';
  const mixedCoverage = coverageCheck(canonical.scene, mixedIntent, canonical.compositions);
  const mixedAction = mixedCoverage.items.find((item) => item.basis === 'clause-action' && item.beat === 'p03')!;
  assert.match(mixedAction.label, /celebrate/);
  assert.doesNotMatch(mixedAction.label, /exit_frame/);
  assert.equal(mixedAction.covered, true, 'executed celebrate remains required while intent-only leave is excluded');
  mixedIntent.beats.find((beat) => beat.phraseId === 'p03')!.text = 'Zapp wants to celebrate because he celebrates.';
  const repeatedIntentCoverage = coverageCheck(canonical.scene, mixedIntent, canonical.compositions);
  const repeatedAction = repeatedIntentCoverage.items.find((item) => item.basis === 'clause-action' && item.beat === 'p03')!;
  assert.match(repeatedAction.label, /celebrate/);
  assert.equal(repeatedAction.covered, true, 'later execution of the same intended action remains required');

  const propClause = coverage.clauses.find((clause) => clause.propStateRealization.required > 0)!;
  const laterPress = structuredClone(canonical.stage);
  laterPress.world.button.pressT = 32.5;
  const laterPressCoverage = coverageCheck(canonical.scene, laterPress, canonical.compositions);
  const laterState = laterPressCoverage.items.find((item) => item.basis === 'clause-prop-state')!;
  assert.equal(laterState.composition, canonical.compositionAt(32.5)!.index, 'transition evidence owns its actual composition');
  const boundaryPress = structuredClone(canonical.stage);
  const propBeat = canonical.stage.beats.find((beat) => beat.phraseId === propClause.beat)!;
  const clauseDefinition = splitDirectorClauses(propBeat.text).find((clause) => clause.index === propClause.index)!;
  const exactClauseEnd = propBeat.start + (propBeat.end - propBeat.start) * clauseDefinition.words[1] / propBeat.text.trim().split(/\s+/).length;
  boundaryPress.world.button.pressT = exactClauseEnd;
  const boundaryCoverage = coverageCheck(canonical.scene, boundaryPress, canonical.compositions);
  assert.equal(boundaryCoverage.propStateRealization.realized, 0, 'clause end is half-open');
  for (const clause of coverage.clauses) {
    const evidenceOwners = coverage.items.filter((item) => item.beat === clause.beat && item.clause === clause.index
      && ['clause-literal', 'clause-action', 'clause-prop-state'].includes(item.basis) && item.sampleTimes.length > 0 && item.composition !== null && item.composition >= 0)
      .map((item) => item.composition);
    if (evidenceOwners.length) assert.ok(evidenceOwners.includes(clause.composition), `${clause.beat} clause ${clause.index} summary owner`);
  }

  const blindPose = { pos: [0, 100, 0] as [number, number, number], target: [0, 101, 0] as [number, number, number], fovDeg: 10 };
  const first = canonical.compositions[0];
  const oneBlind = canonical.compositions.map((composition) => composition === first
    ? { ...composition, shot: { ...composition.shot, keys: [{ lt: 0, pose: blindPose }] } }
    : composition);
  const scoped = coverageCheck(canonical.scene, canonical.stage, oneBlind);
  const firstSubject = scoped.items.find((item) => item.basis === 'composition-subject' && item.beat === first.beat && item.composition === first.index)!;
  assert.equal(firstSubject.covered, false, 'visibility in later compositions cannot satisfy this sub-shot subject');
  assert.equal(scoped.blocking, true, 'a hidden selected target fails closed even if the global ratio remains high');

  const blind = canonical.compositions.map((composition) => ({ ...composition, shot: { ...composition.shot, keys: [{ lt: 0, pose: blindPose }] } }));
  const blindCoverage = coverageCheck(canonical.scene, canonical.stage, blind);
  assert.equal(blindCoverage.items.filter((item) => item.basis === 'composition-subject' && item.covered).length, 0);
  assert.ok(blindCoverage.fullVideoCoverage.pct < 0.9);
  assert.equal(blindCoverage.blocking, true);
  assert.equal(blindCoverage.threshold, 0.9);
  assert.equal(coverage.audioOnly, coverage.items.filter((item) => item.space === 'audio').length);
});

test('final composition direction, not composition zero, feeds the next persistent action axis', () => {
  const p01 = canonical.compositions.filter((c) => c.beat === 'p01');
  const p02First = canonical.compositions.find((c) => c.beat === 'p02' && c.index === 0)!;
  const initialSide = p01[0].shot.diagnostics.cameraSide;
  const finalSide = p01.at(-1)!.shot.diagnostics.cameraSide;
  const carriedSide = p02First.shot.safety.spec.screenDirection?.previousCameraSide;
  assert.notEqual(initialSide, finalSide, 'fixture must distinguish initial and final composition state');
  assert.equal(carriedSide, finalSide);
  assert.ok(p02First.shot.samples.every((s) => !s.reasons.some((r) => r.startsWith('SCREEN_DIRECTION_REVERSED'))));
});

test('final-camera safety evaluates posed output frames after scene shake and supplemental zoom/shake', () => {
  const t = 46.1;
  const composition = canonical.compositionAt(t)!;
  assert.equal(composition.beat, 'p10');
  const withoutSceneFx = evaluateFinalCameraAt(canonical.scene, composition, t, { includeSceneShake: false, supplementalVfx: [] });
  const final = evaluateFinalCameraAt(canonical.scene, composition, t, { supplementalVfx: [{ vfxId: 'zoom_punch', at: 46.0 }] });
  assert.ok(final.result, final.reasons.join('; '));
  assert.ok(final.camera && withoutSceneFx.camera);
  assert.ok(final.effects.sceneShake > 0, 'canonical screen_shake must be included');
  assert.ok(final.effects.supplementalShake > 0, 'zoom punch shake must be included');
  assert.ok(final.effects.zoom > 1, 'zoom punch must alter final FOV');
  assert.ok(final.camera!.fovY < withoutSceneFx.camera!.fovY);

  const unsafeComposition: CameraComposition = {
    ...composition,
    shot: {
      ...composition.shot,
      accepted: true,
      source: 'recipe',
      keys: [{ lt: 0, pose: { pos: [0, 100, 0], target: [0, 101, 0], fovDeg: 10 } }],
      samples: composition.shot.samples.map((s) => ({ ...s, accepted: true, reasons: [] })),
    },
  };
  const unsafeFinal = evaluateFinalCameraAt(canonical.scene, unsafeComposition, t, { includeSceneShake: false });
  assert.equal(unsafeFinal.accepted, false, 'dense evaluation must not replay sparse ShotChoice.accepted flags');
  assert.ok(unsafeFinal.result && unsafeFinal.result.rejectionReasons.length > 0);

  const dense = auditFinalCameraSafety(canonical.scene, [composition], { fps: 4, supplementalVfx: [{ vfxId: 'zoom_punch', at: 45.95 }] });
  assert.ok(dense.frames >= 4);
  assert.equal(dense.samples.length, dense.frames);
  assert.ok(dense.samples.every((s) => s.result !== undefined), dense.samples.flatMap((s) => s.reasons).join('; '));
  assert.equal(dense.accepted, dense.acceptedFrames === dense.frames);
});

test('raw Director sheets require exact complete blocker-free semantic authorization before staging', async () => {
  const approved = await directScript({ script: 'Kira waits in the kitchen.', duration: 4, seed: 44 }, { provider: 'offline' });
  const substitution = approved.report.semanticRequirements.beats[0].terms.find((term) => term.term === 'kitchen')!;
  assert.deepEqual(substitution, {
    term: 'kitchen', category: 'set', disposition: 'approved_substitution', words: [4, 5],
    catalogId: 'home_kitchen', substituteId: 'classroom',
  });
  assert.doesNotThrow(() => runVignette(approved.sheet, lib, { directorReport: approved.report }));

  assert.throws(() => runVignette(approved.sheet, lib), (error: unknown) =>
    error instanceof VignetteValidationError && /semantic sidecar/.test(error.message));

  const deleted = structuredClone(approved.report);
  deleted.semanticRequirements.beats[0].terms.splice(0, 1);
  assert.throws(() => runVignette(approved.sheet, lib, { directorReport: deleted }), (error: unknown) =>
    error instanceof VignetteValidationError && /do not exactly match/.test(error.message));

  const tamperedSubstitution = structuredClone(approved.report);
  tamperedSubstitution.semanticRequirements.beats[0].terms.find((term) => term.term === 'kitchen')!.substituteId = 'playground';
  assert.throws(() => runVignette(approved.sheet, lib, { directorReport: tamperedSubstitution }), (error: unknown) =>
    error instanceof VignetteValidationError && /do not exactly match/.test(error.message));

});

test('unknown residual semantics block instead of silently becoming idle', async () => {
  for (const [script, expected] of [
    ['A drone hovers.', ['drone']],
    ['Octopus swam.', ['octopus', 'swam']],
    ['The locksmith gave a parcel.', ['locksmith', 'gave', 'parcel']],
    ['Zapp runs/octopus.', ['runs octopus']],
    ['Kira/alien waits.', ['kira alien']],
    ['Zapp holds phone/meteor.', ['phone meteor']],
    ['Zapp runs🐙.', ['runs🐙.']],
    ['Kira外星 waits.', ['kira外星']],
    ['Zapp holds phone☄️.', ['phone☄️.']],
    ['Zapp picks/up the phone.', ['picks up']],
    ['Zapp picks／up the phone.', ['picks up']],
    ['Zapp picks—up the phone.', ['picks up']],
  ] as const) {
    const result = await directScript({ script, duration: 4, seed: 45 }, { provider: 'offline' });
    const blockers = result.report.semanticRequirements.beats.flatMap((beat) => beat.terms
      .filter((term) => term.disposition === 'authorization_blocker').map((term) => term.term));
    for (const term of expected) assert.ok(blockers.includes(term), `${script}: ${term}`);
    assert.throws(() => runVignette(result.sheet, lib, { directorReport: result.report }), (error: unknown) =>
      error instanceof VignetteValidationError && /semantic authorization blocked/.test(error.message));
  }
});

test('separable puts-it-down action is authorized without a false down concept', async () => {
  const result = await directScript({ script: ['Kira holds the phone.', 'She puts it down.'], duration: 8, seed: 46 }, { provider: 'offline' });
  assert.equal(result.sheet.beats[1].cast[0].actionId, 'put_down');
  const second = result.report.semanticRequirements.beats[1].terms;
  assert.ok(second.some((term) => term.term === 'puts it down' && term.category === 'action' && term.catalogId === 'put_down' && term.disposition === 'available'));
  assert.equal(second.some((term) => term.term === 'down' && term.category === 'unknown-content'), false);
  assert.doesNotThrow(() => runVignette(result.sheet, lib, { directorReport: result.report }));
});
