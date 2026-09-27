// Asset manifest schemas: characters, props, environments, audio. Every asset carries license metadata.
import { v, type SchemaT } from './v.ts';
import { EXPRESSIONS, ACTIONS } from './episode.ts';

export const License = v.object({
  source: v.enum(['original-procedural', 'original-authored', 'commissioned', 'licensed-commercial', 'cc0'] as const),
  author: v.string({ min: 1, max: 120 }),
  license: v.string({ min: 1, max: 120 }),
  url: v.string({ max: 300 }).optional(),
  attributionRequired: v.boolean(),
  notes: v.string({ max: 400 }).optional(),
});

const shape = v.enum(['box', 'wedge', 'cylinder', 'sphere', 'plane'] as const);
const Part = v.object({
  id: v.id(), attach: v.id(), shape,
  size: v.array(v.number({ min: 0, max: 50 }), { min: 1, max: 3 }),
  pos: v.vec3(), rotDeg: v.vec3().optional(), color: v.hexColor(), bevel: v.number({ min: 0, max: 1 }).optional(),
  emissive: v.hexColor().optional(), texture: v.id().optional(), sheen: v.number({ min: 0, max: 1 }).optional(),
});
export type PartT = SchemaT<typeof Part>;

const FaceState = v.object({
  eyes: v.enum(['oval', 'circle_wide', 'squeeze', 'half_lid', 'narrow', 'side_glance'] as const),
  browL: v.tuple<[number, number]>(v.number({ min: -1, max: 1 }), v.number({ min: -60, max: 60 })), // [raise, angleDeg]
  browR: v.tuple<[number, number]>(v.number({ min: -1, max: 1 }), v.number({ min: -60, max: 60 })),
  mouth: v.enum(['half_smile', 'flat', 'o', 'smug', 'grin', 'open_grin', 'frown', 'tight', 'wobbly'] as const),
});

export const CharacterManifestSchema = v.object({
  kind: v.literal('character'),
  id: v.id(), version: v.semver(), displayName: v.string({ max: 40 }), description: v.string({ max: 600 }),
  rig: v.enum(['blocky_biped_v1', 'floating_orb_v1'] as const),
  body: v.object({
    headSize: v.vec3(), headBevel: v.number({ min: 0, max: 0.2 }), skin: v.hexColor(),
    torso: v.vec3(), torsoColor: v.hexColor(),
    armWidth: v.number({ min: 0.05, max: 0.4 }), upperArm: v.number({ min: 0 }), lowerArm: v.number({ min: 0 }),
    sleeveColor: v.hexColor(), handColor: v.hexColor(),
    legWidth: v.number({ min: 0.05, max: 0.5 }), upperLeg: v.number({ min: 0 }), lowerLeg: v.number({ min: 0 }),
    legColor: v.hexColor(), shoeColor: v.hexColor(), soleColor: v.hexColor(),
  }),
  parts: v.array(Part, { max: 60 }),
  face: v.object({
    eyeColor: v.hexColor(), browColor: v.hexColor(), mouthColor: v.hexColor(),
    eyeSpacing: v.number({ min: 0, max: 1 }), eyeY: v.number({ min: 0, max: 1 }), eyeW: v.number({ min: 0, max: 1 }), eyeH: v.number({ min: 0, max: 1 }),
    browThickness: v.number({ min: 0, max: 0.3 }), browWidth: v.number({ min: 0, max: 0.6 }), mouthY: v.number({ min: 0, max: 1 }), mouthW: v.number({ min: 0, max: 1 }),
    hasNose: v.boolean(),
    states: v.record(FaceState),
  }),
  allowedExpressions: v.array(v.enum(EXPRESSIONS), { min: 1 }),
  allowedActions: v.array(v.enum(ACTIONS), { min: 1 }),
  locomotion: v.object({ walkSpeed: v.number({ min: 0.1, max: 5 }), runSpeed: v.number({ min: 0.1, max: 10 }) }),
  personality: v.string({ max: 300 }),
  identityRules: v.array(v.string({ max: 200 })),
  license: License,
});
export type CharacterManifest = SchemaT<typeof CharacterManifestSchema>;

export const PropManifestSchema = v.object({
  kind: v.literal('prop'),
  id: v.id(), version: v.semver(), displayName: v.string({ max: 40 }), category: v.string({ max: 40 }),
  dimensions: v.vec3(),
  collision: v.object({ shape: v.enum(['box', 'cylinder', 'sphere'] as const), size: v.vec3(), offset: v.vec3() }),
  parts: v.array(Part, { min: 1, max: 40 }),
  grips: v.record(v.vec3()), // grip/contact points in prop space
  anchors: v.record(v.vec3()), // animation anchors (e.g. press_surface)
  effectAnchors: v.record(v.vec3()),
  defaultMaterial: v.enum(['matte_plastic', 'glossy_plastic', 'metal_gold', 'paper', 'wood', 'glass', 'fabric', 'electronics'] as const),
  defaultColor: v.hexColor(),
  allowedTransformations: v.array(v.enum(['translate', 'rotate', 'uniform_scale', 'press_depress', 'glow', 'open', 'spin'] as const)),
  forbiddenTransformations: v.array(v.enum(['non_uniform_scale', 'recolor', 'morph', 'duplicate_uncontrolled', 'uniform_scale', 'text_change'] as const)),
  maxScale: v.number({ min: 0.01, max: 100 }),
  thumbnail: v.string({ max: 200 }),
  status: v.enum(['ready', 'draft'] as const),
  license: License,
});
export type PropManifest = SchemaT<typeof PropManifestSchema>;

const Box = v.object({ id: v.id(), size: v.vec3(), pos: v.vec3(), rotDeg: v.vec3().optional(), color: v.hexColor(), bevel: v.number({ min: 0, max: 1 }).optional(), texture: v.id().optional(), collide: v.boolean(), decor: v.boolean().optional(), shape: v.enum(['box', 'cylinder', 'plane', 'sphere'] as const).optional(), emissive: v.hexColor().optional() });
export const EnvironmentManifestSchema = v.object({
  kind: v.literal('environment'),
  id: v.id(), version: v.semver(), displayName: v.string({ max: 40 }),
  units: v.literal('meters'),
  axes: v.object({ up: v.literal('+y'), stageRight: v.literal('+x'), towardAudience: v.literal('+z') }),
  bounds: v.object({ min: v.vec3(), max: v.vec3() }),
  pieces: v.array(Box, { min: 1, max: 400 }),
  marks: v.record(v.object({ pos: v.vec3(), facingDeg: v.number({ min: -360, max: 360 }) })),
  anchors: v.record(v.vec3()),
  cameraSafe: v.object({ min: v.vec3(), max: v.vec3(), audienceSideOnly: v.boolean() }),
  composition: v.object({
    /** normalized 9:16 safe title/action area (platform UI overlays avoided) */
    actionSafe: v.object({ left: v.number(), right: v.number(), top: v.number(), bottom: v.number() }),
    stageLine: v.object({ a: v.vec3(), b: v.vec3() }),
  }),
  lighting: v.record(v.object({
    sunDir: v.vec3(), sunColor: v.hexColor(), sunIntensity: v.number({ min: 0, max: 10 }),
    sky: v.hexColor(), ground: v.hexColor(), ambientIntensity: v.number({ min: 0, max: 5 }),
    fog: v.hexColor(), fogNear: v.number(), fogFar: v.number(), exposure: v.number({ min: 0.1, max: 4 }),
  })),
  extras: v.object({ decorDensity: v.number({ min: 0, max: 1 }), backgroundCharacters: v.int({ min: 0, max: 0 }) }),
  license: License,
});
export type EnvironmentManifest = SchemaT<typeof EnvironmentManifestSchema>;

export const AudioManifestSchema = v.object({
  kind: v.literal('audio'),
  id: v.id(), version: v.semver(), category: v.enum(['sfx', 'music', 'ambience'] as const),
  synth: v.id(), // name of deterministic procedural synth patch in packages/audio
  params: v.record(v.number()),
  durationSec: v.number({ min: 0.01, max: 60 }),
  description: v.string({ max: 200 }),
  license: License,
});
export type AudioManifest = SchemaT<typeof AudioManifestSchema>;
