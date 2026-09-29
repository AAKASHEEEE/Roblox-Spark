// Model-provider abstraction. Providers return UNTRUSTED values; the pipeline validates every response with the
// stage schema and never executes provider output.
import type { Registry } from '../registry.ts';
import type { NormalizedIdea, RepairConstraint, StoryRequest, VisualBeatPlan } from '../schemas.ts';
import type { TemplateSpec } from '../templates.ts';

export interface CallMeta { stage: string; ms: number; tokensIn: number; tokensOut: number; ok: boolean; error?: string; model: string; attempts: number }

export interface NormalizeInput { request: StoryRequest; registry: Registry; constraints: RepairConstraint[] }
export interface PlanInput { request: StoryRequest; idea: NormalizedIdea; template: TemplateSpec; registry: Registry; constraints: RepairConstraint[] }
export interface RepairInput { request: StoryRequest; idea: NormalizedIdea; plan: VisualBeatPlan; template: TemplateSpec; registry: Registry; constraints: RepairConstraint[]; attempt: number }

export interface StoryModelProvider {
  readonly name: string;
  readonly model: string;
  /** Stage A: raw (unvalidated) normalized idea */
  normalizeIdea(input: NormalizeInput): Promise<unknown>;
  /** Stage B: raw (unvalidated) visual beat plan */
  planBeats(input: PlanInput): Promise<unknown>;
  /** Stage G: raw (unvalidated) repair patches for the affected semantic fields only */
  repairPlan(input: RepairInput): Promise<unknown>;
  /** metadata of the most recent call (latency, tokens) */
  lastCall(): CallMeta | null;
}

export class ProviderError extends Error {
  readonly kind: 'timeout' | 'http' | 'network' | 'malformed' | 'config';
  readonly status?: number;
  constructor(kind: ProviderError['kind'], message: string, status?: number) { super(message); this.kind = kind; this.status = status; }
}

/** crude token estimate for providers that do not report usage (≈4 chars/token) */
export const estimateTokens = (s: string): number => Math.ceil(s.length / 4);
