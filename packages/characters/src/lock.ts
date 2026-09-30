// Lifecycle + locking. draft -> validated -> approved -> locked (-> deprecated). A locked version is immutable:
// the same characterId@version always resolves to the same recipe, component hashes, palette, proportions,
// expressions and accessories. Any identity change needs a new version. Episodes pin characterId + version +
// contentHash; "latest" is never resolved at render time.
import { checkCompatibility, type CompatibilityOptions } from './compatibility.ts';
import { createCatalog, type Catalog, type Vec3 } from './catalog.ts';
import { canonicalJson, clone, contentHashOf, deepFreeze } from './hash.ts';
import { checkLicensing } from './licensing.ts';
import { resolveRecipe, type ResolvedRecipe } from './recipe.ts';
import { validateReference } from './references.ts';
import { CONTENT_HASH, err, findForbiddenKeys, parseProfile, type CharacterProfile, type Finding, type ProfileStatus } from './schema.ts';

/** fields that are lifecycle state, not identity; everything else is identity and is hashed */
const LIFECYCLE_FIELDS = ['status', 'locked', 'contentHash', 'deprecation'] as const;
export type IdentityPayload = Omit<CharacterProfile, (typeof LIFECYCLE_FIELDS)[number]> & { recipe: ResolvedRecipe };

export interface Evaluation {
  ok: boolean;
  profile?: CharacterProfile;
  errors: Finding[];
  warnings: Finding[];
  recipe?: ResolvedRecipe;
  contentHash?: string;
  boundsM?: Vec3;
  faceTargetM?: Vec3;
}
export interface LockedManifest extends IdentityPayload { status: 'locked'; locked: true; contentHash: string }
export interface CharacterPin { characterId: string; version: string; contentHash: string }

export function identityPayload(p: CharacterProfile, recipe: ResolvedRecipe): IdentityPayload {
  const o = clone(p) as Record<string, unknown>;
  for (const k of LIFECYCLE_FIELDS) delete o[k];
  return { ...(o as Omit<CharacterProfile, (typeof LIFECYCLE_FIELDS)[number]>), recipe: clone(recipe) };
}

/** full validation: schema, references, licensing/IP, recipe resolution, compatibility, hash */
export function evaluateProfile(raw: unknown, catalog: Catalog = createCatalog(), opts: CompatibilityOptions = {}): Evaluation {
  const parsed = parseProfile(raw);
  if (!parsed.ok) return { ok: false, errors: parsed.errors, warnings: [] };
  const p = parsed.profile;
  const errors: Finding[] = [], warnings: Finding[] = [];
  const push = (fs: Finding[]) => { for (const f of fs) (f.severity === 'error' ? errors : warnings).push(f); };

  const ids = new Set<string>();
  p.references.forEach((r, i) => {
    if (ids.has(r.referenceId)) errors.push(err('REFERENCE_DUPLICATE', `$.references[${i}].referenceId`, `duplicate ${r.referenceId}`));
    ids.add(r.referenceId);
    push(validateReference(r, `$.references[${i}]`));
  });
  push(checkLicensing(p));
  const isLockedState = p.status === 'locked' || p.status === 'deprecated';
  if (p.locked !== isLockedState) errors.push(err('LOCK_STATE_INCONSISTENT', '$.locked', `locked=${p.locked} contradicts status "${p.status}"`));
  if (p.locked && !p.contentHash) errors.push(err('LOCK_HASH_MISSING', '$.contentHash', 'locked profiles must carry their contentHash'));
  if ((p.deprecation !== undefined) !== (p.status === 'deprecated')) errors.push(err('LOCK_STATE_INCONSISTENT', '$.deprecation', 'deprecation info is required for, and only allowed on, deprecated profiles'));

  const rr = resolveRecipe(p, catalog);
  push(rr.errors); push(rr.warnings);
  let contentHash: string | undefined, boundsM: Vec3 | undefined, faceTargetM: Vec3 | undefined;
  if (rr.recipe) {
    const compat = checkCompatibility(rr.recipe, rr.components, catalog, opts);
    push(compat.errors); push(compat.warnings);
    boundsM = compat.boundsM; faceTargetM = compat.faceTargetM;
    contentHash = contentHashOf(identityPayload(p, rr.recipe));
    if (p.contentHash && p.contentHash !== contentHash) errors.push(err('CONTENT_HASH_MISMATCH', '$.contentHash', `declared ${p.contentHash} but identity hashes to ${contentHash}`));
  }
  return { ok: errors.length === 0, profile: p, errors, warnings, recipe: rr.recipe, contentHash, boundsM, faceTargetM };
}

export function buildLockedManifest(ev: Evaluation): LockedManifest {
  if (!ev.ok || !ev.profile || !ev.recipe || !ev.contentHash) throw new Error('cannot lock a profile with blocking errors');
  return deepFreeze({ ...identityPayload(ev.profile, ev.recipe), status: 'locked', locked: true, contentHash: ev.contentHash });
}
/** stable serialization (sorted keys) — byte-identical for identical manifests */
export const serializeManifest = (m: LockedManifest): string => canonicalJson(m);
export const pinOf = (m: LockedManifest): CharacterPin => ({ characterId: m.characterId, version: m.version, contentHash: m.contentHash });

const semverCmp = (a: string, b: string) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
const EXACT_SEMVER = /^\d+\.\d+\.\d+$/;

interface VersionRecord {
  state: ProfileStatus;
  profile: CharacterProfile;
  evaluation?: Evaluation;
  approvedBy?: string;
  manifest?: LockedManifest;
  deprecation?: { reason: string; supersededBy?: string };
}
export type OpResult<T = {}> = ({ ok: true } & T) | { ok: false; errors: Finding[]; warnings?: Finding[] };
const fail = (code: string, path: string, message: string): { ok: false; errors: Finding[] } => ({ ok: false, errors: [err(code, path, message)] });

/**
 * In-memory registry of character versions. Persistence is the caller's concern: locked manifests are plain JSON
 * and can be re-imported with importLocked(), which re-verifies the hash.
 */
export class CharacterRegistry {
  readonly catalog: Catalog;
  private opts: CompatibilityOptions;
  private records = new Map<string, VersionRecord>();
  constructor(catalog: Catalog = createCatalog(), opts: CompatibilityOptions = {}) { this.catalog = catalog; this.opts = opts; }

  static key(characterId: string, version: string) { return `${characterId}@${version}`; }

  private guardFrozen(p: CharacterProfile, hash: string | undefined): { ok: false; errors: Finding[] } | undefined {
    const key = CharacterRegistry.key(p.characterId, p.version);
    const prev = this.records.get(key);
    if (prev?.manifest) {
      return prev.manifest.contentHash === hash
        ? fail('VERSION_ALREADY_LOCKED', '$.version', `${key} is already locked`)
        : fail('IDENTITY_CHANGE_REQUIRES_NEW_VERSION', '$.version', `${key} is locked as ${prev.manifest.contentHash}; identity changes need a new version`);
    }
    const lockedVersions = [...this.records.values()].filter((r) => r.manifest && r.profile.characterId === p.characterId).map((r) => r.profile.version);
    const newer = lockedVersions.find((v) => semverCmp(v, p.version) > 0);
    if (newer) return fail('VERSION_NOT_INCREASING', '$.version', `${p.version} is older than locked ${p.characterId}@${newer}`);
  }

  /** create or replace an unlocked draft */
  createDraft(raw: unknown): OpResult<{ key: string; warnings: Finding[] }> {
    const parsed = parseProfile(raw);
    if (!parsed.ok) return { ok: false, errors: parsed.errors };
    const p = parsed.profile;
    if (p.status !== 'draft' || p.locked || p.contentHash || p.deprecation) return fail('DRAFT_STATUS_INVALID', '$.status', 'new drafts must be status "draft", unlocked, without contentHash/deprecation');
    const ev = evaluateProfile(p, this.catalog, this.opts);
    const g = this.guardFrozen(p, ev.contentHash);
    if (g) return g;
    const key = CharacterRegistry.key(p.characterId, p.version);
    this.records.set(key, { state: 'draft', profile: deepFreeze(clone(p)) });
    return { ok: true, key, warnings: ev.warnings };
  }

  validate(key: string): OpResult<{ evaluation: Evaluation }> {
    const r = this.records.get(key);
    if (!r) return fail('PROFILE_NOT_FOUND', '$', `${key} not found`);
    if (r.state !== 'draft' && r.state !== 'validated') return fail('LIFECYCLE_INVALID', '$.status', `${key} is ${r.state}`);
    const ev = evaluateProfile(r.profile, this.catalog, this.opts);
    if (!ev.ok) { r.state = 'draft'; return { ok: false, errors: ev.errors, warnings: ev.warnings }; }
    r.state = 'validated'; r.evaluation = ev;
    return { ok: true, evaluation: ev };
  }

  approve(key: string, approvedBy: string): OpResult {
    const r = this.records.get(key);
    if (!r) return fail('PROFILE_NOT_FOUND', '$', `${key} not found`);
    if (r.state !== 'validated') return fail('LIFECYCLE_INVALID', '$.status', `${key} must be validated before approval (is ${r.state})`);
    if (!approvedBy.trim()) return fail('APPROVER_REQUIRED', '$', 'approval requires an approver');
    r.state = 'approved'; r.approvedBy = approvedBy;
    return { ok: true };
  }

  lock(key: string): OpResult<{ manifest: LockedManifest; pin: CharacterPin }> {
    const r = this.records.get(key);
    if (!r) return fail('PROFILE_NOT_FOUND', '$', `${key} not found`);
    if (r.state !== 'approved') return fail('LIFECYCLE_INVALID', '$.status', `${key} must be approved before locking (is ${r.state})`);
    const ev = evaluateProfile(r.profile, this.catalog, this.opts); // re-evaluate: catalog must not have drifted since approval
    if (!ev.ok || ev.contentHash !== r.evaluation?.contentHash) return { ok: false, errors: ev.ok ? [err('CONTENT_HASH_MISMATCH', '$', 'profile or catalog changed since validation')] : ev.errors };
    const manifest = buildLockedManifest(ev);
    Object.assign(r, { state: 'locked', manifest });
    return { ok: true, manifest, pin: pinOf(manifest) };
  }

  /** register an already-locked manifest (e.g. loaded from storage); the hash is recomputed, never trusted */
  importLocked(raw: unknown): OpResult<{ manifest: LockedManifest; pin: CharacterPin }> {
    const forbidden = findForbiddenKeys(raw);
    if (forbidden.length) return { ok: false, errors: forbidden };
    const o = raw && typeof raw === 'object' ? { ...(raw as Record<string, unknown>) } : raw;
    if (o && typeof o === 'object') delete (o as Record<string, unknown>).recipe; // recipe is re-derived, not trusted
    const ev = evaluateProfile(o, this.catalog, this.opts);
    if (!ev.ok || !ev.profile) return { ok: false, errors: ev.errors, warnings: ev.warnings };
    if (ev.profile.status !== 'locked') return fail('LIFECYCLE_INVALID', '$.status', 'only locked manifests can be imported');
    const g = this.guardFrozen(ev.profile, ev.contentHash);
    if (g) return g;
    const manifest = buildLockedManifest(ev);
    this.records.set(CharacterRegistry.key(manifest.characterId, manifest.version), { state: 'locked', profile: deepFreeze(clone(ev.profile)), evaluation: ev, manifest });
    return { ok: true, manifest, pin: pinOf(manifest) };
  }

  /** mutable draft copy of a locked version with a new, higher version number */
  deriveNextVersion(key: string, nextVersion: string): OpResult<{ draft: CharacterProfile }> {
    const r = this.records.get(key);
    if (!r?.manifest) return fail('PROFILE_NOT_LOCKED', '$', `${key} is not locked`);
    if (!EXACT_SEMVER.test(nextVersion) || semverCmp(nextVersion, r.profile.version) <= 0) return fail('VERSION_NOT_INCREASING', '$.version', `${nextVersion} must be greater than ${r.profile.version}`);
    const d = clone(r.profile) as CharacterProfile;
    delete d.contentHash; delete d.deprecation;
    return { ok: true, draft: { ...d, version: nextVersion, status: 'draft', locked: false } };
  }

  /** mark a locked version deprecated; it stays resolvable for existing pins and is never deleted */
  deprecate(key: string, reason: string, supersededBy?: string): OpResult {
    const r = this.records.get(key);
    if (!r?.manifest) return fail('PROFILE_NOT_LOCKED', '$', `${key} is not locked`);
    r.state = 'deprecated'; r.deprecation = { reason, ...(supersededBy ? { supersededBy } : {}) };
    return { ok: true };
  }

  /** exact pin resolution for episode manifests / render. No ranges, tags or "latest". */
  resolvePin(pin: unknown): OpResult<{ manifest: LockedManifest; deprecated: boolean; warnings: Finding[] }> {
    if (findForbiddenKeys(pin).length) return fail('PROTOTYPE_KEY_REJECTED', '$', 'forbidden key in pin');
    const p = pin as Partial<CharacterPin> | null;
    if (!p || typeof p !== 'object' || Object.keys(p).sort().join(',') !== 'characterId,contentHash,version') return fail('PIN_INVALID', '$', 'pin must be exactly {characterId, version, contentHash}');
    if (typeof p.version !== 'string' || !EXACT_SEMVER.test(p.version)) return fail('PIN_NOT_EXACT', '$.version', `version ${JSON.stringify(p.version)} is not an exact version; "latest"/ranges are never resolved at render time`);
    if (typeof p.contentHash !== 'string' || !CONTENT_HASH.test(p.contentHash)) return fail('PIN_INVALID', '$.contentHash', 'pin needs a sha256 contentHash');
    const r = this.records.get(CharacterRegistry.key(String(p.characterId), p.version));
    if (!r) return fail('PIN_NOT_FOUND', '$', `${p.characterId}@${p.version} is not registered`);
    if (!r.manifest) return fail('PIN_NOT_LOCKED', '$', `${p.characterId}@${p.version} is ${r.state}; only locked versions can be rendered`);
    if (r.manifest.contentHash !== p.contentHash) return fail('PIN_HASH_MISMATCH', '$.contentHash', `pinned ${p.contentHash} but ${p.characterId}@${p.version} is ${r.manifest.contentHash}`);
    const warnings = r.deprecation ? [{ code: 'PROFILE_DEPRECATED', path: '$', message: `${p.characterId}@${p.version} is deprecated: ${r.deprecation.reason}`, severity: 'warning' as const }] : [];
    return { ok: true, manifest: r.manifest, deprecated: !!r.deprecation, warnings };
  }

  /** resolve every character pin of an episode; all-or-nothing */
  resolveEpisodePins(pins: unknown[]): OpResult<{ manifests: LockedManifest[]; warnings: Finding[] }> {
    const manifests: LockedManifest[] = [], errors: Finding[] = [], warnings: Finding[] = [];
    pins.forEach((pin, i) => {
      const r = this.resolvePin(pin);
      if (r.ok) { manifests.push(r.manifest); warnings.push(...r.warnings); }
      else errors.push(...r.errors.map((e) => ({ ...e, path: `$.characters[${i}]${e.path.slice(1)}` })));
    });
    return errors.length ? { ok: false, errors } : { ok: true, manifests, warnings };
  }

  /** authoring-time listing (all versions incl. deprecated). Render code must use resolvePin. */
  versions(characterId: string): { version: string; state: ProfileStatus; contentHash?: string }[] {
    return [...this.records.values()].filter((r) => r.profile.characterId === characterId)
      .map((r) => ({ version: r.profile.version, state: r.state, contentHash: r.manifest?.contentHash }))
      .sort((a, b) => semverCmp(a.version, b.version));
  }
}
