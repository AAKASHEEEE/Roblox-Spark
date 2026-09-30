import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  BUILTIN_COMPONENTS, CharacterRegistry, canonicalJson, contentHashOf, createCatalog, evaluateProfile, serializeManifest, sha256Hex,
  type CharacterProfile, type Finding,
} from '../packages/characters/src/index.ts';
import { ROOT } from './helpers.ts';

const EXAMPLE = readFileSync(join(ROOT, 'packages/characters/examples/zapp@1.0.0.profile.json'), 'utf8');
const base = (): any => JSON.parse(EXAMPLE);
const codes = (fs: Finding[] | undefined) => (fs ?? []).map((f) => f.code);
const errCodes = (raw: unknown, opts = {}) => codes(evaluateProfile(raw, undefined, opts).errors);
const warnCodes = (raw: unknown, opts = {}) => codes(evaluateProfile(raw, undefined, opts).warnings);
const ok = <T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> => { assert.equal(r.ok, true, JSON.stringify(r)); return r as Extract<T, { ok: true }>; };
function lockNew(reg: CharacterRegistry, p: CharacterProfile) {
  const { key } = ok(reg.createDraft(p));
  ok(reg.validate(key)); ok(reg.approve(key, 'reviewer')); return ok(reg.lock(key));
}

test('strict schema: example is valid; unknown keys and missing fields are rejected', () => {
  const ev = evaluateProfile(base(), undefined, { environments: ['classroom@1.1.0'] });
  assert.deepEqual(ev.errors, []); assert.equal(ev.ok, true);
  const p = base(); p.mesh = 'zapp.glb'; p.appearance.hair.path = '/tmp/x';
  assert.deepEqual(errCodes(p), ['SCHEMA_UNKNOWN_KEY', 'SCHEMA_UNKNOWN_KEY']);
  const q = base(); delete q.motionProfile; q.schemaVersion = '2.0';
  assert.ok(errCodes(q).length === 2 && errCodes(q).every((c) => c === 'SCHEMA_INVALID'));
});

test('prototype-pollution keys are rejected anywhere, before the schema runs', () => {
  const raw = JSON.parse(EXAMPLE.replace('"palette": { "skin": "#f2c53d" }', '"palette": { "skin": "#f2c53d" }, "__proto__": { "locked": true }'));
  assert.deepEqual(errCodes(raw), ['PROTOTYPE_KEY_REJECTED']);
  const p = base(); p.appearance.hair.palette = JSON.parse('{"constructor":"#ffffff"}');
  assert.deepEqual(errCodes(p), ['PROTOTYPE_KEY_REJECTED']);
  assert.equal(({} as any).locked, undefined);
});

test('reference validation: executables, archives, extension/dimension mismatches, attestation', () => {
  const mk = (patch: object) => { const p = base(); Object.assign(p.references[0], patch); return errCodes(p); };
  assert.ok(mk({ displayFilename: 'front.png.exe' }).includes('REFERENCE_EXECUTABLE_REJECTED'));
  assert.ok(mk({ mimeType: 'application/x-msdownload' }).includes('REFERENCE_EXECUTABLE_REJECTED'));
  assert.ok(mk({ displayFilename: 'refs.zip', mimeType: 'application/zip' }).includes('REFERENCE_ARCHIVE_REJECTED'));
  assert.ok(mk({ displayFilename: 'front.jpg' }).includes('REFERENCE_EXTENSION_MISMATCH'));
  assert.ok(mk({ dimensions: undefined }).includes('REFERENCE_DIMENSIONS_REQUIRED'));
  assert.ok(mk({ userAttestation: { ...base().references[0].userAttestation, attested: false } }).includes('REFERENCE_ATTESTATION_MISSING'));
  assert.ok(mk({ storageRef: 'cas://references/sha256/' + '3'.repeat(64) }).includes('REFERENCE_HASH_MISMATCH'));
  assert.ok(mk({ redistributable: true }).includes('LICENSE_REDISTRIBUTION_FORBIDDEN'));
  const glb = base(); Object.assign(glb.references[0], { type: 'owned_glb', mimeType: 'model/gltf-binary', displayFilename: 'body.glb', dimensions: undefined });
  assert.deepEqual(errCodes(glb), []); assert.ok(warnCodes(glb).includes('REFERENCE_NOT_IMPORTED'));
});

test('path traversal and non-CAS storage references are rejected', () => {
  for (const [field, value] of [['displayFilename', '../../etc/passwd.png'], ['displayFilename', 'a\\b.png'], ['displayFilename', '%2e%2e.png'],
    ['storageRef', 'cas://references/sha256/../../' + '1'.repeat(58)], ['storageRef', '/var/data/front.png'], ['storageRef', 'C:\\refs\\front.png']]) {
    const p = base(); p.references[0][field] = value;
    const c = errCodes(p);
    assert.ok(c.includes('REFERENCE_PATH_TRAVERSAL'), `${field}=${value}: ${c}`);
  }
  const p = base(); p.references[0].storageRef = 'https://example.com/x.png';
  assert.ok(errCodes(p).includes('REFERENCE_STORAGE_INVALID'));
});

test('unsupported MIME types are rejected per reference type', () => {
  const mk = (type: string, mimeType: string, displayFilename: string) => { const p = base(); Object.assign(p.references[0], { type, mimeType, displayFilename }); return errCodes(p); };
  assert.ok(mk('front_image', 'image/gif', 'front.gif').includes('REFERENCE_MIME_UNSUPPORTED'));
  assert.ok(mk('front_image', 'model/gltf-binary', 'front.glb').includes('REFERENCE_MIME_UNSUPPORTED'));
  assert.ok(mk('front_image', 'image/svg+xml', 'front.svg').includes('REFERENCE_EXECUTABLE_REJECTED'));
  assert.deepEqual(mk('palette_image', 'image/webp', 'palette.webp'), []);
});

test('provenance is required and gates production locking', () => {
  const p = base(); delete p.references[0].provenance; delete p.license;
  assert.deepEqual(errCodes(p), ['PROVENANCE_MISSING', 'PROVENANCE_MISSING']);
  const set = (f: (p: any) => void) => { const q = base(); f(q); return errCodes(q); };
  assert.ok(set((q) => { q.license.source = 'unknown'; }).includes('LICENSE_PROVENANCE_UNKNOWN'));
  assert.ok(set((q) => { q.references[1].provenance.source = 'prohibited'; }).includes('LICENSE_PROHIBITED'));
  assert.ok(set((q) => { q.references[0].provenance.attributionRequired = true; }).includes('LICENSE_ATTRIBUTION_MISSING'));
  assert.ok(set((q) => { q.references[0].provenance.allowsDerivative = false; }).includes('LICENSE_DERIVATIVE_FORBIDDEN'));
  assert.ok(set((q) => { q.references[0].mayAppearInOutput = true; q.references[0].provenance.allowsOutput = false; }).includes('LICENSE_OUTPUT_FORBIDDEN'));
  assert.ok(set((q) => { q.license.source = 'licensed'; delete q.license.licenseName; }).includes('LICENSE_NAME_MISSING'));
  // an unknown-provenance draft can be stored but never validated/locked
  const reg = new CharacterRegistry(); const q = base(); q.license.source = 'unknown';
  const { key } = ok(reg.createDraft(q));
  assert.equal(reg.validate(key).ok, false); assert.equal(reg.approve(key, 'x').ok, false); assert.equal(reg.lock(key).ok, false);
});

test('requests to copy a protected character are blocked; inspiration mentions only warn', () => {
  const p = base(); p.role.personality = 'Make him an exact copy of Pikachu but blocky.';
  assert.ok(errCodes(p).includes('PROTECTED_CHARACTER_REQUEST'));
  const n = base(); n.displayName = 'Mario'; assert.ok(errCodes(n).includes('PROTECTED_CHARACTER_REQUEST'));
  const r = base(); r.references[1].details = 'Clone the bacon hair avatar 1:1.'; assert.ok(errCodes(r).includes('PROTECTED_CHARACTER_REQUEST'));
  const w = base(); w.role.personality = 'Energy of a Saturday cartoon, nothing like Sonic the Hedgehog.';
  assert.deepEqual(errCodes(w), []); assert.ok(warnCodes(w).includes('PROTECTED_NAME_MENTIONED'));
});

test('a registered profile resolves to a pinned modular recipe with palette overrides', () => {
  const p = base(); p.appearance.hair.palette = { primary: '#ff0000' };
  const { recipe } = evaluateProfile(p);
  assert.ok(recipe);
  assert.equal(recipe.rig, 'blocky_biped_v1');
  assert.equal(recipe.body.ref, 'block-teen-slim@1.0.0');
  assert.deepEqual(recipe.hair.palette, { primary: '#ff0000', streak: '#19d3e6' }); // override + registered default
  assert.deepEqual(recipe.clothing.map((c) => [c.ref, c.slot]), [['top-zip-hoodie@1.0.0', 'outer'], ['top-tshirt@1.0.0', 'top'], ['bottom-cargo@1.0.0', 'bottom']]);
  assert.deepEqual(recipe.accessories.map((a) => [a.ref, a.anchor]), [['acc-wristband@1.0.0', 'wrist_r']]);
  for (const e of [recipe.body, recipe.head, recipe.hair, recipe.shoes, recipe.faceSet, recipe.motion]) assert.match(e.hash, /^sha256:[0-9a-f]{64}$/);
  const bad = base(); bad.appearance.hair.palette = { glitter: '#ffffff' };
  assert.deepEqual(errCodes(bad), ['PALETTE_SLOT_UNKNOWN']);
  const unpinned = base(); unpinned.appearance.hair.assetId = 'hair-spiky-front@latest';
  assert.deepEqual(errCodes(unpinned), ['SCHEMA_INVALID']);
});

test('unknown components are ASSET_COMPONENT_UNAVAILABLE with approval-gated suggestions; nothing is invented', () => {
  const p = base(); p.appearance.hair.assetId = 'hair-spiky-mohawk@1.0.0';
  const ev = evaluateProfile(p);
  assert.equal(ev.ok, false); assert.equal(ev.recipe, undefined); assert.equal(ev.contentHash, undefined);
  const f = ev.errors.find((e) => e.code === 'ASSET_COMPONENT_UNAVAILABLE')!;
  assert.equal(f.path, '$.appearance.hair');
  assert.equal(f.suggestion?.category, 'hair'); assert.equal(f.suggestion?.requiresApproval, true);
  assert.equal(f.suggestion?.candidates[0], 'hair-spiky-front@1.0.0');
  const wrongCat = base(); wrongCat.appearance.hair.assetId = 'acc-cap@1.0.0';
  assert.deepEqual(errCodes(wrongCat), ['COMPONENT_CATEGORY_MISMATCH']);
});

test('no silent substitution: only an explicit approval swaps a component, and the swap is part of identity', () => {
  const p = base(); p.appearance.clothing[0] = { assetId: 'top-rain-poncho@1.0.0', slot: 'outer', palette: { primary: '#1f4fd1' } };
  assert.ok(errCodes(p).includes('ASSET_COMPONENT_UNAVAILABLE'));
  p.substitutions = [{ requested: 'top-rain-poncho@1.0.0', substitute: 'top-bomber-jacket@1.0.0', approvedBy: 'art-director', reason: 'poncho not built yet' }];
  const ev = evaluateProfile(p);
  assert.equal(ev.ok, true, JSON.stringify(ev.errors));
  assert.deepEqual([ev.recipe!.clothing[0].ref, ev.recipe!.clothing[0].substitutedFrom], ['top-bomber-jacket@1.0.0', 'top-rain-poncho@1.0.0']);
  assert.ok(codes(ev.warnings).includes('COMPONENT_SUBSTITUTED'));
  assert.notEqual(ev.contentHash, evaluateProfile(base()).contentHash);
  const direct = base(); direct.appearance.clothing[0] = { assetId: 'top-bomber-jacket@1.0.0', slot: 'outer', palette: { primary: '#1f4fd1' } };
  assert.notEqual(ev.contentHash, evaluateProfile(direct).contentHash, 'approved substitution is recorded, not laundered');
  const bogus = base(); bogus.appearance.clothing[0].assetId = 'top-rain-poncho@1.0.0';
  bogus.substitutions = [{ requested: 'top-rain-poncho@1.0.0', substitute: 'top-made-up@1.0.0', approvedBy: 'x', reason: 'y' }];
  assert.deepEqual(errCodes(bogus).sort(), ['ASSET_COMPONENT_UNAVAILABLE', 'SUBSTITUTION_INVALID']);
});

test('locking is gated by lifecycle and deterministic across registries and key order', () => {
  const reg = new CharacterRegistry();
  const { key } = ok(reg.createDraft(base()));
  assert.equal(reg.lock(key).ok, false); assert.equal(reg.approve(key, 'r').ok, false); // must validate, then approve
  ok(reg.validate(key)); ok(reg.approve(key, 'reviewer'));
  const a = ok(reg.lock(key));
  const rev = (v: any): any => (Array.isArray(v) ? v.map(rev) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).reverse().map((k) => [k, rev(v[k])])) : v);
  const reordered = rev(base());
  assert.notEqual(Object.keys(reordered)[0], Object.keys(base())[0]);
  const b = lockNew(new CharacterRegistry(), reordered);
  assert.equal(a.manifest.contentHash, b.manifest.contentHash);
  assert.equal(serializeManifest(a.manifest), serializeManifest(b.manifest));
  assert.deepEqual(a.pin, { characterId: 'zapp', version: '1.0.0', contentHash: a.manifest.contentHash });
  assert.equal(Object.isFrozen(a.manifest.recipe.hair.palette), true);
  assert.throws(() => { (a.manifest.recipe.hair.palette as any).primary = '#000000'; });
});

test('identity changes on a locked version require a new version', () => {
  const reg = new CharacterRegistry();
  const v1 = lockNew(reg, base());
  const same = base(); same.appearance.accessories[0].anchor = 'wrist_l';
  assert.deepEqual(codes((reg.createDraft(same) as any).errors), ['IDENTITY_CHANGE_REQUIRES_NEW_VERSION']);
  assert.deepEqual(codes((reg.createDraft(base()) as any).errors), ['VERSION_ALREADY_LOCKED']);
  assert.equal(reg.deriveNextVersion('zapp@1.0.0', '1.0.0').ok, false);
  const { draft } = ok(reg.deriveNextVersion('zapp@1.0.0', '1.1.0'));
  draft.appearance.accessories[0].anchor = 'wrist_l';
  const v2 = lockNew(reg, draft);
  assert.notEqual(v2.manifest.contentHash, v1.manifest.contentHash);
  const old = base(); old.version = '0.9.0';
  assert.deepEqual(codes((reg.createDraft(old) as any).errors), ['VERSION_NOT_INCREASING']);
});

test('the same version can never be re-imported with a different hash', () => {
  const reg = new CharacterRegistry();
  const { manifest } = lockNew(reg, base());
  const tampered = JSON.parse(serializeManifest(manifest)); tampered.proportions.heightM = 1.6;
  assert.ok(codes((new CharacterRegistry().importLocked(tampered) as any).errors).includes('CONTENT_HASH_MISMATCH'));
  const { recipe: _r, contentHash: _h, ...rest } = tampered;
  tampered.contentHash = evaluateProfile({ ...rest, status: 'draft', locked: false }).contentHash;
  assert.match(tampered.contentHash, /^sha256:/);
  assert.deepEqual(codes((reg.importLocked(tampered) as any).errors), ['IDENTITY_CHANGE_REQUIRES_NEW_VERSION']);
  const fresh = new CharacterRegistry();
  assert.equal(ok(fresh.importLocked(JSON.parse(serializeManifest(manifest)))).manifest.contentHash, manifest.contentHash);
});

test('deprecation keeps old versions resolvable and listed', () => {
  const reg = new CharacterRegistry();
  const v1 = lockNew(reg, base());
  const { draft } = ok(reg.deriveNextVersion('zapp@1.0.0', '1.1.0')); draft.appearance.hair.palette.primary = '#ff7a26';
  lockNew(reg, draft);
  ok(reg.deprecate('zapp@1.0.0', 'hair tone retuned', '1.1.0'));
  const r = ok(reg.resolvePin(v1.pin));
  assert.equal(r.deprecated, true); assert.deepEqual(codes(r.warnings), ['PROFILE_DEPRECATED']);
  assert.equal(r.manifest.contentHash, v1.manifest.contentHash);
  assert.deepEqual(reg.versions('zapp').map((v) => [v.version, v.state]), [['1.0.0', 'deprecated'], ['1.1.0', 'locked']]);
  assert.equal(reg.deprecate('nobody@1.0.0', 'x').ok, false);
});

test('episode pins resolve the exact pinned version and hash', () => {
  const reg = new CharacterRegistry();
  const v1 = lockNew(reg, base());
  const { draft } = ok(reg.deriveNextVersion('zapp@1.0.0', '1.1.0')); draft.proportions.heightM = 1.6;
  const v2 = lockNew(reg, draft);
  const r = ok(reg.resolveEpisodePins([v1.pin, v2.pin]));
  assert.deepEqual(r.manifests.map((m) => [m.version, m.proportions.heightM]), [['1.0.0', 1.55], ['1.1.0', 1.6]]);
  const bad = reg.resolveEpisodePins([{ ...v1.pin, contentHash: v2.pin.contentHash }]) as any;
  assert.deepEqual(codes(bad.errors), ['PIN_HASH_MISMATCH']); assert.equal(bad.errors[0].path, '$.characters[0].contentHash');
  const d = base(); d.version = '1.2.0'; ok(reg.createDraft(d));
  assert.deepEqual(codes((reg.resolvePin({ characterId: 'zapp', version: '1.2.0', contentHash: v1.pin.contentHash }) as any).errors), ['PIN_NOT_LOCKED']);
});

test('"latest", ranges and partial pins are never resolved at render time', () => {
  const reg = new CharacterRegistry();
  const v1 = lockNew(reg, base());
  for (const version of ['latest', '^1.0.0', '1.x', '*', '']) assert.deepEqual(codes((reg.resolvePin({ ...v1.pin, version }) as any).errors), ['PIN_NOT_EXACT'], version);
  assert.deepEqual(codes((reg.resolvePin({ characterId: 'zapp', version: '1.0.0' }) as any).errors), ['PIN_INVALID']);
  assert.deepEqual(codes((reg.resolvePin({ ...v1.pin, extra: 1 }) as any).errors), ['PIN_INVALID']);
  assert.equal((reg as any).latest, undefined);
});

test('expression compatibility with the face set and head', () => {
  const p = base(); p.expressions = ['neutral', 'smug'];
  assert.deepEqual(errCodes(p), ['EXPRESSION_UNAVAILABLE']);
  const d = base(); d.expressions = ['shock', 'shock']; assert.deepEqual(errCodes(d), ['EXPRESSION_DUPLICATE']);
  assert.ok(warnCodes(d).includes('EXPRESSION_NO_NEUTRAL'));
  const h = base(); h.appearance.head.preset = 'head-square-soft@1.0.0';
  assert.deepEqual(errCodes(h), ['FACE_SET_HEAD_INCOMPATIBLE']);
});

test('motion compatibility: actions, height range and required anchors', () => {
  assert.deepEqual(errCodes(base(), { requiredActions: ['walk', 'hover'] }), ['MOTION_ACTION_UNAVAILABLE']);
  const k = base(); k.motionProfile = 'motion-kid-bouncy@1.0.0';
  assert.deepEqual(errCodes(k), ['MOTION_HEIGHT_INCOMPATIBLE']);
  const handless = BUILTIN_COMPONENTS.map((c) => (c.id === 'block-teen-slim' ? { ...c, anchors: c.anchors!.filter((a) => a !== 'hand_l') } : c));
  const c = codes(evaluateProfile(base(), createCatalog(handless)).errors);
  assert.ok(c.includes('ANCHOR_MISSING') && c.includes('MOTION_ANCHOR_MISSING'), String(c));
});

test('accessory limits, anchors, clothing intersections and environment scale', () => {
  const acc = (assetId: string, anchor: string, palette = {}) => ({ assetId, anchor, palette });
  const p = base(); p.appearance.accessories = [acc('acc-wristband@1.0.0', 'wrist_r'), acc('acc-wristband@1.0.0', 'wrist_l'), acc('acc-scarf@1.0.0', 'neck'), acc('acc-backpack@1.0.0', 'back')];
  const c = errCodes(p);
  assert.ok(c.includes('ACCESSORY_LIMIT_EXCEEDED'));
  assert.ok(c.includes('CLOTHING_INTERSECTION'), 'scarf vs hoodie collar share "neck"');
  const cap = base(); cap.appearance.accessories.push(acc('acc-cap@1.0.0', 'head_top'));
  assert.deepEqual(errCodes(cap), ['CLOTHING_INTERSECTION']); // cap vs spiky hair
  const anchor = base(); anchor.appearance.accessories = [acc('acc-glasses-square@1.0.0', 'back')];
  assert.deepEqual(errCodes(anchor), ['ACCESSORY_ANCHOR_INVALID']);
  const tall = base(); tall.bodyPreset = 'block-teen-standard@1.0.0'; tall.proportions.heightM = 1.85; tall.proportions.headScale = 1.3;
  assert.ok(errCodes(tall, { environments: ['classroom@1.1.0'] }).includes('ENVIRONMENT_SCALE_INCOMPATIBLE'));
  assert.deepEqual(errCodes(base(), { environments: ['moonbase@9.9.9'] }), ['ENVIRONMENT_UNKNOWN']);
});

test('deterministic hashing: sha256 matches node, lifecycle fields excluded, every identity field included', () => {
  for (const s of ['', 'abc', 'x'.repeat(1000), 'héllo ✨']) assert.equal(sha256Hex(s), createHash('sha256').update(s).digest('hex'));
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: 0 }] }), '{"a":[2,{"c":0,"d":1}],"b":1}');
  assert.equal(createCatalog().hash, createCatalog().hash);
  assert.equal(contentHashOf({ a: 1, b: 2 }), contentHashOf({ b: 2, a: 1 }));
  const h0 = evaluateProfile(base()).contentHash!;
  const withLifecycle = base(); withLifecycle.status = 'validated';
  assert.equal(evaluateProfile(withLifecycle).contentHash, h0);
  const mutations: ((p: any) => void)[] = [
    (p) => { p.appearance.head.palette.skin = '#f2c53e'; }, (p) => { p.proportions.limbScale = 1.01; }, (p) => { p.expressions.pop(); },
    (p) => { p.appearance.accessories = []; }, (p) => { p.displayName = 'Zap'; }, (p) => { p.references[1].details += '!'; },
    (p) => { p.expressions.reverse(); }, (p) => { p.voice.pace = 'normal'; },
  ];
  const hashes = mutations.map((m) => { const p = base(); m(p); return evaluateProfile(p).contentHash; });
  assert.equal(new Set([h0, ...hashes]).size, mutations.length + 1);
});
