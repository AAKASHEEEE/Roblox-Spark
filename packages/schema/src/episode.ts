// Strict, versioned episode schema (v1.1). Episodes are DATA ONLY: no code, shaders or commands.
// 1.1 = 1.0 + a mandatory `render` block declaring the renderer version and motion profile (render-compat.ts).
import { v, type SchemaT } from './v.ts';
import { EPISODE_SCHEMA_VERSION, MOTION_PROFILE_IDS, RENDERER_VERSIONS } from './render-compat.ts';

export const SCHEMA_VERSION = EPISODE_SCHEMA_VERSION;

export const ACTIONS = [
  'idle', 'walk', 'run', 'point', 'press_button', 'pick_up', 'hold', 'put_down', 'drink', 'throw', 'jump', 'fall',
  'cower', 'look_at', 'curious_lean', 'shock_recoil', 'angry_stomp', 'victory_pose', 'laugh', 'facepalm',
  'regret_freeze', 'hover', 'chase', 'turn_toward', 'exit_frame', 'enter_frame', 'arms_crossed', 'head_shake', 'dive_prone',
] as const;
export type ActionName = (typeof ACTIONS)[number];

/** actions that move the actor's root to `to` */
export const LOCOMOTION_ACTIONS: readonly ActionName[] = ['walk', 'run', 'chase', 'exit_frame', 'enter_frame', 'dive_prone'];

export const EXPRESSIONS = [
  'neutral', 'curious', 'shock', 'determined', 'regret', // Zapp
  'smug', 'skeptical', 'surprised', 'laughing', // Kira
  'happy', 'angry', 'calm', 'strict', // shared / Max / Ms. Byte
] as const;

export const CAMERA_PRESETS = [
  'prop_ecu', 'frontal_medium', 'two_shot', 'over_shoulder', 'low_angle_reveal', 'top_down_insert',
  'wide_environment', 'reaction_punch_in', 'chase_cam', 'final_loop',
] as const;

export const PROP_EVENTS = ['spawn', 'show', 'hide', 'press', 'reset', 'flash', 'hop_to', 'grow', 'spin', 'stand_up', 'tip_over', 'slide', 'wobble'] as const;

export const VFX = ['sparkle_burst', 'dust_puff', 'impact_ring', 'confetti', 'emote', 'screen_flash', 'screen_shake', 'glow_pulse', 'shadow_looming', 'speed_lines'] as const;

export const BEAT_INTENTS = ['hook', 'setup', 'temptation', 'cause', 'effect', 'celebrate', 'escalate', 'climax', 'reversal', 'payoff', 'loop'] as const;

export const COMEDY_ENGINES = ['escalation_backfire', 'skeptic_reversal', 'too_good_to_be_true', 'rule_break_consequence'] as const;

/** reference to a mark, anchor, actor or prop; optional .sub (e.g. button.press_surface, zapp.face) */
const ref = () => v.string({ pattern: /^[a-z][a-z0-9_-]*(\.[a-z0-9_]+)?$/, max: 80 });

const numericParams = v.record(v.union<number | string | boolean>(v.number(), v.string({ max: 64 }), v.boolean()), /^[a-zA-Z][a-zA-Z0-9]*$/);

/** mode-specific limits: Visual Comedy keeps its channel limits; Narrated Story drafts follow the uploaded voice-over */
export interface EpisodeLimits { durationSec: [number, number]; timeMax: number; beats: number; shots: number; actions: number; engines: readonly string[] }
export const VISUAL_COMEDY_LIMITS: EpisodeLimits = { durationSec: [14, 22], timeMax: 60, beats: 30, shots: 40, actions: 200, engines: COMEDY_ENGINES };
export const NARRATED_DRAFT_LIMITS: EpisodeLimits = { durationSec: [35, 75], timeMax: 80, beats: 80, shots: 120, actions: 400, engines: [...COMEDY_ENGINES, 'narrated_story'] };
export function episodeSchema(L: EpisodeLimits) {
  const time = () => v.number({ min: 0, max: L.timeMax });
  return v.object({
  schemaVersion: v.literal(SCHEMA_VERSION),
  // explicit rendering compatibility declaration: required, never defaulted (see docs/RENDERING_COMPATIBILITY.md)
  render: v.object({
    rendererVersion: v.enum(RENDERER_VERSIONS),
    motionProfile: v.enum(MOTION_PROFILE_IDS),
    upgradedFrom: v.object({ rendererVersion: v.enum(RENDERER_VERSIONS), motionProfile: v.enum(MOTION_PROFILE_IDS), sourceSha256: v.string({ pattern: /^[0-9a-f]{64}$/ }) }).optional(),
  }),
  episode: v.object({
    id: v.id(),
    title: v.string({ min: 1, max: 80 }),
    logline: v.string({ min: 1, max: 280 }),
    duration: v.number({ min: L.durationSec[0], max: L.durationSec[1] }),
    format: v.literal('vertical'),
    resolution: v.tuple<[1080, 1920]>(v.literal(1080), v.literal(1920)),
    fps: v.union<30 | 60>(v.literal(30), v.literal(60)),
    seed: v.int({ min: 0, max: 2 ** 31 - 1 }),
    comedyEngine: v.enum(L.engines as typeof COMEDY_ENGINES),
  }),
  environment: v.object({ id: v.id(), version: v.semver(), lighting: v.id() }),
  cast: v.array(v.object({
    id: v.id(), version: v.semver(),
    role: v.enum(['protagonist', 'foil', 'support', 'extra'] as const),
    startMark: v.id(),
    startFacing: ref().optional(), // mark/anchor/actor id to face at t=0
    startExpression: v.enum(EXPRESSIONS),
  }), { min: 1, max: 5 }),
  props: v.array(v.object({
    instance: v.id(), id: v.id(), version: v.semver(), anchor: v.id(), parent: v.id().optional(), hero: v.boolean(),
    visible: v.boolean(), scale: v.number({ min: 0.01, max: 100 }),
  }), { min: 1, max: 12 }),
  beats: v.array(v.object({
    id: v.id(), start: time(), end: time(), intent: v.enum(BEAT_INTENTS), summary: v.string({ min: 1, max: 160 }),
    informationChange: v.boolean(),
  }), { min: 3, max: L.beats }),
  actions: v.array(v.object({
    actor: v.id(), action: v.enum(ACTIONS), start: time(), duration: v.number({ min: 0.1, max: 20 }),
    target: ref().optional(), to: ref().optional(), expression: v.enum(EXPRESSIONS).optional(),
    params: numericParams.optional(),
  }), { max: L.actions }),
  expressions: v.array(v.object({ actor: v.id(), state: v.enum(EXPRESSIONS), at: time() }), { max: L.actions }),
  propEvents: v.array(v.object({
    prop: v.id(), event: v.enum(PROP_EVENTS), start: time(), duration: v.number({ min: 0, max: 20 }),
    to: ref().optional(), params: numericParams.optional(),
  }), { max: 200 }),
  shots: v.array(v.object({
    id: v.id(), start: time(), end: time(), preset: v.enum(CAMERA_PRESETS), subjects: v.array(ref(), { min: 1, max: 4 }),
    purpose: v.string({ min: 1, max: 120 }),
    params: numericParams.optional(),
  }), { min: 6, max: L.shots }),
  vfx: v.array(v.object({ type: v.enum(VFX), at: time(), duration: v.number({ min: 0, max: 10 }), target: ref().optional(), params: numericParams.optional() }), { max: 200 }),
  audio: v.object({
    cues: v.array(v.object({ sfx: v.id(), at: time(), gainDb: v.number({ min: -40, max: 6 }), pitch: v.number({ min: 0.25, max: 4 }).optional(), sync: v.string({ max: 80 }).optional() }), { max: 300 }),
    music: v.object({ id: v.id(), gainDb: v.number({ min: -40, max: 0 }) }).optional(),
    ambience: v.object({ id: v.id(), gainDb: v.number({ min: -50, max: 0 }) }).optional(),
    loudnessLufs: v.number({ min: -24, max: -9 }),
    duckingDb: v.number({ min: 0, max: 20 }),
  }),
  loop: v.object({
    mode: v.enum(['match_cut', 'continuous'] as const),
    firstShot: v.id(), lastShot: v.id(),
    /** seconds at the end whose state must match t=0 */
    matchWindow: v.number({ min: 0, max: 3 }),
  }),
  export: v.object({
    container: v.literal('mp4'), videoCodec: v.literal('h264'), audioCodec: v.enum(['opus', 'aac'] as const),
    videoBitrateKbps: v.int({ min: 2000, max: 40000 }), audioBitrateKbps: v.int({ min: 64, max: 320 }),
  }),
  safety: v.object({
    familySafe: v.literal(true), usesThirdPartyBrands: v.literal(false),
    realMoneyOrGiveawayClaims: v.literal(false), notes: v.string({ max: 400 }),
  }),
});
}
export const EpisodeSchema = episodeSchema(VISUAL_COMEDY_LIMITS);
export const NarratedEpisodeSchema = episodeSchema(NARRATED_DRAFT_LIMITS);

export type Episode = SchemaT<typeof EpisodeSchema>;
export type EpisodeAction = Episode['actions'][number];
export type EpisodeShot = Episode['shots'][number];
export type EpisodePropEvent = Episode['propEvents'][number];
export type EpisodeVfx = Episode['vfx'][number];
