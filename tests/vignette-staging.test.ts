import { test } from 'node:test';
import assert from 'node:assert/strict';

const { loadLibrary } = await import('../apps/render-worker/lib/library.ts');
const { stageBeatSheet } = await import('../packages/vignette/src/stage.ts');
const { planPath, segmentHits, BODY_RADIUS } = await import('../packages/vignette/src/path.ts');

const lib = loadLibrary();
const cast = (characterId: string, placement: string, actionId = 'idle', lookAt?: string) => ({
  characterId, role: characterId === 'zapp' ? 'lead' : 'foil', placement, actionId, expressionId: 'neutral', ...(lookAt ? { lookAt } : {}),
});
const beat = (phraseId: string, start: number, end: number, setId: string, members: any[], props: any[] = [], carryOver: string[] = []) => ({
  phraseId, start, end, text: phraseId, setId, lighting: setId === 'classroom' ? 'morning' : 'day', cast: members, props, events: [],
  camera: { recipeId: 'wide_environment', subject: members[0]?.characterId ?? 'zapp' }, captions: [], carryOver,
});
const sheet = (beats: any[]) => ({
  schemaVersion: '1.0', id: 'staging-test', title: 'staging test', seed: 17, source: { narrated: 'test', narratedId: 'test' }, music: [], beats,
}) as any;

test('set layouts retain semantic placement capabilities', () => {
  const plan = stageBeatSheet(sheet([
    beat('p1', 0, 3, 'playground', [cast('zapp', 'play_center')], [{ propId: 'ball', placement: 'sandpit', state: 'idle' }]),
    beat('p2', 3, 6, 'classroom', [cast('zapp', 'zapp_desk')], [{ propId: 'suspicious_button', placement: 'button_desk', state: 'idle' }]),
  ]), lib);
  const playground = plan.sets.find((s) => s.id === 'playground')!;
  assert.deepEqual(playground.marks.sandpit.capabilities, ['prop']);
  assert.ok(playground.marks.slide.capabilities.includes('actor-standing'));
  assert.ok(playground.marks.swings.capabilities.includes('actor-seated'));
  assert.deepEqual(playground.marks.sandpit_center.capabilities, ['camera-look-only']);
  const classroom = plan.sets.find((s) => s.id === 'classroom')!;
  assert.ok(classroom.marks.button_desk.capabilities.includes('interaction'));
});

test('prop-only playground requests deterministically fall back to routable actor marks', () => {
  const input = sheet([
    beat('p1', 0, 4, 'playground', [cast('zapp', 'play_center')]),
    beat('p2', 4, 10, 'playground', [cast('zapp', 'sandpit', 'walk')], [], ['zapp']),
  ]);
  const a = stageBeatSheet(input, lib), b = stageBeatSheet(input, lib);
  assert.equal(a.issues.some((x) => x.code === 'PATH_BLOCKED'), false, JSON.stringify(a.issues));
  assert.equal(a.world.errors.length, 0, JSON.stringify(a.world.errors));
  assert.ok(a.issues.some((x) => x.code === 'ACTOR_MARK_FALLBACK' && x.message.includes('sandpit')));
  const last = a.world.actors.zapp.segs.at(-1)!;
  assert.notEqual(last.endMark, 'sandpit');
  assert.deepEqual(a.world.actors.zapp.segs, b.world.actors.zapp.segs);
});

test('blocked paths never return a collider-crossing direct fallback', () => {
  const plan = stageBeatSheet(sheet([beat('p1', 0, 4, 'playground', [cast('zapp', 'play_center')])]), lib);
  const set = plan.sets[0], from = set.marks.play_center.pos, enclosed = set.marks.sandpit.pos;
  const route = planPath(from, enclosed, set.obstacles, set.walk);
  assert.ok(route.blockedBy?.includes('sandpit_edge'));
  assert.deepEqual(route.pts, [from]);

  const open = planPath(set.marks.play_center.pos, set.marks.playground_path.pos, set.obstacles, set.walk);
  assert.equal(open.blockedBy, null);
  for (let i = 1; i < open.pts.length; i++) for (const o of set.obstacles) {
    const inflated = { ...o, x0: o.x0 - BODY_RADIUS, x1: o.x1 + BODY_RADIUS, z0: o.z0 - BODY_RADIUS, z1: o.z1 + BODY_RADIUS };
    assert.equal(segmentHits(inflated, open.pts[i - 1][0], open.pts[i - 1][2], open.pts[i][0], open.pts[i][2]), false, `${o.id} intersects segment ${i}`);
  }
});

test('overlapping actor requests use distinct actor marks, never prop or hazard-only marks', () => {
  const plan = stageBeatSheet(sheet([beat('p1', 0, 5, 'playground', [cast('zapp', 'play_center'), cast('kira', 'play_center')])]), lib);
  const marks = ['zapp', 'kira'].map((id) => plan.world.actors[id].segs[0].endMark!);
  assert.equal(new Set(marks).size, 2);
  for (const id of marks) assert.ok(plan.sets[0].marks[id].capabilities.includes('actor-standing'), id);
  assert.equal(plan.issues.some((x) => x.code === 'ACTOR_OVERLAP'), false, JSON.stringify(plan.issues));
});

test('prone actors get an explicit deterministic posture transition before moving', () => {
  const input = sheet([
    beat('p1', 0, 3, 'playground', [cast('zapp', 'play_center', 'fall')]),
    beat('p2', 3, 9, 'playground', [cast('zapp', 'playground_path', 'walk')], [], ['zapp']),
  ]);
  const a = stageBeatSheet(input, lib), b = stageBeatSheet(input, lib);
  const getUp = a.world.actors.zapp.segs.find((s) => s.action === 'get_up');
  assert.ok(getUp);
  assert.equal(getUp!.posture, 'prone');
  assert.equal(getUp!.endPosture, 'standing');
  assert.ok(a.world.actors.zapp.segs.some((s) => s.kind === 'path' && s.t0 >= getUp!.t1));
  assert.equal(a.issues.some((x) => x.code === 'GET_UP_UNAVAILABLE' || x.code === 'PRONE_RESET_AT_CUT'), false);
  assert.deepEqual(a.world.actors.zapp.segs, b.world.actors.zapp.segs);
});

test('press requires an available control on an interaction mark before contracts are scheduled', () => {
  const missing = stageBeatSheet(sheet([beat('p1', 0, 4, 'classroom', [cast('zapp', 'zapp_desk', 'press_button')])]), lib);
  assert.equal(missing.issues.filter((x) => x.code === 'PRESS_NO_BUTTON').length, 1);
  assert.equal(missing.world.instances.some((x) => x.contract === 'press_button'), false);

  const available = stageBeatSheet(sheet([beat('p1', 0, 5, 'classroom', [cast('zapp', 'zapp_desk', 'press_button')], [
    { propId: 'suspicious_button', placement: 'button_desk', state: 'idle' },
  ])]), lib);
  assert.equal(available.issues.some((x) => x.code === 'PRESS_NO_BUTTON'), false, JSON.stringify(available.issues));
  assert.ok(available.world.instances.some((x) => x.contract === 'press_button'));
});

test('generic prop looks use the dynamic prop target and prop cuts are always reported', () => {
  const plan = stageBeatSheet(sheet([
    beat('p1', 0, 4, 'playground', [cast('zapp', 'play_center', 'look_at', 'ball')], [{ propId: 'ball', instanceId: 'ball', placement: 'sandpit', state: 'idle' }]),
    beat('p2', 4, 8, 'playground', [cast('zapp', 'play_center', 'look_at', 'ball')], [{ propId: 'ball', instanceId: 'ball', placement: 'playground_path', state: 'idle' }], ['zapp']),
  ]), lib);
  assert.ok(plan.issues.some((x) => x.code === 'DYNAMIC_PROP_LOOK_TARGET'));
  assert.equal(plan.issues.some((x) => x.code === 'LOOK_TARGET_BODY_ONLY'), false);
  assert.ok(plan.issues.some((x) => x.code === 'PROP_CUT_PLACEMENT'));
});

test('catalog-constrained routing stress corpus clears at least 90 percent without staging errors', () => {
  const cases = [
    ['playground', 'play_center', 'slide'], ['playground', 'play_center', 'swings'], ['playground', 'play_center', 'bench'],
    ['playground', 'play_center', 'playground_path'], ['playground', 'play_center', 'sandpit'],
    ['school_hallway', 'hall_center', 'lockers'], ['school_hallway', 'hall_center', 'water_fountain'],
    ['classroom', 'center_stage', 'zapp_desk'], ['classroom', 'center_stage', 'kira_safe'], ['classroom', 'center_stage', 'button_desk'],
  ] as const;
  let clean = 0;
  for (const [setId, from, requested] of cases) {
    const input = sheet([
      beat('p1', 0, 4, setId, [cast('zapp', from)]),
      beat('p2', 4, 12, setId, [cast('zapp', requested, 'walk')], [], ['zapp']),
    ]);
    const a = stageBeatSheet(input, lib), b = stageBeatSheet(input, lib);
    const errors = a.issues.filter((x) => x.severity === 'error');
    if (!errors.length && !a.world.errors.length) clean++;
    const effective = a.world.actors.zapp.segs.at(-1)!.endMark!;
    const mark = a.sets[0].marks[effective];
    assert.ok(mark.capabilities.includes('actor-standing'), `${setId}:${requested} assigned ${effective}`);
    assert.ok(!(mark.capabilities.includes('prop') && !mark.capabilities.includes('actor-standing')), `${setId}:${requested} used prop-only ${effective}`);
    assert.deepEqual(a.world.actors.zapp.segs, b.world.actors.zapp.segs, `${setId}:${requested} path/posture drift`);
  }
  assert.equal(clean, cases.length, `${clean}/${cases.length} stress cases were error-free (minimum 90%)`);
});