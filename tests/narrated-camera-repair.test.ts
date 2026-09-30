// Narrated camera repair: full-shot camera planning (envelope + every-frame validation), deterministic tracking, motivated
// profile / three-quarter coverage, sequential speaker/listener coverage, giant-prop scale reveal, implied-seated ending,
// canonical frame ownership. Mocked geometry + ONE analysis-only integrated pass (no pixels, browser, FFmpeg or audio).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { Vec3 } from '../packages/engine/src/math.ts';
import { evaluateCameraCandidate, nextScreenDirectionState, projectToScreen, CAMERA_SAFETY_DEFAULTS, EXCLUDED_ACTOR_MAX_BODY_COVERAGE, type Bounds3, type CameraCandidate, type CameraObstacle, type CameraSafetyScene, type ProjectedEntity } from '../packages/engine/src/camera-safety.ts';

const { lib, ROOT } = await import('./helpers.ts');
const I = await import('../apps/render-worker/narrated-integration.ts');
const { draftEpisodeFor } = await import('../apps/studio/narrated-draft.ts');
const { compileNarratedTimeline, DRAFT_EXPORT } = await import('../packages/narrated/src/timeline.ts');
const { buildWorldPlan, worldAssets } = await import('../packages/narrated/src/world.ts');
const { validateEpisode } = await import('../packages/pipeline/src/validate.ts');
const { headlessEngine } = await import('../packages/engine/src/headless.ts');

// ───────── mocked geometry (metres; y up, audience at +z) ─────────
const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Bounds3 => ({ min: [x0, y0, z0], max: [x1, y1, z1] });
const n3 = (v: Vec3): Vec3 => { const l = Math.hypot(...v); return [v[0] / l, v[1] / l, v[2] / l]; };
function character(id: string, x: number, z: number, facing: Vec3 = [0, 0, 1]) {
  const f = n3(facing);
  const obstacles: CameraObstacle[] = [
    { entityId: id, type: 'body', bounds: box(x - 0.3, 0, z - 0.2, x + 0.3, 1.3, z + 0.2) },
    { entityId: id, type: 'head', bounds: box(x - 0.16, 1.3, z - 0.16, x + 0.16, 1.62, z + 0.16) },
  ];
  const meta: ProjectedEntity = { entityId: id, kind: 'character', facing: f };
  return { obstacles, meta, face: [x + f[0] * 0.162, 1.46, z + f[2] * 0.162] as Vec3 };
}
const FLOOR: CameraObstacle = { entityId: 'floor', type: 'environment', bounds: box(-8, -0.1, -4, 8, 0, 12) };
const scene = (obstacles: CameraObstacle[], entities: ProjectedEntity[], over: Partial<CameraSafetyScene> = {}): CameraSafetyScene => ({ frameWidth: 540, frameHeight: 960, subjectIds: [], heroPropIds: [], obstacles: [FLOOR, ...obstacles], projectedEntities: entities, ...over });
const cand = (id: string, intent: CameraCandidate['intent'], position: Vec3, target: Vec3, more: Partial<CameraCandidate> = {}): CameraCandidate => ({ id, intent, fov: 38, transform: { position }, target, ...more });
const has = (r: string[], code: string) => r.some((x) => x === code || x.startsWith(code + ':'));
const orbit = (c: Vec3, yawDeg: number, d: number, dy: number): Vec3 => [c[0] + Math.sin((yawDeg * Math.PI) / 180) * d, c[1] + dy, c[2] + Math.cos((yawDeg * Math.PI) / 180) * d];

/** Kira faces Zapp (to her left, -x); a hair lock hides only her FAR (right) eye from the audience-left side */
function kiraListening() {
  const k = character('kira', 0.7, 0, [-1, 0, 0]), z = character('zapp', -0.7, 0, [1, 0, 0]);
  const kFace: ProjectedEntity = { ...k.meta, face: { center: k.face, normal: [-1, 0, 0], halfWidth: 0.12, halfHeight: 0.12, leftEye: [0.538, 1.51, -0.066], rightEye: [0.538, 1.51, 0.066], mouth: [0.538, 1.39, 0] } };
  return { k, z, kFace };
}

// ───────── one analysis-only integrated pass (shared) ─────────
const TEXT = readFileSync(join(ROOT, 'tests/fixtures/narrated/approved-narrated-v0.1.json'), 'utf8'), SB = JSON.parse(TEXT);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
function integrate() {
  const tl = compileNarratedTimeline(SB, sha(TEXT));
  const v = validateEpisode(draftEpisodeFor(SB, tl, lib as never), lib as never, { repair: true, profile: 'narrated-draft' });
  const plan = buildWorldPlan(SB, worldAssets(lib as never));
  const { prod } = headlessEngine(v.episode!, lib as never, DRAFT_EXPORT.width, DRAFT_EXPORT.height);
  return { tl, plan, ...I.integrateNarrated({ sb: SB, tl, plan, prod, width: DRAFT_EXPORT.width, height: DRAFT_EXPORT.height }) };
}
const RUN = integrate();
const T = RUN.timeline, A = RUN.analysis as any, N = RUN.plan.frames, W = DRAFT_EXPORT.width, H = DRAFT_EXPORT.height;
const gate = (id: string) => A.gates.find((g: any) => g.id === id)!;

test('1. full-shot validation catches a failure between sparse planning samples', () => {
  // a 7-frame shot: a hanging sign swings in front of the face ONLY on frame 4 (not a 0/3/6 planning sample)
  const k = character('kira', 0, 0);
  const cam = cand('static', 'medium', [0, 1.35, 2.05], [0, 1.2, 0], { activeSubjectId: 'kira' });
  const frames = Array.from({ length: 7 }, (_, i) => scene([...k.obstacles, ...(i === 4 ? [{ entityId: 'sign', type: 'environment' as const, bounds: box(-0.3, 1.25, 0.6, 0.3, 1.7, 0.65) }] : [])], [k.meta], { subjectIds: ['kira'] }));
  const sparse = [0, 3, 6].map((i) => evaluateCameraCandidate(frames[i], cam).accepted);
  assert.deepEqual(sparse, [true, true, true], 'the sparse samples alone would accept the camera');
  const every = frames.map((f) => evaluateCameraCandidate(f, cam));
  assert.equal(every[4].accepted, false);
  assert.ok(has(every[4].rejectionReasons, 'FACE_VISIBILITY_LOW:kira'), every[4].rejectionReasons.join('; '));
  // the planner samples first/last, every <=100 ms and every event / mark / pose transition, then validates EVERY frame
  const mockPlan = { fps: 30, events: [{ t: 0.14, type: 'x' }], actors: { a: { segs: [{ t0: 0.05, t1: 0.2 }] } }, instances: [{ t0: 0.1, t1: 0.2 }] } as never;
  const sf = I.planSampleFrames(mockPlan, 0, 10);
  assert.deepEqual([sf[0], sf[sf.length - 1]], [0, 9]);
  for (let k2 = 1; k2 < sf.length; k2++) assert.ok(sf[k2] - sf[k2 - 1] <= I.CAMERA_SAMPLE_FRAMES);
  for (const f of [2, 3, 5, 6]) assert.ok(sf.includes(f), `event/mark/pose frame ${f} sampled`);
  // in the integrated plan every shot's chosen camera was validated on all of its frames
  assert.equal(A.frameCoverage.failing - T.shots.filter((s) => !s.camera).reduce((a: number, s) => a + (s.frames[1] - s.frames[0]), 0), 0, 'no accepted camera fails any of its frames');
});

test('2. a tracking camera keeps the moving subject inside its size band', () => {
  // Kira walks 2.4 m along +x; a static medium loses her, the tracked camera keeps her head size constant
  const F = 49, X = (i: number) => -1.2 + (2.4 * i) / (F - 1);
  const geos = Array.from({ length: F }, (_, i) => ({ i, t: i / 30, actors: { kira: { head: box(X(i) - 0.16, 1.3, -0.16, X(i) + 0.16, 1.62, 0.16), root: [X(i), 0, 0] } }, props: {} }) as never);
  const seed = cand('seed', 'medium', [0, 1.4, 1.9], [0, 1.2, 0], { activeSubjectId: 'kira' });
  const t = I.buildTrackingTrajectory(seed, geos, 0, F, 'kira', undefined);
  assert.equal(t.reason, null);
  const hh: number[] = [], still: boolean[] = [];
  for (let i = 0; i < F; i++) {
    const k = character('kira', X(i), 0), sc = scene(k.obstacles, [k.meta], { subjectIds: ['kira'] });
    const r = evaluateCameraCandidate(sc, { ...seed, transform: { position: t.track![i].position }, target: t.track![i].target, ...(i ? { lensPath: [t.track![i - 1].position] } : {}) });
    hh.push(r.diagnostics.requiredHeadHeightPct.kira);
    still.push(evaluateCameraCandidate(sc, seed).accepted);
    assert.equal(r.accepted, true, `frame ${i}: ${r.rejectionReasons.join('; ')}`);
  }
  assert.ok(Math.max(...hh) - Math.min(...hh) < 2, `head size stays in band: ${Math.min(...hh)}..${Math.max(...hh)} %`);
  assert.ok(still.includes(false), 'the static camera fails once she walks away (why tracking is used)');
  for (let i = 1; i < F; i++) assert.ok(Math.hypot(...([0, 1, 2].map((q) => t.track![i].position[q] - t.track![i - 1].position[q]) as [number, number, number])) <= I.MAX_TRACK_STEP_M, 'no teleport');
});

test('3. a tracking path through geometry blocks the candidate', () => {
  const k = character('kira', 0, 0), pillar: CameraObstacle = { entityId: 'pillar', type: 'environment', bounds: box(0.9, 0, 2.3, 1.1, 3, 2.5) };
  const sc = scene([...k.obstacles, pillar], [k.meta], { subjectIds: ['kira'] });
  const here = cand('track@k', 'medium', [1.6, 1.35, 2.4], [0, 1.2, 0], { activeSubjectId: 'kira' });
  assert.ok(!evaluateCameraCandidate(sc, here).rejectionReasons.some((x) => /COLLISION/.test(x)), 'the frame position itself is clear');
  const r = evaluateCameraCandidate(sc, { ...here, lensPath: [[0.4, 1.35, 2.4]] }); // previous frame on the far side of the pillar
  assert.equal(r.accepted, false);
  assert.ok(has(r.rejectionReasons, 'CAMERA_PATH_COLLISION:environment:pillar'), r.rejectionReasons.join('; '));
});

test('4. tracking preserves screen direction (a trajectory crossing the action axis is refused)', () => {
  // Zapp (tracked) walks past a static Kira: a fixed offset would carry the lens across the Kira–Zapp axis
  const geos = Array.from({ length: 91 }, (_, i) => {
    const x = 2 - (4 * i) / 90;
    return { i, t: i / 30, actors: { zapp: { head: box(x - 0.16, 1.3, 1.44, x + 0.16, 1.62, 1.76), root: [x, 0, 1.6] }, kira: { head: box(-0.16, 1.3, -0.16, 0.16, 1.62, 0.16), root: [0, 0, 0] } }, props: {} } as never;
  });
  const seed = cand('seed', 'medium', [0, 1.4, 4.6], [0, 1.3, 1.6], { activeSubjectId: 'zapp' });
  const t = I.buildTrackingTrajectory(seed, geos, 0, 91, 'zapp', undefined);
  assert.equal(t.track, null);
  assert.match(t.reason!, /^TRACKING_SCREEN_DIRECTION_FLIP/);
  // a subject moving along its own side of the axis tracks fine
  const ok = I.buildTrackingTrajectory(seed, geos.slice(0, 31) as never, 0, 31, 'zapp', undefined); // stays on its side
  assert.equal(ok.reason, null);
});

test('5. a motivated Kira profile passes with one eye and the mouth readable', () => {
  const { k, z, kFace } = kiraListening();
  const lock: CameraObstacle = { entityId: 'kira', type: 'hair', bounds: box(0.5, 1.47, -0.09, 0.56, 1.55, -0.05) }; // over the far eye only
  const sc = scene([...k.obstacles, ...z.obstacles, lock], [kFace, z.meta], { subjectIds: ['kira'], optionalSubjectIds: ['zapp'], activeSubjectId: 'kira' });
  const pos = orbit(k.face, -90 + 70, 1.8, 0.02); // 70 deg off her face normal, audience side, eyeline toward Zapp
  const c = cand('kira_profile', 'motivated_profile', pos, [0.7, 1.42, 0], { activeSubjectId: 'kira', eyelineTargetId: 'zapp', profileScale: 'close' });
  const r = evaluateCameraCandidate(sc, c);
  assert.equal(r.accepted, true, r.rejectionReasons.join('; '));
  assert.equal(r.diagnostics.eyesVisible.kira, 1, 'only the near eye reads');
  assert.equal(r.diagnostics.mouthVisible.kira, true);
  assert.ok(r.diagnostics.requiredHeadHeightPct.kira >= 26, 'close band minimum preserved');
  // eyeline: a camera from the far side makes her look away from Zapp on screen -> rejected
  const wrong = evaluateCameraCandidate(sc, { ...c, eyelineTargetId: 'nobody' });
  assert.ok(has(wrong.rejectionReasons, 'EYELINE_TARGET_UNKNOWN:kira'));
});

test('6. a normal frontal shot cannot use the relaxed profile rules', () => {
  const { k, kFace } = kiraListening();
  // Zapp is only the eyeline target here (no geometry in the way of a frontal camera)
  const zT: ProjectedEntity = { entityId: 'zapp', kind: 'character', bounds: box(-0.86, 1.3, -0.16, -0.54, 1.62, 0.16) };
  const lock: CameraObstacle = { entityId: 'kira', type: 'hair', bounds: box(0.5, 1.47, -0.09, 0.56, 1.55, -0.05) };
  const sc = scene([...k.obstacles, lock], [kFace, zT], { subjectIds: ['kira'], activeSubjectId: 'kira' });
  const near = orbit(k.face, -90 + 20, 1.8, 0.02); // 20 deg: a frontal close
  const asClose = evaluateCameraCandidate(sc, cand('close', 'close', near, [0.7, 1.42, 0], { activeSubjectId: 'kira' }));
  assert.ok(has(asClose.rejectionReasons, 'EYES_NOT_VISIBLE:kira'), 'frontal close needs both eyes: ' + asClose.rejectionReasons.join('; '));
  const asProfile = evaluateCameraCandidate(sc, cand('prof', 'motivated_profile', near, [0.7, 1.42, 0], { activeSubjectId: 'kira', eyelineTargetId: 'zapp' }));
  assert.ok(has(asProfile.rejectionReasons, 'PROFILE_ANGLE_OUT_OF_RANGE:kira'), 'a frontal view cannot be relabelled as a profile');
  // the 60% profile visibility never applies to a medium: 0.6 fails the normal 80%
  const sign: CameraObstacle = { entityId: 'sign', type: 'environment', bounds: box(0.3, 1.3, 0.62, 0.42, 1.62, 0.7) };
  const sc2 = scene([...k.obstacles, sign], [kFace, zT], { subjectIds: ['kira'], activeSubjectId: 'kira' });
  const med = evaluateCameraCandidate(sc2, cand('med', 'medium', orbit(k.face, -90 + 40, 2.9, -0.2), [0.7, 1.15, 0], { activeSubjectId: 'kira' }));
  if (med.faceVisibility.kira < 0.8) assert.ok(has(med.rejectionReasons, 'FACE_VISIBILITY_LOW:kira'));
});

test('7. the Kira warning receives speaker/listener sequential coverage in the same interval', () => {
  const warn = SB.script.phrases.find((p: any) => p.semanticAction === 'head_shake');
  const seq = T.sequentialCoverage.filter((q) => q.phraseId === warn.id && q.split);
  assert.ok(seq.length >= 1, 'the warning beat is split into speaker + listener coverage');
  for (const q of seq) {
    const [a, b] = q.split!.map((id) => T.shots.find((s) => s.id === id)!), src = RUN.tl.shots.find((s) => s.id === q.sourceShot)!;
    assert.equal(a.spec.active, warn.actor, 'speaker first');
    assert.equal(b.spec.active, warn.supportingCharacter, 'listener second');
    assert.equal(a.start, src.start); assert.equal(b.end, src.end); assert.equal(a.end, b.start);
    assert.equal(a.frames[1], b.frames[0], 'contiguous frames, same continuous world');
    assert.equal(a.chunkId, b.chunkId, 'same caption / audio interval');
    if (q.outcome.startsWith('blocked')) assert.ok(!(a.camera && b.camera));
    if (!(a.camera && b.camera)) assert.equal(gate('C09').pass, false, 'a blocked split is reported, never silently accepted');
  }
});

test('8. required actors are never dropped', () => {
  assert.equal(A.camera.requiredActorDropFrames, 0);
  for (const s of T.shots.filter((x) => x.camera)) {
    const req = s.spec.subjects.filter((q) => !s.spec.optional.includes(q));
    for (const q of req) assert.ok(!s.droppedOptional.includes(q), `${s.id} drops required ${q}`);
  }
  // a sequential split keeps both required actors: one per half, each as that half's active subject
  for (const q of T.sequentialCoverage.filter((x) => x.split)) { const [a, b] = q.split!.map((id) => T.shots.find((s) => s.id === id)!); assert.deepEqual([a.spec.active, b.spec.active].sort(), [...new Set([a.spec.active, b.spec.active])].sort()); assert.notEqual(a.spec.active, b.spec.active); }
});

function giantCoin() {
  const z = character('zapp', 1.1, 0.4, [0, 0, 1]);
  const c: Vec3 = [-0.6, 1.2, -0.2], R = 1.2, th = 0.12;
  const coin: CameraObstacle = { entityId: 'coin', type: 'prop', bounds: box(c[0] - R, 0, c[2] - th, c[0] + R, 2 * R, c[2] + th) };
  const rim = Array.from({ length: 12 }, (_, k) => { const a = (k / 12) * 2 * Math.PI; return [c[0] + R * Math.cos(a), c[1] + R * Math.sin(a), c[2]] as Vec3; });
  const ent: ProjectedEntity = { entityId: 'coin', kind: 'prop', bounds: coin.bounds, identity: { center: c, frontNormal: [0, 0, 1], emblem: [c[0], c[1], c[2] + th], rim, base: [c[0], 0.01, c[2]] } };
  return { z, coin, ent, c, sc: scene([...z.obstacles, coin], [z.meta, ent], { subjectIds: ['zapp'], heroPropIds: ['coin'], activeSubjectId: 'zapp' }) };
}

test('9. a giant-coin scale reveal shows silhouette, emblem, thickness edge, base and the scale actor', () => {
  const { sc, c } = giantCoin();
  const mid: Vec3 = [0.1, 1.1, 0];
  const good = cand('reveal', 'scale_reveal', orbit(mid, 30, 7.2, 0.9), mid, { fov: 50, activeSubjectId: 'zapp', scaleReferenceIds: ['zapp'] });
  const r = evaluateCameraCandidate(sc, good);
  assert.equal(r.accepted, true, r.rejectionReasons.join('; '));
  assert.ok(r.diagnostics.propScreenSize.coin >= 0.2 && r.diagnostics.subjectScreenHeight.zapp >= 0.12);
  const flatOn = evaluateCameraCandidate(sc, { ...good, transform: { position: [c[0], c[1], 7.2] }, target: [c[0], c[1], 0] });
  assert.ok(has(flatOn.rejectionReasons, 'SCALE_REVEAL_NO_THICKNESS_EDGE:coin'), 'flat-on hides the thickness');
  const edgeOn = evaluateCameraCandidate(sc, { ...good, transform: { position: [c[0] - 7, c[1], -0.1] }, target: [c[0], c[1], 0] });
  assert.ok(has(edgeOn.rejectionReasons, 'SCALE_REVEAL_EMBLEM_UNREADABLE:coin') || has(edgeOn.rejectionReasons, 'CAMERA_BEHIND_HERO_PROP:coin'), edgeOn.rejectionReasons.join('; '));
  const behind = evaluateCameraCandidate(sc, { ...good, transform: { position: orbit(mid, 180 + 25, 7, 0.9) } });
  assert.ok(has(behind.rejectionReasons, 'CAMERA_BEHIND_HERO_PROP:coin'));
  const far = evaluateCameraCandidate(sc, { ...good, transform: { position: orbit(mid, 30, 40, 2) }, fov: 42 });
  assert.ok(has(far.rejectionReasons, 'SCALE_REFERENCE_TOO_SMALL:zapp') || has(far.rejectionReasons, 'HERO_PROP_UNREADABLE:coin'));
  // the scale-reveal exception is explicit only: the same camera as an ordinary wide keeps the ordinary rules
  assert.equal(evaluateCameraCandidate(sc, { ...good, intent: 'prop' }).rejectionReasons.some((x) => x.startsWith('SCALE_REVEAL')), false);
});

test('10. a giant coin cannot hide the active face', () => {
  const z = character('zapp', 1.1, 0, [0, 0, 1]);
  const cb = box(0.2, 0, 1.0, 2.0, 2.4, 1.24), c: Vec3 = [1.1, 1.2, 1.12];
  const rim = Array.from({ length: 12 }, (_, k) => { const a = (k / 12) * 2 * Math.PI; return [c[0] + 0.9 * Math.cos(a), c[1] + 0.9 * Math.sin(a), c[2]] as Vec3; });
  const ent: ProjectedEntity = { entityId: 'coin', kind: 'prop', bounds: cb, identity: { center: c, frontNormal: [0, 0, 1], emblem: [1.1, 1.2, 1.24], rim, base: [1.1, 0.01, 1.12] } };
  const sc = scene([...z.obstacles, { entityId: 'coin', type: 'prop', bounds: cb }], [z.meta, ent], { subjectIds: ['zapp'], heroPropIds: ['coin'], activeSubjectId: 'zapp' });
  const r = evaluateCameraCandidate(sc, cand('hidden', 'scale_reveal', [2.6, 1.5, 6], [1.1, 1.3, 0.4], { fov: 50, activeSubjectId: 'zapp', scaleReferenceIds: ['zapp'] }));
  assert.equal(r.accepted, false);
  assert.ok(has(r.rejectionReasons, 'PROP_COVERS_FACE:zapp'), r.rejectionReasons.join('; '));
  assert.ok((r.diagnostics.faceOccluders.zapp ?? []).includes('prop:coin'));
});

test('11. the implied_seated teacher-return shot is waist-up (no legs, no missing chair)', () => {
  const p13 = SB.script.phrases.find((p: any) => /teacher returns/i.test(p.text));
  const s = T.shots.find((x) => x.phraseId === p13.id)!;
  assert.equal(s.spec.active, 'kira');
  assert.ok(s.spec.optional.includes('zapp'), 'Zapp and the coin are not required in the Kira reaction');
  assert.ok(s.camera, `teacher-return shot ${s.id} has a camera (${s.blocked})`);
  for (let i = s.frames[0]; i < s.frames[1]; i++) {
    const g = RUN.geos[i];
    const r = evaluateCameraCandidate(I.cameraScene(g, s.spec, W, H, undefined), I.cameraForFrame(s, i));
    assert.ok(!r.rejectionReasons.some((x) => x.startsWith('WAIST_UP_REQUIRED_LEGS_VISIBLE')), `frame ${i}: ${r.rejectionReasons.join('; ')}`);
    assert.equal(r.diagnostics.headCropped.kira, false);
  }
});

test('12. the final button-reset shots do not require Kira', () => {
  const p14 = SB.script.phrases.find((p: any) => /resets/i.test(p.text));
  const shots = T.shots.filter((x) => x.phraseId === p14.id);
  assert.ok(shots.length >= 1);
  for (const s of shots) assert.ok(!s.spec.subjects.filter((q) => !s.spec.optional.includes(q)).includes('kira'), `${s.id} requires Kira`);
  const last = shots[shots.length - 1];
  assert.equal(last.spec.intent, 'elevated_consequence');
  assert.deepEqual(last.spec.scaleRefs, ['zapp'], 'Zapp (prone) stays in the consequence coverage');
  assert.ok(last.spec.heroProps.includes('coin'));
  const sc = I.cameraScene(RUN.geos[last.frames[0]], last.spec, W, H, undefined);
  assert.ok(!sc.subjectIds.includes('kira') && !(sc.optionalSubjectIds ?? []).includes('kira'), 'Kira is not a subject: waist-up framing is not demanded of this shot');
});

test('13. all frames are assigned to exactly one shot (canonical ceil(start*fps) ownership)', () => {
  assert.equal(A.frameCoverage.totalFrames, N);
  assert.equal(N, 2075);
  assert.equal(A.frameCoverage.assigned, N);
  assert.equal(A.frameCoverage.gapCount, 0);
  assert.equal(A.frameCoverage.overlapCount, 0);
  assert.equal(T.shots[0].frames[0], 0);
  assert.equal(T.shots[T.shots.length - 1].frames[1], N);
  for (let k = 1; k < T.shots.length; k++) assert.equal(T.shots[k].frames[0], T.shots[k - 1].frames[1], `${T.shots[k].id} starts where ${T.shots[k - 1].id} ends`);
  for (const s of T.shots) assert.equal(s.frames[0], I.firstFrameAt(s.start, 30));
  const blockedFrames = T.shots.filter((s) => !s.camera).reduce((a, s) => a + s.frames[1] - s.frames[0], 0);
  assert.equal(A.frameCoverage.evaluated, N - blockedFrames, 'every frame with a camera is evaluated with the camera active at that frame');
  // cameraAt resolves every frame through the same ownership (render-time == analysis-time camera)
  for (const s of T.shots.filter((x) => x.camera)) for (const i of [s.frames[0], s.frames[1] - 1]) {
    const c = I.cameraAt(T, i / 30), e = I.cameraForFrame(s, i);
    assert.ok(c.pos.every((v, q) => Math.abs(v - e.transform.position[q]) < 1e-12), `${s.id} frame ${i}: render camera = analysed camera`);
  }
});

test('14. no between-sample head-size failure', () => {
  assert.equal(A.camera.subjectSizeFrames, 0, `${A.camera.subjectSizeFrames} frames outside the head-size band`);
  assert.equal(gate('C07').pass, true, gate('C07').detail);
  const inCamShots = Object.entries(A.frameCoverage.failuresByShot as Record<string, number>).filter(([id]) => T.shots.find((s) => s.id === id)?.camera);
  assert.deepEqual(inCamShots, [], 'no frame of an accepted camera fails validation');
});

test('15. a caption conflict selects the next caption-safe camera (never an unresolved conflict)', () => {
  const fake = (bad: boolean) => ({ band: 'lower' as const, rect: { x: 0, y: 0, w: 1, h: 1 }, centerY: 0.72, score: bad ? 10000 : 0, overlapMetrics: {}, warnings: bad ? ['CAPTION_PLACEMENT_CONFLICT'] : [], stableForWholeChunk: true, chunkStart: 0, chunkEnd: 1, violations: bad ? ['PRIMARY_FACE' as const] : [], candidates: [] });
  const r = I.coordinateChunk([['cam_a', 'cam_b'], ['cam_c']], (c) => fake(c[0] === 'cam_a'));
  assert.deepEqual(r.chosen, ['cam_b', 'cam_c']);
  assert.equal(r.blocked, null);
  for (const p of T.captionPlacements) {
    if (p.blocked || p.band === 'none') continue;
    assert.deepEqual(p.violations, [], `${p.chunkId} placed without hard violations`);
  }
  assert.equal(gate('K07').pass, true, gate('K07').detail);
  // a shot keeps a camera only if its chunk has a caption-safe band
  for (const s of T.shots.filter((x) => x.camera)) assert.ok(T.captions.find((c) => c.chunkId === s.chunkId)?.placement, `${s.id} camera without caption placement`);
});

test('16. the same input produces a byte-identical camera plan', () => {
  const again = integrate();
  assert.equal(JSON.stringify(again.timeline.shots), JSON.stringify(T.shots));
  assert.equal(JSON.stringify(again.timeline.captionPlacements), JSON.stringify(T.captionPlacements));
  assert.equal(JSON.stringify((again.analysis as any).frameCoverage), JSON.stringify(A.frameCoverage));
});

test('17. the existing camera-safety worker tests remain passing', () => {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; // run as an independent test process (TAP on stdout)
  const out = execFileSync(process.execPath, ['--test', '--test-reporter=tap', 'tests/narrated-camera-safety.test.ts'], { cwd: ROOT, encoding: 'utf8', env });
  assert.match(out, /# fail 0/);
  assert.match(out, /# pass [1-9]/);
});

test('18. the Visual Comedy camera path is unchanged', () => {
  const git = (args: string[]) => { try { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; } };
  for (const f of ['packages/engine/src/camera.ts', 'packages/engine/src/production.ts']) {
    const base = git(['show', `4905755:${f}`]);
    if (base !== null) assert.equal(readFileSync(join(ROOT, f), 'utf8'), base, `${f} changed`);
  }
  const ep = JSON.parse(readFileSync(join(ROOT, 'episodes/free-coins-loop-001.json'), 'utf8'));
  const v = validateEpisode(ep, lib as never, { repair: true });
  const run = () => { const { prod } = headlessEngine(v.episode!, lib as never, 540, 960); return [0, 3.1, 7.7, 12.4].map((t) => prod.evaluate(t).cam.pos.map((x: number) => x.toFixed(6)).join(',')).join('|'); };
  assert.equal(run(), run());
  assert.doesNotMatch(readFileSync(join(ROOT, 'packages/engine/src/production.ts'), 'utf8'), /narrated|camera-safety/);
});

// ───────── final five: intent-level shot patterns selected from semantic events ─────────
const shot = (id: string) => T.shots.find((x) => x.id === id);
const byCoverage = (c: string) => T.shots.filter((x) => x.coverage === c);
const everyFrame = (s: (typeof T.shots)[number]) => { const out = []; for (let i = s.frames[0]; i < s.frames[1]; i++) out.push(evaluateCameraCandidate(I.cameraScene(RUN.geos[i], s.spec, W, H, undefined), I.cameraForFrame(s, i))); return out; };

test('19. Kira warning: offset/elevated speaker OTS holds the actual head shake on every frame', () => {
  const warn = SB.script.phrases.find((p: any) => p.semanticAction === 'head_shake');
  const sp = T.shots.find((x) => x.phraseId === warn.id && x.coverage === 'sequential_speaker')!;
  assert.equal(sp.spec.active, 'kira', 'Kira stays the active subject');
  assert.ok(!sp.spec.optional.includes('kira'), "Kira's face is never optional");
  assert.equal(sp.camera!.intent, 'offset_elevated_speaker_ots');
  assert.equal(sp.camera!.eval.foregroundSubjectId, 'zapp');
  const yaws = []; for (let i = sp.frames[0]; i < sp.frames[1]; i++) { const n = RUN.geos[i].actors.kira.face.normal; yaws.push((Math.atan2(n[0], n[2]) * 180) / Math.PI); }
  assert.ok(Math.max(...yaws) - Math.min(...yaws) > 25, 'the interval contains the real head shake');
  const zBody = RUN.geos[sp.frames[0]].actors.zapp.body;
  assert.ok(sp.camera!.position[1] >= zBody.max[1], "lens above the listener's shoulder line");
  const kira = RUN.geos[sp.frames[0]].actors.kira.root;
  assert.equal(RUN.geos[sp.frames[1] - 1].actors.kira.root.join(), kira.join(), 'Kira is not moved or rotated toward the camera');
  for (const r of everyFrame(sp)) {
    assert.equal(r.accepted, true, r.rejectionReasons.join('; '));
    assert.ok(r.diagnostics.eyesVisible.kira >= 1 && r.diagnostics.mouthVisible.kira, 'near eye + mouth');
    assert.ok(r.foregroundCoverage <= 0.35 && r.lensClearance > 0);
    assert.ok(!r.screenDirectionResult.startsWith('reversed'));
  }
  // same side as the previous shot, or a side change that is motivated by the neutral top-down insert right before it
  const prevShot = T.shots[T.shots.indexOf(sp) - 1];
  assert.ok(sp.screenDirection.startsWith('consistent') || (sp.screenDirection.startsWith('reset_after_neutral') && prevShot.camera!.intent === 'neutral_top_down_prop_insert'), `screen direction: ${sp.screenDirection} after ${prevShot.id}`);
  // the listener coverage stays separate and follows in the same caption interval
  const li = T.shots.find((x) => x.phraseId === warn.id && x.coverage === 'sequential_listener')!;
  assert.equal(li.spec.active, 'zapp'); assert.equal(li.chunkId, sp.chunkId); assert.equal(li.frames[0], sp.frames[1]);
});

test('20. the speaker OTS pattern is explicit: an ordinary medium from the same lens is not relaxed', () => {
  const sp = byCoverage('sequential_speaker')[0], i = sp.frames[0] + 5, c = I.cameraForFrame(sp, i);
  const asOts = evaluateCameraCandidate(I.cameraScene(RUN.geos[i], sp.spec, W, H, undefined), c);
  assert.equal(asOts.accepted, true);
  const noFg = evaluateCameraCandidate(I.cameraScene(RUN.geos[i], sp.spec, W, H, undefined), { ...c, foregroundSubjectId: undefined });
  assert.ok(noFg.rejectionReasons.some((x) => x.startsWith('OTS_NO_FOREGROUND_SUBJECT')), 'an OTS must name its foreground listener');
  const low = evaluateCameraCandidate(I.cameraScene(RUN.geos[i], sp.spec, W, H, undefined), { ...c, transform: { position: [c.transform.position[0], 0.9, c.transform.position[2]] } });
  assert.ok(low.rejectionReasons.some((x) => x.startsWith('OTS_NOT_ELEVATED:zapp')));
});

test('21. coin growth receives scale-staged coverage cut at deterministic prop-scale thresholds', () => {
  const pat = T.coveragePatterns.find((q) => q.pattern === 'prop_growth_sequence')!;
  assert.ok(pat && pat.segments.length >= 2, 'at least two scale-appropriate cameras');
  assert.equal(pat.outcome, 'accepted');
  const segs = pat.segments.map((id) => shot(id)!);
  const src = RUN.tl.shots.find((x) => x.id === pat.sourceShot)!;
  assert.equal(segs[0].start, src.start); assert.equal(segs[segs.length - 1].end, src.end);
  for (let k = 1; k < segs.length; k++) assert.equal(segs[k].frames[0], segs[k - 1].frames[1], 'every frame belongs to exactly one stage');
  const scales = []; for (let i = segs[0].frames[0]; i < segs[segs.length - 1].frames[1]; i++) scales.push(RUN.geos[i].coinScale);
  assert.deepEqual(I.growthStageBoundaries(scales, segs[0].frames[0]), pat.boundaries, 'boundaries = first frame at s0 * 2.5^k');
  assert.deepEqual(I.growthStageBoundaries(scales, segs[0].frames[0]), I.growthStageBoundaries([...scales], segs[0].frames[0]));
  for (const b of pat.boundaries) {
    const g0 = RUN.geos[b - 1], g1 = RUN.geos[b];
    assert.ok(Math.abs(g1.coinScale - g0.coinScale) < 0.3, 'the coin transform is continuous across the cut (no reset)');
    assert.ok(Math.abs(g1.props.coin!.min[1] - g0.props.coin!.min[1]) < 1e-6, 'fixed base across the cut');
  }
  for (const s of segs) {
    for (const r of everyFrame(s)) { assert.equal(r.accepted, true, `${s.id}: ${r.rejectionReasons.join('; ')}`); assert.ok(r.diagnostics.propScreenSize.coin >= 0.2); }
    const sc = scales.slice(s.frames[0] - segs[0].frames[0], s.frames[1] - segs[0].frames[0]);
    assert.ok(Math.max(...sc) / Math.min(...sc) <= I.GROWTH_STAGE_RATIO + 1e-9, 'each stage spans at most the stage ratio');
  }
  assert.notEqual(segs[0].camera!.id, segs[1].camera!.id);
});

test('22. Zapp reacts first, then a giant-coin insert, inside the same narration interval', () => {
  const pat = T.coveragePatterns.find((q) => q.pattern === 'reaction_then_insert')!;
  assert.equal(pat.outcome, 'accepted');
  const [a, b] = pat.segments.map((id) => shot(id)!);
  assert.equal(a.chunkId, b.chunkId); assert.equal(a.frames[1], b.frames[0]);
  assert.equal(a.spec.active, 'zapp'); assert.ok(!a.spec.optional.includes('zapp'), 'Zapp face required in the reaction');
  assert.deepEqual(a.spec.heroProps, [], 'the coin is not required in the reaction');
  assert.ok(b.spec.heroProps.includes('coin') && b.spec.intent === 'scale_reveal');
  assert.ok(!I.cameraScene(RUN.geos[b.frames[0]], b.spec, W, H, undefined).subjectIds.includes('kira'), 'Kira excluded from the insert');
  for (const r of everyFrame(a)) { assert.equal(r.accepted, true); assert.ok(r.faceVisibility.zapp >= 0.8); }
  for (const r of everyFrame(b)) { assert.equal(r.accepted, true); assert.ok(!(r.diagnostics.faceOccluders.zapp ?? []).includes('prop:coin')); }
  assert.notEqual(JSON.stringify(a.camera!.position), JSON.stringify(b.camera!.position), 'no repeated identical framing');
});

test('23. an intentional neutral top-down insert may reset geography; ordinary shots may not ignore screen direction', () => {
  const k = character('kira', 1.4, 0), z = character('zapp', -1.4, 0);
  const btn: CameraObstacle = { entityId: 'button', type: 'prop', bounds: box(-0.15, 0.76, 2.0, 0.15, 0.9, 2.2) };
  // the previous shot was on the far ('right') side of the Zapp-Kira axis; the button sits on the near side
  const sd = { actors: [{ id: 'zapp', position: [-1.4, 0, 0] as Vec3 }, { id: 'kira', position: [1.4, 0, 0] as Vec3 }], previousCameraSide: 'right' as const };
  const sc = scene([...k.obstacles, ...z.obstacles, btn], [k.meta, z.meta, { entityId: 'button', kind: 'prop', bounds: btn.bounds }], { subjectIds: [], heroPropIds: ['button'], screenDirection: sd });
  const behind: Vec3 = [0.05, 1.9, 1.35];
  const ordinary = evaluateCameraCandidate(sc, cand('prop_behind', 'prop', behind, [0, 0.83, 2.1], { requiresHeroProp: true }));
  assert.ok(ordinary.rejectionReasons.some((x) => x.startsWith('SCREEN_DIRECTION_REVERSED')), `ordinary insert from the far side: ${ordinary.screenDirectionResult}`);
  const insert = cand('top_down', 'neutral_top_down_prop_insert', behind, [0, 0.83, 2.1], { requiresHeroProp: true });
  const r = evaluateCameraCandidate(sc, insert);
  assert.equal(r.accepted, true, r.rejectionReasons.join('; '));
  assert.equal(r.screenDirectionResult, 'neutral_insert');
  const next = nextScreenDirectionState(sc, insert)!;
  assert.equal(next.previousWasNeutral, true, 'geography reset for the next shot');
  assert.equal(next.previousCameraSide, 'right', 'the insert does not claim a side');
  const shallow = evaluateCameraCandidate(sc, { ...insert, transform: { position: [0.05, 1.1, 0.6] } });
  assert.ok(shallow.rejectionReasons.some((x) => x.startsWith('INSERT_NOT_TOP_DOWN')), 'the neutral classification requires a steep top-down view');
  const zNear = character('zapp', 0.55, 2.1);
  const sc2 = scene([...zNear.obstacles, btn], [zNear.meta, { entityId: 'button', kind: 'prop', bounds: btn.bounds }], { subjectIds: [], heroPropIds: ['button'] });
  const wide = evaluateCameraCandidate(sc2, { ...insert, transform: { position: [0.05, 2.5, 2.3] }, fov: 70 });
  assert.ok(wide.rejectionReasons.some((x) => x.startsWith('INSERT_SHOWS_ACTOR:zapp')), 'no actor may enter a neutral insert: ' + wide.rejectionReasons.join('; '));
  // in the episode: the reset insert frames only the button (reset point visible, Kira's legs out of frame)
  const s = T.shots.find((x) => x.spec.intent === 'neutral_top_down_prop_insert')!;
  assert.equal(s.screenDirection, 'neutral_insert');
  for (const q of everyFrame(s)) { assert.equal(q.accepted, true, q.rejectionReasons.join('; ')); assert.ok(q.propVisibility.button >= 0.6); }
  const nx = T.shots[T.shots.indexOf(s) + 1];
  assert.match(nx.screenDirection, /^reset_after_neutral|^established|^consistent/);
});

test('24. final consequence: prone-Zapp close/medium, then an elevated consequence shot (Kira not required)', () => {
  const pat = T.coveragePatterns.find((q) => q.pattern === 'consequence_sequence')!;
  assert.equal(pat.outcome, 'accepted');
  const [a, b] = pat.segments.map((id) => shot(id)!);
  assert.equal(b.frames[1], N, 'the consequence ends the episode');
  assert.deepEqual(a.spec.propEdge, ['coin']);
  assert.equal(b.camera!.intent, 'elevated_consequence');
  for (const r of everyFrame(a)) { assert.equal(r.accepted, true, r.rejectionReasons.join('; ')); assert.equal(RUN.geos[a.frames[0]].actors.zapp.posture, 'prone'); }
  for (const r of everyFrame(b)) { assert.equal(r.accepted, true, r.rejectionReasons.join('; ')); assert.ok(r.propVisibility.coin >= 0.6); }
  for (const q of [a, b]) assert.ok(!q.spec.subjects.filter((x) => !q.spec.optional.includes(x)).includes('kira'));
  assert.ok(b.camera!.position[1] < 3.95, 'below the ceiling');
  const pitch = Math.atan2(b.camera!.position[1] - b.camera!.target[1], Math.hypot(b.camera!.position[0] - b.camera!.target[0], b.camera!.position[2] - b.camera!.target[2])) * 180 / Math.PI;
  assert.ok(pitch >= 20, `elevated (${pitch.toFixed(1)} deg)`);
});

test('25. the repaired plan passes every gate with every frame covered', () => {
  assert.equal(A.summary.passed, A.summary.total, A.summary.failed.join(', '));
  assert.equal(A.frameCoverage.evaluated, N); assert.equal(A.frameCoverage.passing, N);
  assert.equal(T.shots.filter((x) => !x.camera).length, 0);
  assert.equal(A.world.coinZappClearance.minM >= 0.02, true);
  assert.equal(A.world.contact.count, 1);
});

// ───────── Draft V3 targeted fix (s015 insert -> s016a far-side speaker OTS; beat b04 head-edge rule) ─────────
const V3 = (id: string) => T.shots.find((x) => x.id === id)!;
const framesOf = (s: (typeof T.shots)[number]) => Array.from({ length: s.frames[1] - s.frames[0] }, (_, k) => s.frames[0] + k);
const evalAt = (s: (typeof T.shots)[number], i: number) => evaluateCameraCandidate(I.cameraScene(RUN.geos[i], s.spec, W, H, undefined), I.cameraForFrame(s, i));
const ownerAt = (i: number) => T.shots.find((x) => i >= x.frames[0] && i < x.frames[1])!;
/** the chunk's caption keeps every printed hero-prop label (and the interaction point) clear, on every frame */
function captionClearOfLabel(s: (typeof T.shots)[number], prop: string) {
  for (const i of framesOf(s)) assert.ok(I.occupiedRegions(RUN.geos[i], s.spec, I.cameraForFrame(s, i), W, H).some((o) => o.entityId === `label:${prop}`), `${s.id} frame ${i}: ${prop} label projected as a hard caption exclusion`);
  const pl = T.captionPlacements.find((q) => q.chunkId === s.chunkId)!;
  assert.deepEqual(pl.violations, [], `${s.chunkId} caption violations`);
  assert.equal(pl.overlap.interaction_clearance_hit, 0, `${s.chunkId}: caption touches the label / interaction clearance`);
  assert.equal(pl.overlap.interaction_max, 0, `${s.chunkId}: caption overlaps the label`);
}

test('V3-1. regression: the exact V2 s016a camera fails FACE_SELF_OCCLUDED during the head shake', () => {
  const s = V3('s016a');
  const v2: CameraCandidate = { id: 'v2:s016a:speaker_ots:s-1:u0.35:o1.15:b0.15:close0.36', intent: 'offset_elevated_speaker_ots', transform: { position: [0.075, 2.0159, 0.8484] }, target: [1.2581, 1.676, -0.4061], fov: 61, activeSubjectId: 'kira', requiresHeroProp: false, profileScale: 'close', eyelineTargetId: 'eyeline:kira', foregroundSubjectId: 'zapp' };
  assert.deepEqual(s.frames, [779, 807], 'V2 s016a frame range');
  const hits = framesOf(s).filter((i) => evaluateCameraCandidate(I.cameraScene(RUN.geos[i], s.spec, W, H, undefined), v2).rejectionReasons.some((r) => r.startsWith('FACE_SELF_OCCLUDED:kira')));
  assert.ok(hits.length > 0, 'the V2 camera must be rejected for Kira hiding her own face');
});

test('V3-2. s016a: Kira face readable on every frame of the head shake, never self-occluded (measured)', (t) => {
  const s = V3('s016a');
  assert.equal(s.camera!.intent, 'offset_elevated_speaker_ots');
  const [a0, a1] = CAMERA_SAFETY_DEFAULTS.speakerOtsAngleDeg;
  let full = 0, maxOff = 0, run = 0, longest = 0;
  const self = new Set<string>();
  for (const i of framesOf(s)) {
    const r = evalAt(s, i), c = I.cameraForFrame(s, i), f = RUN.geos[i].actors.kira.face;
    const n = Math.hypot(f.normal[0], f.normal[2]) || 1, tc = [c.transform.position[0] - f.center[0], c.transform.position[2] - f.center[2]], tl = Math.hypot(tc[0], tc[1]) || 1;
    const off = (Math.acos(Math.max(-1, Math.min(1, (f.normal[0] / n) * (tc[0] / tl) + (f.normal[2] / n) * (tc[1] / tl)))) * 180) / Math.PI;
    maxOff = Math.max(maxOff, off);
    for (const x of r.diagnostics.selfOccludedFeatures) self.add(x);
    const atStandard = r.accepted && r.faceVisibility.kira >= CAMERA_SAFETY_DEFAULTS.minFaceVisibility && r.diagnostics.eyesVisible.kira >= 2 && r.diagnostics.mouthVisible.kira && r.diagnostics.selfOccludedFeatures.length === 0 && off >= a0 && off <= a1;
    if (atStandard) { full++; run = 0; } else { run++; longest = Math.max(longest, run); }
  }
  const n = s.frames[1] - s.frames[0];
  t.diagnostic(`s016a ${s.camera!.id}: ${full}/${n} frames (${((100 * full) / n).toFixed(1)}%) at the full face standard; max off-face ${maxOff.toFixed(1)} deg; longest turned-away run ${longest} frames; self-occluded features: ${[...self].join(',') || 'none'}`);
  assert.equal(full, n, 'every frame at the full face standard');
  assert.equal(self.size, 0, 'no self-occluded facial feature');
  assert.ok(maxOff <= a1, `max off-face ${maxOff.toFixed(1)} deg`);
});

test('V3-3. s015 is a neutral top-down button insert: no actor in frame, caption clear of the FREE COINS label', () => {
  const s = V3('s015');
  assert.equal(s.spec.intent, 'neutral_top_down_prop_insert');
  assert.deepEqual(s.spec.heroProps, ['button']);
  assert.equal(s.screenDirection, 'neutral_insert');
  for (const i of framesOf(s)) {
    const r = evalAt(s, i);
    assert.equal(r.accepted, true, r.rejectionReasons.join('; '));
    for (const id of Object.keys(RUN.geos[i].actors)) assert.equal(r.diagnostics.entityCoverage[id] ?? 0, 0, `frame ${i}: ${id} in frame`);
  }
  captionClearOfLabel(s, 'button');
});

test('V3-4. screen direction: s015 neutral insert -> s016a reset_after_neutral -> s016b on-axis -> s017 reset; no reversal anywhere', () => {
  assert.ok(V3('s016a').screenDirection.startsWith('reset_after_neutral'), V3('s016a').screenDirection);
  assert.equal(V3('s016b').screenDirection, 'neutral');
  assert.ok(V3('s017').screenDirection.startsWith('reset_after_neutral'), V3('s017').screenDirection);
  assert.equal(V3('s024g1').screenDirection, 'neutral');
  assert.deepEqual(T.shots.filter((x) => x.screenDirection.startsWith('reversed')).map((x) => x.id), []);
  assert.equal(A.camera.screenDirectionViolations, 0);
});

test('V3-5. beat b04 (s010-s012) and s026: no partial head at the frame edge; b04 partner head inside the safe margin or out (body <= 3%)', () => {
  const known = new Set(T.knownIssues.map((k) => k.shot));
  for (const id of ['s010', 's011', 's012']) {
    const s = V3(id);
    assert.equal(s.spec.active, 'kira'); assert.ok(s.spec.optional.includes('zapp'), 'Zapp optional');
    if (known.has(id)) continue;
    assert.deepEqual(s.partialHeads, [], `${id} partial heads`);
    assert.equal(s.camera!.eval.partialHeadsBlocking, true); assert.deepEqual(s.camera!.eval.excludedSubjectIds, ['zapp']);
    for (const i of framesOf(s)) {
      const r = evalAt(s, i);
      assert.equal(r.accepted, true, `${id} frame ${i}: ${r.rejectionReasons.join('; ')}`);
      assert.deepEqual(r.diagnostics.partialHeads, []);
      assert.ok(!r.rejectionReasons.some((x) => x.startsWith('EXCLUDED_ACTOR_IN_FRAME')));
    }
  }
  assert.equal(V3('s011').spec.intent, 'reaction', 's011 stays a Kira reaction');
  assert.ok(EXCLUDED_ACTOR_MAX_BODY_COVERAGE <= 0.03);
  assert.deepEqual(V3('s026').partialHeads, [], 's026 partial heads');
  for (const i of framesOf(V3('s026'))) assert.deepEqual(evalAt(V3('s026'), i).diagnostics.partialHeads, []);
});

test('V3-6. the whole coin stays framed 44.22-49.5 s (coin scale passage)', () => {
  for (let i = V3('s026').frames[0]; i <= Math.floor(49.5 * RUN.plan.fps); i++) {
    const s = ownerAt(i), c = I.cameraForFrame(s, i), rim = RUN.geos[i].coinIdentity!.rim;
    const out = rim.filter((p) => { const q = projectToScreen(c, p, W / H); return !(q.z > 0 && q.x >= 0 && q.x <= 1 && q.y >= 0 && q.y <= 1); });
    assert.equal(out.length, 0, `frame ${i} (${s.id}): ${out.length}/${rim.length} coin rim points outside the frame`);
  }
});

test('V3-7. Kira stays at her safe mark and in frame 51.5-54.7 s', () => {
  const mark = RUN.plan.assets.marks.kira_safe.pos;
  for (let i = Math.ceil(51.5 * RUN.plan.fps); i <= Math.floor(54.7 * RUN.plan.fps); i++) {
    const k = RUN.geos[i].actors.kira.root, s = ownerAt(i);
    assert.ok(Math.hypot(k[0] - mark[0], k[2] - mark[2]) <= 0.02, `frame ${i}: Kira off her safe mark`);
    assert.ok((evalAt(s, i).diagnostics.entityCoverage.kira ?? 0) > 0, `frame ${i} (${s.id}): Kira not in frame`);
  }
});

test('V3-8. flattened result: the coin and prone Zapp are framed on every result frame', () => {
  const res = T.shots.filter((x) => x.spec.reason.startsWith('flattened result'));
  assert.ok(res.length >= 2, 'result 1/2 and 2/2');
  for (const s of res) for (const i of framesOf(s)) {
    const r = evalAt(s, i);
    assert.equal(r.accepted, true, `${s.id} frame ${i}: ${r.rejectionReasons.join('; ')}`);
    assert.equal(RUN.geos[i].actors.zapp.posture, 'prone');
    assert.ok((r.diagnostics.entityCoverage.zapp ?? 0) > 0 && (r.diagnostics.entityCoverage.coin ?? 0) > 0, `${s.id} frame ${i}: coin + Zapp in frame`);
  }
});

test('V3-9. button reset insert: the caption does not overlap the FREE COINS label', () => {
  const s = T.shots.find((x) => x.spec.intent === 'neutral_top_down_prop_insert' && x.spec.reason.startsWith('button reset'))!;
  assert.ok(s, 'reset insert present');
  captionClearOfLabel(s, 'button');
});
