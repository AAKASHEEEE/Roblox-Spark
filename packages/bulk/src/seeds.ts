// Deterministic seed allocation. A derived seed depends ONLY on (batchId, episodeId, batchSeed, variant) — never on the
// episode's position, the batch size or any clock — so reordering or appending episodes cannot change existing seeds,
// and a retry (same job, same record) keeps its seed by construction.
import { sha256Bytes } from './hash.ts';

export const SEED_MAX = 0xffffffff;
export const SEED_DERIVATION = 'bulk-seed-v1';

export function deriveSeed(batchId: string, episodeId: string, batchSeed: number, variant = 0): number {
  if (!Number.isInteger(variant) || variant < 0) throw new Error('deriveSeed: variant must be a non-negative integer');
  const material = `${SEED_DERIVATION}\u0000${batchId}\u0000${episodeId}\u0000${batchSeed >>> 0}\u0000${variant}`;
  const d = sha256Bytes(new TextEncoder().encode(material));
  return ((d[0] << 24) | (d[1] << 16) | (d[2] << 8) | d[3]) >>> 0;
}

/** `variantOf` + `variant` mark an explicit "duplicate with new seed" copy of another episode. */
export interface SeedSource { episodeId: string; seed?: number; variantOf?: string; variant?: number }

export function seedFor(batchId: string, batchSeed: number, e: SeedSource): { seed: number; derived: boolean } {
  if (e.seed !== undefined) return { seed: e.seed, derived: false };
  return { seed: deriveSeed(batchId, e.variantOf ?? e.episodeId, batchSeed, e.variant ?? 0), derived: true };
}

/** Explicit seeds win; otherwise derive. Returns episodeId -> { seed, derived }. */
export function allocateSeeds(batchId: string, batchSeed: number, episodes: readonly SeedSource[]): Map<string, { seed: number; derived: boolean }> {
  const out = new Map<string, { seed: number; derived: boolean }>();
  for (const e of episodes) out.set(e.episodeId, seedFor(batchId, batchSeed, e));
  return out;
}
