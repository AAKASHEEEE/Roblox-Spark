import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import type { EnvironmentManifest } from '../packages/schema/src/assets.ts';
import type { PropBuilder, SetBuilder } from '../packages/library/src/types.ts';
import { ID_PATTERN } from '../packages/library/src/ids.ts';
import { buildProp } from '../packages/engine/src/build.ts';
import {
  dispatchProp, dispatchSet, registerBuilder, registeredBuilder, unregisterBuilders, type ManifestLibrary,
} from '../packages/engine/src/build-dispatch.ts';
import {
  BUILT_IN_SET_BUILDERS, CLASSROOM_MANIFEST, CLASSROOM_SET, PLAYGROUND_MANIFEST, PLAYGROUND_SET,
  registerSetBuilders, SCHOOL_HALLWAY_MANIFEST, SCHOOL_HALLWAY_SET,
} from '../packages/engine/src/sets/index.ts';
import {
  CLASSROOM_1_2_0, ENVIRONMENT_CATALOG, PLAYGROUND_1_0_0, SCHOOL_HALLWAY_1_0_0,
  isCameraAllowed, validateCameraZones, validateEnvironmentCatalog, validateMarks,
} from '../packages/environments/src/index.ts';
import { loadLibrary } from '../apps/render-worker/lib/library.ts';
import { ROOT } from './helpers.ts';

const EMPTY_LIBRARY: ManifestLibrary = { characters: {}, props: {}, environments: {} };
const ADULT_HEIGHT_M = 2.69;
const HEAD_MARGIN_M = 0.21;
const MIN_CLEAR_HEIGHT_M = ADULT_HEIGHT_M + HEAD_MARGIN_M;
const MIN_CLEAR_WIDTH_M = 1.25;

type Collider = { id: string; min: [number, number, number]; max: [number, number, number] };
const overlaps = (a: Collider, min: [number, number, number], max: [number, number, number]) =>
  a.min.every((v, i) => v < max[i] - 1e-9 && a.max[i] > min[i] + 1e-9);
const piece = (m: EnvironmentManifest, id: string) => {
  const found = m.pieces.find((p) => p.id === id);
  assert.ok(found, `${m.id}: missing piece ${id}`);
  return found;
};
const innerEdge = (p: ReturnType<typeof piece>, side: 'min' | 'max') => p.pos[0] + (side === 'min' ? -1 : 1) * p.size[0] / 2;

function assertDoorway(
  builder: SetBuilder,
  expected: { id: string; threshold: [number, number, number]; inside: [number, number, number]; left: string; right: string; lintel: string },
): void {
  const built = builder.build({ seed: 47, decorDensity: 1 });
  const door = built.doors.find((d) => d.id === expected.id);
  assert.ok(door, `${builder.id}: missing ${expected.id}`);
  assert.deepEqual(door.position, expected.threshold);
  assert.equal(door.facingDeg, 0);
  const inside = built.marks.find((m) => m.id === door.entryMarkId);
  assert.ok(inside, `${builder.id}: entry mark ${door.entryMarkId} missing`);
  assert.deepEqual(inside.position, expected.inside);

  const manifest = builder.manifest!;
  const left = piece(manifest, expected.left), right = piece(manifest, expected.right), lintel = piece(manifest, expected.lintel);
  const clearWidth = innerEdge(right, 'min') - innerEdge(left, 'max');
  const clearHeight = lintel.pos[1] - lintel.size[1] / 2;
  assert.ok(clearWidth >= MIN_CLEAR_WIDTH_M, `${builder.id}: clear width ${clearWidth.toFixed(3)}m`);
  assert.ok(clearHeight >= MIN_CLEAR_HEIGHT_M, `${builder.id}: clear height ${clearHeight.toFixed(3)}m`);
  assert.ok(Math.max(left.size[1], right.size[1]) >= 3.4, `${builder.id}: wall is shorter than 3.4m`);

  // A full minimum-size adult envelope must pass through the wall plane without touching any collider.
  const halfWidth = MIN_CLEAR_WIDTH_M / 2;
  const prismMin: [number, number, number] = [door.position[0] - halfWidth, 0.001, door.position[2] - 0.32];
  const prismMax: [number, number, number] = [door.position[0] + halfWidth, MIN_CLEAR_HEIGHT_M, door.position[2] + 0.32];
  const blockers = (built.colliders as Collider[]).filter((c) => overlaps(c, prismMin, prismMax));
  assert.deepEqual(blockers.map((c) => c.id), [], `${builder.id}: doorway envelope blocked`);

  // The walked segment from threshold to first-inside mark keeps a 0.30m body radius clear.
  for (let step = 0; step <= 10; step++) {
    const u = step / 10;
    const x = door.position[0] + (inside.position[0] - door.position[0]) * u;
    const z = door.position[2] + (inside.position[2] - door.position[2]) * u;
    const min: [number, number, number] = [x - 0.3, 0.001, z - 0.3];
    const max: [number, number, number] = [x + 0.3, MIN_CLEAR_HEIGHT_M, z + 0.3];
    assert.deepEqual((built.colliders as Collider[]).filter((c) => overlaps(c, min, max)).map((c) => c.id), [], `${builder.id}: blocked entry path at u=${u}`);
  }
}

function sceneSignature(builder: SetBuilder): unknown {
  const built = builder.build({ seed: 1337, decorDensity: 0.73 });
  const nodes: unknown[] = [];
  built.root.traverse((node) => nodes.push({
    name: node.name, pos: [...node.pos], rot: [...node.rot], scl: [...node.scl],
    color: node.material ? [...node.material.color] : null,
    vertices: node.geometry?.positions.length ?? 0,
    indices: node.geometry?.indices.length ?? 0,
  }));
  return { nodes, colliders: built.colliders, marks: built.marks, doors: built.doors, safeMin: built.safeMin, safeMax: built.safeMax, lights: Object.keys(built.lighting).sort() };
}

function assertMarkClear(builder: SetBuilder, ids: string[]): void {
  const built = builder.build({ seed: 9, decorDensity: 1 });
  for (const id of ids) {
    const mark = built.marks.find((m) => m.id === id);
    assert.ok(mark, `${builder.id}: missing mark ${id}`);
    const min: [number, number, number] = [mark.position[0] - 0.25, 0.001, mark.position[2] - 0.25];
    const max: [number, number, number] = [mark.position[0] + 0.25, Math.max(0.05, mark.postures.length ? 2.0 : 0.05), mark.position[2] + 0.25];
    assert.deepEqual((built.colliders as Collider[]).filter((c) => overlaps(c, min, max)).map((c) => c.id), [], `${builder.id}: mark ${id} is inside a collider`);
  }
}

test('three producer IDs, exact versions and explicit registration resolve through S6 dispatch', () => {
  assert.deepEqual(BUILT_IN_SET_BUILDERS.map((b) => `${b.id}@${b.version}`), [
    'classroom@1.2.0', 'school_hallway@1.0.0', 'playground@1.0.0',
  ]);
  for (const builder of BUILT_IN_SET_BUILDERS) {
    assert.match(builder.id, ID_PATTERN);
    const built = builder.build({ seed: 1 });
    for (const id of [...built.marks.map((m) => m.id), ...built.doors.map((d) => d.id), ...Object.keys(built.lighting)]) assert.match(id, ID_PATTERN, `${builder.id}:${id}`);
  }
  unregisterBuilders();
  registerSetBuilders();
  for (const builder of BUILT_IN_SET_BUILDERS) {
    assert.equal(registeredBuilder('set', builder.id), builder);
    assert.equal(registeredBuilder('set', `${builder.id}@${builder.version}`), builder);
    const dispatched = dispatchSet(builder.id, EMPTY_LIBRARY, { seed: 5, placeholder: () => { throw new Error('placeholder must not run'); } });
    assert.equal(dispatched.source, 'builder');
    assert.equal(dispatched.key, `${builder.id}@${builder.version}`);
    assert.ok(dispatched.built);
  }
  unregisterBuilders();
});

test('prop dispatch retains the registered builder for S6 state application', () => {
  const manifest = loadLibrary().props['student_desk@1.0.0'];
  const builder: PropBuilder = {
    kind: 'prop', id: 'student_desk', version: '1.0.0', manifest,
    build(instanceId) { return { instance: buildProp(manifest, instanceId), states: ['default'] }; },
    applyState() { return { visible: true }; },
  };
  unregisterBuilders();
  registerBuilder(builder);
  const dispatched = dispatchProp('student_desk@1.0.0', 'review_desk', EMPTY_LIBRARY, {
    seed: 5, placeholder: () => { throw new Error('placeholder must not run'); },
  });
  assert.equal(dispatched.source, 'builder');
  assert.equal(dispatched.builder, builder);
  assert.equal(dispatched.built?.states[0], 'default');
  assert.deepEqual(dispatched.builder?.applyState(dispatched.built!, 'default', 1), { visible: true });
  unregisterBuilders();
});

test('published JSON and browser-safe generated manifests are identical and asset-locked', () => {
  const pairs: Array<[EnvironmentManifest, string]> = [
    [CLASSROOM_MANIFEST, 'classroom@1.2.0.json'], [SCHOOL_HALLWAY_MANIFEST, 'school_hallway@1.0.0.json'], [PLAYGROUND_MANIFEST, 'playground@1.0.0.json'],
  ];
  for (const [manifest, file] of pairs) {
    const disk = JSON.parse(readFileSync(join(ROOT, 'assets/environments', file), 'utf8'));
    assert.deepEqual(manifest, disk, file);
    assert.equal(manifest.license.source, 'original-procedural');
    assert.ok(manifest.notes?.includes('Original') || manifest.id === 'classroom');
  }
  assert.deepEqual(loadLibrary().errors, []);
});

test('classroom and hallway doorways clear an adult plus margin and follow staged entries', () => {
  assertDoorway(CLASSROOM_SET, {
    id: 'classroom_door', threshold: [2.5, 0, -3.95], inside: [2.5, 0, -3.0],
    left: 'wall_back_left', right: 'wall_back_right', lintel: 'wall_back_lintel',
  });
  assertDoorway(SCHOOL_HALLWAY_SET, {
    id: 'hall_door', threshold: [0, 0, -8.05], inside: [0, 0, -7.0],
    left: 'wall_back_left', right: 'wall_back_right', lintel: 'wall_back_lintel',
  });
  assert.equal(PLAYGROUND_SET.build({ seed: 1 }).doors.length, 0, 'open playground must not claim a fake door');
});

test('authored marks are present, reachable and clear of colliders', () => {
  assertMarkClear(CLASSROOM_SET, ['classroom_door_inside', 'center_stage', 'button_desk', 'coin_spawn']);
  assertMarkClear(SCHOOL_HALLWAY_SET, ['hall_center', 'lockers', 'hall_door_inside']);
  assertMarkClear(PLAYGROUND_SET, ['slide', 'swings', 'sandpit']);
  for (const builder of BUILT_IN_SET_BUILDERS) {
    const built = builder.build({ seed: 17 });
    assert.equal(new Set(built.marks.map((m) => m.id)).size, built.marks.length, `${builder.id}: duplicate marks`);
    assert.equal(new Set(built.doors.map((d) => d.id)).size, built.doors.length, `${builder.id}: duplicate doors`);
    for (const door of built.doors) assert.ok(built.marks.some((m) => m.id === door.entryMarkId));
  }
  for (const profile of [CLASSROOM_1_2_0, SCHOOL_HALLWAY_1_0_0, PLAYGROUND_1_0_0]) assert.deepEqual(validateMarks(profile), [], profile.id);
});

test('profiles expose valid camera zones, collider parity and two renderer lighting presets', () => {
  assert.equal(validateEnvironmentCatalog(ENVIRONMENT_CATALOG).ok, true);
  const triples = [
    [CLASSROOM_1_2_0, CLASSROOM_MANIFEST, CLASSROOM_SET],
    [SCHOOL_HALLWAY_1_0_0, SCHOOL_HALLWAY_MANIFEST, SCHOOL_HALLWAY_SET],
    [PLAYGROUND_1_0_0, PLAYGROUND_MANIFEST, PLAYGROUND_SET],
  ] as const;
  for (const [profile, manifest, builder] of triples) {
    assert.deepEqual(validateCameraZones(profile), [], profile.id);
    assert.deepEqual(profile.collision.colliderIds, manifest.pieces.filter((p) => p.collide).map((p) => p.id), `${profile.id}: collider profile drift`);
    for (const [id, manifestMark] of Object.entries(manifest.marks)) {
      const profileMark = profile.marks.find((m) => m.id === id);
      assert.ok(profileMark, `${profile.id}: manifest mark ${id} absent from profile`);
      assert.deepEqual([profileMark.position, profileMark.facingDeg], [manifestMark.pos, manifestMark.facingDeg], `${profile.id}:${id} transform drift`);
    }
    assert.equal(Object.keys(manifest.lighting).length, 2, `${profile.id}: manifest requires two presets`);
    assert.deepEqual(Object.keys(builder.build({ seed: 3 }).lighting).sort(), Object.keys(manifest.lighting).sort());
  }
  assert.equal(isCameraAllowed(CLASSROOM_1_2_0, [0, 1.4, 6], 'frontal_medium').ok, true);
  assert.equal(isCameraAllowed(SCHOOL_HALLWAY_1_0_0, [0, 1.7, 6.5], 'chase_cam').ok, true);
  assert.equal(isCameraAllowed(PLAYGROUND_1_0_0, [0, 2.2, 6.6], 'wide_environment').ok, true);
});

test('geometry, marks, doors and lighting keys are deterministic for equal options', () => {
  for (const builder of BUILT_IN_SET_BUILDERS) assert.deepEqual(sceneSignature(builder), sceneSignature(builder), builder.id);
});

test('single review sheet stays within the 1800px publication limit', () => {
  const png = readFileSync(join(ROOT, 'docs/vignette/sets/procedural-sets-review.png'));
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  assert.deepEqual([width, height], [1600, 900]);
  assert.ok(Math.max(width, height) <= 1800);
});

test('manifest generator check mode detects no generated drift', () => {
  const result = spawnSync(process.execPath, ['scripts/generate-lib-set-manifests.ts', '--check'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /verified classroom@1\.2\.0/);
});
