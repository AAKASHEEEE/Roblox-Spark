// Library resolution for staging: which beat-sheet IDs are built from real producers / locked assets and which are
// rendered as labelled grey placeholders (sets, characters, props) or played through an existing engine behaviour with
// a placeholder label (actions, expressions, VFX, text graphics). Audio IDs are resolved but never drawn.
import { LIBRARY, lookup, type Library, type LibraryKind } from '../../library/src/ids.ts';
import { registeredBuilder, resolveManifestKey, type ManifestLibrary } from '../../engine/src/build-dispatch.ts';
import { hasFace } from '../../engine/src/faces/index.ts';
import { LIB_ACTIONS, NEW_ACTION_IDS, UPGRADED_ENGINE_ACTIONS } from '../../engine/src/animation/lib/registry.ts';
import type { CharacterManifest } from '../../schema/src/assets.ts';

export type Resolution = 'available' | 'placeholder' | 'fallback' | 'audio_only' | 'unknown';
export interface ResolvedItem { kind: LibraryKind; id: string; status: 'available' | 'planned' | 'unknown'; resolution: Resolution; source: string; note?: string }

const bare = (r: string) => r.split('@')[0];

/** sets / characters / props: builder or locked manifest = real; otherwise a grey placeholder block */
export function resolveAsset(kind: 'sets' | 'characters' | 'props', ref: string, lib: ManifestLibrary, library: Library = LIBRARY): ResolvedItem {
  const e = lookup(kind, ref, library), id = bare(ref);
  const rk = kind === 'sets' ? 'set' : kind === 'characters' ? 'character' : 'prop';
  const records = kind === 'sets' ? lib.environments : kind === 'characters' ? lib.characters : lib.props;
  const b = registeredBuilder(rk, ref) ?? (!ref.includes('@') ? registeredBuilder(rk, id) : undefined);
  if (b) return { kind, id, status: e?.status ?? 'unknown', resolution: 'available', source: `builder ${b.id}@${b.version}` };
  // a planned entry is never rendered from a stray manifest; an available entry needs its locked asset
  const key = e?.status === 'available' ? resolveManifestKey(ref, records) : undefined;
  if (key) return { kind, id, status: 'available', resolution: 'available', source: `assets ${key}` };
  return { kind, id, status: e?.status ?? 'unknown', resolution: 'placeholder', source: 'grey placeholder block', note: e ? (e.status === 'planned' ? `planned (${e.owner})` : 'available in the manifest but no locked asset / builder found') : 'not in the library' };
}

// ---------------------------------------------------------------- expressions

/** nearest drawable face for an expression the character's face set does not have (first match wins) */
const EXPRESSION_NEAREST: Record<string, string[]> = {
  evil_grin: ['smug', 'determined', 'happy'], big_grin: ['happy', 'laughing', 'smug', 'curious'], laugh: ['laughing', 'happy', 'smug'], happy: ['happy', 'laughing', 'smug', 'curious'],
  furious: ['angry', 'determined', 'skeptical'], angry: ['angry', 'determined', 'skeptical'], scream: ['shock', 'surprised'], shocked: ['shock', 'surprised'], shock: ['shock', 'surprised'],
  surprised: ['surprised', 'shock'], scared: ['shock', 'surprised', 'regret'], sad: ['regret', 'skeptical'], crying: ['regret', 'skeptical'], suspicious: ['skeptical', 'curious', 'determined'],
  sleepy: ['regret', 'neutral', 'skeptical'], confused: ['curious', 'skeptical', 'surprised'], love_eyes: ['happy', 'laughing', 'smug'], calm: ['calm', 'neutral', 'smug', 'skeptical'],
  strict: ['strict', 'determined', 'skeptical'], neutral: ['neutral', 'calm', 'skeptical'], curious: ['curious', 'skeptical', 'surprised'], smug: ['smug', 'determined', 'happy'],
  skeptical: ['skeptical', 'curious', 'determined'], determined: ['determined', 'skeptical', 'smug'], regret: ['regret', 'skeptical'], laughing: ['laughing', 'happy', 'smug'],
};
export interface FaceResolution { requested: string; applied: string; resolution: 'available' | 'fallback'; note?: string }
export function resolveExpression(expr: string, m: CharacterManifest, library: Library = LIBRARY): FaceResolution {
  const states = m.face.states;
  if (hasFace(m, expr)) return { requested: expr, applied: expr, resolution: 'available' };
  const pick = (EXPRESSION_NEAREST[expr] ?? []).find((s) => states[s]) ?? Object.keys(states)[0];
  return { requested: expr, applied: pick, resolution: 'fallback', note: `${m.id} has no "${expr}" face; nearest drawable "${pick}"` };
}

// ---------------------------------------------------------------- actions

/**
 * How staging plays a beat-sheet action: the world contract (packages/narrated/src/contracts.ts) it runs under and the
 * procedural bridge keeps authoritative root staging intact; `runtime: library` means VignetteScene overlays the real
 * S5 LibraryTrack pose/cues. `placeholder` is reserved for an unknown or genuinely missing implementation.
 */
export interface ActionPlay { contract: 'move_to' | 'look_at' | 'press_button' | 'jump' | 'celebrate' | 'warning' | 'confident_pose' | 'remain_still' | 'fall_prone'; pose: string; hold: boolean; seconds: number; posture: 'standing' | 'implied_seated' | 'prone'; locomotion?: 'walk' | 'run'; placeholder: boolean; runtime: 'library' | 'legacy' | 'fallback' }
type ActionPlayBase = Omit<ActionPlay, 'placeholder' | 'runtime'>;
const P = (contract: ActionPlay['contract'], pose: string, hold: boolean, seconds: number, extra: Partial<ActionPlayBase> = {}): ActionPlayBase => ({ contract, pose, hold, seconds, posture: 'standing', ...extra });
const ACTION_PLAY: Record<string, ActionPlayBase> = {
  idle: P('remain_still', 'idle', true, 0.8), walk: P('move_to', 'idle', true, 0, { locomotion: 'walk' }), run: P('move_to', 'idle', true, 0, { locomotion: 'run' }),
  chase: P('move_to', 'idle', true, 0, { locomotion: 'run' }), enter_frame: P('move_to', 'idle', true, 0, { locomotion: 'walk' }), exit_frame: P('move_to', 'idle', true, 0, { locomotion: 'walk' }),
  press_button: P('press_button', 'press_button', false, 0.9), jump: P('jump', 'jump', false, 0.9), fall: P('fall_prone', 'fall', true, 0.6, { posture: 'prone' }),
  dive_prone: P('fall_prone', 'dive_prone', true, 0.6, { posture: 'prone' }), head_shake: P('warning', 'head_shake', false, 0.9), arms_crossed: P('confident_pose', 'arms_crossed', true, 1.8),
  victory_pose: P('celebrate', 'victory_pose', false, 1.3), look_at: P('look_at', 'look_at', true, 1.2), turn_toward: P('look_at', 'look_at', true, 1.2),
  point: P('look_at', 'point', true, 1.2), curious_lean: P('look_at', 'curious_lean', true, 1.2), shock_recoil: P('look_at', 'shock_recoil', true, 1.2), cower: P('look_at', 'cower', true, 1.2),
  angry_stomp: P('look_at', 'angry_stomp', false, 1.0), laugh: P('look_at', 'laugh', true, 1.2), facepalm: P('look_at', 'facepalm', true, 1.2), regret_freeze: P('look_at', 'regret_freeze', true, 1.2),
  // needs hand attachment / floating rig (engine: unavailable) -> nearest procedural pose
  pick_up: P('look_at', 'look_at', true, 1.0), hold: P('look_at', 'look_at', true, 1.0), put_down: P('look_at', 'look_at', true, 1.0), drink: P('look_at', 'look_at', true, 1.0),
  throw: P('look_at', 'point', true, 1.0), hover: P('remain_still', 'idle', true, 1.0),
  // planned (S5) -> closest existing behaviour, labelled
  sit: P('remain_still', 'idle', true, 0.8, { posture: 'implied_seated' }), stand_up: P('remain_still', 'idle', true, 0.8), celebrate: P('celebrate', 'victory_pose', false, 1.3),
  dance: P('celebrate', 'victory_pose', false, 1.6), cry: P('look_at', 'regret_freeze', true, 1.2), scream: P('look_at', 'shock_recoil', true, 1.2), grab: P('look_at', 'point', true, 1.0),
  tug: P('look_at', 'point', true, 1.0), open_door: P('look_at', 'point', true, 0.8), slam_door: P('look_at', 'point', true, 0.8), type_laptop: P('look_at', 'look_at', true, 1.2),
  use_phone: P('look_at', 'look_at', true, 1.2), eat: P('look_at', 'look_at', true, 1.2), sleep: P('remain_still', 'idle', true, 1.2), look_around: P('look_at', 'look_at', true, 1.2),
  shrug: P('look_at', 'curious_lean', true, 1.0), wave: P('look_at', 'point', true, 1.0), clap: P('celebrate', 'victory_pose', false, 1.2), sneak: P('move_to', 'idle', true, 0, { locomotion: 'walk' }),
  push: P('look_at', 'point', true, 1.0), flattened: P('fall_prone', 'fall', true, 0.6, { posture: 'prone' }),
};
const LIBRARY_TRACK_ACTIONS = new Set<string>([...NEW_ACTION_IDS, ...UPGRADED_ENGINE_ACTIONS, 'pick_up', 'hold', 'put_down', 'hover']);
export function resolveAction(actionId: string, library: Library = LIBRARY): ActionPlay & { status: 'available' | 'planned' | 'unknown'; note?: string } {
  const e = lookup('actions', actionId, library);
  const play = ACTION_PLAY[actionId] ?? P('look_at', 'look_at', true, 1.2);
  const implemented = !!LIB_ACTIONS[actionId];
  return {
    ...play,
    runtime: !implemented ? 'fallback' : LIBRARY_TRACK_ACTIONS.has(actionId) ? 'library' : 'legacy',
    placeholder: !e || !implemented,
    status: e?.status ?? 'unknown',
    ...(!e ? { note: 'not in the library' } : !implemented ? { note: `action ${actionId} has no LIB_ACTIONS implementation; played as ${play.pose}` } : {}),
  };
}

/** VFX / text styles / SFX / music / camera recipes: available, planned (placeholder or audio-only) or unknown */
export function resolveCue(kind: 'vfx' | 'textStyles' | 'sfx' | 'music' | 'cameraRecipes', ref: string, library: Library = LIBRARY): ResolvedItem {
  const e = lookup(kind, ref, library), id = bare(ref);
  if (!e) return { kind, id, status: 'unknown', resolution: 'unknown', source: 'not in the library' };
  if (kind === 'sfx' || kind === 'music') return { kind, id, status: e.status, resolution: 'audio_only', source: e.status === 'available' ? e.source ?? 'asset' : `planned (${e.owner}); not drawn` };
  if (kind === 'cameraRecipes') return { kind, id, status: e.status, resolution: 'available', source: 'packages/vignette camera recipe (S6)' };
  return { kind, id, status: e.status, resolution: e.status === 'available' ? 'available' : 'placeholder', source: e.status === 'available' ? e.source ?? 'engine' : `planned (${e.owner}); labelled placeholder` };
}
