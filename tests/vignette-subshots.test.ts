import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadLibrary } from '../apps/render-worker/lib/library.ts';
import { MIN_SUB_SHOT_DURATION, validateBeatSheet, type BeatSheet } from '../packages/director/src/beat-sheet.ts';
import { LIBRARY, type Library } from '../packages/library/src/ids.ts';
import { CAMERA_RECIPES } from '../packages/vignette/src/camera-recipes.ts';
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
  // Teacher enters p13 at 60.6; end the main teacher composition before that instant.
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

test('coverage uses the active composition camera and retains the 90% threshold', () => {
  assert.equal(canonical.coverage.threshold, 0.9);
  assert.equal(canonical.report.summary.coverageThreshold, 0.9);
  assert.equal(canonical.coverage.blocking, false);
  const blindPose = { pos: [0, 100, 0] as [number, number, number], target: [0, 101, 0] as [number, number, number], fovDeg: 10 };
  const blind = canonical.compositions.map((c) => ({ ...c, shot: { ...c.shot, keys: [{ lt: 0, pose: blindPose }] } }));
  const blindCoverage = coverageCheck(canonical.scene, canonical.stage, blind);
  assert.ok(blindCoverage.covered < canonical.coverage.covered, `${blindCoverage.covered} should be below ${canonical.coverage.covered}`);
  assert.equal(blindCoverage.threshold, 0.9);
  assert.equal(canonical.coverage.audioOnly, canonical.coverage.items.filter((i) => i.space === 'audio').length);
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
