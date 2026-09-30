// Persisted job record + transition helper. Records are plain JSON (they live inside the atomic state file).
import type { JobState } from './states.ts';
import { assertTransition } from './states.ts';
import type { BulkErrorCode } from './errors.ts';
import type { ResolvedEpisode } from './schema.ts';

export type LeaseKind = 'prep' | 'render';
export interface Lease { workerId: string; token: string; kind: LeaseKind; acquiredAt: string; expiresAt: string }

export interface ArtifactSet {
  /** all paths are relative to the configured output root (portable) */
  mp4: string | null;
  mp4Sha256: string | null;
  episodeJson: string | null;
  timeline: string | null;
  qualityReport: string | null;
}
export type RenderTarget = 'draft' | 'final';

export interface JobError { code: BulkErrorCode | string; message: string; retryable: boolean; attempt: number; at: string }
export interface HistoryEntry { state: JobState; at: string; attempt: number; note?: string }

export interface JobRecord {
  jobId: string;
  batchId: string;
  episodeId: string;
  attempt: number;
  maxAttempts: number;
  seed: number;
  state: JobState;
  history: HistoryEntry[];
  lease: Lease | null;
  inputHash: string;
  projectHash: string | null;
  /** small opaque JSON reference returned by generateStoryboard() (e.g. a storyboard file id), kept for resume */
  projectRef: unknown;
  approvedHash: string | null;
  /** opaque JSON handed back by EpisodePipeline.approve(); passed to renderDraft/renderFinal (must be JSON-serialisable) */
  approval: unknown;
  outputDir: string;
  outputs: Partial<Record<RenderTarget, ArtifactSet>>;
  rendererVersion: string | null;
  error: JobError | null;
  errors: JobError[];
  retryable: boolean | null;
  timeoutMs: number | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export const jobIdFor = (batchId: string, episodeId: string): string => `${batchId}--${episodeId}`;

export function newJob(ep: ResolvedEpisode, maxAttempts: number, at: string): JobRecord {
  return {
    jobId: jobIdFor(ep.batchId, ep.episodeId), batchId: ep.batchId, episodeId: ep.episodeId, attempt: 1, maxAttempts, seed: ep.seed,
    state: 'pending', history: [{ state: 'pending', at, attempt: 1 }], lease: null, inputHash: ep.inputHash, projectHash: null, projectRef: null,
    approvedHash: null, approval: null, outputDir: ep.outputDir, outputs: {}, rendererVersion: null, error: null, errors: [],
    retryable: null, timeoutMs: ep.timeoutMs, createdAt: at, updatedAt: at, startedAt: null, completedAt: null,
  };
}

/** The ONLY way a job's state changes: validates against TRANSITIONS and appends history. Mutates in place. */
export function transition(job: JobRecord, to: JobState, at: string, note?: string): JobRecord {
  assertTransition(job.state, to, job.jobId);
  job.state = to;
  job.history.push(note ? { state: to, at, attempt: job.attempt, note } : { state: to, at, attempt: job.attempt });
  job.updatedAt = at;
  if (to === 'validating' && job.startedAt === null) job.startedAt = at;
  if (to === 'completed' || to === 'cancelled' || to === 'failed') job.completedAt = at;
  return job;
}
