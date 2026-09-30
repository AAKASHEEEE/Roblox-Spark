import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ENVIRONMENT_CATALOG, CLASSROOM_1_0_0, CLASSROOM_1_1_0, CLASSROOM_1_2_0, validateProfile, validateCatalog, validateMarks, validateAnchors, validateCameraZones,
  parseProfile, parseEnvironmentRef, resolveForRender, pinExact, pinLatestForAuthoring, profileContentHash, sha256Hex, verifyLock,
  placeableMarks, resolvePlacementMark, checkPropAnchor, resolvePropAnchor, isCameraAllowed, checkCompatibility, simultaneousActorCapacity,
  type EnvironmentProfile, type CompatibilityRequest, type Catalog,
} from '../packages/environments/src/index.ts';
import { lib, sample, ROOT } from './helpers.ts';

const clone = (p: EnvironmentProfile): EnvironmentProfile => structuredClone(p) as EnvironmentProfile;
const codes = (xs: Array<{ code: string }>) => xs.map((x) => x.code);
const zapp = lib.characters['zapp@1.0.0'], kira = lib.characters['kira@1.0.0'];

/** the pinned Visual Comedy episode expressed as a compatibility request */
function visualComedyRequest(): CompatibilityRequest {
  const ep = sample();
  return {
    storyPattern: ep.episode.comedyEngine, castCount: ep.cast.length, characters: [zapp, kira],
    requiredActions: ep.actions.map((a: any) => ({ actor: a.actor, action: a.action })),
    requiredProps: [
      { instance: 'desk', category: 'furniture', anchor: 'hero_desk_spot' },
      { instance: 'button', category: 'device', anchor: 'button_spot' },
      { instance: 'coin', category: 'collectible', anchor: 'coin_floor', scale: 16.7 },
    ],
    requiredMarks: [...ep.cast.map((c: any) => c.startMark), ...ep.actions.filter((a: any) => a.to).map((a: any) => a.to)],
    cameraIntents: ep.shots.map((s: any) => s.preset),
  };
}

test('strict schema: built-in catalog validates; unknown keys and bad values are rejected', () => {
  assert.deepEqual(validateCatalog(ENVIRONMENT_CATALOG), []);
  const p: any = clone(CLASSROOM_1_0_0); p.marks[0].colour = 'red'; p.extra = 1;
  const r = parseProfile(p);
  assert.equal(r.ok, false);
  const paths = r.ok ? [] : r.issues.map((i) => i.path);
  assert.ok(paths.includes('$.extra') && paths.includes('$.marks[0].colour'));
  const q: any = clone(CLASSROOM_1_0_0); q.schemaVersion = 'environment-profile/2';
  assert.equal(parseProfile(q).ok, false);
});

test('prototype keys are rejected in profiles and environment refs', () => {
  const p = JSON.parse(JSON.stringify(CLASSROOM_1_0_0).replace('"id":"zapp_enter"', '"__proto__":{"polluted":true},"id":"zapp_enter"'));
  const r = parseProfile(p);
  assert.ok(!r.ok && r.issues.some((i) => i.message === 'forbidden prototype key'));
  const ref = JSON.parse(`{"environmentId":"classroom","version":"1.0.0","contentHash":"${'a'.repeat(64)}","constructor":{"x":1}}`);
  assert.equal(parseEnvironmentRef(ref).ok, false);
  assert.equal(({} as any).polluted, undefined);
});

test('exact version resolution: episode pins resolve to exactly that profile', () => {
  const r100 = pinExact(ENVIRONMENT_CATALOG, 'classroom', '1.0.0');
  assert.equal(resolveForRender(ENVIRONMENT_CATALOG, r100), ENVIRONMENT_CATALOG.profiles[0]);
  assert.equal(resolveForRender(ENVIRONMENT_CATALOG, pinExact(ENVIRONMENT_CATALOG, 'classroom', '1.1.0')).version, '1.1.0');
  assert.throws(() => resolveForRender(ENVIRONMENT_CATALOG, { ...r100, contentHash: pinExact(ENVIRONMENT_CATALOG, 'classroom', '1.1.0').contentHash }), /content hash mismatch/);
  assert.throws(() => resolveForRender(ENVIRONMENT_CATALOG, { ...r100, version: '9.9.9' }), /not in the catalog/);
  assert.throws(() => resolveForRender(ENVIRONMENT_CATALOG, { environmentId: 'classroom', version: '1.0.0' }), /contentHash required/);
});

test('latest/ranges are forbidden at render; latest is an authoring-only pin', () => {
  const h = pinExact(ENVIRONMENT_CATALOG, 'classroom', '1.0.0').contentHash;
  for (const version of ['latest', '^1.0.0', '~1.1.0', '1.x', '*', '>=1.0.0'])
    assert.throws(() => resolveForRender(ENVIRONMENT_CATALOG, { environmentId: 'classroom', version, contentHash: h }), /exact environment version|invalid environment ref/, version);
  assert.deepEqual(pinLatestForAuthoring(ENVIRONMENT_CATALOG, 'classroom'), pinExact(ENVIRONMENT_CATALOG, 'classroom', '1.2.0'));
});

test('content hash is deterministic and key-order independent; sha256 matches node:crypto', () => {
  const a = profileContentHash(CLASSROOM_1_0_0);
  const reverseKeys = (x: unknown): unknown => Array.isArray(x) ? x.map(reverseKeys)
    : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).reverse().map(([k, v]) => [k, reverseKeys(v)])) : x;
  assert.equal(profileContentHash(reverseKeys(CLASSROOM_1_0_0) as EnvironmentProfile), a);
  assert.equal(profileContentHash(clone(CLASSROOM_1_0_0)), a);
  assert.equal(a, ENVIRONMENT_CATALOG.lock['classroom@1.0.0']);
  assert.notEqual(a, profileContentHash(CLASSROOM_1_1_0));
  for (const s of ['', 'abc', 'é🎬'.repeat(40), 'x'.repeat(1000)]) assert.equal(sha256Hex(s), createHash('sha256').update(s).digest('hex'));
});

test('mark ids must be unique (marks and anchors)', () => {
  const p = clone(CLASSROOM_1_0_0); p.marks.push({ ...p.marks[1] });
  assert.ok(codes(validateMarks(p)).includes('mark_duplicate'));
  const q = clone(CLASSROOM_1_0_0); q.anchors[0].id = 'zapp_desk';
  assert.ok(codes(validateAnchors(q)).includes('anchor_mark_collision'));
});

test('coordinates must be finite and inside bounds', () => {
  const p: any = clone(CLASSROOM_1_0_0); p.marks[0].position = [NaN, 0, 0];
  assert.equal(parseProfile(p).ok, false);
  const q = clone(CLASSROOM_1_0_0); q.marks[0].position = [Infinity, 0, 0];
  assert.ok(codes(validateMarks(q)).includes('mark_non_finite'));
  const r = clone(CLASSROOM_1_0_0); r.marks[0].position = [9, 0, 0];
  assert.ok(codes(validateMarks(r)).includes('mark_out_of_bounds'));
});

test('reachability graph: unknown targets, invalid targets and disconnected marks are errors', () => {
  const p = clone(CLASSROOM_1_0_0);
  p.marks.find((m) => m.id === 'zapp_desk')!.reachable.push('nowhere', 'classroom_door');
  const c = codes(validateMarks(p));
  assert.ok(c.includes('reach_unknown') && c.includes('reach_invalid'));
  const q = clone(CLASSROOM_1_0_0);
  for (const m of q.marks) m.reachable = m.reachable.filter((r) => r !== 'kira_safe');
  q.marks.find((m) => m.id === 'kira_safe')!.reachable = [];
  assert.ok(validateMarks(q).some((i) => i.code === 'reach_disconnected' && i.message.includes('kira_safe')));
});

test('occupancy: overlapping marks need alias/exclusivity; one body per actor mark; capacity honours exclusivity', () => {
  const p = clone(CLASSROOM_1_1_0);
  p.marks.find((m) => m.id === 'race_right')!.exclusiveWith = [];
  p.marks.find((m) => m.id === 'kira_safe')!.exclusiveWith = [];
  assert.ok(validateMarks(p).some((i) => i.code === 'occupancy_conflict' && /kira_safe|race_right/.test(i.message)));
  const q = clone(CLASSROOM_1_0_0); q.marks[0].occupancy = 2;
  assert.ok(codes(validateMarks(q)).includes('occupancy_limit'));
  const w = clone(CLASSROOM_1_1_0); w.marks.find((m) => m.id === 'wp_front_left')!.occupancy = 1;
  assert.ok(codes(validateMarks(w)).includes('waypoint_occupancy'));
  assert.equal(simultaneousActorCapacity(CLASSROOM_1_0_0), 7);
});

test('off-screen cue classroom_door is direction-only and never geometry', () => {
  for (const env of [CLASSROOM_1_0_0, CLASSROOM_1_1_0]) {
    const door = env.marks.find((m) => m.id === 'classroom_door')!;
    assert.equal(door.kind, 'offscreen_cue'); assert.equal(door.instantiateGeometry, false); assert.equal(door.occupancy, 0);
    assert.ok(!placeableMarks(env).some((m) => m.id === 'classroom_door'));
    assert.throws(() => resolvePlacementMark(env, 'classroom_door'), /off-screen cue/);
    assert.ok(env.marks.every((m) => m.instantiateGeometry === false));
  }
  const p = clone(CLASSROOM_1_0_0); p.marks.find((m) => m.id === 'classroom_door')!.instantiateGeometry = true;
  assert.ok(codes(validateMarks(p)).includes('offscreen_geometry'));
  const q = clone(CLASSROOM_1_0_0); q.marks.find((m) => m.id === 'classroom_door')!.cueDirection = null;
  assert.ok(codes(validateMarks(q)).includes('offscreen_direction'));
});

test('anchor compatibility: category, scale and size are enforced', () => {
  assert.equal(checkPropAnchor(CLASSROOM_1_0_0, { instance: 'button', category: 'device', anchor: 'button_spot' }).ok, true);
  assert.equal(resolvePropAnchor(CLASSROOM_1_0_0, { instance: 'coin', category: 'collectible', anchor: 'coin_floor', scale: 16.7 }).id, 'coin_floor');
  const bad = (r: ReturnType<typeof checkPropAnchor>) => (r.ok ? 'ok' : r.code);
  assert.equal(bad(checkPropAnchor(CLASSROOM_1_0_0, { instance: 'coin', category: 'collectible', anchor: 'button_spot' })), 'anchor_category');
  assert.equal(bad(checkPropAnchor(CLASSROOM_1_0_0, { instance: 'desk', category: 'furniture', anchor: 'hero_desk_spot', scale: 2 })), 'anchor_scale');
  assert.equal(bad(checkPropAnchor(CLASSROOM_1_0_0, { instance: 'desk', category: 'furniture', anchor: 'hero_desk_spot', size: [3, 1, 1] })), 'anchor_size');
  assert.equal(bad(checkPropAnchor(CLASSROOM_1_0_0, { instance: 'x', category: 'device', anchor: 'board_center' })), 'anchor_role');
  const p = clone(CLASSROOM_1_0_0); p.anchors.find((a) => a.id === 'button_spot')!.parentSurface.ref = 'ghost';
  assert.ok(codes(validateAnchors(p)).includes('anchor_parent_unknown'));
});

test('missing anchor blocks: no fallback coordinate', () => {
  const req = { instance: 'giant', category: 'giant_prop', anchor: 'giant_spot' };
  assert.throws(() => resolvePropAnchor(CLASSROOM_1_0_0, req), /does not define/);
  assert.equal(resolvePropAnchor(CLASSROOM_1_1_0, req).id, 'giant_spot');
  const r = checkCompatibility(CLASSROOM_1_0_0, { ...visualComedyRequest(), requiredProps: [req] });
  assert.equal(r.compatible, false);
  assert.deepEqual(r.missingAnchors, ['giant_spot']);
});

test('camera-safe zones: intents are permitted only inside volumes that allow them', () => {
  assert.equal(isCameraAllowed(CLASSROOM_1_0_0, [0, 1.4, 6], 'frontal_medium').ok, true);
  assert.equal(isCameraAllowed(CLASSROOM_1_0_0, [0, 1.4, 6], 'top_down_insert').ok, false);
  assert.equal(isCameraAllowed(CLASSROOM_1_0_0, [0, 3.0, 0.2], 'top_down_insert').ok, true);
  assert.match(isCameraAllowed(CLASSROOM_1_0_0, [0, 1.4, -3.9], 'frontal_medium').reason!, /outside every safe volume/);
  const p = clone(CLASSROOM_1_0_0); p.cameraZones.safeVolumes[0].min[0] = -4.5;
  assert.ok(codes(validateCameraZones(p)).includes('camera_wall_clearance'));
  const r = checkCompatibility(CLASSROOM_1_0_0, { ...visualComedyRequest(), cameraIntents: ['frontal_medium', 'drone_orbit'] });
  assert.deepEqual(r.missingCameraZones, ['drone_orbit']);
  assert.equal(r.compatible, false);
});

test('exclusion volumes reject camera positions and corridor endpoints', () => {
  assert.match(isCameraAllowed(CLASSROOM_1_0_0, [0, 0.5, 0], 'prop_ecu').reason!, /exclusion volume "hero_desk_body"/);
  const p = clone(CLASSROOM_1_0_0); p.cameraZones.lensCorridors[1].to = [0, 0.5, 0];
  assert.ok(codes(validateCameraZones(p)).includes('camera_corridor_endpoint'));
  const q = clone(CLASSROOM_1_0_0); q.cameraZones.exclusionVolumes[0].max = [...q.cameraZones.exclusionVolumes[0].min];
  assert.ok(codes(validateCameraZones(q)).includes('camera_exclusion_invalid'));
});

test('ceiling validation', () => {
  assert.match(isCameraAllowed(CLASSROOM_1_0_0, [0, 4.3, 6], 'wide_environment').reason!, /above ceiling/);
  const p = clone(CLASSROOM_1_0_0); p.cameraZones.safeVolumes[0].max[1] = 4.5;
  assert.ok(codes(validateCameraZones(p)).includes('camera_above_ceiling'));
  const q = clone(CLASSROOM_1_0_0); q.cameraZones.ceilingY = 6;
  assert.ok(codes(validateCameraZones(q)).includes('camera_ceiling_above_room'));
});

test('any locked change (marks, anchors, camera, lighting, collision, geometry) requires a new version', () => {
  const mutations: Array<(p: EnvironmentProfile) => void> = [
    (p) => { p.marks[1].position[0] += 0.01; },
    (p) => { p.anchors[0].maxSize[0] = 2; },
    (p) => { p.cameraZones.ceilingY = 4.1; },
    (p) => { p.lighting.params.exposure = 1.1; },
    (p) => { p.collision.colliderIds.pop(); },
    (p) => { p.asset.sha256 = 'f'.repeat(64); },
  ];
  for (const mutate of mutations) {
    const p = clone(CLASSROOM_1_0_0); mutate(p);
    const cat: Catalog = { profiles: [p, CLASSROOM_1_1_0], lock: ENVIRONMENT_CATALOG.lock };
    assert.ok(codes(verifyLock(cat)).includes('version_bump_required'));
    assert.throws(() => resolveForRender(cat, pinExact(ENVIRONMENT_CATALOG, 'classroom', '1.0.0')), /version bump required/);
  }
  assert.throws(() => { (CLASSROOM_1_0_0.marks[0].position as number[])[0] = 5; }, TypeError);
});

test('old versions stay pinned and reproducible after a new version is published', () => {
  const pin100 = pinExact(ENVIRONMENT_CATALOG, 'classroom', '1.0.0');
  const next = clone(CLASSROOM_1_2_0); next.version = '1.3.0'; next.lighting.params.exposure = 1.2;
  const cat: Catalog = { profiles: [...ENVIRONMENT_CATALOG.profiles, next], lock: { ...ENVIRONMENT_CATALOG.lock, 'classroom@1.3.0': profileContentHash(next) } };
  assert.deepEqual(verifyLock(cat), []);
  assert.equal(profileContentHash(resolveForRender(cat, pin100)), pin100.contentHash);
  assert.equal(pinLatestForAuthoring(cat, 'classroom').version, '1.3.0');
  const dropped: Catalog = { profiles: [CLASSROOM_1_1_0], lock: ENVIRONMENT_CATALOG.lock };
  assert.ok(codes(verifyLock(dropped)).includes('lock_orphan'));
  // classroom@1.0.0 (Visual Comedy) mirrors its manifest and asset-lock entry unchanged
  const lock = JSON.parse(readFileSync(join(ROOT, 'assets/asset-lock.json'), 'utf8')).assets;
  for (const env of [CLASSROOM_1_0_0, CLASSROOM_1_1_0]) {
    const man = JSON.parse(readFileSync(join(ROOT, `assets/environments/classroom@${env.version}.json`), 'utf8'));
    assert.equal(env.asset.sha256, lock[`environments/classroom@${env.version}`]);
    for (const [id, m] of Object.entries<any>(man.marks)) { const pm = env.marks.find((x) => x.id === id)!; assert.deepEqual([pm.position, pm.facingDeg], [m.pos, m.facingDeg], id); }
    for (const [id, pos] of Object.entries<any>(man.anchors)) assert.deepEqual(env.anchors.find((a) => a.id === id)!.position, pos, id);
    assert.deepEqual(env.lighting.params, man.lighting.morning);
    assert.deepEqual(env.collision.colliderIds, man.pieces.filter((x: any) => x.collide).map((x: any) => x.id));
    assert.deepEqual(env.bounds, man.bounds);
  }
  assert.equal(sample().environment.version, '1.0.0');
});

test('cast-count compatibility', () => {
  const base = visualComedyRequest();
  assert.equal(checkCompatibility(CLASSROOM_1_0_0, base).compatible, true);
  const four = checkCompatibility(CLASSROOM_1_0_0, { ...base, castCount: 4 });
  assert.equal(four.compatible, false);
  assert.ok(four.errors.some((e) => /cast of 4 outside/.test(e)));
  const three = checkCompatibility(CLASSROOM_1_0_0, { ...base, castCount: 3, characters: [zapp, kira, { ...kira, id: 'max' }] });
  assert.ok(three.warnings.some((w) => /frame at most 2 of 3/.test(w)));
});

test('story pattern, action and prop compatibility with a deterministic hash', () => {
  const vc = visualComedyRequest();
  const ok = checkCompatibility(CLASSROOM_1_0_0, vc);
  assert.equal(ok.compatible, true, ok.errors.join('\n'));
  assert.deepEqual([ok.missingMarks, ok.missingAnchors, ok.unsupportedActions], [[], [], []]);
  const shuffled = { ...vc, requiredActions: [...vc.requiredActions].reverse(), cameraIntents: [...vc.cameraIntents].reverse(), characters: [kira, zapp] };
  assert.equal(checkCompatibility(CLASSROOM_1_0_0, shuffled).compatibilityHash, ok.compatibilityHash);
  assert.notEqual(checkCompatibility(CLASSROOM_1_1_0, vc).compatibilityHash, ok.compatibilityHash);
  const noob = checkCompatibility(CLASSROOM_1_0_0, { ...vc, storyPattern: 'noob_vs_smart' });
  assert.equal(noob.compatible, false);
  assert.equal(checkCompatibility(CLASSROOM_1_1_0, { ...vc, storyPattern: 'noob_vs_smart' }).compatible, true);
  const acts = checkCompatibility(CLASSROOM_1_0_0, { ...vc, requiredActions: [{ actor: 'kira', action: 'dive_prone' }, { actor: 'zapp', action: 'hover' }], requiredMarks: ['giant_front'] });
  assert.deepEqual(acts.unsupportedActions, ['kira:dive_prone', 'zapp:hover']);
  assert.deepEqual(acts.missingMarks, ['giant_front']);
  assert.equal(acts.compatible, false);
});

test('licensing and provenance problems block compatibility', () => {
  const vc = visualComedyRequest();
  const p = clone(CLASSROOM_1_0_0); p.license = { ...p.license, source: 'licensed-commercial', attributionRequired: true };
  const r = checkCompatibility(p, vc);
  assert.equal(r.compatible, false);
  assert.equal(r.licenseProblems.length, 2);
  const q = clone(CLASSROOM_1_0_0); q.provenance.derivedFrom = ['somewhere/else'];
  assert.ok(checkCompatibility(q, vc).licenseProblems.some((x) => /provenance/.test(x)));
  const unlicensed = checkCompatibility(CLASSROOM_1_0_0, { ...vc, characters: [zapp, { id: 'kira', version: '1.0.0', allowedActions: kira.allowedActions }] });
  assert.ok(unlicensed.licenseProblems.some((x) => /kira@1\.0\.0: no licence/.test(x)));
  assert.equal(validateProfile({ ...clone(CLASSROOM_1_0_0), license: { source: 'found-online' } }).ok, false);
});
