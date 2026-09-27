// Product naming lives in one place so it can be changed without touching code paths.
// "BLOCKSPARK STUDIO" is a TEMPORARY neutral codename. No trademark clearance has been performed for it or any
// other name; a proper clearance process is required before commercial launch (see docs/LEGAL_AND_ASSET_SAFETY.md).
// The former codename "RBLX SPARK" / "RBLX SPARK VIDEO FACTORY" is DEPRECATED (RBLX is Roblox Corporation's
// ticker) and must not appear in new user-facing output. Historical paths (repo folder, package name) keep it
// only to avoid breaking evidence links.
const env = (k: string): string | undefined => (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[k];

export const PRODUCT = {
  /** user-facing name; override with BLOCKSPARK_PRODUCT_NAME */
  name: env('BLOCKSPARK_PRODUCT_NAME') ?? 'BlockSpark Studio',
  /** short name used in file metadata (MP4 compressor name, max 31 chars) */
  shortName: env('BLOCKSPARK_PRODUCT_SHORT') ?? 'BlockSpark',
  codename: 'BLOCKSPARK STUDIO',
  deprecatedNames: ['RBLX SPARK', 'RBLX SPARK VIDEO FACTORY'],
  trademarkStatus: 'temporary codename — trademark clearance NOT performed; required before commercial launch',
} as const;
