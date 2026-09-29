// Deterministic camera safety + framing evaluator and safe-shot selector.
//
// Generic engine-level module: it knows about entities, obstacles (AABBs), faces, props and shot intents — nothing
// story-specific. It does NOT render; every metric is an analytic approximation over axis-aligned bounds:
//   • collision: lens safety sphere (r = 0.12 m) vs every obstacle, densely sampled along the camera path;
//   • visibility: five rays per face / hero prop (centre + four corners), occlusion by slab tests;
//   • coverage: a fixed screen grid of primary rays (nearest hit) → foreground clutter and per-entity coverage;
//   • framing: projected head/face/prop/subject rectangles against intent rules;
//   • screen direction: camera side of the action axis vs the previous shot.
// Not wired into any renderer yet; see `selectSafeCamera` for the integration entry point.
import { add, sub, scale, dot, cross, len, norm, clamp, lerp3, DEG, type Vec3 } from './math.ts';

// ───────────────────────────── types ─────────────────────────────

export interface Bounds3 { min: Vec3; max: Vec3 }
export type ObstacleType = 'environment' | 'body' | 'head' | 'hair' | 'prop';
export interface CameraObstacle { entityId: string; type: ObstacleType; bounds: Bounds3 }

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
  /** required subjects; the first is the active subject unless `activeSubjectId` is set */
  subjectIds: string[];
  heroPropIds: string[];
  obstacles: CameraObstacle[];
  projectedEntities?: ProjectedEntity[];
  screenDirection?: ScreenDirectionState;
  activeSubjectId?: string;
  captionReservedRegion?: ScreenRegion;
}

export interface CameraTransform { position: Vec3; /** degrees */ roll?: number }

export type CameraIntent = 'wide' | 'medium' | 'close' | 'reaction' | 'prop' | 'over_shoulder' | 'extreme_close';

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
  /** OTS: the actor whose shoulder is in the foreground (inferred when absent) */
  foregroundSubjectId?: string;
  /** beat explicitly intends a prop to cover the active face */
  allowPropOverFace?: boolean;
  /** action requires the hero prop / active hand to be visible */
  requiresHeroProp?: boolean;
  disorientationIntended?: boolean;
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
  minWideSubjectHeight: number;
  minWideContentCoverage: number;
  minPropScreenSize: number;
  headHeight: Record<CameraIntent, [number, number]>;
  pathStep: number;
  grid: number;
  neutralAxisSin: number;
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
  minWideContentCoverage: 0.04,
  minPropScreenSize: 0.2,
  // projected head height as a fraction of frame height, per intent
  headHeight: {
    wide: [0, 0.2], medium: [0.06, 0.32], close: [0.18, 0.7], reaction: [0.18, 0.7],
    prop: [0, 10], over_shoulder: [0.08, 0.45], extreme_close: [0.35, 10],
  },
  pathStep: 0.05,
  grid: 24,
  neutralAxisSin: 0.2,
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
function projectBox(c: Cam, b: Bounds3): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, behind = false;
  for (const p of corners(b)) {
    const q = project(c, p);
    if (!(q.z > NEAR)) { behind = true; continue; }
    x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y);
  }
  return { x0, y0, x1, y1, behind };
}
const clip01 = (v: number) => clamp(v, 0, 1);
const clippedHeight = (r: Rect) => (isFinite(r.y0) ? Math.max(0, clip01(r.y1) - clip01(r.y0)) : 0);
const clippedWidth = (r: Rect) => (isFinite(r.x0) ? Math.max(0, clip01(r.x1) - clip01(r.x0)) : 0);

/** Project a world point for a candidate's first frame: x 0..1 left→right, y 0..1 top→bottom, z view depth (NaN x/y if behind). */
export function projectToScreen(cand: CameraCandidate, p: Vec3, aspect: number): { x: number; y: number; z: number } {
  return project(makeCam(cand.transform.position, cand.target, cand.fov, cand.transform.roll ?? 0, aspect), p);
}

// ───────────────────────────── scene index ─────────────────────────────

interface FaceFrame { entityId: string; center: Vec3; normal: Vec3; right: Vec3; up: Vec3; samples: Vec3[]; eyes: [Vec3, Vec3]; mouth: Vec3; head: Bounds3; headTop: Bounds3 }
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
  return { entityId: id, center, normal, right, up, samples, eyes, mouth, head, headTop };
}

/** is the segment cam→p blocked by any obstacle not excluded? returns blockers */
function blockers(ix: SceneIndex, from: Vec3, p: Vec3, exclude: (o: CameraObstacle) => boolean): CameraObstacle[] {
  const d = sub(p, from), out: CameraObstacle[] = [];
  for (const o of ix.scene.obstacles) {
    if (exclude(o)) continue;
    const h = rayBox(from, d, o.bounds);
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
  return {
    ...sd,
    previousCameraSide: end === 'left' || end === 'right' ? end : sd.previousCameraSide,
    previousWasNeutral: end === 'neutral',
    previousOrdering: ordering,
    previousMovementScreenX: mover ? Math.sign(dot(mover.movement!, cam.r)) || sd.previousMovementScreenX : sd.previousMovementScreenX,
    disorientationIntended: false,
  };
}

// ───────────────────────────── evaluation ─────────────────────────────

interface SampleEval {
  reasons: string[];
  face: Record<string, number>;
  prop: Record<string, number>;
  fg: number;
  d: Omit<CameraSafetyDiagnostics, 'minHeadDistance' | 'pathSamples' | 'cameraSide' | 'captionOverlapsActiveFace' | 'fallback'> & { captionOverlap: boolean; minHeadDist: number };
  sizeTerm: number;
}

const FACE_INTENTS = new Set<CameraIntent>(['medium', 'close', 'reaction', 'over_shoulder', 'extreme_close']);

function evaluateSample(ix: SceneIndex, cand: CameraCandidate, pos: Vec3, target: Vec3, roll: number, cfg: CameraSafetyConfig): SampleEval {
  const { scene } = ix;
  const cam = makeCam(pos, target, cand.fov, roll, ix.aspect);
  const reasons: string[] = [];
  const intent = cand.intent;
  const active = cand.activeSubjectId ?? ix.active;
  const required = [...new Set(scene.subjectIds)];
  const heroes = [...new Set(scene.heroPropIds)];
  // OTS foreground actor: explicit, or the required character (≠ active) nearest the lens
  let fgActor = cand.foregroundSubjectId;
  if (intent === 'over_shoulder' && !fgActor) {
    fgActor = required.filter((id) => id !== active && ix.faces.has(id)).sort((a, b) => len(sub(ix.faces.get(a)!.center, pos)) - len(sub(ix.faces.get(b)!.center, pos)) || (a < b ? -1 : 1))[0];
    if (!fgActor) reasons.push('OTS_NO_FOREGROUND_SUBJECT');
  }
  const focusIds = new Set<string>(intent === 'prop' ? heroes : required.filter((id) => id !== fgActor));
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
    const bl = blockers(ix, pos, p, (o) => o.entityId === id && o.type === 'head');
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
    const hr = projectBox(cam, f.headTop);
    headInFrame[id] = hr.behind || (isFinite(hr.x0) && hr.x1 > 0 && hr.x0 < 1 && hr.y1 > 0 && hr.y0 < 1);
    headScreenHeight[id] = r6(hr.behind || !isFinite(hr.y0) ? 10 : hr.y1 - hr.y0);
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
      const h = rayBox(pos, dir, o.bounds);
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
      const need = intent === 'extreme_close' ? cfg.ecuMinFaceVisibility : cfg.minFaceVisibility;
      if (face[active!] < need) reasons.push(`FACE_VISIBILITY_LOW:${active}:${face[active!]}<${need}`);
    }
  }
  if (af && intent !== 'prop' && face[active!] === 0 && !reasons.some((r) => r.startsWith('FACE_VISIBILITY_LOW'))) reasons.push(`ACTIVE_SUBJECT_HIDDEN:${active}`);
  if (af && !cand.allowPropOverFace && intent !== 'prop') {
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
  const heroNeed = intent === 'prop' || cand.requiresHeroProp;
  for (const id of heroes) {
    if (heroNeed && prop[id] < cfg.minHeroPropVisibility) reasons.push(`HERO_PROP_VISIBILITY_LOW:${id}:${prop[id]}<${cfg.minHeroPropVisibility}`);
    if (intent === 'wide' && prop[id] === 0) reasons.push(`WIDE_MISSING_HERO_PROP:${id}`);
  }

  // ── framing rules
  const [hMin, hMax] = cfg.headHeight[intent];
  let sizeTerm = 1;
  if (intent !== 'prop' && intent !== 'extreme_close') {
    for (const id of required) if (ix.faces.has(id) && id !== fgActor && headCropped[id] && (id === active || intent === 'wide' || headInFrame[id])) reasons.push(`HEAD_CROPPED:${id}`);
  }
  if (af && intent !== 'prop' && intent !== 'wide') {
    const hh = headScreenHeight[active!];
    if (hh < hMin) reasons.push(`SUBJECT_TOO_SMALL_FOR_INTENT:${active}:${hh.toFixed(3)}<${hMin}`);
    if (hh > hMax) reasons.push(`SHOT_TOO_TIGHT_FOR_INTENT:${active}:${hh.toFixed(3)}>${hMax}`);
    const ideal = hMax > 5 ? hMin * 1.3 : (hMin + hMax) / 2;
    sizeTerm = clamp(1 - Math.abs(hh - ideal) / Math.max(ideal, 1e-3), 0, 1);
  }
  if (intent === 'wide') {
    let content = 0;
    for (const id of required) {
      if (subjectScreenHeight[id] < cfg.minWideSubjectHeight) reasons.push(`WIDE_SUBJECT_TOO_SMALL:${id}:${(subjectScreenHeight[id] ?? 0).toFixed(3)}<${cfg.minWideSubjectHeight}`);
      content += entityCoverage[id] ?? 0;
    }
    for (const id of heroes) content += entityCoverage[id] ?? 0;
    if (content < cfg.minWideContentCoverage) reasons.push(`WIDE_EXCESSIVE_EMPTY_SPACE:${content.toFixed(3)}<${cfg.minWideContentCoverage}`);
    const minH = Math.min(...required.map((id) => subjectScreenHeight[id] ?? 0));
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
  if ((intent === 'close' || intent === 'reaction') && af) {
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

  // ── implied seated / waist-up constraints
  for (const id of required) {
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
    if (m.behindEntityId) {
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

  return {
    reasons, face, prop, fg, sizeTerm,
    d: { eyesVisible, mouthVisible, profile, headScreenHeight, subjectScreenHeight, headCropped, entityCoverage, propScreenSize, faceOccluders, captionOverlap, minHeadDist },
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
  const propTerm = heroes.length && (cand.intent === 'prop' || cand.requiresHeroProp || cand.intent === 'wide') ? Math.min(...heroes.map((h) => prop[h] ?? 0)) : 1;
  const clutterTerm = clamp(1 - fg / cfg.maxForegroundCoverage, 0, 1);
  const clearTerm = clamp(col.clearance / 0.5, 0, 1);
  const sizeTerm = Math.min(...evals.map((e) => e.sizeTerm));
  const dirTerm = dir.result.startsWith('consistent') || dir.result === 'no_axis' || dir.result.startsWith('established') ? 1 : 0.5;
  const score = r6(clamp(0.3 * faceTerm + 0.2 * propTerm + 0.2 * clutterTerm + 0.1 * clearTerm + 0.15 * sizeTerm + 0.05 * dirTerm - dir.penalty, 0, 1));
  const rejectionReasons = [...reasons];
  const sideLabel: Side = endSide;
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
    },
  };
}

// ───────────────────────────── fallbacks ─────────────────────────────

export type FallbackKind = 'frontal_medium' | 'two_character_medium' | 'elevated_wide' | 'prop_insert' | 'reaction_close';
export const FALLBACK_ORDER: FallbackKind[] = ['frontal_medium', 'two_character_medium', 'elevated_wide', 'prop_insert', 'reaction_close'];
const FALLBACK_PREFERENCE: Record<CameraIntent, FallbackKind[]> = {
  wide: ['elevated_wide', 'two_character_medium', 'frontal_medium'],
  medium: ['frontal_medium', 'two_character_medium'],
  close: ['reaction_close', 'frontal_medium'],
  reaction: ['reaction_close', 'frontal_medium'],
  extreme_close: ['reaction_close', 'frontal_medium'],
  prop: ['prop_insert', 'elevated_wide'],
  over_shoulder: ['two_character_medium', 'frontal_medium'],
};

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
  if (chars.length >= 2) {
    const a = centerOf(ix.faces.get(chars[0])!.head), b = centerOf(ix.faces.get(chars[1])!.head);
    const mid = scale(add(a, b), 0.5), ab = sub(b, a);
    let perp = norm(cross(UP, [ab[0], 0, ab[2]]));
    const avgN = add(ix.faces.get(chars[0])!.normal, ix.faces.get(chars[1])!.normal);
    const dn = dot(perp, avgN);
    if (dn < -1e-6 || (Math.abs(dn) <= 1e-6 && perp[2] < 0)) perp = scale(perp, -1); // toward the faces; tie → audience (+z)
    if (axis && sd?.previousCameraSide) { const s = sideOf(axis, add(mid, perp), cfg.neutralAxisSin); if (s !== 'neutral' && s !== sd.previousCameraSide) perp = scale(perp, -1); }
    const w = len([ab[0], 0, ab[2]]) / 2 + 0.55, fov = 38;
    const dist = w / (hfovTan(fov) * 0.92);
    out.push({ fallback: 'two_character_medium', id: 'fallback:two_character_medium', intent: 'medium', fov, activeSubjectId: active, transform: { position: add(add(mid, scale(perp, dist)), [0, -0.1, 0]) }, target: add(mid, [0, -0.35, 0]) });
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
    out.push({ fallback: 'reaction_close', id: 'fallback:reaction_close', intent: 'reaction', fov: 38, activeSubjectId: active, transform: { position: add(add(hc, scale(n, 1.0)), [0, 0.02, 0]) }, target: add(hc, [0, -0.05, 0]) });
  }
  return out;
}

// ───────────────────────────── selection ─────────────────────────────

export interface CameraEvaluation { candidate: CameraCandidate; result: CameraSafetyResult }
export type CameraSelection =
  | { ok: true; candidate: CameraCandidate; result: CameraSafetyResult; usedFallback: boolean; fallback?: FallbackKind; evaluations: CameraEvaluation[]; fallbackEvaluations: CameraEvaluation[] }
  | { ok: false; blocking: true; code: 'CAMERA_SAFETY_BLOCKED'; message: string; evaluations: CameraEvaluation[]; fallbackEvaluations: CameraEvaluation[] };

/**
 * Evaluate every candidate, keep the ones passing collision / occlusion / visibility / framing / screen direction,
 * pick the highest score (ties → lexicographic id). If none pass, try vetted fallbacks (preference by the requested
 * intent, then FALLBACK_ORDER) — each fully evaluated. If every fallback fails, return a blocking error.
 */
export function selectSafeCamera(scene: CameraSafetyScene, candidates: CameraCandidate[], cfg: CameraSafetyConfig = CAMERA_SAFETY_DEFAULTS): CameraSelection {
  const ix = indexScene(scene);
  const evaluations = [...candidates].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((c) => ({ candidate: c, result: evaluateIndexed(ix, c, cfg) }));
  const pick = (list: CameraEvaluation[]) => list.filter((e) => e.result.accepted).sort((a, b) => b.result.score - a.result.score || (a.candidate.id < b.candidate.id ? -1 : 1))[0];
  const best = pick(evaluations);
  if (best) return { ok: true, candidate: best.candidate, result: best.result, usedFallback: false, evaluations, fallbackEvaluations: [] };

  const intent = candidates[0]?.intent ?? 'medium';
  const order = [...new Set([...FALLBACK_PREFERENCE[intent], ...FALLBACK_ORDER])];
  const fbs = buildSafeFallbackCandidates(scene, cfg).sort((a, b) => order.indexOf(a.fallback) - order.indexOf(b.fallback));
  const fallbackEvaluations: CameraEvaluation[] = [];
  for (const fb of fbs) {
    const result = evaluateIndexed(ix, fb, cfg);
    result.diagnostics.fallback = fb.fallback;
    fallbackEvaluations.push({ candidate: fb, result });
    if (result.accepted) return { ok: true, candidate: fb, result, usedFallback: true, fallback: fb.fallback, evaluations, fallbackEvaluations };
  }
  const summary = [...evaluations, ...fallbackEvaluations].map((e) => `${e.candidate.id}: ${e.result.rejectionReasons.slice(0, 3).join('; ')}`).join(' | ');
  return { ok: false, blocking: true, code: 'CAMERA_SAFETY_BLOCKED', message: `no candidate or vetted fallback passed camera safety — ${summary}`, evaluations, fallbackEvaluations };
}

/** Throwing variant for pipelines that must never accept an unsafe camera. */
export function requireSafeCamera(scene: CameraSafetyScene, candidates: CameraCandidate[], cfg: CameraSafetyConfig = CAMERA_SAFETY_DEFAULTS) {
  const s = selectSafeCamera(scene, candidates, cfg);
  if (!s.ok) throw new Error(`CAMERA_SAFETY_BLOCKED: ${s.message}`);
  return s;
}
