// Labelled grey placeholder blocks for library items that are not built yet (status 'planned', or no locked asset):
// sets, characters and props get real (grey) engine geometry so the pipeline runs end to end before S2-S5 land.
// Every placeholder is built through the engine build dispatch (packages/engine/src/build.ts) like a real asset and
// carries a readable label naming the missing item. Nothing here is registered as an asset or written to assets/.
import type { CharacterManifest, EnvironmentManifest, PropManifest } from '../../schema/src/assets.ts';
import type { Vec3 } from '../../engine/src/math.ts';

export const PLACEHOLDER_VERSION = '0.0.0';
const LICENSE = { source: 'original-procedural' as const, author: 'RBLX SPARK (in-house)', license: 'Proprietary - owned', attributionRequired: false, notes: 'S6 staging placeholder (grey block); replaced when the owner session ships the item.' };
const GREY = { light: '#b8b8b8', mid: '#9a9a9a', dark: '#6e6e6e', floor: '#8c8c8c', wall: '#a9a9a9' };

// ---------------------------------------------------------------- props

/** block sizes (m) for planned props; anything else is a 0.4 m cube */
const PROP_SIZE: Record<string, Vec3> = {
  door: [1.0, 2.1, 0.1], phone: [0.09, 0.17, 0.03], laptop: [0.36, 0.03, 0.25], book: [0.2, 0.05, 0.27], backpack: [0.34, 0.45, 0.2],
  chair: [0.45, 0.9, 0.45], table: [1.2, 0.75, 0.8], bed: [1.0, 0.5, 2.0], couch: [1.9, 0.85, 0.85], fridge: [0.75, 1.8, 0.7],
  stove: [0.75, 0.9, 0.65], tv: [1.1, 0.65, 0.08], car: [1.8, 1.4, 4.0], ball: [0.24, 0.24, 0.24], pizza: [0.35, 0.03, 0.35],
  drink_cup: [0.08, 0.14, 0.08], trophy: [0.18, 0.35, 0.18], cash_stack: [0.16, 0.08, 0.07], ban_hammer: [0.3, 0.9, 0.2],
  broom: [0.25, 1.3, 0.08], plate: [0.26, 0.02, 0.26], lamp: [0.3, 1.5, 0.3], trash_can: [0.4, 0.6, 0.4], sign_board: [1.0, 1.6, 0.08], gift_box: [0.35, 0.3, 0.35],
};
export const propBlockSize = (id: string): Vec3 => [...(PROP_SIZE[id] ?? [0.4, 0.4, 0.4])] as Vec3;

export function placeholderProp(id: string): PropManifest {
  const [w, h, d] = propBlockSize(id);
  return {
    kind: 'prop', id, version: PLACEHOLDER_VERSION, displayName: `${id} (placeholder)`.slice(0, 40), category: id === 'door' ? 'door' : 'placeholder',
    dimensions: [w, h, d], collision: { shape: 'box', size: [w, h, d], offset: [0, h / 2, 0] },
    parts: [{ id: 'block', attach: 'root', shape: 'box', size: [w, h, d], pos: [0, h / 2, 0], color: GREY.mid, bevel: Math.min(0.02, Math.min(w, h, d) / 6) }],
    grips: {}, anchors: { top: [0, h, 0], front: [0, h / 2, d / 2] }, effectAnchors: { center: [0, h / 2, 0] },
    defaultMaterial: 'matte_plastic', defaultColor: GREY.mid, allowedTransformations: ['translate', 'rotate'], forbiddenTransformations: ['non_uniform_scale', 'recolor', 'morph'],
    maxScale: 1, thumbnail: 'none', status: 'draft', license: LICENSE,
  };
}

// ---------------------------------------------------------------- characters

const ADULTS = new Set(['teacher', 'mom', 'dad']);
/** a face state for every expression name the beat sheets may use (engine enum + planned face set) */
const FACE: Record<string, { eyes: 'oval' | 'circle_wide' | 'squeeze' | 'half_lid' | 'narrow' | 'side_glance'; mouth: 'half_smile' | 'flat' | 'o' | 'smug' | 'grin' | 'open_grin' | 'frown' | 'tight' | 'wobbly'; brow: [number, number] }> = {
  neutral: { eyes: 'oval', mouth: 'flat', brow: [0, 0] }, calm: { eyes: 'half_lid', mouth: 'half_smile', brow: [0, 0] }, curious: { eyes: 'oval', mouth: 'o', brow: [0.4, 6] },
  shock: { eyes: 'circle_wide', mouth: 'o', brow: [0.8, 4] }, shocked: { eyes: 'circle_wide', mouth: 'o', brow: [0.9, 4] }, surprised: { eyes: 'circle_wide', mouth: 'o', brow: [0.7, 4] },
  determined: { eyes: 'narrow', mouth: 'tight', brow: [-0.3, -14] }, regret: { eyes: 'half_lid', mouth: 'wobbly', brow: [0.3, 16] }, smug: { eyes: 'half_lid', mouth: 'smug', brow: [0.2, 4] },
  skeptical: { eyes: 'narrow', mouth: 'flat', brow: [0.3, -6] }, laughing: { eyes: 'squeeze', mouth: 'open_grin', brow: [0.3, 8] }, laugh: { eyes: 'squeeze', mouth: 'open_grin', brow: [0.3, 8] },
  happy: { eyes: 'oval', mouth: 'grin', brow: [0.3, 6] }, big_grin: { eyes: 'squeeze', mouth: 'grin', brow: [0.4, 6] }, angry: { eyes: 'narrow', mouth: 'frown', brow: [-0.5, -22] },
  furious: { eyes: 'narrow', mouth: 'open_grin', brow: [-0.7, -30] }, strict: { eyes: 'narrow', mouth: 'tight', brow: [-0.2, -12] }, scream: { eyes: 'circle_wide', mouth: 'open_grin', brow: [0.9, 10] },
  scared: { eyes: 'circle_wide', mouth: 'wobbly', brow: [0.8, 18] }, sad: { eyes: 'half_lid', mouth: 'frown', brow: [0.4, 20] }, crying: { eyes: 'squeeze', mouth: 'wobbly', brow: [0.5, 24] },
  suspicious: { eyes: 'side_glance', mouth: 'flat', brow: [-0.2, -10] }, sleepy: { eyes: 'half_lid', mouth: 'flat', brow: [-0.1, 0] }, evil_grin: { eyes: 'narrow', mouth: 'smug', brow: [-0.4, -18] },
  confused: { eyes: 'oval', mouth: 'wobbly', brow: [0.5, 12] }, love_eyes: { eyes: 'squeeze', mouth: 'grin', brow: [0.5, 8] },
};
export const PLACEHOLDER_FACE_STATES = Object.keys(FACE);

export function placeholderCharacter(id: string): CharacterManifest {
  const adult = ADULTS.has(id);
  const k = adult ? 1.12 : 1;
  const states = Object.fromEntries(Object.entries(FACE).map(([n, f]) => [n, { eyes: f.eyes, browL: [f.brow[0], f.brow[1]] as [number, number], browR: [f.brow[0], -f.brow[1]] as [number, number], mouth: f.mouth }]));
  return {
    kind: 'character', id, version: PLACEHOLDER_VERSION, displayName: `${id} (placeholder)`.slice(0, 40), description: `Grey placeholder for the planned character "${id}" (S3 builds the real one).`,
    rig: 'blocky_biped_v1',
    body: {
      headSize: [0.5, 0.5, 0.48], headBevel: 0.06, skin: GREY.light, torso: [0.54 * k, 0.6 * k, 0.28], torsoColor: GREY.mid, armWidth: 0.15, upperArm: 0.31 * k, lowerArm: 0.29 * k,
      sleeveColor: GREY.mid, handColor: GREY.light, legWidth: 0.21, upperLeg: 0.39 * k, lowerLeg: 0.39 * k, legColor: GREY.dark, shoeColor: '#555555', soleColor: '#dddddd',
    },
    parts: [],
    face: { eyeColor: '#1a1a1a', browColor: '#2a2a2a', mouthColor: '#2a2a2a', eyeSpacing: 0.33, eyeY: 0.5, eyeW: 0.1, eyeH: 0.16, browThickness: 0.05, browWidth: 0.2, mouthY: 0.74, mouthW: 0.22, hasNose: false, states },
    allowedExpressions: ['neutral', 'curious', 'shock', 'determined', 'regret', 'smug', 'skeptical', 'surprised', 'laughing', 'happy', 'angry', 'calm', 'strict'],
    allowedActions: ['idle', 'walk', 'run', 'point', 'press_button', 'jump', 'fall', 'cower', 'look_at', 'curious_lean', 'shock_recoil', 'angry_stomp', 'victory_pose', 'laugh', 'facepalm', 'regret_freeze', 'chase', 'turn_toward', 'exit_frame', 'enter_frame', 'arms_crossed', 'head_shake', 'dive_prone'],
    locomotion: { walkSpeed: 1.25, runSpeed: 3.4 }, personality: 'placeholder', identityRules: ['Grey placeholder block; never shipped.'], license: LICENSE,
  } as CharacterManifest;
}

// ---------------------------------------------------------------- sets

export interface PlaceholderSetSpec {
  id: string;
  /** marks in set-local coordinates */
  marks: Record<string, { pos: Vec3; facingDeg: number }>;
  /** doors: threshold point on a wall + the direction an entering character faces */
  doors: Record<string, { pos: Vec3; facingDeg: number }>;
  lighting: string[];
  /** half extents of the floor (x, z) */
  half: [number, number];
}

const lightingPreset = (id: string) => {
  const night = /night|dark|evening/.test(id);
  return {
    sunDir: [-0.6, 0.8, 0.45] as Vec3, sunColor: night ? '#b9c6ff' : '#fff4e2', sunIntensity: night ? 0.9 : 1.9, sky: night ? '#6d7aa6' : '#d6dde6', ground: '#8f8f8f',
    ambientIntensity: night ? 0.45 : 0.62, fog: night ? '#39405a' : '#e3e6ea', fogNear: 18, fogFar: 45, exposure: 1.05,
  };
};

/** a grey box room (floor, back and side walls, door frames); the set name label is attached by the scene */
export function placeholderSet(spec: PlaceholderSetSpec): EnvironmentManifest {
  const [hx, hz] = spec.half, H = 3.6;
  const pieces: EnvironmentManifest['pieces'] = [
    { id: 'floor', size: [2 * hx, 0.1, 2 * hz + 10], pos: [0, -0.05, 5], color: GREY.floor, collide: true },
    { id: 'wall_back', size: [2 * hx, H, 0.2], pos: [0, H / 2, -hz - 0.1], color: GREY.wall, collide: true },
    { id: 'wall_left', size: [0.2, H, 2 * hz], pos: [-hx - 0.1, H / 2, 0], color: GREY.wall, collide: true },
    { id: 'wall_right', size: [0.2, H, 2 * hz], pos: [hx + 0.1, H / 2, 0], color: GREY.wall, collide: true },
    { id: 'skirting_back', size: [2 * hx, 0.18, 0.04], pos: [0, 0.09, -hz + 0.02], color: GREY.dark, collide: false },
  ];
  for (const [id, d] of Object.entries(spec.doors)) {
    // frame posts + lintel standing in the wall the threshold is on (facing = into the room)
    const a = (d.facingDeg * Math.PI) / 180, fx = Math.sin(a), fz = Math.cos(a), sx = fz, sz = -fx;
    for (const s of [-1, 1]) pieces.push({ id: `${id}_post_${s < 0 ? 'l' : 'r'}`, size: [Math.abs(sx) * 0.1 + Math.abs(fx) * 0.24, 2.2, Math.abs(sz) * 0.1 + Math.abs(fz) * 0.24], pos: [d.pos[0] + sx * 0.58 * s, 1.1, d.pos[2] + sz * 0.58 * s], color: GREY.dark, collide: true });
    pieces.push({ id: `${id}_lintel`, size: [Math.abs(sx) * 1.26 + Math.abs(fx) * 0.24, 0.12, Math.abs(sz) * 1.26 + Math.abs(fz) * 0.24], pos: [d.pos[0], 2.26, d.pos[2]], color: GREY.dark, collide: false });
  }
  return {
    kind: 'environment', id: spec.id, version: PLACEHOLDER_VERSION, displayName: `${spec.id} (placeholder)`.slice(0, 40), units: 'meters',
    axes: { up: '+y', stageRight: '+x', towardAudience: '+z' },
    bounds: { min: [-hx, 0, -hz], max: [hx, H, hz] }, pieces,
    marks: Object.fromEntries(Object.entries(spec.marks).map(([k, m]) => [k, { pos: [...m.pos] as Vec3, facingDeg: m.facingDeg }])),
    anchors: {},
    cameraSafe: { min: [-hx + 0.3, 0.15, -hz + 0.4], max: [hx - 0.3, H - 0.2, hz + 10], audienceSideOnly: true },
    composition: { actionSafe: { left: 0.06, right: 0.86, top: 0.1, bottom: 0.8 }, stageLine: { a: [-hx + 1, 0, 0.4], b: [hx - 1, 0, 0.4] } },
    lighting: Object.fromEntries((spec.lighting.length ? spec.lighting : ['day']).map((l) => [l, lightingPreset(l)])),
    extras: { decorDensity: 1, backgroundCharacters: 0 }, license: LICENSE,
  } as EnvironmentManifest;
}
