// Job queue on top of BulkStore. Every operation is one locked read-modify-write, so claims are linearisable: a job is
// handed to at most one live lease at a time. Lease tokens are deterministic (`<worker>:<revision>:<jobId>`) and are
// checked — together with expiry — on every worker-side mutation; a stale holder gets LEASE_LOST.
import { BulkError, type BulkErrorCode } from './errors.ts';
import { transition, type ArtifactSet, type JobRecord, type Lease, type LeaseKind, type RenderTarget } from './job.ts';
import { PREP_LEASE_STATES, RENDER_LEASE_STATES, isTerminal } from './states.ts';
import type { BatchState, BulkStore } from './store.ts';
import { iso } from './store.ts';

export const DEFAULT_LEASE_MS = 60_000;
export interface LeaseRef { batchId: string; jobId: string; token: string }
export interface FailureInput { code: BulkErrorCode | string; message: string; retryable: boolean }

export class JobQueue {
  readonly store: BulkStore;
  readonly leaseMs: number;
  constructor(store: BulkStore, opts: { leaseMs?: number } = {}) { this.store = store; this.leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS; }

  list(batchId: string): JobRecord[] { return this.store.readState(batchId).jobs; }
  get(batchId: string, jobId: string): JobRecord { return find(this.store.readState(batchId), jobId); }

  /** approved → queued (explicit enqueue of an approved job) */
  enqueue(batchId: string, jobId: string): JobRecord {
    return this.store.mutate(batchId, (s, at) => clone(transition(find(s, jobId), 'queued', at)));
  }

  /** Claim the next pending job for the prep phase (pending → validating) with a prep lease. */
  claimPrep(batchId: string, workerId: string): { job: JobRecord; lease: LeaseRef } | null {
    return this.claim(batchId, workerId, 'prep', (j) => j.state === 'pending', 'validating');
  }

  /** Lease the next queued job for rendering (queued → leased). Never returns a job that has a live lease. */
  leaseNext(batchId: string, workerId: string): { job: JobRecord; lease: LeaseRef } | null {
    return this.claim(batchId, workerId, 'render', (j) => j.state === 'queued', 'leased');
  }

  /** Re-acquire an awaiting_approval job (e.g. after a human approved it) under a prep lease without changing state. */
  claimApproval(batchId: string, workerId: string, skip: ReadonlySet<string> = new Set()): { job: JobRecord; lease: LeaseRef } | null {
    return this.claim(batchId, workerId, 'prep', (j) => j.state === 'awaiting_approval' && j.lease === null && !skip.has(j.jobId), null);
  }

  private claim(batchId: string, workerId: string, kind: LeaseKind, pick: (j: JobRecord) => boolean, to: JobRecord['state'] | null) {
    return this.store.mutate(batchId, (s, at) => {
      const live = (j: JobRecord) => j.lease !== null && Date.parse(j.lease.expiresAt) > Date.parse(at);
      const job = s.jobs.find((j) => pick(j) && !live(j)); // request order = priority; deterministic
      if (!job) return null;
      if (to) transition(job, to, at, `claimed by ${workerId}`);
      const token = `${workerId}:${s.revision + 1}:${job.jobId}`;
      job.lease = { workerId, token, kind, acquiredAt: at, expiresAt: iso(Date.parse(at) + this.leaseMs) };
      return { job: clone(job), lease: { batchId, jobId: job.jobId, token } };
    });
  }

  renewLease(ref: LeaseRef): Lease {
    return this.store.mutate(ref.batchId, (s, at) => {
      const job = owned(s, ref, at);
      job.lease!.expiresAt = iso(Date.parse(at) + this.leaseMs);
      job.updatedAt = at;
      return { ...job.lease! };
    });
  }

  /** Worker-side state advance while holding the lease (e.g. validating → storyboard, leased → rendering). */
  advance(ref: LeaseRef, to: JobRecord['state'], patch: Partial<Pick<JobRecord, 'projectHash' | 'projectRef' | 'approvedHash' | 'approval' | 'rendererVersion'>> = {}): JobRecord {
    return this.store.mutate(ref.batchId, (s, at) => {
      const job = owned(s, ref, at);
      transition(job, to, at);
      Object.assign(job, patch);
      if (to === 'approved' || to === 'queued' || to === 'pending') job.lease = null; // phase boundary releases the lease
      return clone(job);
    });
  }

  /** Release a lease without changing state (e.g. approval still pending). */
  release(ref: LeaseRef): JobRecord {
    return this.store.mutate(ref.batchId, (s, at) => { const job = owned(s, ref, at); job.lease = null; job.updatedAt = at; return clone(job); });
  }

  recordOutputs(ref: LeaseRef, target: RenderTarget, artifacts: ArtifactSet, rendererVersion: string | null): JobRecord {
    return this.store.mutate(ref.batchId, (s, at) => {
      const job = owned(s, ref, at);
      job.outputs[target] = { ...artifacts };
      if (rendererVersion) job.rendererVersion = rendererVersion;
      job.updatedAt = at;
      return clone(job);
    });
  }

  /** validating_output → completed; releases the lease. */
  complete(ref: LeaseRef): JobRecord {
    return this.store.mutate(ref.batchId, (s, at) => {
      const job = owned(s, ref, at);
      transition(job, 'completed', at);
      job.lease = null; job.error = null; job.retryable = null;
      return clone(job);
    });
  }

  /** Any work state → failed; records the error and retryability; releases the lease. */
  fail(ref: LeaseRef, f: FailureInput): JobRecord {
    return this.store.mutate(ref.batchId, (s, at) => {
      const job = owned(s, ref, at);
      transition(job, 'failed', at, f.code);
      const err = { code: f.code, message: f.message.slice(0, 500), retryable: f.retryable, attempt: job.attempt, at };
      job.error = err; job.errors.push(err); job.retryable = f.retryable && job.attempt < job.maxAttempts; job.lease = null;
      return clone(job);
    });
  }

  /** Cancel a non-terminal job regardless of lease (the holder's next mutation fails with LEASE_LOST). */
  cancel(batchId: string, jobId: string, reason = 'cancelled'): JobRecord {
    return this.store.mutate(batchId, (s, at) => {
      const job = find(s, jobId);
      transition(job, 'cancelled', at, reason);
      job.lease = null;
      return clone(job);
    });
  }

  cancelBatch(batchId: string, reason = 'batch cancelled'): JobRecord[] {
    return this.store.mutate(batchId, (s, at) => {
      for (const job of s.jobs) {
        if (isTerminal(job.state)) continue;
        transition(job, 'cancelled', at, reason);
        job.lease = null;
      }
      return s.jobs.map(clone);
    });
  }

  /** failed → retry_pending (attempt + 1, same seed). Refuses permanent failures and exhausted attempts. */
  retry(batchId: string, jobId: string): JobRecord {
    return this.store.mutate(batchId, (s, at) => {
      const job = find(s, jobId);
      if (job.state !== 'failed') throw new BulkError('RETRY_NOT_ALLOWED', `job ${jobId} is ${job.state}, not failed`);
      if (!job.error?.retryable) throw new BulkError('RETRY_NOT_ALLOWED', `job ${jobId} failed permanently (${job.error?.code})`);
      if (job.attempt >= job.maxAttempts) throw new BulkError('RETRY_NOT_ALLOWED', `job ${jobId} exhausted ${job.maxAttempts} attempts`);
      job.attempt += 1;
      transition(job, 'retry_pending', at);
      job.completedAt = null; job.outputs = {}; // a retry never inherits artifacts from the failed attempt
      return clone(job);
    });
  }

  /** retry_pending → queued when the approval is still valid (render-phase failure), else → pending (redo prep). */
  requeueRetries(batchId: string): JobRecord[] {
    return this.store.mutate(batchId, (s, at) => {
      const moved: JobRecord[] = [];
      for (const job of s.jobs) if (job.state === 'retry_pending') {
        transition(job, job.approvedHash ? 'queued' : 'pending', at, 'retry');
        if (!job.approvedHash) { job.projectHash = null; job.projectRef = null; }
        job.error = null; job.retryable = null; moved.push(clone(job));
      }
      return moved;
    });
  }

  /** Expired leases: prep work → pending, render work → queued, awaiting approval keeps its state. Same attempt + seed. */
  recoverExpiredLeases(batchId: string): JobRecord[] {
    return this.store.mutate(batchId, (s, at) => {
      const now = Date.parse(at), moved: JobRecord[] = [];
      for (const job of s.jobs) {
        if (!job.lease || Date.parse(job.lease.expiresAt) > now) continue;
        const note = `lease expired (${job.lease.workerId})`;
        if (job.state === 'validating' || job.state === 'storyboard') transition(job, 'pending', at, note);
        else if (RENDER_LEASE_STATES.includes(job.state)) transition(job, 'queued', at, note);
        else if (!PREP_LEASE_STATES.includes(job.state)) job.updatedAt = at; // lease on a settled job: just drop it
        job.lease = null;
        moved.push(clone(job));
      }
      return moved;
    });
  }
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

function find(s: BatchState, jobId: string): JobRecord {
  const j = s.jobs.find((x) => x.jobId === jobId);
  if (!j) throw new BulkError('NOT_FOUND', `job "${jobId}" not in batch "${s.batchId}"`);
  return j;
}

function owned(s: BatchState, ref: LeaseRef, at: string): JobRecord {
  const job = find(s, ref.jobId);
  if (!job.lease || job.lease.token !== ref.token) throw new BulkError('LEASE_LOST', `job ${ref.jobId}: lease ${ref.token} is not the current lease`);
  if (Date.parse(job.lease.expiresAt) <= Date.parse(at)) throw new BulkError('LEASE_LOST', `job ${ref.jobId}: lease ${ref.token} expired at ${job.lease.expiresAt}`);
  return job;
}
