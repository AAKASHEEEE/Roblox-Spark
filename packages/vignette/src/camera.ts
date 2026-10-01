// Beat cameras (S6): one shot per beat, from the beat's camera recipe, judged by camera safety on every sampled frame
// of the beat. Candidates that pass on every sample are ranked by script coverage (cast / props / events visible),
// then by the safety score. If no recipe variant passes, camera safety's own vetted fallbacks (fallbackChain of the
// recipe intent) are tried; if those fail too the beat is BLOCKED (the best-effort camera is kept for the still and
// named in the report). Screen direction carries across consecutive beats in the same set and resets on a set change.
import { applyShake } from '../../engine/src/camera.ts';
import { evaluateCameraCandidate, buildSafeFallbackCandidates, fallbackChain, nextScreenDirectionState, baseIntent, type CameraCandidate, type CameraIntent, type CameraSafetyResult, type ScreenDirectionState } from '../../engine/src/camera-safety.ts';
import type { CameraState } from '../../engine/src/gl/renderer.ts';
import type { Vec3 } from '../../engine/src/math.ts';
import { applyZoom, evalVfxEvents, type VfxEvent } from '../../engine/src/vfx/index.ts';
import type { CameraSubject } from '../../library/src/types.ts';
import { CAMERA_RECIPES, ASPECT, type RecipeCtx, type RecipePlan, type Variant } from './camera-recipes.ts';
import { frameGeometry, safetyScene, subjectOf, visibilityOf, boundsOf, projectedHeightFrac, projectPointFrom, type CamPose, type FrameGeometry, type SafetySpec } from './geometry.ts';
import type { VignetteScene } from './scene.ts';
import { actorPresent, type StagedBeat } from './stage.ts';

export const FRAME_W = 1080, FRAME_H = 1920;

export interface ShotSafetyContext {
  /** Exact semantic roles and incoming screen direction used to judge the selected composition. */
  spec: SafetySpec;
  /** Selected candidate flags (framed subjects, foreground, hero prop, profile, and scale-reference rules). */
  candidate: Partial<CameraCandidate>;
}

export interface ShotChoice {
  beat: string; recipeId: string; recipeKnown: boolean; intent: CameraIntent; motion: RecipePlan['motion']; framingFrom: number;
  source: 'recipe' | 'fallback' | 'blocked_best_effort'; candidateId: string; variant: Variant | null; fallback?: string;
  /** lens pose at beat-local time (piecewise-linear through the sampled poses for moving recipes) */
  keys: Array<{ lt: number; pose: CamPose }>;
  samples: Array<{ t: number; accepted: boolean; score: number; reasons: string[]; screenDirection: string }>;
  accepted: boolean; minScore: number; coverageAtSelection: number;
  evaluated: { candidates: number; accepted: number; fallbacks: number };
  rejectionSummary: Record<string, number>;
  subjects: { active: string; required: string[]; optional: string[]; heroProps: string[]; foreground?: string };
  diagnostics: { headHeightPct: Record<string, number>; faceVisibility: Record<string, number>; selfOccludedFeatures: string[]; faceAreaHairFree?: number; cameraSide: string };
  /** Serializable context required to re-evaluate the final, post-effect camera at arbitrary output-frame times. */
  safety: ShotSafetyContext;
}

/** One solved camera composition. Its interval is half-open: [start, end), except the final timeline end is queryable. */
export interface CameraComposition { beat: string; index: number; start: number; end: number; shot: ShotChoice; subject?: string; secondary?: string }

/**
 * Resolve the active composition by both start and end bounds. At a shared cut, the new composition wins; gaps and
 * out-of-range times return undefined rather than leaking the preceding shot into another interval.
 */
export function compositionAt(compositions: readonly CameraComposition[], t: number): CameraComposition | undefined {
  if (!Number.isFinite(t) || !compositions.length) return undefined;
  let lo = 0, hi = compositions.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (compositions[mid].start <= t) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (found < 0) return undefined;
  const c = compositions[found];
  const finalEnd = found === compositions.length - 1 && t === c.end;
  return t >= c.start && (t < c.end || finalEnd) ? c : undefined;
}

export type CameraHoldKind = 'authored' | 'leading-hold' | 'gap-hold' | 'tail-hold';
export interface HeldCameraComposition<T extends CameraComposition = CameraComposition> {
  composition: T;
  kind: CameraHoldKind;
}

/**
 * Deterministic render ownership: the first composition holds through leading pad, an authored composition owns its
 * half-open window, the preceding composition holds every inter-beat gap, and the final composition holds the output
 * tail. A finite time is therefore either owned explicitly or fails closed because there is no solved composition.
 */
export function heldCompositionAt<T extends CameraComposition>(compositions: readonly T[], t: number): HeldCameraComposition<T> | undefined {
  if (!Number.isFinite(t) || t < 0 || !compositions.length) return undefined;
  if (t < compositions[0].start) return { composition: compositions[0], kind: 'leading-hold' };
  let lo = 0, hi = compositions.length - 1, found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (compositions[mid].start <= t) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  const composition = compositions[found];
  if (t < composition.end) return { composition, kind: 'authored' };
  return { composition, kind: found === compositions.length - 1 ? 'tail-hold' : 'gap-hold' };
}

/** Stage sample paired with a held output camera; tail holds freeze the final stage-aligned frame, never an end sentinel. */
export function heldSceneTime(held: HeldCameraComposition, outputTime: number, stageEnd: number, fps = 30): number {
  if (held.kind === 'leading-hold') return held.composition.start;
  if (held.kind !== 'tail-hold') return outputTime;
  const finalStageFrame = (Math.ceil(stageEnd * fps - 1e-9) - 1) / fps;
  return Math.max(held.composition.start, finalStageFrame);
}

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const lerp3 = (a: Vec3, b: Vec3, u: number): Vec3 => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];

/** camera pose at absolute time t for a chosen shot */
export function poseAt(shot: ShotChoice, beatStart: number, t: number): CamPose {
  const lt = t - beatStart, k = shot.keys;
  if (lt <= k[0].lt || k.length === 1) return k[0].pose;
  for (let i = 1; i < k.length; i++) if (lt <= k[i].lt) { const u = (lt - k[i - 1].lt) / Math.max(1e-6, k[i].lt - k[i - 1].lt); return { pos: lerp3(k[i - 1].pose.pos, k[i].pose.pos, u), target: lerp3(k[i - 1].pose.target, k[i].pose.target, u), fovDeg: k[i - 1].pose.fovDeg + (k[i].pose.fovDeg - k[i - 1].pose.fovDeg) * u }; }
  return k[k.length - 1].pose;
}

export interface FinalCameraSafetyOptions {
  /** Additional render-layer VFX, applied after the vignette scene's own shake exactly as the S7 adapter does. */
  supplementalVfx?: readonly VfxEvent[];
  /** The vignette scene's built-in VFX/operator shake is part of the rendered camera by default. */
  includeSceneShake?: boolean;
  /** Posed scene time for a held camera. Omit for authored in-window evaluation. */
  sceneTime?: number;
  /** Ownership classification supplied by the shared hold resolver. */
  ownership?: CameraHoldKind;
  /** Previous final camera in the same held composition; its lens segment is collision checked. */
  previousCamera?: CameraState;
}
export interface FinalCameraSafetyFrame {
  t: number; sceneTime: number; beat: string; composition: number; ownership: CameraHoldKind | 'unowned'; accepted: boolean; score: number; reasons: string[];
  camera?: CameraState; result?: CameraSafetyResult;
  effects: { sceneShake: number; supplementalShake: number; zoom: number };
}
export interface DenseCameraSafetyReport {
  fps: number; frames: number; acceptedFrames: number; accepted: boolean; minScore: number;
  compositions: Array<{ beat: string; index: number; frames: number; acceptedFrames: number; minScore: number }>;
  samples: FinalCameraSafetyFrame[];
}

/**
 * Evaluate the actual rendered camera at one output time: solved/held lens, scene shake, then render-layer shake/zoom.
 * Held frames pose the scene at `sceneTime` while all deterministic camera effects retain the true output timestamp.
 */
export function evaluateFinalCameraAt(scene: VignetteScene, composition: CameraComposition, t: number, opts: FinalCameraSafetyOptions = {}): FinalCameraSafetyFrame {
  const sceneTime = opts.sceneTime ?? t;
  const ownership = opts.ownership ?? 'authored';
  const base = { t, sceneTime, beat: composition.beat, composition: composition.index, ownership, effects: { sceneShake: 0, supplementalShake: 0, zoom: 1 } };
  const held = opts.sceneTime !== undefined;
  if (!Number.isFinite(t) || !Number.isFinite(sceneTime) || sceneTime < 0 || sceneTime > scene.plan.duration + 1e-6 || (!held && (t < composition.start || t >= composition.end))) {
    return { ...base, accepted: false, score: 0, reasons: ['FINAL_CAMERA_TIME_OUTSIDE_COMPOSITION'] };
  }
  try {
    const shot = composition.shot;
    const posed = scene.pose(sceneTime);
    const cameraTime = held ? Math.max(composition.start, Math.min(composition.end, sceneTime)) : t;
    const p = poseAt(shot, composition.start, cameraTime);
    let camera: CameraState = { pos: p.pos, target: p.target, fovY: (p.fovDeg * Math.PI) / 180, ...(p.roll !== undefined ? { roll: p.roll } : {}) };
    let sceneShake = 0, supplementalShake = 0, zoom = 1;
    if (opts.includeSceneShake !== false) {
      sceneShake = scene.vfx(posed).shake;
      camera = applyShake(camera, sceneShake, t, scene.plan.seed);
    }
    if (opts.supplementalVfx !== undefined) {
      const fx = evalVfxEvents(opts.supplementalVfx, t, (id) => scene.entityPoint(id, posed.beat), scene.plan.seed);
      supplementalShake = fx.shake; zoom = fx.zoom;
      camera = applyZoom(applyShake(camera, supplementalShake, t, scene.plan.seed), zoom);
    }
    const safety = shot.safety;
    if (!safety) return { ...base, camera, effects: { sceneShake, supplementalShake, zoom }, accepted: false, score: 0, reasons: ['FINAL_CAMERA_SAFETY_CONTEXT_MISSING'] };
    const geo = frameGeometry(scene, posed);
    const candidate: CameraCandidate = {
      ...safety.candidate,
      id: `${shot.candidateId}@${r4(t)}`,
      transform: { position: camera.pos, ...(camera.roll !== undefined ? { roll: (camera.roll * 180) / Math.PI } : {}) },
      target: camera.target,
      fov: (camera.fovY * 180) / Math.PI,
      intent: shot.intent,
      activeSubjectId: safety.spec.active,
      ...(opts.previousCamera ? { lensPath: [opts.previousCamera.pos] } : {}),
    };
    const result = evaluateCameraCandidate(safetyScene(geo, safety.spec, FRAME_W, FRAME_H), candidate);
    const reasons = [...result.rejectionReasons];
    if (!shot.recipeKnown) reasons.push('CAMERA_RECIPE_UNRESOLVED');
    if (!shot.accepted || shot.source === 'blocked_best_effort') reasons.push('SHOT_SELECTION_BLOCKED');
    return {
      ...base, camera, result, effects: { sceneShake, supplementalShake, zoom }, score: result.score,
      accepted: result.accepted && shot.recipeKnown && shot.accepted && shot.source !== 'blocked_best_effort',
      reasons: [...new Set(reasons)],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...base, accepted: false, score: 0, reasons: [`FINAL_CAMERA_EVALUATION_ERROR:${message}`] };
  }
}

export interface DenseCameraSafetyOptions extends Omit<FinalCameraSafetyOptions, 'previousCamera' | 'sceneTime' | 'ownership'> {
  fps?: number;
  /** Exact encoded output-frame count. Defaults only to the frame-ceiled staged domain when a caller has no output plan. */
  frameCount?: number;
}

/** Audit each output frame exactly once under the same deterministic hold/effect policy used by rendering. */
export function auditFinalCameraSafety(scene: VignetteScene, compositions: readonly CameraComposition[], opts: DenseCameraSafetyOptions = {}): DenseCameraSafetyReport {
  const fps = opts.fps ?? 30;
  const frameCount = opts.frameCount ?? (Number.isFinite(fps) && fps > 0 ? Math.ceil(scene.plan.duration * fps - 1e-9) : 0);
  if (!(Number.isFinite(fps) && fps > 0 && Number.isInteger(frameCount) && frameCount > 0)) {
    return { fps, frames: 0, acceptedFrames: 0, accepted: false, minScore: 0, compositions: [], samples: [] };
  }
  const timelineValid = compositions.every((c, index) => Number.isFinite(c.start) && Number.isFinite(c.end) && c.start >= 0 && c.end > c.start
    && (index === 0 || c.start >= compositions[index - 1].end - 1e-9));
  const samples: FinalCameraSafetyFrame[] = [];
  let previousOwner: CameraComposition | undefined;
  let previousCamera: CameraState | undefined;
  for (let frame = 0; frame < frameCount; frame++) {
    const t = frame / fps;
    const held = heldCompositionAt(compositions, t);
    if (!held || !timelineValid) {
      samples.push({
        t, sceneTime: Math.min(t, scene.plan.duration), beat: held?.composition.beat ?? 'unowned', composition: held?.composition.index ?? -1,
        ownership: held?.kind ?? 'unowned', accepted: false, score: 0,
        reasons: [timelineValid ? 'FINAL_CAMERA_FRAME_UNOWNED' : 'COMPOSITION_TIMELINE_INVALID'],
        effects: { sceneShake: 0, supplementalShake: 0, zoom: 1 },
      });
      previousOwner = undefined; previousCamera = undefined;
      continue;
    }
    const composition = held.composition;
    if (composition !== previousOwner) previousCamera = undefined;
    const sceneTime = heldSceneTime(held, t, scene.plan.duration, fps);
    const sample = evaluateFinalCameraAt(scene, composition, t, {
      supplementalVfx: opts.supplementalVfx,
      includeSceneShake: opts.includeSceneShake,
      sceneTime,
      ownership: held.kind,
      ...(previousCamera ? { previousCamera } : {}),
    });
    samples.push(sample);
    previousOwner = composition;
    previousCamera = sample.camera;
  }
  const summaries = compositions.map((c) => {
    const local = samples.filter((s) => s.beat === c.beat && s.composition === c.index);
    const acceptedFrames = local.filter((s) => s.accepted).length;
    return { beat: c.beat, index: c.index, frames: local.length, acceptedFrames, minScore: local.length ? Math.min(...local.map((s) => s.score)) : 0 };
  });
  const acceptedFrames = samples.filter((s) => s.accepted).length;
  return {
    fps, frames: samples.length, acceptedFrames, accepted: samples.length === frameCount && acceptedFrames === frameCount,
    minScore: samples.length ? Math.min(...samples.map((s) => s.score)) : 0, compositions: summaries, samples,
  };
}

/** sparse solve-time sample times: in-window anchors plus selected events/contacts, never outside the beat */
export function beatSamples(b: StagedBeat, max = 8): number[] {
  const d = b.end - b.start;
  if (!(d > 0)) return [];
  const margin = Math.min(0.05, d / 4), S = b.start + margin, E = b.end - margin;
  const must = [S, (b.start + b.end) / 2, E];
  const keys = b.keyTimes.filter((t) => t > S && t < E && must.every((m) => Math.abs(m - t) > 0.15));
  const out = [...must];
  const step = Math.max(1, Math.ceil(keys.length / Math.max(1, max - must.length)));
  for (let i = 0; i < keys.length && out.length < max; i += step) if (out.every((m) => Math.abs(m - keys[i]) > 0.15)) out.push(keys[i]);
  return [...new Set(out.map(r4))].sort((a, b) => a - b);
}

interface SampleFrame { t: number; geo: FrameGeometry }
interface Cand { id: string; variant: Variant | null; intent: CameraIntent; plan: RecipePlan; poseAt: (lt: number) => CamPose; extras: Partial<CameraCandidate>; fallback?: string }

function unionSubject(samples: SampleFrame[], id: string): CameraSubject | undefined {
  const subs = samples.map((s) => subjectOf(s.geo, id)).filter(Boolean) as CameraSubject[];
  if (!subs.length) return undefined;
  const moved = Math.max(...subs.map((s) => Math.hypot(s.center[0] - subs[0].center[0], s.center[2] - subs[0].center[2])));
  const last = subs[subs.length - 1];
  if (moved < 0.3) return subs[Math.floor(subs.length / 2)];
  const b = boundsOf(subs.flatMap((s) => [[s.center[0] - s.radius, s.bottom[1], s.center[2] - s.radius], [s.center[0] + s.radius, s.top[1], s.center[2] + s.radius]] as Vec3[]));
  const c: Vec3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
  const heads = subs.filter((s) => s.head).map((s) => s.head!);
  return { center: c, ...(heads.length ? { head: [c[0], heads.reduce((a, h) => a + h[1], 0) / heads.length, c[2]] as Vec3 } : {}), top: [c[0], b.max[1], c[2]], bottom: [c[0], b.min[1], c[2]], radius: Math.max(b.max[0] - b.min[0], b.max[2] - b.min[2]) / 2, ...(last.facingYaw !== undefined ? { facingYaw: last.facingYaw } : {}) };
}

export interface BeatCameraInput { scene: VignetteScene; beat: StagedBeat; samples: SampleFrame[]; screenDirection?: ScreenDirectionState; waistUp: boolean }

/** coverage of the beat's cast + props over the sampled frames for one lens path (fraction of items seen in >= half their present samples) */
function quickCoverage(beat: StagedBeat, samples: SampleFrame[], pose: (lt: number) => CamPose): number {
  const items = [...beat.cast.map((c) => c.id), ...beat.props];
  let ok = 0;
  for (const id of items) {
    let present = 0, seen = 0;
    for (const s of samples) {
      if (!s.geo.actors[id] && !s.geo.props[id]) continue;
      present++;
      if (visibilityOf(s.geo, pose(s.t - beat.start), ASPECT, id).ok) seen++;
    }
    if (present && seen * 2 >= present) ok++;
  }
  return items.length ? ok / items.length : 1;
}

/** Produce a renderable diagnostic shot that is always blocking, rather than throwing or accepting vacuously. */
function failClosedCamera(inp: BeatCameraInput, reason: string, recipeKnown: boolean): { shot: ShotChoice; next: ScreenDirectionState | undefined } {
  const { scene, beat, samples } = inp;
  const first = samples[0]?.geo;
  const targetSubject = first ? subjectOf(first, beat.camera.subject) : undefined;
  const target: Vec3 = targetSubject ? [...targetSubject.center] as Vec3 : [0, 1, 0];
  const set = scene.stack.get(beat.setId);
  const rawPos: Vec3 = [target[0], target[1] + 0.25, target[2] + 3];
  const pos: Vec3 = set ? [Math.max(set.safeMin[0], Math.min(set.safeMax[0], rawPos[0])), Math.max(set.safeMin[1], Math.min(set.safeMax[1], rawPos[1])), Math.max(set.safeMin[2], Math.min(set.safeMax[2], rawPos[2]))] : rawPos;
  const pose: CamPose = { pos, target, fovDeg: 50 };
  const code = reason.split(':')[0];
  const spec: SafetySpec = {
    active: beat.camera.subject,
    subjects: [beat.camera.subject, ...(beat.camera.secondary ? [beat.camera.secondary] : [])],
    optional: [], heroProps: [], waistUp: inp.waistUp,
    ...(inp.screenDirection ? { screenDirection: inp.screenDirection } : {}),
  };
  const shot: ShotChoice = {
    beat: beat.phraseId, recipeId: beat.camera.recipeId, recipeKnown, intent: 'medium', motion: 'static', framingFrom: 0,
    source: 'blocked_best_effort', candidateId: `blocked:${beat.camera.recipeId}`, variant: null, keys: [{ lt: 0, pose }],
    samples: [{ t: samples[0]?.t ?? (beat.start + beat.end) / 2, accepted: false, score: 0, reasons: [reason], screenDirection: 'unavailable' }],
    accepted: false, minScore: 0, coverageAtSelection: 0, evaluated: { candidates: 0, accepted: 0, fallbacks: 0 },
    rejectionSummary: { [code]: 1 },
    subjects: { active: beat.camera.subject, required: spec.subjects, optional: [], heroProps: [] },
    diagnostics: { headHeightPct: {}, faceVisibility: {}, selfOccludedFeatures: [], cameraSide: 'none' },
    safety: { spec, candidate: {} },
  };
  return { shot, next: inp.screenDirection };
}

export function solveBeatCamera(inp: BeatCameraInput): { shot: ShotChoice; next: ScreenDirectionState | undefined } {
  const { scene, beat, samples } = inp;
  const recipe = CAMERA_RECIPES[beat.camera.recipeId];
  const recipeKnown = !!recipe && !recipe.planned;
  if (!recipeKnown) return failClosedCamera(inp, `CAMERA_RECIPE_UNRESOLVED:${beat.camera.recipeId}`, false);
  if (!samples.length) return failClosedCamera(inp, 'CAMERA_SAMPLES_EMPTY', true);
  const subjectId = beat.camera.subject, secondaryId = beat.camera.secondary;
  const subject = unionSubject(samples, subjectId);
  if (!subject) return failClosedCamera(inp, `CAMERA_SUBJECT_ABSENT:${subjectId}`, true);
  const secondary = secondaryId ? unionSubject(samples, secondaryId) : undefined;
  try {
    const mid = samples[Math.floor(samples.length / 2)];
    // Preserve the identity/order of the established action axis even when the next beat lists the same actors in a
    // different cast order. Without an explicit axis, the engine re-derives A→B from array order and left/right flips.
    const priorAxisIds = inp.screenDirection?.actors?.slice(0, 2).map((a) => a.id) ?? [];
    const priorAxisSubjects = priorAxisIds.map((id) => subjectOf(mid.geo, id));
    const screenDirection = priorAxisSubjects.length === 2 && priorAxisSubjects.every(Boolean)
      ? { ...inp.screenDirection, axis: [priorAxisSubjects[0]!.center, priorAxisSubjects[1]!.center] as [Vec3, Vec3] }
      : inp.screenDirection;
    const kindOf = (id: string) => (samples.some((s) => s.geo.actors[id]) ? 'character' : 'prop') as 'character' | 'prop';
    const castIds = beat.cast.map((c) => c.id), propIds = beat.props;
    const set = scene.stack.get(beat.setId);
    if (!set) return failClosedCamera(inp, `CAMERA_SET_UNAVAILABLE:${beat.setId}`, true);
  // content for wides: every present cast member and prop, over the beat (the door when a door event happens)
  const contentPts: Vec3[] = [];
  for (const s of samples) for (const id of [...castIds, ...propIds]) { const x = subjectOf(s.geo, id); if (x) contentPts.push([x.center[0] - x.radius, x.bottom[1], x.center[2] - x.radius], [x.center[0] + x.radius, x.top[1], x.center[2] + x.radius]); }
  const content = contentPts.length ? boundsOf(contentPts) : { min: subject.bottom, max: subject.top };
  const viewerId = castIds.find((id) => id !== subjectId && beat.cast.find((c) => c.id === id)?.lookAt === subjectId);
  const ctx: RecipeCtx = {
    d: beat.end - beat.start, subject, subjectKind: kindOf(subjectId), ...(secondary ? { secondary, secondaryKind: kindOf(secondaryId!) } : {}), content,
    ...(viewerId ? { viewer: unionSubject(samples, viewerId) } : {}),
    actorsNear: castIds.some((id) => id !== subjectId && samples.some((sm) => { const a = sm.geo.actors[id], s0 = subjectOf(sm.geo, subjectId); return !!a && !!s0 && Math.hypot((a.body.min[0] + a.body.max[0]) / 2 - s0.center[0], (a.body.min[2] + a.body.max[2]) / 2 - s0.center[2]) < s0.radius + 2.5; })),
    subjectAt: (lt) => { const t = beat.start + lt; const s = samples.reduce((a, x) => (Math.abs(x.t - t) < Math.abs(a.t - t) ? x : a), samples[0]); return subjectOf(s.geo, subjectId); },
    safeMin: set.safeMin, safeMax: set.safeMax, seed: scene.plan.seed,
  };
  const plan = recipe.plan(ctx);
  if (secondaryId && !secondary && (plan.secondaryRole === 'required' || plan.secondaryRole === 'foreground')) return failClosedCamera(inp, `CAMERA_SECONDARY_ABSENT:${secondaryId}`, true);
  // subject roles for camera safety
  const others = castIds.filter((id) => id !== subjectId && id !== secondaryId);
  const secRequired = plan.secondaryRole === 'required' && !!secondaryId;
  const heroProps = [...(plan.heroSubject && kindOf(subjectId) === 'prop' ? [subjectId] : []), ...(plan.secondaryRole === 'foreground' && secondaryId && kindOf(secondaryId) === 'prop' ? [] : [])];
  const spec: SafetySpec = {
    active: subjectId,
    subjects: [subjectId, ...(secondaryId && plan.secondaryRole !== 'none' ? [secondaryId] : []), ...(plan.secondaryRole === 'none' || plan.intent === 'neutral_top_down_prop_insert' ? [] : others)],
    optional: [...(secondaryId && !secRequired && plan.secondaryRole !== 'foreground' ? [secondaryId] : []), ...others],
    heroProps, waistUp: inp.waistUp, ...(screenDirection ? { screenDirection } : {}),
  };
  // scale reveal: the nearest character of the beat reads as the scale reference (and is fitted into the frame)
  const nearestChar = castIds.filter((id) => id !== subjectId && mid.geo.actors[id]).map((id) => { const a = mid.geo.actors[id]; return { id, d: Math.hypot((a.body.min[0] + a.body.max[0]) / 2 - subject.center[0], (a.body.min[2] + a.body.max[2]) / 2 - subject.center[2]) }; }).sort((a, b) => a.d - b.d || (a.id < b.id ? -1 : 1))[0];
  const scaleRef = plan.intent === 'scale_reveal' && nearestChar && nearestChar.d < subject.radius + 3 ? nearestChar.id : undefined;
  const extras: Partial<CameraCandidate> = { ...plan.extras, ...(scaleRef ? { scaleReferenceIds: [scaleRef] } : plan.intent === 'scale_reveal' ? { scaleReferenceIds: [] } : {}), ...(secRequired ? { framedSubjectIds: [subjectId, secondaryId!] } : {}), ...(plan.secondaryRole === 'foreground' && secondaryId ? { foregroundSubjectId: secondaryId } : {}) };
  // framing is judged where the recipe frames (after a whip pan) and while the active subject is on screen
  const subjPresent = (s: SampleFrame) => !!s.geo.actors[subjectId] || !!s.geo.props[subjectId];
  const framed = samples.filter((s) => s.t - beat.start >= plan.framingFrom - 1e-9);
  const frames = framed.some(subjPresent) ? framed.filter(subjPresent) : framed;
  if (!frames.length) return failClosedCamera(inp, `CAMERA_FRAMING_WINDOW_EMPTY:${plan.framingFrom}`, true);
  const scenes = new Map(frames.map((s) => [s.t, safetyScene(s.geo, spec, FRAME_W, FRAME_H)]));

  const evaluate = (c: Cand) => {
    let prev: CamPose | null = null;
    const out: Array<{ t: number; r: CameraSafetyResult }> = [];
    for (const s of frames) {
      const p = c.poseAt(s.t - beat.start);
      const cand: CameraCandidate = { id: c.id, transform: { position: p.pos, ...(p.roll ? { roll: p.roll } : {}) }, target: p.target, fov: p.fovDeg, intent: c.intent, activeSubjectId: spec.active, ...c.extras, ...(prev && plan.motion !== 'static' ? { lensPath: [prev.pos] } : {}) };
      out.push({ t: s.t, r: evaluateCameraCandidate(scenes.get(s.t)!, cand) });
      prev = p;
    }
    return out;
  };
  // ---- calibration on the POSED geometry: head-size bands on the subject's real head (hair included), and distance fit
  // so every point a wide / two-shot must show stays inside the frame across all samples
  const headPts = (t: number): Vec3[] => { const s = samples.reduce((a, x) => (Math.abs(x.t - t) < Math.abs(a.t - t) ? x : a), samples[0]); return s.geo.actors[subjectId]?.headCorners ?? []; };
  const fitPtsFor = (fit: 'content' | 'pair' | undefined): Vec3[] => {
  const fitPts: Vec3[] = [];
  const pairIds = [subjectId, ...(secondaryId ? [secondaryId] : scaleRef ? [scaleRef] : [])];
  if (fit) for (const s of samples) for (const id of fit === 'pair' ? pairIds : [...castIds, ...propIds]) {
    const a = s.geo.actors[id], pr = s.geo.props[id];
    if (a) fitPts.push(...a.headCorners, [(a.body.min[0] + a.body.max[0]) / 2, fit === 'pair' ? a.head.min[1] - 0.25 : a.body.min[1], (a.body.min[2] + a.body.max[2]) / 2]);
    else if (pr) { const b = pr.bounds; for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) fitPts.push([x, y, z]); }
  }
  return fitPts;
  };
  const scaleAbout = (p: CamPose, c: Vec3, k: number): CamPose => ({ ...p, pos: [c[0] + (p.pos[0] - c[0]) * k, c[1] + (p.pos[1] - c[1]) * k, c[2] + (p.pos[2] - c[2]) * k] });
  const inside = (p: CamPose, fitPts: Vec3[]) => fitPts.every((q) => { const s = projectPointFrom(p, q, ASPECT); return s.z > 0.05 && s.x >= 0.04 && s.x <= 0.96 && s.y >= 0.05 && s.y <= 0.96; });
  const calibrated = (v: Variant): ((lt: number) => CamPose) => {
    const raw = (lt: number) => recipe.pose(ctx, v, lt);
    let k = 1;
    if (plan.headSize && kindOf(subjectId) === 'character' && !v.intent) {
      const lt = mid.t - beat.start, p = raw(lt), hp = headPts(mid.t), want = plan.headSize(v, lt), got = projectedHeightFrac(p, hp, ASPECT);
      if (got > 0.01 && want > 0) k = got / want;
    }
    let f = 1;
    const fitPts = fitPtsFor(v.fit ?? plan.fit ?? (scaleRef ? 'pair' : undefined));
    if (fitPts.length) {
      const p0 = raw(0), c = p0.target;
      let lo = 0.55, hi = 3.2;
      if (!inside(scaleAbout(p0, c, hi), fitPts)) f = hi;
      else { for (let i = 0; i < 18; i++) { const m = (lo + hi) / 2; if (inside(scaleAbout(p0, c, m), fitPts)) hi = m; else lo = m; } f = hi * 1.02; }
    }
    return (lt: number) => {
      let p = raw(lt);
      if (k !== 1) { const hp = headPts(beat.start + lt); const hc: Vec3 = hp.length ? [hp.reduce((a, q) => a + q[0], 0) / hp.length, hp.reduce((a, q) => a + q[1], 0) / hp.length, hp.reduce((a, q) => a + q[2], 0) / hp.length] : p.target; p = scaleAbout(p, hc, k); }
      if (f !== 1) p = scaleAbout(p, p.target, f);
      return { ...p, pos: [Math.max(set.safeMin[0], Math.min(set.safeMax[0], p.pos[0])), Math.max(set.safeMin[1], Math.min(set.safeMax[1], p.pos[1])), Math.max(set.safeMin[2], Math.min(set.safeMax[2], p.pos[2]))] };
    };
  };
  // every calibrated single also tries a longer and a wider lens: the head size stays in band, the background (and
  // who is half in frame at its edges) changes
  const base = recipe.variants(ctx);
  const variants = plan.headSize && kindOf(subjectId) === 'character' ? base.flatMap((v) => (v.intent ? [v] : [v, { ...v, fov: v.fov - 8, id: `${v.id}_n` }, { ...v, fov: v.fov + 8, id: `${v.id}_w` }])) : base;
  const cands: Cand[] = variants.map((v) => ({ id: `${recipe.id}:${v.id}`, variant: v, intent: v.intent ?? plan.intent, plan, poseAt: calibrated(v), extras: v.intent && v.intent !== plan.intent ? { ...extras, requiresHeroProp: false } : extras }));
  const results = cands.map((c) => ({ c, ev: evaluate(c) }));
  const rank = (list: typeof results) => list.map((x) => ({ ...x, ok: x.ev.length > 0 && x.ev.every((e) => e.r.accepted), minScore: x.ev.length ? Math.min(...x.ev.map((e) => e.r.score)) : 0, fails: x.ev.filter((e) => !e.r.accepted).length, cov: quickCoverage(beat, samples, x.c.poseAt) }))
    .sort((a, b) => Number(b.ok) - Number(a.ok) || (a.ok ? b.cov - a.cov : a.fails - b.fails || b.cov - a.cov) || b.minScore - a.minScore || (a.c.id < b.c.id ? -1 : 1));
  let ranked = rank(results);
  let source: ShotChoice['source'] = 'recipe', fallbackKind: string | undefined, nFallback = 0;
  if (!ranked[0]?.ok) {
    // camera safety's vetted fallbacks, built on the middle sample, judged on every sample
    const chain = fallbackChain(baseIntent(plan.intent), secRequired || castIds.length >= 2);
    const midScene = scenes.get(frames[Math.floor(frames.length / 2)]?.t ?? mid.t) ?? safetyScene(mid.geo, spec, FRAME_W, FRAME_H);
    const fbs = buildSafeFallbackCandidates(midScene).filter((f) => chain.includes(f.fallback)).sort((a, b) => chain.indexOf(a.fallback) - chain.indexOf(b.fallback));
    nFallback = fbs.length;
    const fres = fbs.map((f) => ({ c: { id: f.id, variant: null, intent: f.intent, plan, fallback: f.fallback, poseAt: () => ({ pos: f.transform.position, target: f.target, fovDeg: f.fov }), extras: { ...(f.framedSubjectIds ? { framedSubjectIds: f.framedSubjectIds } : {}) } } as Cand, ev: [] as Array<{ t: number; r: CameraSafetyResult }> }));
    for (const x of fres) { x.ev = evaluate(x.c); if (x.ev.every((e) => e.r.accepted)) break; }
    const okFb = rank(fres.filter((x) => x.ev.length)).find((x) => x.ok);
    if (okFb) { ranked = [okFb, ...ranked]; source = 'fallback'; fallbackKind = okFb.c.fallback; }
    else source = 'blocked_best_effort';
  }
  const best = ranked[0];
  if (!best) return failClosedCamera(inp, 'CAMERA_CANDIDATES_EMPTY', true);
  const keysAt = plan.motion === 'static' ? [0] : [...new Set([0, ...samples.map((s) => r4(s.t - beat.start)), ...(plan.motion === 'pan' ? [0.1, 0.2, 0.35] : plan.motion === 'punch' ? [0.1, 0.2, 0.3] : []), r4(beat.end - beat.start)])].sort((a, b) => a - b);
  const keys = keysAt.map((lt) => ({ lt, pose: best.c.poseAt(lt) }));
  const rej: Record<string, number> = {};
  for (const x of results) for (const e of x.ev) for (const r of e.r.rejectionReasons) { const k = r.split(':')[0]; rej[k] = (rej[k] ?? 0) + 1; }
  const last = best.ev[best.ev.length - 1]?.r, lastScene = scenes.get(frames[frames.length - 1]?.t ?? mid.t);
  const lastPose = best.c.poseAt((frames[frames.length - 1]?.t ?? mid.t) - beat.start);
  const next = lastScene ? nextScreenDirectionState(lastScene, { ...best.c.extras, id: best.c.id, transform: { position: lastPose.pos, ...(lastPose.roll !== undefined ? { roll: lastPose.roll } : {}) }, target: lastPose.target, fov: lastPose.fovDeg, intent: best.c.intent, activeSubjectId: spec.active }) : inp.screenDirection;
  const shot: ShotChoice = {
    beat: beat.phraseId, recipeId: beat.camera.recipeId, recipeKnown, intent: best.c.intent, motion: best.c.fallback ? 'static' : plan.motion, framingFrom: plan.framingFrom, source,
    candidateId: best.c.id, variant: best.c.variant, ...(fallbackKind ? { fallback: fallbackKind } : {}), keys,
    samples: best.ev.map((e) => ({ t: e.t, accepted: e.r.accepted, score: e.r.score, reasons: e.r.rejectionReasons, screenDirection: e.r.screenDirectionResult })),
    accepted: best.ok, minScore: r4(best.minScore), coverageAtSelection: r4(best.cov),
    evaluated: { candidates: results.length, accepted: results.filter((x) => x.ev.length > 0 && x.ev.every((e) => e.r.accepted)).length, fallbacks: nFallback },
    rejectionSummary: rej,
    subjects: { active: spec.active, required: spec.subjects.filter((s) => !spec.optional.includes(s)), optional: spec.optional, heroProps: spec.heroProps, ...(best.c.extras.foregroundSubjectId ? { foreground: best.c.extras.foregroundSubjectId } : {}) },
    diagnostics: { headHeightPct: last?.diagnostics.requiredHeadHeightPct ?? {}, faceVisibility: last?.faceVisibility ?? {}, selfOccludedFeatures: last?.diagnostics.selfOccludedFeatures ?? [], ...(last?.diagnostics.faceAreaHairFree !== undefined ? { faceAreaHairFree: last.diagnostics.faceAreaHairFree } : {}), cameraSide: last?.diagnostics.cameraSide ?? 'none' },
    safety: { spec, candidate: best.c.extras },
  };
  return { shot, next };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failClosedCamera(inp, `CAMERA_SOLVE_ERROR:${message}`, true);
  }
}

/** pose + geometry for the beat's samples (the scene is left posed at the last sample) */
export function sampleBeat(scene: VignetteScene, beat: StagedBeat, times: number[]): SampleFrame[] {
  return times.map((t) => { const f = scene.pose(t); return { t, geo: frameGeometry(scene, f) }; });
}

export { actorPresent };
