// Deterministically publishes the original procedural S2 set manifests and their browser-safe TS mirror.
// classroom@1.2.0 derives only from our locked in-house classroom; hallway/playground are authored here.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');
const unknownArgs = process.argv.slice(2).filter((arg) => arg !== '--check');
if (unknownArgs.length) throw new Error(`unknown argument(s): ${unknownArgs.join(', ')}`);
function emit(path: string, contents: string): void {
  if (CHECK) {
    if (!existsSync(path) || readFileSync(path, 'utf8') !== contents) throw new Error(`generated output is stale: ${path}`);
  } else writeFileSync(path, contents);
}
type V3 = [number, number, number];
type Piece = {
  id: string; size: number[]; pos: number[]; color: string; collide: boolean;
  shape?: 'box' | 'cylinder' | 'plane' | 'sphere'; rotDeg?: number[]; bevel?: number;
  texture?: string; emissive?: string; decor?: boolean;
};
type PieceOpts = Omit<Partial<Piece>, 'id' | 'size' | 'pos' | 'color'>;
const box = (id: string, size: V3, pos: V3, color: string, o: PieceOpts = {}): Piece => ({ id, size, pos, color, collide: false, ...o });
const cylinder = (id: string, radius: number, height: number, pos: V3, color: string, o: PieceOpts = {}): Piece =>
  ({ id, shape: 'cylinder', size: [radius, height, 0], pos, color, collide: false, ...o });
const sphere = (id: string, radius: number, pos: V3, color: string, o: PieceOpts = {}): Piece =>
  ({ id, shape: 'sphere', size: [radius, 0, 0], pos, color, collide: false, ...o });
const LICENSE = {
  source: 'original-procedural', author: 'RBLX SPARK (in-house)', license: 'Proprietary - owned',
  attributionRequired: false, notes: 'Original primitive geometry and procedural dressing authored in-house; no Roblox or copied map assets.',
};
const AXES = { up: '+y', stageRight: '+x', towardAudience: '+z' };
const ACTION_SAFE = { left: 0.06, right: 0.86, top: 0.1, bottom: 0.8 };

const classroom110 = JSON.parse(readFileSync(join(ROOT, 'assets/environments/classroom@1.1.0.json'), 'utf8')) as any;
const removedClassroomPieces = new Set(['wall_back', 'wainscot_back', 'rail_back']);
const classroomPieces = (classroom110.pieces as Piece[])
  .filter((p) => !removedClassroomPieces.has(p.id))
  .map((p) => p.id === 'clock_body' ? { ...p, pos: [3.75, 3.15, -3.97] } : p);
classroomPieces.splice(1, 0,
  box('wall_back_left', [6.4, 4.2, 0.2], [-1.4, 2.1, -4.1], '#9fcbb6', { collide: true }),
  box('wall_back_right', [1.4, 4.2, 0.2], [3.9, 2.1, -4.1], '#9fcbb6', { collide: true }),
  box('wall_back_lintel', [1.4, 1.15, 0.2], [2.5, 3.625, -4.1], '#9fcbb6', { collide: true }),
  box('wainscot_back_left', [6.4, 1.0, 0.06], [-1.4, 0.5, -3.98], '#5f8f7a'),
  box('wainscot_back_right', [1.4, 1.0, 0.06], [3.9, 0.5, -3.98], '#5f8f7a'),
  box('rail_back_left', [6.4, 0.06, 0.1], [-1.4, 1.02, -3.96], '#e9e1cf', { bevel: 0.01 }),
  box('rail_back_right', [1.4, 0.06, 0.1], [3.9, 1.02, -3.96], '#e9e1cf', { bevel: 0.01 }),
  box('classroom_door_frame_left', [0.12, 3.05, 0.18], [1.74, 1.525, -3.96], '#f3ead4', { bevel: 0.015 }),
  box('classroom_door_frame_right', [0.12, 3.05, 0.18], [3.26, 1.525, -3.96], '#f3ead4', { bevel: 0.015 }),
  box('classroom_door_frame_header', [1.64, 0.12, 0.18], [2.5, 3.11, -3.96], '#f3ead4', { bevel: 0.015 }),
  box('classroom_door_threshold', [1.4, 0.035, 0.3], [2.5, 0.0175, -3.95], '#b18b61', { bevel: 0.008 }),
  box('classroom_room_sign', [0.72, 0.28, 0.06], [3.65, 2.72, -3.96], '#264f73', { bevel: 0.025, decor: true }),
);
const classroom = {
  ...classroom110,
  version: '1.2.0',
  displayName: 'Classroom 1A - Doorway',
  pieces: classroomPieces,
  marks: { ...classroom110.marks, classroom_door_inside: { pos: [2.5, 0, -3.0], facingDeg: 0 } },
  anchors: { ...classroom110.anchors, coin_floor: [-2.1, 0, -1.4] },
  lighting: {
    ...classroom110.lighting,
    afternoon: {
      sunDir: [0.62, 0.74, 0.28], sunColor: '#ffe2b8', sunIntensity: 1.75,
      sky: '#b9d2e8', ground: '#a27a58', ambientIntensity: 0.7,
      fog: '#e8e2d7', fogNear: 18, fogFar: 46, exposure: 1.02,
    },
  },
  notes: '1.2.0: preserves 1.1.0 geometry while adding a collision-clear 1.40m x 3.05m doorway and the approved narrated coin/impact staging coordinates.',
};

const hallwayPieces: Piece[] = [
  box('floor', [9.2, 0.1, 16.4], [0, -0.05, 0], '#d8d2c4', { collide: true, bevel: 0.01 }),
  box('ceiling', [9.2, 0.1, 16.4], [0, 4.15, 0], '#f4f0e8'),
  box('wall_left', [0.2, 4.2, 16.4], [-4.6, 2.1, 0], '#c9d9df', { collide: true }),
  box('wall_right', [0.2, 4.2, 16.4], [4.6, 2.1, 0], '#c9d9df', { collide: true }),
  box('wall_back_left', [3.9, 4.2, 0.2], [-2.65, 2.1, -8.2], '#b9ced7', { collide: true }),
  box('wall_back_right', [3.9, 4.2, 0.2], [2.65, 2.1, -8.2], '#b9ced7', { collide: true }),
  box('wall_back_lintel', [1.4, 1.15, 0.2], [0, 3.625, -8.2], '#b9ced7', { collide: true }),
  box('wall_front', [9.2, 4.2, 0.2], [0, 2.1, 8.2], '#d4e0e4', { collide: true }),
  box('baseboard_left', [0.08, 0.24, 16.0], [-4.47, 0.12, 0], '#426b78'),
  box('baseboard_right', [0.08, 0.24, 16.0], [4.47, 0.12, 0], '#426b78'),
  box('hall_door_frame_left', [0.12, 3.05, 0.18], [-0.76, 1.525, -8.06], '#f4e2b8', { bevel: 0.015 }),
  box('hall_door_frame_right', [0.12, 3.05, 0.18], [0.76, 1.525, -8.06], '#f4e2b8', { bevel: 0.015 }),
  box('hall_door_frame_header', [1.64, 0.12, 0.18], [0, 3.11, -8.06], '#f4e2b8', { bevel: 0.015 }),
  box('hall_door_threshold', [1.4, 0.035, 0.32], [0, 0.0175, -8.05], '#9b8064', { bevel: 0.008 }),
  box('hall_door_exit_sign', [0.8, 0.28, 0.08], [0, 3.45, -8.05], '#2f8b57', { emissive: '#58d68d' }),
  box('water_fountain', [0.55, 0.85, 0.52], [4.15, 0.425, -2.3], '#7396a7', { collide: true, bevel: 0.06 }),
  box('water_fountain_basin', [0.62, 0.12, 0.62], [4.05, 0.88, -2.3], '#a9c2cd', { bevel: 0.04 }),
  box('trophy_case', [0.4, 1.7, 2.5], [4.25, 1.15, 3.7], '#89633f', { collide: true, bevel: 0.03 }),
  box('trophy_case_glass', [0.05, 1.42, 2.22], [4.02, 1.2, 3.7], '#9ed7df', { emissive: '#bcebf2' }),
  box('hall_center_stripe', [0.08, 0.012, 14.5], [0, 0.012, 0], '#e9b949'),
];
for (let i = 0; i < 10; i++) {
  const z = -5.4 + i * 1.2;
  const color = i % 2 ? '#356b8c' : '#2f7896';
  hallwayPieces.push(
    box(`locker_${i + 1}`, [0.48, 1.9, 1.0], [-4.22, 0.95, z], color, { collide: true, bevel: 0.025 }),
    box(`locker_door_${i + 1}`, [0.035, 1.72, 0.9], [-3.965, 0.98, z], i % 2 ? '#4c88a9' : '#438eaa', { bevel: 0.018 }),
    box(`locker_vent_${i + 1}`, [0.025, 0.05, 0.42], [-3.942, 1.58, z], '#173c52'),
    box(`locker_handle_${i + 1}`, [0.035, 0.18, 0.05], [-3.93, 1.02, z + 0.27], '#e2d4aa', { bevel: 0.01 }),
  );
}
for (const [n, z] of [-4.6, 0.2, 5.0].entries()) {
  hallwayPieces.push(
    box(`classroom_door_${n + 1}`, [0.05, 2.8, 1.25], [4.485, 1.4, z], n % 2 ? '#d69a4b' : '#c78345', { bevel: 0.035 }),
    box(`classroom_door_${n + 1}_window`, [0.035, 0.72, 0.44], [4.45, 2.05, z], '#8ec8d6', { emissive: '#a9deea' }),
    box(`classroom_door_${n + 1}_handle`, [0.08, 0.1, 0.08], [4.42, 1.15, z - 0.42], '#f0cf78', { bevel: 0.02 }),
  );
}
for (let i = 0; i < 5; i++) hallwayPieces.push(
  box(`ceiling_light_${i + 1}`, [1.1, 0.08, 0.4], [0, 4.04, -6 + i * 3], '#ffffff', { emissive: '#fff7db' }),
);
hallwayPieces.push(
  box('notice_board', [0.06, 1.35, 2.1], [4.48, 1.8, 6.25], '#ae6f42', { bevel: 0.025, decor: true }),
  box('notice_card_blue', [0.03, 0.44, 0.55], [4.44, 2.03, 5.8], '#5ba8d1', { decor: true }),
  box('notice_card_yellow', [0.03, 0.38, 0.48], [4.44, 1.55, 6.45], '#f4cf55', { decor: true }),
  cylinder('hall_plant_pot', 0.24, 0.45, [3.95, 0.225, 7.3], '#b95f3f', { collide: true, decor: true }),
  sphere('hall_plant', 0.48, [3.95, 0.85, 7.3], '#4c9d62', { decor: true }),
);
const schoolHallway = {
  kind: 'environment', id: 'school_hallway', version: '1.0.0', displayName: 'North School Hall', units: 'meters', axes: AXES,
  bounds: { min: [-4.6, 0, -8.2], max: [4.6, 4.2, 8.2] },
  pieces: hallwayPieces,
  marks: {
    hall_center: { pos: [0, 0, 0], facingDeg: 0 },
    lockers: { pos: [-3.25, 0, 1.2], facingDeg: -90 },
    hall_door_inside: { pos: [0, 0, -7.0], facingDeg: 0 },
    notice_board: { pos: [3.25, 0, 6.25], facingDeg: 90 },
    water_fountain: { pos: [3.25, 0, -2.3], facingDeg: 90 },
    hall_end: { pos: [0, 0, 5.8], facingDeg: 180 },
  },
  anchors: { locker_focus: [-3.95, 1.15, 1.2], trophy_case_focus: [4.0, 1.4, 3.7] },
  cameraSafe: { min: [-4.0, 0.2, -7.6], max: [4.0, 3.95, 7.6], audienceSideOnly: false },
  composition: { actionSafe: ACTION_SAFE, stageLine: { a: [-3.2, 0, 0], b: [3.2, 0, 0] } },
  lighting: {
    day: { sunDir: [-0.45, 0.86, 0.35], sunColor: '#fff4d8', sunIntensity: 1.85, sky: '#c8deea', ground: '#9d8b73', ambientIntensity: 0.72, fog: '#e5edf0', fogNear: 24, fogFar: 58, exposure: 1.02 },
    after_school: { sunDir: [0.65, 0.68, 0.35], sunColor: '#ffd2a1', sunIntensity: 1.55, sky: '#b8cbe0', ground: '#95745c', ambientIntensity: 0.62, fog: '#e7ded7', fogNear: 22, fogFar: 52, exposure: 1.08 },
  },
  extras: { decorDensity: 1, backgroundCharacters: 0 },
  notes: 'Original procedural school corridor with ten authored lockers, classroom doors, trophy case, fountain, notices and a collision-clear 1.40m x 3.05m end doorway.',
  license: LICENSE,
};

const playgroundPieces: Piece[] = [
  box('ground', [16, 0.1, 15], [0, -0.05, 0.5], '#72a85e', { collide: true }),
  box('rubber_play_surface', [9.2, 0.035, 7.4], [0, 0.01, -0.7], '#5d85a8', { bevel: 0.02 }),
  box('path', [2.2, 0.025, 5.0], [0, 0.018, 5.5], '#d6c8a7'),
  box('slide_platform', [1.4, 0.18, 1.4], [-3.0, 1.8, -0.8], '#f6c445', { collide: true, bevel: 0.04 }),
  box('slide_post_1', [0.18, 1.8, 0.18], [-3.55, 0.9, -1.35], '#e0524d', { collide: true, bevel: 0.025 }),
  box('slide_post_2', [0.18, 1.8, 0.18], [-2.45, 0.9, -1.35], '#e0524d', { collide: true, bevel: 0.025 }),
  box('slide_post_3', [0.18, 1.8, 0.18], [-3.55, 0.9, -0.25], '#e0524d', { collide: true, bevel: 0.025 }),
  box('slide_post_4', [0.18, 1.8, 0.18], [-2.45, 0.9, -0.25], '#e0524d', { collide: true, bevel: 0.025 }),
  box('slide_chute', [1.05, 0.22, 3.2], [-3.0, 1.05, 1.45], '#f28c35', { rotDeg: [-24, 0, 0], bevel: 0.025 }),
  box('slide_rail_left', [0.09, 0.22, 3.25], [-3.57, 1.23, 1.4], '#ffd760', { rotDeg: [-24, 0, 0] }),
  box('slide_rail_right', [0.09, 0.22, 3.25], [-2.43, 1.23, 1.4], '#ffd760', { rotDeg: [-24, 0, 0] }),
  box('slide_ladder_left', [0.12, 1.9, 0.12], [-3.45, 0.95, -1.85], '#365d86', { collide: true, rotDeg: [12, 0, 0] }),
  box('slide_ladder_right', [0.12, 1.9, 0.12], [-2.55, 0.95, -1.85], '#365d86', { collide: true, rotDeg: [12, 0, 0] }),
  box('swing_top_bar', [3.6, 0.18, 0.18], [2.5, 2.9, -1.8], '#315c7d', { collide: true, bevel: 0.03 }),
  box('swing_post_left', [0.2, 2.9, 0.2], [0.75, 1.45, -1.8], '#315c7d', { collide: true, bevel: 0.025 }),
  box('swing_post_right', [0.2, 2.9, 0.2], [4.25, 1.45, -1.8], '#315c7d', { collide: true, bevel: 0.025 }),
  box('swing_rope_1a', [0.035, 1.45, 0.035], [1.75, 2.12, -1.8], '#e9e0c8'),
  box('swing_rope_1b', [0.035, 1.45, 0.035], [2.1, 2.12, -1.8], '#e9e0c8'),
  box('swing_seat_1', [0.65, 0.09, 0.34], [1.925, 1.38, -1.8], '#e0524d', { collide: true, bevel: 0.025 }),
  box('swing_rope_2a', [0.035, 1.45, 0.035], [2.9, 2.12, -1.8], '#e9e0c8'),
  box('swing_rope_2b', [0.035, 1.45, 0.035], [3.25, 2.12, -1.8], '#e9e0c8'),
  box('swing_seat_2', [0.65, 0.09, 0.34], [3.075, 1.38, -1.8], '#f6c445', { collide: true, bevel: 0.025 }),
  box('sandpit_sand', [3.5, 0.08, 2.7], [3.0, 0.02, 3.55], '#edcf87', { bevel: 0.08 }),
  box('sandpit_edge_left', [0.18, 0.28, 2.9], [1.15, 0.14, 3.55], '#a86f3f', { collide: true, bevel: 0.04 }),
  box('sandpit_edge_right', [0.18, 0.28, 2.9], [4.85, 0.14, 3.55], '#a86f3f', { collide: true, bevel: 0.04 }),
  box('sandpit_edge_back', [3.9, 0.28, 0.18], [3.0, 0.14, 4.95], '#a86f3f', { collide: true, bevel: 0.04 }),
  box('sandpit_edge_front', [3.9, 0.28, 0.18], [3.0, 0.14, 2.15], '#a86f3f', { collide: true, bevel: 0.04 }),
  box('bench_seat', [2.1, 0.16, 0.55], [-4.9, 0.62, 4.3], '#9a6338', { collide: true, bevel: 0.04 }),
  box('bench_back', [2.1, 0.85, 0.14], [-4.9, 1.05, 4.55], '#9a6338', { collide: true, bevel: 0.03 }),
  box('bench_legs', [1.7, 0.62, 0.35], [-4.9, 0.31, 4.3], '#3b5363', { collide: true }),
  box('hopscotch_1', [0.7, 0.018, 0.7], [-0.35, 0.02, 3.15], '#ef6f61'),
  box('hopscotch_2', [0.7, 0.018, 0.7], [0.35, 0.02, 3.85], '#f5ca55'),
  box('hopscotch_3', [0.7, 0.018, 0.7], [-0.35, 0.02, 4.55], '#65b6a5'),
  box('fence_back_left', [6.8, 1.4, 0.12], [-4.6, 0.7, -6.94], '#f2ead7', { collide: true }),
  box('fence_back_right', [6.8, 1.4, 0.12], [4.6, 0.7, -6.94], '#f2ead7', { collide: true }),
  box('fence_left', [0.12, 1.4, 15], [-7.94, 0.7, 0.5], '#f2ead7', { collide: true }),
  box('fence_right', [0.12, 1.4, 15], [7.94, 0.7, 0.5], '#f2ead7', { collide: true }),
];
for (let i = 0; i < 6; i++) playgroundPieces.push(
  box(`slide_ladder_step_${i + 1}`, [0.88, 0.08, 0.16], [-3.0, 0.35 + i * 0.27, -1.92], '#6ea6c7', { bevel: 0.018 }),
);
for (const [i, x, z] of [[1, -6.4, -4.7], [2, 6.1, -4.9], [3, -6.2, 6.1]] as const) playgroundPieces.push(
  cylinder(`tree_trunk_${i}`, 0.22, 2.4, [x, 1.2, z], '#7a5132', { collide: true, decor: true }),
  sphere(`tree_crown_${i}`, 1.15, [x, 2.9, z], i === 2 ? '#4b985c' : '#55a969', { decor: true }),
  sphere(`tree_crown_${i}_small`, 0.75, [x + 0.6, 2.65, z + 0.15], '#63b674', { decor: true }),
);
const playground = {
  kind: 'environment', id: 'playground', version: '1.0.0', displayName: 'Spark School Playground', units: 'meters', axes: AXES,
  bounds: { min: [-8, 0, -7], max: [8, 5, 8] },
  pieces: playgroundPieces,
  marks: {
    play_center: { pos: [0, 0, 0.9], facingDeg: 0 },
    slide: { pos: [-1.6, 0, 1.8], facingDeg: -90 },
    swings: { pos: [2.5, 0, -0.55], facingDeg: 180 },
    sandpit: { pos: [3.0, 0, 3.55], facingDeg: 180 },
    bench: { pos: [-3.5, 0, 4.3], facingDeg: -90 },
    playground_path: { pos: [0, 0, 5.5], facingDeg: 180 },
  },
  anchors: { slide_focus: [-3.0, 1.1, 0.5], swing_focus: [2.5, 1.7, -1.8], sandpit_center: [3.0, 0.08, 3.55] },
  cameraSafe: { min: [-7.4, 0.2, -6.4], max: [7.4, 4.5, 7.4], audienceSideOnly: false },
  composition: { actionSafe: ACTION_SAFE, stageLine: { a: [-5.5, 0, 0.8], b: [5.5, 0, 0.8] } },
  lighting: {
    day: { sunDir: [-0.58, 0.8, 0.25], sunColor: '#fff1cf', sunIntensity: 2.2, sky: '#8ecaf0', ground: '#77a765', ambientIntensity: 0.7, fog: '#d9eef7', fogNear: 28, fogFar: 70, exposure: 1.0 },
    sunset: { sunDir: [0.75, 0.5, 0.3], sunColor: '#ffb36b', sunIntensity: 2.0, sky: '#8faed1', ground: '#9a694c', ambientIntensity: 0.55, fog: '#e9c5b0', fogNear: 24, fogFar: 62, exposure: 1.08 },
  },
  extras: { decorDensity: 1, backgroundCharacters: 0 },
  notes: 'Original procedural playground with a climbable slide silhouette, two swings, bordered sandpit, bench, hopscotch, trees, fence and unobstructed authored staging marks.',
  license: LICENSE,
};

const manifests = [classroom, schoolHallway, playground];
const assetDir = join(ROOT, 'assets/environments');
const generatedDir = join(ROOT, 'packages/engine/src/sets');
mkdirSync(generatedDir, { recursive: true });
for (const m of manifests) emit(join(assetDir, `${m.id}@${m.version}.json`), JSON.stringify(m, null, 2) + '\n');
const generated = [
  '// Generated by scripts/generate-lib-set-manifests.ts. Do not hand-edit; regenerate deterministically.',
  "import type { EnvironmentManifest } from '../../../schema/src/assets.ts';",
  '',
  `export const CLASSROOM_MANIFEST = ${JSON.stringify(classroom, null, 2)} as unknown as EnvironmentManifest;`,
  `export const SCHOOL_HALLWAY_MANIFEST = ${JSON.stringify(schoolHallway, null, 2)} as unknown as EnvironmentManifest;`,
  `export const PLAYGROUND_MANIFEST = ${JSON.stringify(playground, null, 2)} as unknown as EnvironmentManifest;`,
  '',
].join('\n');
emit(join(generatedDir, 'generated-manifests.ts'), generated);
console.log(`${CHECK ? 'verified' : 'generated'} ${manifests.map((m) => `${m.id}@${m.version}`).join(', ')}`);
