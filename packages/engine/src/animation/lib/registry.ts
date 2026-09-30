// S5 action library registry: every action ID the vignette pipeline can stage, as S0 ActionDefs.
//   - the 29 engine actions (ACTION_DEFS) under their existing IDs; jump / victory_pose gain landing squash and the
//     object actions (pick_up, hold, put_down, throw, drink) gain prop cues and anchor-aware poses
//   - the 21 planned library actions (sit ... flattened)
//   - enter_door / exit_door: public door-mark entrances and exits
// ACTION_DEFS / ActorTrack are untouched (byte-frozen), so existing episodes, goldens and the narrated path render exactly
// as before; library actions play through LibraryTrack (track.ts).
import type { ActionName } from '../../../../schema/src/episode.ts';
import { ACTION_DEFS, type ActionDef } from '../actions.ts';
import { hop, landingSquash, squashStretch } from '../comedy.ts';
import { BODY_ACTIONS } from './body-actions.ts';
import { DOOR_ACTIONS } from './door-actions.ts';
import { PROP_ACTIONS } from './prop-actions.ts';
import type { LibActionDef } from './types.ts';
import { ramp } from './util.ts';

export const LIB_ACTION_VERSION = '1.0.0';
type Def = Omit<LibActionDef, 'id' | 'version' | 'kind'>;
const make = (id: string, d: Def): LibActionDef => ({ id, version: LIB_ACTION_VERSION, kind: 'action', ...d });

/** staging hints for the engine actions (durations match how the story compiler uses them) */
const ENGINE_HINTS: Record<ActionName, Pick<Def, 'defaultDuration' | 'needs' | 'locomotion' | 'targetRole' | 'run'>> = {
  idle: { defaultDuration: 1.5 }, walk: { defaultDuration: 2, locomotion: true }, run: { defaultDuration: 1.5, locomotion: true, run: true },
  point: { defaultDuration: 1.2, needs: ['target'] }, press_button: { defaultDuration: 1.2, needs: ['target'], targetRole: 'contact' },
  pick_up: { defaultDuration: 1.2, needs: ['target'], targetRole: 'grip' }, hold: { defaultDuration: 1.5, needs: ['prop_in_hand'] },
  put_down: { defaultDuration: 1.2, needs: ['target', 'prop_in_hand'] }, drink: { defaultDuration: 2, needs: ['prop_in_hand'] },
  throw: { defaultDuration: 1.3, needs: ['target', 'prop_in_hand'] }, jump: { defaultDuration: 1.0 }, fall: { defaultDuration: 1.2 },
  cower: { defaultDuration: 1.5 }, look_at: { defaultDuration: 1.2, needs: ['target'] }, curious_lean: { defaultDuration: 1.2 },
  shock_recoil: { defaultDuration: 1.2 }, angry_stomp: { defaultDuration: 1.5 }, victory_pose: { defaultDuration: 1.6 }, laugh: { defaultDuration: 1.8 },
  facepalm: { defaultDuration: 1.4, needs: ['target'] }, regret_freeze: { defaultDuration: 1.5 }, hover: { defaultDuration: 2 },
  chase: { defaultDuration: 2, locomotion: true, run: true, needs: ['target'] }, turn_toward: { defaultDuration: 0.8, needs: ['target'] },
  exit_frame: { defaultDuration: 2, locomotion: true, run: true }, enter_frame: { defaultDuration: 2, locomotion: true },
  arms_crossed: { defaultDuration: 1.5 }, head_shake: { defaultDuration: 1.0 }, dive_prone: { defaultDuration: 1.6, locomotion: true, run: true },
};

/** engine jump + cartoon squash (crouch), stretch (air) and landing squash, on the engine's own phase timings */
function jumpWithSquash(base: ActionDef): Def['pose'] {
  return (c) => {
    const p = base.pose(c), u = c.u;
    // engine jump: crouch to 0.22, air 0.25..0.8, landing crouch 0.8..1
    const h = hop(u, { takeoff: 0.25, land: 0.8, height: 0, squash: 0.2, stretch: 0.1 });
    return { ...p, scale: h.scale };
  };
}
/** engine victory_pose (hop 0.15..0.45) + landing squash */
function victoryWithSquash(base: ActionDef): Def['pose'] {
  return (c) => {
    const p = base.pose(c), u = c.u;
    const air = u > 0.18 && u < 0.45 ? 1 + 0.08 * Math.sin(Math.PI * (u - 0.18) / 0.27) : 1;
    return { ...p, scale: squashStretch(air * landingSquash((u - 0.45) / 0.3, 0.16)) };
  };
}

function engineEntry(id: ActionName): LibActionDef {
  const base = ACTION_DEFS[id];
  const d: Def = { holds: base.holds, blendIn: base.blendIn, pose: base.pose, ...(base.layer ? { layer: true } : {}), ...(base.contactU !== undefined ? { contactU: base.contactU } : {}), ...ENGINE_HINTS[id] };
  switch (id) {
    case 'jump': d.pose = jumpWithSquash(base); break;
    case 'victory_pose': d.pose = victoryWithSquash(base); break;
    case 'pick_up': d.props = (c) => ({ hand: 'r', grip: 'grip', attach: ramp(c.u, 0.44, 0.47) }); break;
    case 'hold': d.props = () => ({ hand: 'r', grip: 'grip', attach: 1 }); break;
    case 'put_down': d.props = (c) => ({ hand: 'r', grip: 'grip', attach: 1 - ramp(c.u, 0.49, 0.52) }); break;
  }
  return make(id, d);
}

const ENGINE_IDS = Object.keys(ACTION_DEFS) as ActionName[];
/** the library actions that replace an engine pose for vignette staging (anchor-aware prop interactions) */
export const UPGRADED_ENGINE_ACTIONS = ['throw', 'drink'] as const;

export const LIB_ACTIONS: Readonly<Record<string, LibActionDef>> = Object.freeze({
  ...Object.fromEntries(ENGINE_IDS.map((id) => [id, engineEntry(id)])),
  ...Object.fromEntries(Object.entries({ ...BODY_ACTIONS, ...PROP_ACTIONS, ...DOOR_ACTIONS }).map(([id, d]) => [id, make(id, d)])),
});
/** S5 action definitions that did not exist in the legacy ACTION_DEFS table. */
export const NEW_ACTION_IDS: readonly string[] = Object.keys({ ...BODY_ACTIONS, ...PROP_ACTIONS, ...DOOR_ACTIONS }).filter((id) => !(id in ACTION_DEFS));
/** Door transit IDs are now public library entries; retained as an empty compatibility export. */
export const UNRESERVED_ACTION_IDS: readonly string[] = [];

export type ActionResolver = (name: string) => LibActionDef | undefined;
/** vignette path: the full library (upgraded prop interactions and squash included) */
export const libActionDef: ActionResolver = (name) => LIB_ACTIONS[name];
