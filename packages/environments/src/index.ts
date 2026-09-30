// Public entry for the versioned environment catalog (metadata only: no geometry, rendering or camera solving).
import { parseProfile, type EnvironmentProfile } from './schema.ts';
import { validateMarks, type CatalogIssue } from './marks.ts';
import { validateAnchors } from './anchors.ts';
import { validateCameraZones } from './camera-zones.ts';
import { verifyLock, profileKey, profileContentHash, type Catalog } from './lock.ts';

export * from './lock-source.ts';
export * from './schema.ts';
export * from './marks.ts';
export * from './anchors.ts';
export * from './camera-zones.ts';
export * from './compatibility.ts';
export * from './lock.ts';
export * from './catalog.ts';

/** strict schema + semantic validation of one profile */
export function validateProfile(x: unknown): { ok: true; profile: EnvironmentProfile; issues: [] } | { ok: false; issues: CatalogIssue[] } {
  const r = parseProfile(x);
  if (!r.ok) return { ok: false, issues: r.issues.map((i) => ({ code: 'schema', path: i.path, message: i.message })) };
  const p = r.value;
  const issues = [...validateMarks(p), ...validateAnchors(p), ...validateCameraZones(p)];
  if (p.cast.min > p.cast.max) issues.push({ code: 'cast_range', path: 'cast', message: 'cast.min > cast.max' });
  if (p.collision.assetKey !== p.asset.key || p.collision.assetSha256 !== p.asset.sha256) issues.push({ code: 'collision_ref', path: 'collision', message: 'collision reference must point at the same locked asset as the geometry' });
  if (p.geometryVersion !== p.asset.key.split('@')[1]) issues.push({ code: 'geometry_version', path: 'geometryVersion', message: 'geometryVersion must equal the pinned asset version' });
  return issues.length ? { ok: false, issues } : { ok: true, profile: p, issues: [] };
}

export interface KeyedCatalogIssue extends CatalogIssue { /** affected id@version (or lock key / profiles[i] when no id@version exists) */ key: string }

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const LOCK_KEY = /^[a-z][a-z0-9_]*(-[a-z0-9_]+)*@\d+\.\d+\.\d+$/;
const LOCK_HASH = /^[0-9a-f]{64}$/;

/**
 * Values canonicalJson/profileContentHash can serialise deterministically: plain JSON data only. Rejects non-finite
 * numbers, bigint/function/symbol, cycles, holes, accessors, hidden (non-enumerable) or symbol keys, non-plain
 * prototypes and unsafe keys. Must run before any other walk, because other walkers do not guard against cycles.
 */
export function hashableValueIssues(x: unknown, path = '$', out: CatalogIssue[] = [], stack = new Set<object>()): CatalogIssue[] {
  if (x === null || typeof x === 'string' || typeof x === 'boolean') return out;
  if (typeof x === 'number') { if (!Number.isFinite(x)) out.push({ code: 'hash_non_finite', path, message: `non-finite number at ${path}` }); return out; }
  if (typeof x !== 'object') { out.push({ code: 'hash_invalid_value', path, message: `${typeof x} at ${path} cannot be canonically hashed` }); return out; }
  if (stack.has(x)) { out.push({ code: 'hash_cycle', path, message: `cyclic reference at ${path}` }); return out; }
  stack.add(x);
  const proto = Object.getPrototypeOf(x);
  if (Array.isArray(x) ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) out.push({ code: 'hash_non_plain', path, message: `non-plain object at ${path}` });
  if (Object.getOwnPropertySymbols(x).length) out.push({ code: 'hash_symbol_key', path, message: `symbol-keyed property at ${path}` });
  if (Array.isArray(x)) {
    for (let i = 0; i < x.length; i++) {
      if (!Object.hasOwn(x, i) || x[i] === undefined) out.push({ code: 'hash_array_hole', path: `${path}[${i}]`, message: `missing/undefined array element at ${path}[${i}]` });
      else hashableValueIssues(x[i], `${path}[${i}]`, out, stack);
    }
  } else {
    for (const k of Object.getOwnPropertyNames(x)) {
      const d = Object.getOwnPropertyDescriptor(x, k)!;
      const p = `${path}.${k}`;
      if (UNSAFE_KEYS.has(k)) { out.push({ code: 'unsafe_key', path: p, message: `unsafe key "${k}" at ${path}` }); continue; }
      if (!d.enumerable) { out.push({ code: 'hash_non_enumerable', path: p, message: `hidden (non-enumerable) property at ${p}` }); continue; }
      if (d.get || d.set) { out.push({ code: 'hash_accessor', path: p, message: `accessor property at ${p}` }); continue; }
      if (d.value !== undefined) hashableValueIssues(d.value, p, out, stack);
    }
  }
  stack.delete(x);
  return out;
}

/**
 * THE combined catalog validator. Runs before any lock hash is accepted or generated: hashability, every profile's
 * strict schema + semantic validation, duplicate id@version, and lock structure (key format, exact id@version match,
 * hash format, conflicting entries, unsafe keys, locked profiles that disappeared). Does not compare hashes — that is
 * planEnvironmentLock's job, and it only happens once this passes. Every issue carries the affected id@version.
 */
export function validateEnvironmentCatalog(c: Catalog): { ok: boolean; issues: KeyedCatalogIssue[] } {
  const issues: KeyedCatalogIssue[] = [];
  const add = (key: string, i: CatalogIssue) => issues.push({ ...i, key, message: `${key}: ${i.message}` });
  if (!c || typeof c !== 'object' || !Array.isArray(c.profiles)) { add('catalog', { code: 'catalog_shape', path: '$', message: 'catalog must have a profiles array' }); return { ok: false, issues }; }
  const byKey = new Map<string, EnvironmentProfile>();
  c.profiles.forEach((p, i) => {
    const raw = p as unknown as Record<string, unknown> | null;
    const key = raw && typeof raw.id === 'string' && typeof raw.version === 'string' ? profileKey(raw.id, raw.version) : `profiles[${i}]`;
    const unhashable = hashableValueIssues(p, `profiles[${i}]`);
    unhashable.forEach((x) => add(key, x));
    if (!unhashable.length) {
      const r = validateProfile(p);
      if (!r.ok) r.issues.forEach((x) => add(key, x));
    }
    if (byKey.has(key)) add(key, { code: 'profile_duplicate', path: `profiles[${i}]`, message: 'duplicate id@version in catalog' });
    else byKey.set(key, p);
  });
  const lock = c.lock as unknown;
  if (!lock || typeof lock !== 'object' || Array.isArray(lock)) { add('lock', { code: 'lock_shape', path: 'lock', message: 'lock must be an object of id@version -> sha256' }); return { ok: false, issues }; }
  const proto = Object.getPrototypeOf(lock);
  if (proto !== Object.prototype && proto !== null) add('lock', { code: 'lock_shape', path: 'lock', message: 'lock must be a plain object' });
  if (Object.getOwnPropertySymbols(lock).length) add('lock', { code: 'lock_shape', path: 'lock', message: 'lock has symbol keys' });
  const byHash = new Map<string, string>();
  for (const k of Object.getOwnPropertyNames(lock)) {
    const d = Object.getOwnPropertyDescriptor(lock, k)!;
    if (UNSAFE_KEYS.has(k)) { add(k, { code: 'unsafe_key', path: `lock.${k}`, message: 'unsafe lock key' }); continue; }
    if (!d.enumerable || d.get || d.set) { add(k, { code: 'lock_shape', path: `lock.${k}`, message: 'lock entries must be plain enumerable data properties' }); continue; }
    if (!LOCK_KEY.test(k)) add(k, { code: 'lock_key_invalid', path: `lock.${k}`, message: 'lock key must be exactly <id>@<major>.<minor>.<patch>' });
    const h = d.value;
    if (typeof h !== 'string' || !LOCK_HASH.test(h)) add(k, { code: 'lock_hash_invalid', path: `lock.${k}`, message: 'lock value must be a lowercase sha256 hex digest' });
    else if (byHash.has(h)) add(k, { code: 'lock_conflict', path: `lock.${k}`, message: `same content hash as ${byHash.get(h)} (conflicting entries)` });
    else byHash.set(h, k);
    const p = byKey.get(k);
    if (!p) add(k, { code: 'lock_orphan', path: `lock.${k}`, message: 'previously locked profile has disappeared from the catalog; pinned episodes would no longer reproduce' });
    else if (p.status !== 'locked') add(k, { code: 'lock_status', path: `lock.${k}`, message: 'lock entry exists but the profile is not marked locked' });
  }
  return { ok: issues.length === 0, issues };
}

export type LockMode = 'check' | 'update';
export interface LockPlanEntry { key: string; status: 'unchanged' | 'missing' | 'mismatch'; locked: string | null; computed: string }
export interface LockPlan { mode: LockMode; ok: boolean; issues: KeyedCatalogIssue[]; entries: LockPlanEntry[]; appended: string[]; nextLock: Record<string, string> | null }

const keyOrder = (a: string, b: string) => {
  const [ia, va] = a.split('@'), [ib, vb] = b.split('@');
  if (ia !== ib) return ia < ib ? -1 : 1;
  const x = va.split('.').map(Number), y = vb.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

/**
 * Deterministic lock plan. check: read-only; fails on any validation issue, missing or mismatched entry.
 * update: may only APPEND hashes for new, valid, locked versions; any mismatch (or other issue) refuses the whole
 * update. Existing entries are never rewritten, reordered or removed. Hashes come only from profileContentHash.
 */
export function planEnvironmentLock(c: Catalog, mode: LockMode): LockPlan {
  const v = validateEnvironmentCatalog(c);
  if (!v.ok) return { mode, ok: false, issues: v.issues, entries: [], appended: [], nextLock: null }; // nothing hashed
  const entries: LockPlanEntry[] = c.profiles.filter((p) => p.status === 'locked').map((p) => {
    const key = profileKey(p.id, p.version), computed = profileContentHash(p);
    const locked = Object.hasOwn(c.lock, key) ? c.lock[key] : null;
    return { key, computed, locked, status: locked === null ? 'missing' : locked === computed ? 'unchanged' : 'mismatch' } as LockPlanEntry;
  }).sort((a, b) => keyOrder(a.key, b.key));
  const issues: KeyedCatalogIssue[] = [];
  for (const e of entries) {
    if (e.status === 'mismatch') issues.push({ key: e.key, code: 'version_bump_required', path: `lock.${e.key}`, message: `${e.key}: content hash ${e.computed} != locked ${e.locked}; locked versions are immutable, publish a new version` });
    if (e.status === 'missing' && mode === 'check') issues.push({ key: e.key, code: 'lock_missing', path: `lock.${e.key}`, message: `${e.key}: locked profile has no lock entry (run the explicit lock update)` });
  }
  if (issues.length) return { mode, ok: false, issues, entries, appended: [], nextLock: null };
  if (mode === 'check') return { mode, ok: true, issues, entries, appended: [], nextLock: null };
  const appended = entries.filter((e) => e.status === 'missing').map((e) => e.key);
  const nextLock: Record<string, string> = {};
  for (const k of Object.keys(c.lock)) nextLock[k] = c.lock[k];
  for (const e of entries) if (e.status === 'missing') nextLock[e.key] = e.computed;
  return { mode, ok: true, issues, entries, appended, nextLock };
}

/** validate every profile and the lock */
export function validateCatalog(c: Catalog): CatalogIssue[] {
  const out: CatalogIssue[] = [];
  for (const p of c.profiles) {
    const r = validateProfile(p);
    if (!r.ok) out.push(...r.issues.map((i) => ({ ...i, path: `${p.id}@${p.version}:${i.path}` })));
  }
  return [...out, ...verifyLock(c)];
}
