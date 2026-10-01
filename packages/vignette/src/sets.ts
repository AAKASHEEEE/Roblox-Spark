// Set layouts for staging: every set a beat sheet uses gets an origin in one shared world (sets never overlap), its
// marks and doors in WORLD coordinates, set dressing implied by prop marks, walk bounds and static walk obstacles.
// Available sets read marks from the locked environment manifest plus the environment catalog (S2); planned sets get a
// deterministic grey room whose marks/doors are allocated from the names the beats use (validation is format-only for
// planned sets, so any mark name may appear there).
import type { EnvironmentManifest } from '../../schema/src/assets.ts';
import type { BeatSheet } from '../../director/src/beat-sheet.ts';
import { LIBRARY, lookup, type Library, type SetEntry } from '../../library/src/ids.ts';
import { resolveManifestKey, type ManifestLibrary } from '../../engine/src/build-dispatch.ts';
import { ENVIRONMENT_CATALOG } from '../../environments/src/catalog.ts';
import type { Mark as EnvironmentMark, PropAnchor } from '../../environments/src/schema.ts';
import { placeholderSet, type PlaceholderSetSpec } from './placeholders.ts';
import { resolveAsset } from './resolve.ts';

export type Vec3 = [number, number, number];
export type PlacementCapability = 'actor-standing' | 'actor-seated' | 'waypoint' | 'prop' | 'hazard' | 'interaction' | 'camera-look-only';
export interface StageMark {
  id: string;
  pos: Vec3;
  facingDeg: number;
  source: 'manifest' | 'catalog' | 'generated' | 'dressing';
  /** props placed here stand on this height */
  surfaceY: number;
  /** Semantic placement roles retained from the environment profile. */
  capabilities: PlacementCapability[];
  postures: string[];
  occupancy: number;
  reachable: string[];
  exclusiveWith: string[];
  hazard: string;
  aliasOf?: string;
}
export interface StageDoor {
  id: string;
  /** floor point in the doorway (world) */
  threshold: Vec3;
  /** direction an entering character faces (into the room) */
  facingDeg: number;
  /** first point inside the room an entering character walks to (world) */
  inside: Vec3;
  source: 'staging' | 'generated';
  note?: string;
}
export interface SetDressing { instance: string; propRef: string; pos: Vec3; yawDeg: number; reason: string }
export interface Box2 { id: string; x0: number; x1: number; z0: number; z1: number }
export interface SetLayout {
  id: string;
  index: number;
  status: 'available' | 'planned' | 'unknown';
  resolution: 'available' | 'placeholder';
  /** environment manifest key (id@version) or the placeholder key */
  key: string;
  manifest: EnvironmentManifest;
  origin: Vec3;
  marks: Record<string, StageMark>;
  doors: Record<string, StageDoor>;
  dressing: SetDressing[];
  lighting: string[];
  /** walkable floor rectangle (world xz) */
  walk: Box2;
  /** static obstacles for walking (world xz, NOT inflated): colliders + dressing */
  obstacles: Box2[];
  notes: string[];
}

/** spacing between set origins along +x (m): larger than any set, so sets never see each other */
export const SET_SPACING = 40;

/**
 * Doors the classroom manifest does not author yet. The catalog keeps classroom_door as an off-screen cue beyond
 * wall_left ([-5.2, 0, -2.6]); the beat sheets stage a visible door (planned prop `door`) that characters walk through,
 * so staging needs a doorway inside the room. It uses the free stretch of wall_back stage-right of the chalkboard
 * (x 1.75..4.6; clock above at 3.1 m): upstage of the action, so audience-side shots keep the door in the background.
 */
const STAGING_DOORS: Record<string, Record<string, { threshold: Vec3; facingDeg: number; inside: Vec3; note: string }>> = {
  classroom: { classroom_door: { threshold: [2.5, 0, -3.95], facingDeg: 0, inside: [2.5, 0, -3.0], note: 'catalog: off-screen cue beyond wall_left; staging doorway on wall_back stage-right of the board (S2 to author)' } },
};
/** prop marks that imply set dressing (catalog kind "prop" marks are anchors of a carrier prop) */
const DRESSING: Record<string, Record<string, { instance: string; propRef: string; anchor: string; surfaceAnchor: string; reason: string }>> = {
  classroom: { button_desk: { instance: 'hero_desk', propRef: 'student_desk@1.0.0', anchor: 'hero_desk_spot', surfaceAnchor: 'button_spot', reason: 'button_desk = the desk carrying the button (catalog: manifest.anchors.hero_desk_spot)' } },
};

const add = (a: readonly number[], b: readonly number[]): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const bare = (r: string) => r.split('@')[0];

const generatedMark = (id: string, pos: Vec3, facingDeg: number, source: StageMark['source'] = 'generated'): StageMark => ({
  id, pos, facingDeg, source, surfaceY: 0, capabilities: ['actor-standing'], postures: ['stand'], occupancy: 1,
  reachable: [], exclusiveWith: [], hazard: 'none',
});
const capabilitiesForMark = (m: EnvironmentMark): PlacementCapability[] => {
  const out: PlacementCapability[] = [];
  if (m.kind === 'actor') {
    if (m.postures.includes('stand') || m.postures.includes('crouch') || m.postures.includes('prone')) out.push('actor-standing');
    if (m.postures.includes('sit')) out.push('actor-seated');
  } else if (m.kind === 'waypoint') out.push('waypoint');
  else if (m.kind === 'prop') out.push('prop');
  else out.push('camera-look-only');
  if (m.hazard.kind !== 'none') out.push('hazard');
  return out;
};
const profiledMark = (m: EnvironmentMark, origin: Vec3, source: StageMark['source'] = 'catalog'): StageMark => ({
  id: m.id, pos: add(m.position, origin), facingDeg: m.facingDeg, source, surfaceY: 0,
  capabilities: capabilitiesForMark(m), postures: [...m.postures], occupancy: m.occupancy,
  reachable: [...m.reachable], exclusiveWith: [...m.exclusiveWith], hazard: m.hazard.kind,
  ...(m.aliasOf ? { aliasOf: m.aliasOf } : {}),
});
const anchorMark = (a: PropAnchor, origin: Vec3): StageMark => ({
  id: a.id, pos: add(a.position, origin), facingDeg: a.rotationDeg[1], source: 'catalog', surfaceY: a.position[1],
  capabilities: a.role === 'look_target' ? ['camera-look-only'] : a.categories.includes('device') ? ['interaction'] : ['prop'],
  postures: [], occupancy: 0, reachable: [], exclusiveWith: [], hazard: a.hazard.kind,
});

/** names the beats use in a set: marks (cast/prop placements, lookAt/vfx targets that are not entities) and doors */
function namesUsed(sheet: BeatSheet, setId: string): { marks: string[]; doors: string[]; lighting: string[] } {
  const marks: string[] = [], doors: string[] = [], lighting: string[] = [];
  const addU = (xs: string[], x: string) => { if (!xs.includes(x)) xs.push(x); };
  for (const b of sheet.beats) {
    if (bare(b.setId) !== setId) continue;
    addU(lighting, b.lighting);
    const ents = new Set([...b.cast.map((c) => bare(c.characterId)), ...b.props.map((p) => p.instanceId ?? bare(p.propId))]);
    for (const e of b.events) if (e.type === 'enter' || e.type === 'exit' || e.type === 'door_open' || e.type === 'door_close') addU(doors, e.doorId);
    for (const c of b.cast) {
      const [k, t] = c.placement.includes(':') ? c.placement.split(':') : ['mark', c.placement];
      if (k === 'mark') addU(marks, t); else addU(doors, t);
      if (c.lookAt && c.lookAt !== 'camera' && !ents.has(c.lookAt) && !doors.includes(c.lookAt)) addU(marks, c.lookAt);
    }
    for (const p of b.props) {
      const [k, t] = p.placement.includes(':') ? p.placement.split(':') : ['mark', p.placement];
      if (k === 'mark' && !doors.includes(t)) addU(marks, t);
    }
  }
  return { marks, doors, lighting };
}

/** deterministic mark grid for planned sets: front row centre-out, then a back row, then a far-front row */
const GRID: Array<[number, number]> = [[-0.8, 0], [0.8, 0], [0, 0.6], [-2.6, -0.4], [2.6, -0.4], [0, -1.4], [-1.4, -1.6], [1.4, -1.6], [-3.2, 1.0], [3.2, 1.0], [-0.8, 1.4], [0.8, 1.4]];
const FACE_ROW = (x: number) => Math.max(-35, Math.min(35, -x * 12));

function plannedLayout(id: string, used: ReturnType<typeof namesUsed>): PlaceholderSetSpec {
  const half: [number, number] = [4.6, 4.0];
  const marks: PlaceholderSetSpec['marks'] = {};
  used.marks.forEach((m, k) => {
    const [x, z] = GRID[k % GRID.length], ring = Math.floor(k / GRID.length);
    const pos: Vec3 = [x + ring * 0.35, 0, z - ring * 0.3];
    marks[m] = { pos, facingDeg: FACE_ROW(pos[0]) };
  });
  const doors: PlaceholderSetSpec['doors'] = {};
  used.doors.forEach((d, k) => {
    const side = k % 3; // left wall, right wall, back wall
    const slot = Math.floor(k / 3);
    if (side === 0) doors[d] = { pos: [-half[0] + 0.05, 0, -1.4 + slot * 1.6], facingDeg: 90 };
    else if (side === 1) doors[d] = { pos: [half[0] - 0.05, 0, -1.4 + slot * 1.6], facingDeg: -90 };
    else doors[d] = { pos: [-2.6 + slot * 1.8, 0, -half[1] + 0.05], facingDeg: 0 };
  });
  return { id, marks, doors, lighting: used.lighting, half };
}

export function layoutSets(sheet: BeatSheet, lib: ManifestLibrary, library: Library = LIBRARY): SetLayout[] {
  const order: string[] = [];
  for (const b of sheet.beats) if (!order.includes(bare(b.setId))) order.push(bare(b.setId));
  const refOf = (id: string) => sheet.beats.find((b) => bare(b.setId) === id)!.setId;
  return order.map((id, index) => {
    const origin: Vec3 = [index * SET_SPACING, 0, 0];
    const entry = lookup('sets', refOf(id), library) as SetEntry | undefined;
    const res = resolveAsset('sets', refOf(id), lib, library);
    const used = namesUsed(sheet, id);
    const notes: string[] = [];
    const marks: Record<string, StageMark> = {}, doors: Record<string, StageDoor> = {};
    const dressing: SetDressing[] = [];
    let manifest: EnvironmentManifest, key: string;
    if (res.resolution === 'available' && resolveManifestKey(refOf(id), lib.environments)) {
      key = resolveManifestKey(refOf(id), lib.environments)!;
      manifest = lib.environments[key];
      for (const [m, v] of Object.entries(manifest.marks)) marks[m] = generatedMark(m, add(v.pos, origin), v.facingDeg, 'manifest');
      const prof = ENVIRONMENT_CATALOG.profiles.find((p) => `${p.id}@${p.version}` === key);
      for (const cm of prof?.marks ?? []) {
        if (cm.kind === 'offscreen_cue') continue;
        const source = marks[cm.id]?.source ?? 'catalog';
        marks[cm.id] = profiledMark(cm, origin, source);
      }
      for (const a of prof?.anchors ?? []) {
        if (marks[a.id] || a.role !== 'look_target') continue;
        marks[a.id] = anchorMark(a, origin);
      }
      for (const [mk, d] of Object.entries(DRESSING[id] ?? {})) {
        if (!used.marks.includes(mk)) continue;
        const desk = lib.props[d.propRef], at = manifest.anchors[d.anchor];
        if (!desk || !at) { notes.push(`dressing for ${mk} unavailable (${d.propRef} / ${d.anchor})`); continue; }
        const pos = add(at, origin);
        dressing.push({ instance: d.instance, propRef: d.propRef, pos, yawDeg: 0, reason: d.reason });
        const s = desk.anchors[d.surfaceAnchor];
        const prior = marks[mk];
        marks[mk] = {
          ...(prior ?? generatedMark(mk, pos, 0, 'dressing')),
          id: mk, pos: add(pos, [s[0], 0, s[2]]), facingDeg: 0, source: 'dressing', surfaceY: s[1],
          capabilities: ['prop', 'interaction'], postures: [], occupancy: 1, hazard: prior?.hazard ?? 'none',
        };
      }
      for (const d of used.doors) {
        const sd = STAGING_DOORS[id]?.[d];
        if (!entry?.doors.includes(d)) notes.push(`door ${d} is not a door of set ${id}`);
        if (sd) doors[d] = { id: d, threshold: add(sd.threshold, origin), facingDeg: sd.facingDeg, inside: add(sd.inside, origin), source: 'staging', note: sd.note };
        else {
          // no authored doorway: the nearest wall point to the set's first mark, facing into the room
          const b = manifest.bounds;
          doors[d] = { id: d, threshold: add([b.min[0] + 0.1, 0, 0], origin), facingDeg: 90, inside: add([b.min[0] + 1.0, 0, 0], origin), source: 'generated', note: 'no authored doorway: generated on the stage-left wall' };
        }
      }
    } else {
      const spec = plannedLayout(id, used);
      manifest = placeholderSet(spec);
      key = `${manifest.id}@${manifest.version}`;
      for (const [m, v] of Object.entries(spec.marks)) marks[m] = generatedMark(m, add(v.pos, origin), v.facingDeg);
      for (const [d, v] of Object.entries(spec.doors)) {
        const a = (v.facingDeg * Math.PI) / 180;
        doors[d] = { id: d, threshold: add(v.pos, origin), facingDeg: v.facingDeg, inside: add([v.pos[0] + Math.sin(a) * 0.9, 0, v.pos[2] + Math.cos(a) * 0.9], origin), source: 'generated' };
      }
      notes.push(`placeholder set: ${used.marks.length} marks and ${used.doors.length} doors allocated from the beats (${res.note ?? 'planned'})`);
    }
    // walk bounds + static obstacles (colliders overlapping body height; floor excluded)
    const b = manifest.bounds;
    const walk: Box2 = { id: 'walk', x0: b.min[0] + origin[0], x1: b.max[0] + origin[0], z0: b.min[2] + origin[2], z1: b.max[2] + origin[2] };
    const obstacles: Box2[] = [];
    for (const p of manifest.pieces) {
      if (!p.collide || p.id === 'floor') continue;
      const shape = p.shape ?? 'box';
      const hx = shape === 'cylinder' || shape === 'sphere' ? p.size[0] : p.size[0] / 2, hz = shape === 'cylinder' || shape === 'sphere' ? p.size[0] : p.size[2] / 2;
      const hy = shape === 'sphere' ? p.size[0] : p.size[1] / 2;
      if (p.pos[1] - hy > 1.8 || p.pos[1] + hy < 0.05) continue;
      obstacles.push({ id: `env:${p.id}`, x0: p.pos[0] - hx + origin[0], x1: p.pos[0] + hx + origin[0], z0: p.pos[2] - hz + origin[2], z1: p.pos[2] + hz + origin[2] });
    }
    for (const d of dressing) {
      const m = lib.props[d.propRef], c = m.collision;
      obstacles.push({ id: `prop:${d.instance}`, x0: d.pos[0] + c.offset[0] - c.size[0] / 2, x1: d.pos[0] + c.offset[0] + c.size[0] / 2, z0: d.pos[2] + c.offset[2] - c.size[2] / 2, z1: d.pos[2] + c.offset[2] + c.size[2] / 2 });
    }
    for (const m of used.marks) if (!marks[m]) notes.push(`mark ${m} is used by a beat but not defined in set ${id}`);
    return { id, index, status: entry?.status ?? 'unknown', resolution: res.resolution === 'available' ? 'available' : 'placeholder', key, manifest, origin, marks, doors, dressing, lighting: used.lighting, walk, obstacles, notes };
  });
}
