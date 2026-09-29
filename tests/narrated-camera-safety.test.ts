// Narrated Continuity Checkpoint 2 — camera safety & framing. Pure geometry on mocked scene snapshots:
// no engine renderer, browser, FFmpeg or video.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Vec3 } from '../packages/engine/src/math.ts';
import {
  evaluateCameraCandidate, selectSafeCamera, requireSafeCamera, projectToScreen, nextScreenDirectionState,
  type Bounds3, type CameraCandidate, type CameraObstacle, type CameraSafetyScene, type ProjectedEntity,
} from '../packages/engine/src/camera-safety.ts';

// ───────── mocked geometry (metres; y up, audience at +z) ─────────
const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Bounds3 => ({ min: [x0, y0, z0], max: [x1, y1, z1] });
const n3 = (v: Vec3): Vec3 => { const l = Math.hypot(...v); return [v[0] / l, v[1] / l, v[2] / l]; };

/** blocky character: body 0.6×1.3×0.4, head 0.32 cube on top, hair cap on top/back relative to facing */
function character(id: string, x: number, z: number, facing: Vec3 = [0, 0, 1]) {
  const f = n3(facing);
  const bx = Math.round(-f[0] * 0.05 * 1e6) / 1e6, bz = Math.round(-f[2] * 0.05 * 1e6) / 1e6; // hair shifted to the back of the head
  const obstacles: CameraObstacle[] = [
    { entityId: id, type: 'body', bounds: box(x - 0.3, 0, z - 0.2, x + 0.3, 1.3, z + 0.2) },
    { entityId: id, type: 'head', bounds: box(x - 0.16, 1.3, z - 0.16, x + 0.16, 1.62, z + 0.16) },
    { entityId: id, type: 'hair', bounds: box(x - 0.17 + bx, 1.56, z - 0.17 + bz, x + 0.17 + bx, 1.68, z + 0.17 + bz) },
  ];
  const meta: ProjectedEntity = { entityId: id, kind: 'character', facing: f };
  return { obstacles, meta };
}
const ENV: CameraObstacle[] = [
  { entityId: 'floor', type: 'environment', bounds: box(-8, -0.1, -4, 8, 0, 12) },
  { entityId: 'back_wall', type: 'environment', bounds: box(-8, 0, -3.2, 8, 3.2, -3) },
];
const DESK: CameraObstacle = { entityId: 'student_desk', type: 'prop', bounds: box(-0.45, 0, 0.7, 0.45, 0.72, 1.1) };
const COIN: CameraObstacle = { entityId: 'spark_coin', type: 'prop', bounds: box(-0.12, 0.72, 0.86, 0.12, 0.96, 0.92) };

function classroom(extra: CameraObstacle[] = [], over: Partial<CameraSafetyScene> = {}): CameraSafetyScene {
  const k = character('kira', -0.6, 0), z = character('zapp', 0.6, 0);
  return {
    frameWidth: 1080, frameHeight: 1920,
    subjectIds: ['kira', 'zapp'], heroPropIds: ['spark_coin'],
    obstacles: [...ENV, ...k.obstacles, ...z.obstacles, DESK, COIN, ...extra],
    projectedEntities: [k.meta, z.meta, { entityId: 'spark_coin', kind: 'prop', interactionPoint: [0, 0.95, 0.89] }],
    ...over,
  };
}
const cand = (id: string, intent: CameraCandidate['intent'], position: Vec3, target: Vec3, more: Partial<CameraCandidate> = {}): CameraCandidate =>
  ({ id, intent, fov: 38, transform: { position }, target, ...more });
const has = (reasons: string[], code: string) => reasons.some((r) => r === code || r.startsWith(code + ':'));
const hasPrefix = (reasons: string[], prefix: string) => reasons.some((r) => r.startsWith(prefix));

const FRONTAL_KIRA = cand('frontal_kira', 'medium', [-0.6, 1.31, 2.1], [-0.6, 1.08, 0]);
const PROP_INSERT = cand('coin_insert', 'prop', [0, 1.2, 1.6], [0, 0.84, 0.89]);

// Face-to-face three-quarter pair for OTS (kira at left facing right+audience, zapp mirrored). No desk/coin.
function facingPair(): CameraSafetyScene {
  const k = character('kira', -0.7, 0, [1, 0, 1]), z = character('zapp', 0.7, 0, [-1, 0, 1]);
  return { frameWidth: 1080, frameHeight: 1920, subjectIds: ['kira', 'zapp'], activeSubjectId: 'zapp', heroPropIds: [], obstacles: [...ENV, ...k.obstacles, ...z.obstacles], projectedEntities: [k.meta, z.meta] };
}
const kiraHead: Vec3 = [-0.7, 1.46, 0];
/** on the zapp→kira sight line, `d` m behind kira's head, slightly toward the audience (classic OTS placement) */
const behindKira = (d: number, up: number): Vec3 => [kiraHead[0] - d, kiraHead[1] + up, 0.1];

// ───────── collision ─────────

test('1. camera inside a head is rejected', () => {
  const r = evaluateCameraCandidate(classroom(), cand('in_head', 'medium', [-0.6, 1.46, 0], [-0.6, 1.46, 2]));
  assert.equal(r.accepted, false);
  assert.ok(has(r.rejectionReasons, 'LENS_COLLISION:head:kira'), r.rejectionReasons.join('\n'));
  assert.ok(r.lensClearance < 0);
});

test('2. camera inside hair is rejected', () => {
  const r = evaluateCameraCandidate(classroom(), cand('in_hair', 'medium', [-0.6, 1.66, -0.1], [0.6, 1.46, 2]));
  assert.equal(r.accepted, false);
  assert.ok(has(r.rejectionReasons, 'LENS_COLLISION:hair:kira'), r.rejectionReasons.join('\n'));
});

test('3. camera inside a prop is rejected', () => {
  const r = evaluateCameraCandidate(classroom(), cand('in_coin', 'prop', [0, 0.84, 0.89], [0, 0.84, 3]));
  assert.equal(r.accepted, false);
  assert.ok(has(r.rejectionReasons, 'LENS_COLLISION:prop:spark_coin'), r.rejectionReasons.join('\n'));
});

test('4. a camera move through geometry is rejected even when the first and last frames are clear', () => {
  const base = cand('truck', 'wide', [1.6, 1.46, 0], [0, 1.2, 0]);
  const still = evaluateCameraCandidate(classroom(), base);
  assert.ok(!hasPrefix(still.rejectionReasons, 'LENS_COLLISION') && !hasPrefix(still.rejectionReasons, 'CAMERA_PATH_COLLISION'));
  const moving = evaluateCameraCandidate(classroom(), { ...base, motion: { to: { position: [-1.6, 1.46, 0] } } });
  assert.equal(moving.accepted, false);
  assert.ok(has(moving.rejectionReasons, 'CAMERA_PATH_COLLISION:head:zapp'), moving.rejectionReasons.join('\n'));
  assert.ok(has(moving.rejectionReasons, 'CAMERA_PATH_COLLISION:head:kira'));
  assert.ok(!hasPrefix(moving.rejectionReasons, 'LENS_COLLISION'), 'first frame itself is clear');
  assert.ok(moving.diagnostics.pathSamples > 20 && moving.lensClearance < 0);
});

// ───────── occlusion ─────────

test('5. foreground hair filling the frame is rejected (lens 0.43–0.86 m from a head)', () => {
  const r = evaluateCameraCandidate(facingPair(), cand('ots_hair', 'over_shoulder', behindKira(0.5, 0.12), [0.7, 1.46, 0]));
  assert.equal(r.accepted, false, JSON.stringify(r));
  assert.ok(hasPrefix(r.rejectionReasons, 'LENS_TOO_CLOSE_TO_HEAD:kira'), r.rejectionReasons.join('\n'));
  assert.ok(hasPrefix(r.rejectionReasons, 'FOREGROUND_CLUTTER'), r.rejectionReasons.join('\n'));
  assert.ok(hasPrefix(r.rejectionReasons, 'OTS_FOREGROUND_OBSTRUCTION:kira'));
  assert.ok(r.foregroundCoverage > 0.5, `coverage ${r.foregroundCoverage}`);
  assert.ok(!hasPrefix(r.rejectionReasons, 'LENS_COLLISION'), 'not a collision: purely an obstruction');
  // metrics are still exposed on rejection
  assert.equal(typeof r.faceVisibility.zapp, 'number');
  for (const d of [0.43, 0.6, 0.86]) {
    const rr = evaluateCameraCandidate(facingPair(), cand(`ots_${d}`, 'over_shoulder', behindKira(d, 0.1), [0.7, 1.46, 0]));
    assert.equal(rr.accepted, false, `lens ${d} m from kira's head must be rejected`);
    assert.ok(hasPrefix(rr.rejectionReasons, 'LENS_TOO_CLOSE_TO_HEAD:kira'));
  }
});

test('6. foreground hoodie/arm filling the frame is rejected', () => {
  const r = evaluateCameraCandidate(facingPair(), cand('ots_hoodie', 'over_shoulder', behindKira(0.6, -0.35), [0.7, 1.46, 0]));
  assert.equal(r.accepted, false);
  assert.ok(hasPrefix(r.rejectionReasons, 'FOREGROUND_CLUTTER'), r.rejectionReasons.join('\n'));
  assert.ok(hasPrefix(r.rejectionReasons, 'OTS_FOREGROUND_OBSTRUCTION:kira'));
  assert.ok(!hasPrefix(r.rejectionReasons, 'LENS_COLLISION'), r.rejectionReasons.join('\n'));
  assert.ok(r.foregroundCoverage > 0.35);
});

test('7. a face below 80% visibility is rejected', () => {
  const sign: CameraObstacle = { entityId: 'hanging_sign', type: 'environment', bounds: box(-0.8, 1.3, 0.3, -0.61, 1.7, 0.35) };
  const r = evaluateCameraCandidate(classroom([sign]), FRONTAL_KIRA);
  assert.equal(r.faceVisibility.kira, 0.6);
  assert.ok(hasPrefix(r.rejectionReasons, 'FACE_VISIBILITY_LOW:kira'), r.rejectionReasons.join('\n'));
  assert.equal(r.accepted, false);
});

test('8. a hero prop below 60% visibility is rejected', () => {
  const pencils: CameraObstacle = { entityId: 'pencil_case', type: 'prop', bounds: box(-0.2, 0.72, 0.95, 0.01, 1.0, 1.0) };
  const r = evaluateCameraCandidate(classroom([pencils]), PROP_INSERT);
  assert.ok(r.propVisibility.spark_coin < 0.6, String(r.propVisibility.spark_coin));
  assert.ok(hasPrefix(r.rejectionReasons, 'HERO_PROP_VISIBILITY_LOW:spark_coin'), r.rejectionReasons.join('\n'));
  assert.equal(r.accepted, false);
});

test('9. a giant coin hiding Zapp\'s face is rejected', () => {
  const s = classroom();
  s.obstacles = s.obstacles.filter((o) => o.entityId !== 'spark_coin');
  s.obstacles.push({ entityId: 'spark_coin', type: 'prop', bounds: box(0.25, 1.15, 0.5, 0.95, 1.8, 0.56) });
  const c = cand('zapp_react', 'reaction', [0.6, 1.48, 1.0], [0.6, 1.41, 0], { activeSubjectId: 'zapp' });
  const r = evaluateCameraCandidate(s, c);
  assert.equal(r.accepted, false);
  assert.ok(hasPrefix(r.rejectionReasons, 'PROP_COVERS_FACE:zapp:spark_coin'), r.rejectionReasons.join('\n'));
  assert.ok(hasPrefix(r.rejectionReasons, 'FACE_VISIBILITY_LOW:zapp'));
  assert.equal(r.faceVisibility.zapp, 0);
  // explicit beat intent removes only the "prop over face" reason; visibility still fails
  const allowed = evaluateCameraCandidate(s, { ...c, allowPropOverFace: true });
  assert.ok(!hasPrefix(allowed.rejectionReasons, 'PROP_COVERS_FACE'));
  assert.equal(allowed.accepted, false);
});

// ───────── framing ─────────

test('10. a head crop in a non-ECU shot is rejected', () => {
  const r = evaluateCameraCandidate(classroom(), cand('chest', 'medium', [-0.6, 1.0, 1.2], [-0.6, 0.95, 0]));
  assert.equal(r.accepted, false);
  assert.ok(has(r.rejectionReasons, 'HEAD_CROPPED:kira'), r.rejectionReasons.join('\n'));
  assert.equal(r.diagnostics.headCropped.kira, true);
});

test('11. an intentional ECU may crop head/shoulders but preserves the face', () => {
  const ecu = cand('kira_ecu', 'extreme_close', [-0.6, 1.44, 0.75], [-0.6, 1.44, 0]);
  const r = evaluateCameraCandidate(classroom(), ecu);
  assert.equal(r.accepted, true, r.rejectionReasons.join('\n'));
  assert.equal(r.diagnostics.headCropped.kira, true, 'the ECU does crop');
  assert.equal(r.diagnostics.eyesVisible.kira, 2);
  assert.ok(r.faceVisibility.kira >= 0.8);
  assert.ok(r.lensClearance > 0);
  // the same framing is illegal as a normal close-up
  const close = evaluateCameraCandidate(classroom(), { ...ecu, id: 'kira_close', intent: 'close' });
  assert.equal(close.accepted, false);
  assert.ok(hasPrefix(close.rejectionReasons, 'LENS_TOO_CLOSE_TO_HEAD:kira'));
  // an ECU still may not enter the head
  const inside = evaluateCameraCandidate(classroom(), { ...ecu, id: 'ecu_in', transform: { position: [-0.6, 1.44, 0.2] } });
  assert.equal(inside.accepted, false);
  assert.ok(hasPrefix(inside.rejectionReasons, 'LENS_COLLISION:head:kira'), inside.rejectionReasons.join('\n'));
});

test('12. an empty wide with tiny subjects is rejected', () => {
  const r = evaluateCameraCandidate(classroom(), cand('empty_wide', 'wide', [0, 3, 20], [0, 0.8, 0], { fov: 50 }));
  assert.equal(r.accepted, false);
  assert.ok(hasPrefix(r.rejectionReasons, 'WIDE_SUBJECT_TOO_SMALL:kira'), r.rejectionReasons.join('\n'));
  assert.ok(hasPrefix(r.rejectionReasons, 'WIDE_EXCESSIVE_EMPTY_SPACE'));
});

test('13. a valid wide geography shot passes', () => {
  const r = evaluateCameraCandidate(classroom(), cand('wide', 'wide', [0, 2.2, 4.2], [0, 0.8, 0.4], { fov: 42 }));
  assert.equal(r.accepted, true, r.rejectionReasons.join('\n'));
  assert.ok(r.propVisibility.spark_coin > 0);
  assert.ok(r.diagnostics.subjectScreenHeight.kira >= 0.12 && r.diagnostics.subjectScreenHeight.zapp >= 0.12);
});

test('14. a valid frontal medium passes', () => {
  const r = evaluateCameraCandidate(classroom(), FRONTAL_KIRA);
  assert.equal(r.accepted, true, r.rejectionReasons.join('\n'));
  assert.equal(r.faceVisibility.kira, 1);
  assert.equal(r.foregroundCoverage, 0);
  assert.ok(r.lensClearance > 1 && r.score > 0.8, `score ${r.score}`);
});

test('15. a valid prop insert passes', () => {
  const r = evaluateCameraCandidate(classroom(), PROP_INSERT);
  assert.equal(r.accepted, true, r.rejectionReasons.join('\n'));
  assert.equal(r.propVisibility.spark_coin, 1);
  assert.ok(r.diagnostics.propScreenSize.spark_coin >= 0.2);
});

test('16. an unsafe OTS falls back to a safe two-character medium', () => {
  const s = facingPair();
  const sel = selectSafeCamera(s, [cand('ots_hair', 'over_shoulder', behindKira(0.55, 0.1), [0.7, 1.46, 0])]);
  assert.equal(sel.ok, true, !sel.ok ? sel.message : '');
  if (!sel.ok) return;
  assert.equal(sel.evaluations[0].result.accepted, false);
  assert.equal(sel.usedFallback, true);
  assert.equal(sel.fallback, 'two_character_medium');
  assert.equal(sel.result.accepted, true);
  assert.equal(sel.result.diagnostics.fallback, 'two_character_medium');
  assert.ok(sel.result.faceVisibility.zapp >= 0.8 && sel.result.faceVisibility.kira >= 0.8);
  assert.ok(sel.candidate.transform.position[2] > 0, 'audience side of the action line');
});

// ───────── screen direction ─────────

test('17. an unmotivated screen-direction reversal is rejected; neutral reset / on-camera crossing / disorientation allow it', () => {
  const sd = { actors: [{ id: 'kira', position: [-0.6, 0, 0] as Vec3 }, { id: 'zapp', position: [0.6, 0, 0] as Vec3 }] };
  const front = cand('front', 'wide', [0, 2.2, 4.2], [0, 0.8, 0.4], { fov: 42 });
  const first = evaluateCameraCandidate(classroom([], { screenDirection: sd }), front);
  assert.match(first.screenDirectionResult, /^established:left/);
  const next = nextScreenDirectionState(classroom([], { screenDirection: sd }), front)!;
  assert.equal(next.previousCameraSide, 'left');
  assert.deepEqual(next.previousOrdering, ['kira', 'zapp']);

  const reverse = cand('reverse', 'wide', [0, 2.2, -2.6], [0, 0.8, 0], { fov: 42 });
  const bad = evaluateCameraCandidate(classroom([], { screenDirection: next }), reverse);
  assert.match(bad.screenDirectionResult, /^reversed_unmotivated:left->right/);
  assert.ok(hasPrefix(bad.rejectionReasons, 'SCREEN_DIRECTION_REVERSED'));
  assert.equal(bad.accepted, false);

  const reset = evaluateCameraCandidate(classroom([], { screenDirection: { ...next, previousWasNeutral: true } }), reverse);
  assert.match(reset.screenDirectionResult, /^reset_after_neutral:right/);
  assert.ok(!hasPrefix(reset.rejectionReasons, 'SCREEN_DIRECTION_REVERSED'));

  const orbit = evaluateCameraCandidate(classroom([], { screenDirection: next }), { ...front, id: 'orbit', motion: { to: { position: [0, 2.2, -2.6] }, toTarget: [0, 0.8, 0] } });
  assert.match(orbit.screenDirectionResult, /^crossed_on_camera:left->right/);
  assert.ok(!hasPrefix(orbit.rejectionReasons, 'SCREEN_DIRECTION_REVERSED'));
  assert.ok(!hasPrefix(orbit.rejectionReasons, 'CAMERA_PATH_COLLISION'), orbit.rejectionReasons.join('\n'));

  const dis = evaluateCameraCandidate(classroom([], { screenDirection: next }), { ...reverse, disorientationIntended: true });
  assert.match(dis.screenDirectionResult, /^crossed_intended_disorientation/);

  const neutral = evaluateCameraCandidate(classroom([], { screenDirection: next }), cand('axis', 'wide', [4.5, 1.8, 0.2], [0, 1.0, 0], { fov: 42 }));
  assert.match(neutral.screenDirectionResult, /^neutral/);
  assert.equal(nextScreenDirectionState(classroom([], { screenDirection: next }), cand('axis', 'wide', [4.5, 1.8, 0.2], [0, 1.0, 0]))!.previousWasNeutral, true);
});

// ───────── implied seated ─────────

test('18. implied_seated produces waist-up framing behind the desk', () => {
  const k = character('kira', 0, 0);
  const desk: CameraObstacle = { entityId: 'kira_desk', type: 'prop', bounds: box(-0.5, 0, 0.3, 0.5, 0.78, 0.8) };
  const s: CameraSafetyScene = {
    frameWidth: 1080, frameHeight: 1920, subjectIds: ['kira'], heroPropIds: [],
    obstacles: [...ENV, ...k.obstacles, desk],
    projectedEntities: [{ ...k.meta, waistUpRequired: true, waistY: 0.75, behindEntityId: 'kira_desk' }],
  };
  const side = cand('side_full_body', 'medium', [2.5, 1.0, -0.3], [0, 0.9, 0]);
  const r = evaluateCameraCandidate(s, side);
  assert.ok(hasPrefix(r.rejectionReasons, 'WAIST_UP_REQUIRED_LEGS_VISIBLE:kira'), r.rejectionReasons.join('\n'));
  assert.ok(hasPrefix(r.rejectionReasons, 'NOT_FRAMED_BEHIND:kira:kira_desk'));

  const sel = selectSafeCamera(s, [side]);
  assert.equal(sel.ok, true, !sel.ok ? sel.message : '');
  if (!sel.ok) return;
  assert.equal(sel.fallback, 'frontal_medium');
  assert.ok(!hasPrefix(sel.result.rejectionReasons, 'WAIST_UP'));
  // the waist line at the actor's front sits below the frame bottom → waist-up framing; head fully in frame
  const waist = projectToScreen(sel.candidate, [0, 0.75, 0.2], 1080 / 1920);
  assert.ok(waist.y > 1, `waist at screen y ${waist.y}`);
  assert.equal(sel.result.diagnostics.headCropped.kira, false);
  assert.ok(sel.candidate.transform.position[2] > 0.8, 'camera on the desk side');
});

// ───────── selection ─────────

test('19. candidate choice is deterministic (order-independent, ties by id)', () => {
  const s = classroom();
  const list = [
    cand('b_medium', 'medium', [-0.6, 1.31, 2.1], [-0.6, 1.08, 0]),
    cand('a_medium', 'medium', [-0.6, 1.31, 2.1], [-0.6, 1.08, 0]),
    cand('c_wide', 'wide', [0, 2.2, 4.2], [0, 0.8, 0.4], { fov: 42 }),
    cand('d_in_head', 'medium', [-0.6, 1.46, 0], [-0.6, 1.46, 2]),
  ];
  const a = selectSafeCamera(s, list), b = selectSafeCamera(s, [...list].reverse()), c = selectSafeCamera(classroom(), list);
  assert.ok(a.ok && b.ok && c.ok);
  if (!a.ok || !b.ok || !c.ok) return;
  assert.equal(a.candidate.id, b.candidate.id);
  assert.deepEqual(a.result, b.result);
  assert.deepEqual(JSON.stringify(a), JSON.stringify(c));
  const med = a.evaluations.find((e) => e.candidate.id === 'a_medium')!.result.score;
  const wide = a.evaluations.find((e) => e.candidate.id === 'c_wide')!.result.score;
  assert.equal(a.candidate.id, med >= wide ? 'a_medium' : 'c_wide', 'highest score, ties broken by id');
  assert.equal(a.usedFallback, false);
});

test('20. no valid candidate and no valid fallback produces a blocking error', () => {
  const k = character('kira', 0, 0);
  const s: CameraSafetyScene = {
    frameWidth: 1080, frameHeight: 1920, subjectIds: ['kira'], heroPropIds: [],
    // a solid set piece fills the whole audience side: every candidate and fallback collides
    obstacles: [...ENV, ...k.obstacles, { entityId: 'set_wall', type: 'environment', bounds: box(-10, 0, 0.35, 10, 6, 12) }],
    projectedEntities: [k.meta],
  };
  const sel = selectSafeCamera(s, [cand('front', 'medium', [0, 1.31, 2.1], [0, 1.08, 0])]);
  assert.equal(sel.ok, false);
  if (sel.ok) return;
  assert.equal(sel.blocking, true);
  assert.equal(sel.code, 'CAMERA_SAFETY_BLOCKED');
  assert.ok(sel.fallbackEvaluations.length >= 3, 'fallbacks were attempted');
  assert.ok(sel.fallbackEvaluations.every((e) => !e.result.accepted && e.result.rejectionReasons.length > 0));
  assert.throws(() => requireSafeCamera(s, [cand('front', 'medium', [0, 1.31, 2.1], [0, 1.08, 0])]), /CAMERA_SAFETY_BLOCKED/);
});
