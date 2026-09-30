// Bulk batch request — strict, versioned schema. Unknown keys are errors at every level (shared strict validator from
// packages/schema), plus semantic checks the structural validator cannot express: prototype-pollution keys anywhere,
// duplicate episode IDs, duplicate seeds, unsafe/outside-root paths, batch-size and concurrency limits.
import { v, type SchemaT, type Issue } from '../../schema/src/v.ts';
import { hashJson } from './hash.ts';
import { seedFor, SEED_MAX } from './seeds.ts';
import { isWithin, unsafePathReason } from './paths.ts';

export const BULK_SCHEMA_VERSION = '1.0';
export const BULK_MODES = ['narrated_story'] as const;
export type BulkMode = (typeof BULK_MODES)[number];
/** Mirrors packages/narrated STORY_PATTERNS; kept local so the bulk core stays independent of the narrated branch. */
export const BULK_STORY_PATTERNS = ['comparison', 'hypothetical', 'escalating_consequence', 'narrated_comedy'] as const;
export const DRAFT_QUALITIES = ['540x960', '720x1280'] as const;
export const FINAL_QUALITIES = ['1080x1920'] as const;
export const OUTPUT_KINDS = ['draft', 'final', 'both'] as const;
export type OutputKind = (typeof OUTPUT_KINDS)[number];
export const VOICE_FORMATS = ['wav', 'mp3', 'm4a'] as const;
export const FORBIDDEN_KEYS = ['__proto__', 'prototype', 'constructor'] as const;

export const DEFAULT_LIMITS = { maxEpisodes: 20, maxConcurrency: 4 } as const;
export interface BatchLimits {
  maxEpisodes?: number;
  maxConcurrency?: number;
  /** reject explicit or derived seed collisions inside one batch (default true) */
  requireUniqueSeeds?: boolean;
  /** when set, every episode output dir must lie beneath this relative root (e.g. "bulk") */
  outputRoot?: string;
}

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const id = () => v.string({ pattern: ID, max: 64 });
const relPath = () => v.string({ min: 1, max: 512 });
const hex64 = () => v.string({ pattern: /^[0-9a-f]{64}$/ });

const EpisodeRequestSchema = v.object({
  episodeId: id(),
  prompt: v.string({ min: 1, max: 2000 }),
  /** optional complete narration script; when present the pipeline must not rewrite it */
  script: v.string({ min: 1, max: 8000 }).optional(),
  voiceOver: v.object({ ref: relPath(), format: v.enum(VOICE_FORMATS).optional(), sha256: hex64().optional() }).optional(),
  characterIds: v.array(id(), { min: 1, max: 6 }),
  environmentId: id(),
  storyPattern: v.enum(BULK_STORY_PATTERNS).optional(),
  seed: v.int({ min: 0, max: SEED_MAX }).optional(),
  /** "duplicate with new seed": copy of `variantOf` whose seed is derived from (variantOf, variant) */
  variantOf: id().optional(),
  variant: v.int({ min: 1, max: 9999 }).optional(),
  targetDurationSec: v.number({ min: 5, max: 180 }).optional(),
  captionPreset: id().optional(),
  output: v.enum(OUTPUT_KINDS).optional(),
  outputDir: relPath().optional(),
  timeoutMs: v.int({ min: 1000, max: 3_600_000 }).optional(),
  tags: v.array(v.string({ pattern: /^[a-z0-9][a-z0-9_-]{0,31}$/ }), { max: 16 }).optional(),
  metadata: v.record(v.string({ max: 500 }), /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/).optional(),
});

export const BatchRequestSchema = v.object({
  schemaVersion: v.literal(BULK_SCHEMA_VERSION),
  batchId: id(),
  title: v.string({ min: 1, max: 200 }),
  mode: v.enum(BULK_MODES),
  concurrency: v.int({ min: 1, max: 64 }),
  batchSeed: v.int({ min: 0, max: SEED_MAX }).optional(),
  policy: v.object({ maxAttempts: v.int({ min: 1, max: 5 }).optional(), stopOnFirstError: v.boolean().optional() }).optional(),
  defaults: v.object({
    storyPattern: v.enum(BULK_STORY_PATTERNS),
    captionPreset: id(),
    draftQuality: v.enum(DRAFT_QUALITIES),
    finalQuality: v.enum(FINAL_QUALITIES),
    targetDurationSec: v.number({ min: 5, max: 180 }).optional(),
    output: v.enum(OUTPUT_KINDS).optional(),
    timeoutMs: v.int({ min: 1000, max: 3_600_000 }).optional(),
  }),
  episodes: v.array(EpisodeRequestSchema, { min: 1 }),
});

export type EpisodeRequest = SchemaT<typeof EpisodeRequestSchema>;
export type BatchRequest = SchemaT<typeof BatchRequestSchema>;

/** Episode with every default applied and its seed fixed — this is what a pipeline handler receives. */
export interface ResolvedEpisode {
  batchId: string;
  mode: BulkMode;
  episodeId: string;
  prompt: string;
  script: string | null;
  voiceOver: { ref: string; format: string | null; sha256: string | null } | null;
  characterIds: string[];
  environmentId: string;
  storyPattern: string;
  seed: number;
  seedDerived: boolean;
  variantOf: string | null;
  variant: number;
  targetDurationSec: number | null;
  captionPreset: string;
  output: OutputKind;
  draftQuality: string;
  finalQuality: string;
  outputDir: string;
  timeoutMs: number | null;
  tags: string[];
  metadata: Record<string, string>;
  /** sha256 of the canonical resolved episode (excluding this field) */
  inputHash: string;
}

export interface ResolvedBatch {
  schemaVersion: typeof BULK_SCHEMA_VERSION;
  batchId: string;
  title: string;
  mode: BulkMode;
  concurrency: number;
  batchSeed: number;
  maxAttempts: number;
  stopOnFirstError: boolean;
  /** sha256 of the canonical validated request */
  inputHash: string;
  request: BatchRequest;
  episodes: ResolvedEpisode[];
}

export type ParseResult = { ok: true; batch: ResolvedBatch } | { ok: false; issues: Issue[] };

export const DEFAULT_MAX_ATTEMPTS = 2;

/** Deep scan for prototype-pollution keys (JSON.parse creates `__proto__` as an OWN key, so this must run first). */
export function findForbiddenKeys(value: unknown, path = '$', out: Issue[] = [], depth = 0): Issue[] {
  if (depth > 32) { out.push({ path, message: 'nesting deeper than 32 levels' }); return out; }
  if (value && typeof value === 'object') {
    const isArr = Array.isArray(value);
    for (const k of Object.keys(value)) {
      const p = isArr ? `${path}[${k}]` : `${path}.${k}`;
      if ((FORBIDDEN_KEYS as readonly string[]).includes(k)) out.push({ path: p, message: 'forbidden key (prototype pollution)' });
      findForbiddenKeys((value as Record<string, unknown>)[k], p, out, depth + 1);
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== Array.prototype && Object.getPrototypeOf(value) !== null) out.push({ path, message: 'non-plain object' });
  }
  return out;
}

export function parseBatchRequest(raw: unknown, limits: BatchLimits = {}): ParseResult {
  const maxEpisodes = limits.maxEpisodes ?? DEFAULT_LIMITS.maxEpisodes;
  const maxConcurrency = limits.maxConcurrency ?? DEFAULT_LIMITS.maxConcurrency;
  const requireUniqueSeeds = limits.requireUniqueSeeds ?? true;
  const forbidden = findForbiddenKeys(raw);
  if (forbidden.length) return { ok: false, issues: forbidden };
  const r = BatchRequestSchema.parse(raw);
  if (!r.ok) return { ok: false, issues: r.issues };
  const req = r.value;
  const issues: Issue[] = [];
  if (req.episodes.length > maxEpisodes) issues.push({ path: '$.episodes', message: `batch has ${req.episodes.length} episodes; limit is ${maxEpisodes}` });
  if (req.concurrency > maxConcurrency) issues.push({ path: '$.concurrency', message: `concurrency ${req.concurrency} exceeds limit ${maxConcurrency}` });
  if (req.concurrency > req.episodes.length) issues.push({ path: '$.concurrency', message: `concurrency ${req.concurrency} exceeds episode count ${req.episodes.length}` });
  if (limits.outputRoot !== undefined && unsafePathReason(limits.outputRoot)) issues.push({ path: '$(limits.outputRoot)', message: `configured output root is unsafe: ${unsafePathReason(limits.outputRoot)}` });

  const batchSeed = req.batchSeed ?? 0;
  const ids = new Map<string, number>();
  const seeds = new Map<number, string>();
  const episodes: ResolvedEpisode[] = [];
  req.episodes.forEach((e, i) => {
    const p = `$.episodes[${i}]`;
    if (ids.has(e.episodeId)) issues.push({ path: `${p}.episodeId`, message: `duplicate episode ID "${e.episodeId}" (first at index ${ids.get(e.episodeId)})` });
    ids.set(e.episodeId, i);
    if ((e.variantOf === undefined) !== (e.variant === undefined)) issues.push({ path: `${p}.variant`, message: 'variantOf and variant must be given together' });
    if (e.variantOf !== undefined && e.variantOf === e.episodeId) issues.push({ path: `${p}.variantOf`, message: 'an episode cannot be a variant of itself' });
    if (e.voiceOver) { const why = unsafePathReason(e.voiceOver.ref); if (why) issues.push({ path: `${p}.voiceOver.ref`, message: `unsafe path: ${why}` }); }
    const outputDir = e.outputDir ?? `${limits.outputRoot ? `${limits.outputRoot}/` : ''}${req.batchId}/${e.episodeId}`;
    const why = unsafePathReason(outputDir);
    if (why) issues.push({ path: `${p}.outputDir`, message: `unsafe path: ${why}` });
    else if (limits.outputRoot !== undefined && !isWithin(outputDir, limits.outputRoot)) issues.push({ path: `${p}.outputDir`, message: `output path "${outputDir}" is outside the configured root "${limits.outputRoot}"` });
    const { seed, derived } = seedFor(req.batchId, batchSeed, e);
    if (requireUniqueSeeds) {
      if (seeds.has(seed)) issues.push({ path: `${p}.seed`, message: `seed ${seed} duplicates episode "${seeds.get(seed)}"` });
      seeds.set(seed, e.episodeId);
    }
    const base: Omit<ResolvedEpisode, 'inputHash'> = {
      batchId: req.batchId, mode: req.mode, episodeId: e.episodeId, prompt: e.prompt, script: e.script ?? null,
      voiceOver: e.voiceOver ? { ref: e.voiceOver.ref, format: e.voiceOver.format ?? null, sha256: e.voiceOver.sha256 ?? null } : null,
      characterIds: [...e.characterIds], environmentId: e.environmentId, storyPattern: e.storyPattern ?? req.defaults.storyPattern,
      seed, seedDerived: derived, variantOf: e.variantOf ?? null, variant: e.variant ?? 0,
      targetDurationSec: e.targetDurationSec ?? req.defaults.targetDurationSec ?? null,
      captionPreset: e.captionPreset ?? req.defaults.captionPreset, output: e.output ?? req.defaults.output ?? 'draft',
      draftQuality: req.defaults.draftQuality, finalQuality: req.defaults.finalQuality, outputDir,
      timeoutMs: e.timeoutMs ?? req.defaults.timeoutMs ?? null, tags: [...(e.tags ?? [])], metadata: { ...(e.metadata ?? {}) },
    };
    episodes.push({ ...base, inputHash: hashJson(base) });
  });
  // variants must point at an episode in the same batch
  req.episodes.forEach((e, i) => { if (e.variantOf !== undefined && !ids.has(e.variantOf)) issues.push({ path: `$.episodes[${i}].variantOf`, message: `unknown episode "${e.variantOf}"` }); });
  // two episodes may not write into the same (or nested) output directory
  for (let a = 0; a < episodes.length; a++) for (let b = a + 1; b < episodes.length; b++) {
    if (isWithin(episodes[a].outputDir, episodes[b].outputDir) || isWithin(episodes[b].outputDir, episodes[a].outputDir)) issues.push({ path: `$.episodes[${b}].outputDir`, message: `output dir overlaps episode "${episodes[a].episodeId}"` });
  }
  if (issues.length) return { ok: false, issues };
  return {
    ok: true,
    batch: {
      schemaVersion: BULK_SCHEMA_VERSION, batchId: req.batchId, title: req.title, mode: req.mode, concurrency: req.concurrency, batchSeed,
      maxAttempts: req.policy?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, stopOnFirstError: req.policy?.stopOnFirstError ?? false,
      inputHash: hashJson(req), request: req, episodes,
    },
  };
}

/**
 * "Duplicate with new seed": returns a NEW episode request (append it to the batch) that copies `episodeId` and gets a
 * deterministic variant seed. Same (batch, episode, variant) always yields the same seed; the original is untouched.
 */
export function duplicateWithNewSeed(req: BatchRequest, episodeId: string, variant: number): EpisodeRequest {
  const src = req.episodes.find((e) => e.episodeId === episodeId);
  if (!src) throw new Error(`duplicateWithNewSeed: unknown episode "${episodeId}"`);
  if (!Number.isInteger(variant) || variant < 1) throw new Error('duplicateWithNewSeed: variant must be an integer >= 1');
  const root = src.variantOf ?? src.episodeId;
  const { seed: _s, outputDir: _o, variantOf: _v, variant: _n, ...rest } = src;
  return { ...rest, episodeId: `${root}-v${variant}`.slice(0, 64), variantOf: root, variant };
}
