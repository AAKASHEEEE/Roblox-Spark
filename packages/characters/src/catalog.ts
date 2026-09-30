// Registry of modular character components (METADATA ONLY). Each entry describes an original procedural component
// the engine already knows how to build from primitives on rig blocky_biped_v1; nothing here is a mesh, and nothing
// outside this registry can ever be resolved into a recipe.
import { ACTIONS, EXPRESSIONS } from '../../schema/src/episode.ts';
import { MOTION_PROFILE_IDS } from '../../schema/src/render-compat.ts';
import { contentHashOf, deepFreeze } from './hash.ts';

export const COMPONENT_CATEGORIES = ['body', 'head', 'hair', 'clothing', 'shoes', 'accessory', 'face_set', 'motion'] as const;
export type ComponentCategory = (typeof COMPONENT_CATEGORIES)[number];
export type Vec3 = [number, number, number];

export interface ComponentDef {
  id: string;
  version: string;
  category: ComponentCategory;
  rigs: string[];
  source: 'original-procedural';
  /** palette slots with their default colors; profiles may only override declared slots */
  palette: Record<string, string>;
  /** occupied volume zones; two components occupying one zone intersect */
  zones?: string[];
  /** extra bounding-box extent this component adds on top of the body [x, y, z] meters at 1.0 scale */
  boundsGrowth?: Vec3;
  // body
  anchors?: string[];
  heightRangeM?: [number, number];
  baseBounds?: Vec3;
  baseHeightM?: number;
  maxAccessories?: number;
  // head
  faceTarget?: Vec3;
  faceSets?: string[];
  // clothing / accessory
  slot?: 'top' | 'outer' | 'bottom';
  allowedAnchors?: string[];
  // face set
  expressions?: string[];
  // motion
  actions?: string[];
  requiredAnchors?: string[];
  engineMotionProfile?: string;
}
export interface RegisteredComponent extends ComponentDef { ref: string; hash: string }

const RIG = ['blocky_biped_v1'];
const BODY_ANCHORS = ['head', 'head_top', 'face', 'neck', 'torso', 'back', 'waist', 'wrist_l', 'wrist_r', 'hand_l', 'hand_r', 'foot_l', 'foot_r'];
const ALL_ACTIONS = ACTIONS.filter((a) => a !== 'hover');
const c = (d: ComponentDef): ComponentDef => d;

export const BUILTIN_COMPONENTS: ComponentDef[] = [
  c({ id: 'block-teen-slim', version: '1.0.0', category: 'body', rigs: RIG, source: 'original-procedural', palette: { torso: '#1f4fd1', legs: '#3b3d42' }, anchors: BODY_ANCHORS, heightRangeM: [1.35, 1.75], baseHeightM: 1.55, baseBounds: [0.62, 1.55, 0.34], maxAccessories: 3 }),
  c({ id: 'block-teen-standard', version: '1.0.0', category: 'body', rigs: RIG, source: 'original-procedural', palette: { torso: '#2a6d3a', legs: '#2b2d33' }, anchors: BODY_ANCHORS, heightRangeM: [1.4, 1.85], baseHeightM: 1.62, baseBounds: [0.7, 1.62, 0.38], maxAccessories: 3 }),
  c({ id: 'block-kid-small', version: '1.0.0', category: 'body', rigs: RIG, source: 'original-procedural', palette: { torso: '#e0493b', legs: '#34363c' }, anchors: BODY_ANCHORS, heightRangeM: [0.95, 1.3], baseHeightM: 1.12, baseBounds: [0.5, 1.12, 0.3], maxAccessories: 2 }),

  c({ id: 'head-square-bevel', version: '1.0.0', category: 'head', rigs: RIG, source: 'original-procedural', palette: { skin: '#f2c53d' }, zones: ['head_core'], faceTarget: [0, 0.26, 0.26], faceSets: ['face-bright-classic', 'face-cool-classic'] }),
  c({ id: 'head-square-soft', version: '1.0.0', category: 'head', rigs: RIG, source: 'original-procedural', palette: { skin: '#c98a5a' }, zones: ['head_core'], faceTarget: [0, 0.25, 0.25], faceSets: ['face-cool-classic'] }),

  c({ id: 'hair-spiky-front', version: '1.0.0', category: 'hair', rigs: RIG, source: 'original-procedural', palette: { primary: '#ff6a1a', streak: '#19d3e6' }, zones: ['head_top', 'head_back'], boundsGrowth: [0.02, 0.14, 0.02] }),
  c({ id: 'hair-bob-side', version: '1.0.0', category: 'hair', rigs: RIG, source: 'original-procedural', palette: { primary: '#6b3fa0' }, zones: ['head_top', 'head_back', 'head_sides'], boundsGrowth: [0.04, 0.06, 0.04] }),
  c({ id: 'hair-buzz', version: '1.0.0', category: 'hair', rigs: RIG, source: 'original-procedural', palette: { primary: '#2a1d14' }, zones: [], boundsGrowth: [0, 0.01, 0] }),

  c({ id: 'top-zip-hoodie', version: '1.0.0', category: 'clothing', rigs: RIG, source: 'original-procedural', slot: 'outer', palette: { primary: '#1f4fd1', trim: '#1942b4', patch: '#19d3e6' }, zones: ['torso_outer', 'neck'], boundsGrowth: [0.03, 0, 0.03] }),
  c({ id: 'top-bomber-jacket', version: '1.0.0', category: 'clothing', rigs: RIG, source: 'original-procedural', slot: 'outer', palette: { primary: '#2f7d4f', trim: '#1c3f2b' }, zones: ['torso_outer', 'neck'], boundsGrowth: [0.04, 0, 0.04] }),
  c({ id: 'top-tshirt', version: '1.0.0', category: 'clothing', rigs: RIG, source: 'original-procedural', slot: 'top', palette: { primary: '#f7f7f5' }, zones: ['torso_base'] }),
  c({ id: 'bottom-cargo', version: '1.0.0', category: 'clothing', rigs: RIG, source: 'original-procedural', slot: 'bottom', palette: { primary: '#3b3d42', pocket: '#33353a' }, zones: ['legs'], boundsGrowth: [0.02, 0, 0.01] }),
  c({ id: 'bottom-jeans', version: '1.0.0', category: 'clothing', rigs: RIG, source: 'original-procedural', slot: 'bottom', palette: { primary: '#2d4a7a' }, zones: ['legs'] }),

  c({ id: 'shoes-sneaker', version: '1.0.0', category: 'shoes', rigs: RIG, source: 'original-procedural', palette: { upper: '#f4f4f2', sole: '#ffe01a' }, zones: ['feet'] }),
  c({ id: 'shoes-hightop', version: '1.0.0', category: 'shoes', rigs: RIG, source: 'original-procedural', palette: { upper: '#d8342c', sole: '#f4f4f2' }, zones: ['feet', 'ankles'] }),

  c({ id: 'acc-wristband', version: '1.0.0', category: 'accessory', rigs: RIG, source: 'original-procedural', palette: { primary: '#19d3e6' }, allowedAnchors: ['wrist_l', 'wrist_r'], zones: [] }),
  c({ id: 'acc-cap', version: '1.0.0', category: 'accessory', rigs: RIG, source: 'original-procedural', palette: { crown: '#e0493b', brim: '#222222' }, allowedAnchors: ['head_top'], zones: ['head_top'], boundsGrowth: [0.06, 0.08, 0.12] }),
  c({ id: 'acc-glasses-square', version: '1.0.0', category: 'accessory', rigs: RIG, source: 'original-procedural', palette: { frame: '#111114' }, allowedAnchors: ['face'], zones: ['face_front'] }),
  c({ id: 'acc-backpack', version: '1.0.0', category: 'accessory', rigs: RIG, source: 'original-procedural', palette: { primary: '#f28c28', strap: '#333333' }, allowedAnchors: ['back'], zones: ['back'], boundsGrowth: [0, 0, 0.18] }),
  c({ id: 'acc-scarf', version: '1.0.0', category: 'accessory', rigs: RIG, source: 'original-procedural', palette: { primary: '#c2185b' }, allowedAnchors: ['neck'], zones: ['neck'] }),

  c({ id: 'face-bright-classic', version: '1.0.0', category: 'face_set', rigs: RIG, source: 'original-procedural', palette: { eyes: '#111114', brows: '#1b1410', mouth: '#2a1410' }, expressions: ['neutral', 'curious', 'shock', 'determined', 'regret', 'happy'] }),
  c({ id: 'face-cool-classic', version: '1.0.0', category: 'face_set', rigs: RIG, source: 'original-procedural', palette: { eyes: '#15141a', brows: '#2b1a12', mouth: '#3a1a14' }, expressions: ['smug', 'skeptical', 'surprised', 'laughing', 'neutral'] }),

  c({ id: 'motion-energetic-teen', version: '1.0.0', category: 'motion', rigs: RIG, source: 'original-procedural', palette: {}, actions: ALL_ACTIONS, requiredAnchors: ['hand_l', 'hand_r', 'foot_l', 'foot_r', 'head'], engineMotionProfile: 'corrected-head-v2', heightRangeM: [1.2, 1.9] }),
  c({ id: 'motion-calm-teen', version: '1.0.0', category: 'motion', rigs: RIG, source: 'original-procedural', palette: {}, actions: ['idle', 'walk', 'point', 'look_at', 'arms_crossed', 'head_shake', 'laugh', 'turn_toward', 'enter_frame', 'exit_frame', 'hold', 'pick_up', 'put_down'], requiredAnchors: ['hand_l', 'hand_r', 'foot_l', 'foot_r', 'head'], engineMotionProfile: 'corrected-head-v2', heightRangeM: [1.2, 1.9] }),
  c({ id: 'motion-kid-bouncy', version: '1.0.0', category: 'motion', rigs: RIG, source: 'original-procedural', palette: {}, actions: ['idle', 'walk', 'run', 'jump', 'point', 'laugh', 'look_at', 'cower', 'victory_pose'], requiredAnchors: ['hand_l', 'hand_r', 'foot_l', 'foot_r', 'head'], engineMotionProfile: 'corrected-head-v2', heightRangeM: [0.9, 1.35] }),
];

/** environment scale descriptors (metadata mirror of assets/environments; asset files are not modified) */
export interface EnvironmentScale { ref: string; characterHeightRangeM: [number, number]; maxFootprintM: number }
export const BUILTIN_ENVIRONMENTS: EnvironmentScale[] = [
  { ref: 'classroom@1.0.0', characterHeightRangeM: [0.9, 2.0], maxFootprintM: 0.9 },
  { ref: 'classroom@1.1.0', characterHeightRangeM: [0.9, 2.0], maxFootprintM: 0.9 },
];

export interface Catalog {
  readonly components: ReadonlyMap<string, RegisteredComponent>;
  readonly environments: ReadonlyMap<string, EnvironmentScale>;
  /** hash of the whole registry (changes whenever any component changes) */
  readonly hash: string;
  get(ref: string): RegisteredComponent | undefined;
  byCategory(cat: ComponentCategory): RegisteredComponent[];
}

/** build an immutable catalog. Throws on internal inconsistency so a bad registry never ships. */
export function createCatalog(defs: ComponentDef[] = BUILTIN_COMPONENTS, envs: EnvironmentScale[] = BUILTIN_ENVIRONMENTS): Catalog {
  const map = new Map<string, RegisteredComponent>();
  for (const d of defs) {
    const ref = `${d.id}@${d.version}`;
    if (map.has(ref)) throw new Error(`catalog: duplicate component ${ref}`);
    if (d.category === 'face_set') for (const e of d.expressions ?? []) if (!(EXPRESSIONS as readonly string[]).includes(e)) throw new Error(`catalog: ${ref} expression "${e}" unknown to the engine`);
    if (d.category === 'motion') {
      for (const a of d.actions ?? []) if (!(ACTIONS as readonly string[]).includes(a)) throw new Error(`catalog: ${ref} action "${a}" unknown to the engine`);
      if (!(MOTION_PROFILE_IDS as readonly string[]).includes(d.engineMotionProfile ?? '')) throw new Error(`catalog: ${ref} engine motion profile unknown`);
    }
    map.set(ref, deepFreeze({ ...d, ref, hash: contentHashOf(d) }));
  }
  const envMap = new Map(envs.map((e) => [e.ref, deepFreeze({ ...e })]));
  const sorted = [...map.values()].sort((a, b) => (a.ref < b.ref ? -1 : 1));
  const hash = contentHashOf({ components: sorted.map((x) => [x.ref, x.hash]), environments: [...envMap.values()].sort((a, b) => (a.ref < b.ref ? -1 : 1)) });
  return Object.freeze({
    components: map, environments: envMap, hash,
    get: (ref: string) => map.get(ref),
    byCategory: (cat: ComponentCategory) => sorted.filter((x) => x.category === cat),
  });
}

/** registered alternatives for an unavailable component: same category, ranked by id-token overlap then id */
export function suggestAlternatives(catalog: Catalog, category: ComponentCategory, requested: string, filter: (c: RegisteredComponent) => boolean = () => true): string[] {
  const toks = new Set(requested.split('@')[0].split('-'));
  return catalog.byCategory(category).filter(filter)
    .map((x) => ({ ref: x.ref, score: x.id.split('-').filter((t) => toks.has(t)).length }))
    .sort((a, b) => b.score - a.score || (a.ref < b.ref ? -1 : 1))
    .slice(0, 3).map((x) => x.ref);
}
