// Shared producer contracts for the vignette pipeline (S0-owned; other sessions report changes instead of editing).
// Each producer session implements one of these interfaces and registers it under an ID from ./ids.ts.
// Type-only file: no runtime code, no engine behaviour.
import type { ActionCtx, ActionDef as EngineActionDef } from '../../engine/src/animation/actions.ts';
import type { ActionPose } from '../../engine/src/animation/pose.ts';
import type { Rig, PropInstance, EnvInstance } from '../../engine/src/build.ts';
import type { PropState } from '../../engine/src/props.ts';
import type { Node, RGB } from '../../engine/src/gl/scene.ts';
import type { Lighting, Particle, PostFx } from '../../engine/src/gl/renderer.ts';
import type { CharacterManifest, PropManifest, EnvironmentManifest } from '../../schema/src/assets.ts';
import type { Vec3 } from '../../engine/src/math.ts';

export type { ActionCtx, ActionPose, Vec3 };

/** Shared identity every registered item carries. `id` must exist in LIBRARY (ids.ts) under the matching kind. */
export interface LibraryItem {
  id: string;
  /** semver of the implementation; asset-backed items match their manifest version */
  version: string;
}

// ---------------------------------------------------------------- sets (S2)

/** A named standing/placement spot in a set (beat-sheet placements reference these). */
export interface SetMark {
  id: string;
  position: Vec3;
  facingDeg: number;
  postures: Array<'stand' | 'sit' | 'crouch' | 'prone'>;
}
/** A doorway characters enter/exit through (`enter:<doorId>` / `exit:<doorId>` placements). */
export interface SetDoor {
  id: string;
  /** threshold point on the floor */
  position: Vec3;
  /** direction an entering character faces */
  facingDeg: number;
  /** door prop id (props kind) drawn in the frame; null = off-screen cue only */
  propId: string | null;
  /** mark an entering character walks to first */
  entryMarkId: string;
}
export interface BuiltSet {
  root: Node;
  colliders: EnvInstance['colliders'];
  marks: SetMark[];
  doors: SetDoor[];
  /** named lighting presets for BeatSheet.beats[].lighting */
  lighting: Record<string, Lighting>;
  /** camera-safe volume */
  safeMin: Vec3;
  safeMax: Vec3;
}
export interface SetBuilder extends LibraryItem {
  kind: 'set';
  /** backing environment manifest, when the set is asset-driven */
  manifest?: EnvironmentManifest;
  build(opts: { seed: number; decorDensity?: number }): BuiltSet;
}

// ---------------------------------------------------------------- props (S4)

export interface BuiltProp {
  instance: PropInstance;
  /** named states a beat can request (BeatSheet props[].state), e.g. closed/open, small/giant */
  states: string[];
}
export interface PropBuilder extends LibraryItem {
  kind: 'prop';
  manifest?: PropManifest;
  build(instanceId: string, opts: { seed: number }): BuiltProp;
  /** pose the prop for a named state at progress u (0..1) of the transition into it */
  applyState(p: BuiltProp, state: string, u: number): Partial<PropState>;
}

// ---------------------------------------------------------------- characters and faces (S3)

export interface CharacterRecipe extends LibraryItem {
  kind: 'character';
  displayName: string;
  /** manifest the engine rig is built from (buildCharacter) */
  manifest: CharacterManifest;
  /** default expressionId when a beat gives none */
  defaultExpression: string;
  /** expressionIds this character can show (subset of LIBRARY.expressions) */
  expressions: string[];
  /** optional per-character build step (accessories etc.) run after buildCharacter */
  decorate?(rig: Rig, opts: { seed: number }): void;
}

export interface ExpressionDef extends LibraryItem {
  kind: 'expression';
  /** draws the face for this expression; blink 0..1, talk 0..1 (mouth open) */
  draw(ctx: { ctx2d: CanvasRenderingContext2D; size: number; skin: string; blink: number; talk: number; t: number; seed: number }): void;
  /** optional emote bubble shown with the expression (vfx id) */
  emoteVfxId?: string;
}

// ---------------------------------------------------------------- actions and talking (S5)

/** Same shape as the engine's ACTION_DEFS entries, plus library identity and staging hints. */
export interface ActionDef extends LibraryItem, EngineActionDef {
  kind: 'action';
  holds: boolean;
  blendIn: number;
  layer?: boolean;
  contactU?: number;
  pose(c: ActionCtx): ActionPose;
  /** moves the root (walk/run/sneak/enter/exit) — staging supplies ActionCtx.loco */
  locomotion?: boolean;
  /** default duration when the beat does not fix one (s) */
  defaultDuration: number;
  /** what the action needs to resolve: a target (lookAt/prop/actor) and/or a prop in hand */
  needs?: Array<'target' | 'prop_in_hand' | 'door' | 'seat'>;
}

// ---------------------------------------------------------------- camera (S6)

export interface CameraSubject { center: Vec3; head?: Vec3; top: Vec3; bottom: Vec3; radius: number; facingYaw?: number }
export interface CameraRecipe extends LibraryItem {
  kind: 'camera';
  /** solve the camera at local time lt within a beat of duration d */
  solve(ctx: { lt: number; d: number; subject: CameraSubject; secondary?: CameraSubject; safeMin: Vec3; safeMax: Vec3; seed: number }): { pos: Vec3; target: Vec3; fovDeg: number; roll?: number };
  /** subjects the recipe needs: 1 (single) or 2 (two_shot / over_shoulder) */
  subjects: 1 | 2;
}

// ---------------------------------------------------------------- captions, graphics, VFX, audio (S7)

export interface VfxFrameContribution { particles?: Particle[]; post?: Partial<PostFx>; shake?: number; emotes?: Array<{ target: string; symbol: string; scale: number }>; lights?: Array<{ target: string; intensity: number; color: RGB }> }
export interface VfxDef extends LibraryItem {
  kind: 'vfx';
  duration: number;
  /** anchor: world point of the target entity, or screen-space */
  space: 'world' | 'screen';
  eval(ctx: { lt: number; d: number; u: number; at?: Vec3; seed: number; params: Record<string, number | string | boolean> }): VfxFrameContribution;
}

export interface TextStyleDef extends LibraryItem {
  kind: 'text_style';
  font: string;
  weight: number;
  fill: string;
  stroke?: { color: string; width: number };
  highlightFill?: string;
  /** 'screen' = 2D overlay; 'world' = 3D text placed in the set */
  space: 'screen' | 'world';
  maxWordsPerChunk: number;
  animateIn?: 'pop' | 'slide' | 'none';
}

export interface SfxDef extends LibraryItem {
  kind: 'sfx';
  /** audio asset refs (id@x.y.z) this cue may pick from deterministically by seed */
  sources: string[];
  gainDb: number;
  /** optional pitch jitter range (+/- semitones) */
  pitchJitter?: number;
}

export interface MusicDef extends LibraryItem {
  kind: 'music';
  sources: string[];
  gainDb: number;
  /** ducking under narration (dB) */
  duckDb: number;
  loop: boolean;
  mood: string;
}

export type LibraryDef = SetBuilder | PropBuilder | CharacterRecipe | ExpressionDef | ActionDef | CameraRecipe | VfxDef | TextStyleDef | SfxDef | MusicDef;
