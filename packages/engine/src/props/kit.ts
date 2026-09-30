// Block-style prop authoring kit (S4). Manifests in assets/props/*.json are GENERATED from the catalog written with
// these helpers (scripts/props.ts write) and then hash-locked; the JSON is what renders. Pure data, no DOM, no node.
//
// Conventions every prop follows (see ./README.md):
// - units are meters; +y up, the prop's front faces +z (toward the audience / a character at yaw 0 faces +z);
// - the prop origin is its floor contact point (bottom centre), so `anchors.floor` is always [0, 0, 0];
// - believable scale is judged against Zapp (1.93 m to the top of the head, hip 0.80 m, knee 0.40 m, shoulder ~1.32 m,
//   hand ~0.13 m wide), not against real-world humans: furniture follows his joint heights (see SCALE_REF in ./check.ts).
import type { PropManifest } from '../../../schema/src/assets.ts';

export type V3 = [number, number, number];
type Part = PropManifest['parts'][number];
type Transform = PropManifest['allowedTransformations'][number];
type Forbidden = PropManifest['forbiddenTransformations'][number];

/** Part options. `attach` names a rig pivot (./rigs.ts) the part rides on; default 'root' (static). */
export interface PartOpts { attach?: string; rot?: V3; bevel?: number; emissive?: string; sheen?: number }

const r4 = (x: number): number => Math.round(x * 1e4) / 1e4 + 0; // + 0 turns -0 into 0
const r3v = (v: number[]): V3 => [r4(v[0]), r4(v[1]), r4(v[2])];

function part(id: string, shape: Part['shape'], size: number[], pos: V3, color: string, o: PartOpts = {}): Part {
  const p: Part = { id, attach: o.attach ?? 'root', shape, size: size.map(r4), pos: r3v(pos), color };
  if (o.rot) p.rotDeg = r3v(o.rot);
  if (o.bevel !== undefined) p.bevel = r4(o.bevel);
  if (o.emissive) p.emissive = o.emissive;
  if (o.sheen !== undefined) p.sheen = r4(o.sheen);
  return p;
}

/** Part constructors. Box/sphere are centred on `pos`; cylinders are centred with their axis on +y (size [radius, height]);
 *  wedges have their base at `pos.y` (engine geometry); planes face +z (rotate [-90,0,0] to face up). */
export const box = (id: string, size: V3, pos: V3, color: string, o?: PartOpts): Part => part(id, 'box', size, pos, color, o);
export const cyl = (id: string, radius: number, height: number, pos: V3, color: string, o?: PartOpts): Part => part(id, 'cylinder', [radius, height], pos, color, o);
export const sph = (id: string, radius: number, pos: V3, color: string, o?: PartOpts): Part => part(id, 'sphere', [radius], pos, color, o);
export const wedge = (id: string, size: V3, pos: V3, color: string, o?: PartOpts): Part => part(id, 'wedge', size, pos, color, o);
export const plane = (id: string, w: number, h: number, pos: V3, color: string, o?: PartOpts): Part => part(id, 'plane', [w, h], pos, color, o);
/** plane lying flat, facing up (+y) */
export const decalUp = (id: string, w: number, d: number, pos: V3, color: string, o: PartOpts = {}): Part => plane(id, w, d, pos, color, { ...o, rot: [-90, 0, 0] });

/** Anchor contract: every prop carries these three names. */
export const REQUIRED_GRIP = 'grip';
export const REQUIRED_ANCHORS = ['surface', 'floor'] as const;

const BASE_FORBIDDEN: Forbidden[] = ['non_uniform_scale', 'recolor', 'morph', 'duplicate_uncontrolled', 'text_change'];

export interface PropDef {
  id: string;
  version?: string;
  displayName: string;
  /** furniture | appliance | architecture | vehicle | handheld | food | tool | device | decor | collectible */
  category: string;
  /** full bounding size of the default state [w, h, d] */
  dims: V3;
  /** default: box of `dims`, bottom on the floor, centred on `center` (x/z) */
  collision?: PropManifest['collision'];
  /** bounding box centre offset in x/z when the prop is not symmetric about its origin */
  center?: [number, number];
  parts: Part[];
  /** hand grips; must include `grip` */
  grips: Record<string, V3>;
  /** placement / animation anchors; must include `surface` (floor is added as [0,0,0]) */
  anchors: Record<string, V3>;
  effectAnchors?: Record<string, V3>;
  material: PropManifest['defaultMaterial'];
  color: string;
  allowed?: Transform[];
  /** extra forbidden transformations; uniform_scale is forbidden automatically unless allowed */
  forbid?: Forbidden[];
  /** drop these from the default forbidden list (e.g. sign_board allows text_change) */
  permit?: Forbidden[];
  maxScale?: number;
  notes?: string;
}

export function manifest(d: PropDef): PropManifest {
  const allowed: Transform[] = ['translate', 'rotate', ...(d.allowed ?? [])];
  const forbidden = new Set<Forbidden>([...BASE_FORBIDDEN, ...(d.forbid ?? [])]);
  if (!allowed.includes('uniform_scale')) forbidden.add('uniform_scale');
  for (const p of d.permit ?? []) forbidden.delete(p);
  const [cx, cz] = d.center ?? [0, 0];
  const m: PropManifest = {
    kind: 'prop', id: d.id, version: d.version ?? '1.0.0', displayName: d.displayName, category: d.category,
    dimensions: r3v(d.dims),
    collision: d.collision ?? { shape: 'box', size: r3v(d.dims), offset: r3v([cx, d.dims[1] / 2, cz]) },
    parts: d.parts,
    grips: Object.fromEntries(Object.entries(d.grips).map(([k, v]) => [k, r3v(v)])),
    anchors: Object.fromEntries(Object.entries({ floor: [0, 0, 0] as V3, ...d.anchors }).map(([k, v]) => [k, r3v(v)])),
    effectAnchors: Object.fromEntries(Object.entries(d.effectAnchors ?? {}).map(([k, v]) => [k, r3v(v)])),
    defaultMaterial: d.material, defaultColor: d.color,
    allowedTransformations: [...new Set(allowed)],
    forbiddenTransformations: [...forbidden],
    maxScale: d.maxScale ?? (allowed.includes('uniform_scale') ? 10 : 1),
    thumbnail: `assets/thumbnails/${d.id}.png`,
    status: 'ready',
    license: { source: 'original-procedural', author: 'RBLX SPARK (in-house)', license: 'Proprietary - owned', attributionRequired: false, ...(d.notes ? { notes: d.notes } : {}) },
  };
  return m;
}

// shared palette (sRGB hex) so the library reads as one family
export const C = {
  white: '#f4f4f2', offWhite: '#eef1f4', paper: '#f4efe2', ink: '#1c1c20', dark: '#2b2f36', charcoal: '#16181d', screenOff: '#0d0f14',
  metal: '#c3c9d0', steel: '#9aa3ad', grey: '#6b7785', greyDark: '#58626e', rubber: '#1f2126',
  wood: '#c98f55', woodDark: '#a8733f', walnut: '#8a5a3c', walnutDark: '#6b4a2e',
  red: '#e8322b', redDark: '#c8312b', orange: '#ff7a1a', yellow: '#ffd21a', gold: '#ffc21a', green: '#39b56a', cash: '#5fae4c', cashDark: '#3f8a36',
  blue: '#3f7fd9', blueDark: '#1f4fd1', blueLight: '#6aa0ea', navy: '#1d2b52', glass: '#9fd3f2', couch: '#5b6fb5', couchLight: '#6f84cc',
} as const;
