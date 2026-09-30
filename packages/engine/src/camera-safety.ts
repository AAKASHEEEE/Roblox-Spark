// Deterministic camera safety + framing evaluator and safe-shot selector.
//
// Generic engine-level module: it knows about entities, obstacles (AABBs), faces, props and shot intents — nothing
// story-specific. It does NOT render; every metric is an analytic approximation over axis-aligned bounds:
//   • collision: lens safety sphere (r = 0.12 m) vs every obstacle, densely sampled along the camera path;
//   • visibility: five rays per face / hero prop (centre + four corners), occlusion by slab tests;
//   • coverage: a fixed screen grid of primary rays (nearest hit) → foreground clutter and per-entity coverage;
//   • framing: projected head/face/prop/subject rectangles against intent rules;
//   • screen direction: camera side of the action axis vs the previous shot;
//   • portrait readability: intent-specific minimum head heights; required actors are never silently dropped.
// Not wired into any renderer yet; see `selectSafeCamera` for the integration entry point.
import { add, sub, scale, dot, cross, len, norm, clamp, lerp3, DEG, type Vec3 } from './math.ts';

// ───────────────────────────── types ─────────────────────────────

export interface Bounds3 { min: Vec3; max: Vec3 }
export type ObstacleType = 'environment' | 'body' | 'head' | 'hair' | 'prop';
/** oriented box (unit axes) of the true part geometry */
export interface OrientedBox { center: Vec3; axes: [Vec3, Vec3, Vec3]; half: Vec3 }
/**
 * `bounds` (AABB) is always used for lens collision / clearance (conservative). When `oriented` is present, visibility
 * rays and screen coverage use the oriented part box instead: the AABB of a yawed torso or head is up to ~40% larger
 * than the part and falsely occludes the actor's own chin or a neighbour's face.
 */
export interface CameraObstacle {
  entityId: string; type: ObstacleType; bounds: Bounds3; oriented?: OrientedBox;
  /** false: a conservative collision envelope only (lens collision / clearance / path); visibility rays and screen
   *  coverage use the accurate per-part obstacles emitted alongside it */
  occludes?: boolean;
}

/** Optional explicit face anchors; derived from the head obstacle + facing when absent. */
export interface FaceAnchors {
  center: Vec3;
  /** outward face normal (unit) */
  normal: Vec3;
  halfWidth: number;
  halfHeight: number;
  leftEye?: Vec3;
  rightEye?: Vec3;
  mouth?: Vec3;
}

/** Per-entity semantic metadata that the evaluator projects per candidate. */
export interface ProjectedEntity {
  entityId: string;
  kind: 'character' | 'prop' | 'environment';
  /** overrides the union of the entity's obstacles */
  bounds?: Bounds3;
  face?: FaceAnchors;
  /** facing direction (xz); face normal is derived from it when `face` is absent. Default +z. */
  facing?: Vec3;
  /** causal interaction point for prop shots (hand/contact point) */
  interactionPoint?: Vec3;
  /** implied-seated style constraint: nothing below `waistY` may be visible unless occluded */
  waistUpRequired?: boolean;
  waistY?: number;
  /** entity the subject must be framed behind (e.g. a desk); camera must be on that entity's side */
  behindEntityId?: string;
  /**
   * World-space corners of the ORIENTED head (+ hair) part boxes. When present they replace the head/hair AABB for
   * screen-size, crop and in-frame measurement: the world AABB of a yawed block head overstates its projected size by
   * up to ~40%, which both rejects valid close-ups and lets too-small heads pass minimums. Collision/occlusion keep AABBs.
   */
  headCorners?: Vec3[];
  /** identity landmarks of a hero prop (used by `scale_reveal`): emblem face, thickness edge and base contact */
  identity?: PropIdentity;
}

export interface PropIdentity {
  center: Vec3;
  /** unit normal of the identity (emblem) face that must read; the camera may not be behind it */
  frontNormal: Vec3;
  /** emblem / identity landmark (centre of the identity face) */
  emblem: Vec3;
  /** points on the thickness edge (rim); the silhouette is judged from them */
  rim: Vec3[];
  /** base / ground contact that shows the fixed-base relationship */
  base: Vec3;
}

export interface ScreenDirectionActor { id: string; position: Vec3; facing?: Vec3; movement?: Vec3 }
export interface ScreenDirectionState {
  /** action axis A→B; derived from the first two actors when absent */
  axis?: [Vec3, Vec3];
  actors?: ScreenDirectionActor[];
  /** side of the axis the previous shot was on */
  previousCameraSide?: 'left' | 'right';
  /** previous on-screen left→right ordering of actors */
  previousOrdering?: string[];
  /** sign (-1/1) of the previous on-screen movement direction */
  previousMovementScreenX?: number;
  /** previous shot was a neutral (on-axis) establishing shot: geography reset */
  previousWasNeutral?: boolean;
  /** beat explicitly calls for disorientation */
  disorientationIntended?: boolean;
}

/** Normalised screen rect (0..1, v grows downward) reserved for captions. Metadata only — placement is not owned here. */
export interface ScreenRegion { x0: number; y0: number; x1: number; y1: number }

export interface CameraSafetyScene {
  frameWidth: number;
  frameHeight: number;
  /**
   * Shot subjects; the first is the active subject unless `activeSubjectId` is set. Every subject is REQUIRED in the
   * frame unless listed in `optionalSubjectIds` — a required actor is never silently dropped.
   */
  subjectIds: string[];
  /** supporting subjects the beat does not require in the same frame (may be dropped for a readable active shot) */
  optionalSubjectIds?: string[];
  heroPropIds: string[];
  obstacles: CameraObstacle[];
  projectedEntities?: ProjectedEntity[];
  screenDirection?: ScreenDirectionState;
  activeSubjectId?: string;
  captionReservedRegion?: ScreenRegion;
}

export interface CameraTransform { position: Vec3; /** degrees */ roll?: number }

export type CameraIntent = 'wide' | 'medium' | 'close' | 'reaction' | 'prop' | 'over_shoulder' | 'extreme_close'
  /** face read at 25–60° off its normal: normal 80% face visibility, near eye + mouth, eyeline toward `eyelineTargetId` */
  | 'three_quarter_profile'
  /** motivated profile (45–85° off the face normal) for listening/warning beats: near eye, mouth, brow, face area,
   *  no foreign obstruction, eyeline toward `eyelineTargetId`; 60% face visibility. Never applied to other intents. */
  | 'motivated_profile'
  /** giant hero-prop scale reveal: silhouette, emblem, thickness edge, base and a readable scale-reference actor */
  | 'scale_reveal'
  /** speaker coverage over an elevated, side-offset listener shoulder (over_shoulder foreground rules + profile face
   *  rules: near eye, mouth, brow, face area, eyeline to the listener, 80% face visibility); lens above the listener's head */
  | 'offset_elevated_speaker_ots'
  /** intentional neutral-axis prop insert: steep top-down (>= topDownMinPitchDeg), prop rules, no actor in frame; may
   *  reset screen-direction geography for the next shot */
  | 'neutral_top_down_prop_insert'
  /** consequence shot: scale-reveal identity rules from an elevated camera (>= consequenceMinPitchDeg) */
  | 'elevated_consequence';

export interface CameraCandidate {
  id: string;
  transform: CameraTransform;
  target: Vec3;
  /** vertical field of view, degrees */
  fov: number;
  intent: CameraIntent;
  /** camera interpolates start → `motion.to` during the shot (linear); the whole path is checked */
  motion?: { to: CameraTransform; toTarget?: Vec3 };
  activeSubjectId?: string;
  /** characters this composition frames (e.g. both actors of a two-shot); they must be readable like required ones */
  framedSubjectIds?: string[];
  /** OTS: the actor whose shoulder is in the foreground (inferred when absent) */
  foregroundSubjectId?: string;
  /** beat explicitly intends a prop to cover the active face */
  allowPropOverFace?: boolean;
  /** action requires the hero prop / active hand to be visible */
  requiresHeroProp?: boolean;
  disorientationIntended?: boolean;
  /** profile intents: which head-size band applies (never lower than that band's minimum). Default 'close'. */
  profileScale?: 'medium' | 'close';
  /** profile intents: the entity the active subject looks at; its screen side must match the face direction */
  eyelineTargetId?: string;
  /** extra lens positions the camera passes through (e.g. a tracking camera's inter-frame path): collision-checked */
  lensPath?: Vec3[];
  /** scale reveal: actors that must read as the scale reference (default: the required characters) */
  scaleReferenceIds?: string[];
  /** props whose thickness edge (identity rim) must read in this shot (>= 2 rim points in frame and unoccluded) */
  propEdgeIds?: string[];
}

export interface CameraSafetyDiagnostics {
  eyesVisible: Record<string, number>;
  mouthVisible: Record<string, boolean>;
  profile: Record<string, boolean>;
  headScreenHeight: Record<string, number>;
  subjectScreenHeight: Record<string, number>;
  headCropped: Record<string, boolean>;
  entityCoverage: Record<string, number>;
  propScreenSize: Record<string, number>;
  faceOccluders: Record<string, string[]>;
  minHeadDistance: number;
  pathSamples: number;
  cameraSide: 'left' | 'right' | 'neutral' | 'none';
  captionOverlapsActiveFace: boolean;
  /** subjectIds − optionalSubjectIds (+ the active subject) */
  requiredSubjects: string[];
  optionalSubjects: string[];
  /** projected head (incl. hair) height as % of frame height, per required / framed actor */
  requiredHeadHeightPct: Record<string, number>;
  /** head-height minimum applied to the readable actors for this intent (fraction of frame height) */
  minHeadHeight: number;
  /** two-character medium rules applied (≥ 2 required/framed characters) */
  twoShot: boolean;
  subjectsInFrame: string[];
  droppedSubjects: string[];
  droppedOptionalSubjects: string[];
  droppedRequiredSubjects: string[];
  /** a supporting actor was dropped and every dropped actor was optional */
  droppedOnlyOptionalSupport: boolean;
  /** required actors named by at least one rejection reason */
  rejectingRequiredSubjects: string[];
  fallback?: string;
}

export interface CameraSafetyResult {
  accepted: boolean;
  score: number;
  rejectionReasons: string[];
  faceVisibility: Record<string, number>;
  propVisibility: Record<string, number>;
  foregroundCoverage: number;
  lensClearance: number;
  screenDirectionResult: string;
  diagnostics: CameraSafetyDiagnostics;
}

export interface CameraSafetyConfig {
  lensRadius: number;
  /** min lens → head-centre distance for any head in front of the lens (prevents the 0.43–0.86 m failures) */
  minHeadDistance: number;
  /** ECU only, active subject: min lens → head-centre distance (geometry checks still apply) */
  ecuMinHeadDistance: number;
  minFaceVisibility: number;
  ecuMinFaceVisibility: number;
  minHeroPropVisibility: number;
  maxForegroundCoverage: number;
  /** a hit is foreground if nearer than this fraction of the focus distance */
  foregroundDepthRatio: number;
  profileAngleDeg: number;
  safeMargin: { top: number; bottom: number; side: number };
  faceMargin: number;
  /** geography/scale wide: min full-actor height (fraction of frame height); expressions not required. Band 0.10–0.12. */
  minWideSubjectHeight: number;
  /** wide "excessive empty space": subject + hero-prop coverage must reach this × number of subject actors */
  minWideContentCoveragePerActor: number;
  minPropScreenSize: number;
  /** [min, max] projected head height per intent (fraction of frame height); `medium` min is the single-character medium */
  headHeight: Record<CameraIntent, [number, number]>;
  /** two-character medium: every required/framed head must reach this (fraction of frame height) */
  twoShotMinHeadHeight: number;
  pathStep: number;
  grid: number;
  neutralAxisSin: number;
  /** face angle windows (deg off the face normal, horizontal) for the profile intents */
  threeQuarterAngleDeg: [number, number];
  motivatedProfileAngleDeg: [number, number];
  /** motivated profile: minimum five-ray face visibility (centre + near-side corners) */
  profileMinFaceVisibility: number;
  /** profile intents: minimum projected face area (fraction of the frame area) */
  profileMinFaceArea: number;
  /** profile intents: max horizontal angle between the face normal and the direction to the eyeline target */
  eyelineToleranceDeg: number;
  /** scale reveal: min fraction of rim (silhouette) points in frame and unoccluded by other entities */
  scaleRevealMinSilhouette: number;
  /** scale reveal: view angle off the identity-face normal that shows both the emblem and the thickness edge */
  scaleRevealViewAngleDeg: [number, number];
  /** offset_elevated_speaker_ots: allowed angle off the speaker's face normal */
  speakerOtsAngleDeg: [number, number];
  /** neutral_top_down_prop_insert: minimum downward camera pitch */
  topDownMinPitchDeg: number;
  /** elevated_consequence: minimum downward camera pitch */
  consequenceMinPitchDeg: number;
}

export const CAMERA_SAFETY_DEFAULTS: CameraSafetyConfig = {
  lensRadius: 0.12,
  minHeadDistance: 0.9,
  ecuMinHeadDistance: 0.3,
  minFaceVisibility: 0.8,
  ecuMinFaceVisibility: 0.6,
  minHeroPropVisibility: 0.6,
  maxForegroundCoverage: 0.35,
  foregroundDepthRatio: 0.6,
  profileAngleDeg: 55,
  safeMargin: { top: 0.03, bottom: 0.02, side: 0.02 },
  faceMargin: 0.04,
  minWideSubjectHeight: 0.12,
  // calibrated so an actor at the wide minimum height is never rejected as "empty" (≈0.8% coverage at 12%)
  minWideContentCoveragePerActor: 0.005,
  minPropScreenSize: 0.2,
  // projected head height as a fraction of frame height, per intent (portrait readability)
  headHeight: {
    wide: [0, 0.2], medium: [0.18, 0.32], close: [0.26, 0.7], reaction: [0.26, 0.7],
    prop: [0, 10], over_shoulder: [0.08, 0.45], extreme_close: [0.35, 10],
    // profile intents resolve to headHeight[profileScale] (medium or close) at evaluation; listed for completeness
    three_quarter_profile: [0.26, 0.7], motivated_profile: [0.26, 0.7], scale_reveal: [0, 10],
    offset_elevated_speaker_ots: [0.26, 0.7], neutral_top_down_prop_insert: [0, 10], elevated_consequence: [0, 10],
  },
  twoShotMinHeadHeight: 0.14,
  pathStep: 0.05,
  grid: 24,
  neutralAxisSin: 0.2,
  threeQuarterAngleDeg: [15, 60],
  // lower bound 30 deg: the 60% visibility relaxation can only come from far-side rays turned away from the lens
  // (any foreign occluder is rejected outright), never from an occluded near-frontal face
  motivatedProfileAngleDeg: [30, 88],
  profileMinFaceVisibility: 0.6,
  profileMinFaceArea: 0.01,
  // half-angle of the gaze cone: a head shake / nod oscillates around the look target
  eyelineToleranceDeg: 45,
  scaleRevealMinSilhouette: 0.75,
  scaleRevealViewAngleDeg: [15, 78],
  // upper bound = the motivated-profile bound family: beyond ~75 deg readability is decided by the near-eye / mouth /
  // brow / face-area / no-obstruction checks that this intent always applies
  speakerOtsAngleDeg: [0, 85],
  topDownMinPitchDeg: 50,
  consequenceMinPitchDeg: 20,
};

// ───────────────────────────── geometry ─────────────────────────────

const NEAR = 0.05;
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
const UP: Vec3 = [0, 1, 0];

export function unionBounds(list: Bounds3[]): Bounds3 | undefined {
  if (!list.length) return undefined;
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const b of list) for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], b.min[i]); max[i] = Math.max(max[i], b.max[i]); }
  return { min, max };
}
const centerOf = (b: Bounds3): Vec3 => scale(add(b.min, b.max), 0.5);
const halfOf = (b: Bounds3): Vec3 => scale(sub(b.max, b.min), 0.5);
const corners = (b: Bounds3): Vec3[] => {
  const out: Vec3[] = [];
  for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) out.push([x, y, z]);
  return out;
};

/** Euclidean distance from a point to an AABB (0 when inside). */
export function pointBoxDistance(p: Vec3, b: Bounds3): number {
  let s = 0;
  for (let i = 0; i < 3; i++) { const d = p[i] < b.min[i] ? b.min[i] - p[i] : p[i] > b.max[i] ? p[i] - b.max[i] : 0; s += d * d; }
  return Math.sqrt(s);
}

/** Slab test. Returns [tEnter, tExit] along o + t·d, or null. */
function rayBox(o: Vec3, d: Vec3, b: Bounds3): [number, number] | null {
  let t0 = -Infinity, t1 = Infinity;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-12) { if (o[i] < b.min[i] || o[i] > b.max[i]) return null; continue; }
    let a = (b.min[i] - o[i]) / d[i], c = (b.max[i] - o[i]) / d[i];
    if (a > c) [a, c] = [c, a];
    if (a > t0) t0 = a;
    if (c < t1) t1 = c;
    if (t0 > t1) return null;
  }
  return [t0, t1];
}

interface Cam { pos: Vec3; f: Vec3; r: Vec3; u: Vec3; tanH: number; tanV: number }
function makeCam(pos: Vec3, target: Vec3, fovDeg: number, rollDeg: number, aspect: number): Cam {
  const f = norm(sub(target, pos));
  let r = cross(f, UP);
  if (len(r) < 1e-6) r = [1, 0, 0];
  r = norm(r);
  let u = cross(r, f);
  const a = (rollDeg || 0) * DEG;
  if (a) { const c = Math.cos(a), s = Math.sin(a); const r2 = add(scale(r, c), scale(u, s)); u = add(scale(u, c), scale(r, -s)); r = r2; }
  const tanV = Math.tan((fovDeg * DEG) / 2);
  return { pos, f, r, u, tanV, tanH: tanV * aspect };
}
interface Proj { x: number; y: number; z: number }
/** normalised screen coords: x 0..1 left→right, y 0..1 top→bottom, z view depth */
function project(c: Cam, p: Vec3): Proj {
  const d = sub(p, c.pos), z = dot(d, c.f);
  if (z <= NEAR) return { x: NaN, y: NaN, z };
  return { x: 0.5 + (dot(d, c.r) / (z * c.tanH)) / 2, y: 0.5 - (dot(d, c.u) / (z * c.tanV)) / 2, z };
}
const inFrame = (p: Proj, m = 0) => p.z > NEAR && p.x >= m && p.x <= 1 - m && p.y >= m && p.y <= 1 - m;
interface Rect { x0: number; y0: number; x1: number; y1: number; behind: boolean }
/** Screen rect of a box's visible part. Boxes straddling the near plane are clipped edge-by-edge (not guessed). */
function projectBox(c: Cam, b: Bounds3): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, behind = false;
  const cs = corners(b), zc = NEAR * 1.01;
  const depth = (p: Vec3) => dot(sub(p, c.pos), c.f);
  const pts: Vec3[] = [];
  for (const p of cs) { if (depth(p) > zc) pts.push(p); else behind = true; }
  if (behind) {
    for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) {
      const a = cs[i], e = cs[j];
      if ((a[0] !== e[0] ? 1 : 0) + (a[1] !== e[1] ? 1 : 0) + (a[2] !== e[2] ? 1 : 0) !== 1) continue; // not a box edge
      const da = depth(a) - zc, de = depth(e) - zc;
      if (da > 0 === de > 0) continue;
      pts.push(lerp3(a, e, da / (da - de)));
    }
  }
  for (const p of pts) {
    const q = project(c, p);
    if (!(q.z > NEAR)) continue;
    x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y);
  }
  return { x0, y0, x1, y1, behind };
}
const clip01 = (v: number) => clamp(v, 0, 1);
/** screen rect of explicit world points (points behind the lens flag `behind`) */
function projectPts(c: Cam, pts: Vec3[]): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, behind = false;
  for (const p of pts) {
    const q = project(c, p);
    if (!(q.z > NEAR)) { behind = true; continue; }
    x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y);
  }
  return { x0, y0, x1, y1, behind };
}
const insideBox = (b: Bounds3, p: Vec3, e = 1e-6) => p[0] >= b.min[0] - e && p[0] <= b.max[0] + e && p[1] >= b.min[1] - e && p[1] <= b.max[1] + e && p[2] >= b.min[2] - e && p[2] <= b.max[2] + e;
const PROFILE_INTENTS = new Set<CameraIntent>(['three_quarter_profile', 'motivated_profile', 'offset_elevated_speaker_ots']);
/** explicit pattern intents evaluated with a base intent's rules plus their own extra checks */
const INTENT_BASE: Partial<Record<CameraIntent, CameraIntent>> = { offset_elevated_speaker_ots: 'over_shoulder', neutral_top_down_prop_insert: 'prop', elevated_consequence: 'scale_reveal' };
export const baseIntent = (i: CameraIntent): CameraIntent => INTENT_BASE[i] ?? i;
const overlapsFrame = (r: Rect) => isFinite(r.x0) && r.x1 > 0 && r.x0 < 1 && r.y1 > 0 && r.y0 < 1;
const clippedHeight = (r: Rect) => (overlapsFrame(r) ? Math.max(0, clip01(r.y1) - clip01(r.y0)) : 0);
const clippedWidth = (r: Rect) => (overlapsFrame(r) ? Math.max(0, clip01(r.x1) - clip01(r.x0)) : 0);

/** Project a world point for a candidate's first frame: x 0..1 left→right, y 0..1 top→bottom, z view depth (NaN x/y if behind). */
export function projectToScreen(cand: CameraCandidate, p: Vec3, aspect: number): { x: number; y: number; z: number } {
  return project(makeCam(cand.transform.position, cand.target, cand.fov, cand.transform.roll ?? 0, aspect), p);
}

// ───────────────────────────── scene index ─────────────────────────────

interface FaceFrame { entityId: string; center: Vec3; normal: Vec3; right: Vec3; up: Vec3; samples: Vec3[]; eyes: [Vec3, Vec3]; mouth: Vec3; head: Bounds3; headTop: Bounds3; corners?: Vec3[] }
interface SceneIndex {
  scene: CameraSafetyScene;
  meta: Map<string, ProjectedEntity>;
  bounds: Map<string, Bounds3>;
  kind: Map<string, 'character' | 'prop' | 'environment'>;
  faces: Map<string, FaceFrame>;
  active: string | undefined;
  aspect: number;
}

function indexScene(scene: CameraSafetyScene): SceneIndex {
  const meta = new Map((scene.projectedEntities ?? []).map((e) => [e.entityId, e] as const));
  const byEntity = new Map<string, CameraObstacle[]>();
  for (const o of scene.obstacles) { const l = byEntity.get(o.entityId) ?? []; l.push(o); byEntity.set(o.entityId, l); }
  const ids = [...new Set([...byEntity.keys(), ...meta.keys()])].sort();
  const bounds = new Map<string, Bounds3>(), kind = new Map<string, 'character' | 'prop' | 'environment'>(), faces = new Map<string, FaceFrame>();
  for (const id of ids) {
    const obs = byEntity.get(id) ?? [], m = meta.get(id);
    const b = m?.bounds ?? unionBounds(obs.map((o) => o.bounds));
    if (b) bounds.set(id, b);
    const k = m?.kind ?? (obs.some((o) => o.type === 'head' || o.type === 'body' || o.type === 'hair') ? 'character' : obs.some((o) => o.type === 'prop') ? 'prop' : 'environment');
    kind.set(id, k);
    const head = unionBounds(obs.filter((o) => o.type === 'head').map((o) => o.bounds));
    if (k === 'character' && (head || m?.face)) {
      const headB = head ?? { min: sub(m!.face!.center, [0.15, 0.15, 0.15]), max: add(m!.face!.center, [0.15, 0.15, 0.15]) };
      const headTop = unionBounds([headB, ...obs.filter((o) => o.type === 'hair').map((o) => o.bounds)])!;
      faces.set(id, faceFrame(id, headB, headTop, m));
    }
  }
  const active = scene.activeSubjectId ?? scene.subjectIds[0];
  return { scene, meta, bounds, kind, faces, active, aspect: scene.frameWidth / scene.frameHeight };
}

function faceFrame(id: string, head: Bounds3, headTop: Bounds3, m?: ProjectedEntity): FaceFrame {
  let center: Vec3, normal: Vec3, hw: number, hh: number;
  if (m?.face) { center = m.face.center; normal = norm(m.face.normal); hw = m.face.halfWidth; hh = m.face.halfHeight; }
  else {
    const fac = m?.facing ?? [0, 0, 1];
    normal = norm([fac[0], 0, fac[2]]);
    const c = centerOf(head), h = halfOf(head);
    const depth = Math.abs(normal[0]) * h[0] + Math.abs(normal[2]) * h[2];
    const lateral = Math.abs(normal[2]) * h[0] + Math.abs(normal[0]) * h[2];
    center = add(c, scale(normal, depth + 0.002));
    hw = 0.6 * lateral; hh = 0.5 * h[1];
  }
  let right = cross(UP, normal); right = len(right) < 1e-6 ? [1, 0, 0] : norm(right);
  const up = norm(cross(normal, right));
  const at = (a: number, b: number): Vec3 => add(center, add(scale(right, a * hw), scale(up, b * hh)));
  const samples = [center, at(-1, 1), at(1, 1), at(-1, -1), at(1, -1)];
  const eyes: [Vec3, Vec3] = [m?.face?.leftEye ?? at(-0.55, 0.45), m?.face?.rightEye ?? at(0.55, 0.45)];
  const mouth = m?.face?.mouth ?? at(0, -0.55);
  return { entityId: id, center, normal, right, up, samples, eyes, mouth, head, headTop, ...(m?.headCorners?.length ? { corners: m.headCorners } : {}) };
}

/** ray / obstacle intersection: oriented part box when available (visibility), else the AABB */
function rayObstacle(o: CameraObstacle, org: Vec3, d: Vec3): [number, number] | null {
  const ob = o.oriented, hb = rayBox(org, d, o.bounds);
  if (!ob || !hb) return hb; // the oriented box lies inside its AABB: an AABB miss is an OBB miss (broad phase)
  const r = sub(org, ob.center);
  const lo: Vec3 = [dot(r, ob.axes[0]), dot(r, ob.axes[1]), dot(r, ob.axes[2])], ld: Vec3 = [dot(d, ob.axes[0]), dot(d, ob.axes[1]), dot(d, ob.axes[2])];
  return rayBox(lo, ld, { min: [-ob.half[0], -ob.half[1], -ob.half[2]], max: [ob.half[0], ob.half[1], ob.half[2]] });
}
function insideObstacle(o: CameraObstacle, p: Vec3): boolean {
  const ob = o.oriented;
  if (!ob) return insideBox(o.bounds, p);
  const r = sub(p, ob.center);
  return [0, 1, 2].every((k) => Math.abs(dot(r, ob.axes[k])) <= ob.half[k] + 1e-6);
}
/** is the segment cam→p blocked by any obstacle not excluded? returns blockers */
function blockers(ix: SceneIndex, from: Vec3, p: Vec3, exclude: (o: CameraObstacle) => boolean): CameraObstacle[] {
  const d = sub(p, from), out: CameraObstacle[] = [];
  for (const o of ix.scene.obstacles) {
    if (o.occludes === false || exclude(o)) continue;
    const h = rayObstacle(o, from, d);
    if (h && h[0] < 1 - 1e-4 && h[1] > 1e-4) out.push(o);
  }
  return out;
}

// ───────────────────────────── screen direction ─────────────────────────────

type Side = 'left' | 'right' | 'neutral' | 'none';
function axisOf(sd?: ScreenDirectionState): [Vec3, Vec3] | undefined {
  if (!sd) return undefined;
  if (sd.axis) return sd.axis;
  const a = sd.actors ?? [];
  return a.length >= 2 ? [a[0].position, a[1].position] : undefined;
}
function sideOf(axis: [Vec3, Vec3] | undefined, p: Vec3, neutralSin: number): Side {
  if (!axis) return 'none';
  const [a, b] = axis;
  const ab: Vec3 = [b[0] - a[0], 0, b[2] - a[2]], mid = scale(add(a, b), 0.5), ap: Vec3 = [p[0] - mid[0], 0, p[2] - mid[2]];
  const l1 = len(ab), l2 = len(ap);
  if (l1 < 1e-6 || l2 < 1e-6) return 'neutral';
  const s = (ab[0] * ap[2] - ab[2] * ap[0]) / (l1 * l2);
  if (Math.abs(s) < neutralSin) return 'neutral';
  return s > 0 ? 'left' : 'right';
}

function evaluateScreenDirection(sd: ScreenDirectionState | undefined, cand: CameraCandidate, startSide: Side, endSide: Side, cam: Cam): { result: string; reject: boolean; penalty: number } {
  if (!sd || startSide === 'none') return { result: 'no_axis', reject: false, penalty: 0 };
  // an intentional top-down prop insert has no actor on screen: it is classified neutral (never a reversal) and resets
  // geography for the next shot; its own rules (steep pitch, no actor in frame) are enforced by the evaluator
  if (cand.intent === 'neutral_top_down_prop_insert') return { result: 'neutral_insert', reject: false, penalty: 0 };
  let penalty = 0, suffix = '';
  // movement direction on screen
  if (sd.previousMovementScreenX && sd.actors) {
    for (const a of sd.actors) if (a.movement && len(a.movement) > 1e-6) {
      const sx = Math.sign(dot(a.movement, cam.r));
      if (sx && sx !== Math.sign(sd.previousMovementScreenX)) { penalty += 0.1; suffix = `;movement_reversed:${a.id}`; }
    }
  }
  const prev = sd.previousCameraSide;
  if (startSide === 'neutral' && endSide === 'neutral') return { result: `neutral${suffix}`, reject: false, penalty };
  const side = endSide === 'neutral' ? startSide : endSide;
  if (!prev) return { result: `established:${side}${suffix}`, reject: false, penalty };
  if (startSide === prev && endSide === prev) return { result: `consistent:${prev}${suffix}`, reject: false, penalty };
  if (startSide === 'neutral' || endSide === 'neutral') {
    // on-axis start or end: a neutral transition
    if (side === prev) return { result: `consistent:${prev}${suffix}`, reject: false, penalty };
    return { result: `crossed_via_neutral:${prev}->${side}${suffix}`, reject: false, penalty: penalty + 0.02 };
  }
  if (startSide === prev && endSide !== prev) return { result: `crossed_on_camera:${prev}->${endSide}${suffix}`, reject: false, penalty };
  if (sd.previousWasNeutral) return { result: `reset_after_neutral:${side}${suffix}`, reject: false, penalty };
  if (sd.disorientationIntended || cand.disorientationIntended) return { result: `crossed_intended_disorientation:${prev}->${side}${suffix}`, reject: false, penalty };
  return { result: `reversed_unmotivated:${prev}->${side}${suffix}`, reject: true, penalty: penalty + 0.5 };
}

/** Which side of the action axis a lens position is on (generic helper for trajectory checks). */
export function cameraAxisSide(sd: ScreenDirectionState | undefined, p: Vec3, cfg: CameraSafetyConfig = CAMERA_SAFETY_DEFAULTS): 'left' | 'right' | 'neutral' | 'none' {
  return sideOf(axisOf(sd), p, cfg.neutralAxisSin);
}

/** State to carry into the next shot after `cand` is chosen. */
export function nextScreenDirectionState(scene: CameraSafetyScene, cand: CameraCandidate, cfg: CameraSafetyConfig = CAMERA_SAFETY_DEFAULTS): ScreenDirectionState | undefined {
  const sd = scene.screenDirection;
  if (!sd) return undefined;
  const axis = axisOf(sd);
  const end = sideOf(axis, (cand.motion?.to ?? cand.transform).position, cfg.neutralAxisSin);
  const aspect = scene.frameWidth / scene.frameHeight;
  const cam = makeCam((cand.motion?.to ?? cand.transform).position, cand.motion?.toTarget ?? cand.target, cand.fov, (cand.motion?.to ?? cand.transform).roll ?? 0, aspect);
  const ordering = (sd.actors ?? []).map((a) => ({ id: a.id, x: project(cam, a.position).x })).filter((a) => isFinite(a.x)).sort((a, b) => a.x - b.x || (a.id < b.id ? -1 : 1)).map((a) => a.id);
  const mover = (sd.actors ?? []).find((a) => a.movement && len(a.movement) > 1e-6);
  const insert = cand.intent === 'neutral_top_down_prop_insert';
  return {
    ...sd,
    previousCameraSide: !insert && (end === 'left' || end === 'right') ? end : sd.previousCameraSide,
    previousWasNeutral: insert || end === 'neutral',
    previousOrdering: ordering,
    previousMovementScreenX: mover ? Math.sign(dot(mover.movement!, cam.r)) || sd.previousMovementScreenX : sd.previousMovementScreenX,
    disorientationIntended: false,
  };
}

// ───────────────────────────── evaluation ─────────────────────────────

/** Required vs optional subjects for a candidate (the active subject is always required). */
function rolesOf(scene: CameraSafetyScene, active: string | undefined): { required: string[]; optional: string[] } {
  const opt = new Set(scene.optionalSubjectIds ?? []);
  const required = [...new Set(scene.subjectIds.filter((id) => !opt.has(id) || id === active))];
  if (active && !required.includes(active)) required.push(active);
  return { required, optional: [...new Set(scene.subjectIds.filter((id) => opt.has(id) && id !== active))] };
}
const pct = (x: number) => Math.round(x * 1000) / 10;

interface SampleEval {
  reasons: string[];
  face: Record<string, number>;
  prop: Record<string, number>;
  fg: number;
  d: Omit<CameraSafetyDiagnostics, 'minHeadDistance' | 'pathSamples' | 'cameraSide' | 'captionOverlapsActiveFace' | 'fallback' | 'rejectingRequiredSubjects'> & { captionOverlap: boolean; minHeadDist: number };
  sizeTerm: number;
}

const FACE_INTENTS = new Set<CameraIntent>(['medium', 'close', 'reaction', 'over_shoulder', 'extreme_close', 'three_quarter_profile', 'motivated_profile']);

function evaluateSample(ix: SceneIndex, cand: CameraCandidate, pos: Vec3, target: Vec3, roll: number, cfg: CameraSafetyConfig): SampleEval {
  const { scene } = ix;
  const cam = makeCam(pos, target, cand.fov, roll, ix.aspect);
  const reasons: string[] = [];
  const intent0 = cand.intent, intent = baseIntent(intent0);
  const active = cand.activeSubjectId ?? ix.active;
  const required = [...new Set(scene.subjectIds)]; // every shot subject (required + optional)
  const roles = rolesOf(scene, active), requiredSet = new Set(roles.required);
  const heroes = [...new Set(scene.heroPropIds)];
  // OTS foreground actor: explicit, or the required character (≠ active) nearest the lens
  let fgActor = cand.foregroundSubjectId;
  if (intent === 'over_shoulder' && !fgActor) {
    fgActor = required.filter((id) => id !== active && ix.faces.has(id)).sort((a, b) => len(sub(ix.faces.get(a)!.center, pos)) - len(sub(ix.faces.get(b)!.center, pos)) || (a < b ? -1 : 1))[0];
    if (!fgActor) reasons.push('OTS_NO_FOREGROUND_SUBJECT');
  }
  const focusIds = new Set<string>(intent === 'prop' ? heroes : intent === 'scale_reveal' ? [...heroes, ...required] : required.filter((id) => id !== fgActor));
  if (intent !== 'prop' && active) focusIds.add(active);

  // ── lens → head distance (the 0.43–0.86 m obstruction class)
  let minHeadDist = Infinity;
  for (const [id, f] of [...ix.faces].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const hc = centerOf(f.head), dist = len(sub(hc, pos));
    minHeadDist = Math.min(minHeadDist, dist);
    if (dot(sub(hc, pos), cam.f) <= 0) continue; // behind the lens
    const limit = intent === 'extreme_close' && id === active ? cfg.ecuMinHeadDistance : cfg.minHeadDistance;
    if (dist < limit) reasons.push(`LENS_TOO_CLOSE_TO_HEAD:${id}:${dist.toFixed(2)}m<${limit}m`);
  }

  // ── faces: five rays each
  const face: Record<string, number> = {}, eyesVisible: Record<string, number> = {}, mouthVisible: Record<string, boolean> = {}, profile: Record<string, boolean> = {};
  const faceOccluders: Record<string, string[]> = {}, headScreenHeight: Record<string, number> = {}, headCropped: Record<string, boolean> = {}, subjectScreenHeight: Record<string, number> = {};
  const headInFrame: Record<string, boolean> = {};
  const pointVisible = (id: string, f: FaceFrame, p: Vec3, occ: Set<string>) => {
    const q = project(cam, p);
    if (!inFrame(q)) return false;
    if (dot(f.normal, norm(sub(pos, p))) <= 0.1) return false; // facing away
    // an actor's own head never occludes its face; an own-BODY box that CONTAINS the face sample is AABB inflation of a
    // yawed torso (the true torso sits below the head), not a surface in front of the face — own limbs in front still block
    const bl = blockers(ix, pos, p, (o) => o.entityId === id && (o.type === 'head' || (o.type === 'body' && insideObstacle(o, p))));
    for (const b of bl) occ.add(`${b.type}:${b.entityId}`);
    return bl.length === 0;
  };
  for (const [id, f] of [...ix.faces].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const occ = new Set<string>();
    face[id] = r6(f.samples.filter((p) => pointVisible(id, f, p, occ)).length / f.samples.length);
    eyesVisible[id] = f.eyes.filter((p) => pointVisible(id, f, p, new Set())).length;
    mouthVisible[id] = pointVisible(id, f, f.mouth, new Set());
    const toCam = norm([pos[0] - f.center[0], 0, pos[2] - f.center[2]]);
    profile[id] = dot(toCam, norm([f.normal[0], 0, f.normal[2]])) < Math.cos(cfg.profileAngleDeg * DEG);
    faceOccluders[id] = [...occ].sort();
    const hr = f.corners ? projectPts(cam, f.corners) : projectBox(cam, f.headTop);
    headInFrame[id] = overlapsFrame(hr);
    headScreenHeight[id] = r6(isFinite(hr.y0) ? hr.y1 - hr.y0 : 0);
    headCropped[id] = hr.behind || !isFinite(hr.y0) || hr.y0 < cfg.safeMargin.top || hr.y1 > 1 - cfg.safeMargin.bottom || hr.x0 < cfg.safeMargin.side || hr.x1 > 1 - cfg.safeMargin.side;
    const sb = ix.bounds.get(id);
    subjectScreenHeight[id] = sb ? r6(clippedHeight(projectBox(cam, sb))) : 0;
  }

  // ── hero props: five rays each
  const prop: Record<string, number> = {}, propScreenSize: Record<string, number> = {};
  for (const id of heroes) {
    const b = ix.bounds.get(id);
    if (!b) { prop[id] = 0; propScreenSize[id] = 0; continue; }
    const c = centerOf(b), h = halfOf(b);
    const er = Math.abs(cam.r[0]) * h[0] + Math.abs(cam.r[1]) * h[1] + Math.abs(cam.r[2]) * h[2];
    const eu = Math.abs(cam.u[0]) * h[0] + Math.abs(cam.u[1]) * h[1] + Math.abs(cam.u[2]) * h[2];
    const pts = [c, ...[[-1, 1], [1, 1], [-1, -1], [1, -1]].map(([a, bb]) => add(c, add(scale(cam.r, a * 0.45 * er), scale(cam.u, bb * 0.45 * eu))))];
    prop[id] = r6(pts.filter((p) => inFrame(project(cam, p)) && blockers(ix, pos, p, (o) => o.entityId === id).length === 0).length / pts.length);
    const pr = projectBox(cam, b);
    propScreenSize[id] = r6(Math.max(clippedHeight(pr), clippedWidth(pr)));
  }

  // ── screen grid: foreground clutter + per-entity coverage
  const focusDist = (() => {
    const pts: Vec3[] = [];
    for (const id of focusIds) { const f = ix.faces.get(id); if (f) pts.push(f.center); else { const b = ix.bounds.get(id); if (b) pts.push(centerOf(b)); } }
    return pts.length ? Math.min(...pts.map((p) => len(sub(p, pos)))) : 2;
  })();
  const cols = cfg.grid, rows = Math.max(1, Math.round(cols / ix.aspect));
  let fgHits = 0;
  const cover = new Map<string, number>();
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const nx = ((i + 0.5) / cols) * 2 - 1, ny = 1 - ((j + 0.5) / rows) * 2;
    const dir = norm(add(cam.f, add(scale(cam.r, nx * cam.tanH), scale(cam.u, ny * cam.tanV))));
    let best = Infinity, who: CameraObstacle | undefined;
    for (const o of scene.obstacles) {
      if (o.occludes === false) continue;
      const h = rayObstacle(o, pos, dir);
      if (!h || h[1] <= NEAR) continue;
      const t = Math.max(0, h[0]);
      if (t < best || (t === best && who && o.entityId < who.entityId)) { best = t; who = o; }
    }
    if (!who) continue;
    cover.set(who.entityId, (cover.get(who.entityId) ?? 0) + 1);
    if (!focusIds.has(who.entityId) && best < cfg.foregroundDepthRatio * focusDist) fgHits++;
  }
  const n = cols * rows;
  const entityCoverage: Record<string, number> = {};
  for (const k of [...cover.keys()].sort()) entityCoverage[k] = r6(cover.get(k)! / n);
  const fg = r6(fgHits / n);
  if (fg > cfg.maxForegroundCoverage) reasons.push(`FOREGROUND_CLUTTER:${fg.toFixed(2)}>${cfg.maxForegroundCoverage}`);

  // ── visibility rules
  const af = active ? ix.faces.get(active) : undefined;
  if (FACE_INTENTS.has(intent)) {
    if (!af) reasons.push(`ACTIVE_FACE_UNKNOWN:${active}`);
    else {
      const need = intent === 'extreme_close' ? cfg.ecuMinFaceVisibility : intent === 'motivated_profile' ? cfg.profileMinFaceVisibility : cfg.minFaceVisibility;
      if (face[active!] < need) reasons.push(`FACE_VISIBILITY_LOW:${active}:${face[active!]}<${need}`);
    }
  }
  // "fully hidden": for face intents the face rule applies; in a wide an actor walking / turned away from the lens is not
  // hidden — it is hidden when nothing of it covers the screen or something occludes its face
  const hiddenInWide = intent !== 'wide' || !(entityCoverage[active!] > 0) || faceOccluders[active!].some((o) => !o.endsWith(`:${active}`));
  if (af && intent !== 'prop' && intent !== 'scale_reveal' && face[active!] === 0 && hiddenInWide && !reasons.some((r) => r.startsWith('FACE_VISIBILITY_LOW'))) reasons.push(`ACTIVE_SUBJECT_HIDDEN:${active}`);
  if (af && !cand.allowPropOverFace && intent !== 'prop' && intent !== 'scale_reveal') {
    const props = faceOccluders[active!].filter((o) => o.startsWith('prop:'));
    if (props.length) reasons.push(`PROP_COVERS_FACE:${active}:${props.map((p) => p.slice(5)).join(',')}`);
  }
  if (af && (intent === 'close' || intent === 'reaction') && !profile[active!]) {
    if (eyesVisible[active!] < 2) reasons.push(`EYES_NOT_VISIBLE:${active}:${eyesVisible[active!]}/2`);
    if (!mouthVisible[active!]) reasons.push(`MOUTH_NOT_VISIBLE:${active}`);
  }
  if (af && intent === 'extreme_close') {
    if (eyesVisible[active!] < 1) reasons.push(`ECU_BOTH_EYES_CROPPED:${active}`);
    const clutter = faceOccluders[active!].filter((o) => !o.endsWith(`:${active}`));
    if (clutter.length) reasons.push(`ECU_FOREGROUND_OVER_FACE:${active}:${clutter.join(',')}`);
  }
  // ── profile intents (explicit only; never applied to frontal intents)
  if (af && PROFILE_INTENTS.has(intent0)) {
    const nxz = norm([af.normal[0], 0, af.normal[2]]), toCam = norm([pos[0] - af.center[0], 0, pos[2] - af.center[2]]);
    const ang = Math.acos(clamp(dot(toCam, nxz), -1, 1)) / DEG;
    const [a0, a1] = intent0 === 'three_quarter_profile' ? cfg.threeQuarterAngleDeg : intent0 === 'offset_elevated_speaker_ots' ? cfg.speakerOtsAngleDeg : cfg.motivatedProfileAngleDeg;
    if (ang < a0 || ang > a1) reasons.push(`PROFILE_ANGLE_OUT_OF_RANGE:${active}:${ang.toFixed(0)}deg`);
    if (eyesVisible[active!] < 1) reasons.push(`NEAR_EYE_NOT_VISIBLE:${active}`);
    if (!mouthVisible[active!]) reasons.push(`MOUTH_NOT_VISIBLE:${active}`);
    if (![af.samples[1], af.samples[2]].some((p) => pointVisible(active!, af, p, new Set()))) reasons.push(`BROW_NOT_READABLE:${active}`);
    const q = [af.samples[1], af.samples[2], af.samples[4], af.samples[3]].map((p) => project(cam, p));
    const area = q.every((x) => x.z > NEAR) ? Math.abs(q.reduce((a, x, k) => a + x.x * q[(k + 1) % 4].y - q[(k + 1) % 4].x * x.y, 0)) / 2 : 0;
    if (area < cfg.profileMinFaceArea) reasons.push(`FACE_AREA_TOO_SMALL:${active}:${area.toFixed(4)}<${cfg.profileMinFaceArea}`);
    // any occluder over the face — another actor, a prop, or the actor's own hair / hoodie / arm — is an obstruction
    if (faceOccluders[active!].length) reasons.push(`PROFILE_FACE_OBSTRUCTED:${active}:${faceOccluders[active!].join(',')}`);
    const tid = cand.eyelineTargetId, tf = tid ? ix.faces.get(tid) : undefined, tb = tid ? ix.bounds.get(tid) : undefined;
    const tp = tf ? tf.center : tb ? centerOf(tb) : undefined;
    if (!tp) reasons.push(`EYELINE_TARGET_UNKNOWN:${active}:${tid ?? 'none'}`);
    else {
      const toT = norm([tp[0] - af.center[0], 0, tp[2] - af.center[2]]);
      const off = Math.acos(clamp(dot(toT, nxz), -1, 1)) / DEG;
      if (off > cfg.eyelineToleranceDeg) reasons.push(`EYELINE_OFF_TARGET:${active}:${tid}:${off.toFixed(0)}deg`);
      // the face must look toward the screen side the target is on (or the eyeline reads backwards)
      const lookX = dot(nxz, cam.r), tgtX = dot(sub(tp, af.center), cam.r);
      if (Math.abs(lookX) > 0.05 && Math.abs(tgtX) > 0.05 && Math.sign(lookX) !== Math.sign(tgtX)) reasons.push(`EYELINE_SCREEN_MISMATCH:${active}:${tid}`);
    }
  }
  const heroNeed = intent === 'prop' || intent === 'scale_reveal' || cand.requiresHeroProp;
  for (const id of heroes) {
    if (heroNeed && prop[id] < cfg.minHeroPropVisibility) reasons.push(`HERO_PROP_VISIBILITY_LOW:${id}:${prop[id]}<${cfg.minHeroPropVisibility}`);
    if (intent === 'wide' && prop[id] === 0) reasons.push(`WIDE_MISSING_HERO_PROP:${id}`);
  }

  // ── framing rules
  const [hMin, hMax] = PROFILE_INTENTS.has(intent0) ? cfg.headHeight[cand.profileScale ?? 'close'] : cfg.headHeight[intent];
  // readable actors: required + explicitly framed characters (the OTS foreground shoulder is exempt)
  const readable = [...new Set([...roles.required, ...(cand.framedSubjectIds ?? [])])].filter((id) => ix.faces.has(id) && id !== fgActor).sort();
  const twoShot = intent === 'medium' && readable.length >= 2;
  const minHead = twoShot ? cfg.twoShotMinHeadHeight : hMin;
  let sizeTerm = 1;
  if (intent !== 'prop' && intent !== 'extreme_close') {
    const refs = cand.scaleReferenceIds ?? roles.required;
    for (const id of required) if (ix.faces.has(id) && id !== fgActor && headCropped[id] && ((id === active && intent !== 'scale_reveal') || (intent === 'wide' && requiredSet.has(id)) || (intent === 'scale_reveal' && refs.includes(id)) || headInFrame[id])) reasons.push(`HEAD_CROPPED:${id}`);
  }
  if (intent !== 'prop' && intent !== 'wide' && intent !== 'scale_reveal') {
    // a required actor is never silently dropped from a character shot
    for (const id of roles.required) if (ix.faces.has(id) && id !== fgActor && !headInFrame[id]) reasons.push(`REQUIRED_SUBJECT_NOT_IN_FRAME:${id}`);
    // readable portrait scale: two-shot → every readable head ≥ twoShotMinHeadHeight; otherwise the active head ≥ intent min
    for (const id of twoShot ? readable : af ? [active!] : []) {
      if (id !== active && !headInFrame[id]) continue; // reported as REQUIRED_SUBJECT_NOT_IN_FRAME
      const hh = headScreenHeight[id];
      if (hh < minHead) reasons.push(`SUBJECT_TOO_SMALL_FOR_INTENT:${id}:${pct(hh)}%<${pct(minHead)}%`);
      if (hh > hMax) reasons.push(`SHOT_TOO_TIGHT_FOR_INTENT:${id}:${pct(hh)}%>${pct(hMax)}%`);
    }
    if (af) {
      const hh = headScreenHeight[active!], ideal = hMax > 5 ? minHead * 1.3 : (minHead + hMax) / 2;
      sizeTerm = clamp(1 - Math.abs(hh - ideal) / Math.max(ideal, 1e-3), 0, 1);
    }
  }
  if (intent === 'wide') {
    let content = 0;
    const needContent = cfg.minWideContentCoveragePerActor * Math.max(1, required.filter((id) => ix.faces.has(id)).length);
    for (const id of required) {
      if (requiredSet.has(id) && subjectScreenHeight[id] < cfg.minWideSubjectHeight) reasons.push(`WIDE_SUBJECT_TOO_SMALL:${id}:${(subjectScreenHeight[id] ?? 0).toFixed(3)}<${cfg.minWideSubjectHeight}`);
      content += entityCoverage[id] ?? 0;
    }
    for (const id of heroes) content += entityCoverage[id] ?? 0;
    if (content < needContent) reasons.push(`WIDE_EXCESSIVE_EMPTY_SPACE:${content.toFixed(3)}<${needContent.toFixed(3)}`);
    const minH = Math.min(...roles.required.map((id) => subjectScreenHeight[id] ?? 0));
    sizeTerm = clamp(1 - Math.abs(minH - 0.35) / 0.35, 0, 1);
  }
  if (intent === 'medium' && active) {
    const body = scene.obstacles.filter((o) => o.entityId === active && o.type === 'body').map((o) => o.bounds);
    const bb = unionBounds(body);
    if (bb) {
      const sh: Vec3 = [(bb.min[0] + bb.max[0]) / 2, bb.max[1] - 0.05, (bb.min[2] + bb.max[2]) / 2];
      if (!inFrame(project(cam, sh))) reasons.push(`UPPER_BODY_NOT_READABLE:${active}`);
    }
  }
  if ((intent === 'close' || intent === 'reaction' || PROFILE_INTENTS.has(intent0)) && af) {
    const fr = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    let bad = false;
    for (const p of af.samples) { const q = project(cam, p); if (!(q.z > NEAR)) { bad = true; continue; } fr.x0 = Math.min(fr.x0, q.x); fr.x1 = Math.max(fr.x1, q.x); fr.y0 = Math.min(fr.y0, q.y); fr.y1 = Math.max(fr.y1, q.y); }
    const m = cfg.faceMargin;
    if (bad || fr.x0 < m || fr.y0 < m || fr.x1 > 1 - m || fr.y1 > 1 - m) reasons.push(`FACE_OUTSIDE_SAFE_MARGIN:${active}`);
  }
  if (intent === 'over_shoulder' && fgActor) {
    const fgCov = Object.entries(entityCoverage).filter(([k]) => k === fgActor).reduce((s, [, v]) => s + v, 0);
    if (fgCov > cfg.maxForegroundCoverage) reasons.push(`OTS_FOREGROUND_OBSTRUCTION:${fgActor}:${fgCov.toFixed(2)}>${cfg.maxForegroundCoverage}`);
  }
  if (intent === 'prop') {
    for (const id of heroes) {
      if (propScreenSize[id] < cfg.minPropScreenSize) reasons.push(`HERO_PROP_UNREADABLE:${id}:${propScreenSize[id].toFixed(3)}<${cfg.minPropScreenSize}`);
      const pc = entityCoverage[id] ?? 0;
      for (const [k, v] of Object.entries(entityCoverage)) if (ix.kind.get(k) === 'character' && v > Math.max(cfg.maxForegroundCoverage, 1.5 * pc)) reasons.push(`PROP_SHOT_UPSTAGED_BY_BODY:${k}:${v.toFixed(2)}`);
      const ip = ix.meta.get(id)?.interactionPoint;
      if (ip && (!inFrame(project(cam, ip)) || blockers(ix, pos, ip, (o) => o.entityId === id || o.entityId === active).length)) reasons.push(`INTERACTION_POINT_HIDDEN:${id}`);
    }
    if (!heroes.length) reasons.push('PROP_SHOT_WITHOUT_HERO_PROP');
    sizeTerm = heroes.length ? clamp(Math.min(...heroes.map((id) => propScreenSize[id])) / 0.5, 0, 1) : 0;
  }
  // ── giant hero-prop scale reveal (explicit intent only): identity, thickness, base, scale reference, no hidden face
  if (intent === 'scale_reveal') {
    if (!heroes.length) reasons.push('SCALE_REVEAL_WITHOUT_HERO_PROP');
    for (const id of heroes) {
      if (propScreenSize[id] < cfg.minPropScreenSize) reasons.push(`HERO_PROP_UNREADABLE:${id}:${propScreenSize[id].toFixed(3)}<${cfg.minPropScreenSize}`);
      const idn = ix.meta.get(id)?.identity;
      if (!idn) { reasons.push(`SCALE_REVEAL_IDENTITY_UNKNOWN:${id}`); continue; }
      const seen = (p: Vec3) => inFrame(project(cam, p)) && blockers(ix, pos, p, (o) => o.entityId === id).length === 0;
      const fn = norm(idn.frontNormal), toCam = sub(pos, idn.emblem);
      const ang = Math.acos(clamp(dot(fn, norm(toCam)), -1, 1)) / DEG;
      if (dot(fn, toCam) <= 0) reasons.push(`CAMERA_BEHIND_HERO_PROP:${id}`);
      else if (ang > cfg.scaleRevealViewAngleDeg[1]) reasons.push(`SCALE_REVEAL_EMBLEM_UNREADABLE:${id}:${ang.toFixed(0)}deg`);
      else if (ang < cfg.scaleRevealViewAngleDeg[0]) reasons.push(`SCALE_REVEAL_NO_THICKNESS_EDGE:${id}:${ang.toFixed(0)}deg`);
      if (!seen(idn.emblem)) reasons.push(`SCALE_REVEAL_EMBLEM_HIDDEN:${id}`);
      const rim = idn.rim.filter(seen).length / Math.max(1, idn.rim.length);
      if (rim < cfg.scaleRevealMinSilhouette) reasons.push(`SCALE_REVEAL_SILHOUETTE_LOW:${id}:${rim.toFixed(2)}<${cfg.scaleRevealMinSilhouette}`);
      if (!inFrame(project(cam, idn.base))) reasons.push(`SCALE_REVEAL_BASE_NOT_VISIBLE:${id}`);
      // no face may be hidden by the giant prop (actors facing away have no visible face to hide)
      for (const [cid, occ] of Object.entries(faceOccluders)) if (!cand.allowPropOverFace && occ.includes(`prop:${id}`)) reasons.push(`PROP_COVERS_FACE:${cid}:${id}`);
    }
    for (const id of (cand.scaleReferenceIds ?? roles.required).filter((x) => ix.kind.get(x) === 'character')) {
      if (!(entityCoverage[id] > 0)) reasons.push(`SCALE_REFERENCE_NOT_VISIBLE:${id}`);
      else if (subjectScreenHeight[id] < cfg.minWideSubjectHeight) reasons.push(`SCALE_REFERENCE_TOO_SMALL:${id}:${subjectScreenHeight[id].toFixed(3)}<${cfg.minWideSubjectHeight}`);
    }
    const ps = heroes.length ? Math.min(...heroes.map((id) => propScreenSize[id])) : 0;
    sizeTerm = clamp(ps / 0.6, 0, 1);
  }

  // ── explicit pattern intents: their own extra checks on top of the base-intent rules
  const pitch = Math.asin(clamp(-cam.f[1], -1, 1)) / DEG;
  if (intent0 === 'offset_elevated_speaker_ots' && fgActor) {
    // the lens sits above the listener's shoulder line (top of the body parts below the head)
    const body = unionBounds(scene.obstacles.filter((o) => o.entityId === fgActor && o.type === 'body').map((o) => o.bounds));
    if (body && pos[1] < body.max[1]) reasons.push(`OTS_NOT_ELEVATED:${fgActor}`);
  }
  if (intent0 === 'neutral_top_down_prop_insert') {
    if (pitch < cfg.topDownMinPitchDeg) reasons.push(`INSERT_NOT_TOP_DOWN:${pitch.toFixed(0)}deg<${cfg.topDownMinPitchDeg}`);
    for (const [k, v] of Object.entries(entityCoverage)) if (ix.kind.get(k) === 'character' && v > 0) reasons.push(`INSERT_SHOWS_ACTOR:${k}`);
  }
  if (intent0 === 'elevated_consequence' && pitch < cfg.consequenceMinPitchDeg) reasons.push(`CONSEQUENCE_NOT_ELEVATED:${pitch.toFixed(0)}deg<${cfg.consequenceMinPitchDeg}`);
  for (const id of cand.propEdgeIds ?? []) {
    const idn = ix.meta.get(id)?.identity;
    const n = idn ? idn.rim.filter((q) => inFrame(project(cam, q)) && blockers(ix, pos, q, (o) => o.entityId === id).length === 0).length : 0;
    if (n < 2) reasons.push(`PROP_EDGE_NOT_VISIBLE:${id}:${n}/${idn?.rim.length ?? 0}`);
  }

  // ── implied seated / waist-up constraints: ANY character whose legs must not show (subject or not) — an optional or
  // off-subject seated actor may be left out of frame or hidden, but never shown standing on missing chair legs
  const seatedIds = [...ix.meta.values()].filter((m) => m.waistUpRequired).map((m) => m.entityId).sort();
  for (const id of seatedIds) {
    const m = ix.meta.get(id);
    if (!m?.waistUpRequired) continue;
    const bb = ix.bounds.get(id);
    const f = ix.faces.get(id);
    if (!bb || !f) continue;
    const waist = m.waistY ?? (bb.min[1] + (bb.max[1] - bb.min[1]) * 0.45);
    const fwd = norm([f.normal[0], 0, f.normal[2]]);
    const h = halfOf(bb), c = centerOf(bb);
    const front = add(c, scale(fwd, Math.abs(fwd[0]) * h[0] + Math.abs(fwd[2]) * h[2] + 0.001));
    const legs = [0.15, 0.5, 0.85].map((k): Vec3 => [front[0], bb.min[1] + (waist - bb.min[1]) * k, front[2]]);
    const shown = legs.filter((p) => inFrame(project(cam, p)) && blockers(ix, pos, p, (o) => o.entityId === id).length === 0).length;
    if (shown) reasons.push(`WAIST_UP_REQUIRED_LEGS_VISIBLE:${id}:${shown}/3`);
    if (m.behindEntityId && required.includes(id)) {
      const d = ix.bounds.get(m.behindEntityId);
      if (d) {
        const toDesk = sub(centerOf(d), c), toCam = sub(pos, c);
        if (toDesk[0] * toCam[0] + toDesk[2] * toCam[2] <= 0) reasons.push(`NOT_FRAMED_BEHIND:${id}:${m.behindEntityId}`);
      }
    }
  }

  // ── caption-reserved region (metadata; placement is not owned here)
  let captionOverlap = false;
  const cr = scene.captionReservedRegion;
  if (cr && af) {
    const q = project(cam, af.center);
    captionOverlap = inFrame(q) && q.x >= cr.x0 && q.x <= cr.x1 && q.y >= cr.y0 && q.y <= cr.y1;
    if (captionOverlap) reasons.push(`ACTIVE_FACE_IN_CAPTION_REGION:${active}`);
  }

  const requiredHeadHeightPct: Record<string, number> = {};
  for (const id of [...new Set([...roles.required, ...readable])].filter((x) => ix.faces.has(x)).sort()) requiredHeadHeightPct[id] = headInFrame[id] ? pct(headScreenHeight[id]) : 0; // 0 = not in frame
  const subjectsInFrame = required.filter((id) => ix.faces.has(id) && (id === fgActor ? (entityCoverage[id] ?? 0) > 0 : headInFrame[id])).sort();
  // prop inserts frame the hero prop; actor presence is not assessed for them
  // prop-led intents frame the hero prop: prop inserts assess no actor presence; a scale reveal assesses its scale
  // references only (a missing reference is also rejected as SCALE_REFERENCE_NOT_VISIBLE)
  const presence = intent === 'scale_reveal' ? required.filter((id) => (cand.scaleReferenceIds ?? roles.required).includes(id)) : required;
  const droppedSubjects = intent === 'prop' ? [] : presence.filter((id) => ix.faces.has(id) && !subjectsInFrame.includes(id)).sort();
  return {
    reasons, face, prop, fg, sizeTerm,
    d: {
      eyesVisible, mouthVisible, profile, headScreenHeight, subjectScreenHeight, headCropped, entityCoverage, propScreenSize, faceOccluders, captionOverlap, minHeadDist,
      requiredSubjects: [...roles.required].sort(), optionalSubjects: [...roles.optional].sort(), requiredHeadHeightPct, minHeadHeight: minHead, twoShot, subjectsInFrame,
      droppedSubjects, droppedOptionalSubjects: droppedSubjects.filter((id) => !requiredSet.has(id)), droppedRequiredSubjects: droppedSubjects.filter((id) => requiredSet.has(id)),
      droppedOnlyOptionalSupport: droppedSubjects.length > 0 && droppedSubjects.every((id) => !requiredSet.has(id)),
    },
  };
}

/** Lens-sphere collision along the full camera path (dense, step ≤ cfg.pathStep). */
function pathCollision(ix: SceneIndex, a: Vec3, b: Vec3, cfg: CameraSafetyConfig): { clearance: number; hits: string[]; samples: number } {
  const steps = Math.max(1, Math.ceil(len(sub(b, a)) / Math.min(cfg.pathStep, cfg.lensRadius / 2)));
  let clearance = Infinity;
  const hits = new Set<string>();
  for (let s = 0; s <= steps; s++) {
    const p = lerp3(a, b, s / steps);
    for (const o of ix.scene.obstacles) {
      const d = pointBoxDistance(p, o.bounds) - cfg.lensRadius;
      if (d < clearance) clearance = d;
      if (d < 0) hits.add(`${s === 0 ? 'LENS_COLLISION' : 'CAMERA_PATH_COLLISION'}:${o.type}:${o.entityId}`);
    }
  }
  return { clearance: r6(clearance === Infinity ? 99 : clearance), hits: [...hits].sort(), samples: steps + 1 };
}

export function evaluateCameraCandidate(scene: CameraSafetyScene, cand: CameraCandidate, cfg: CameraSafetyConfig = CAMERA_SAFETY_DEFAULTS): CameraSafetyResult {
  return evaluateIndexed(indexScene(scene), cand, cfg);
}

function evaluateIndexed(ix: SceneIndex, cand: CameraCandidate, cfg: CameraSafetyConfig): CameraSafetyResult {
  const p0 = cand.transform.position, p1 = cand.motion?.to.position ?? p0;
  const t0 = cand.target, t1 = cand.motion?.toTarget ?? t0;
  const r0 = cand.transform.roll ?? 0, r1 = cand.motion?.to.roll ?? r0;
  const col = pathCollision(ix, p0, p1, cfg);
  // explicit lens path (e.g. a tracking camera's previous frame positions → this frame): every segment is checked
  const lp = cand.lensPath ?? [];
  for (let k = 0; k < lp.length; k++) {
    const seg = pathCollision(ix, lp[k], k + 1 < lp.length ? lp[k + 1] : p0, cfg);
    col.clearance = Math.min(col.clearance, seg.clearance); col.samples += seg.samples;
    for (const h of seg.hits) { const x = h.replace(/^LENS_COLLISION/, 'CAMERA_PATH_COLLISION'); if (!col.hits.includes(x)) col.hits.push(x); }
  }
  col.hits.sort();
  // visibility/framing at start, middle and end of the move (worst case wins)
  const us = cand.motion ? [0, 0.5, 1] : [0];
  const evals = us.map((u) => evaluateSample(ix, cand, lerp3(p0, p1, u), lerp3(t0, t1, u), r0 + (r1 - r0) * u, cfg));
  const reasons = new Set<string>(col.hits);
  for (const e of evals) for (const r of e.reasons) reasons.add(r);
  const minRec = (k: 'face' | 'prop') => { const out: Record<string, number> = {}; for (const e of evals) for (const [id, v] of Object.entries(e[k])) out[id] = Math.min(out[id] ?? Infinity, v); return out; };
  const face = minRec('face'), prop = minRec('prop');
  const fg = Math.max(...evals.map((e) => e.fg));
  const worst = evals.reduce((w, e) => (e.reasons.length > w.reasons.length ? e : w), evals[0]);

  const sd = ix.scene.screenDirection, axis = axisOf(sd);
  const startSide = sideOf(axis, p0, cfg.neutralAxisSin), endSide = sideOf(axis, p1, cfg.neutralAxisSin);
  const endCam = makeCam(p1, t1, cand.fov, r1, ix.aspect);
  const dir = evaluateScreenDirection(sd, cand, startSide, endSide, endCam);
  if (dir.reject) reasons.add(`SCREEN_DIRECTION_REVERSED:${dir.result}`);

  const active = cand.activeSubjectId ?? ix.active;
  const faceTerm = active && face[active] !== undefined ? face[active] : 1;
  const heroes = ix.scene.heroPropIds;
  const bi = baseIntent(cand.intent);
  const propTerm = heroes.length && (bi === 'prop' || cand.requiresHeroProp || bi === 'wide') ? Math.min(...heroes.map((h) => prop[h] ?? 0)) : 1;
  const clutterTerm = clamp(1 - fg / cfg.maxForegroundCoverage, 0, 1);
  const clearTerm = clamp(col.clearance / 0.5, 0, 1);
  const sizeTerm = Math.min(...evals.map((e) => e.sizeTerm));
  const dirTerm = dir.result.startsWith('consistent') || dir.result === 'no_axis' || dir.result.startsWith('established') ? 1 : 0.5;
  const score = r6(clamp(0.3 * faceTerm + 0.2 * propTerm + 0.2 * clutterTerm + 0.1 * clearTerm + 0.15 * sizeTerm + 0.05 * dirTerm - dir.penalty, 0, 1));
  const rejectionReasons = [...reasons];
  const sideLabel: Side = endSide;
  const req = new Set(worst.d.requiredSubjects);
  const rejectingRequiredSubjects = [...new Set(rejectionReasons.flatMap((r) => r.split(':').slice(1).filter((x) => req.has(x))))].sort();
  return {
    accepted: rejectionReasons.length === 0,
    score,
    rejectionReasons,
    faceVisibility: face,
    propVisibility: prop,
    foregroundCoverage: fg,
    lensClearance: col.clearance,
    screenDirectionResult: dir.result,
    diagnostics: {
      eyesVisible: worst.d.eyesVisible, mouthVisible: worst.d.mouthVisible, profile: worst.d.profile,
      headScreenHeight: worst.d.headScreenHeight, subjectScreenHeight: worst.d.subjectScreenHeight, headCropped: worst.d.headCropped,
      entityCoverage: worst.d.entityCoverage, propScreenSize: worst.d.propScreenSize, faceOccluders: worst.d.faceOccluders,
      minHeadDistance: r6(Math.min(...evals.map((e) => e.d.minHeadDist))), pathSamples: col.samples, cameraSide: sideLabel,
      captionOverlapsActiveFace: evals.some((e) => e.d.captionOverlap),
      requiredSubjects: worst.d.requiredSubjects, optionalSubjects: worst.d.optionalSubjects, requiredHeadHeightPct: worst.d.requiredHeadHeightPct,
      minHeadHeight: worst.d.minHeadHeight, twoShot: worst.d.twoShot, subjectsInFrame: worst.d.subjectsInFrame,
      droppedSubjects: worst.d.droppedSubjects, droppedOptionalSubjects: worst.d.droppedOptionalSubjects, droppedRequiredSubjects: worst.d.droppedRequiredSubjects,
      droppedOnlyOptionalSupport: worst.d.droppedOnlyOptionalSupport, rejectingRequiredSubjects,
    },
  };
}

// ───────────────────────────── fallbacks ─────────────────────────────

export type FallbackKind = 'frontal_medium' | 'two_character_medium' | 'elevated_wide' | 'prop_insert' | 'reaction_close';
export const FALLBACK_ORDER: FallbackKind[] = ['frontal_medium', 'two_character_medium', 'elevated_wide', 'prop_insert', 'reaction_close'];

/**
 * Fallback chain for the requested intent. The elevated wide is used only for geography/scale (wide) beats and the
 * prop insert only for prop beats, so neither can stand in for an unreadable character shot. A single active medium
 * / reaction close drop the supporting actor and are therefore rejected when that actor is required.
 */
export function fallbackChain(intent: CameraIntent, twoShotFirst: boolean): FallbackKind[] {
  switch (intent) {
    case 'wide': return ['elevated_wide', 'two_character_medium', 'frontal_medium', 'reaction_close'];
    case 'prop': return ['prop_insert', 'frontal_medium', 'two_character_medium', 'reaction_close'];
    case 'close': case 'reaction': case 'extreme_close': return ['reaction_close', 'frontal_medium', 'two_character_medium'];
    default: return twoShotFirst ? ['two_character_medium', 'frontal_medium', 'reaction_close'] : ['frontal_medium', 'two_character_medium', 'reaction_close'];
  }
}

/** Vetted, geometry-solved fallback shots. They are still fully evaluated before use. */
export function buildSafeFallbackCandidates(scene: CameraSafetyScene, cfg: CameraSafetyConfig = CAMERA_SAFETY_DEFAULTS): Array<CameraCandidate & { fallback: FallbackKind }> {
  const ix = indexScene(scene);
  const out: Array<CameraCandidate & { fallback: FallbackKind }> = [];
  const active = ix.active;
  const af = active ? ix.faces.get(active) : undefined;
  const hfovTan = (fov: number) => Math.tan((fov * DEG) / 2) * ix.aspect;
  const sd = scene.screenDirection, axis = axisOf(sd);
  const seated = active ? ix.meta.get(active)?.waistUpRequired === true : false;
  if (af) {
    const hc = centerOf(af.head), n = norm([af.normal[0], 0, af.normal[2]]);
    if (seated) {
      // waist-up constraint: level camera whose frame bottom (at the subject) sits above the waist line
      const m = ix.meta.get(active!)!, bb = ix.bounds.get(active!)!, dist = 2.0, tanV = Math.tan(19 * DEG);
      const waist = m.waistY ?? bb.min[1] + (bb.max[1] - bb.min[1]) * 0.45;
      const ty = Math.max(hc[1] - 0.38, waist + 0.08 + (dist + 0.2) * tanV);
      const pos = add(hc, scale(n, dist));
      out.push({ fallback: 'frontal_medium', id: 'fallback:frontal_medium', intent: 'medium', fov: 38, activeSubjectId: active, transform: { position: [pos[0], ty, pos[2]] }, target: [hc[0], ty, hc[2]] });
    } else {
      out.push({ fallback: 'frontal_medium', id: 'fallback:frontal_medium', intent: 'medium', fov: 38, activeSubjectId: active, transform: { position: add(add(hc, scale(n, 2.1)), [0, -0.15, 0]) }, target: add(hc, [0, -0.38, 0]) });
    }
  }
  const chars = scene.subjectIds.filter((id) => ix.faces.has(id));
  const { required } = rolesOf(scene, active);
  const partner = active ? [...chars.filter((id) => id !== active && required.includes(id)), ...chars.filter((id) => id !== active && !required.includes(id))][0] : chars[1];
  const pair = active && af ? (partner ? [active, partner] : []) : chars.slice(0, 2);
  if (pair.length === 2) {
    const fa = ix.faces.get(pair[0])!, fb = ix.faces.get(pair[1])!;
    const a = centerOf(fa.head), b = centerOf(fb.head);
    const mid = scale(add(a, b), 0.5), ab = sub(b, a);
    let perp = norm(cross(UP, [ab[0], 0, ab[2]]));
    const avgN = add(fa.normal, fb.normal);
    const dn = dot(perp, avgN);
    if (dn < -1e-6 || (Math.abs(dn) <= 1e-6 && perp[2] < 0)) perp = scale(perp, -1); // toward the faces; tie → audience (+z)
    if (axis && sd?.previousCameraSide) { const s = sideOf(axis, add(mid, perp), cfg.neutralAxisSin); if (s !== 'neutral' && s !== sd.previousCameraSide) perp = scale(perp, -1); }
    // fit the two HEADS (+ small margin), not full bodies: a portrait two-shot is never pushed back further than the
    // heads need. If that distance is still unreadable, the evaluator rejects it (SUBJECT_TOO_SMALL_FOR_INTENT).
    const headHalfW = Math.max(halfOf(fa.headTop)[0], halfOf(fa.headTop)[2], halfOf(fb.headTop)[0], halfOf(fb.headTop)[2]);
    const w = len([ab[0], 0, ab[2]]) / 2 + headHalfW + 0.08, fov = 38;
    const dist = w / (hfovTan(fov) * 0.92);
    out.push({ fallback: 'two_character_medium', id: 'fallback:two_character_medium', intent: 'medium', fov, activeSubjectId: active, framedSubjectIds: [...pair], transform: { position: add(add(mid, scale(perp, dist)), [0, -0.1, 0]) }, target: add(mid, [0, -0.35, 0]) });
  }
  const content = unionBounds([...scene.subjectIds, ...scene.heroPropIds].map((id) => ix.bounds.get(id)).filter(Boolean) as Bounds3[]);
  if (content) {
    const c = centerOf(content), h = halfOf(content), fov = 42;
    const halfW = (h[0] + 0.5) * 1.1, halfH = h[1] + 0.3;
    const dist = Math.max(halfW / hfovTan(fov), halfH / Math.tan((fov * DEG) / 2)) + h[2];
    let dirv: Vec3 = af ? norm([af.normal[0], 0, af.normal[2]]) : [0, 0, 1];
    if (axis && sd?.previousCameraSide && sideOf(axis, add(c, dirv), cfg.neutralAxisSin) === (sd.previousCameraSide === 'left' ? 'right' : 'left')) dirv = scale(dirv, -1);
    const dir = norm(add(dirv, [0, 0.35, 0]));
    out.push({ fallback: 'elevated_wide', id: 'fallback:elevated_wide', intent: 'wide', fov, activeSubjectId: active, transform: { position: add(c, scale(dir, dist)) }, target: c });
  }
  for (const pid of scene.heroPropIds.slice(0, 1)) {
    const b = ix.bounds.get(pid);
    if (!b) continue;
    const c = centerOf(b), h = halfOf(b), rad = Math.max(h[0], h[1], h[2]), fov = 38;
    const dist = Math.max(rad / (hfovTan(fov) * 0.6), 0.5);
    const base: Vec3 = af ? norm([af.normal[0], 0, af.normal[2]]) : [0, 0, 1];
    const dir = norm(add(base, [0, 0.5, 0]));
    out.push({ fallback: 'prop_insert', id: 'fallback:prop_insert', intent: 'prop', fov, activeSubjectId: active, transform: { position: add(c, scale(dir, dist)) }, target: c });
  }
  if (af) {
    const hc = centerOf(af.head), n = norm([af.normal[0], 0, af.normal[2]]);
    // 1.6 m keeps the head inside the close/reaction band (26–70% of frame height) without cropping 3/4 heads in 9:16
    out.push({ fallback: 'reaction_close', id: 'fallback:reaction_close', intent: 'reaction', fov: 38, activeSubjectId: active, transform: { position: add(add(hc, scale(n, 1.6)), [0, 0.02, 0]) }, target: add(hc, [0, -0.05, 0]) });
  }
  return out;
}

// ───────────────────────────── selection ─────────────────────────────

export interface CameraEvaluation { candidate: CameraCandidate; result: CameraSafetyResult }
export type CameraSelection =
  | {
    ok: true; candidate: CameraCandidate; result: CameraSafetyResult; usedFallback: boolean; fallback?: FallbackKind;
    /** supporting actors left out of the chosen frame (always optional ones — required actors are never dropped) */
    droppedOptionalSubjects: string[];
    /** true when the chosen shot dropped a supporting actor and every dropped actor was optional */
    droppedOnlyOptionalSupport: boolean;
    evaluations: CameraEvaluation[]; fallbackEvaluations: CameraEvaluation[];
  }
  | { ok: false; blocking: true; code: 'CAMERA_SAFETY_BLOCKED'; message: string; rejectingRequiredSubjects: string[]; evaluations: CameraEvaluation[]; fallbackEvaluations: CameraEvaluation[] };

/**
 * Evaluate every candidate, keep the ones passing collision / occlusion / visibility / framing / screen direction,
 * pick the highest score (ties → lexicographic id). If none pass, try the vetted fallbacks of `fallbackChain(intent)`
 * (intent of the id-sorted first candidate; a beat's candidates normally share one) — each fully evaluated. If every
 * fallback fails, return a blocking error that names the required actors behind the rejections.
 */
export function selectSafeCamera(scene: CameraSafetyScene, candidates: CameraCandidate[], cfg: CameraSafetyConfig = CAMERA_SAFETY_DEFAULTS): CameraSelection {
  const ix = indexScene(scene);
  const evaluations = [...candidates].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((c) => ({ candidate: c, result: evaluateIndexed(ix, c, cfg) }));
  const pick = (list: CameraEvaluation[]) => list.filter((e) => e.result.accepted).sort((a, b) => b.result.score - a.result.score || (a.candidate.id < b.candidate.id ? -1 : 1))[0];
  const dropped = (r: CameraSafetyResult) => ({ droppedOptionalSubjects: r.diagnostics.droppedOptionalSubjects, droppedOnlyOptionalSupport: r.diagnostics.droppedOnlyOptionalSupport });
  const best = pick(evaluations);
  if (best) return { ok: true, candidate: best.candidate, result: best.result, usedFallback: false, ...dropped(best.result), evaluations, fallbackEvaluations: [] };

  // requested intent: from the id-sorted list, so the chain does not depend on input order
  const intent = evaluations[0]?.candidate.intent ?? 'medium';
  const requiredChars = rolesOf(scene, ix.active).required.filter((id) => ix.faces.has(id));
  const twoShotFirst = requiredChars.length >= 2 || candidates.some((c) => c.intent === 'over_shoulder' || (c.framedSubjectIds?.length ?? 0) >= 2);
  const chain = fallbackChain(intent, twoShotFirst);
  const fbs = buildSafeFallbackCandidates(scene, cfg).filter((f) => chain.includes(f.fallback)).sort((a, b) => chain.indexOf(a.fallback) - chain.indexOf(b.fallback));
  const fallbackEvaluations: CameraEvaluation[] = [];
  for (const fb of fbs) {
    const result = evaluateIndexed(ix, fb, cfg);
    result.diagnostics.fallback = fb.fallback;
    fallbackEvaluations.push({ candidate: fb, result });
    if (result.accepted) return { ok: true, candidate: fb, result, usedFallback: true, fallback: fb.fallback, ...dropped(result), evaluations, fallbackEvaluations };
  }
  const all = [...evaluations, ...fallbackEvaluations];
  const rejectingRequiredSubjects = [...new Set(all.flatMap((e) => e.result.diagnostics.rejectingRequiredSubjects))].sort();
  const summary = all.map((e) => `${e.candidate.id}: ${e.result.rejectionReasons.slice(0, 3).join('; ')}`).join(' | ');
  return { ok: false, blocking: true, code: 'CAMERA_SAFETY_BLOCKED', message: `no candidate or vetted fallback passed camera safety (required actors: ${rejectingRequiredSubjects.join(', ') || 'n/a'}) — ${summary}`, rejectingRequiredSubjects, evaluations, fallbackEvaluations };
}

/** Throwing variant for pipelines that must never accept an unsafe camera. */
export function requireSafeCamera(scene: CameraSafetyScene, candidates: CameraCandidate[], cfg: CameraSafetyConfig = CAMERA_SAFETY_DEFAULTS) {
  const s = selectSafeCamera(scene, candidates, cfg);
  if (!s.ok) throw new Error(`CAMERA_SAFETY_BLOCKED: ${s.message}`);
  return s;
}
