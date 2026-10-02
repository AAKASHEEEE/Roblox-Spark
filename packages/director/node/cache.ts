// Node-only content-addressed Director cache. The request descriptor is hashed but not stored;
// API credentials are deliberately absent from the descriptor type and cache envelope.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, openSync, closeSync, fsyncSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { validateBeatSheet } from '../src/beat-sheet.ts';
import { verifySemanticRequirementsBinding } from '../src/semantic-requirements.ts';
import type { DIRECTOR_ALGORITHM_VERSION, DirectorMode, DirectorResult, NormalizedDirectorRequest } from '../src/offline.ts';

export interface DirectorCacheDescriptor {
  algorithmVersion: typeof DIRECTOR_ALGORITHM_VERSION | string;
  request: NormalizedDirectorRequest;
  provider: DirectorMode;
  models: string[];
  /** Provider behavior that can change model failover and therefore output. */
  timeoutMs: number | null;
  /** Separates keyless auto fallback from authenticated auto runs without storing the key. */
  openRouterConfigured: boolean;
}
export interface DirectorCacheHit { digest: string; value: DirectorResult }
interface CacheEnvelope { format: 'spark-director-cache'; version: 1; descriptorHash: string; valueHash: string; value: DirectorResult }

let tempSequence = 0;
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}
export function sha256(value: unknown): string { return createHash('sha256').update(canonicalJson(value)).digest('hex'); }

/** A configured auto-provider failure is transient; caching it would prevent recovery on the next run. */
export function shouldCacheDirectorResult(descriptor: DirectorCacheDescriptor, value: DirectorResult): boolean {
  return !(descriptor.provider === 'auto' && descriptor.openRouterConfigured && value.report.provider.used === 'offline');
}

export class NodeDirectorCache {
  readonly root: string;
  constructor(root: string) { this.root = resolve(root); mkdirSync(this.root, { recursive: true }); }

  digest(descriptor: DirectorCacheDescriptor): string { return sha256(descriptor); }
  pathFor(descriptor: DirectorCacheDescriptor): string {
    const digest = this.digest(descriptor);
    return join(this.root, digest.slice(0, 2), `${digest}.json`);
  }

  get(descriptor: DirectorCacheDescriptor): DirectorCacheHit | null {
    const digest = this.digest(descriptor), file = this.pathFor(descriptor);
    if (!existsSync(file)) return null;
    let parsed: CacheEnvelope;
    try { parsed = JSON.parse(readFileSync(file, 'utf8')) as CacheEnvelope; }
    catch { throw new Error(`Director cache entry ${digest} is not valid JSON`); }
    if (parsed?.format !== 'spark-director-cache' || parsed.version !== 1 || parsed.descriptorHash !== digest) throw new Error(`Director cache entry ${digest} has an invalid envelope`);
    if (parsed.valueHash !== sha256(parsed.value)) throw new Error(`Director cache entry ${digest} failed its content hash`);
    const validation = validateBeatSheet(parsed.value?.sheet, { requireAvailable: true });
    if (!validation.ok || !validation.value) throw new Error(`Director cache entry ${digest} contains an invalid BeatSheet`);
    try { verifySemanticRequirementsBinding(validation.value, parsed.value?.report); }
    catch (error) { throw new Error(`Director cache entry ${digest} contains invalid semantic authorization: ${error instanceof Error ? error.message : String(error)}`); }
    return { digest, value: parsed.value };
  }

  put(descriptor: DirectorCacheDescriptor, value: DirectorResult): string {
    const validation = validateBeatSheet(value.sheet, { requireAvailable: true });
    if (!validation.ok || !validation.value) throw new Error(`refusing to cache invalid BeatSheet: ${validation.issues[0]?.message ?? 'unknown issue'}`);
    try { verifySemanticRequirementsBinding(validation.value, value.report); }
    catch (error) { throw new Error(`refusing to cache invalid semantic authorization: ${error instanceof Error ? error.message : String(error)}`); }
    const digest = this.digest(descriptor), file = this.pathFor(descriptor);
    mkdirSync(dirname(file), { recursive: true });
    const envelope: CacheEnvelope = { format: 'spark-director-cache', version: 1, descriptorHash: digest, valueHash: sha256(value), value };
    const text = `${JSON.stringify(envelope)}\n`;
    const temp = `${file}.tmp-${process.pid}-${++tempSequence}`;
    const fd = openSync(temp, 'wx', 0o600);
    try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
    try { renameSync(temp, file); } catch (error) { try { unlinkSync(temp); } catch { /* best effort */ } throw error; }
    return digest;
  }
}
