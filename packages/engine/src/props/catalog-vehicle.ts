// Car: compact block hatchback, forward = +z, driver side = +x (a character facing +z has its left hand at +x).
// Roof at 1.54 m (Zapp's chest/neck), 3.64 m long. Each wheel is its own pivot (spin about x); front wheels sit under a
// steering pivot (yaw). See ./car.ts for rollWheels()/steer().
import { box, cyl, manifest, C, type V3 } from './kit.ts';
import type { PropManifest } from '../../../schema/src/assets.ts';

export const CAR_WHEEL = { radius: 0.34, width: 0.24, x: 0.8, z: 1.15 } as const;
const W = CAR_WHEEL;
export const WHEELS = ['fl', 'fr', 'rl', 'rr'] as const;
export type WheelId = (typeof WHEELS)[number];
/** wheel centre in prop space: l = +x, f = +z */
export const wheelCenter = (w: WheelId): V3 => [w[1] === 'l' ? W.x : -W.x, W.radius, w[0] === 'f' ? W.z : -W.z];

const wheelParts = (w: WheelId) => {
  const c = wheelCenter(w), o = { attach: `wheel_${w}` };
  const out = Math.sign(c[0]); // outer face direction
  return [
    cyl(`tire_${w}`, W.radius, W.width, c, C.rubber, { ...o, rot: [0, 0, 90], bevel: 0.04, sheen: 0.1 }),
    cyl(`hub_${w}`, 0.18, W.width + 0.01, c, C.metal, { ...o, rot: [0, 0, 90], sheen: 0.9 }),
    box(`spoke_${w}`, [0.02, 0.3, 0.06], [c[0] + out * (W.width / 2 + 0.01), c[1], c[2]], '#8a8f99', o),
  ];
};

const BODY = C.red;
export const car: PropManifest = manifest({
  id: 'car', displayName: 'Car', category: 'vehicle', dims: [1.88, 1.54, 3.64],
  parts: [
    box('body', [1.7, 0.62, 3.5], [0, 0.55, 0], BODY, { bevel: 0.08, sheen: 0.6 }),
    box('cabin', [1.56, 0.62, 1.9], [0, 1.17, -0.25], BODY, { bevel: 0.1, sheen: 0.6 }),
    box('roof', [1.5, 0.08, 1.7], [0, 1.5, -0.3], C.white, { bevel: 0.03 }),
    box('windshield', [1.4, 0.48, 0.03], [0, 1.17, 0.705], C.glass, { sheen: 1 }),
    box('rear_window', [1.4, 0.44, 0.03], [0, 1.19, -1.205], C.glass, { sheen: 1 }),
    box('window_l', [0.03, 0.44, 1.6], [0.785, 1.19, -0.25], C.glass, { sheen: 1 }),
    box('window_r', [0.03, 0.44, 1.6], [-0.785, 1.19, -0.25], C.glass, { sheen: 1 }),
    box('pillar_l', [0.04, 0.46, 0.08], [0.79, 1.19, -0.2], BODY),
    box('pillar_r', [0.04, 0.46, 0.08], [-0.79, 1.19, -0.2], BODY),
    box('bumper_f', [1.74, 0.16, 0.12], [0, 0.34, 1.76], C.dark, { bevel: 0.03 }),
    box('bumper_r', [1.74, 0.16, 0.12], [0, 0.34, -1.76], C.dark, { bevel: 0.03 }),
    box('grille', [0.8, 0.14, 0.02], [0, 0.62, 1.755], C.dark),
    box('head_l', [0.26, 0.14, 0.03], [0.6, 0.66, 1.755], '#fff6c8', { sheen: 1 }),
    box('head_r', [0.26, 0.14, 0.03], [-0.6, 0.66, 1.755], '#fff6c8', { sheen: 1 }),
    box('tail_l', [0.24, 0.12, 0.03], [0.6, 0.68, -1.755], '#ff3b30', { sheen: 1, emissive: '#400000' }),
    box('tail_r', [0.24, 0.12, 0.03], [-0.6, 0.68, -1.755], '#ff3b30', { sheen: 1, emissive: '#400000' }),
    box('plate', [0.34, 0.1, 0.01], [0, 0.34, 1.825], C.yellow),
    box('handle_l', [0.02, 0.04, 0.16], [0.86, 0.8, 0.1], C.metal, { sheen: 0.9 }),
    box('handle_r', [0.02, 0.04, 0.16], [-0.86, 0.8, 0.1], C.metal, { sheen: 0.9 }),
    box('mirror_l', [0.14, 0.08, 0.1], [0.87, 1.0, 0.6], BODY, { bevel: 0.02 }),
    box('mirror_r', [0.14, 0.08, 0.1], [-0.87, 1.0, 0.6], BODY, { bevel: 0.02 }),
    ...WHEELS.flatMap(wheelParts),
  ],
  grips: { grip: [0.875, 0.8, 0.1], grip_passenger: [-0.875, 0.8, 0.1] },
  anchors: {
    surface: [0, 1.54, -0.3], hood: [0, 0.86, 1.25], trunk: [0, 0.86, -1.5], seat_driver: [0.4, 0.75, -0.1],
    door_driver: [1.4, 0, 0.1], door_passenger: [-1.4, 0, 0.1],
    ...Object.fromEntries(WHEELS.map((w) => [`axle_${w}`, wheelCenter(w)])),
    ...Object.fromEntries(WHEELS.map((w) => [`contact_${w}`, [wheelCenter(w)[0], 0, wheelCenter(w)[2]] as V3])),
  },
  effectAnchors: { exhaust: [0.5, 0.3, -1.85], dust: [0, 0.05, -1.9], headlights: [0, 0.66, 1.9] },
  material: 'glossy_plastic', color: BODY, allowed: ['spin'],
  notes: 'Wheels on pivots wheel_fl/fr/rl/rr (spin about x), front wheels under steer_fl/steer_fr (yaw). Plate is blank (no text).',
});
