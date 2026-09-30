// Bulk runner: orchestrates validate → storyboard → approve → render → output validation for every job in a batch
// through an INJECTED EpisodePipeline. It never imports the renderer, never renders by itself and never retries forever
// (attempts are capped by the batch policy, default 2).
//
// Semantics
// - concurrency: at most N jobs in flight (N = min(option ?? batch.concurrency, jobs)); each worker holds one lease.
// - continue-on-error (default): a failed job does not stop the others.
// - stopOnFirstError: automatic retries are disabled and the FIRST failed attempt stops the run: no new claim is made by
//   any worker. Claims already in flight are neither aborted nor cancelled — each runs its current claim to its normal
//   end (phase boundary: queued/awaiting_approval after prep, completed/failed after render) and commits it. Untouched
//   jobs stay pending/queued; the failed job stays `failed` (retryable flag recorded) so a later run / retry() resumes.
// - retries: retryable failures (handler says so, thrown non-Bulk errors, timeouts) are retried while attempt < max,
//   keeping the same seed. Render-phase retries reuse the approval; prep-phase retries redo validation/storyboard.
// - leases: every claim holds a lease of `queue.leaseMs`; a heartbeat renews it every `heartbeatMs` (< leaseMs) with a
//   token check under the batch lock. LEASE_LOST aborts the pipeline stage; its late result is never committed.
// - timeout: the per-job deadline (episode timeoutMs ?? defaultTimeoutMs) covers the whole claim. On expiry the stage is
//   aborted, the attempt is committed as failed/TIMEOUT (retryable) and any late result is dropped.
// - the heartbeat interval and the timeout timer are cleared on every exit path (success, failure, timeout, abort, loss).
// - cancellation: `signal` abort (or cancel()) stops claiming, aborts in-flight handlers and cancels open jobs.
// - resume: every run first sweeps temp files, recovers expired leases and requeues retry_pending jobs.
import { BulkError, isBulkError, type BulkErrorCode } from './errors.ts';
import type { ArtifactSet, JobRecord, RenderTarget } from './job.ts';
import { isSafeRelativePath, isWithin } from './paths.ts';
import { JobQueue, type LeaseRef } from './queue.ts';
import type { ResolvedBatch, ResolvedEpisode } from './schema.ts';
import type { JobState } from './states.ts';

export interface PipelineContext { batchId: string; jobId: string; attempt: number; seed: number; signal: AbortSignal; deadline: number | null }
export interface HandlerFailure { ok: false; code?: string; message: string; retryable?: boolean }
export type ValidationResult = { ok: true; warnings?: string[] } | HandlerFailure;
export type StoryboardResult = { ok: true; projectHash: string; projectRef?: unknown } | HandlerFailure;
export interface StoryboardProject { request: ResolvedEpisode; projectHash: string; projectRef: unknown }
export type ApprovalResult =
  | { status: 'approved'; approvedHash: string; approval?: unknown }
  | { status: 'pending' }
  | { status: 'rejected'; message: string };
export interface ApprovedProject { request: ResolvedEpisode; jobId: string; attempt: number; approvedHash: string; approval: unknown; outputDir: string; target: RenderTarget; quality: string }
export type RenderResult = { ok: true; rendererVersion: string; artifacts: Partial<ArtifactSet> } | HandlerFailure;

/** Future integration point: the narrated pipeline + render worker implement this; the bulk core only calls it. */
export interface EpisodePipeline {
  validate(request: ResolvedEpisode, ctx: PipelineContext): Promise<ValidationResult>;
  generateStoryboard(request: ResolvedEpisode, ctx: PipelineContext): Promise<StoryboardResult>;
  approve(project: StoryboardProject, ctx: PipelineContext): Promise<ApprovalResult>;
  renderDraft(approval: ApprovedProject, ctx: PipelineContext): Promise<RenderResult>;
  renderFinal(approval: ApprovedProject, ctx: PipelineContext): Promise<RenderResult>;
}

export type ProgressEvent =
  | { type: 'state'; jobId: string; state: JobState; attempt: number }
  | { type: 'retry'; jobId: string; attempt: number; code: string }
  | { type: 'failed'; jobId: string; attempt: number; code: string; retryable: boolean }
  | { type: 'lease_lost'; jobId: string }
  | { type: 'cancelled'; jobId: string }
  | { type: 'heartbeat_retry'; jobId: string; code: string }
  | { type: 'fatal'; jobId: string | null; code: string; message: string }
  | { type: 'stopped'; reason: 'first_error' | 'cancelled' | 'fatal' }
  | { type: 'done'; summary: RunSummary };

export interface RunOptions {
  concurrency?: number;
  stopOnFirstError?: boolean;
  signal?: AbortSignal;
  onEvent?: (e: ProgressEvent) => void;
  /** fallback per-job timeout when the episode has none (ms) */
  defaultTimeoutMs?: number;
  workerPrefix?: string;
  /** lease heartbeat period (ms). Must be > 0 and < the queue's leaseMs. Default: floor(leaseMs / 3). */
  heartbeatMs?: number;
  /** injected timers (tests use a fake scheduler; default: global setInterval/setTimeout) */
  timers?: Timers;
}

/** Timer port so heartbeats and timeouts are deterministic under test. Time itself comes from the store's Clock. */
export interface Timers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
export const systemTimers: Timers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * Why a job's AbortController fired. The FIRST cause wins (AbortController ignores later aborts) and decides the outcome:
 * - cancelled:       external/run cancellation → emits `cancelled`; nothing committed (cancelBatch already did it)
 * - timeout:         deadline hit → commits failed/TIMEOUT for this attempt (normal retry policy applies)
 * - lease_lost:      token expired/replaced (seen by heartbeat or a commit) → emits `lease_lost`; nothing committed
 * - heartbeat_fatal: renewal failed with STORE_CORRUPT or an unexpected error → nothing committed; run fails closed
 * - run_fatal:       a sibling job hit a fatal error → nothing committed; its lease expires and is recovered on resume
 */
export type AbortCauseKind = 'cancelled' | 'timeout' | 'lease_lost' | 'heartbeat_fatal' | 'run_fatal';
export interface AbortCause { kind: AbortCauseKind; error?: unknown }
const causeOf = (signal: AbortSignal): AbortCause | null => (signal.aborted ? ((signal.reason as AbortCause)?.kind ? (signal.reason as AbortCause) : { kind: 'cancelled' }) : null);

/** Heartbeat renewal errors: STORE_LOCKED is transient (retried next beat); everything else aborts the job. */
export const TRANSIENT_HEARTBEAT_CODES = ['STORE_LOCKED'] as const;

export interface RunSummary {
  batchId: string; total: number; completed: number; failed: number; cancelled: number; awaitingApproval: number;
  open: number; stoppedEarly: boolean; aborted: boolean;
}

const HEX64 = /^[0-9a-f]{64}$/;

export class BulkRunner {
  readonly queue: JobQueue;
  readonly pipeline: EpisodePipeline;
  constructor(queue: JobQueue, pipeline: EpisodePipeline) { this.queue = queue; this.pipeline = pipeline; }

  async run(batchId: string, opts: RunOptions = {}): Promise<RunSummary> {
    const { batch } = this.queue.store.loadBatch(batchId);
    const heartbeatMs = opts.heartbeatMs ?? Math.max(1, Math.floor(this.queue.leaseMs / 3));
    if (!Number.isFinite(heartbeatMs) || heartbeatMs <= 0 || heartbeatMs >= this.queue.leaseMs) {
      throw new BulkError('SCHEMA_INVALID', `heartbeatMs ${heartbeatMs} must be > 0 and < leaseMs ${this.queue.leaseMs}`);
    }
    // validated before any store mutation
    const env: ProcessEnv = { timers: opts.timers ?? systemTimers, heartbeatMs, autoRetry: !(opts.stopOnFirstError ?? batch.stopOnFirstError), defaultTimeoutMs: opts.defaultTimeoutMs };
    this.queue.store.recover(batchId);
    this.queue.recoverExpiredLeases(batchId);
    this.queue.requeueRetries(batchId);
    const emit = (e: ProgressEvent) => { try { opts.onEvent?.(e); } catch { /* observers never break the run */ } };
    const stopOnFirstError = opts.stopOnFirstError ?? batch.stopOnFirstError;
    const concurrency = Math.max(1, Math.min(opts.concurrency ?? batch.concurrency, batch.episodes.length));
    const inflight = new Set<AbortController>();
    const approvalChecked = new Set<string>();
    let stopped = false, aborted = false;
    let fatal: { error: unknown } | null = null;

    const onAbort = () => {
      if (aborted) return;
      aborted = true; stopped = true;
      for (const c of inflight) c.abort({ kind: 'cancelled' } satisfies AbortCause);
      this.queue.cancelBatch(batchId, 'run aborted');
      emit({ type: 'stopped', reason: 'cancelled' });
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    if (opts.signal?.aborted) onAbort();

    // idle workers wait while a sibling is busy (it may produce new claimable work, e.g. prep → queued) instead of exiting
    let busy = 0;
    let wake: (() => void) | null = null;
    let changed = new Promise<void>((r) => { wake = r; });
    const notify = () => { const w = wake; changed = new Promise<void>((r) => { wake = r; }); w?.(); };
    const worker = async (workerId: string) => {
      while (!stopped) {
        const c = this.queue.leaseNext(batchId, workerId) ?? this.queue.claimPrep(batchId, workerId) ?? this.queue.claimApproval(batchId, workerId, approvalChecked);
        if (!c) { if (busy === 0) break; await changed; continue; }
        busy++;
        try {
          const outcome = await this.process(batch, c.job, c.lease, env, emit, inflight, approvalChecked);
          if (outcome === 'failed' && stopOnFirstError && !stopped) { stopped = true; emit({ type: 'stopped', reason: 'first_error' }); }
        } catch (e) {
          // fail closed: stop claiming, abort every sibling without committing, surface the error from run()
          if (!fatal) {
            fatal = { error: e }; stopped = true;
            for (const ctl of inflight) ctl.abort({ kind: 'run_fatal', error: e } satisfies AbortCause);
            emit({ type: 'fatal', jobId: c.job.jobId, code: isBulkError(e) ? e.code : 'UNEXPECTED', message: e instanceof Error ? e.message : String(e) });
            emit({ type: 'stopped', reason: 'fatal' });
          }
        } finally { busy--; notify(); }
      }
      notify(); // let waiting siblings re-check (and exit) once this worker is done
    };
    try {
      await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(`${opts.workerPrefix ?? 'w'}${i + 1}`)));
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
    }
    if (fatal) throw (fatal as { error: unknown }).error;
    const summary = summarize(batchId, this.queue.list(batchId), stopped && !aborted, aborted);
    emit({ type: 'done', summary });
    return summary;
  }

  /** Runs one claimed job until it leaves this worker's hands. Returns how it ended for this worker. */
  private async process(batch: ResolvedBatch, claimed: JobRecord, ref: LeaseRef, env: ProcessEnv, emit: (e: ProgressEvent) => void,
    inflight: Set<AbortController>, approvalChecked: Set<string>): Promise<'ok' | 'failed' | 'retrying' | 'lost' | 'cancelled'> {
    const q = this.queue;
    const ep = batch.episodes.find((e) => e.episodeId === claimed.episodeId);
    if (!ep) throw new BulkError('NOT_FOUND', `episode ${claimed.episodeId} missing from batch ${batch.batchId}`);
    const controller = new AbortController();
    inflight.add(controller);
    const clock = q.store.clock;
    const timeoutMs = claimed.timeoutMs ?? env.defaultTimeoutMs ?? null;
    const ctx: PipelineContext = { batchId: batch.batchId, jobId: claimed.jobId, attempt: claimed.attempt, seed: claimed.seed, signal: controller.signal, deadline: timeoutMs === null ? null : clock.now() + timeoutMs };
    const abort = (cause: AbortCause) => controller.abort(cause); // first cause wins
    // heartbeat: token-checked renewal for the whole claim. STORE_LOCKED → retry next beat (the lease stays valid until
    // its expiry; if it lapses meanwhile the next renewal/commit gets LEASE_LOST). LEASE_LOST → lease-loss path.
    // STORE_CORRUPT or anything unexpected → abort and fail the run closed (never ignored, never retried).
    let heartbeat: unknown = env.timers.setInterval(() => {
      if (controller.signal.aborted) return;
      try { q.renewLease(ref); } catch (e) {
        if (isBulkError(e) && (TRANSIENT_HEARTBEAT_CODES as readonly string[]).includes(e.code)) { emit({ type: 'heartbeat_retry', jobId: claimed.jobId, code: e.code }); return; }
        abort(isBulkError(e, 'LEASE_LOST') ? { kind: 'lease_lost', error: e } : { kind: 'heartbeat_fatal', error: e });
      }
    }, env.heartbeatMs);
    const stopHeartbeat = () => { if (heartbeat !== null) { env.timers.clearInterval(heartbeat); heartbeat = null; } };
    const call = async <T>(p: () => Promise<T>) => {
      const r = await withDeadline(p, ctx, env.timers, clock);
      if (controller.signal.aborted) throw new BulkError('CANCELLED', 'job aborted'); // never act on a result after any abort
      return r;
    };
    let job = claimed;
    const step = (to: JobState, patch?: Parameters<JobQueue['advance']>[2]) => { job = q.advance(ref, to, patch); emit({ type: 'state', jobId: job.jobId, state: to, attempt: job.attempt }); };
    try {
      emit({ type: 'state', jobId: job.jobId, state: job.state, attempt: job.attempt });
      if (job.state === 'validating') {
        const v = await call(() => this.pipeline.validate(ep, ctx));
        if (!v.ok) return this.failJob(ref, job, 'VALIDATION_FAILED', v, false, emit, env.autoRetry);
        step('storyboard');
        const sb = await call(() => this.pipeline.generateStoryboard(ep, ctx));
        if (!sb.ok) return this.failJob(ref, job, 'STORYBOARD_FAILED', sb, true, emit, env.autoRetry);
        if (!HEX64.test(sb.projectHash)) return this.failJob(ref, job, 'OUTPUT_INVALID', { ok: false, message: 'storyboard projectHash must be sha256 hex' }, false, emit, env.autoRetry);
        step('awaiting_approval', { projectHash: sb.projectHash, projectRef: sb.projectRef ?? null });
      }
      if (job.state === 'awaiting_approval') {
        approvalChecked.add(job.jobId);
        const a = await call(() => this.pipeline.approve({ request: ep, projectHash: job.projectHash!, projectRef: job.projectRef }, ctx));
        if (a.status === 'pending') { q.release(ref); return 'ok'; }
        if (a.status === 'rejected') return this.failJob(ref, job, 'APPROVAL_REJECTED', { ok: false, message: a.message }, false, emit, env.autoRetry);
        if (!HEX64.test(a.approvedHash)) return this.failJob(ref, job, 'OUTPUT_INVALID', { ok: false, message: 'approvedHash must be sha256 hex' }, false, emit, env.autoRetry);
        step('approved', { approvedHash: a.approvedHash, approval: a.approval ?? null });
        job = q.enqueue(batch.batchId, job.jobId);
        emit({ type: 'state', jobId: job.jobId, state: 'queued', attempt: job.attempt });
        return 'ok';
      }
      if (job.state === 'leased') {
        step('rendering');
        const targets: RenderTarget[] = ep.output === 'both' ? ['draft', 'final'] : [ep.output];
        const results: [RenderTarget, Extract<RenderResult, { ok: true }>][] = [];
        for (const target of targets) {
          const approved: ApprovedProject = { request: ep, jobId: job.jobId, attempt: job.attempt, approvedHash: job.approvedHash!, approval: job.approval, outputDir: job.outputDir, target, quality: target === 'draft' ? ep.draftQuality : ep.finalQuality };
          const r = await call(() => (target === 'draft' ? this.pipeline.renderDraft(approved, ctx) : this.pipeline.renderFinal(approved, ctx)));
          if (!r.ok) return this.failJob(ref, job, 'RENDER_FAILED', r, true, emit, env.autoRetry);
          results.push([target, r]);
        }
        step('validating_output');
        for (const [target, r] of results) {
          const problem = checkArtifacts(r.artifacts, job.outputDir);
          if (problem) return this.failJob(ref, job, 'OUTPUT_INVALID', { ok: false, message: `${target}: ${problem}` }, false, emit, env.autoRetry);
          q.recordOutputs(ref, target, normalizeArtifacts(r.artifacts), r.rendererVersion);
        }
        job = q.complete(ref);
        emit({ type: 'state', jobId: job.jobId, state: 'completed', attempt: job.attempt });
        return 'ok';
      }
      return 'ok';
    } catch (e) {
      stopHeartbeat();
      if (isBulkError(e, 'TIMEOUT')) abort({ kind: 'timeout', error: e }); // no-op if another cause already aborted
      if (isBulkError(e, 'LEASE_LOST')) abort({ kind: 'lease_lost', error: e }); // seen by a commit, not the heartbeat
      const cause = causeOf(controller.signal);
      if (cause?.kind === 'cancelled') { emit({ type: 'cancelled', jobId: job.jobId }); return 'cancelled'; }
      if (cause?.kind === 'lease_lost') { emit({ type: 'lease_lost', jobId: job.jobId }); return 'lost'; }
      if (cause?.kind === 'heartbeat_fatal' || cause?.kind === 'run_fatal') throw cause.error; // fail closed, commit nothing
      if (isBulkError(e, 'ILLEGAL_TRANSITION')) throw e; // programming error: surface it
      const code: string = isBulkError(e) ? e.code : 'HANDLER_ERROR';
      const retryable = isBulkError(e) ? e.retryable : true;
      return this.failJob(ref, job, code, { ok: false, message: e instanceof Error ? e.message : String(e), retryable }, retryable, emit, env.autoRetry);
    } finally {
      stopHeartbeat();
      inflight.delete(controller);
    }
  }

  private failJob(ref: LeaseRef, job: JobRecord, fallbackCode: BulkErrorCode | string, f: HandlerFailure, defaultRetryable: boolean, emit: (e: ProgressEvent) => void, autoRetry: boolean): 'failed' | 'retrying' | 'lost' {
    const code = f.code ?? fallbackCode;
    let failed: JobRecord;
    try { failed = this.queue.fail(ref, { code, message: f.message, retryable: f.retryable ?? defaultRetryable }); }
    catch (e) { if (isBulkError(e, 'LEASE_LOST')) { emit({ type: 'lease_lost', jobId: job.jobId }); return 'lost'; } throw e; }
    emit({ type: 'failed', jobId: failed.jobId, attempt: failed.attempt, code, retryable: failed.retryable === true });
    if (failed.retryable && autoRetry) {
      const r = this.queue.retry(failed.batchId, failed.jobId);
      this.queue.requeueRetries(failed.batchId);
      emit({ type: 'retry', jobId: r.jobId, attempt: r.attempt, code });
      return 'retrying';
    }
    return 'failed';
  }
}

interface ProcessEnv { timers: Timers; heartbeatMs: number; autoRetry: boolean; defaultTimeoutMs?: number }

/**
 * Race a pipeline stage against the job deadline and the job's abort signal. Whatever the stage resolves to after the
 * race is lost (late result) is dropped: the caller has already left that code path, so it can never be committed.
 */
async function withDeadline<T>(fn: () => Promise<T>, ctx: PipelineContext, timers: Timers, clock: { now(): number }): Promise<T> {
  if (ctx.signal.aborted) throw new BulkError('CANCELLED', 'job aborted');
  let timer: unknown = null, onAbort: (() => void) | null = null;
  const racers: Promise<T>[] = [fn(), new Promise<never>((_, reject) => { onAbort = () => reject(new BulkError('CANCELLED', 'job aborted')); ctx.signal.addEventListener('abort', onAbort, { once: true }); })];
  if (ctx.deadline !== null) {
    const remaining = ctx.deadline - clock.now();
    if (remaining <= 0) racers.push(Promise.reject(new BulkError('TIMEOUT', 'job deadline exceeded', { retryable: true })));
    else racers.push(new Promise<never>((_, reject) => { timer = timers.setTimeout(() => reject(new BulkError('TIMEOUT', `job exceeded its ${Math.round(remaining)} ms budget`, { retryable: true })), remaining); }));
  }
  racers[0].catch(() => { /* a late rejection after the race is decided is intentionally ignored */ });
  try { return await Promise.race(racers); } finally {
    if (timer !== null) timers.clearTimeout(timer);
    if (onAbort) ctx.signal.removeEventListener('abort', onAbort);
  }
}

function checkArtifacts(a: Partial<ArtifactSet>, outputDir: string): string | null {
  const paths = (['mp4', 'episodeJson', 'timeline', 'qualityReport'] as const).map((k) => [k, a[k]] as const).filter(([, p]) => p !== undefined && p !== null);
  if (!paths.length) return 'renderer returned no artifacts';
  for (const [k, p] of paths) {
    if (!isSafeRelativePath(p)) return `${k} path ${JSON.stringify(p)} is not a safe relative path`;
    if (!isWithin(p as string, outputDir)) return `${k} path "${p}" is outside the job output dir "${outputDir}"`;
  }
  if (a.mp4Sha256 !== undefined && a.mp4Sha256 !== null && !HEX64.test(a.mp4Sha256)) return 'mp4Sha256 must be sha256 hex';
  if (a.mp4Sha256 && !a.mp4) return 'mp4Sha256 given without mp4 path';
  return null;
}

const normalizeArtifacts = (a: Partial<ArtifactSet>): ArtifactSet => ({
  mp4: a.mp4 ?? null, mp4Sha256: a.mp4Sha256 ?? null, episodeJson: a.episodeJson ?? null, timeline: a.timeline ?? null, qualityReport: a.qualityReport ?? null,
});

export function summarize(batchId: string, jobs: JobRecord[], stoppedEarly: boolean, aborted: boolean): RunSummary {
  const n = (s: JobState) => jobs.filter((j) => j.state === s).length;
  const completed = n('completed'), failed = n('failed'), cancelled = n('cancelled'), awaitingApproval = n('awaiting_approval');
  return { batchId, total: jobs.length, completed, failed, cancelled, awaitingApproval, open: jobs.length - completed - failed - cancelled - awaitingApproval, stoppedEarly, aborted };
}
