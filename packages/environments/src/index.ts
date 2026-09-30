// Public entry for the versioned environment catalog (metadata only: no geometry, rendering or camera solving).
import { parseProfile, type EnvironmentProfile } from './schema.ts';
import { validateMarks, type CatalogIssue } from './marks.ts';
import { validateAnchors } from './anchors.ts';
import { validateCameraZones } from './camera-zones.ts';
import { verifyLock, type Catalog } from './lock.ts';

export * from './schema.ts';
export * from './marks.ts';
export * from './anchors.ts';
export * from './camera-zones.ts';
export * from './compatibility.ts';
export * from './lock.ts';
export * from './catalog.ts';

/** strict schema + semantic validation of one profile */
export function validateProfile(x: unknown): { ok: true; profile: EnvironmentProfile; issues: [] } | { ok: false; issues: CatalogIssue[] } {
  const r = parseProfile(x);
  if (!r.ok) return { ok: false, issues: r.issues.map((i) => ({ code: 'schema', path: i.path, message: i.message })) };
  const p = r.value;
  const issues = [...validateMarks(p), ...validateAnchors(p), ...validateCameraZones(p)];
  if (p.cast.min > p.cast.max) issues.push({ code: 'cast_range', path: 'cast', message: 'cast.min > cast.max' });
  if (p.collision.assetKey !== p.asset.key || p.collision.assetSha256 !== p.asset.sha256) issues.push({ code: 'collision_ref', path: 'collision', message: 'collision reference must point at the same locked asset as the geometry' });
  if (p.geometryVersion !== p.asset.key.split('@')[1]) issues.push({ code: 'geometry_version', path: 'geometryVersion', message: 'geometryVersion must equal the pinned asset version' });
  return issues.length ? { ok: false, issues } : { ok: true, profile: p, issues: [] };
}

/** validate every profile and the lock */
export function validateCatalog(c: Catalog): CatalogIssue[] {
  const out: CatalogIssue[] = [];
  for (const p of c.profiles) {
    const r = validateProfile(p);
    if (!r.ok) out.push(...r.issues.map((i) => ({ ...i, path: `${p.id}@${p.version}:${i.path}` })));
  }
  return [...out, ...verifyLock(c)];
}
