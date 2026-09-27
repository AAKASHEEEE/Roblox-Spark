// Capability registry: the ONLY vocabulary the generator may use, derived from the locked asset library + engine.
import type { CharacterManifest, EnvironmentManifest, PropManifest, AudioManifest } from '../../schema/src/assets.ts';
import { ACTIONS, CAMERA_PRESETS, VFX } from '../../schema/src/episode.ts';
import { ACTION_DEFS, ACTION_REQUIREMENTS, ENGINE_FEATURES, unmetRequirements, type EngineFeature } from '../../engine/src/animation/actions.ts';

export interface ActionCapability {
  implemented: boolean;
  /** usable in generated stories with the current engine (implemented, story-worthy AND every required engine feature exists) */
  storyUse: boolean;
  /** explicit availability; 'unavailable' actions are never offered to or accepted from a model provider */
  availability: { status: 'available' } | { status: 'unavailable'; requires: EngineFeature[]; reason: string };
  needsTarget: boolean;
  needsTo: boolean;
  locomotion: boolean;
  contact: boolean;
  note: string;
}

const HELD = 'unavailable until hand attachment exists (see ACTION_REQUIREMENTS)';
/** story-level capability of each action; availability additionally requires ACTION_REQUIREMENTS to be met */
export const ACTION_CAPS: Record<string, Omit<ActionCapability, 'implemented' | 'availability'>> = {
  idle: { storyUse: true, needsTarget: false, needsTo: false, locomotion: false, contact: false, note: '' },
  walk: { storyUse: true, needsTarget: false, needsTo: true, locomotion: true, contact: false, note: 'path must be clear; speed limited by manifest walkSpeed' },
  run: { storyUse: true, needsTarget: false, needsTo: true, locomotion: true, contact: false, note: '' },
  chase: { storyUse: true, needsTarget: false, needsTo: true, locomotion: true, contact: false, note: '' },
  enter_frame: { storyUse: true, needsTarget: false, needsTo: true, locomotion: true, contact: false, note: '' },
  exit_frame: { storyUse: true, needsTarget: false, needsTo: true, locomotion: true, contact: false, note: '' },
  dive_prone: { storyUse: true, needsTarget: false, needsTo: true, locomotion: true, contact: false, note: 'ends prone, head raised' },
  point: { storyUse: true, needsTarget: true, needsTo: false, locomotion: false, contact: false, note: '' },
  press_button: { storyUse: true, needsTarget: true, needsTo: false, locomotion: false, contact: true, note: 'target must be a prop anchor with press_depress (button.press_surface)' },
  look_at: { storyUse: true, needsTarget: true, needsTo: false, locomotion: false, contact: false, note: '' },
  turn_toward: { storyUse: true, needsTarget: true, needsTo: false, locomotion: false, contact: false, note: '' },
  curious_lean: { storyUse: true, needsTarget: true, needsTo: false, locomotion: false, contact: false, note: '' },
  shock_recoil: { storyUse: true, needsTarget: false, needsTo: false, locomotion: false, contact: false, note: '' },
  cower: { storyUse: true, needsTarget: false, needsTo: false, locomotion: false, contact: false, note: '' },
  arms_crossed: { storyUse: true, needsTarget: false, needsTo: false, locomotion: false, contact: false, note: '' },
  head_shake: { storyUse: true, needsTarget: false, needsTo: false, locomotion: false, contact: false, note: 'additive head layer' },
  victory_pose: { storyUse: true, needsTarget: false, needsTo: false, locomotion: false, contact: false, note: '' },
  laugh: { storyUse: true, needsTarget: false, needsTo: false, locomotion: false, contact: false, note: '' },
  facepalm: { storyUse: true, needsTarget: true, needsTo: false, locomotion: false, contact: true, note: 'target = own face (<actor>.face)' },
  regret_freeze: { storyUse: true, needsTarget: false, needsTo: false, locomotion: false, contact: false, note: '' },
  angry_stomp: { storyUse: true, needsTarget: false, needsTo: false, locomotion: false, contact: false, note: '' },
  jump: { storyUse: true, needsTarget: false, needsTo: false, locomotion: false, contact: false, note: 'in place only' },
  fall: { storyUse: true, needsTarget: false, needsTo: false, locomotion: false, contact: false, note: 'backward, ends supine' },
  pick_up: { storyUse: true, needsTarget: true, needsTo: false, locomotion: false, contact: true, note: HELD },
  hold: { storyUse: true, needsTarget: false, needsTo: false, locomotion: false, contact: false, note: HELD },
  put_down: { storyUse: true, needsTarget: true, needsTo: false, locomotion: false, contact: true, note: HELD },
  throw: { storyUse: true, needsTarget: false, needsTo: false, locomotion: false, contact: false, note: HELD },
  drink: { storyUse: true, needsTarget: false, needsTo: false, locomotion: false, contact: false, note: `${HELD}; no drinkable prop exists` },
  hover: { storyUse: true, needsTarget: false, needsTo: false, locomotion: false, contact: false, note: 'only for floating rigs (BZTT, not built)' },
};

/** emotion -> locked expression per character (generation-time mapping, not an asset change) */
export const EMOTION_FACE: Record<string, Record<string, string>> = {
  zapp: { neutral: 'neutral', curious: 'curious', determined: 'determined', happy: 'neutral', shock: 'shock', regret: 'regret', skeptical: 'curious', smug: 'neutral', laugh: 'neutral', surprised: 'shock' },
  kira: { neutral: 'smug', curious: 'skeptical', determined: 'smug', happy: 'laughing', shock: 'surprised', regret: 'surprised', skeptical: 'skeptical', smug: 'smug', laugh: 'laughing', surprised: 'surprised' },
};

export interface Registry {
  characters: Record<string, CharacterManifest>;
  environment: EnvironmentManifest;
  props: { button: PropManifest; coin: PropManifest; desk: PropManifest };
  audio: Record<string, AudioManifest>;
  actions: Record<string, ActionCapability>;
  cameras: readonly string[];
  vfx: readonly string[];
  /** ids used in stage schemas */
  ids: { characters: string[]; props: string[]; environments: string[]; actions: string[] };
}

const semver = (a: string, b: string) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
function latest<T extends { id: string; version: string }>(all: Record<string, T>, id: string): T {
  const c = Object.values(all).filter((m) => m.id === id).sort((a, b) => semver(b.version, a.version));
  if (!c.length) throw new Error(`registry: ${id} missing from library`);
  return c[0];
}

export function buildRegistry(lib: { characters: Record<string, CharacterManifest>; props: Record<string, PropManifest>; environments: Record<string, EnvironmentManifest>; audio: Record<string, AudioManifest> }, features: Record<EngineFeature, boolean> = ENGINE_FEATURES): Registry {
  const characters = { zapp: latest(lib.characters, 'zapp'), kira: latest(lib.characters, 'kira') };
  const actions: Record<string, ActionCapability> = {};
  for (const a of ACTIONS) {
    const base = ACTION_CAPS[a] ?? { storyUse: false, needsTarget: false, needsTo: false, locomotion: false, contact: false, note: 'no capability entry' };
    const unmet = unmetRequirements(a, features);
    const implemented = !!ACTION_DEFS[a];
    const availability: ActionCapability['availability'] = !implemented ? { status: 'unavailable', requires: [], reason: 'not implemented' }
      : unmet.length ? { status: 'unavailable', requires: unmet, reason: ACTION_REQUIREMENTS[a]!.reason }
      : !base.storyUse ? { status: 'unavailable', requires: [], reason: base.note || 'not story-worthy' } : { status: 'available' };
    actions[a] = { implemented, ...base, storyUse: availability.status === 'available', availability, note: availability.status === 'unavailable' ? availability.reason : base.note };
  }
  const audio: Record<string, AudioManifest> = {};
  for (const a of Object.values(lib.audio)) audio[a.id] = a;
  return {
    characters,
    environment: latest(lib.environments, 'classroom'),
    props: { button: latest(lib.props, 'suspicious_button'), coin: latest(lib.props, 'spark_coin'), desk: latest(lib.props, 'student_desk') },
    audio, actions, cameras: CAMERA_PRESETS, vfx: VFX,
    ids: { characters: Object.keys(characters), props: ['suspicious_button', 'spark_coin', 'student_desk'], environments: ['classroom'], actions: ACTIONS.filter((a) => actions[a].storyUse) },
  };
}

/** compact description of the registry for model prompts */
export function registrySummary(r: Registry): Record<string, unknown> {
  return {
    characters: Object.fromEntries(Object.entries(r.characters).map(([k, c]) => [k, { version: c.version, personality: c.personality, expressions: c.allowedExpressions, actions: c.allowedActions.filter((a) => r.actions[a]?.storyUse) }])),
    environment: { id: r.environment.id, version: r.environment.version, note: 'the only available set' },
    props: { button: 'suspicious_button: FREE COINS button on a student desk (can press, flash, reset; cannot scale)', coin: 'spark_coin: pops out of the button; can spin, stand up, grow up to 16.7x, hop, wobble, tip over', desk: 'student_desk: static furniture' },
    unavailableActions: Object.fromEntries(Object.entries(r.actions).filter(([, c]) => c.availability.status === 'unavailable').map(([k, c]) => [k, c.availability.status === 'unavailable' ? `${c.availability.reason}${c.availability.requires.length ? ` (requires: ${c.availability.requires.join(', ')})` : ''}` : ''])),
    cameras: r.cameras, emotions: EMOTION_FACE,
  };
}
