// Durable local store (MVP): one directory per batch holding two content-hashed JSON envelopes —
//   batches/<batchId>/batch.json  immutable resolved request (written once)
//   batches/<batchId>/state.json  job records + monotonically increasing revision (rewritten atomically per mutation)
// Writes go through BulkFs.writeAtomic (temp file → fsync → rename → dir fsync in the Node adapter), so a reader sees
// either the old or the new file, never a torn one. Every read re-verifies the content hash; a mismatch or unparsable
// file is STORE_CORRUPT (never silently "repaired"). Orphan temp files from an interrupted write are swept by recover().
// Mutations run under a per-batch exclusive lock file (cross-process) and re-read state inside the lock, so two workers
// can never both win the same job. File-system access is injected so this module has no `node:` imports.
import { BulkError } from './errors.ts';
import { canonicalJson, sha256Hex } from './hash.ts';
import { newJob, type JobRecord } from './job.ts';
import { assertSafeRelativePath } from './paths.ts';
import type { ResolvedBatch } from './schema.ts';

/** Synchronous FS port. All paths are relative to the adapter's root. Sync keeps each locked mutation atomic in-process. */
export interface BulkFs {
  readText(path: string): string | null;
  /** temp file + fsync + atomic rename */
  writeAtomic(path: string, text: string): void;
  /** create only if absent (O_EXCL); false when it already exists */
  createExclusive(path: string, text: string): boolean;
  remove(path: string): void;
  list(dir: string): string[];
  mkdirp(dir: string): void;
}

export interface Clock { now(): number }
export const systemClock: Clock = { now: () => Date.now() };
export const iso = (ms: number): string => new Date(ms).toISOString();

export interface BatchState { batchId: string; revision: number; jobs: JobRecord[] }
export interface StoredBatch { batch: ResolvedBatch; createdAt: string }

const ENVELOPE_FORMAT = 'spark-bulk';
const ENVELOPE_VERSION = 1;
export const TEMP_MARKER = '.tmp-';
interface Envelope<T> { format: string; formatVersion: number; kind: string; contentHash: string; data: T }

export function encodeEnvelope<T>(kind: string, data: T): string {
  const env: Envelope<T> = { format: ENVELOPE_FORMAT, formatVersion: ENVELOPE_VERSION, kind, contentHash: sha256Hex(canonicalJson(data)), data };
  return `${JSON.stringify(env, null, 2)}\n`;
}

export function decodeEnvelope<T>(kind: string, text: string, where: string): T {
  let env: Envelope<T>;
  try { env = JSON.parse(text); } catch { throw new BulkError('STORE_CORRUPT', `${where}: not valid JSON (interrupted or tampered write)`); }
  if (!env || typeof env !== 'object' || env.format !== ENVELOPE_FORMAT || env.kind !== kind) throw new BulkError('STORE_CORRUPT', `${where}: not a ${ENVELOPE_FORMAT}/${kind} envelope`);
  if (env.formatVersion !== ENVELOPE_VERSION) throw new BulkError('STORE_CORRUPT', `${where}: unsupported formatVersion ${env.formatVersion}`);
  if (typeof env.contentHash !== 'string' || sha256Hex(canonicalJson(env.data)) !== env.contentHash) throw new BulkError('STORE_CORRUPT', `${where}: content hash mismatch`);
  return env.data;
}

export interface StoreOptions {
  clock?: Clock;
  /** lock files older than this are considered abandoned by a crashed process (ms, default 30 s) */
  lockStaleMs?: number;
  /** how long to wait for a busy lock before STORE_LOCKED (ms, default 2 s) */
  lockWaitMs?: number;
  /** identifies this process in lock files */
  owner?: string;
}

const sleepSync = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

export class BulkStore {
  readonly fs: BulkFs;
  readonly clock: Clock;
  private lockStaleMs: number;
  private lockWaitMs: number;
  private owner: string;
  private held = new Set<string>();

  constructor(fs: BulkFs, opts: StoreOptions = {}) {
    this.fs = fs;
    this.clock = opts.clock ?? systemClock;
    this.lockStaleMs = opts.lockStaleMs ?? 30_000;
    this.lockWaitMs = opts.lockWaitMs ?? 2_000;
    this.owner = opts.owner ?? 'bulk-store';
  }

  private dir(batchId: string): string { return assertSafeRelativePath(`batches/${batchId}`, 'batch dir'); }

  /** Create a batch and its pending jobs. Fails if the batch already exists (batches are immutable once created). */
  createBatch(batch: ResolvedBatch): BatchState {
    const dir = this.dir(batch.batchId);
    this.fs.mkdirp(dir);
    return this.withLock(batch.batchId, () => {
      if (this.fs.readText(`${dir}/batch.json`) !== null) throw new BulkError('ALREADY_EXISTS', `batch "${batch.batchId}" already exists`);
      const at = iso(this.clock.now());
      const state: BatchState = { batchId: batch.batchId, revision: 1, jobs: batch.episodes.map((e) => newJob(e, batch.maxAttempts, at)) };
      // state first: a crash between the two writes leaves no batch.json, so the batch simply doesn't exist yet
      this.fs.writeAtomic(`${dir}/state.json`, encodeEnvelope('state', state));
      this.fs.writeAtomic(`${dir}/batch.json`, encodeEnvelope<StoredBatch>('batch', { batch, createdAt: at }));
      return state;
    });
  }

  loadBatch(batchId: string): StoredBatch {
    const text = this.fs.readText(`${this.dir(batchId)}/batch.json`);
    if (text === null) throw new BulkError('NOT_FOUND', `batch "${batchId}" not found`);
    return decodeEnvelope<StoredBatch>('batch', text, `${batchId}/batch.json`);
  }

  listBatches(): string[] {
    return this.fs.list('batches').filter((n) => !n.includes(TEMP_MARKER) && this.fs.readText(`batches/${n}/batch.json`) !== null).sort();
  }

  readState(batchId: string): BatchState {
    const text = this.fs.readText(`${this.dir(batchId)}/state.json`);
    if (text === null) throw new BulkError('NOT_FOUND', `state for batch "${batchId}" not found`);
    const s = decodeEnvelope<BatchState>('state', text, `${batchId}/state.json`);
    if (s.batchId !== batchId) throw new BulkError('STORE_CORRUPT', `${batchId}/state.json belongs to batch "${s.batchId}"`);
    return s;
  }

  /**
   * Read-modify-write under the batch lock. `fn` mutates the fresh state (or throws to abort without writing).
   * The revision is bumped and the whole state written atomically.
   */
  mutate<T>(batchId: string, fn: (state: BatchState, at: string) => T): T {
    return this.withLock(batchId, () => {
      const state = this.readState(batchId);
      const result = fn(state, iso(this.clock.now()));
      state.revision += 1;
      this.fs.writeAtomic(`${this.dir(batchId)}/state.json`, encodeEnvelope('state', state));
      return result;
    });
  }

  /** Remove orphan temp files left by an interrupted write and stale lock files. Returns the removed names. */
  recover(batchId: string): string[] {
    const dir = this.dir(batchId);
    const removed: string[] = [];
    for (const name of this.fs.list(dir)) if (name.includes(TEMP_MARKER)) { this.fs.remove(`${dir}/${name}`); removed.push(name); }
    const lock = this.fs.readText(`${dir}/state.lock`);
    if (lock !== null && this.lockIsStale(lock)) { this.fs.remove(`${dir}/state.lock`); removed.push('state.lock'); }
    return removed.sort();
  }

  writeFile(path: string, text: string): void {
    const p = assertSafeRelativePath(path);
    const slash = p.lastIndexOf('/');
    if (slash > 0) this.fs.mkdirp(p.slice(0, slash));
    this.fs.writeAtomic(p, text);
  }

  private lockIsStale(text: string): boolean {
    try { const l = JSON.parse(text); return typeof l.expiresAt !== 'number' || l.expiresAt <= this.clock.now(); } catch { return true; }
  }

  private withLock<T>(batchId: string, fn: () => T): T {
    if (this.held.has(batchId)) return fn(); // re-entrant within this store instance
    const path = `${this.dir(batchId)}/state.lock`;
    const deadline = Date.now() + this.lockWaitMs;
    for (;;) {
      const body = JSON.stringify({ owner: this.owner, expiresAt: this.clock.now() + this.lockStaleMs });
      if (this.fs.createExclusive(path, body)) break;
      const cur = this.fs.readText(path);
      if (cur !== null && this.lockIsStale(cur)) { this.fs.remove(path); continue; } // abandoned by a crashed process
      if (Date.now() >= deadline) throw new BulkError('STORE_LOCKED', `batch "${batchId}" is locked by another process`, { retryable: true });
      sleepSync(5);
    }
    this.held.add(batchId);
    try { return fn(); } finally { this.held.delete(batchId); this.fs.remove(path); }
  }
}

/** In-memory BulkFs (tests, dry runs). Mirrors the Node adapter's semantics, including exclusive create. */
export class MemoryBulkFs implements BulkFs {
  readonly files = new Map<string, string>();
  readText(p: string) { return this.files.get(p) ?? null; }
  writeAtomic(p: string, t: string) { this.files.set(p, t); }
  createExclusive(p: string, t: string) { if (this.files.has(p)) return false; this.files.set(p, t); return true; }
  remove(p: string) { this.files.delete(p); }
  mkdirp() {}
  list(dir: string) {
    const pre = `${dir}/`, out = new Set<string>();
    for (const k of this.files.keys()) if (k.startsWith(pre)) out.add(k.slice(pre.length).split('/')[0]);
    return [...out].sort();
  }
}
