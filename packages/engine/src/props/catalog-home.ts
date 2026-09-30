// Architecture, furniture and appliances. Heights follow Zapp's joints: seats at knee height (~0.45), tables/desks at
// hip height (0.76), counters just above the hip (0.92), and the published door clears the taller adult cast.
import { box, cyl, decalUp, manifest, plane, C, type V3 } from './kit.ts';
import type { PropManifest } from '../../../schema/src/assets.ts';

// ---------------------------------------------------------------- door (hinged; see ./door.ts for set placement)
/** leaf pivot: front-left edge of the leaf, on the frame's front face */
export const DOOR_DIMS = { openingW: 1.25, openingH: 2.9, frameW: 1.45, frameH: 3.0, frameD: 0.16, leafT: 0.05, hingeX: -0.625, hingeZ: 0.08, handleY: 1.1 } as const;
const D = DOOR_DIMS;
const H = { attach: 'hinge' };
const JAMB_W = 0.1, JAMB_X = D.openingW / 2 + JAMB_W / 2;
const LEAF_W = D.openingW - 0.02, LEAF_H = D.openingH - 0.03;
const HANDLE_X = D.openingW / 2 - 0.15;
const leafZ = D.hingeZ - D.leafT / 2; // 0.055
export const door: PropManifest = manifest({
  id: 'door', version: '1.1.0', displayName: 'Door', category: 'architecture', dims: [D.frameW, D.frameH, 0.205], center: [0, 0.021],
  collision: { shape: 'box', size: [D.frameW, D.frameH, D.frameD], offset: [0, D.frameH / 2, 0] },
  parts: [
    box('jamb_l', [JAMB_W, D.frameH, D.frameD], [-JAMB_X, D.frameH / 2, 0], C.offWhite, { bevel: 0.01 }),
    box('jamb_r', [JAMB_W, D.frameH, D.frameD], [JAMB_X, D.frameH / 2, 0], C.offWhite, { bevel: 0.01 }),
    box('header', [D.frameW, 0.1, D.frameD], [0, D.openingH + 0.05, 0], C.offWhite, { bevel: 0.01 }),
    box('threshold', [D.openingW, 0.02, D.frameD], [0, 0.01, 0], C.steel),
    box('hinge_top', [0.03, 0.12, 0.03], [D.hingeX - 0.005, 2.45, D.hingeZ], C.metal, { sheen: 0.9 }),
    box('hinge_bot', [0.03, 0.12, 0.03], [D.hingeX - 0.005, 0.45, D.hingeZ], C.metal, { sheen: 0.9 }),
    // leaf (rides the hinge pivot)
    box('leaf', [LEAF_W, LEAF_H, D.leafT], [0, 0.01 + LEAF_H / 2, leafZ], '#c0703a', { ...H, bevel: 0.01 }),
    box('panel_top_f', [D.openingW - 0.3, 1.15, 0.012], [0, 2.18, leafZ + 0.027], '#a95f2f', { ...H, bevel: 0.004 }),
    box('panel_bot_f', [D.openingW - 0.3, 1.05, 0.012], [0, 0.68, leafZ + 0.027], '#a95f2f', { ...H, bevel: 0.004 }),
    box('panel_top_b', [D.openingW - 0.3, 1.15, 0.012], [0, 2.18, leafZ - 0.027], '#a95f2f', { ...H, bevel: 0.004 }),
    box('panel_bot_b', [D.openingW - 0.3, 1.05, 0.012], [0, 0.68, leafZ - 0.027], '#a95f2f', { ...H, bevel: 0.004 }),
    box('plate_f', [0.06, 0.18, 0.01], [HANDLE_X + 0.05, D.handleY, leafZ + 0.03], C.metal, { ...H, sheen: 0.9 }),
    box('lever_f', [0.16, 0.035, 0.035], [HANDLE_X, D.handleY, leafZ + 0.05], C.metal, { ...H, sheen: 0.9, bevel: 0.01 }),
    box('plate_b', [0.06, 0.18, 0.01], [HANDLE_X + 0.05, D.handleY, leafZ - 0.03], C.metal, { ...H, sheen: 0.9 }),
    box('lever_b', [0.16, 0.035, 0.035], [HANDLE_X, D.handleY, leafZ - 0.05], C.metal, { ...H, sheen: 0.9, bevel: 0.01 }),
  ],
  grips: { grip: [HANDLE_X, D.handleY, leafZ + 0.05], grip_back: [HANDLE_X, D.handleY, leafZ - 0.05] },
  anchors: {
    surface: [0, D.openingH / 2, D.hingeZ], threshold: [0, 0, 0], hinge_axis: [D.hingeX, 0, D.hingeZ],
    // floor spots: use_front stands beside the handle OUTSIDE the leaf's swing arc
    use_front: [D.openingW / 2 + 0.25, 0, 0.5], use_back: [0.35, 0, -0.65], enter_front: [0, 0, 1.65], enter_back: [0, 0, -1.1],
  },
  effectAnchors: { knock: [0, 1.75, D.hingeZ + 0.01], slam_dust: [0, 0.05, 0.3] },
  material: 'wood', color: '#c0703a', allowed: ['open'],
  notes: 'Hinged leaf on pivot "hinge" (anchors.hinge_axis). Front (+z) is the swing side. Place with door.ts doorPlacement().',
});

// ---------------------------------------------------------------- chair
export const chair: PropManifest = manifest({
  id: 'chair', displayName: 'Chair', category: 'furniture', dims: [0.48, 0.93, 0.46],
  parts: [
    box('seat', [0.48, 0.05, 0.46], [0, 0.425, 0], C.blue, { bevel: 0.012 }),
    ...([[-1, 1], [1, 1], [-1, -1], [1, -1]] as const).map(([sx, sz], i) => box(`leg_${i}`, [0.045, 0.4, 0.045], [sx * 0.2, 0.2, sz * 0.19], C.dark)),
    box('post_l', [0.045, 0.5, 0.045], [0.2, 0.65, -0.19], C.dark),
    box('post_r', [0.045, 0.5, 0.045], [-0.2, 0.65, -0.19], C.dark),
    box('backrest', [0.46, 0.22, 0.04], [0, 0.8, -0.2], C.blue, { bevel: 0.012 }),
    box('rail', [0.4, 0.04, 0.03], [0, 0.6, -0.2], C.dark),
  ],
  grips: { grip: [0, 0.91, -0.2] },
  anchors: { surface: [0, 0.45, 0.02], seat: [0, 0.45, 0.02], sit_front: [0, 0, 0.5] },
  material: 'matte_plastic', color: C.blue,
});

// ---------------------------------------------------------------- table
export const table: PropManifest = manifest({
  id: 'table', displayName: 'Table', category: 'furniture', dims: [1.4, 0.76, 0.85],
  parts: [
    box('top', [1.4, 0.06, 0.85], [0, 0.73, 0], C.wood, { bevel: 0.015 }),
    box('apron', [1.3, 0.1, 0.75], [0, 0.65, 0], C.woodDark),
    ...([[-1, 1], [1, 1], [-1, -1], [1, -1]] as const).map(([sx, sz], i) => box(`leg_${i}`, [0.09, 0.7, 0.09], [sx * 0.62, 0.35, sz * 0.34], C.woodDark, { bevel: 0.01 })),
  ],
  grips: { grip: [0, 0.74, 0.425], grip_l: [0.7, 0.74, 0], grip_r: [-0.7, 0.74, 0] },
  anchors: { surface: [0, 0.76, 0], place_l: [0.4, 0.76, 0.15], place_r: [-0.4, 0.76, 0.15], seat_front: [0, 0, 0.8] },
  material: 'wood', color: C.wood,
});

// ---------------------------------------------------------------- bed (foot toward +z)
export const bed: PropManifest = manifest({
  id: 'bed', displayName: 'Bed', category: 'furniture', dims: [1.2, 1.0, 2.46],
  parts: [
    ...([[-1, 1], [1, 1], [-1, -1], [1, -1]] as const).map(([sx, sz], i) => box(`foot_${i}`, [0.08, 0.1, 0.08], [sx * 0.54, 0.05, sz * 1.1], C.walnutDark)),
    box('frame', [1.2, 0.2, 2.3], [0, 0.2, 0], C.walnut, { bevel: 0.015 }),
    box('mattress', [1.1, 0.2, 2.2], [0, 0.4, 0], C.white, { bevel: 0.05 }),
    box('blanket', [1.12, 0.06, 1.45], [0, 0.5, 0.36], C.blue, { bevel: 0.025 }),
    box('blanket_fold', [1.13, 0.07, 0.14], [0, 0.52, -0.32], C.blueLight, { bevel: 0.025 }),
    box('pillow', [0.7, 0.12, 0.35], [0, 0.56, -0.85], '#ffffff', { bevel: 0.05 }),
    box('headboard', [1.2, 1.0, 0.08], [0, 0.5, -1.19], C.walnut, { bevel: 0.02 }),
    box('footboard', [1.2, 0.6, 0.08], [0, 0.3, 1.19], C.walnut, { bevel: 0.02 }),
  ],
  grips: { grip: [0, 0.6, 1.23], grip_head: [0, 1.0, -1.19] },
  anchors: { surface: [0, 0.53, 0.2], pillow: [0, 0.62, -0.85], lie_hips: [0, 0.5, -0.1], sit_edge: [0.55, 0.5, 0.3], get_in: [0.95, 0, 0.2] },
  material: 'wood', color: C.walnut,
});

// ---------------------------------------------------------------- couch
export const couch: PropManifest = manifest({
  id: 'couch', displayName: 'Couch', category: 'furniture', dims: [2.2, 0.875, 0.9],
  parts: [
    ...([[-1, 1], [1, 1], [-1, -1], [1, -1]] as const).map(([sx, sz], i) => box(`foot_${i}`, [0.08, 0.08, 0.08], [sx * 1.0, 0.04, sz * 0.36], C.walnutDark)),
    box('base', [2.2, 0.25, 0.9], [0, 0.2, 0], C.couch, { bevel: 0.03 }),
    box('cushion_l', [0.86, 0.14, 0.7], [0.44, 0.39, 0.08], C.couchLight, { bevel: 0.04 }),
    box('cushion_r', [0.86, 0.14, 0.7], [-0.44, 0.39, 0.08], C.couchLight, { bevel: 0.04 }),
    box('back', [2.2, 0.55, 0.22], [0, 0.6, -0.34], C.couch, { bevel: 0.04 }),
    box('back_cushion_l', [0.86, 0.4, 0.14], [0.44, 0.66, -0.18], C.couchLight, { bevel: 0.04 }),
    box('back_cushion_r', [0.86, 0.4, 0.14], [-0.44, 0.66, -0.18], C.couchLight, { bevel: 0.04 }),
    box('arm_l', [0.2, 0.62, 0.9], [1.0, 0.39, 0], C.couch, { bevel: 0.04 }),
    box('arm_r', [0.2, 0.62, 0.9], [-1.0, 0.39, 0], C.couch, { bevel: 0.04 }),
  ],
  grips: { grip: [1.0, 0.7, 0.2], grip_r: [-1.0, 0.7, 0.2] },
  anchors: { surface: [0, 0.46, 0.1], seat_l: [0.44, 0.46, 0.1], seat_r: [-0.44, 0.46, 0.1], sit_front_l: [0.44, 0, 0.75], sit_front_r: [-0.44, 0, 0.75] },
  material: 'fabric', color: C.couch,
});

// ---------------------------------------------------------------- fridge (door hinged on the right, handle left)
const FD = { attach: 'door' };
export const fridge: PropManifest = manifest({
  id: 'fridge', displayName: 'Fridge', category: 'appliance', dims: [0.85, 2.0, 0.8], center: [0, 0.025],
  parts: [
    box('back', [0.85, 2.0, 0.04], [0, 1.0, -0.355], C.offWhite),
    box('side_l', [0.04, 2.0, 0.68], [0.405, 1.0, -0.035], C.offWhite),
    box('side_r', [0.04, 2.0, 0.68], [-0.405, 1.0, -0.035], C.offWhite),
    box('top', [0.77, 0.04, 0.64], [0, 1.98, -0.015], C.offWhite),
    box('bottom', [0.77, 0.1, 0.64], [0, 0.05, -0.015], C.offWhite),
    box('divider', [0.77, 0.04, 0.64], [0, 1.45, -0.015], C.offWhite),
    box('interior_back', [0.77, 1.35, 0.01], [0, 0.775, -0.33], '#dfe9f2'),
    box('shelf_low', [0.76, 0.02, 0.55], [0, 0.55, -0.06], '#c8e4f5', { sheen: 0.8 }),
    box('shelf_mid', [0.76, 0.02, 0.55], [0, 1.0, -0.06], '#c8e4f5', { sheen: 0.8 }),
    box('milk', [0.1, 0.22, 0.1], [0.2, 0.67, -0.1], '#ffffff', { bevel: 0.006 }),
    box('milk_band', [0.102, 0.06, 0.102], [0.2, 0.7, -0.1], C.blue),
    cyl('bottle', 0.04, 0.26, [-0.05, 0.69, -0.12], C.green, { sheen: 0.8 }),
    box('cake', [0.2, 0.1, 0.18], [0.12, 1.06, -0.12], '#f5b3c8', { bevel: 0.01 }),
    box('apple', [0.08, 0.08, 0.08], [-0.22, 1.05, -0.05], C.red, { bevel: 0.025 }),
    box('kick', [0.77, 0.1, 0.02], [0, 0.05, 0.3], C.steel),
    // door (rides the "door" pivot)
    box('door', [0.85, 1.98, 0.07], [0, 1.0, 0.34], C.offWhite, { ...FD, bevel: 0.02 }),
    box('seam', [0.85, 0.012, 0.004], [0, 1.45, 0.3765], '#c3c9d0', FD),
    box('handle_main', [0.04, 0.6, 0.05], [-0.34, 1.05, 0.4], C.steel, { ...FD, bevel: 0.012, sheen: 0.8 }),
    box('handle_freezer', [0.04, 0.25, 0.05], [-0.34, 1.62, 0.4], C.steel, { ...FD, bevel: 0.012, sheen: 0.8 }),
    box('door_bin_low', [0.7, 0.08, 0.06], [0, 0.6, 0.275], '#c8e4f5', FD),
    box('door_bin_high', [0.7, 0.08, 0.06], [0, 1.1, 0.275], '#c8e4f5', FD),
    box('juice', [0.07, 0.18, 0.05], [-0.2, 0.72, 0.275], '#ffb020', { ...FD, bevel: 0.006 }),
    box('note', [0.12, 0.15, 0.004], [0.15, 1.3, 0.3775], '#ffe066', FD),
  ],
  grips: { grip: [-0.34, 1.05, 0.43], grip_freezer: [-0.34, 1.62, 0.43] },
  anchors: { surface: [0, 2.0, -0.015], door_axis: [0.425, 0, 0.375], shelf_mid: [0, 1.01, -0.05], shelf_low: [0, 0.56, -0.05], use_front: [-0.7, 0, 0.6], look_in: [-0.1, 0, 0.9] },
  effectAnchors: { cold_mist: [0, 1.0, 0.45], light: [0, 1.2, 0.1] },
  material: 'glossy_plastic', color: C.offWhite, allowed: ['open', 'glow'],
  notes: 'Door on pivot "door" (anchors.door_axis), swings toward +z. Interior light turns on with door_open.',
});

// ---------------------------------------------------------------- stove
export const stove: PropManifest = manifest({
  id: 'stove', displayName: 'Stove', category: 'appliance', dims: [0.76, 1.1, 0.72], center: [0, 0.035],
  parts: [
    box('body', [0.76, 0.88, 0.64], [0, 0.44, 0], C.offWhite, { bevel: 0.02 }),
    box('cooktop', [0.76, 0.04, 0.64], [0, 0.9, 0], C.dark, { sheen: 0.8 }),
    ...([[-1, 1], [1, 1], [-1, -1], [1, -1]] as const).map(([sx, sz]) => cyl(`burner_${sz > 0 ? 'f' : 'b'}${sx > 0 ? 'l' : 'r'}`, 0.09, 0.012, [sx * 0.19, 0.926, sz * 0.15], '#1a1c20')),
    box('backsplash', [0.76, 0.18, 0.06], [0, 1.01, -0.29], C.offWhite, { bevel: 0.015 }),
    ...[0, 1, 2, 3].map((i) => cyl(`knob_${i}`, 0.025, 0.03, [-0.27 + 0.18 * i, 1.0, -0.245], C.dark, { rot: [90, 0, 0] })),
    box('oven_door', [0.66, 0.5, 0.03], [0, 0.42, 0.335], '#dfe4ea', { bevel: 0.01 }),
    box('oven_window', [0.5, 0.26, 0.01], [0, 0.45, 0.352], '#1f232a', { sheen: 0.9 }),
    box('handle', [0.56, 0.035, 0.04], [0, 0.73, 0.37], C.steel, { bevel: 0.01, sheen: 0.8 }),
    box('drawer', [0.66, 0.1, 0.02], [0, 0.1, 0.33], '#c3c9d0'),
    cyl('pan', 0.1, 0.04, [-0.19, 0.952, 0.15], '#3a3d44', { bevel: 0.008 }),
    box('pan_handle', [0.08, 0.02, 0.03], [-0.33, 0.957, 0.15], C.ink),
  ],
  grips: { grip: [0, 0.73, 0.39] },
  anchors: {
    surface: [0, 0.92, 0], burner_fl: [0.19, 0.932, 0.15], burner_fr: [-0.19, 0.932, 0.15], burner_bl: [0.19, 0.932, -0.15], burner_br: [-0.19, 0.932, -0.15],
    pan: [-0.19, 0.972, 0.15], use_front: [0, 0, 0.75],
  },
  effectAnchors: { flame: [0.19, 0.95, 0.15], steam: [-0.19, 1.02, 0.15] },
  material: 'glossy_plastic', color: C.offWhite, allowed: ['glow'],
});

// ---------------------------------------------------------------- tv (on its own feet; sits on a table/console)
export const tv: PropManifest = manifest({
  id: 'tv', displayName: 'Television', category: 'device', dims: [1.3, 0.88, 0.26],
  parts: [
    box('stand', [0.5, 0.03, 0.26], [0, 0.015, 0], C.charcoal, { bevel: 0.008 }),
    box('neck', [0.1, 0.1, 0.05], [0, 0.08, -0.01], C.charcoal),
    box('bezel', [1.3, 0.76, 0.07], [0, 0.5, 0], C.charcoal, { bevel: 0.015, sheen: 0.6 }),
    box('back_bump', [0.9, 0.5, 0.06], [0, 0.5, -0.06], '#23262c', { bevel: 0.02 }),
    plane('screen', 1.22, 0.68, [0, 0.5, 0.0355], C.screenOff, { sheen: 1 }),
    box('led', [0.015, 0.01, 0.005], [0.58, 0.14, 0.036], '#5a1a18'),
  ],
  grips: { grip: [0.65, 0.5, 0], grip_r: [-0.65, 0.5, 0] },
  anchors: { surface: [0, 0.88, 0], screen_center: [0, 0.5, 0.036], watch_spot: [0, 0, 2.4] },
  effectAnchors: { glow: [0, 0.5, 0.3] },
  material: 'electronics', color: C.charcoal, allowed: ['glow'],
});

// ---------------------------------------------------------------- floor lamp
export const lamp: PropManifest = manifest({
  id: 'lamp', displayName: 'Lamp', category: 'decor', dims: [0.44, 1.65, 0.44],
  parts: [
    cyl('base', 0.16, 0.04, [0, 0.02, 0], C.dark, { bevel: 0.01 }),
    cyl('pole', 0.018, 1.34, [0, 0.71, 0], C.metal, { sheen: 0.9 }),
    box('switch', [0.03, 0.05, 0.03], [0.025, 1.1, 0], C.dark),
    cyl('socket', 0.03, 0.06, [0, 1.38, 0], C.dark),
    cyl('shade', 0.22, 0.3, [0, 1.5, 0], '#cdbb94', { bevel: 0.01 }),
    cyl('shade_trim', 0.224, 0.025, [0, 1.36, 0], '#e2a83a'),
  ],
  grips: { grip: [0, 1.0, 0] },
  anchors: { surface: [0, 1.65, 0], switch: [0.045, 1.1, 0] },
  effectAnchors: { light: [0, 1.3, 0] },
  material: 'fabric', color: '#cdbb94', allowed: ['glow'],
});

// ---------------------------------------------------------------- trash can (lid hinged at the back)
const LID = { attach: 'lid' };
export const trash_can: PropManifest = manifest({
  id: 'trash_can', displayName: 'Trash Can', category: 'decor', dims: [0.45, 0.71, 0.45],
  collision: { shape: 'cylinder', size: [0.225, 0.71, 0.225], offset: [0, 0.355, 0] },
  parts: [
    cyl('can', 0.21, 0.62, [0, 0.31, 0], C.grey, { bevel: 0.01 }),
    cyl('band_low', 0.215, 0.03, [0, 0.18, 0], C.greyDark),
    cyl('band_high', 0.215, 0.03, [0, 0.45, 0], C.greyDark),
    cyl('rim', 0.225, 0.035, [0, 0.6175, 0], C.greyDark),
    plane('badge', 0.1, 0.1, [0, 0.33, 0.212], C.green),
    cyl('lid', 0.22, 0.04, [0, 0.655, 0], C.grey, { ...LID, bevel: 0.012 }),
    box('lid_handle', [0.14, 0.035, 0.035], [0, 0.69, 0], '#3a3f47', { ...LID, bevel: 0.01 }),
  ],
  grips: { grip: [0, 0.71, 0], grip_rim: [0.225, 0.61, 0] },
  anchors: { surface: [0, 0.675, 0], mouth: [0, 0.64, 0], lid_axis: [0, 0.635, -0.22] },
  material: 'matte_plastic', color: C.grey, allowed: ['open'],
});

export const HOME_PROPS: PropManifest[] = [door, chair, table, bed, couch, fridge, stove, tv, lamp, trash_can];
export type { V3 };
// decal helper re-export (keeps authoring files importing from one place)
export { decalUp };
