// Prop-anchor validation + strict resolution. A prop never falls back to an arbitrary coordinate: a missing or
// incompatible anchor is an error, not a default.
import type { EnvironmentProfile, PropAnchor } from './schema.ts';
import type { CatalogIssue } from './marks.ts';

const finite = (p: readonly number[]) => p.every((n) => Number.isFinite(n));
const inside = (p: readonly number[], b: { min: readonly number[]; max: readonly number[] }) => p.every((x, i) => x >= b.min[i] && x <= b.max[i]);

export function validateAnchors(p: EnvironmentProfile): CatalogIssue[] {
  const out: CatalogIssue[] = [];
  const ids = new Map<string, PropAnchor>();
  const marks = new Map(p.marks.map((m) => [m.id, m]));
  p.anchors.forEach((a, i) => {
    const path = `anchors[${i}]`;
    if (ids.has(a.id)) out.push({ code: 'anchor_duplicate', path, message: `duplicate anchor id "${a.id}"` });
    if (marks.has(a.id)) out.push({ code: 'anchor_mark_collision', path, message: `anchor "${a.id}" shares an id with a mark` });
    ids.set(a.id, a);
    if (!finite(a.position) || !finite(a.rotationDeg) || !finite(a.maxSize)) out.push({ code: 'anchor_non_finite', path, message: `anchor "${a.id}" has non-finite values` });
    if (a.role === 'prop' && a.categories.length === 0) out.push({ code: 'anchor_no_category', path, message: `prop anchor "${a.id}" accepts no category` });
    if (a.parentSurface.kind !== 'prop_anchor' && finite(a.position) && !inside(a.position, p.bounds)) out.push({ code: 'anchor_out_of_bounds', path, message: `anchor "${a.id}" lies outside environment bounds` });
    if (a.parentSurface.kind === 'prop_anchor' && (!a.parentSurface.ref || !a.parentSurface.propAnchor)) out.push({ code: 'anchor_parent_missing', path, message: `anchor "${a.id}" on a prop needs parentSurface.ref and propAnchor` });
    if (a.parentSurface.kind !== 'prop_anchor' && (a.parentSurface.ref !== null || a.parentSurface.propAnchor !== null)) out.push({ code: 'anchor_parent_unexpected', path, message: `anchor "${a.id}" on ${a.parentSurface.kind} must not name a parent` });
    if (!a.scaling.allowed && a.scaling.maxScale !== 1) out.push({ code: 'anchor_scale', path, message: `anchor "${a.id}" forbids scaling but maxScale != 1` });
    for (const z of a.reachZones) {
      const m = marks.get(z.markId);
      if (!m) out.push({ code: 'anchor_reach_unknown', path, message: `anchor "${a.id}" reach zone names unknown mark "${z.markId}"` });
      else if (m.kind === 'offscreen_cue') out.push({ code: 'anchor_reach_offscreen', path, message: `anchor "${a.id}" cannot be reached from off-screen cue "${z.markId}"` });
    }
  });
  for (const a of p.anchors) if (a.parentSurface.kind === 'prop_anchor' && a.parentSurface.ref) {
    const parent = ids.get(a.parentSurface.ref);
    if (!parent || parent.role !== 'prop') out.push({ code: 'anchor_parent_unknown', path: `anchor:${a.id}`, message: `anchor "${a.id}" parent "${a.parentSurface.ref}" is not a prop anchor` });
    else if (parent.parentSurface.kind === 'prop_anchor') out.push({ code: 'anchor_parent_depth', path: `anchor:${a.id}`, message: `anchor "${a.id}" nests more than one prop deep` });
  }
  return out;
}

export interface PropPlacementRequest { instance: string; category: string; anchor: string; size?: readonly [number, number, number]; scale?: number }
export type AnchorCheck = { ok: true; anchor: PropAnchor; warnings: string[] } | { ok: false; code: 'anchor_missing' | 'anchor_role' | 'anchor_category' | 'anchor_size' | 'anchor_scale'; message: string };

/** check a requested prop placement against the profile. Never returns a fallback position. */
export function checkPropAnchor(p: EnvironmentProfile, req: PropPlacementRequest): AnchorCheck {
  const a = p.anchors.find((x) => x.id === req.anchor);
  const where = `${p.id}@${p.version}`;
  if (!a) return { ok: false, code: 'anchor_missing', message: `${where}: prop "${req.instance}" requires anchor "${req.anchor}", which this environment does not define` };
  if (a.role !== 'prop') return { ok: false, code: 'anchor_role', message: `${where}: "${req.anchor}" is a ${a.role} anchor, not a prop anchor` };
  if (!a.categories.includes(req.category)) return { ok: false, code: 'anchor_category', message: `${where}: anchor "${a.id}" accepts [${a.categories.join(', ')}], not "${req.category}"` };
  const scale = req.scale ?? 1;
  if (scale !== 1 && (!a.scaling.allowed || scale > a.scaling.maxScale)) return { ok: false, code: 'anchor_scale', message: `${where}: anchor "${a.id}" allows scale <= ${a.scaling.allowed ? a.scaling.maxScale : 1}, requested ${scale}` };
  if (req.size && req.size.some((s, i) => s > a.maxSize[i] + 1e-9)) return { ok: false, code: 'anchor_size', message: `${where}: prop "${req.instance}" base size exceeds anchor "${a.id}" maxSize` };
  const warnings = a.hazard.kind !== 'none' ? [`anchor "${a.id}" has hazard ${a.hazard.kind} (r=${a.hazard.radius} m)`] : [];
  return { ok: true, anchor: a, warnings };
}

/** throwing variant for scene assembly */
export function resolvePropAnchor(p: EnvironmentProfile, req: PropPlacementRequest): PropAnchor {
  const r = checkPropAnchor(p, req);
  if (!r.ok) throw new Error(r.message);
  return r.anchor;
}
