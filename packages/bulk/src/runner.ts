// Bulk runner: orchestrates validate → storyboard → approve → render → output validation for every job in a batch
// through an INJECTED EpisodePipeline. It never imports the renderer, never renders by itself and never retries forever
// (attempts are capped by the batch policy, default 2).
//
// Semantics
// - concurrency: at most N jobs in flight (N = min(option ?? batch.concurrency, jobs)); each worker holds one lease.
// - continue-on-error (default): a failed job does not stop the others.
// - stopOnFirstError: after the first job that ends failed without an automatic retry, no new job is claimed; in-flight
//   jobs finish; untouched jobs stay pending/queued so a later run can resume them.
// - retries: retryable failures (handler says so, thrown non-Bulk errors, timeouts) are retried while attempt < max,
//   keeping the same seed. Render-phase retries reuse the approval; prep-phase retries redo validation/storyboard.
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
  | { type: 'stopped'; reason: 'first_error' | 'cancelled' }
  | { type: 'done'; summary: RunSummary };

export interface RunOptions {
  concurrency?: number;
  stopOnFirstError?: boolean;
  signal?: AbortSignal;
  onEvent?: (e: ProgressEvent) => void;
  /** fallback per-job timeout when the episode has none (ms) */
  defaultTimeoutMs?: number;
  workerPrefix?: string;
  /** lease heartbeat period (ms, default leaseMs / 3) */
  heartbeatMs?: number;
}

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
    this.queue.store.recover(batchId);
    this.queue.recoverExpiredLeases(batchId);
    this.queue.requeueRetries(batchId);
    const emit = (e: ProgressEvent) => { try { opts.onEvent?.(e); } catch { /* observers never break the run */ } };
    const stopOnFirstError = opts.stopOnFirstError ?? batch.stopOnFirstError;
    const concurrency = Math.max(1, Math.min(opts.concurrency ?? batch.concurrency, batch.episodes.length));
    const inflight = new Set<AbortController>();
    const approvalChecked = new Set<string>();
    let stopped = false, aborted = false;

    const onAbort = () => {
      if (aborted) return;
      aborted = true; stopped = true;
      for (const c of inflight) c.abort();
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
          const outcome = await this.process(batch, c.job, c.lease, opts, emit, inflight, approvalChecked);
          if (outcome === 'failed' && stopOnFirstError && !stopped) { stopped = true; emit({ type: 'stopped', reason: 'first_error' }); }
        } finally { busy--; notify(); }
      }
      notify(); // let waiting siblings re-check (and exit) once this worker is done
    };
    try {
      await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(`${opts.workerPrefix ?? 'w'}${i + 1}`)));
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
    }
    const summary = summarize(batchId, this.queue.list(batchId), stopped && !aborted, aborted);
    emit({ type: 'done', summary });
    return summary;
  }

  /** Runs one claimed job until it leaves this worker's hands. Returns how it ended for this worker. */
  private async process(batch: ResolvedBatch, claimed: JobRecord, ref: LeaseRef, opts: RunOptions, emit: (e: ProgressEvent) => void,
    inflight: Set<AbortController>, approvalChecked: Set<string>): Promise<'ok' | 'failed' | 'retrying' | 'lost'> {
    const q = this.queue;
    const ep = batch.episodes.find((e) => e.episodeId === claimed.episodeId);
    if (!ep) throw new BulkError('NOT_FOUND', `episode ${claimed.episodeId} missing from batch ${batch.batchId}`);
    const controller = new AbortController();
    inflight.add(controller);
    const timeoutMs = claimed.timeoutMs ?? opts.defaultTimeoutMs ?? null;
    const ctx: PipelineContext = { batchId: batch.batchId, jobId: claimed.jobId, attempt: claimed.attempt, seed: claimed.seed, signal: controller.signal, deadline: timeoutMs === null ? null : Date.now() + timeoutMs };
    const heartbeat = setInterval(() => {
      try { q.renewLease(ref); } catch (e) { if (isBulkError(e, 'LEASE_LOST')) controller.abort(); }
    }, opts.heartbeatMs ?? Math.max(10, Math.floor(q.leaseMs / 3)));
    const call = <T>(p: () => Promise<T>) => withDeadline(p, ctx);
    let job = claimed;
    const step = (to: JobState, patch?: Parameters<JobQueue['advance']>[2]) => { job = q.advance(ref, to, patch); emit({ type: 'state', jobId: job.jobId, state: to, attempt: job.attempt }); };
    try {
      emit({ type: 'state', jobId: job.jobId, state: job.state, attempt: job.attempt });
      if (job.state === 'validating') {
        const v = await call(() => this.pipeline.validate(ep, ctx));
        if (!v.ok) return this.failJob(ref, job, 'VALIDATION_FAILED', v, false, emit);
        step('storyboard');
        const sb = await call(() => this.pipeline.generateStoryboard(ep, ctx));
        if (!sb.ok) return this.failJob(ref, job, 'STORYBOARD_FAILED', sb, true, emit);
        if (!HEX64.test(sb.projectHash)) return this.failJob(ref, job, 'OUTPUT_INVALID', { ok: false, message: 'storyboard projectHash must be sha256 hex' }, false, emit);
        step('awaiting_approval', { projectHash: sb.projectHash, projectRef: sb.projectRef ?? null });
      }
      if (job.state === 'awaiting_approval') {
        approvalChecked.add(job.jobId);
        const a = await call(() => this.pipeline.approve({ request: ep, projectHash: job.projectHash!, projectRef: job.projectRef }, ctx));
        if (a.status === 'pending') { q.release(ref); return 'ok'; }
        if (a.status === 'rejected') return this.failJob(ref, job, 'APPROVAL_REJECTED', { ok: false, message: a.message }, false, emit);
        if (!HEX64.test(a.approvedHash)) return this.failJob(ref, job, 'OUTPUT_INVALID', { ok: false, message: 'approvedHash must be sha256 hex' }, false, emit);
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
          if (!r.ok) return this.failJob(ref, job, 'RENDER_FAILED', r, true, emit);
          results.push([target, r]);
        }
        step('validating_output');
        for (const [target, r] of results) {
          const problem = checkArtifacts(r.artifacts, job.outputDir);
          if (problem) return this.failJob(ref, job, 'OUTPUT_INVALID', { ok: false, message: `${target}: ${problem}` }, false, emit);
          q.recordOutputs(ref, target, normalizeArtifacts(r.artifacts), r.rendererVersion);
        }
        job = q.complete(ref);
        emit({ type: 'state', jobId: job.jobId, state: 'completed', attempt: job.attempt });
        return 'ok';
      }
      return 'ok';
    } catch (e) {
      if (isBulkError(e, 'LEASE_LOST') || (controller.signal.aborted && !isBulkError(e, 'TIMEOUT'))) { emit({ type: 'lease_lost', jobId: job.jobId }); return 'lost'; }
      if (isBulkError(e, 'ILLEGAL_TRANSITION')) throw e; // programming error: surface it
      if (isBulkError(e, 'TIMEOUT')) controller.abort(); // tell the still-running handler to stop
      const code: string = isBulkError(e) ? e.code : 'HANDLER_ERROR';
      const retryable = isBulkError(e) ? e.retryable : true;
      return this.failJob(ref, job, code, { ok: false, message: e instanceof Error ? e.message : String(e), retryable }, retryable, emit);
    } finally {
      clearInterval(heartbeat);
      inflight.delete(controller);
    }
  }

  private failJob(ref: LeaseRef, job: JobRecord, fallbackCode: BulkErrorCode | string, f: HandlerFailure, defaultRetryable: boolean, emit: (e: ProgressEvent) => void): 'failed' | 'retrying' | 'lost' {
    const code = f.code ?? fallbackCode;
    let failed: JobRecord;
    try { failed = this.queue.fail(ref, { code, message: f.message, retryable: f.retryable ?? defaultRetryable }); }
    catch (e) { if (isBulkError(e, 'LEASE_LOST')) { emit({ type: 'lease_lost', jobId: job.jobId }); return 'lost'; } throw e; }
    emit({ type: 'failed', jobId: failed.jobId, attempt: failed.attempt, code, retryable: failed.retryable === true });
    if (failed.retryable) {
      const r = this.queue.retry(failed.batchId, failed.jobId);
      this.queue.requeueRetries(failed.batchId);
      emit({ type: 'retry', jobId: r.jobId, attempt: r.attempt, code });
      return 'retrying';
    }
    return 'failed';
  }
}

async function withDeadline<T>(fn: () => Promise<T>, ctx: PipelineContext): Promise<T> {
  if (ctx.signal.aborted) throw new BulkError('CANCELLED', 'job aborted');
  if (ctx.deadline === null) return fn();
  const remaining = ctx.deadline - Date.now();
  if (remaining <= 0) throw new BulkError('TIMEOUT', 'job deadline exceeded', { retryable: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new BulkError('TIMEOUT', `job exceeded its ${Math.round(remaining)} ms budget`, { retryable: true })), remaining); });
  try { return await Promise.race([fn(), timeout]); } finally { clearTimeout(timer); }
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
