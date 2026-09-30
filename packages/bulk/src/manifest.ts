// Deterministic, portable batch manifest. Same store contents → byte-identical manifest (canonical JSON, jobs sorted by
// episode ID, no wall-clock "generatedAt"). Paths are relative to the output root; absolute/machine paths are refused.
import { BulkError } from './errors.ts';
import { canonicalJson, sha256Hex } from './hash.ts';
import type { ArtifactSet, JobInput, JobRecord, RenderTarget } from './job.ts';
import { looksAbsolute } from './paths.ts';
import { BULK_SCHEMA_VERSION, sortCharacterRefs, type CharacterRef, type EnvironmentRef, type ResolvedBatch } from './schema.ts';
import { SEED_DERIVATION } from './seeds.ts';
import type { BulkStore } from './store.ts';

export const MANIFEST_VERSION = '1.0';
export const BULK_CORE_VERSION = '0.1.0';

export interface ManifestJob {
  jobId: string; episodeId: string; state: string; attempt: number; seed: number; seedDerived: boolean;
  inputHash: string; input: JobInput; projectHash: string | null; approvedHash: string | null; outputDir: string;
  artifacts: Partial<Record<RenderTarget, ArtifactSet>>; rendererVersion: string | null;
  error: { code: string; message: string; retryable: boolean; attempt: number } | null;
  startedAt: string | null; completedAt: string | null;
}

export interface BatchManifest {
  manifestVersion: string;
  bulkCoreVersion: string;
  schemaVersion: string;
  seedDerivation: string;
  batchId: string;
  title: string;
  mode: string;
  batchInputHash: string;
  batchSeed: number;
  rendererVersions: string[];
  /** every exact pin used by the batch, de-duplicated and sorted (id, version, hash) */
  resources: { characters: CharacterRef[]; environments: EnvironmentRef[] };
  counts: { total: number; completed: number; failed: number; cancelled: number; awaitingApproval: number; open: number };
  startedAt: string | null;
  completedAt: string | null;
  jobs: ManifestJob[];
  failures: { jobId: string; episodeId: string; code: string; message: string; attempt: number }[];
  /** sha256 of the canonical manifest without this field */
  manifestHash: string;
}

export function buildManifest(batch: ResolvedBatch, jobs: readonly JobRecord[]): BatchManifest {
  const byEp = new Map(batch.episodes.map((e) => [e.episodeId, e]));
  const sorted = [...jobs].sort((a, b) => (a.episodeId < b.episodeId ? -1 : a.episodeId > b.episodeId ? 1 : 0));
  const mj: ManifestJob[] = sorted.map((j) => ({
    jobId: j.jobId, episodeId: j.episodeId, state: j.state, attempt: j.attempt, seed: j.seed, seedDerived: byEp.get(j.episodeId)?.seedDerived ?? false,
    inputHash: j.inputHash,
    input: { characterRefs: sortCharacterRefs(j.input.characterRefs), environmentRef: { ...j.input.environmentRef }, voiceOver: j.input.voiceOver ? { ...j.input.voiceOver } : null },
    projectHash: j.projectHash, approvedHash: j.approvedHash, outputDir: j.outputDir,
    artifacts: j.outputs, rendererVersion: j.rendererVersion,
    error: j.error ? { code: j.error.code, message: j.error.message, retryable: j.error.retryable, attempt: j.error.attempt } : null,
    startedAt: j.startedAt, completedAt: j.completedAt,
  }));
  const count = (s: string) => jobs.filter((j) => j.state === s).length;
  const counts = { total: jobs.length, completed: count('completed'), failed: count('failed'), cancelled: count('cancelled'), awaitingApproval: count('awaiting_approval'), open: 0 };
  counts.open = counts.total - counts.completed - counts.failed - counts.cancelled - counts.awaitingApproval;
  const starts = jobs.map((j) => j.startedAt).filter((x): x is string => x !== null).sort();
  const ends = jobs.map((j) => j.completedAt).filter((x): x is string => x !== null).sort();
  const allSettled = counts.open === 0 && counts.awaitingApproval === 0;
  const body: Omit<BatchManifest, 'manifestHash'> = {
    manifestVersion: MANIFEST_VERSION, bulkCoreVersion: BULK_CORE_VERSION, schemaVersion: BULK_SCHEMA_VERSION, seedDerivation: SEED_DERIVATION,
    batchId: batch.batchId, title: batch.title, mode: batch.mode, batchInputHash: batch.inputHash, batchSeed: batch.batchSeed,
    rendererVersions: [...new Set(jobs.map((j) => j.rendererVersion).filter((x): x is string => !!x))].sort(),
    resources: collectResources(jobs),
    counts, startedAt: starts[0] ?? null, completedAt: allSettled ? (ends[ends.length - 1] ?? null) : null, jobs: mj,
    failures: mj.filter((j) => j.state === 'failed' && j.error).map((j) => ({ jobId: j.jobId, episodeId: j.episodeId, code: j.error!.code, message: j.error!.message, attempt: j.error!.attempt })),
  };
  assertPortable(body);
  const manifestHash = sha256Hex(canonicalJson(body));
  return { ...body, manifestHash };
}

function collectResources(jobs: readonly JobRecord[]): BatchManifest['resources'] {
  const key = (...p: string[]) => p.join('\u0000');
  const chars = new Map<string, CharacterRef>(), envs = new Map<string, EnvironmentRef>();
  for (const j of jobs) {
    for (const c of j.input.characterRefs) chars.set(key(c.characterId, c.version, c.contentHash), { characterId: c.characterId, version: c.version, contentHash: c.contentHash });
    const e = j.input.environmentRef;
    envs.set(key(e.environmentId, e.version, e.contentHash), { environmentId: e.environmentId, version: e.version, contentHash: e.contentHash });
  }
  const sorted = <T>(m: Map<string, T>) => [...m.keys()].sort().map((k) => m.get(k)!);
  return { characters: sorted(chars), environments: sorted(envs) };
}

/** Throws if any string in the manifest looks like an absolute / machine-specific path. */
export function assertPortable(value: unknown, path = '$'): void {
  if (typeof value === 'string') { if (looksAbsolute(value)) throw new BulkError('UNSAFE_PATH', `manifest ${path} contains a machine-specific path`); return; }
  if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) assertPortable(v, `${path}.${k}`);
}

export const serializeManifest = (m: BatchManifest): string => `${canonicalJson(m)}\n`;

/** Build from the store and write `batches/<id>/manifest.json` atomically. */
export function writeManifest(store: BulkStore, batchId: string): BatchManifest {
  const m = buildManifest(store.loadBatch(batchId).batch, store.readState(batchId).jobs);
  store.writeFile(`batches/${batchId}/manifest.json`, serializeManifest(m));
  return m;
}
