import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ENVIRONMENT_CATALOG, ENVIRONMENT_LOCK, CLASSROOM_1_0_0, CLASSROOM_1_1_0, CLASSROOM_1_2_0, canonicalJson, profileContentHash,
  validateEnvironmentCatalog, planEnvironmentLock, parseLockBlock, renderLockBlock, replaceLockBlock, type EnvironmentProfile,
  validateCatalog, hashableValueIssues, type Catalog,
} from '../packages/environments/src/index.ts';
import { runEnvironmentLock, LOCK_SOURCE } from '../scripts/environment-lock.ts';

const EXPECTED = {
  'classroom@1.0.0': '3494d354c5dc2f904964115002d864c40b72236a3379f3e937375f17279a6479',
  'classroom@1.1.0': '0bb894417d9cdb3dee19ed358e54730f4162d84d540525587e5942cb60047dbf',
  'classroom@1.2.0': '9b3b696f7e76e66361921095769216ca30cfb18883e7aacb5a72eb242db36087',
  'playground@1.0.0': 'b6056be513505ed9a1e9c2e06a2d16d20180fc1cc47797e3315c4cdd236fdf95',
  'school_hallway@1.0.0': 'cd02cdc410b22af8b1bc9010054dc30fefbddfd9a99d0b5c23ea3468a0a1e3ee',
};
const clone = (p: EnvironmentProfile): EnvironmentProfile => structuredClone(p) as EnvironmentProfile;
const PROFILES = ENVIRONMENT_CATALOG.profiles;
const replaceProfile = (replacement: EnvironmentProfile): EnvironmentProfile[] => PROFILES.map((p) =>
  p.id === replacement.id && p.version === replacement.version ? replacement : p,
);
/** private copy of lock.ts so write-mode tests never touch the committed file */
function tempLock(edit?: (src: string) => string): { path: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'bs-envlock-'));
  const path = join(dir, 'lock.ts');
  copyFileSync(LOCK_SOURCE, path);
  if (edit) writeFileSync(path, edit(readFileSync(path, 'utf8')));
  return { path, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const v130 = () => { const p = clone(CLASSROOM_1_2_0); p.version = '1.3.0'; p.lighting.params.exposure = 1.2; return p; };

test('committed catalog passes the combined validator', () => {
  assert.deepEqual(validateEnvironmentCatalog(ENVIRONMENT_CATALOG), { ok: true, issues: [] });
});

test('check mode succeeds with the committed lock and is read-only', () => {
  const before = readFileSync(LOCK_SOURCE, 'utf8');
  const r = runEnvironmentLock({ mode: 'check', profiles: PROFILES, lockSourcePath: LOCK_SOURCE, runtimeLock: ENVIRONMENT_LOCK });
  assert.equal(r.code, 0, r.lines.join('\n'));
  assert.equal(r.wrote, false);
  assert.equal(readFileSync(LOCK_SOURCE, 'utf8'), before);
  const parsed = parseLockBlock(before);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.lock, EXPECTED);
  assert.deepEqual({ ...ENVIRONMENT_LOCK }, EXPECTED);
});

test('profile tampering causes a mismatch naming the id@version', () => {
  const t = clone(CLASSROOM_1_0_0); t.marks[1].position[0] += 0.001;
  const profiles = replaceProfile(t);
  const plan = planEnvironmentLock({ profiles, lock: ENVIRONMENT_LOCK }, 'check');
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.issues.map((i) => [i.code, i.key]), [['version_bump_required', 'classroom@1.0.0']]);
  assert.equal(runEnvironmentLock({ mode: 'check', profiles, lockSourcePath: LOCK_SOURCE }).code, 1);
});

test('a missing lock entry fails check mode', () => {
  const tmp = tempLock((s) => s.replace(`  'classroom@1.1.0': '${EXPECTED['classroom@1.1.0']}',\n`, ''));
  try {
    const r = runEnvironmentLock({ mode: 'check', profiles: PROFILES, lockSourcePath: tmp.path });
    assert.equal(r.code, 1);
    assert.ok(r.lines.some((l) => l.includes('[lock_missing] classroom@1.1.0')), r.lines.join('\n'));
    // the committed module lock no longer matches the edited file -> refused outright
    assert.equal(runEnvironmentLock({ mode: 'check', profiles: PROFILES, lockSourcePath: tmp.path, runtimeLock: ENVIRONMENT_LOCK }).code, 1);
  } finally { tmp.done(); }
});

test('deleting a previously locked profile fails check and update', () => {
  const tmp = tempLock();
  try {
    const before = readFileSync(tmp.path, 'utf8');
    for (const mode of ['check', 'update'] as const) {
      const r = runEnvironmentLock({ mode, profiles: [CLASSROOM_1_1_0], lockSourcePath: tmp.path });
      assert.equal(r.code, 1);
      assert.ok(r.lines.some((l) => l.includes('[lock_orphan] classroom@1.0.0')), r.lines.join('\n'));
    }
    assert.equal(readFileSync(tmp.path, 'utf8'), before);
  } finally { tmp.done(); }
});

test('update mode appends a new version, keeps existing entries byte-identical, and is idempotent', () => {
  const tmp = tempLock();
  try {
    const before = readFileSync(tmp.path, 'utf8');
    const profiles = [...PROFILES, v130()];
    assert.equal(runEnvironmentLock({ mode: 'check', profiles, lockSourcePath: tmp.path }).code, 1, 'new version is missing before update');
    const r = runEnvironmentLock({ mode: 'update', profiles, lockSourcePath: tmp.path });
    assert.equal(r.code, 0, r.lines.join('\n'));
    assert.equal(r.wrote, true);
    const after = readFileSync(tmp.path, 'utf8');
    const parsed = parseLockBlock(after);
    assert.ok(parsed.ok);
    assert.deepEqual(Object.keys(parsed.lock), [...Object.keys(EXPECTED), 'classroom@1.3.0']);
    assert.deepEqual({ ...parsed.lock, 'classroom@1.3.0': undefined }, { ...EXPECTED, 'classroom@1.3.0': undefined });
    assert.equal(parsed.lock['classroom@1.3.0'], profileContentHash(v130()));
    // only the one appended line differs from the original file
    assert.equal(after.replace(`  'classroom@1.3.0': '${parsed.lock['classroom@1.3.0']}',\n`, ''), before);
    assert.equal(runEnvironmentLock({ mode: 'check', profiles, lockSourcePath: tmp.path }).code, 0);
    const again = runEnvironmentLock({ mode: 'update', profiles, lockSourcePath: tmp.path });
    assert.deepEqual([again.code, again.wrote], [0, false]);
    assert.equal(readFileSync(tmp.path, 'utf8'), after);
  } finally { tmp.done(); }
});

test('update mode refuses to rewrite an existing hash (and appends nothing)', () => {
  const tmp = tempLock();
  try {
    const before = readFileSync(tmp.path, 'utf8');
    const t = clone(CLASSROOM_1_0_0); t.lighting.params.exposure = 1.3;
    const r = runEnvironmentLock({ mode: 'update', profiles: [...replaceProfile(t), v130()], lockSourcePath: tmp.path });
    assert.equal(r.code, 1);
    assert.ok(r.lines.some((l) => l.includes('[version_bump_required] classroom@1.0.0')), r.lines.join('\n'));
    assert.equal(readFileSync(tmp.path, 'utf8'), before);
    // the writer itself also refuses to change, reorder or drop a locked entry
    assert.throws(() => replaceLockBlock(before, { ...EXPECTED, 'classroom@1.0.0': 'f'.repeat(64) }), /refusing/);
    assert.throws(() => replaceLockBlock(before, { 'classroom@1.1.0': EXPECTED['classroom@1.1.0'] }), /refusing/);
    // a hand-edited (non-generated) block is refused rather than parsed loosely
    const hand = tempLock((s) => s.replace(`  'classroom@1.0.0'`, `  // pinned\n  'classroom@1.0.0'`));
    try {
      const h = runEnvironmentLock({ mode: 'update', profiles: [...PROFILES, v130()], lockSourcePath: hand.path });
      assert.equal(h.code, 1);
      assert.match(h.lines[0], /REFUSED - line \d+ of the generated lock block/);
    } finally { hand.done(); }
  } finally { tmp.done(); }
});

test('invalid profiles and lock entries are rejected, keyed by id@version, before any hashing', () => {
  const nan = clone(CLASSROOM_1_0_0); nan.marks[0].position[0] = NaN;
  const cyclic: any = clone(CLASSROOM_1_1_0); cyclic.self = cyclic;
  assert.throws(() => profileContentHash(nan), /non-finite/); // why validation must come first
  const plan = planEnvironmentLock({ profiles: [nan, cyclic], lock: ENVIRONMENT_LOCK }, 'update');
  assert.equal(plan.ok, false);
  assert.deepEqual([plan.entries, plan.nextLock], [[], null]); // nothing was hashed or generated
  const got = plan.issues.map((i) => `${i.key}:${i.code}`);
  assert.ok(got.includes('classroom@1.0.0:hash_non_finite') && got.includes('classroom@1.1.0:hash_cycle'), got.join(' '));
  const big: any = clone(CLASSROOM_1_0_0); big.scale.metersPerUnit = 1n;
  const schemaBad: any = clone(CLASSROOM_1_0_0); schemaBad.marks[0].extra = true;
  const bad = validateEnvironmentCatalog({ profiles: [big, schemaBad, CLASSROOM_1_1_0, CLASSROOM_1_1_0], lock: ENVIRONMENT_LOCK }).issues.map((i) => `${i.key}:${i.code}`);
  for (const want of ['classroom@1.0.0:hash_invalid_value', 'classroom@1.0.0:schema', 'classroom@1.1.0:profile_duplicate']) assert.ok(bad.includes(want), `${want} in ${bad.join(' ')}`);
  const lock = JSON.parse(`{"__proto__":{"x":1},"Classroom@1.0.0":"${EXPECTED['classroom@1.0.0']}","classroom@1.0.0":"${EXPECTED['classroom@1.0.0']}","classroom@1.1.0":"nothex"}`);
  const lk = validateEnvironmentCatalog({ profiles: PROFILES, lock }).issues.map((i) => `${i.key}:${i.code}`);
  for (const want of ['__proto__:unsafe_key', 'Classroom@1.0.0:lock_key_invalid', 'Classroom@1.0.0:lock_orphan', 'classroom@1.0.0:lock_conflict', 'classroom@1.1.0:lock_hash_invalid']) assert.ok(lk.includes(want), `${want} in ${lk.join(' ')}`);
  const tmp = tempLock();
  try {
    const before = readFileSync(tmp.path, 'utf8');
    assert.equal(runEnvironmentLock({ mode: 'update', profiles: [nan, CLASSROOM_1_1_0, v130()], lockSourcePath: tmp.path }).code, 1);
    assert.equal(readFileSync(tmp.path, 'utf8'), before);
  } finally { tmp.done(); }
});

test('hashes are identical across repeated runs and match node:crypto SHA-256 of the canonical JSON', () => {
  const runs = [1, 2, 3].map(() => planEnvironmentLock(ENVIRONMENT_CATALOG, 'check'));
  for (const r of runs) assert.deepEqual(r, runs[0]);
  assert.deepEqual(runs[0].entries.map((e) => [e.key, e.computed, e.status]), Object.entries(EXPECTED).map(([k, h]) => [k, h, 'unchanged']));
  for (const p of PROFILES) assert.equal(profileContentHash(p), createHash('sha256').update(canonicalJson(p)).digest('hex'));
  assert.equal(renderLockBlock(EXPECTED), renderLockBlock({ ...EXPECTED }));
});

const withUndefinedOptional = () => { const p = clone(CLASSROOM_1_0_0); (p.license as any).url = undefined; return p; };
const withNestedUndefined = () => { const p = clone(CLASSROOM_1_0_0); (p.marks[0].hazard as any).note = undefined; return p; };

test('present-but-undefined properties (optional and nested) are rejected before hashing; absent optionals stay valid', () => {
  for (const [p, path] of [[withUndefinedOptional(), 'profiles[0].license.url'], [withNestedUndefined(), 'profiles[0].marks[0].hazard.note']] as const) {
    const plan = planEnvironmentLock({ profiles: replaceProfile(p), lock: ENVIRONMENT_LOCK }, 'check');
    assert.equal(plan.ok, false);
    assert.deepEqual([plan.entries, plan.nextLock], [[], null]); // never reached profileContentHash
    assert.deepEqual(plan.issues.map((i) => [i.key, i.code, i.path]), [['classroom@1.0.0', 'hash_invalid_value', path]]);
    // why it matters: canonical hashing silently drops the key, so the tampered object would "match" the lock
    assert.equal(profileContentHash(p), EXPECTED['classroom@1.0.0']);
  }
  assert.equal(Object.hasOwn(CLASSROOM_1_0_0.license, 'url'), false); // committed profiles use absent optionals
  const absent = v130();
  delete (absent.provenance as any).notes;
  delete (absent.marks.find((m) => m.hazard.note !== undefined)!.hazard as any).note;
  assert.deepEqual(hashableValueIssues(absent), []);
  const up = planEnvironmentLock({ profiles: [...PROFILES, absent], lock: ENVIRONMENT_LOCK }, 'update');
  assert.deepEqual([up.ok, up.appended, up.issues], [true, ['classroom@1.3.0'], []]);
});

test('undefined array entries and holes stay rejected; update writes nothing while any unhashable value exists', () => {
  const undef = clone(CLASSROOM_1_0_0); (undef.marks[0].postures as unknown[]).push(undefined);
  const hole = clone(CLASSROOM_1_0_0); hole.marks[0].reachable.length = 2;
  assert.deepEqual(hashableValueIssues(undef).map((i) => [i.code, i.path]), [['hash_array_hole', '$.marks[0].postures[1]']]);
  assert.deepEqual(hashableValueIssues(hole).map((i) => [i.code, i.path]), [['hash_array_hole', '$.marks[0].reachable[1]']]);
  const tmp = tempLock();
  try {
    const before = readFileSync(tmp.path, 'utf8');
    for (const bad of [withUndefinedOptional(), withNestedUndefined(), undef, hole]) {
      const r = runEnvironmentLock({ mode: 'update', profiles: [...replaceProfile(bad), v130()], lockSourcePath: tmp.path });
      assert.deepEqual([r.code, r.wrote], [1, false]);
      assert.ok(r.lines.some((l) => /\[hash_(invalid_value|array_hole)\] classroom@1\.0\.0: /.test(l)), r.lines.join('\n'));
    }
    assert.equal(readFileSync(tmp.path, 'utf8'), before);
  } finally { tmp.done(); }
});

test('legacy validateCatalog delegates to the authoritative path: same issues, never accepts what it rejects', () => {
  const tampered = clone(CLASSROOM_1_0_0); tampered.marks[1].position[0] += 0.001;
  const hidden = clone(CLASSROOM_1_0_0); Object.defineProperty(hidden, 'hidden', { value: 1, enumerable: false });
  const cyclic: any = clone(CLASSROOM_1_1_0); cyclic.self = cyclic;
  const { 'classroom@1.1.0': _dropped, ...lockMissing } = ENVIRONMENT_LOCK;
  const cases: Array<[string, Catalog, string]> = [
    ['hash mismatch', { profiles: replaceProfile(tampered), lock: ENVIRONMENT_LOCK }, 'version_bump_required'],
    ['missing lock entry', { profiles: PROFILES, lock: lockMissing }, 'lock_missing'],
    ['deleted locked profile', { profiles: PROFILES.filter((p) => !(p.id === 'classroom' && p.version === '1.0.0')), lock: ENVIRONMENT_LOCK }, 'lock_orphan'],
    // the three below were accepted (or crashed) under the old, separate validateCatalog logic
    ['undefined optional', { profiles: replaceProfile(withUndefinedOptional()), lock: ENVIRONMENT_LOCK }, 'hash_invalid_value'],
    ['hidden property', { profiles: replaceProfile(hidden), lock: ENVIRONMENT_LOCK }, 'hash_non_enumerable'],
    ['cycle', { profiles: replaceProfile(cyclic), lock: ENVIRONMENT_LOCK }, 'hash_cycle'],
  ];
  for (const [name, cat, code] of cases) {
    const combined = validateEnvironmentCatalog(cat);
    assert.equal(combined.ok, false, name);
    assert.ok(combined.issues.some((i) => i.code === code), `${name}: ${combined.issues.map((i) => i.code).join(' ')}`);
    assert.ok(combined.issues.every((i) => /^classroom@\d+\.\d+\.\d+$/.test(i.key)), name);
    assert.deepEqual(validateCatalog(cat), combined.issues, name);
    assert.deepEqual(planEnvironmentLock(cat, 'check').issues, combined.issues, name);
  }
  assert.deepEqual(validateCatalog(ENVIRONMENT_CATALOG), []);
  assert.deepEqual(validateEnvironmentCatalog(ENVIRONMENT_CATALOG), { ok: true, issues: [] });
  assert.deepEqual({ ...ENVIRONMENT_LOCK }, EXPECTED);
  assert.deepEqual(Object.fromEntries(PROFILES.map((p) => [`${p.id}@${p.version}`, profileContentHash(p)])), EXPECTED);
});
