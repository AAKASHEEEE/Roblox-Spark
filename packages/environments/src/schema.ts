// Environment profile schema (strict). A profile is METADATA over an already-locked environment asset: it never
// carries geometry, never drives a camera solver and never renders. Unknown keys and prototype keys are rejected.
import { v, type Issue, type Result, type SchemaT, type Schema } from '../../schema/src/v.ts';
import { License } from '../../schema/src/assets.ts';
import { ACTIONS, CAMERA_PRESETS } from '../../schema/src/episode.ts';

export const PROFILE_SCHEMA_VERSION = 'environment-profile/1' as const;

/** shot intents a camera zone may permit (the episode schema's camera presets; no new camera behaviour) */
export const SHOT_INTENTS = CAMERA_PRESETS;
export type ShotIntent = (typeof SHOT_INTENTS)[number];
export const POSTURES = ['stand', 'sit', 'crouch', 'prone', 'hover'] as const;
export const MARK_KINDS = ['actor', 'waypoint', 'prop', 'offscreen_cue'] as const;
export const HAZARD_KINDS = ['none', 'impact_zone', 'falling_object', 'trip', 'pinch'] as const;
export const STORY_PATTERNS = [
  'escalation_backfire', 'ordinary_object_extreme', 'visible_secret_chase', 'apparent_win_instant_loss', 'noob_vs_smart',
  'comparison', 'hypothetical', 'escalating_consequence', 'narrated_comedy',
] as const;
export type StoryPattern = (typeof STORY_PATTERNS)[number];

const Vec3 = v.vec3();
const Box3 = v.object({ min: Vec3, max: Vec3 });
const Hazard = v.object({ kind: v.enum(HAZARD_KINDS), radius: v.number({ min: 0, max: 20 }), note: v.string({ max: 200 }).optional() });

export const MarkSchema = v.object({
  id: v.id(),
  kind: v.enum(MARK_KINDS),
  position: Vec3,
  facingDeg: v.number({ min: -360, max: 360 }),
  postures: v.array(v.enum(POSTURES), { max: POSTURES.length }),
  /** simultaneous actors (actor/waypoint) or props (prop marks); off-screen cues must be 0 */
  occupancy: v.int({ min: 0, max: 8 }),
  /** marks an actor may move to directly from here */
  reachable: v.array(v.id(), { max: 64 }),
  pathId: v.id().nullable(),
  /** same physical spot as another mark (role alias); aliases share the canonical mark's occupancy */
  aliasOf: v.id().nullable(),
  /** marks that may not be occupied at the same time as this one (too close for two bodies) */
  exclusiveWith: v.array(v.id(), { max: 32 }),
  camera: v.object({ onScreen: v.boolean(), visibleIntents: v.array(v.enum(SHOT_INTENTS), { max: SHOT_INTENTS.length }) }),
  hazard: Hazard,
  /** off-screen cues: the direction a character looks/points/exits toward; never instantiated */
  cueDirection: Vec3.nullable(),
  instantiateGeometry: v.boolean(),
  /** provenance of the coordinates (manifest mark / anchor they were taken from) */
  sourceRef: v.string({ max: 120 }),
});
export type Mark = SchemaT<typeof MarkSchema>;

export const PropAnchorSchema = v.object({
  id: v.id(),
  role: v.enum(['prop', 'look_target', 'effect'] as const),
  categories: v.array(v.string({ min: 1, max: 40, pattern: /^[a-z][a-z0-9_]*$/ }), { max: 16 }),
  position: Vec3,
  rotationDeg: Vec3,
  maxSize: Vec3,
  parentSurface: v.object({
    kind: v.enum(['floor', 'wall', 'prop_anchor', 'none'] as const),
    /** prop_anchor: id of the parent anchor; position is then in the parent prop's space */
    ref: v.id().nullable(),
    /** prop_anchor: named anchor on the parent prop manifest (e.g. student_desk.button_spot) */
    propAnchor: v.id().nullable(),
  }),
  reachZones: v.array(v.object({ markId: v.id(), radius: v.number({ min: 0, max: 10 }) }), { max: 16 }),
  clearance: v.object({ radius: v.number({ min: 0, max: 10 }), height: v.number({ min: 0, max: 10 }) }),
  scaling: v.object({ allowed: v.boolean(), maxScale: v.number({ min: 0.01, max: 100 }) }),
  hazard: Hazard,
  sourceRef: v.string({ max: 120 }),
});
export type PropAnchor = SchemaT<typeof PropAnchorSchema>;

const SafeVolume = v.object({
  id: v.id(), min: Vec3, max: Vec3,
  allowedIntents: v.array(v.enum(SHOT_INTENTS), { min: 1, max: SHOT_INTENTS.length }),
  elevatedAllowed: v.boolean(), topDownAllowed: v.boolean(),
  maxCastFraming: v.int({ min: 1, max: 8 }),
});
export const CameraZonesSchema = v.object({
  safeVolumes: v.array(SafeVolume, { min: 1, max: 32 }),
  exclusionVolumes: v.array(v.object({ id: v.id(), min: Vec3, max: Vec3, reason: v.string({ min: 1, max: 200 }) }), { max: 64 }),
  ceilingY: v.number({ min: 0.5, max: 100 }),
  minWallClearance: v.number({ min: 0, max: 5 }),
  /** room sides with no wall (fourth wall) — wall clearance is not applied there */
  openSides: v.array(v.enum(['+x', '-x', '+z', '-z'] as const), { max: 4 }),
  axis: v.object({ stageLineA: Vec3, stageLineB: Vec3, audienceSide: v.enum(['+z', '-z'] as const), screenRight: v.enum(['+x', '-x'] as const), audienceSideOnly: v.boolean() }),
  lensCorridors: v.array(v.object({ id: v.id(), from: Vec3, to: Vec3, radius: v.number({ min: 0.01, max: 10 }), intents: v.array(v.enum(SHOT_INTENTS), { min: 1 }) }), { max: 32 }),
});
export type CameraZones = SchemaT<typeof CameraZonesSchema>;

const LightingParams = v.object({
  sunDir: Vec3, sunColor: v.hexColor(), sunIntensity: v.number({ min: 0, max: 10 }),
  sky: v.hexColor(), ground: v.hexColor(), ambientIntensity: v.number({ min: 0, max: 5 }),
  fog: v.hexColor(), fogNear: v.number(), fogFar: v.number(), exposure: v.number({ min: 0.1, max: 4 }),
});
const Normalized = () => v.number({ min: 0, max: 1 });

export const EnvironmentProfileSchema = v.object({
  schemaVersion: v.literal(PROFILE_SCHEMA_VERSION),
  id: v.id(),
  version: v.semver(),
  displayName: v.string({ min: 1, max: 60 }),
  status: v.enum(['locked', 'draft'] as const),
  asset: v.object({
    /** asset-lock key, e.g. environments/classroom@1.0.0 */
    key: v.string({ pattern: /^environments\/[a-z][a-z0-9_]*@\d+\.\d+\.\d+$/ }),
    sha256: v.string({ pattern: /^[0-9a-f]{64}$/ }),
    source: v.literal('assets/asset-lock.json'),
  }),
  geometryVersion: v.semver(),
  coordinateSystem: v.object({ units: v.literal('meters'), up: v.literal('+y'), stageRight: v.literal('+x'), towardAudience: v.literal('+z'), handedness: v.literal('right') }),
  scale: v.object({ metersPerUnit: v.number({ min: 0.001, max: 1000 }), actorReferenceHeight: v.number({ min: 0.1, max: 10 }) }),
  bounds: Box3,
  lighting: v.object({ presetId: v.id(), params: LightingParams }),
  marks: v.array(MarkSchema, { min: 1, max: 128 }),
  anchors: v.array(PropAnchorSchema, { max: 128 }),
  cameraZones: CameraZonesSchema,
  collision: v.object({
    source: v.literal('environment_manifest_pieces'),
    assetKey: v.string({ max: 80 }),
    assetSha256: v.string({ pattern: /^[0-9a-f]{64}$/ }),
    filter: v.literal('collide=true'),
    colliderIds: v.array(v.id(), { min: 1, max: 400 }),
  }),
  captionSafe: v.object({
    actionSafe: v.object({ left: Normalized(), right: Normalized(), top: Normalized(), bottom: Normalized() }),
    captionBand: v.object({ top: Normalized(), bottom: Normalized() }),
    avoidBusyBackgroundBehindCaptions: v.boolean(),
  }),
  cast: v.object({ min: v.int({ min: 1, max: 8 }), max: v.int({ min: 1, max: 8 }) }),
  storyPatterns: v.array(v.enum(STORY_PATTERNS), { min: 1 }),
  supportedActions: v.array(v.enum(ACTIONS), { min: 1 }),
  license: License,
  provenance: v.object({
    origin: v.enum(['in_house_procedural', 'in_house_authored', 'commissioned', 'licensed'] as const),
    derivedFrom: v.array(v.string({ max: 80 }), { min: 1 }),
    author: v.string({ min: 1, max: 120 }),
    notes: v.string({ max: 400 }).optional(),
  }),
});
export type EnvironmentProfile = SchemaT<typeof EnvironmentProfileSchema>;

/** Exact pin carried by an episode manifest. No ranges, tags or "latest". */
export const EnvironmentRefSchema = v.object({
  environmentId: v.id(),
  version: v.semver(),
  contentHash: v.string({ pattern: /^[0-9a-f]{64}$/ }),
});
export type EnvironmentRef = SchemaT<typeof EnvironmentRefSchema>;

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
/** reject prototype-pollution keys anywhere in the tree (defence in depth on top of the strict object schema) */
export function prototypeKeyIssues(x: unknown, path = '$', out: Issue[] = []): Issue[] {
  if (x && typeof x === 'object') {
    for (const k of Object.keys(x)) {
      if (FORBIDDEN_KEYS.has(k)) out.push({ path: `${path}.${k}`, message: 'forbidden prototype key' });
      prototypeKeyIssues((x as Record<string, unknown>)[k], Array.isArray(x) ? `${path}[${k}]` : `${path}.${k}`, out);
    }
  }
  return out;
}
function strictParse<T>(schema: Schema<T>, x: unknown): Result<T> {
  const proto = prototypeKeyIssues(x);
  const r = schema.parse(x);
  if (!proto.length) return r;
  return { ok: false, issues: [...proto, ...(r.ok ? [] : r.issues)] };
}
export const parseProfile = (x: unknown): Result<EnvironmentProfile> => strictParse(EnvironmentProfileSchema, x);
export const parseEnvironmentRef = (x: unknown): Result<EnvironmentRef> => strictParse(EnvironmentRefSchema, x);
