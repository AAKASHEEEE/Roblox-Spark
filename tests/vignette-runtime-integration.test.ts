// Cross-layer S3-S6 runtime integration: truthful registries, builder dispatch, S4/S5 compatibility, S3 mouths, and S6 staging.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

class TestCanvas {
  width: number; height: number;
  constructor(w: number, h: number) { this.width = w; this.height = h; }
  getContext() {
    return new Proxy<Record<string | symbol, unknown>>({}, {
      get(t, k) {
        if (k in t) return t[k];
        if (k === 'measureText') return () => ({ width: 1 });
        if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} });
        if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
        return () => undefined;
      },
      set(t, k, v) { t[k] = v; return true; },
    });
  }
}
(globalThis as unknown as { OffscreenCanvas: unknown }).OffscreenCanvas = TestCanvas;

const { ROOT } = await import('./helpers.ts');
const { loadLibrary } = await import('../apps/render-worker/lib/library.ts');
const { LIBRARY, checkLibrary, lookup } = await import('../packages/library/src/ids.ts');
const { registeredBuilder, unregisterBuilders } = await import('../packages/engine/src/build-dispatch.ts');
const { registerRuntimeLibrary } = await import('../packages/vignette/src/runtime-library.ts');
const { LIB_ACTIONS } = await import('../packages/engine/src/animation/lib/registry.ts');
const { CAMERA_RECIPES, PLANNED_RECIPES } = await import('../packages/vignette/src/camera-recipes.ts');
const { resolveAnchor } = await import('../packages/engine/src/animation/lib/anchors.ts');
const { propBuilder, anchorLocal, DOOR } = await import('../packages/engine/src/props/index.ts');
const { characterRecipes } = await import('../packages/engine/src/faces/recipes.ts');
const { buildCharacter } = await import('../packages/engine/src/build.ts');
const { S5_TO_S3_MOUTH, applyS3FaceFrame, s3MouthFrame } = await import('../packages/engine/src/faces/face-track-adapter.ts');
const { stageBeatSheet } = await import('../packages/vignette/src/stage.ts');
const { VignetteScene } = await import('../packages/vignette/src/scene.ts');
const { validateBeatSheet } = await import('../packages/director/src/beat-sheet.ts');
const { resolveAsset } = await import('../packages/vignette/src/resolve.ts');

const lib = loadLibrary();
const ctx = (def: any, u: number) => ({ lt: u * def.defaultDuration, d: def.defaultDuration, u, t: u * def.defaultDuration, seed: 5, params: {}, loco: { dist: 0, speed: 0, run: false, legLen: 0.8, total: 0 } });

test('S3-S6 registry entries are truthful only with real implementations and exact published versions', () => {
  assert.deepEqual(lib.errors, []);
  assert.deepEqual(checkLibrary(), []);
  unregisterBuilders();
  const count = registerRuntimeLibrary(lib);
  assert.equal(count.sets, 3);
  assert.equal(count.characters, Object.keys(lib.characters).length);
  assert.equal(count.props, Object.keys(lib.props).length);

  for (const e of LIBRARY.sets.filter((x) => x.status === 'available')) {
    const latest = e.versions?.[e.versions.length - 1];
    assert.ok(latest, e.id);
    assert.equal(registeredBuilder('set', `${e.id}@${latest}`)?.version, latest, `${e.id}@${latest}`);
    assert.match(e.source ?? '', /assets\/environments\/.*packages\/engine\/src\/sets\//);
  }
  for (const e of LIBRARY.characters) {
    assert.equal(e.status, 'available', e.id);
    assert.ok(e.versions?.every((v) => !!lib.characters[`${e.id}@${v}`]), e.id);
    for (const v of e.versions ?? []) assert.equal(registeredBuilder('character', `${e.id}@${v}`)?.version, v, `${e.id}@${v}`);
    assert.match(e.source ?? '', /assets\/characters\/.*packages\/engine\/src\/faces\/recipes\.ts/);
  }
  for (const e of LIBRARY.props) {
    assert.equal(e.status, 'available', e.id);
    assert.ok(e.versions?.every((v) => !!lib.props[`${e.id}@${v}`]), e.id);
    for (const v of e.versions ?? []) assert.equal(registeredBuilder('prop', `${e.id}@${v}`)?.version, v, `${e.id}@${v}`);
    assert.match(e.source ?? '', /assets\/props\/.*packages\/engine\/src\/props\/index\.ts/);
  }
  for (const e of LIBRARY.actions) {
    assert.equal(e.status, 'available', e.id);
    assert.equal(LIB_ACTIONS[e.id]?.version, e.versions?.[0], e.id);
    assert.match(e.source ?? '', /LIB_ACTIONS/);
  }
  for (const e of LIBRARY.expressions) {
    assert.equal(e.status, 'available', e.id);
    assert.deepEqual(e.versions, ['1.0.0']);
  }
  for (const e of LIBRARY.cameraRecipes) {
    assert.equal(e.status, 'available', e.id);
    assert.equal(CAMERA_RECIPES[e.id]?.version, e.versions?.[0], e.id);
  }
  assert.deepEqual(PLANNED_RECIPES, []);
  assert.equal(resolveAsset('props', 'door@9.9.9', lib).resolution, 'placeholder', 'an unknown exact version never drifts to the latest bare builder');
  // S7 remains deliberately unresolved; no S3-S6 status update masks it.
  for (const [kind, id] of [['music', 'bed_upbeat'], ['sfx', 'door_open'], ['vfx', 'emote_exclaim']] as const) assert.equal(lookup(kind, id)?.status, 'planned');
});

test('S5 prop roles and cues are compatible with the locked S4 rigs', () => {
  assert.equal(resolveAnchor(lib.props['door@1.1.0'], 'door_hinge'), 'hinge_axis');
  assert.equal(resolveAnchor(lib.props['phone@1.0.0'], 'screen'), 'screen_center');
  assert.equal(resolveAnchor(lib.props['laptop@1.0.0'], 'screen'), 'screen_center');
  assert.equal(resolveAnchor(lib.props['drink_cup@1.0.0'], 'lip'), 'mouth');

  const drink = LIB_ACTIONS.drink.props!(ctx(LIB_ACTIONS.drink, 0.5))!;
  assert.equal(drink.state, undefined, 'cup tilt is not an invented rig state');
  assert.ok(Math.abs(drink.orientation!.rotDeg[2]) > 20, 'cup tilt is placement orientation');
  const eat = LIB_ACTIONS.eat.props!(ctx(LIB_ACTIONS.eat, 0.5))!;
  assert.equal(eat.state?.name, 'slice');
  assert.ok(propBuilder(lib.props['pizza@1.0.0']).build('pizza', { seed: 1 }).states.includes(eat.state!.name));
});

test('door@1.1.0 clears adults and its grip follows the S4 hinge', () => {
  assert.ok(DOOR.openingH >= 2.9);
  assert.ok(DOOR.openingW >= 1.25);
  const adults = characterRecipes(lib.characters);
  for (const id of ['teacher', 'mom', 'dad']) {
    const rig = buildCharacter(adults[id].manifest);
    assert.ok(rig.dims.height < DOOR.openingH, `${id} height ${rig.dims.height}`);
    assert.ok(adults[id].manifest.body.torso[0] < DOOR.openingW, `${id} torso width`);
  }
  const b = propBuilder(lib.props['door@1.1.0']), rig = b.build('door', { seed: 1 });
  b.applyState(rig, 'closed', 1);
  const closed = anchorLocal(rig, 'grip');
  b.applyState(rig, 'open', 1);
  const open = anchorLocal(rig, 'grip');
  assert.ok(Math.hypot(open[0] - closed[0], open[2] - closed[2]) > 1, 'grip moves with leaf, not the root/frame');
});

test('S5 mouth vocabulary maps to S3 setFace with open amount preserved', () => {
  assert.deepEqual(S5_TO_S3_MOUTH, { closed: 'closed', small: 'open', open: 'open', wide: 'wide', round: 'o' });
  const amounts = { closed: 0, small: 0.2, open: 0.5, wide: 0.9, round: 0.7 } as const;
  const rig = buildCharacter(lib.characters['zapp@1.0.0']);
  for (const [shape, open] of Object.entries(amounts)) {
    const mapped = s3MouthFrame({ shape: shape as keyof typeof amounts, open });
    applyS3FaceFrame(rig, { expression: 'neutral', blink: 0, mouth: { shape: shape as keyof typeof amounts, open } });
    assert.ok(rig.face.material!.texture!.key.includes(`m=${mapped.shape}`), `${shape} -> ${mapped.shape}`);
  }
  assert.match(rig.face.material!.texture!.key, /m=o:a=0\.75$/, 'open amount is quantized into the S3 texture key');
});

test('merged S3-S6 fixture resolves builders and real actions/faces without placeholder labels', () => {
  registerRuntimeLibrary(lib);
  const sheet = JSON.parse(readFileSync(join(ROOT, 'packages/director/fixtures/free-coins-classroom.beats.json'), 'utf8'));
  const validation = validateBeatSheet(sheet);
  assert.ok(validation.ok);
  assert.ok(validation.planned.every((x) => lookup(x.kind, x.id)?.owner === 'S7'), JSON.stringify(validation.planned));
  const plan = stageBeatSheet(sheet, lib);
  assert.equal(plan.sets[0]?.key, 'classroom@1.2.0');
  assert.deepEqual(plan.sets[0]?.doors.classroom_door?.threshold, [2.5, 0, -3.95]);
  assert.deepEqual(plan.sets[0]?.marks.zapp_impact?.pos, [-2.1, 0, 1.2]);
  assert.deepEqual(plan.sets[0]?.marks.coin_spawn?.pos, [-2.1, 0, -1.4]);
  for (const c of Object.values(plan.characters)) assert.equal(c.resolution.resolution, 'available', c.id);
  for (const p of Object.values(plan.props)) assert.equal(p.resolution.resolution, 'available', p.instance);
  assert.deepEqual(plan.beats.flatMap((b) => b.cast.flatMap((c) => c.labels.filter((x) => /^(ACTION|FACE) /.test(x)))), []);

  const scene = new VignetteScene(plan, lib);
  for (const [id, source] of Object.entries(scene.sources)) {
    if (source.kind === 'character' || source.kind === 'prop') assert.equal(source.source, 'builder', id);
  }
  assert.ok(scene.props.get('door')?.built);
  scene.pose(2.35);
  assert.ok(Math.abs(scene.rigs.get('zapp')!.joints.hip_l.rot[0]) > 0.5, 'S5 LibraryTrack applies the real seated pose');
  assert.match(scene.rigs.get('zapp')!.face.material!.texture!.key, /m=closed/, 'narrator text does not flap an actor mouth');
  const closedGrip = scene.entityPoint('door.grip', plan.beats[0])!;
  scene.pose(2.65);
  const movingGrip = scene.entityPoint('door.grip', plan.beats[0])!;
  assert.ok(Math.hypot(movingGrip[0] - closedGrip[0], movingGrip[2] - closedGrip[2]) > 0.2, 'door event drives the real hinged grip');
  const names: string[] = [];
  const visit = (n: any) => { names.push(n.name); for (const c of n.children ?? []) visit(c); };
  visit(scene.root);
  assert.ok(!names.some((n) => n.includes('doorway:classroom_door:fallback')), 'no duplicate fallback frame for real door');
});

test('fresh browser entry registers the same runtime builders before rebuilding the scene', () => {
  const source = readFileSync(join(ROOT, 'packages/vignette/src/web-entry.ts'), 'utf8');
  const register = source.indexOf('registerRuntimeLibrary(lib);');
  const stage = source.indexOf('plan = stageBeatSheet(v.value, lib);');
  const scene = source.indexOf('scene = new VignetteScene(plan, lib);');
  assert.ok(register >= 0 && register < stage && stage < scene, 'browser must register builders before staging/rendering');
});