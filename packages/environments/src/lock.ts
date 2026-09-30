// Content hashing, the append-only environment lock, and exact-pin resolution.
// A locked version's hash covers geometry hash, marks, anchors, camera zones, lighting and collision reference:
// any change produces a different hash and therefore requires a new version. Rendering only accepts exact pins.
import { parseEnvironmentRef, type EnvironmentProfile, type EnvironmentRef } from './schema.ts';
import type { CatalogIssue } from './marks.ts';

/** canonical JSON: sorted keys, no whitespace, undefined dropped — formatting-independent hashing */
export function canonicalJson(x: unknown): string {
  if (Array.isArray(x)) return '[' + x.map(canonicalJson).join(',') + ']';
  if (x && typeof x === 'object') return '{' + Object.keys(x).sort().filter((k) => (x as Record<string, unknown>)[k] !== undefined).map((k) => JSON.stringify(k) + ':' + canonicalJson((x as Record<string, unknown>)[k])).join(',') + '}';
  if (typeof x === 'number' && !Number.isFinite(x)) throw new Error('canonicalJson: non-finite number');
  return JSON.stringify(x);
}

// Synchronous pure SHA-256 (browser + node, no platform crypto types needed). Verified against node:crypto in tests.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
export function sha256Hex(input: string): string {
  const msg = new TextEncoder().encode(input);
  const len = msg.length, total = ((len + 9 + 63) >> 6) << 6;
  const buf = new Uint8Array(total); buf.set(msg); buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 8, Math.floor(len / 0x20000000)); dv.setUint32(total - 4, (len * 8) >>> 0);
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const W = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < total; off += 64) {
    for (let t = 0; t < 16; t++) W[t] = dv.getUint32(off + t * 4);
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(W[t - 15], 7) ^ rotr(W[t - 15], 18) ^ (W[t - 15] >>> 3), s1 = rotr(W[t - 2], 17) ^ rotr(W[t - 2], 19) ^ (W[t - 2] >>> 10);
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) >>> 0;
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let t = 0; t < 64; t++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[t] + W[t]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  return Array.from(H, (x) => x.toString(16).padStart(8, '0')).join('');
}

export const profileKey = (id: string, version: string) => `${id}@${version}`;
/** deterministic content hash of a profile (covers every locked field) */
export const profileContentHash = (p: EnvironmentProfile): string => sha256Hex(canonicalJson(p));

/** the fields a lock guarantees; exposed so callers/tests can see what a hash change means */
export const LOCKED_FIELDS = ['asset', 'geometryVersion', 'marks', 'anchors', 'cameraZones', 'lighting', 'collision'] as const;

export type EnvironmentLock = Readonly<Record<string, string>>;

/**
 * Append-only lock: `id@version` -> content hash. Never edit an existing entry; publish a new version instead.
 * Verify with `npm run environments:lock:check`; append new locked versions with `npm run environments:lock:update`.
 * The marked block below is machine-maintained and must stay in its exact generated form (the tool refuses otherwise).
 */
// BEGIN GENERATED ENVIRONMENT_LOCK (append-only; maintained by scripts/environment-lock.ts)
export const ENVIRONMENT_LOCK: EnvironmentLock = Object.freeze({
  'classroom@1.0.0': '3494d354c5dc2f904964115002d864c40b72236a3379f3e937375f17279a6479',
  'classroom@1.1.0': '0bb894417d9cdb3dee19ed358e54730f4162d84d540525587e5942cb60047dbf',
  'classroom@1.2.0': '9b3b696f7e76e66361921095769216ca30cfb18883e7aacb5a72eb242db36087',
  'playground@1.0.0': 'b6056be513505ed9a1e9c2e06a2d16d20180fc1cc47797e3315c4cdd236fdf95',
  'school_hallway@1.0.0': 'cd02cdc410b22af8b1bc9010054dc30fefbddfd9a99d0b5c23ea3468a0a1e3ee',
});
// END GENERATED ENVIRONMENT_LOCK

export interface Catalog { profiles: readonly EnvironmentProfile[]; lock: EnvironmentLock }

/**
 * Low-level hash comparison only (no profile/hashability validation). Catalog validation must go through
 * validateEnvironmentCatalog in index.ts, which validates everything before hashing.
 * Verifies every locked profile still hashes to its lock entry and every lock entry still has its profile.
 */
export function verifyLock(c: Catalog): CatalogIssue[] {
  const out: CatalogIssue[] = [];
  const keys = new Set<string>();
  for (const p of c.profiles) {
    const key = profileKey(p.id, p.version);
    if (keys.has(key)) out.push({ code: 'profile_duplicate', path: key, message: `duplicate profile ${key}` });
    keys.add(key);
    const locked = c.lock[key];
    if (p.status === 'locked' && !locked) out.push({ code: 'lock_missing', path: key, message: `locked profile ${key} has no lock entry` });
    if (locked && profileContentHash(p) !== locked) out.push({ code: 'version_bump_required', path: key, message: `${key} content changed after locking (marks/anchors/camera/lighting/collision/geometry); publish a new version instead` });
    if (locked && p.status !== 'locked') out.push({ code: 'lock_status', path: key, message: `${key} is in the lock but not marked locked` });
  }
  for (const key of Object.keys(c.lock)) if (!keys.has(key)) out.push({ code: 'lock_orphan', path: key, message: `lock entry ${key} has no profile; pinned episodes would no longer reproduce` });
  return out;
}

const NON_EXACT = /^(latest|current|stable|\*|x)$|[\^~<>=*x|\s]/i;

/**
 * Render-time resolution: EXACT environmentId + version + contentHash only. "latest", ranges, tags and hash
 * mismatches throw. There is deliberately no fallback to another version.
 */
export function resolveForRender(c: Catalog, ref: unknown): EnvironmentProfile {
  const v = (ref as Record<string, unknown> | null)?.version;
  if (typeof v === 'string' && NON_EXACT.test(v)) throw new Error(`render requires an exact environment version; "${v}" is not allowed (never resolve latest during rendering)`);
  const parsed = parseEnvironmentRef(ref);
  if (!parsed.ok) throw new Error(`invalid environment ref: ${parsed.issues.map((i) => `${i.path} ${i.message}`).join('; ')}`);
  const { environmentId, version, contentHash } = parsed.value;
  const key = profileKey(environmentId, version);
  const p = c.profiles.find((x) => x.id === environmentId && x.version === version);
  if (!p) throw new Error(`environment ${key} is not in the catalog`);
  if (p.status !== 'locked') throw new Error(`environment ${key} is a draft; only locked environments render`);
  const locked = c.lock[key];
  if (!locked) throw new Error(`environment ${key} has no lock entry`);
  const actual = profileContentHash(p);
  if (actual !== locked) throw new Error(`environment ${key} no longer matches its lock (version bump required)`);
  if (contentHash !== locked) throw new Error(`environment ${key} content hash mismatch: episode pins ${contentHash.slice(0, 12)}…, catalog has ${locked.slice(0, 12)}…`);
  return p;
}

const semverCmp = (a: string, b: string) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };

/**
 * Authoring-time helper ONLY (never called by render): pick the newest locked version of an environment and
 * return the exact pin an episode manifest must store.
 */
export function pinLatestForAuthoring(c: Catalog, environmentId: string): EnvironmentRef {
  const locked = c.profiles.filter((p) => p.id === environmentId && p.status === 'locked' && c.lock[profileKey(p.id, p.version)]).sort((a, b) => semverCmp(b.version, a.version));
  if (!locked.length) throw new Error(`no locked version of environment "${environmentId}"`);
  return pinExact(c, environmentId, locked[0].version);
}

/** build the exact pin for a specific version (authoring) */
export function pinExact(c: Catalog, environmentId: string, version: string): EnvironmentRef {
  const key = profileKey(environmentId, version);
  const contentHash = c.lock[key];
  if (!contentHash) throw new Error(`environment ${key} is not locked`);
  return { environmentId, version, contentHash };
}
