// Job state machine. Every transition is listed explicitly; anything else throws ILLEGAL_TRANSITION.
//
//   pending → validating → storyboard → awaiting_approval → approved → queued → leased → rendering → validating_output → completed
//   (prep phase: claimed with a prep lease)                              (render phase: claimed with a render lease)
//   any non-terminal (incl. failed) → cancelled · work states → failed · failed → retry_pending → pending | queued
//   lease-expiry recovery: validating|storyboard → pending ; leased|rendering|validating_output → queued
import { BulkError } from './errors.ts';

export const JOB_STATES = [
  'pending', 'validating', 'storyboard', 'awaiting_approval', 'approved', 'queued', 'leased', 'rendering',
  'validating_output', 'completed', 'failed', 'cancelled', 'retry_pending',
] as const;
export type JobState = (typeof JOB_STATES)[number];

export const TERMINAL_STATES: readonly JobState[] = ['completed', 'cancelled'];
export const PREP_LEASE_STATES: readonly JobState[] = ['validating', 'storyboard', 'awaiting_approval'];
export const RENDER_LEASE_STATES: readonly JobState[] = ['leased', 'rendering', 'validating_output'];

export const TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = {
  pending: ['validating', 'cancelled'],
  validating: ['storyboard', 'failed', 'cancelled', 'pending'],
  storyboard: ['awaiting_approval', 'failed', 'cancelled', 'pending'],
  awaiting_approval: ['approved', 'failed', 'cancelled'],
  approved: ['queued', 'cancelled'],
  queued: ['leased', 'cancelled'],
  leased: ['rendering', 'failed', 'cancelled', 'queued'],
  rendering: ['validating_output', 'failed', 'cancelled', 'queued'],
  validating_output: ['completed', 'failed', 'cancelled', 'queued'],
  completed: [],
  failed: ['retry_pending', 'cancelled'],
  cancelled: [],
  retry_pending: ['pending', 'queued', 'cancelled'],
};

export const canTransition = (from: JobState, to: JobState): boolean => TRANSITIONS[from]?.includes(to) ?? false;

export function assertTransition(from: JobState, to: JobState, jobId = '?'): void {
  if (!canTransition(from, to)) throw new BulkError('ILLEGAL_TRANSITION', `job ${jobId}: ${from} → ${to} is not allowed`, { details: { from, to } });
}

export const isTerminal = (s: JobState): boolean => TERMINAL_STATES.includes(s);
/** `failed` is settled for reporting but may still move to retry_pending. */
export const isSettled = (s: JobState): boolean => s === 'completed' || s === 'cancelled' || s === 'failed';
