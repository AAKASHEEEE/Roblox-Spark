import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  BUILTIN_COMPONENTS, CharacterRegistry, canonicalJson, contentHashOf, createCatalog, evaluateProfile, serializeManifest, sha256Hex,
  type CharacterProfile, type Finding, type Reference, type ReferenceVerification, type TrustedWorkflow,
} from '../packages/characters/src/index.ts';
import { ROOT } from './helpers.ts';

const EXAMPLE = readFileSync(join(ROOT, 'packages/characters/examples/zapp@1.0.0.profile.json'), 'utf8');
const draft = (): any => JSON.parse(EXAMPLE);

// ---------------------------------------------------------------------------------------------------------------
// TEST-ONLY FIXTURES. Synthetic bytes and an in-memory stand-in for the authenticated ingest/approval service.
// The test explicitly plays the trusted workflow: it stores bytes, records attestations and names the accounts
// it authenticated. Nothing here exists in the package.
// ---------------------------------------------------------------------------------------------------------------
const hex = (b: string) => createHash('sha256').update(b).digest('hex');
const ATTESTER = 'fixture-idp:alice-artist-7f3';
const REVIEWER = 'fixture-idp:bo-reviewer-19c';
class FixtureTrust implements TrustedWorkflow {
  bytes = new Map<string, { data: string; mime: string }>();
  attestations = new Map<string, string>();
  actors = new Set([ATTESTER, REVIEWER]);
  verifyReference(ref: Readonly<Reference>): ReferenceVerification {
    const stored = ref.storageRef ? this.bytes.get(ref.storageRef) : undefined;
    const bytes = !stored ? 'unknown' : `sha256:${hex(stored.data)}` === ref.contentHash && Buffer.byteLength(stored.data) === ref.byteSize && stored.mime === ref.mimeType ? 'verified' : 'mismatch';
    const rec = this.attestations.get(`${ref.referenceId}|${ref.contentHash}`);
    const attestation = !rec ? 'unknown' : rec === canonicalJson(ref.userAttestation) ? 'verified' : 'mismatch';
    return { bytes, attestation };
  }
  isAuthenticatedActor(id: string) { return this.actors.has(id); }
  /** simulate a real upload: store bytes, hash them, record the human's explicit attestation */
  ingest(referenceId: string, type: Reference['type'], data: string, mimeType: string, displayFilename: string, extra: Partial<Reference> = {}): Reference {
    const h = hex(data);
    const ref: Reference = {
      referenceId, type, contentHash: `sha256:${h}`, mimeType, byteSize: Buffer.byteLength(data), displayFilename,
      provenance: { source: 'original', owner: ATTESTER, attributionRequired: false, allowsDerivative: true, allowsOutput: true, allowsRedistribution: false },
      userAttestation: { attested: true, attestedBy: ATTESTER, attestedAt: '2026-09-30T06:00:00Z', statement: 'Fixture statement recorded by the test workflow.' },
      storageRef: `cas://references/sha256/${h}`, redistributable: false, mayAppearInOutput: false, ...extra,
    };
    this.bytes.set(ref.storageRef!, { data, mime: mimeType });
    this.attestations.set(`${referenceId}|${ref.contentHash}`, canonicalJson(ref.userAttestation));
    return ref;
  }
}
const trust = new FixtureTrust();
const FRONT = trust.ingest('ref_front', 'front_image', 'fixture front image bytes', 'image/png', 'front.png', { dimensions: { width: 64, height: 64 } });
const NOTES = trust.ingest('ref_notes', 'written_details', 'fixture notes bytes', 'text/plain', 'notes.txt', { details: 'Test-only written details.' });
const GLB = trust.ingest('ref_glb', 'owned_glb', 'fixture glb bytes', 'model/gltf-binary', 'body.glb');
const WEBP = trust.ingest('ref_palette', 'palette_image', 'fixture palette bytes', 'image/webp', 'palette.webp', { dimensions: { width: 8, height: 8 } });
const FIXTURE_LICENSE = { source: 'original', owner: ATTESTER, attributionRequired: false, allowsDerivative: true, allowsOutput: true, allowsRedistribution: false };
/** example draft + test-fixture evidence -> a profile that can validate */
const base = (): any => ({ ...draft(), license: structuredClone(FIXTURE_LICENSE), references: structuredClone([FRONT, NOTES]) });

const codes = (fs: Finding[] | undefined) => (fs ?? []).map((f) => f.code);
const errCodes = (raw: unknown, opts = {}) => codes(evaluateProfile(raw, undefined, { trust, ...opts }).errors);
const warnCodes = (raw: unknown, opts = {}) => codes(evaluateProfile(raw, undefined, { trust, ...opts }).warnings);
const hashOf = (raw: unknown) => evaluateProfile(raw, undefined, { trust }).contentHash;
const ok = <T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> => { assert.equal(r.ok, true, JSON.stringify(r)); return r as Extract<T, { ok: true }>; };
const errsOf = (r: { ok: boolean }) => codes((r as any).errors);
const registry = (t: TrustedWorkflow = trust) => new CharacterRegistry(t);
function lockNew(reg: CharacterRegistry, p: CharacterProfile) {
  const { key } = ok(reg.createDraft(p));
  ok(reg.validate(key)); ok(reg.approve(key, REVIEWER)); return ok(reg.lock(key));
}
const deepKeys = (v: unknown, out: string[] = []): string[] => { if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); deepKeys(x, out); } return out; };

// ---------------------------------------------------------------------------------------------------------------

test('sanitized Zapp example is a draft with no fabricated references, owners, hashes or attestations', () => {
  const d = draft();
  assert.equal(d.status, 'draft'); assert.equal(d.locked, false);
  assert.deepEqual(d.references, []); assert.equal(d.license, undefined); assert.equal(d.voice, undefined);
  for (const k of ['userAttestation', 'attestedBy', 'attestedAt', 'attested', 'storageRef', 'contentHash', 'owner', 'provenance']) assert.ok(!deepKeys(d).includes(k), k);
  assert.doesNotMatch(EXAMPLE, /sha256|cas:\/\/|attest|in-house|\d{4}-\d{2}-\d{2}T/i);
  // recipe + identity rules preserved (identity rules come from the repo's locked Zapp manifest)
  const repo = JSON.parse(readFileSync(join(ROOT, 'assets/characters/zapp@1.0.0.json'), 'utf8'));
  for (const r of d.identityRules) assert.ok(repo.identityRules.includes(r), r);
  assert.deepEqual(d.expressions, repo.allowedExpressions);
  const ev = evaluateProfile(d, undefined, { trust });
  assert.ok(ev.recipe); assert.deepEqual(ev.recipe.accessories.map((a) => [a.ref, a.anchor]), [['acc-wristband@1.0.0', 'wrist_r']]);
  assert.deepEqual(codes(ev.errors), ['PROVENANCE_MISSING'], 'draft cannot validate until the owner supplies a licence record');
});

test('an incomplete draft can be stored and edited but cannot be validated, approved or locked', () => {
  const reg = registry();
  const p = draft(); p.references = [{ referenceId: 'ref_side', type: 'side_image', displayFilename: 'side.png' }];
  const { key } = ok(reg.createDraft(p));
  assert.deepEqual(reg.get(key)!.references[0], { referenceId: 'ref_side', type: 'side_image', displayFilename: 'side.png' }, 'nothing filled in');
  p.appearance.hair.palette.primary = '#ff7a26';
  ok(reg.createDraft(p)); // drafts are editable
  assert.equal(reg.get(key)!.appearance.hair.palette.primary, '#ff7a26');
  const v = reg.validate(key);
  assert.equal(v.ok, false);
  for (const c of ['REFERENCE_EVIDENCE_INCOMPLETE', 'PROVENANCE_MISSING', 'REFERENCE_ATTESTATION_MISSING', 'REFERENCE_DIMENSIONS_REQUIRED']) assert.ok(errsOf(v).includes(c), c);
  assert.deepEqual(errsOf(reg.approve(key, REVIEWER)), ['LIFECYCLE_INVALID']);
  assert.deepEqual(errsOf(reg.lock(key)), ['LIFECYCLE_INVALID']);
  assert.equal(reg.versions('zapp')[0].state, 'draft');
});

test('no helper manufactures an attestation, byte verification or approval', () => {
  assert.throws(() => new (CharacterRegistry as any)(), /TrustedWorkflow/);
  const reg = registry();
  const p = base(); delete p.references[0].userAttestation;
  const { key } = ok(reg.createDraft(p));
  assert.equal(reg.validate(key).ok, false);
  assert.equal(reg.get(key)!.references[0].userAttestation, undefined);
  assert.equal(evaluateProfile(p, undefined, { trust }).profile!.references[0].userAttestation, undefined);
  // derived versions of a clean draft never gain evidence
  const v1 = lockNew(reg, { ...draft(), license: structuredClone(FIXTURE_LICENSE) } as any);
  const { draft: next } = ok(reg.deriveNextVersion(`zapp@${v1.manifest.version}`, '1.1.0'));
  assert.ok(!deepKeys(next).includes('userAttestation'));
  // source guard: no default attester, timestamp, attested=true or hard-coded 'verified' result anywhere in the package
  const dir = join(ROOT, 'packages/characters/src');
  for (const f of readdirSync(dir)) {
    const src = readFileSync(join(dir, f), 'utf8');
    assert.doesNotMatch(src, /attested\s*:\s*true|attested(By|At)\s*[:=]\s*['"`]|['"]verified['"]\s*[,}]|isAuthenticatedActor\s*[:=(][^)]*\)\s*(=>|\{)\s*(return\s+)?true/, f);
  }
});

test('empty, generic and placeholder actor identities are rejected at validation and approval', () => {
  for (const [who, code] of [['', 'ACTOR_MISSING'], ['owner', 'ACTOR_ID_INVALID'], ['studio-owner', 'ACTOR_ID_INVALID'], ['github:owner', 'ACTOR_PLACEHOLDER'],
    ['github:reviewer', 'ACTOR_PLACEHOLDER'], ['user:example-1', 'ACTOR_PLACEHOLDER'], ['github:xxx', 'ACTOR_PLACEHOLDER'], ['test:john_doe', 'ACTOR_PLACEHOLDER'],
    ['github:real-looking-dev', 'ACTOR_UNAUTHENTICATED']]) {
    const p = base(); p.references[0].userAttestation.attestedBy = who;
    assert.ok(errCodes(p).includes(code), `${who}: ${errCodes(p)}`);
  }
  const reg = registry();
  const { key } = ok(reg.createDraft(base())); ok(reg.validate(key));
  assert.deepEqual(errsOf(reg.approve(key, '')), ['ACTOR_MISSING']);
  assert.deepEqual(errsOf(reg.approve(key, 'reviewer')), ['ACTOR_ID_INVALID']);
  assert.deepEqual(errsOf(reg.approve(key, 'github:approver')), ['ACTOR_PLACEHOLDER']);
  assert.deepEqual(errsOf(reg.approve(key, 'github:unknown-person-42')), ['ACTOR_UNAUTHENTICATED']);
  ok(reg.approve(key, REVIEWER));
  assert.equal(reg.versions('zapp')[0].approvedBy, REVIEWER);
});

test('missing or failed actual-byte verification blocks validation, approval and locking', () => {
  // no trusted workflow at all
  const none = codes(evaluateProfile(base()).errors);
  for (const c of ['REFERENCE_BYTES_UNVERIFIED', 'REFERENCE_ATTESTATION_UNVERIFIED', 'ACTOR_UNAUTHENTICATED']) assert.ok(none.includes(c), c);
  // workflow that never stored the bytes
  const empty = new FixtureTrust(); empty.attestations = trust.attestations;
  assert.equal(registry(empty).validate(ok(registry(empty).createDraft(base())).key).ok, false);
  const reg0 = registry(empty); const k0 = ok(reg0.createDraft(base())).key;
  assert.ok(errsOf(reg0.validate(k0)).includes('REFERENCE_BYTES_UNVERIFIED'));
  // bytes tampered in storage after validation -> approval re-verifies and fails
  const t = new FixtureTrust(); const f = t.ingest('ref_front', 'front_image', 'fixture front image bytes', 'image/png', 'front.png', { dimensions: { width: 64, height: 64 } });
  const p = { ...base(), references: [f] };
  const reg = registry(t); const { key } = ok(reg.createDraft(p)); ok(reg.validate(key));
  t.bytes.set(f.storageRef!, { data: 'swapped bytes', mime: 'image/png' });
  assert.ok(errsOf(reg.approve(key, REVIEWER)).includes('REFERENCE_BYTES_MISMATCH'));
  // attestation record withdrawn after approval -> lock re-verifies and fails
  t.bytes.set(f.storageRef!, { data: 'fixture front image bytes', mime: 'image/png' });
  ok(reg.validate(key)); ok(reg.approve(key, REVIEWER));
  t.attestations.clear();
  assert.ok(errsOf(reg.lock(key)).includes('REFERENCE_ATTESTATION_UNVERIFIED'));
});

test('strict schema: complete profile is valid; unknown keys and missing fields are rejected', () => {
  const ev = evaluateProfile(base(), undefined, { trust, environments: ['classroom@1.1.0'] });
  assert.deepEqual(ev.errors, []); assert.equal(ev.ok, true);
  const p = base(); p.mesh = 'zapp.glb'; p.appearance.hair.path = '/tmp/x';
  assert.deepEqual(errCodes(p), ['SCHEMA_UNKNOWN_KEY', 'SCHEMA_UNKNOWN_KEY']);
  const q = base(); delete q.motionProfile; q.schemaVersion = '2.0';
  assert.ok(errCodes(q).length === 2 && errCodes(q).every((c) => c === 'SCHEMA_INVALID'));
});

test('prototype-pollution keys are rejected anywhere, before the schema runs', () => {
  const raw = JSON.parse(EXAMPLE.replace('"skin": "#f2c53d"', '"skin": "#f2c53d", "__proto__": { "locked": true }'));
  assert.deepEqual(errCodes(raw), ['PROTOTYPE_KEY_REJECTED']);
  const p = base(); p.appearance.hair.palette = JSON.parse('{"constructor":"#ffffff"}');
  assert.deepEqual(errCodes(p), ['PROTOTYPE_KEY_REJECTED']);
  assert.equal(({} as any).locked, undefined);
});

test('reference validation: executables, archives, extension/dimension mismatches, attestation flag', () => {
  const mk = (patch: object) => { const p = base(); Object.assign(p.references[0], patch); return errCodes(p); };
  assert.ok(mk({ displayFilename: 'front.png.exe' }).includes('REFERENCE_EXECUTABLE_REJECTED'));
  assert.ok(mk({ mimeType: 'application/x-msdownload' }).includes('REFERENCE_EXECUTABLE_REJECTED'));
  assert.ok(mk({ displayFilename: 'refs.zip', mimeType: 'application/zip' }).includes('REFERENCE_ARCHIVE_REJECTED'));
  assert.ok(mk({ displayFilename: 'front.jpg' }).includes('REFERENCE_EXTENSION_MISMATCH'));
  assert.ok(mk({ dimensions: undefined }).includes('REFERENCE_DIMENSIONS_REQUIRED'));
  assert.ok(mk({ userAttestation: { ...FRONT.userAttestation, attested: false } }).includes('REFERENCE_ATTESTATION_MISSING'));
  assert.ok(mk({ storageRef: 'cas://references/sha256/' + '3'.repeat(64) }).includes('REFERENCE_HASH_MISMATCH'));
  assert.ok(mk({ redistributable: true }).includes('LICENSE_REDISTRIBUTION_FORBIDDEN'));
  const glb = { ...base(), references: [structuredClone(GLB)] };
  assert.deepEqual(errCodes(glb), []); assert.ok(warnCodes(glb).includes('REFERENCE_NOT_IMPORTED'));
});

test('path traversal and non-CAS storage references are rejected', () => {
  for (const [field, value] of [['displayFilename', '../../etc/passwd.png'], ['displayFilename', 'a\\b.png'], ['displayFilename', '%2e%2e.png'],
    ['storageRef', 'cas://references/sha256/../../' + '1'.repeat(58)], ['storageRef', '/var/data/front.png'], ['storageRef', 'C:\\refs\\front.png']]) {
    const p = base(); p.references[0][field] = value;
    assert.ok(errCodes(p).includes('REFERENCE_PATH_TRAVERSAL'), `${field}=${value}`);
  }
  const p = base(); p.references[0].storageRef = 'https://example.com/x.png';
  assert.ok(errCodes(p).includes('REFERENCE_STORAGE_INVALID'));
});

test('unsupported MIME types are rejected per reference type', () => {
  const mk = (type: string, mimeType: string, displayFilename: string) => { const p = base(); Object.assign(p.references[0], { type, mimeType, displayFilename }); return errCodes(p); };
  assert.ok(mk('front_image', 'image/gif', 'front.gif').includes('REFERENCE_MIME_UNSUPPORTED'));
  assert.ok(mk('front_image', 'model/gltf-binary', 'front.glb').includes('REFERENCE_MIME_UNSUPPORTED'));
  assert.ok(mk('front_image', 'image/svg+xml', 'front.svg').includes('REFERENCE_EXECUTABLE_REJECTED'));
  assert.deepEqual(errCodes({ ...base(), references: [structuredClone(WEBP)] }), []);
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
  assert.ok(set((q) => { q.license.source = 'licensed'; }).includes('LICENSE_NAME_MISSING'));
  const reg = registry(); const q = base(); q.license.source = 'unknown';
  const { key } = ok(reg.createDraft(q));
  assert.equal(reg.validate(key).ok, false); assert.equal(reg.approve(key, REVIEWER).ok, false); assert.equal(reg.lock(key).ok, false);
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
  const { recipe } = evaluateProfile(p, undefined, { trust });
  assert.ok(recipe);
  assert.equal(recipe.rig, 'blocky_biped_v1');
  assert.equal(recipe.body.ref, 'block-teen-slim@1.0.0');
  assert.deepEqual(recipe.hair.palette, { primary: '#ff0000', streak: '#19d3e6' });
  assert.deepEqual(recipe.clothing.map((c) => [c.ref, c.slot]), [['top-zip-hoodie@1.0.0', 'outer'], ['top-tshirt@1.0.0', 'top'], ['bottom-cargo@1.0.0', 'bottom']]);
  for (const e of [recipe.body, recipe.head, recipe.hair, recipe.shoes, recipe.faceSet, recipe.motion]) assert.match(e.hash, /^[0-9a-f]{64}$/);
  const bad = base(); bad.appearance.hair.palette = { glitter: '#ffffff' };
  assert.deepEqual(errCodes(bad), ['PALETTE_SLOT_UNKNOWN']);
  const unpinned = base(); unpinned.appearance.hair.assetId = 'hair-spiky-front@latest';
  assert.deepEqual(errCodes(unpinned), ['SCHEMA_INVALID']);
});

test('unknown components are ASSET_COMPONENT_UNAVAILABLE with approval-gated suggestions; nothing is invented', () => {
  const p = base(); p.appearance.hair.assetId = 'hair-spiky-mohawk@1.0.0';
  const ev = evaluateProfile(p, undefined, { trust });
  assert.equal(ev.ok, false); assert.equal(ev.recipe, undefined); assert.equal(ev.contentHash, undefined);
  const f = ev.errors.find((e) => e.code === 'ASSET_COMPONENT_UNAVAILABLE')!;
  assert.equal(f.path, '$.appearance.hair');
  assert.deepEqual([f.suggestion?.category, f.suggestion?.requiresApproval, f.suggestion?.candidates[0]], ['hair', true, 'hair-spiky-front@1.0.0']);
  const wrongCat = base(); wrongCat.appearance.hair.assetId = 'acc-cap@1.0.0';
  assert.deepEqual(errCodes(wrongCat), ['COMPONENT_CATEGORY_MISMATCH']);
});

test('no silent substitution: only an explicit approval swaps a component, and the swap is part of identity', () => {
  const p = base(); p.appearance.clothing[0] = { assetId: 'top-rain-poncho@1.0.0', slot: 'outer', palette: { primary: '#1f4fd1' } };
  assert.ok(errCodes(p).includes('ASSET_COMPONENT_UNAVAILABLE'));
  p.substitutions = [{ requested: 'top-rain-poncho@1.0.0', substitute: 'top-bomber-jacket@1.0.0', approvedBy: REVIEWER, reason: 'poncho not built yet' }];
  const ev = evaluateProfile(p, undefined, { trust });
  assert.equal(ev.ok, true, JSON.stringify(ev.errors));
  assert.deepEqual([ev.recipe!.clothing[0].ref, ev.recipe!.clothing[0].substitutedFrom], ['top-bomber-jacket@1.0.0', 'top-rain-poncho@1.0.0']);
  assert.ok(codes(ev.warnings).includes('COMPONENT_SUBSTITUTED'));
  const direct = base(); direct.appearance.clothing[0] = { assetId: 'top-bomber-jacket@1.0.0', slot: 'outer', palette: { primary: '#1f4fd1' } };
  assert.notEqual(ev.contentHash, hashOf(direct), 'approved substitution is recorded, not laundered');
  const bogus = base(); bogus.appearance.clothing[0].assetId = 'top-rain-poncho@1.0.0';
  bogus.substitutions = [{ requested: 'top-rain-poncho@1.0.0', substitute: 'top-made-up@1.0.0', approvedBy: REVIEWER, reason: 'y' }];
  assert.deepEqual(errCodes(bogus).sort(), ['ASSET_COMPONENT_UNAVAILABLE', 'SUBSTITUTION_INVALID']);
});

test('locking is gated by lifecycle and deterministic across registries and key order', () => {
  const reg = registry();
  const { key } = ok(reg.createDraft(base()));
  assert.equal(reg.lock(key).ok, false); assert.equal(reg.approve(key, REVIEWER).ok, false);
  ok(reg.validate(key)); ok(reg.approve(key, REVIEWER));
  const a = ok(reg.lock(key));
  const rev = (v: any): any => (Array.isArray(v) ? v.map(rev) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).reverse().map((k) => [k, rev(v[k])])) : v);
  const b = lockNew(registry(), rev(base()));
  assert.equal(serializeManifest(a.manifest), serializeManifest(b.manifest));
  assert.deepEqual(a.pin, { characterId: 'zapp', version: '1.0.0', contentHash: a.manifest.contentHash });
  assert.throws(() => { (a.manifest.recipe.hair.palette as any).primary = '#000000'; });
  assert.throws(() => { (a.manifest.references[0].userAttestation as any).attestedBy = 'x'; });
});

test('audit-relevant changes alter the hash and require a new version; lifecycle fields do not', () => {
  const reg = registry();
  const v1 = lockNew(reg, base());
  const h0 = v1.manifest.contentHash;
  const alt = BUILTIN_COMPONENTS.map((c) => (c.id === 'hair-spiky-front' ? { ...c, palette: { ...c.palette, streak: '#00ffee' } } : c));
  assert.notEqual(evaluateProfile(base(), createCatalog(alt), { trust }).contentHash, h0, 'resolved component hash/colour is hashed');
  const mutations: [string, (p: any) => void][] = [
    ['reference contentHash', (p) => { p.references[0].contentHash = 'sha256:' + 'a'.repeat(64); }],
    ['reference owner', (p) => { p.references[0].provenance.owner = REVIEWER; }],
    ['licence terms', (p) => { p.license.allowsRedistribution = true; }],
    ['attribution', (p) => { p.license.attributionText = 'Credit: fixture'; }],
    ['attestation statement', (p) => { p.references[0].userAttestation.statement += '.'; }],
    ['attestation time', (p) => { p.references[0].userAttestation.attestedAt = '2026-09-30T06:00:01Z'; }],
    ['attestation actor', (p) => { p.references[0].userAttestation.attestedBy = REVIEWER; }],
    ['identity rules', (p) => { p.identityRules.push('Always blinks twice.'); }],
    ['substitutions', (p) => { p.substitutions = [{ requested: 'hair-x@1.0.0', substitute: 'hair-buzz@1.0.0', approvedBy: REVIEWER, reason: 'r' }]; }],
    ['component id', (p) => { p.appearance.shoes.assetId = 'shoes-hightop@1.0.0'; p.appearance.shoes.palette = {}; }],
    ['component colour', (p) => { p.appearance.head.palette.skin = '#f2c53e'; }],
    ['proportions', (p) => { p.proportions.limbScale = 1.01; }],
    ['expressions', (p) => { p.expressions.reverse(); }],
    ['motion', (p) => { p.motionProfile = 'motion-calm-teen@1.0.0'; }],
    ['face', (p) => { p.appearance.faceStyle = 'face-cool-classic@1.0.0'; }],
    ['accessories', (p) => { p.appearance.accessories[0].anchor = 'wrist_l'; }],
    ['voice', (p) => { p.voice = { pitch: 'mid', pace: 'fast' }; }],
  ];
  const seen = new Set([h0]);
  for (const [name, m] of mutations) {
    const p = base(); m(p);
    const h = hashOf(p);
    assert.ok(h && !seen.has(h), name); seen.add(h!);
    assert.deepEqual(errsOf(reg.createDraft(p)), ['IDENTITY_CHANGE_REQUIRES_NEW_VERSION'], name);
  }
  const life = base(); life.status = 'validated'; assert.equal(hashOf(life), h0);
  const dep = { ...base(), status: 'deprecated', locked: true, contentHash: h0, deprecation: { reason: 'r' } }; assert.equal(hashOf(dep), h0);
  assert.deepEqual(errsOf(reg.createDraft(base())), ['VERSION_ALREADY_LOCKED']);
  assert.equal(reg.deriveNextVersion('zapp@1.0.0', '1.0.0').ok, false);
  const { draft: next } = ok(reg.deriveNextVersion('zapp@1.0.0', '1.1.0')); next.appearance.accessories[0].anchor = 'wrist_l';
  assert.notEqual(lockNew(reg, next).manifest.contentHash, h0);
  const old = base(); old.version = '0.9.0'; assert.deepEqual(errsOf(reg.createDraft(old)), ['VERSION_NOT_INCREASING']);
});

test('the same version can never be re-imported with a different hash; import needs an authenticated approver', () => {
  const reg = registry();
  const { manifest } = lockNew(reg, base());
  const tampered = JSON.parse(serializeManifest(manifest)); tampered.proportions.heightM = 1.6;
  assert.ok(errsOf(registry().importLocked(tampered, REVIEWER)).includes('CONTENT_HASH_MISMATCH'));
  const { recipe: _r, contentHash: _h, ...rest } = tampered;
  tampered.contentHash = hashOf({ ...rest, status: 'draft', locked: false });
  assert.deepEqual(errsOf(reg.importLocked(tampered, REVIEWER)), ['IDENTITY_CHANGE_REQUIRES_NEW_VERSION']);
  assert.deepEqual(errsOf(registry().importLocked(JSON.parse(serializeManifest(manifest)), 'admin')), ['ACTOR_ID_INVALID']);
  assert.equal(ok(registry().importLocked(JSON.parse(serializeManifest(manifest)), REVIEWER)).manifest.contentHash, manifest.contentHash);
});

test('deprecation keeps old versions resolvable; episode pins resolve exact versions only', () => {
  const reg = registry();
  const v1 = lockNew(reg, base());
  const { draft: next } = ok(reg.deriveNextVersion('zapp@1.0.0', '1.1.0')); next.proportions.heightM = 1.6;
  const v2 = lockNew(reg, next);
  ok(reg.deprecate('zapp@1.0.0', 'height retuned', '1.1.0'));
  const r = ok(reg.resolvePin(v1.pin));
  assert.equal(r.deprecated, true); assert.deepEqual(codes(r.warnings), ['PROFILE_DEPRECATED']);
  assert.deepEqual(reg.versions('zapp').map((v) => [v.version, v.state]), [['1.0.0', 'deprecated'], ['1.1.0', 'locked']]);
  assert.deepEqual(ok(reg.resolveEpisodePins([v1.pin, v2.pin])).manifests.map((m) => [m.version, m.proportions.heightM]), [['1.0.0', 1.55], ['1.1.0', 1.6]]);
  const bad = reg.resolveEpisodePins([{ ...v1.pin, contentHash: v2.pin.contentHash }]) as any;
  assert.deepEqual(codes(bad.errors), ['PIN_HASH_MISMATCH']); assert.equal(bad.errors[0].path, '$.characters[0].contentHash');
  const d = base(); d.version = '1.2.0'; ok(reg.createDraft(d));
  assert.deepEqual(errsOf(reg.resolvePin({ characterId: 'zapp', version: '1.2.0', contentHash: v1.pin.contentHash })), ['PIN_NOT_LOCKED']);
  for (const version of ['latest', '^1.0.0', '1.x', '*', '']) assert.deepEqual(errsOf(reg.resolvePin({ ...v1.pin, version })), ['PIN_NOT_EXACT'], version);
  assert.deepEqual(errsOf(reg.resolvePin({ characterId: 'zapp', version: '1.0.0' })), ['PIN_INVALID']);
  assert.equal((reg as any).latest, undefined);
});

test('expression and motion compatibility', () => {
  const p = base(); p.expressions = ['neutral', 'smug'];
  assert.deepEqual(errCodes(p), ['EXPRESSION_UNAVAILABLE']);
  const d = base(); d.expressions = ['shock', 'shock']; assert.deepEqual(errCodes(d), ['EXPRESSION_DUPLICATE']);
  assert.ok(warnCodes(d).includes('EXPRESSION_NO_NEUTRAL'));
  const h = base(); h.appearance.head.preset = 'head-square-soft@1.0.0';
  assert.deepEqual(errCodes(h), ['FACE_SET_HEAD_INCOMPATIBLE']);
  assert.deepEqual(errCodes(base(), { requiredActions: ['walk', 'hover'] }), ['MOTION_ACTION_UNAVAILABLE']);
  const k = base(); k.motionProfile = 'motion-kid-bouncy@1.0.0';
  assert.deepEqual(errCodes(k), ['MOTION_HEIGHT_INCOMPATIBLE']);
  const handless = BUILTIN_COMPONENTS.map((c) => (c.id === 'block-teen-slim' ? { ...c, anchors: c.anchors!.filter((a) => a !== 'hand_l') } : c));
  const c = codes(evaluateProfile(base(), createCatalog(handless), { trust }).errors);
  assert.ok(c.includes('ANCHOR_MISSING') && c.includes('MOTION_ANCHOR_MISSING'), String(c));
});

test('accessory limits, anchors, clothing intersections and environment scale', () => {
  const acc = (assetId: string, anchor: string, palette = {}) => ({ assetId, anchor, palette });
  const p = base(); p.appearance.accessories = [acc('acc-wristband@1.0.0', 'wrist_r'), acc('acc-wristband@1.0.0', 'wrist_l'), acc('acc-scarf@1.0.0', 'neck'), acc('acc-backpack@1.0.0', 'back')];
  const c = errCodes(p);
  assert.ok(c.includes('ACCESSORY_LIMIT_EXCEEDED')); assert.ok(c.includes('CLOTHING_INTERSECTION'));
  const cap = base(); cap.appearance.accessories.push(acc('acc-cap@1.0.0', 'head_top'));
  assert.deepEqual(errCodes(cap), ['CLOTHING_INTERSECTION']);
  const anchor = base(); anchor.appearance.accessories = [acc('acc-glasses-square@1.0.0', 'back')];
  assert.deepEqual(errCodes(anchor), ['ACCESSORY_ANCHOR_INVALID']);
  const tall = base(); tall.bodyPreset = 'block-teen-standard@1.0.0'; tall.proportions.heightM = 1.85; tall.proportions.headScale = 1.3;
  assert.ok(errCodes(tall, { environments: ['classroom@1.1.0'] }).includes('ENVIRONMENT_SCALE_INCOMPATIBLE'));
  assert.deepEqual(errCodes(base(), { environments: ['moonbase@9.9.9'] }), ['ENVIRONMENT_UNKNOWN']);
});

test('hash formats: reference evidence is "sha256:<hex>", profile locks and pins are bare 64-hex', () => {
  const BARE = /^[0-9a-f]{64}$/;
  // reference evidence keeps the algorithm-qualified digest and exact CAS matching
  assert.match(FRONT.contentHash!, /^sha256:[0-9a-f]{64}$/);
  const bareRef = base(); bareRef.references[0].contentHash = FRONT.contentHash!.slice('sha256:'.length);
  assert.ok(errCodes(bareRef).includes('SCHEMA_INVALID'));
  const upperRef = base(); upperRef.references[0].contentHash = 'SHA256:' + FRONT.contentHash!.slice(7);
  assert.ok(errCodes(upperRef).includes('SCHEMA_INVALID'));
  const casOff = base(); casOff.references[0].storageRef = 'cas://references/sha256/' + NOTES.contentHash!.slice(7);
  assert.ok(errCodes(casOff).includes('REFERENCE_HASH_MISMATCH'));
  assert.equal(FRONT.storageRef, `cas://references/sha256/${FRONT.contentHash!.slice(7)}`);
  assert.deepEqual(errCodes(base()), []);
  // profile identity hash, locked manifest and pin: one bare format only
  const h = hashOf(base())!;
  assert.match(h, BARE); assert.equal(contentHashOf({ a: 1 }), sha256Hex('{"a":1}'));
  const reg = registry();
  const { manifest, pin } = lockNew(reg, base());
  assert.equal(manifest.contentHash, h); assert.match(pin.contentHash, BARE);
  assert.deepEqual(Object.keys(pin).sort(), ['characterId', 'contentHash', 'version']);
  assert.equal(ok(reg.resolvePin(structuredClone(pin))).manifest.contentHash, h);
  for (const bad of [`sha256:${h}`, h.toUpperCase(), h.slice(1), h + '0', `${h.slice(0, 63)}g`, ` ${h}`, '']) assert.deepEqual(errsOf(reg.resolvePin({ ...pin, contentHash: bad })), ['PIN_INVALID'], bad);
  const prefixed = { ...base(), status: 'locked', locked: true, contentHash: `sha256:${h}` };
  assert.ok(errCodes(prefixed).includes('SCHEMA_INVALID'), 'prefixed profile hash is not accepted anywhere');
  const changed = base(); changed.appearance.hair.palette.primary = '#ff7a26';
  assert.notEqual(hashOf(changed), h);
});

test('deterministic hashing primitives', () => {
  for (const s of ['', 'abc', 'x'.repeat(1000), 'héllo ✨']) assert.equal(sha256Hex(s), hex(s));
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: 0 }] }), '{"a":[2,{"c":0,"d":1}],"b":1}');
  assert.equal(createCatalog().hash, createCatalog().hash);
  assert.equal(contentHashOf({ a: 1, b: 2 }), contentHashOf({ b: 2, a: 1 }));
  assert.equal(hashOf(base()), hashOf(base()));
});
