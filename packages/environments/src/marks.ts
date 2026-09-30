// Mark validation + lookup. Marks are named positions; off-screen cues are directions only and never geometry.
import type { EnvironmentProfile, Mark } from './schema.ts';

export interface CatalogIssue { code: string; path: string; message: string }

/** two bodies closer than this (xz, metres) cannot both hold a mark at once — matches staging ACTOR_PATH_MIN */
export const MIN_ACTOR_SEPARATION = 0.55;
const finite3 = (p: readonly number[]) => p.length === 3 && p.every((n) => typeof n === 'number' && Number.isFinite(n));
const inside = (p: readonly number[], b: { min: readonly number[]; max: readonly number[] }) => p.every((x, i) => x >= b.min[i] && x <= b.max[i]);
const xzDist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[2] - b[2]);

export function validateMarks(p: EnvironmentProfile): CatalogIssue[] {
  const out: CatalogIssue[] = [];
  const by = new Map<string, Mark>();
  p.marks.forEach((m, i) => {
    const path = `marks[${i}]`;
    if (by.has(m.id)) out.push({ code: 'mark_duplicate', path, message: `duplicate mark id "${m.id}"` });
    by.set(m.id, m);
    if (!finite3(m.position)) out.push({ code: 'mark_non_finite', path, message: `mark "${m.id}" has non-finite coordinates` });
    if (m.kind === 'offscreen_cue') {
      if (m.instantiateGeometry) out.push({ code: 'offscreen_geometry', path, message: `off-screen cue "${m.id}" must never be instantiated as geometry` });
      if (m.occupancy !== 0) out.push({ code: 'offscreen_occupancy', path, message: `off-screen cue "${m.id}" cannot be occupied` });
      if (m.camera.onScreen || m.camera.visibleIntents.length) out.push({ code: 'offscreen_visible', path, message: `off-screen cue "${m.id}" cannot be camera-visible` });
      if (!m.cueDirection || !finite3(m.cueDirection) || Math.hypot(...m.cueDirection) < 1e-6) out.push({ code: 'offscreen_direction', path, message: `off-screen cue "${m.id}" needs a finite non-zero cueDirection` });
      if (m.reachable.length) out.push({ code: 'offscreen_reachable', path, message: `off-screen cue "${m.id}" cannot be a path node` });
    } else {
      if (m.instantiateGeometry) out.push({ code: 'mark_geometry', path, message: `mark "${m.id}" must not instantiate geometry (profiles are metadata)` });
      if (m.cueDirection) out.push({ code: 'mark_cue_direction', path, message: `only off-screen cues carry cueDirection ("${m.id}")` });
      if (finite3(m.position) && !inside(m.position, p.bounds)) out.push({ code: 'mark_out_of_bounds', path, message: `mark "${m.id}" lies outside environment bounds` });
      if (m.kind === 'actor' && m.postures.length === 0) out.push({ code: 'mark_no_posture', path, message: `actor mark "${m.id}" supports no posture` });
      if (m.kind === 'waypoint' && m.occupancy !== 0) out.push({ code: 'waypoint_occupancy', path, message: `waypoint "${m.id}" is transit-only (occupancy 0)` });
    }
  });
  // references
  for (const m of p.marks) {
    for (const r of m.reachable) {
      const t = by.get(r);
      if (!t) out.push({ code: 'reach_unknown', path: `mark:${m.id}`, message: `"${m.id}" reaches unknown mark "${r}"` });
      else if (t.kind === 'offscreen_cue' || t.kind === 'prop') out.push({ code: 'reach_invalid', path: `mark:${m.id}`, message: `"${m.id}" cannot path to ${t.kind} "${r}"` });
      if (r === m.id) out.push({ code: 'reach_self', path: `mark:${m.id}`, message: `"${m.id}" reaches itself` });
    }
    if (m.aliasOf !== null) {
      const t = by.get(m.aliasOf);
      if (!t || t.aliasOf !== null || t.kind !== m.kind) out.push({ code: 'alias_invalid', path: `mark:${m.id}`, message: `"${m.id}" aliasOf "${m.aliasOf}" must name a canonical mark of the same kind` });
      else if (xzDist(t.position, m.position) > 1e-6 || t.position[1] !== m.position[1]) out.push({ code: 'alias_moved', path: `mark:${m.id}`, message: `alias "${m.id}" must share the exact position of "${t.id}"` });
    }
    for (const x of m.exclusiveWith) if (!by.has(x)) out.push({ code: 'exclusive_unknown', path: `mark:${m.id}`, message: `"${m.id}" exclusiveWith unknown mark "${x}"` });
  }
  // occupancy: dwell marks that overlap must be aliases or declared mutually exclusive
  // (aliases are checked above to sit exactly on their canonical mark, so only canonical marks are compared)
  const dwell = p.marks.filter((m) => m.kind === 'actor' && m.occupancy > 0 && m.aliasOf === null);
  for (let i = 0; i < dwell.length; i++) for (let j = i + 1; j < dwell.length; j++) {
    const a = dwell[i], b = dwell[j];
    if (!finite3(a.position) || !finite3(b.position)) continue;
    if (xzDist(a.position, b.position) < MIN_ACTOR_SEPARATION && !a.exclusiveWith.includes(b.id) && !b.exclusiveWith.includes(a.id))
      out.push({ code: 'occupancy_conflict', path: `mark:${a.id}`, message: `"${a.id}" and "${b.id}" overlap (<${MIN_ACTOR_SEPARATION} m) without aliasOf/exclusiveWith` });
  }
  for (const m of p.marks) if (m.kind === 'actor' && m.occupancy > 1) out.push({ code: 'occupancy_limit', path: `mark:${m.id}`, message: `actor mark "${m.id}" occupancy ${m.occupancy} > 1 (one body per mark)` });
  // reachability: every actor mark must be reachable from, and able to leave to, the rest of the actor graph
  const nodes = p.marks.filter((m) => m.kind === 'actor' || m.kind === 'waypoint');
  if (nodes.length > 1) {
    const adj = new Map<string, Set<string>>(nodes.map((m) => [m.id, new Set<string>()]));
    for (const m of nodes) for (const r of m.reachable) if (adj.has(r)) { adj.get(m.id)!.add(r); adj.get(r)!.add(m.id); }
    // aliases are the same spot: connect them to their canonical mark
    for (const m of nodes) if (m.aliasOf && adj.has(m.aliasOf)) { adj.get(m.id)!.add(m.aliasOf); adj.get(m.aliasOf)!.add(m.id); }
    const seen = new Set<string>([nodes[0].id]); const q = [nodes[0].id];
    while (q.length) for (const n of adj.get(q.shift()!)!) if (!seen.has(n)) { seen.add(n); q.push(n); }
    for (const m of nodes) if (!seen.has(m.id)) out.push({ code: 'reach_disconnected', path: `mark:${m.id}`, message: `mark "${m.id}" is not connected to the reachability graph` });
  }
  return out;
}

export const canonicalOf = (m: Mark): string => m.aliasOf ?? m.id;

export function getMark(p: EnvironmentProfile, id: string): Mark | undefined { return p.marks.find((m) => m.id === id); }

/** marks a scene builder may place something at. Off-screen cues are excluded by construction. */
export function placeableMarks(p: EnvironmentProfile): Mark[] { return p.marks.filter((m) => m.kind !== 'offscreen_cue'); }

/** resolve a mark for actor/prop placement; throws for unknown ids and for off-screen cues (never instantiated) */
export function resolvePlacementMark(p: EnvironmentProfile, id: string): Mark {
  const m = getMark(p, id);
  if (!m) throw new Error(`environment ${p.id}@${p.version}: unknown mark "${id}"`);
  if (m.kind === 'offscreen_cue') throw new Error(`environment ${p.id}@${p.version}: "${id}" is an off-screen cue (direction only) and cannot be placed`);
  return m;
}

/** max number of actors that can hold distinct actor marks at the same time (greedy over canonical, non-exclusive marks) */
export function simultaneousActorCapacity(p: EnvironmentProfile): number {
  const actor = p.marks.filter((m) => m.kind === 'actor' && m.occupancy > 0 && m.aliasOf === null).sort((a, b) => a.id.localeCompare(b.id));
  const taken: Mark[] = [];
  for (const m of actor) if (!taken.some((t) => t.exclusiveWith.includes(m.id) || m.exclusiveWith.includes(t.id))) taken.push(m);
  return taken.reduce((s, m) => s + m.occupancy, 0);
}
