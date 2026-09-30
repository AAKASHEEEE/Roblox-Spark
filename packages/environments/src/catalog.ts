// The environment catalog: versioned, locked profiles over existing environment assets.
// classroom@1.0.0 mirrors the manifest pinned by the Visual Comedy PoC (free-coins-loop-001) exactly — its marks,
// anchors, camera box and lighting are copied, not re-tuned. classroom@1.1.0 mirrors the staging-overlay manifest.
// Catalog-level semantic marks (button_desk, coin_spawn, zapp_impact, classroom_door) are metadata over existing
// coordinates; none of them adds geometry.
import { ACTIONS } from '../../schema/src/episode.ts';
import { PROFILE_SCHEMA_VERSION, SHOT_INTENTS, type EnvironmentProfile, type Mark, type PropAnchor, type ShotIntent } from './schema.ts';
import { ENVIRONMENT_LOCK, type Catalog } from './lock.ts';

type V3 = [number, number, number];
const NO_HAZARD = { kind: 'none', radius: 0 } as const;
const ON_SCREEN: ShotIntent[] = ['frontal_medium', 'two_shot', 'over_shoulder', 'wide_environment', 'reaction_punch_in', 'chase_cam', 'final_loop'];

function actor(id: string, position: V3, facingDeg: number, reachable: string[], o: Partial<Mark> = {}): Mark {
  return {
    id, kind: 'actor', position, facingDeg, postures: ['stand'], occupancy: 1, reachable, pathId: 'floor_main', aliasOf: null, exclusiveWith: [],
    camera: { onScreen: true, visibleIntents: ON_SCREEN }, hazard: { ...NO_HAZARD }, cueDirection: null, instantiateGeometry: false,
    sourceRef: `manifest.marks.${id}`, ...o,
  };
}
const alias = (id: string, of: Mark, o: Partial<Mark> = {}): Mark => ({ ...of, id, aliasOf: of.id, reachable: [], exclusiveWith: [], sourceRef: `manifest.marks.${id} (same spot as ${of.id})`, ...o });
const waypoint = (id: string, position: V3, facingDeg: number, reachable: string[]): Mark =>
  actor(id, position, facingDeg, reachable, { kind: 'waypoint', occupancy: 0, postures: ['stand'], camera: { onScreen: true, visibleIntents: [] }, pathId: 'floor_waypoints' });
const propMark = (id: string, position: V3, sourceRef: string, o: Partial<Mark> = {}): Mark => ({
  id, kind: 'prop', position, facingDeg: 0, postures: [], occupancy: 1, reachable: [], pathId: null, aliasOf: null, exclusiveWith: [],
  camera: { onScreen: true, visibleIntents: ['prop_ecu', 'frontal_medium', 'two_shot', 'wide_environment', 'top_down_insert'] }, hazard: { ...NO_HAZARD },
  cueDirection: null, instantiateGeometry: false, sourceRef, ...o,
});
/** classroom has no door geometry: the door is only a direction characters look/exit toward */
const classroomDoor: Mark = {
  id: 'classroom_door', kind: 'offscreen_cue', position: [-5.2, 0, -2.6], facingDeg: 90, postures: [], occupancy: 0, reachable: [], pathId: null,
  aliasOf: null, exclusiveWith: [], camera: { onScreen: false, visibleIntents: [] }, hazard: { ...NO_HAZARD }, cueDirection: [-1, 0, -0.2],
  instantiateGeometry: false, sourceRef: 'catalog: off-screen cue beyond wall_left (no door geometry exists)',
};

function classroomMarks100(): Mark[] {
  const zappEnter = actor('zapp_enter', [-0.75, 0, -1.9], 40, ['zapp_desk'], { pathId: 'lane_zapp' });
  const zappDesk = actor('zapp_desk', [0.25, 0, -0.52], 0, ['coin_front', 'zapp_flee', 'center_stage'], { pathId: 'lane_zapp', postures: ['stand', 'crouch'] });
  const zappFlee = actor('zapp_flee', [-1.5, 0, 0.75], 0, ['center_stage'], { pathId: 'lane_zapp', postures: ['stand', 'crouch'] });
  const kiraDesk = actor('kira_desk', [1.3, 0, -0.35], -50, ['kira_safe', 'center_stage'], { pathId: 'lane_kira', postures: ['stand', 'sit'] });
  const kiraSafe = actor('kira_safe', [2.5, 0, 0.6], 20, ['center_stage'], { pathId: 'lane_kira' });
  const center = actor('center_stage', [0, 0, 0.5], 0, ['zapp_flee'], { pathId: 'lane_center' });
  const coinFront = actor('coin_front', [-1.5, 0, -0.3], 0, ['zapp_flee'], { pathId: 'lane_zapp', postures: ['stand', 'crouch', 'prone'], hazard: { kind: 'impact_zone', radius: 0.6, note: 'giant coin tips onto this spot' } });
  return [
    zappEnter, zappDesk, zappFlee, kiraDesk, kiraSafe, center, coinFront,
    alias('zapp_impact', coinFront, { sourceRef: 'catalog: Visual Comedy impact spot = manifest.marks.coin_front' }),
    propMark('button_desk', [0, 0, 0], 'manifest.anchors.hero_desk_spot (desk carrying the button)'),
    propMark('coin_spawn', [-1.7, 0, -1.2], 'manifest.anchors.coin_floor', { hazard: { kind: 'falling_object', radius: 1.6, note: 'coin grows up to ~16.7x here' } }),
    classroomDoor,
  ];
}

function classroomMarks110(): Mark[] {
  const base = classroomMarks100();
  const get = (id: string) => base.find((m) => m.id === id)!;
  const link = (id: string, extra: string[]) => { const m = get(id); m.reachable = [...m.reachable, ...extra]; };
  link('zapp_enter', ['wp_desk_back_left']); link('kira_desk', ['wp_desk_back_right']); link('center_stage', ['wp_front_left', 'wp_front_right']);
  link('coin_front', ['giant_front', 'watch_left']);
  get('kira_safe').exclusiveWith = ['race_right'];
  const giantFront = actor('giant_front', [-2.0, 0, -0.75], 0, ['dive_end'], { pathId: 'lane_giant', exclusiveWith: ['race_left'], hazard: { kind: 'impact_zone', radius: 0.9, note: 'giant prop lands at giant_spot in front of this mark' } });
  const overlay: Mark[] = [
    alias('enter_back_left', get('zapp_enter')), alias('press_spot', get('zapp_desk')), alias('foil_spot', get('kira_desk')), alias('foil_safe', get('kira_safe')),
    actor('watch_right', [1.15, 0, -1.0], -40, ['wp_desk_back_right'], { pathId: 'lane_kira' }),
    giantFront,
    actor('dive_end', [-2.0, 0, 0.3], 0, ['wp_front_left'], { pathId: 'lane_giant', postures: ['stand', 'prone'] }),
    actor('race_left', [-2.1, 0, -1.25], 70, ['giant_front', 'watch_left'], { pathId: 'lane_race', exclusiveWith: ['giant_front'] }),
    actor('race_right', [2.4, 0, 0.9], -100, ['wp_front_right'], { pathId: 'lane_race', exclusiveWith: ['kira_safe'] }),
    waypoint('wp_desk_back_left', [-0.6, 0, -0.85], -110, ['press_left', 'smart_wait', 'watch_left']),
    waypoint('wp_desk_back_right', [0.95, 0, -0.9], -60, ['zapp_desk', 'watch_right']),
    waypoint('wp_front_left', [-0.95, 0, 0.75], 0, ['zapp_flee', 'dive_end']),
    waypoint('wp_front_right', [0.95, 0, 0.75], 0, ['observe_safe', 'race_right', 'kira_safe']),
    actor('press_left', [-0.45, 0, -0.52], 0, ['zapp_desk'], { exclusiveWith: ['smart_wait'] }),
    actor('watch_left', [-1.25, 0, -0.95], 50, ['coin_front']),
    actor('observe_safe', [1.15, 0, 0.45], -60, ['wp_front_right']),
    actor('smart_wait', [-0.55, 0, -0.95], 60, ['wp_desk_back_left'], { exclusiveWith: ['press_left'] }),
  ];
  return [...base, ...overlay];
}

function classroomMarks120(): Mark[] {
  const marks = classroomMarks110().filter((m) => m.id !== 'classroom_door');
  const entry = actor('classroom_door_inside', [2.5, 0, -3.0], 0, ['wp_desk_back_right'], {
    pathId: 'lane_classroom_door', sourceRef: 'manifest.marks.classroom_door_inside',
  });
  const threshold = waypoint('classroom_door', [2.5, 0, -3.95], 0, ['classroom_door_inside']);
  threshold.sourceRef = 'producer door threshold: classroom_door';
  const waypointRight = marks.find((m) => m.id === 'wp_desk_back_right')!;
  waypointRight.reachable = [...waypointRight.reachable, 'classroom_door_inside'];
  return [...marks, entry, threshold];
}

function classroomAnchors(v110: boolean): PropAnchor[] {
  const a: PropAnchor[] = [
    { id: 'hero_desk_spot', role: 'prop', categories: ['furniture'], position: [0, 0, 0], rotationDeg: [0, 0, 0], maxSize: [1.1, 0.9, 0.7],
      parentSurface: { kind: 'floor', ref: null, propAnchor: null }, reachZones: [{ markId: 'zapp_desk', radius: 1.0 }, { markId: 'kira_desk', radius: 1.5 }],
      clearance: { radius: 0.6, height: 0.8 }, scaling: { allowed: false, maxScale: 1 }, hazard: { ...NO_HAZARD }, sourceRef: 'manifest.anchors.hero_desk_spot' },
    { id: 'button_spot', role: 'prop', categories: ['device'], position: [-0.1, 0.76, -0.12], rotationDeg: [0, 0, 0], maxSize: [0.4, 0.2, 0.3],
      parentSurface: { kind: 'prop_anchor', ref: 'hero_desk_spot', propAnchor: 'button_spot' }, reachZones: [{ markId: 'zapp_desk', radius: 0.8 }],
      clearance: { radius: 0.2, height: 0.3 }, scaling: { allowed: false, maxScale: 1 }, hazard: { ...NO_HAZARD }, sourceRef: 'props/student_desk@1.0.0 anchors.button_spot' },
    { id: 'coin_floor', role: 'prop', categories: ['collectible'], position: [-1.7, 0, -1.2], rotationDeg: [0, 0, 0], maxSize: [0.2, 0.05, 0.2],
      parentSurface: { kind: 'floor', ref: null, propAnchor: null }, reachZones: [{ markId: 'coin_front', radius: 1.0 }],
      clearance: { radius: 1.6, height: 3.2 }, scaling: { allowed: true, maxScale: 30 }, hazard: { kind: 'falling_object', radius: 1.6, note: 'grown coin tips toward coin_front' }, sourceRef: 'manifest.anchors.coin_floor' },
    { id: 'board_center', role: 'look_target', categories: [], position: [0, 2.0, -3.92], rotationDeg: [0, 0, 0], maxSize: [3.3, 1.35, 0],
      parentSurface: { kind: 'wall', ref: null, propAnchor: null }, reachZones: [], clearance: { radius: 0, height: 0 }, scaling: { allowed: false, maxScale: 1 }, hazard: { ...NO_HAZARD }, sourceRef: 'manifest.anchors.board_center' },
    { id: 'zapp_look_up', role: 'look_target', categories: [], position: [-1.6, 3.0, -0.8], rotationDeg: [0, 0, 0], maxSize: [0, 0, 0],
      parentSurface: { kind: 'none', ref: null, propAnchor: null }, reachZones: [], clearance: { radius: 0, height: 0 }, scaling: { allowed: false, maxScale: 1 }, hazard: { ...NO_HAZARD }, sourceRef: 'manifest.anchors.zapp_look_up' },
  ];
  if (v110) a.push(
    { id: 'look_up_point', role: 'look_target', categories: [], position: [-2.1, 3.0, -1.5], rotationDeg: [0, 0, 0], maxSize: [0, 0, 0],
      parentSurface: { kind: 'none', ref: null, propAnchor: null }, reachZones: [], clearance: { radius: 0, height: 0 }, scaling: { allowed: false, maxScale: 1 }, hazard: { ...NO_HAZARD }, sourceRef: 'manifest.anchors.look_up_point' },
    { id: 'giant_spot', role: 'prop', categories: ['collectible', 'giant_prop'], position: [-2.2, 0, -1.8], rotationDeg: [0, 0, 0], maxSize: [1.2, 1.2, 1.2],
      parentSurface: { kind: 'floor', ref: null, propAnchor: null }, reachZones: [{ markId: 'giant_front', radius: 1.3 }],
      clearance: { radius: 0.9, height: 3.4 }, scaling: { allowed: true, maxScale: 30 }, hazard: { kind: 'impact_zone', radius: 0.9, note: 'landing zone cleared in 1.1.0' }, sourceRef: 'manifest.anchors.giant_spot' },
  );
  return a;
}

const CLOSE_INTENTS: ShotIntent[] = ['prop_ecu', 'over_shoulder', 'low_angle_reveal', 'top_down_insert', 'reaction_punch_in', 'chase_cam'];
const cameraZones = (): EnvironmentProfile['cameraZones'] => ({
  // manifest cameraSafe box [-4.3,0.15,-3.6]..[4.3,4.0,14.0], split at z=0.9 into a stage-side close band and the audience side
  safeVolumes: [
    { id: 'audience_side', min: [-4.3, 0.15, 0.9], max: [4.3, 4.0, 14.0], allowedIntents: SHOT_INTENTS.filter((i) => i !== 'top_down_insert'), elevatedAllowed: true, topDownAllowed: false, maxCastFraming: 3 },
    { id: 'stage_close', min: [-4.3, 0.15, -3.6], max: [4.3, 4.0, 0.9], allowedIntents: CLOSE_INTENTS, elevatedAllowed: true, topDownAllowed: true, maxCastFraming: 2 },
  ],
  exclusionVolumes: [
    { id: 'hero_desk_body', min: [-0.55, 0, -0.36], max: [0.55, 0.9, 0.36], reason: 'lens inside the hero desk' },
    { id: 'teacher_desk', min: [-3.55, 0, -3.3], max: [-1.85, 0.84, -2.5], reason: 'lens inside the teacher desk' },
    { id: 'shelf', min: [4.18, 0, 0.3], max: [4.6, 1.3, 2.1], reason: 'lens inside the shelf' },
  ],
  ceilingY: 4.2,
  minWallClearance: 0.3,
  openSides: ['+z'],
  axis: { stageLineA: [-3, 0, 0.4], stageLineB: [3, 0, 0.4], audienceSide: '+z', screenRight: '+x', audienceSideOnly: true },
  lensCorridors: [
    { id: 'center_push_in', from: [0, 1.4, 8.0], to: [0, 1.2, 2.0], radius: 0.4, intents: ['frontal_medium', 'reaction_punch_in'] },
    { id: 'desk_insert_drop', from: [0, 3.2, 0.8], to: [0, 2.2, 0.4], radius: 0.3, intents: ['top_down_insert'] },
  ],
});

const MORNING = { sunDir: [-0.72, 0.78, 0.42] as V3, sunColor: '#fff1d9', sunIntensity: 2.1, sky: '#c9dcf2', ground: '#b08a62', ambientIntensity: 0.62, fog: '#e7eef2', fogNear: 18, fogFar: 45, exposure: 1.05 };
const COLLIDERS_COMMON = ['floor', 'wall_back', 'wall_left', 'wall_right', 'teacher_desk_top', 'teacher_desk_body', 'bg_desk_1_top', 'bg_desk_1_apron', 'bg_desk_2_top', 'bg_desk_2_apron', 'bg_desk_3_top', 'bg_desk_3_apron', 'bg_desk_4_top', 'bg_desk_4_apron', 'bg_desk_legs_1', 'bg_desk_legs_2', 'bg_desk_legs_3', 'bg_desk_legs_4'];

function classroom(version: '1.0.0' | '1.1.0' | '1.2.0', sha: string, colliders: string[]): EnvironmentProfile {
  const key = `environments/classroom@${version}`;
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION, id: 'classroom', version, displayName: 'Classroom 1A', status: 'locked',
    asset: { key, sha256: sha, source: 'assets/asset-lock.json' },
    geometryVersion: version,
    coordinateSystem: { units: 'meters', up: '+y', stageRight: '+x', towardAudience: '+z', handedness: 'right' },
    scale: { metersPerUnit: 1, actorReferenceHeight: 1.6 },
    bounds: { min: [-4.6, 0, -4.1], max: [4.6, 4.2, 4.0] },
    lighting: { presetId: 'morning', params: { ...MORNING, sunDir: [...MORNING.sunDir] } },
    marks: version === '1.0.0' ? classroomMarks100() : version === '1.1.0' ? classroomMarks110() : classroomMarks120(),
    anchors: classroomAnchors(version !== '1.0.0'),
    cameraZones: cameraZones(),
    collision: { source: 'environment_manifest_pieces', assetKey: key, assetSha256: sha, filter: 'collide=true', colliderIds: colliders },
    captionSafe: { actionSafe: { left: 0.06, right: 0.86, top: 0.1, bottom: 0.8 }, captionBand: { top: 0.8, bottom: 0.94 }, avoidBusyBackgroundBehindCaptions: true },
    cast: { min: 1, max: 3 },
    storyPatterns: version === '1.0.0' ? ['escalation_backfire'] : ['escalation_backfire', 'ordinary_object_extreme', 'visible_secret_chase', 'apparent_win_instant_loss', 'noob_vs_smart'],
    supportedActions: [...ACTIONS],
    license: { source: 'original-procedural', author: 'RBLX SPARK (in-house)', license: 'Proprietary - owned', attributionRequired: false, notes: 'All posters, chalk doodles and textures are procedurally drawn in-house.' },
    provenance: { origin: 'in_house_procedural', derivedFrom: [key], author: 'RBLX SPARK (in-house)', notes: version === '1.0.0' ? 'Pinned by the Visual Comedy PoC (free-coins-loop-001); values copied unchanged.' : version === '1.1.0' ? 'Staging overlay: 1.0.0 marks plus role-neutral marks/waypoints and giant_spot.' : 'New immutable version preserving 1.1.0 marks and room semantics while adding the S6 traversable doorway.' },
  };
}

const HALL_DAY = { sunDir: [-0.45, 0.86, 0.35] as V3, sunColor: '#fff4d8', sunIntensity: 1.85, sky: '#c8deea', ground: '#9d8b73', ambientIntensity: 0.72, fog: '#e5edf0', fogNear: 24, fogFar: 58, exposure: 1.02 };
const PLAYGROUND_DAY = { sunDir: [-0.58, 0.8, 0.25] as V3, sunColor: '#fff1cf', sunIntensity: 2.2, sky: '#8ecaf0', ground: '#77a765', ambientIntensity: 0.7, fog: '#d9eef7', fogNear: 28, fogFar: 70, exposure: 1.0 };
const OWNED_LICENSE = { source: 'original-procedural', author: 'RBLX SPARK (in-house)', license: 'Proprietary - owned', attributionRequired: false, notes: 'Original primitive geometry and procedural dressing authored in-house; no Roblox or copied map assets.' } as const;

function lookAnchor(id: string, position: V3, sourceRef: string): PropAnchor {
  return {
    id, role: 'look_target', categories: [], position, rotationDeg: [0, 0, 0], maxSize: [0, 0, 0],
    parentSurface: { kind: 'none', ref: null, propAnchor: null }, reachZones: [], clearance: { radius: 0, height: 0 },
    scaling: { allowed: false, maxScale: 1 }, hazard: { ...NO_HAZARD }, sourceRef,
  };
}

function hallwayMarks(): Mark[] {
  const center = actor('hall_center', [0, 0, 0], 0, ['lockers', 'hall_door_inside', 'notice_board', 'water_fountain', 'hall_end'], { pathId: 'hall_main' });
  return [
    center,
    actor('lockers', [-3.25, 0, 1.2], -90, ['hall_center'], { pathId: 'hall_locker_lane', postures: ['stand', 'crouch'] }),
    actor('hall_door_inside', [0, 0, -7.0], 0, ['hall_center', 'hall_door'], { pathId: 'hall_main' }),
    actor('notice_board', [3.25, 0, 6.25], 90, ['hall_center'], { pathId: 'hall_right_lane' }),
    actor('water_fountain', [3.25, 0, -2.3], 90, ['hall_center'], { pathId: 'hall_right_lane', postures: ['stand', 'crouch'] }),
    actor('hall_end', [0, 0, 5.8], 180, ['hall_center'], { pathId: 'hall_main' }),
    waypoint('hall_door', [0, 0, -8.05], 0, ['hall_door_inside']),
  ];
}

function hallwayProfile(): EnvironmentProfile {
  const key = 'environments/school_hallway@1.0.0';
  const sha = '6721e7b0915456db52a8e9c77889eb80228d2d6d037eb7bc80de113fee4909ae';
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION, id: 'school_hallway', version: '1.0.0', displayName: 'North School Hall', status: 'locked',
    asset: { key, sha256: sha, source: 'assets/asset-lock.json' }, geometryVersion: '1.0.0',
    coordinateSystem: { units: 'meters', up: '+y', stageRight: '+x', towardAudience: '+z', handedness: 'right' },
    scale: { metersPerUnit: 1, actorReferenceHeight: 1.6 }, bounds: { min: [-4.6, 0, -8.2], max: [4.6, 4.2, 8.2] },
    lighting: { presetId: 'day', params: { ...HALL_DAY, sunDir: [...HALL_DAY.sunDir] } }, marks: hallwayMarks(),
    anchors: [lookAnchor('locker_focus', [-3.95, 1.15, 1.2], 'manifest.anchors.locker_focus'), lookAnchor('trophy_case_focus', [4.0, 1.4, 3.7], 'manifest.anchors.trophy_case_focus')],
    cameraZones: {
      safeVolumes: [{ id: 'hall_long_axis', min: [-4.0, 0.2, -7.6], max: [4.0, 3.95, 7.6], allowedIntents: [...SHOT_INTENTS], elevatedAllowed: true, topDownAllowed: true, maxCastFraming: 4 }],
      exclusionVolumes: [
        { id: 'locker_bank', min: [-4.5, 0, -6.0], max: [-3.9, 2.0, 6.0], reason: 'lens inside the locker bank' },
        { id: 'trophy_case_body', min: [3.95, 0.25, 2.4], max: [4.5, 2.05, 5.0], reason: 'lens inside the trophy case' },
      ],
      ceilingY: 4.1, minWallClearance: 0.35, openSides: [],
      axis: { stageLineA: [-3.2, 0, 0], stageLineB: [3.2, 0, 0], audienceSide: '+z', screenRight: '+x', audienceSideOnly: false },
      lensCorridors: [{ id: 'hall_tracking_lane', from: [0, 1.7, 6.5], to: [0, 1.4, -5.8], radius: 0.5, intents: ['frontal_medium', 'two_shot', 'chase_cam', 'wide_environment'] }],
    },
    collision: { source: 'environment_manifest_pieces', assetKey: key, assetSha256: sha, filter: 'collide=true', colliderIds: [
      'floor', 'wall_left', 'wall_right', 'wall_back_left', 'wall_back_right', 'wall_back_lintel', 'wall_front', 'water_fountain', 'trophy_case',
      ...Array.from({ length: 10 }, (_, i) => `locker_${i + 1}`), 'hall_plant_pot',
    ] },
    captionSafe: { actionSafe: { left: 0.06, right: 0.86, top: 0.1, bottom: 0.8 }, captionBand: { top: 0.8, bottom: 0.94 }, avoidBusyBackgroundBehindCaptions: true },
    cast: { min: 1, max: 4 }, storyPatterns: ['visible_secret_chase', 'noob_vs_smart', 'apparent_win_instant_loss'], supportedActions: [...ACTIONS],
    license: { ...OWNED_LICENSE }, provenance: { origin: 'in_house_procedural', derivedFrom: [key], author: 'RBLX SPARK (in-house)', notes: 'Original S2 corridor assembled from authored primitives and deterministic repeated locker modules.' },
  };
}

function playgroundMarks(): Mark[] {
  return [
    actor('play_center', [0, 0, 0.9], 0, ['slide', 'swings', 'bench', 'playground_path'], { pathId: 'play_main' }),
    actor('slide', [-1.6, 0, 1.8], -90, ['play_center'], { pathId: 'play_slide', postures: ['stand', 'crouch'] }),
    actor('swings', [2.5, 0, -0.55], 180, ['play_center'], { pathId: 'play_swings', postures: ['stand', 'sit'] }),
    propMark('sandpit', [3.0, 0, 3.55], 'manifest.marks.sandpit', { facingDeg: 180 }),
    actor('bench', [-3.5, 0, 4.3], -90, ['play_center'], { pathId: 'play_bench', postures: ['stand', 'sit'] }),
    actor('playground_path', [0, 0, 5.5], 180, ['play_center'], { pathId: 'play_main' }),
  ];
}

function playgroundProfile(): EnvironmentProfile {
  const key = 'environments/playground@1.0.0';
  const sha = 'e68619ae3410bf713d3afe0d75b968c65b126d3ec44efe33f2b71668c418b86c';
  const colliders = [
    'ground', 'slide_platform', 'slide_post_1', 'slide_post_2', 'slide_post_3', 'slide_post_4', 'slide_ladder_left', 'slide_ladder_right',
    'swing_top_bar', 'swing_post_left', 'swing_post_right', 'swing_seat_1', 'swing_seat_2',
    'sandpit_edge_left', 'sandpit_edge_right', 'sandpit_edge_back', 'sandpit_edge_front', 'bench_seat', 'bench_back', 'bench_legs',
    'fence_back_left', 'fence_back_right', 'fence_left', 'fence_right', 'tree_trunk_1', 'tree_trunk_2', 'tree_trunk_3',
  ];
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION, id: 'playground', version: '1.0.0', displayName: 'Spark School Playground', status: 'locked',
    asset: { key, sha256: sha, source: 'assets/asset-lock.json' }, geometryVersion: '1.0.0',
    coordinateSystem: { units: 'meters', up: '+y', stageRight: '+x', towardAudience: '+z', handedness: 'right' },
    scale: { metersPerUnit: 1, actorReferenceHeight: 1.6 }, bounds: { min: [-8, 0, -7], max: [8, 5, 8] },
    lighting: { presetId: 'day', params: { ...PLAYGROUND_DAY, sunDir: [...PLAYGROUND_DAY.sunDir] } }, marks: playgroundMarks(),
    anchors: [
      lookAnchor('slide_focus', [-3.0, 1.1, 0.5], 'manifest.anchors.slide_focus'),
      lookAnchor('swing_focus', [2.5, 1.7, -1.8], 'manifest.anchors.swing_focus'),
      lookAnchor('sandpit_center', [3.0, 0.08, 3.55], 'manifest.anchors.sandpit_center'),
    ],
    cameraZones: {
      safeVolumes: [{ id: 'playground_open', min: [-7.4, 0.2, -6.4], max: [7.4, 4.5, 7.4], allowedIntents: [...SHOT_INTENTS], elevatedAllowed: true, topDownAllowed: true, maxCastFraming: 5 }],
      exclusionVolumes: [
        { id: 'slide_structure', min: [-3.8, 0, -2.2], max: [-2.2, 2.25, 3.1], reason: 'lens inside slide structure' },
        { id: 'swing_structure', min: [0.55, 0, -2.15], max: [4.45, 3.1, -1.4], reason: 'lens inside swing frame' },
      ],
      ceilingY: 4.8, minWallClearance: 0.25, openSides: ['+x', '-x', '+z', '-z'],
      axis: { stageLineA: [-5.5, 0, 0.8], stageLineB: [5.5, 0, 0.8], audienceSide: '+z', screenRight: '+x', audienceSideOnly: false },
      lensCorridors: [{ id: 'playground_establishing', from: [0, 2.2, 6.6], to: [0, 1.5, 1.0], radius: 0.6, intents: ['wide_environment', 'frontal_medium', 'two_shot'] }],
    },
    collision: { source: 'environment_manifest_pieces', assetKey: key, assetSha256: sha, filter: 'collide=true', colliderIds: colliders },
    captionSafe: { actionSafe: { left: 0.06, right: 0.86, top: 0.1, bottom: 0.8 }, captionBand: { top: 0.8, bottom: 0.94 }, avoidBusyBackgroundBehindCaptions: true },
    cast: { min: 1, max: 5 }, storyPatterns: ['visible_secret_chase', 'noob_vs_smart', 'ordinary_object_extreme'], supportedActions: [...ACTIONS],
    license: { ...OWNED_LICENSE }, provenance: { origin: 'in_house_procedural', derivedFrom: [key], author: 'RBLX SPARK (in-house)', notes: 'Original S2 playground assembled from authored primitives and deterministic repeated ladder/tree modules.' },
  };
}

export const CLASSROOM_1_0_0 = classroom('1.0.0', '867964e30cc6b1d8ba3efd58e0486d57d679ef15c941fb7b30ed613ae90568d4',
  [...COLLIDERS_COMMON, 'bg_chair_1_seat', 'bg_chair_1_back', 'bg_chair_2_seat', 'bg_chair_2_back', 'bg_chair_legs_1', 'bg_chair_legs_2', 'shelf', 'plant_pot']);
export const CLASSROOM_1_1_0 = classroom('1.1.0', 'cd1e3b6fd24acacd2ec0f417b6b13dd8cce7b0640418d61568737af3b06f2a90',
  [...COLLIDERS_COMMON, 'bg_chair_2_seat', 'bg_chair_2_back', 'bg_chair_legs_2', 'shelf', 'plant_pot']);
export const CLASSROOM_1_2_0 = classroom('1.2.0', 'c3ba63a7848306d635bfea9e15ef2001a7549db05cd36029db9eb387e51f71b6', [
  'floor', 'wall_back_left', 'wall_back_right', 'wall_back_lintel', 'wall_left', 'wall_right',
  'teacher_desk_top', 'teacher_desk_body', 'bg_desk_1_top', 'bg_desk_1_apron', 'bg_desk_2_top', 'bg_desk_2_apron',
  'bg_desk_3_top', 'bg_desk_3_apron', 'bg_desk_4_top', 'bg_desk_4_apron', 'bg_desk_legs_1', 'bg_desk_legs_2',
  'bg_desk_legs_3', 'bg_desk_legs_4', 'bg_chair_2_seat', 'bg_chair_2_back', 'bg_chair_legs_2', 'shelf', 'plant_pot',
]);
export const SCHOOL_HALLWAY_1_0_0 = hallwayProfile();
export const PLAYGROUND_1_0_0 = playgroundProfile();

/** the built-in catalog; profiles are deep-frozen so nothing can mutate a locked version at runtime */
export const ENVIRONMENT_CATALOG: Catalog = Object.freeze({ profiles: Object.freeze([
  deepFreeze(CLASSROOM_1_0_0), deepFreeze(CLASSROOM_1_1_0), deepFreeze(CLASSROOM_1_2_0),
  deepFreeze(SCHOOL_HALLWAY_1_0_0), deepFreeze(PLAYGROUND_1_0_0),
]), lock: ENVIRONMENT_LOCK });

function deepFreeze<T>(x: T): T {
  if (x && typeof x === 'object') { for (const k of Object.keys(x)) deepFreeze((x as Record<string, unknown>)[k]); Object.freeze(x); }
  return x;
}
