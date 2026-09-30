// Camera-zone METADATA validation and point queries. This is not a camera solver: it only answers "is this
// position/intent permitted by the profile", which a solver elsewhere may consult.
import type { EnvironmentProfile, ShotIntent } from './schema.ts';
import type { CatalogIssue } from './marks.ts';

type Box = { min: readonly number[]; max: readonly number[] };
const finite = (p: readonly number[]) => p.every((n) => Number.isFinite(n));
const ordered = (b: Box) => b.min.every((x, i) => x < b.max[i]);
const inside = (p: readonly number[], b: Box) => p.every((x, i) => x >= b.min[i] && x <= b.max[i]);

export function validateCameraZones(p: EnvironmentProfile): CatalogIssue[] {
  const out: CatalogIssue[] = [];
  const z = p.cameraZones;
  const seen = new Set<string>();
  const uniq = (id: string, path: string) => { if (seen.has(id)) out.push({ code: 'camera_duplicate', path, message: `duplicate camera zone id "${id}"` }); seen.add(id); };
  if (z.ceilingY > p.bounds.max[1] + 1e-9) out.push({ code: 'camera_ceiling_above_room', path: 'cameraZones.ceilingY', message: `ceilingY ${z.ceilingY} is above the room (${p.bounds.max[1]})` });
  if (z.ceilingY <= p.bounds.min[1]) out.push({ code: 'camera_ceiling_below_floor', path: 'cameraZones.ceilingY', message: 'ceilingY is at or below the floor' });
  z.safeVolumes.forEach((s, i) => {
    const path = `cameraZones.safeVolumes[${i}]`;
    uniq(s.id, path);
    if (!finite(s.min) || !finite(s.max) || !ordered(s)) { out.push({ code: 'camera_volume_invalid', path, message: `safe volume "${s.id}" must be finite with min < max` }); return; }
    if (s.max[1] > z.ceilingY + 1e-9) out.push({ code: 'camera_above_ceiling', path, message: `safe volume "${s.id}" top ${s.max[1]} exceeds ceiling ${z.ceilingY}` });
    if (s.min[1] < p.bounds.min[1]) out.push({ code: 'camera_below_floor', path, message: `safe volume "${s.id}" goes below the floor` });
    for (const [side, axis, bound, sign] of [['-x', 0, p.bounds.min[0], 1], ['+x', 0, p.bounds.max[0], -1], ['-z', 2, p.bounds.min[2], 1], ['+z', 2, p.bounds.max[2], -1]] as const) {
      if (z.openSides.includes(side)) continue;
      const edge = sign > 0 ? s.min[axis] : s.max[axis];
      if ((edge - bound) * sign < z.minWallClearance - 1e-9) out.push({ code: 'camera_wall_clearance', path, message: `safe volume "${s.id}" is closer than ${z.minWallClearance} m to wall ${side}` });
    }
    if (s.topDownAllowed && !s.allowedIntents.includes('top_down_insert')) out.push({ code: 'camera_topdown_intent', path, message: `safe volume "${s.id}" allows top-down but not the top_down_insert intent` });
    if (!s.topDownAllowed && s.allowedIntents.includes('top_down_insert')) out.push({ code: 'camera_topdown_intent', path, message: `safe volume "${s.id}" lists top_down_insert without topDownAllowed` });
    if (s.maxCastFraming > p.cast.max) out.push({ code: 'camera_cast_framing', path, message: `safe volume "${s.id}" frames ${s.maxCastFraming} > cast.max ${p.cast.max}` });
  });
  z.exclusionVolumes.forEach((e, i) => {
    const path = `cameraZones.exclusionVolumes[${i}]`;
    uniq(e.id, path);
    if (!finite(e.min) || !finite(e.max) || !ordered(e)) out.push({ code: 'camera_exclusion_invalid', path, message: `exclusion volume "${e.id}" must be finite with min < max` });
  });
  z.lensCorridors.forEach((c, i) => {
    const path = `cameraZones.lensCorridors[${i}]`;
    uniq(c.id, path);
    for (const [end, pt] of [['from', c.from], ['to', c.to]] as const) {
      const why = cameraPositionProblem(p, pt);
      if (why) out.push({ code: 'camera_corridor_endpoint', path, message: `lens corridor "${c.id}" ${end}: ${why}` });
    }
    for (const it of c.intents) if (!z.safeVolumes.some((s) => s.allowedIntents.includes(it) && (inside(c.from, s) || inside(c.to, s))))
      out.push({ code: 'camera_corridor_intent', path, message: `lens corridor "${c.id}" intent ${it} is not allowed by a safe volume at either end` });
  });
  const a = z.axis;
  if (!finite(a.stageLineA) || !finite(a.stageLineB) || Math.hypot(a.stageLineA[0] - a.stageLineB[0], a.stageLineA[2] - a.stageLineB[2]) < 1e-6) out.push({ code: 'camera_axis_invalid', path: 'cameraZones.axis', message: 'stage line must be two distinct finite points' });
  return out;
}

/** reason a camera position is not permitted, or null. Ignores intent. */
export function cameraPositionProblem(p: EnvironmentProfile, pos: readonly number[]): string | null {
  const z = p.cameraZones;
  if (pos.length !== 3 || !finite(pos)) return 'non-finite position';
  if (pos[1] > z.ceilingY) return `above ceiling ${z.ceilingY}`;
  const ex = z.exclusionVolumes.find((e) => inside(pos, e));
  if (ex) return `inside exclusion volume "${ex.id}"`;
  if (!z.safeVolumes.some((s) => inside(pos, s))) return 'outside every safe volume';
  return null;
}

/** whether the profile permits a camera at `pos` for `intent` (metadata query, not a solver) */
export function isCameraAllowed(p: EnvironmentProfile, pos: readonly number[], intent: ShotIntent): { ok: boolean; reason: string | null } {
  const why = cameraPositionProblem(p, pos);
  if (why) return { ok: false, reason: why };
  if (!p.cameraZones.safeVolumes.some((s) => inside(pos, s) && s.allowedIntents.includes(intent))) return { ok: false, reason: `no safe volume at this position allows ${intent}` };
  return { ok: true, reason: null };
}

/** safe volumes permitting an intent (compatibility uses this to report missing camera zones) */
export const zonesForIntent = (p: EnvironmentProfile, intent: ShotIntent) => p.cameraZones.safeVolumes.filter((s) => s.allowedIntents.includes(intent));
