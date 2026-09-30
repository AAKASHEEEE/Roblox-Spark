// Hand-held items, food and tools. Sizes are real-world or slightly chunkier (block style) and checked against Zapp's
// hand (~0.13 m wide): a phone fits in his palm, a cup is a little narrower than his hand, a broom reaches his shoulder.
import { box, cyl, decalUp, manifest, plane, sph, wedge, C } from './kit.ts';
import type { PropManifest } from '../../../schema/src/assets.ts';

// ---------------------------------------------------------------- phone (lies flat, screen up, top edge toward -z)
export const phone: PropManifest = manifest({
  id: 'phone', displayName: 'Phone', category: 'handheld', dims: [0.085, 0.016, 0.165],
  parts: [
    box('body', [0.085, 0.016, 0.165], [0, 0.008, 0], '#22252c', { bevel: 0.006, sheen: 0.8 }),
    decalUp('screen', 0.075, 0.145, [0, 0.0165, 0], C.screenOff, { sheen: 1 }),
    box('side_button', [0.004, 0.006, 0.025], [0.0445, 0.008, -0.03], C.steel),
  ],
  grips: { grip: [0, 0.008, 0.02] },
  anchors: { surface: [0, 0.016, 0], screen_center: [0, 0.0165, 0], ear: [0, 0.008, -0.07] },
  effectAnchors: { glow: [0, 0.03, 0], notification: [0, 0.05, -0.08] },
  material: 'electronics', color: '#22252c', allowed: ['glow'],
});

// ---------------------------------------------------------------- laptop (lid on the "lid" pivot, authored upright)
const LID = { attach: 'lid' };
export const laptop: PropManifest = manifest({
  id: 'laptop', displayName: 'Laptop', category: 'device', dims: [0.36, 0.262, 0.265], center: [0, -0.0075],
  parts: [
    box('base', [0.36, 0.022, 0.25], [0, 0.011, 0], C.steel, { bevel: 0.006, sheen: 0.7 }),
    decalUp('keyboard', 0.3, 0.1, [0, 0.0225, -0.03], C.dark),
    decalUp('trackpad', 0.1, 0.06, [0, 0.0225, 0.075], '#7f8791'),
    box('lid', [0.36, 0.24, 0.012], [0, 0.142, -0.131], C.steel, { ...LID, bevel: 0.005, sheen: 0.7 }),
    plane('screen', 0.33, 0.2, [0, 0.146, -0.1245], C.screenOff, { ...LID, sheen: 1 }),
    box('logo', [0.04, 0.04, 0.002], [0, 0.15, -0.1375], '#dfe5ec', LID),
  ],
  grips: { grip: [0, 0.011, 0.125], grip_lid: [0, 0.262, -0.131] },
  anchors: { surface: [0, 0.022, 0.02], keys: [0, 0.023, -0.03], screen_center: [0, 0.146, -0.124], lid_axis: [0, 0.022, -0.125] },
  effectAnchors: { glow: [0, 0.15, -0.08] },
  material: 'electronics', color: C.steel, allowed: ['open', 'glow'],
  notes: 'Lid on pivot "lid" (anchors.lid_axis). Authored upright; states open (-12 deg) and closed (+90 deg).',
});

// ---------------------------------------------------------------- book (closed, lying flat, spine toward -x)
export const book: PropManifest = manifest({
  id: 'book', displayName: 'Book', category: 'handheld', dims: [0.2, 0.05, 0.27],
  parts: [
    box('cover_bottom', [0.2, 0.008, 0.27], [0, 0.004, 0], '#d63b3b', { bevel: 0.002 }),
    box('pages', [0.19, 0.034, 0.26], [0.004, 0.025, 0], C.paper),
    box('cover_top', [0.2, 0.008, 0.27], [0, 0.046, 0], '#d63b3b', { bevel: 0.002 }),
    box('spine', [0.014, 0.05, 0.27], [-0.093, 0.025, 0], '#b52f2f', { bevel: 0.003 }),
    decalUp('title', 0.12, 0.05, [0.01, 0.0505, -0.05], C.yellow),
  ],
  grips: { grip: [-0.1, 0.025, 0] },
  anchors: { surface: [0, 0.05, 0] },
  material: 'paper', color: '#d63b3b',
});

// ---------------------------------------------------------------- backpack (standing, straps on the back = -z)
export const backpack: PropManifest = manifest({
  id: 'backpack', displayName: 'Backpack', category: 'handheld', dims: [0.4, 0.51, 0.3], center: [0, 0.015],
  parts: [
    box('body', [0.4, 0.46, 0.2], [0, 0.23, 0], '#e8503a', { bevel: 0.05 }),
    box('pocket', [0.32, 0.2, 0.07], [0, 0.14, 0.125], '#c63f2c', { bevel: 0.03 }),
    box('pocket_zip', [0.28, 0.012, 0.012], [0, 0.235, 0.158], C.ink),
    box('main_zip', [0.3, 0.008, 0.012], [0, 0.462, 0.02], C.ink),
    box('badge', [0.06, 0.06, 0.01], [0.1, 0.36, 0.103], C.yellow, { bevel: 0.004 }),
    box('handle', [0.12, 0.04, 0.025], [0, 0.48, -0.05], C.dark, { bevel: 0.008 }),
    box('strap_l', [0.06, 0.4, 0.03], [0.1, 0.25, -0.115], C.dark, { bevel: 0.008 }),
    box('strap_r', [0.06, 0.4, 0.03], [-0.1, 0.25, -0.115], C.dark, { bevel: 0.008 }),
  ],
  grips: { grip: [0, 0.49, -0.05], grip_strap: [0.1, 0.4, -0.13] },
  anchors: { surface: [0, 0.46, 0], back_mount: [0, 0.3, -0.13] },
  material: 'fabric', color: '#e8503a',
  notes: 'back_mount is the point that rests against a wearer\'s back (torso rear face).',
});

// ---------------------------------------------------------------- ball
export const ball: PropManifest = manifest({
  id: 'ball', displayName: 'Ball', category: 'handheld', dims: [0.245, 0.245, 0.245],
  collision: { shape: 'sphere', size: [0.12, 0.12, 0.12], offset: [0, 0.12, 0] },
  parts: [
    sph('ball', 0.12, [0, 0.12, 0], C.orange, { sheen: 0.3 }),
    cyl('seam_h', 0.1225, 0.008, [0, 0.12, 0], '#2b1a10'),
    cyl('seam_v1', 0.1225, 0.008, [0, 0.12, 0], '#2b1a10', { rot: [90, 0, 0] }),
    cyl('seam_v2', 0.1225, 0.008, [0, 0.12, 0], '#2b1a10', { rot: [0, 0, 90] }),
  ],
  grips: { grip: [0.12, 0.12, 0] },
  anchors: { surface: [0, 0.24, 0], center: [0, 0.12, 0] },
  material: 'matte_plastic', color: C.orange, allowed: ['spin', 'uniform_scale'], maxScale: 20,
});

// ---------------------------------------------------------------- pizza (states: whole pie / single hand-held slice)
export const pizza: PropManifest = manifest({
  id: 'pizza', displayName: 'Pizza', category: 'food', dims: [0.4, 0.043, 0.4],
  collision: { shape: 'cylinder', size: [0.2, 0.043, 0.2], offset: [0, 0.0215, 0] },
  parts: [
    cyl('crust', 0.2, 0.03, [0, 0.015, 0], '#e0a458', { bevel: 0.01 }),
    cyl('cheese', 0.18, 0.012, [0, 0.032, 0], '#ffd35a'),
    ...[0, 1, 2, 3, 4, 5].map((i) => cyl(`pep_${i}`, 0.028, 0.006, [Math.cos(i * Math.PI / 3) * 0.105, 0.04, Math.sin(i * Math.PI / 3) * 0.105], '#c8312b')),
    cyl('pep_c', 0.028, 0.006, [0, 0.04, 0], '#c8312b'),
    // single slice: tip toward -z, crust at +z (hidden in state "whole")
    wedge('slice', [0.16, 0.2, 0.018], [0, 0.009, 0.1], '#ffd35a', { rot: [-90, 0, 0] }),
    box('slice_crust', [0.17, 0.026, 0.03], [0, 0.013, 0.105], '#e0a458', { bevel: 0.008 }),
    cyl('slice_pep', 0.022, 0.005, [0, 0.0205, 0.035], '#c8312b'),
  ],
  grips: { grip: [0.2, 0.02, 0], grip_slice: [0, 0.013, 0.105] },
  anchors: { surface: [0, 0.043, 0], bite: [0, 0.01, -0.08] },
  material: 'matte_plastic', color: '#ffd35a', allowed: ['uniform_scale'],
});

// ---------------------------------------------------------------- drink cup (soda cup, lid, straw)
export const drink_cup: PropManifest = manifest({
  id: 'drink_cup', displayName: 'Drink Cup', category: 'handheld', dims: [0.106, 0.28, 0.106],
  collision: { shape: 'cylinder', size: [0.053, 0.28, 0.053], offset: [0, 0.14, 0] },
  parts: [
    cyl('cup', 0.05, 0.17, [0, 0.085, 0], C.blue, { bevel: 0.006 }),
    cyl('band', 0.0505, 0.05, [0, 0.09, 0], C.yellow),
    cyl('lid', 0.053, 0.014, [0, 0.177, 0], C.white, { bevel: 0.004 }),
    box('straw', [0.012, 0.11, 0.012], [0.01, 0.225, 0], C.red, { rot: [0, 0, -10] }),
  ],
  grips: { grip: [0.05, 0.09, 0] },
  anchors: { surface: [0, 0.184, 0], mouth: [0.02, 0.28, 0] },
  material: 'matte_plastic', color: C.blue, allowed: ['uniform_scale'],
});

// ---------------------------------------------------------------- trophy
const GOLD = { sheen: 1, emissive: '#3a2800' };
export const trophy: PropManifest = manifest({
  id: 'trophy', displayName: 'Trophy', category: 'collectible', dims: [0.29, 0.4, 0.2],
  parts: [
    box('base', [0.18, 0.07, 0.18], [0, 0.035, 0], '#3a2e25', { bevel: 0.01 }),
    plane('plaque', 0.12, 0.035, [0, 0.035, 0.0905], C.yellow),
    box('base_top', [0.13, 0.05, 0.13], [0, 0.095, 0], '#3a2e25', { bevel: 0.008 }),
    cyl('stem', 0.025, 0.1, [0, 0.17, 0], C.gold, GOLD),
    cyl('knot', 0.045, 0.025, [0, 0.22, 0], C.gold, { ...GOLD, bevel: 0.008 }),
    cyl('cup', 0.1, 0.16, [0, 0.31, 0], C.gold, { ...GOLD, bevel: 0.02 }),
    cyl('rim', 0.108, 0.02, [0, 0.39, 0], C.gold, { ...GOLD, bevel: 0.006 }),
    box('handle_l', [0.03, 0.12, 0.03], [0.13, 0.32, 0], C.gold, GOLD),
    box('handle_r', [0.03, 0.12, 0.03], [-0.13, 0.32, 0], C.gold, GOLD),
    box('arm_lt', [0.04, 0.025, 0.03], [0.115, 0.37, 0], C.gold, GOLD),
    box('arm_lb', [0.04, 0.025, 0.03], [0.115, 0.27, 0], C.gold, GOLD),
    box('arm_rt', [0.04, 0.025, 0.03], [-0.115, 0.37, 0], C.gold, GOLD),
    box('arm_rb', [0.04, 0.025, 0.03], [-0.115, 0.27, 0], C.gold, GOLD),
    box('emblem', [0.05, 0.05, 0.006], [0, 0.31, 0.1], '#fff1a8', { rot: [0, 0, 45], sheen: 1 }),
  ],
  grips: { grip: [0, 0.17, 0.025], grip_l: [0.13, 0.32, 0], grip_r: [-0.13, 0.32, 0] },
  anchors: { surface: [0, 0.4, 0], plaque: [0, 0.035, 0.091] },
  effectAnchors: { sparkle: [0, 0.45, 0] },
  material: 'metal_gold', color: C.gold, allowed: ['uniform_scale', 'glow'],
});

// ---------------------------------------------------------------- cash stack (three banded bundles; no real currency marks)
export const cash_stack: PropManifest = manifest({
  id: 'cash_stack', displayName: 'Cash Stack', category: 'collectible', dims: [0.18, 0.091, 0.09],
  parts: [
    box('bundle_0', [0.17, 0.03, 0.075], [0, 0.015, 0], C.cash, { bevel: 0.004 }),
    box('band_0', [0.035, 0.032, 0.077], [0, 0.015, 0], C.paper),
    box('bundle_1', [0.17, 0.03, 0.075], [0.005, 0.045, 0.003], C.cash, { bevel: 0.004, rot: [0, 6, 0] }),
    box('band_1', [0.035, 0.032, 0.077], [0.005, 0.045, 0.003], C.paper, { rot: [0, 6, 0] }),
    box('bundle_2', [0.17, 0.03, 0.075], [-0.004, 0.075, -0.002], C.cash, { bevel: 0.004 }),
    box('band_2', [0.035, 0.032, 0.077], [-0.004, 0.075, -0.002], C.paper),
    decalUp('print_l', 0.05, 0.055, [0.052, 0.0905, -0.002], C.cashDark),
    decalUp('print_r', 0.05, 0.055, [-0.06, 0.0905, -0.002], C.cashDark),
  ],
  grips: { grip: [0, 0.045, 0] },
  anchors: { surface: [0, 0.091, 0] },
  material: 'paper', color: C.cash, allowed: ['uniform_scale'], maxScale: 20,
  notes: 'Generic green bundles with paper bands; no real-world currency symbols, faces or platform currency names.',
});

// ---------------------------------------------------------------- ban hammer (stands on its handle end, head up)
export const ban_hammer: PropManifest = manifest({
  id: 'ban_hammer', displayName: 'Ban Hammer', category: 'tool', dims: [0.47, 1.11, 0.24],
  parts: [
    box('pommel', [0.09, 0.05, 0.09], [0, 0.025, 0], C.dark, { bevel: 0.01 }),
    box('wrap', [0.07, 0.25, 0.07], [0, 0.16, 0], C.dark, { bevel: 0.008 }),
    box('handle', [0.06, 0.62, 0.06], [0, 0.57, 0], C.walnut, { bevel: 0.008 }),
    box('collar', [0.1, 0.06, 0.1], [0, 0.87, 0], C.metal, { bevel: 0.01, sheen: 0.9 }),
    box('head', [0.42, 0.22, 0.22], [0, 1.0, 0], C.red, { bevel: 0.03, sheen: 0.5 }),
    box('cap_l', [0.04, 0.24, 0.24], [0.215, 1.0, 0], C.dark, { bevel: 0.015 }),
    box('cap_r', [0.04, 0.24, 0.24], [-0.215, 1.0, 0], C.dark, { bevel: 0.015 }),
    plane('label_f', 0.3, 0.14, [0, 1.0, 0.1105], '#ffffff'),
    plane('label_b', 0.3, 0.14, [0, 1.0, -0.1105], '#ffffff', { rot: [0, 180, 0] }),
  ],
  grips: { grip: [0, 0.16, 0], grip_top: [0, 0.5, 0] },
  anchors: { surface: [0, 1.11, 0], strike_face: [0.235, 1.0, 0], head_center: [0, 1.0, 0] },
  effectAnchors: { impact: [0.3, 1.0, 0] },
  material: 'glossy_plastic', color: C.red, allowed: ['uniform_scale', 'glow'],
  notes: 'Labels are painted in-house (props/screens.ts, block font): "BAN".',
});

// ---------------------------------------------------------------- broom (stands on its bristles)
export const broom: PropManifest = manifest({
  id: 'broom', displayName: 'Broom', category: 'tool', dims: [0.32, 1.42, 0.08],
  parts: [
    box('bristles', [0.32, 0.18, 0.07], [0, 0.09, 0], '#e2b85a', { bevel: 0.01 }),
    box('binding', [0.3, 0.06, 0.08], [0, 0.2, 0], C.redDark, { bevel: 0.01 }),
    box('neck', [0.12, 0.06, 0.05], [0, 0.26, 0], C.redDark, { bevel: 0.01 }),
    cyl('stick', 0.018, 1.1, [0, 0.84, 0], C.walnut),
    cyl('cap', 0.022, 0.04, [0, 1.4, 0], C.redDark, { bevel: 0.006 }),
  ],
  grips: { grip: [0, 1.1, 0], grip_low: [0, 0.75, 0] },
  anchors: { surface: [0, 1.42, 0], sweep: [0, 0.01, 0.05] },
  effectAnchors: { dust: [0, 0.03, 0.15] },
  material: 'wood', color: '#e2b85a',
});

// ---------------------------------------------------------------- plate
export const plate: PropManifest = manifest({
  id: 'plate', displayName: 'Plate', category: 'handheld', dims: [0.26, 0.0215, 0.26],
  collision: { shape: 'cylinder', size: [0.13, 0.0215, 0.13], offset: [0, 0.011, 0] },
  parts: [
    cyl('foot', 0.08, 0.008, [0, 0.004, 0], '#e6e9ee'),
    cyl('body', 0.13, 0.014, [0, 0.011, 0], '#ffffff', { bevel: 0.004 }),
    cyl('rim', 0.13, 0.004, [0, 0.019, 0], C.blue),
    cyl('well', 0.1, 0.004, [0, 0.0195, 0], '#ffffff'),
  ],
  grips: { grip: [0.13, 0.015, 0] },
  anchors: { surface: [0, 0.0215, 0] },
  material: 'glossy_plastic', color: '#ffffff',
});

// ---------------------------------------------------------------- sign board (two posts; text painted per instance)
export const sign_board: PropManifest = manifest({
  id: 'sign_board', displayName: 'Sign Board', category: 'decor', dims: [1.16, 1.7, 0.4],
  parts: [
    box('post_l', [0.06, 1.7, 0.06], [0.45, 0.85, 0], C.walnut),
    box('post_r', [0.06, 1.7, 0.06], [-0.45, 0.85, 0], C.walnut),
    box('foot_l', [0.1, 0.04, 0.4], [0.45, 0.02, 0], C.walnutDark),
    box('foot_r', [0.1, 0.04, 0.4], [-0.45, 0.02, 0], C.walnutDark),
    box('frame', [1.16, 0.68, 0.04], [0, 1.3, 0.05], C.walnutDark, { bevel: 0.01 }),
    box('board', [1.1, 0.62, 0.02], [0, 1.3, 0.075], C.paper),
    plane('text', 1.02, 0.54, [0, 1.3, 0.0855], '#ffffff'),
  ],
  grips: { grip: [0.45, 1.0, 0.03] },
  anchors: { surface: [0, 1.64, 0.05], text_center: [0, 1.3, 0.086], read_spot: [0, 0, 1.5] },
  material: 'wood', color: C.paper, permit: ['text_change'],
  notes: 'Text is painted per instance (build opts.text, default "NOTICE") with the in-house 5x7 block font.',
});

// ---------------------------------------------------------------- gift box (lid on the "lid" pivot)
const GL = { attach: 'lid' };
export const gift_box: PropManifest = manifest({
  id: 'gift_box', displayName: 'Gift Box', category: 'collectible', dims: [0.395, 0.44, 0.395],
  parts: [
    box('body', [0.36, 0.3, 0.36], [0, 0.15, 0], C.blue, { bevel: 0.01 }),
    box('ribbon_x', [0.07, 0.302, 0.365], [0, 0.15, 0], C.yellow),
    box('ribbon_z', [0.365, 0.302, 0.07], [0, 0.15, 0], C.yellow),
    decalUp('inside', 0.33, 0.33, [0, 0.303, 0], C.navy),
    box('lid', [0.39, 0.08, 0.39], [0, 0.33, 0], C.blue, { ...GL, bevel: 0.01 }),
    box('lid_ribbon_x', [0.07, 0.082, 0.395], [0, 0.33, 0], C.yellow, GL),
    box('lid_ribbon_z', [0.395, 0.082, 0.07], [0, 0.33, 0], C.yellow, GL),
    box('bow_a', [0.14, 0.07, 0.05], [0, 0.405, 0], C.yellow, { ...GL, rot: [0, 45, 0], bevel: 0.015 }),
    box('bow_b', [0.14, 0.07, 0.05], [0, 0.405, 0], C.yellow, { ...GL, rot: [0, -45, 0], bevel: 0.015 }),
    box('knot', [0.05, 0.05, 0.05], [0, 0.415, 0], '#ffb400', { ...GL, bevel: 0.01 }),
  ],
  grips: { grip: [0.18, 0.15, 0], grip_r: [-0.18, 0.15, 0] },
  anchors: { surface: [0, 0.37, 0], surprise: [0, 0.35, 0], lid_axis: [0, 0.29, -0.195] },
  effectAnchors: { confetti: [0, 0.55, 0] },
  material: 'paper', color: C.blue, allowed: ['open', 'uniform_scale'],
});

export const ITEM_PROPS: PropManifest[] = [phone, laptop, book, backpack, ball, pizza, drink_cup, trophy, cash_stack, ban_hammer, broom, plate, sign_board, gift_box];
