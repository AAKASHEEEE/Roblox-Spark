// Rig specs (pivots + named states) for every prop in the catalog. Props without moving parts get a single 'default'
// state so every prop answers the same PropBuilder contract.
import type { RigSpec } from './rig.ts';
import { WHEELS } from './catalog-vehicle.ts';

const STATIC: RigSpec = { states: { default: { pose: {}, from: 'default', description: 'rest pose' } }, defaultState: 'default' };
const onOff = (parts: Record<string, string>, kind: 'lit' | 'screens', onName = 'on', offName = 'off', dflt = offName): RigSpec => ({
  [kind]: parts,
  states: {
    [offName]: { pose: { [kind]: Object.fromEntries(Object.keys(parts).map((p) => [p, 0])) }, from: onName, ease: 'linear', description: `${Object.keys(parts).join('/')} off` },
    [onName]: { pose: { [kind]: Object.fromEntries(Object.keys(parts).map((p) => [p, 1])) }, from: offName, ease: 'out', description: `${Object.keys(parts).join('/')} on` },
  },
  defaultState: dflt,
});

const PIZZA_WHOLE = ['crust', 'cheese', 'pep_0', 'pep_1', 'pep_2', 'pep_3', 'pep_4', 'pep_5', 'pep_c'];
const PIZZA_SLICE = ['slice', 'slice_crust', 'slice_pep'];
const show = (on: string[], off: string[]) => ({ ...Object.fromEntries(on.map((p) => [p, true])), ...Object.fromEntries(off.map((p) => [p, false])) });

export const RIGS: Record<string, RigSpec> = {
  door: {
    pivots: [{ id: 'hinge', at: 'hinge_axis', anchors: ['grip', 'grip_back', 'surface', 'knock'] }],
    states: {
      closed: { pose: { pivots: { hinge: { rot: [0, 0, 0] } } }, from: 'open', ease: 'in', description: 'leaf shut in the frame (closing accelerates like a push/slam)' },
      ajar: { pose: { pivots: { hinge: { rot: [0, -30, 0] } } }, from: 'closed', ease: 'out', description: 'leaf opened 30 deg toward +z (peek)' },
      open: { pose: { pivots: { hinge: { rot: [0, -90, 0] } } }, from: 'closed', ease: 'out', description: 'leaf swung 90 deg toward +z; doorway clear' },
    },
    defaultState: 'closed',
  },
  phone: { ...onOff({ screen: 'phone' }, 'screens', 'screen_on', 'screen_off') },
  laptop: {
    pivots: [{ id: 'lid', at: 'lid_axis', anchors: ['grip_lid', 'screen_center', 'glow'] }],
    screens: { screen: 'laptop' },
    states: {
      open: { pose: { pivots: { lid: { rot: [-12, 0, 0] } }, screens: { screen: 1 } }, from: 'closed', ease: 'smooth', description: 'lid at 102 deg, screen on' },
      closed: { pose: { pivots: { lid: { rot: [90, 0, 0] } }, screens: { screen: 0 } }, from: 'open', ease: 'smooth', description: 'lid folded onto the keyboard, screen off' },
    },
    defaultState: 'open',
  },
  fridge: {
    pivots: [{ id: 'door', at: 'door_axis', anchors: ['grip', 'grip_freezer'] }],
    lit: { interior_back: '#bfe3ff' },
    states: {
      door_closed: { pose: { pivots: { door: { rot: [0, 0, 0] } }, lit: { interior_back: 0 } }, from: 'door_open', ease: 'in', description: 'door shut, light off' },
      door_open: { pose: { pivots: { door: { rot: [0, 105, 0] } }, lit: { interior_back: 1 } }, from: 'door_closed', ease: 'out', description: 'door swung 105 deg toward +z, interior lit' },
    },
    defaultState: 'door_closed',
  },
  tv: {
    screens: { screen: 'tv' }, lit: { led: '#ff3b30' },
    states: {
      off: { pose: { screens: { screen: 0 }, lit: { led: 1 } }, from: 'on', ease: 'linear', description: 'dark screen, red standby LED' },
      on: { pose: { screens: { screen: 1 }, lit: { led: 0 } }, from: 'off', ease: 'out', description: 'picture on' },
    },
    defaultState: 'off',
  },
  car: {
    pivots: [
      { id: 'steer_fl', at: 'axle_fl' }, { id: 'wheel_fl', at: 'axle_fl', parent: 'steer_fl', wrap: true },
      { id: 'steer_fr', at: 'axle_fr' }, { id: 'wheel_fr', at: 'axle_fr', parent: 'steer_fr', wrap: true },
      { id: 'wheel_rl', at: 'axle_rl', wrap: true }, { id: 'wheel_rr', at: 'axle_rr', wrap: true },
    ],
    lit: { head_l: '#fff3b0', head_r: '#fff3b0' },
    states: {
      parked: { pose: { lit: { head_l: 0, head_r: 0 } }, from: 'driving', ease: 'out', description: 'wheels at rest, lights off' },
      // u spins the wheels two full turns (rolling forward); staging that moves the car uses car.ts rollWheels(distance)
      driving: { pose: { pivots: Object.fromEntries(WHEELS.map((w) => [`wheel_${w}`, { rot: [720, 0, 0] }])), lit: { head_l: 1, head_r: 1 } }, from: 'parked', ease: 'linear', description: 'headlights on, wheels roll forward (2 turns over u)' },
    },
    defaultState: 'parked',
  },
  lamp: onOff({ shade: '#ffb13b' }, 'lit'),
  stove: onOff({ burner_fl: '#ff5a1f', burner_fr: '#ff5a1f', burner_bl: '#ff5a1f', burner_br: '#ff5a1f' }, 'lit'),
  gift_box: {
    pivots: [{ id: 'lid', at: 'lid_axis' }],
    states: {
      closed: { pose: {}, from: 'open', ease: 'smooth', description: 'lid on' },
      open: { pose: { pivots: { lid: { rot: [-115, 0, 0], off: [0, 0.06, -0.02] } } }, from: 'closed', ease: 'back', description: 'lid pops up and flips back' },
    },
    defaultState: 'closed',
  },
  trash_can: {
    pivots: [{ id: 'lid', at: 'lid_axis', anchors: ['grip'] }],
    states: {
      closed: { pose: {}, from: 'open', ease: 'in', description: 'lid down' },
      open: { pose: { pivots: { lid: { rot: [-100, 0, 0] } } }, from: 'closed', ease: 'out', description: 'lid flipped up and back' },
    },
    defaultState: 'closed',
  },
  pizza: {
    states: {
      whole: { pose: { visible: show(PIZZA_WHOLE, PIZZA_SLICE) }, from: 'slice', ease: 'linear', description: 'whole pie' },
      slice: { pose: { visible: show(PIZZA_SLICE, PIZZA_WHOLE) }, from: 'whole', ease: 'linear', description: 'one hand-held slice (grip_slice)' },
    },
    defaultState: 'whole',
  },
  ban_hammer: { ...STATIC, decals: { label_f: 'ban', label_b: 'ban' } },
  sign_board: { ...STATIC, decals: { text: 'sign' } },
  suspicious_button: {
    states: {
      up: { pose: { state: { capDepth: 0 } }, from: 'pressed', ease: 'back', description: 'cap up' },
      pressed: { pose: { state: { capDepth: 1 } }, from: 'up', ease: 'out', description: 'cap pressed in' },
    },
    defaultState: 'up',
  },
};
export const rigFor = (id: string): RigSpec => RIGS[id] ?? STATIC;
