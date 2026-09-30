// Camera recipes (S6). Every recipe is a CameraRecipe (packages/library/src/types.ts): a deterministic solve() for its
// default framing, plus a family of variants (angle / size / height) that the beat camera (camera.ts) evaluates with the
// camera-safety evaluator (packages/engine/src/camera-safety.ts) on every sampled frame. A recipe never bypasses safety:
// it only proposes lens paths and says which safety intent and subject roles judge them.
// Every S6 recipe below is now registered as available; each candidate still goes through camera safety before use.
import type { CameraIntent, CameraCandidate } from '../../engine/src/camera-safety.ts';
import type { CameraRecipe, CameraSubject } from '../../library/src/types.ts';
import type { Vec3 } from '../../engine/src/math.ts';
import type { CamPose } from './geometry.ts';

export const RECIPE_VERSION = '1.0.0';
export const ASPECT = 9 / 16;
const DEG = Math.PI / 180;
const HEAD_H = 0.62; // block head + hair, projected height used for head-size bands

export type Motion = 'static' | 'dolly' | 'punch' | 'pan' | 'track';
export interface Variant { id: string; yaw: number; size: number; size1?: number; height: number; fov: number; side?: number; /** per-variant safety intent (a recipe family with a tight and a context framing) */ intent?: CameraIntent; fit?: 'content' | 'pair' }
/** what a recipe needs to know about the beat to propose lens paths */
export interface RecipeCtx {
  d: number;
  subject: CameraSubject;
  subjectKind: 'character' | 'prop';
  secondary?: CameraSubject;
  secondaryKind?: 'character' | 'prop';
  /** union of everything the beat should show (present cast + props), for wides */
  content: { min: Vec3; max: Vec3 };
  /** a character looking at the subject (POV source) */
  viewer?: CameraSubject;
  /** characters of the beat within 3 m of the subject (a top-down over them is a geography wide, not a neutral insert) */
  actorsNear?: boolean;
  /** the subject at time lt (tracking recipes) */
  subjectAt?: (lt: number) => CameraSubject | undefined;
  safeMin: Vec3; safeMax: Vec3; seed: number;
}
export interface RecipePlan {
  intent: CameraIntent;
  motion: Motion;
  /** framing rules apply from this local time (whip pan: after the pan) */
  framingFrom: number;
  /** extra camera-safety candidate fields */
  extras: Partial<Pick<CameraCandidate, 'framedSubjectIds' | 'requiresHeroProp' | 'profileScale' | 'eyelineTargetId' | 'scaleReferenceIds' | 'foregroundSubjectId'>>;
  /** subject roles: 'secondary_required' (two-shot), 'foreground' (OTS), 'none' */
  secondaryRole: 'required' | 'foreground' | 'optional' | 'none';
  heroSubject: boolean;
  /** character singles: head height (fraction of frame) the variant asks for at lt — the beat camera calibrates the
   *  lens distance on the posed head so the measured size matches (block heads + hair differ per character) */
  headSize?: (v: Variant, lt: number) => number;
  /** distance fitted on the posed geometry so these points stay inside the frame: every entity of the beat (wides) or
   *  subject + secondary (two-shots) */
  fit?: 'content' | 'pair';
}
export interface VignetteCameraRecipe extends CameraRecipe {
  planned: boolean;
  description: string;
  plan(ctx: RecipeCtx): RecipePlan;
  variants(ctx: RecipeCtx): Variant[];
  /** lens pose at local time lt for a variant */
  pose(ctx: RecipeCtx, v: Variant, lt: number): CamPose;
}

// ---------------------------------------------------------------- geometry helpers
const add = (a: readonly number[], b: readonly number[]): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: readonly number[], b: readonly number[]): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scl = (a: readonly number[], k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const len2 = (a: readonly number[]) => Math.hypot(a[0], a[2]);
const dirYaw = (yawDeg: number): Vec3 => [Math.sin(yawDeg * DEG), 0, Math.cos(yawDeg * DEG)];
const yawOf = (v: readonly number[]) => Math.atan2(v[0], v[2]) / DEG;
const tanV = (fov: number) => Math.tan((fov * DEG) / 2);
const tanH = (fov: number) => tanV(fov) * ASPECT;
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
const smooth = (u: number) => { const x = Math.max(0, Math.min(1, u)); return x * x * (3 - 2 * x); };
const headOf = (s: CameraSubject): Vec3 => s.head ?? [s.center[0], s.top[1] - 0.25, s.center[2]];
/** distance at which a head of HEAD_H fills `frac` of the frame height */
const distForHead = (frac: number, fov: number) => HEAD_H / (frac * 2 * tanV(fov));
/** facing used as "front": the subject's face yaw, or the audience (+z) for props without an identity face */
const frontYaw = (s: CameraSubject) => s.facingYaw ?? 0;
/** keep the camera on the audience side of a character facing away from it (never shoot the back of a head) */
function frontalYaw(s: CameraSubject, kind: 'character' | 'prop'): number {
  const y = frontYaw(s);
  if (kind === 'prop') return Math.abs(((y % 360) + 540) % 360 - 180) > 110 ? 0 : y; // identity face turned away: audience
  return y;
}
const clampSafe = (p: Vec3, c: RecipeCtx): Vec3 => [Math.max(c.safeMin[0], Math.min(c.safeMax[0], p[0])), Math.max(c.safeMin[1], Math.min(c.safeMax[1], p[1])), Math.max(c.safeMin[2], Math.min(c.safeMax[2], p[2]))];
const grid = (yaws: number[], sizes: number[], heights: number[], fovs: number[], extra: Partial<Variant> = {}): Variant[] => {
  const out: Variant[] = [];
  for (const yaw of yaws) for (const size of sizes) for (const height of heights) for (const fov of fovs) out.push({ id: `y${yaw}_s${size}_h${height}_f${fov}`, yaw, size, height, fov, ...extra });
  return out;
};

/** a single on a character: head-size band `size`, lens height offset `height` (m, relative to the eyes) */
function singlePose(c: RecipeCtx, s: CameraSubject, kind: 'character' | 'prop', v: Variant, size: number, tgtDrop: number): CamPose {
  if (kind === 'prop') return propPose(c, s, v, size);
  const h = headOf(s), yaw = frontalYaw(s, kind) + v.yaw, d = distForHead(size, v.fov);
  const pos = add(h, add(scl(dirYaw(yaw), d), [0, v.height, 0]));
  return { pos: clampSafe(pos, c), target: add(h, [0, -tgtDrop, 0]), fovDeg: v.fov };
}
/** a prop filling `size` of the frame (larger of width / height), from `height` degrees of elevation */
function propPose(c: RecipeCtx, s: CameraSubject, v: Variant, size: number): CamPose {
  const r = Math.max(s.radius, 0.05), yaw = frontalYaw(s, 'prop') + v.yaw, el = v.height * DEG;
  const dist = Math.max((2 * r) / (size * 2 * Math.min(tanV(v.fov), tanH(v.fov))), 0.45);
  const dir: Vec3 = [Math.sin(yaw * DEG) * Math.cos(el), Math.sin(el), Math.cos(yaw * DEG) * Math.cos(el)];
  return { pos: clampSafe(add(s.center, scl(dir, dist)), c), target: [...s.center] as Vec3, fovDeg: v.fov };
}
/** fit a box (wide): elevation `height` deg, yaw offset around the audience axis */
function widePose(c: RecipeCtx, box: { min: Vec3; max: Vec3 }, v: Variant, pad = 1.12): CamPose {
  const ctr: Vec3 = scl(add(box.min, box.max), 0.5), hw = ((box.max[0] - box.min[0]) / 2 + 0.3) * pad, hh = ((box.max[1] - box.min[1]) / 2 + 0.25) * pad, hd = (box.max[2] - box.min[2]) / 2;
  const el = v.height * DEG, yaw = v.yaw;
  const dist = Math.max(hw / tanH(v.fov), hh / tanV(v.fov)) + hd;
  const dir: Vec3 = [Math.sin(yaw * DEG) * Math.cos(el), Math.sin(el), Math.cos(yaw * DEG) * Math.cos(el)];
  return { pos: clampSafe(add(ctr, scl(dir, dist)), c), target: ctr, fovDeg: v.fov };
}

// ---------------------------------------------------------------- recipe table
type Def = Omit<VignetteCameraRecipe, 'kind' | 'version' | 'solve'>;
const R = (d: Def): VignetteCameraRecipe => ({
  ...d, kind: 'camera', version: RECIPE_VERSION,
  // library contract: default variant, subject + secondary only (content = their union)
  solve(x) {
    const content = { min: [Math.min(x.subject.bottom[0], x.secondary?.bottom[0] ?? Infinity, x.subject.center[0] - x.subject.radius), Math.min(x.subject.bottom[1], x.secondary?.bottom[1] ?? Infinity), Math.min(x.subject.center[2] - x.subject.radius, (x.secondary?.center[2] ?? Infinity) - (x.secondary?.radius ?? 0))] as Vec3, max: [Math.max(x.subject.center[0] + x.subject.radius, (x.secondary?.center[0] ?? -Infinity) + (x.secondary?.radius ?? 0)), Math.max(x.subject.top[1], x.secondary?.top[1] ?? -Infinity), Math.max(x.subject.center[2] + x.subject.radius, (x.secondary?.center[2] ?? -Infinity) + (x.secondary?.radius ?? 0))] as Vec3 };
    const ctx: RecipeCtx = { d: x.d, subject: x.subject, subjectKind: x.subject.head ? 'character' : 'prop', ...(x.secondary ? { secondary: x.secondary, secondaryKind: x.secondary.head ? 'character' : 'prop' } : {}), content, safeMin: x.safeMin, safeMax: x.safeMax, seed: x.seed };
    const v = d.variants(ctx)[0];
    const p = d.pose(ctx, v, x.lt);
    return { pos: p.pos, target: p.target, fovDeg: p.fovDeg, ...(p.roll ? { roll: p.roll } : {}) };
  },
});
const charOrProp = (c: RecipeCtx, charIntent: CameraIntent): CameraIntent => (c.subjectKind === 'prop' ? 'prop' : charIntent);

export const CAMERA_RECIPES: Record<string, VignetteCameraRecipe> = {
  // ---------------- S6 vignette recipes
  hook_closeup: R({
    id: 'hook_closeup', planned: false, subjects: 1, description: 'Opening hook close-up on the lead: frontal, head fills ~38% of frame, eye-level',
    plan: (c) => ({ intent: charOrProp(c, 'close'), motion: 'static', framingFrom: 0, extras: {}, secondaryRole: 'optional', heroSubject: c.subjectKind === 'prop', ...(c.subjectKind === 'character' ? { headSize: (v: Variant) => v.size } : {}) }),
    variants: (c) => grid([0, 15, -15, 30, -30], c.subjectKind === 'prop' ? [0.55] : [0.34, 0.42], [0.0], [38]),
    pose: (c, v) => singlePose(c, c.subject, c.subjectKind, v, v.size, 0.04),
  }),
  establishing_wide: R({
    id: 'establishing_wide', planned: false, subjects: 1, description: 'Establishing wide of the set: whole cast + props, elevated 14-24 deg, audience side',
    plan: (c) => ({ intent: 'wide', motion: 'static', framingFrom: 0, extras: {}, secondaryRole: 'optional', heroSubject: c.subjectKind === 'prop', fit: 'content' }),
    variants: () => grid([0, 15, -15, 30, -30], [1], [16, 24], [46, 56]),
    pose: (c, v) => widePose(c, c.content, v),
  }),
  medium_single: R({
    id: 'medium_single', planned: false, subjects: 1, description: 'Medium single: chest-up, head ~24% of frame, others optional',
    plan: (c) => ({ intent: charOrProp(c, 'medium'), motion: 'static', framingFrom: 0, extras: {}, secondaryRole: 'optional', heroSubject: c.subjectKind === 'prop', ...(c.subjectKind === 'character' ? { headSize: (v: Variant) => v.size } : {}) }),
    variants: (c) => grid([0, 20, -20, 35, -35, 50, -50], c.subjectKind === 'prop' ? [0.4] : [0.22, 0.27], [-0.08, 0.2], [38]),
    pose: (c, v) => singlePose(c, c.subject, c.subjectKind, v, v.size, 0.3),
  }),
  low_angle_hero: R({
    id: 'low_angle_hero', planned: false, subjects: 1, description: 'Low-angle hero: lens at hip height looking up, head ~22% of frame',
    plan: (c) => ({ intent: charOrProp(c, 'medium'), motion: 'static', framingFrom: 0, extras: {}, secondaryRole: 'optional', heroSubject: c.subjectKind === 'prop', ...(c.subjectKind === 'character' ? { headSize: (v: Variant) => v.size } : {}) }),
    variants: () => grid([0, 20, -20, 35, -35, 50, -50], [0.23, 0.27], [-0.75, -0.95], [40]),
    pose: (c, v) => { const p = singlePose(c, c.subject, c.subjectKind, v, v.size, 0.12); return p; },
  }),
  pov: R({
    id: 'pov', planned: false, subjects: 2, description: 'Point of view of the character looking at the subject (secondary, or a cast member whose lookAt is the subject): lens just in front of the viewer\'s face',
    plan: (c) => ({ intent: c.subjectKind === 'prop' ? 'prop' : 'medium', motion: 'static', framingFrom: 0, extras: {}, secondaryRole: c.viewer || c.secondaryKind === 'character' ? 'optional' : 'none', heroSubject: c.subjectKind === 'prop' }),
    variants: () => grid([0, 6, -6], [0.45, 0.6], [0.02], [44, 52]),
    pose: (c, v) => {
      const viewer = c.viewer ?? (c.secondaryKind === 'character' ? c.secondary : undefined);
      const tgt = c.subjectKind === 'prop' ? c.subject.center : headOf(c.subject);
      if (!viewer) return singlePose(c, c.subject, c.subjectKind, { ...v, yaw: v.yaw }, c.subjectKind === 'prop' ? 0.4 : 0.22, 0.2);
      const eye = headOf(viewer), fwd = sub(tgt, eye), f = scl(fwd, 1 / (Math.hypot(...fwd) || 1)), side: Vec3 = [f[2], 0, -f[0]];
      const pos = add(add(eye, scl(f, v.size)), add(scl(side, Math.sin(v.yaw * DEG) * 0.3), [0, v.height, 0]));
      return { pos: clampSafe(pos, c), target: tgt, fovDeg: v.fov };
    },
  }),
  insert_prop: R({
    id: 'insert_prop', planned: false, subjects: 1, description: 'Prop insert (v2 of prop_ecu): prop fills ~40% of frame, 3/4 elevated 30-45 deg',
    plan: (c) => ({ intent: charOrProp(c, 'close'), motion: 'static', framingFrom: 0, extras: { requiresHeroProp: c.subjectKind === 'prop' }, secondaryRole: 'none', heroSubject: c.subjectKind === 'prop' }),
    variants: () => grid([0, 25, -25, 45, -45], [0.26, 0.34, 0.44], [30, 45], [38]),
    pose: (c, v) => (c.subjectKind === 'prop' ? propPose(c, c.subject, v, v.size) : singlePose(c, c.subject, 'character', { ...v, height: 0 }, 0.36, 0.04)),
  }),
  top_down: R({
    id: 'top_down', planned: false, subjects: 1, description: 'Top-down overhead: 58-76 deg pitch over the subject and what surrounds it (a prop with no actor near is a neutral insert)',
    plan: (c) => ({ intent: c.subjectKind === 'prop' && !c.secondary && !c.actorsNear ? 'neutral_top_down_prop_insert' : 'wide', motion: 'static', framingFrom: 0, extras: { requiresHeroProp: c.subjectKind === 'prop' }, secondaryRole: 'optional', heroSubject: c.subjectKind === 'prop', fit: c.actorsNear ? 'content' : undefined }),
    variants: () => grid([0, 20, -20, 40, -40], [1], [52, 60, 70], [52, 62, 70]),
    pose: (c, v) => {
      const s = c.subject, r = Math.max(s.radius, 0.6), box = c.secondary ? { min: [Math.min(s.center[0] - r, c.secondary.center[0] - c.secondary.radius), 0, Math.min(s.center[2] - r, c.secondary.center[2] - c.secondary.radius)] as Vec3, max: [Math.max(s.center[0] + r, c.secondary.center[0] + c.secondary.radius), Math.max(s.top[1], 0.6), Math.max(s.center[2] + r, c.secondary.center[2] + c.secondary.radius)] as Vec3 } : { min: [s.center[0] - r, 0, s.center[2] - r] as Vec3, max: [s.center[0] + r, s.top[1], s.center[2] + r] as Vec3 };
      return widePose(c, box, v, 1.05);
    },
  }),
  whip_pan: R({
    id: 'whip_pan', planned: false, subjects: 2, description: 'Whip pan: 0.35 s pan from the secondary (or off-frame) onto the subject, then a medium hold; framing rules apply after the pan',
    plan: (c) => ({ intent: charOrProp(c, 'medium'), motion: 'pan', framingFrom: 0.35, extras: {}, secondaryRole: 'optional', heroSubject: c.subjectKind === 'prop', ...(c.subjectKind === 'character' ? { headSize: (v: Variant) => v.size } : {}) }),
    variants: (c) => grid([0, 20, -20, 35, -35], c.subjectKind === 'prop' ? [0.4] : [0.23], [-0.08], [38]),
    pose: (c, v, lt) => {
      const end = singlePose(c, c.subject, c.subjectKind, v, v.size, 0.3);
      const from = c.secondary ? (c.secondaryKind === 'character' ? headOf(c.secondary) : c.secondary.center) : add(end.target, scl([Math.cos((frontYaw(c.subject) + v.yaw) * DEG), 0, -Math.sin((frontYaw(c.subject) + v.yaw) * DEG)], 2.0));
      const u = smooth(lt / 0.35);
      return { ...end, target: [lerp(from[0], end.target[0], u), lerp(from[1], end.target[1], u), lerp(from[2], end.target[2], u)] };
    },
  }),
  slow_push_in: R({
    id: 'slow_push_in', planned: false, subjects: 1, description: 'Slow push-in for tension: dolly from head ~19% to ~29% of frame over the whole beat',
    plan: (c) => ({ intent: charOrProp(c, 'medium'), motion: 'dolly', framingFrom: 0, extras: {}, secondaryRole: 'optional', heroSubject: c.subjectKind === 'prop', ...(c.subjectKind === 'character' ? { headSize: (v: Variant, lt: number) => lerp(v.size, v.size1 ?? v.size, smooth(lt / Math.max(c.d, 0.1))) } : {}) }),
    variants: (c) => grid([0, 20, -20, 35, -35, 50, -50], [c.subjectKind === 'prop' ? 0.3 : 0.2], [-0.05, 0.2], [38], { size1: c.subjectKind === 'prop' ? 0.42 : 0.29 }),
    pose: (c, v, lt) => { const u = smooth(lt / Math.max(c.d, 0.1)); return singlePose(c, c.subject, c.subjectKind, v, lerp(v.size, v.size1 ?? v.size, u), 0.28); },
  }),
  // ---------------- available ids (engine CAMERA_PRESETS), rebuilt on camera safety
  prop_ecu: R({
    id: 'prop_ecu', planned: false, subjects: 1, description: 'Extreme close-up on a prop: fills ~60% of frame',
    plan: (c) => ({ intent: charOrProp(c, 'extreme_close'), motion: 'static', framingFrom: 0, extras: { requiresHeroProp: c.subjectKind === 'prop' }, secondaryRole: 'none', heroSubject: c.subjectKind === 'prop' }),
    variants: () => grid([0, 20, -20, 40, -40], [0.55, 0.65], [20, 35], [36]),
    pose: (c, v) => (c.subjectKind === 'prop' ? propPose(c, c.subject, v, v.size) : singlePose(c, c.subject, 'character', { ...v, height: 0 }, 0.5, 0.02)),
  }),
  frontal_medium: R({
    id: 'frontal_medium', planned: false, subjects: 1, description: 'Frontal medium single (on-axis +-24 deg)',
    plan: (c) => ({ intent: charOrProp(c, 'medium'), motion: 'static', framingFrom: 0, extras: {}, secondaryRole: 'optional', heroSubject: c.subjectKind === 'prop', ...(c.subjectKind === 'character' ? { headSize: (v: Variant) => v.size } : {}) }),
    variants: (c) => grid([0, 12, -12, 24, -24], c.subjectKind === 'prop' ? [0.4] : [0.225, 0.27], [-0.1, 0.2], [38]),
    pose: (c, v) => singlePose(c, c.subject, c.subjectKind, v, v.size, 0.3),
  }),
  two_shot: R({
    id: 'two_shot', planned: false, subjects: 2, description: 'Two-shot: subject and secondary both readable (heads >= 14% of frame), lens perpendicular to their axis on the faces\' side',
    plan: (c) => ({ intent: 'medium', motion: 'static', framingFrom: 0, extras: {}, secondaryRole: 'required', heroSubject: false, fit: 'pair' }),
    // side 0: perpendicular to the pair on the faces' side; side 1: from the audience (+z) axis of the set
    variants: () => [...grid([0, 15, -15, 30, -30, 45, -45, 60, -60], [1.0], [-0.12, 0.3], [34, 40]), ...grid([0, 20, -20, 40, -40], [1.0], [-0.12, 0.3], [34, 40], { side: 1 }).map((v) => ({ ...v, id: `aud_${v.id}` }))],
    pose: (c, v) => {
      const a = c.subject, b = c.secondary ?? c.subject;
      const ha = headOf(a), hb = c.secondaryKind === 'prop' ? b.center : headOf(b), mid = scl(add(ha, hb), 0.5), ab = sub(hb, ha);
      let perp: Vec3 = [-ab[2], 0, ab[0]];
      const pl = len2(perp) || 1; perp = scl(perp, 1 / pl);
      const avg = add(dirYaw(frontYaw(a)), c.secondaryKind === 'character' ? dirYaw(frontYaw(b)) : [0, 0, 1]);
      if (perp[0] * avg[0] + perp[2] * avg[2] < 0) perp = scl(perp, -1);
      const yaw = (v.side === 1 ? 0 : yawOf(perp)) + v.yaw, w = (len2(ab) / 2 + 0.42) * v.size;
      const dist = Math.max(w / (tanH(v.fov) * 0.92), 1.6);
      const pos = add(add(mid, scl(dirYaw(yaw), dist)), [0, v.height, 0]);
      return { pos: clampSafe(pos, c), target: add(mid, [0, -0.3, 0]), fovDeg: v.fov };
    },
  }),
  over_shoulder: R({
    id: 'over_shoulder', planned: false, subjects: 2, description: 'Over-the-shoulder: the subject\'s face read past the secondary in the foreground (a character\'s shoulder, or a prop), lens far enough behind it for the OTS head band',
    plan: (c) => ({ intent: c.subjectKind === 'prop' ? 'prop' : 'over_shoulder', motion: 'static', framingFrom: 0, extras: {}, secondaryRole: 'foreground', heroSubject: c.subjectKind === 'prop' }),
    // yaw = side (+1 / -1) * lateral offset (m); size = distance behind the foreground (m); height above its top (m)
    variants: () => [0.45, 0.8].flatMap((lat) => [1, -1].flatMap((side) => [0.8, 1.3].flatMap((back) => [0.1, 0.35].flatMap((h) => [34, 28].map((fov) => ({ id: `s${side}_l${lat}_b${back}_h${h}_f${fov}`, yaw: 0, side: side * lat, size: back, height: h, fov })))))),
    pose: (c, v) => {
      const fg = c.secondary ?? c.subject, tgt = c.subjectKind === 'prop' ? c.subject.center : headOf(c.subject);
      const fgTop = c.secondaryKind === 'character' ? headOf(fg) : fg.top;
      const back = sub(fgTop, tgt); back[1] = 0;
      const bl = len2(back) || 1, bn = scl(back, 1 / bl), side: Vec3 = [bn[2], 0, -bn[0]];
      // never closer to the read face than its OTS head band allows (head <= 45 % of frame)
      const minD = HEAD_H / (0.42 * 2 * tanV(v.fov));
      // long OTS lines push the lens further behind (and wider of) the foreground so it stays a shoulder, not a wall
      const k = Math.max(1, bl / 2.5), behind = Math.max(v.size * k, minD - bl, 1.0);
      const pos = add(add(fgTop, scl(bn, behind)), add(scl(side, (v.side ?? 0.45) * k), [0, v.height, 0]));
      return { pos: clampSafe(pos, c), target: add(tgt, [0, -0.05, 0]), fovDeg: v.fov };
    },
  }),
  low_angle_reveal: R({
    id: 'low_angle_reveal', planned: false, subjects: 1, description: 'Low-angle reveal: lens 0.6-1.0 m high looking up; a giant prop is judged as a scale reveal (emblem, thickness edge, base, scale reference)',
    plan: (c) => ({ intent: c.subjectKind === 'prop' ? 'scale_reveal' : 'medium', motion: 'static', framingFrom: 0, extras: {}, secondaryRole: 'optional', heroSubject: c.subjectKind === 'prop' }),
    variants: (c) => (c.subjectKind === 'prop' ? grid([25, -25, 38, -38, 50, -50], [0.62, 0.74], [0.6, 1.0], [48]) : grid([0, 20, -20], [0.22], [-0.9], [40])),
    pose: (c, v) => {
      if (c.subjectKind !== 'prop') return singlePose(c, c.subject, 'character', v, v.size, 0.1);
      const s = c.subject, H = Math.max(s.top[1] - s.bottom[1], 2 * s.radius), yaw = frontalYaw(s, 'prop') + v.yaw;
      const dist = Math.max(H / (v.size * 2 * tanV(v.fov)), (2 * s.radius) / (v.size * 2 * tanH(v.fov)) * 0.8);
      const pos = add([s.center[0], v.height, s.center[2]], scl(dirYaw(yaw), dist + s.radius * 0.2));
      return { pos: clampSafe(pos, c), target: [s.center[0], s.center[1] * 0.9, s.center[2]], fovDeg: v.fov };
    },
  }),
  top_down_insert: R({
    id: 'top_down_insert', planned: false, subjects: 1, description: 'Top-down insert: steep (>= 50 deg) neutral prop insert, no actor in frame',
    plan: (c) => ({ intent: c.subjectKind === 'prop' ? 'neutral_top_down_prop_insert' : 'wide', motion: 'static', framingFrom: 0, extras: { requiresHeroProp: true }, secondaryRole: 'none', heroSubject: true }),
    variants: () => grid([0, 25, -25], [0.4, 0.5], [62, 74, 84], [38]),
    pose: (c, v) => propPose(c, c.subject, v, v.size),
  }),
  wide_environment: R({
    id: 'wide_environment', planned: false, subjects: 1, description: 'Wide of the whole set: level-ish (6-12 deg) audience-side wide of everything in the beat',
    plan: (c) => ({ intent: 'wide', motion: 'static', framingFrom: 0, extras: {}, secondaryRole: 'optional', heroSubject: c.subjectKind === 'prop', fit: 'content' }),
    variants: () => grid([0, 15, -15, 30, -30], [1], [6, 12], [44, 52]),
    pose: (c, v) => widePose(c, c.content, v, 1.18),
  }),
  reaction_punch_in: R({
    id: 'reaction_punch_in', planned: false, subjects: 1, description: 'Reaction punch-in: 0.3 s snap from head ~29% to ~40% of frame, then hold',
    plan: (c) => ({ intent: charOrProp(c, 'reaction'), motion: 'punch', framingFrom: 0, extras: {}, secondaryRole: 'optional', heroSubject: c.subjectKind === 'prop', ...(c.subjectKind === 'character' ? { headSize: (v: Variant, lt: number) => lerp(v.size, v.size1 ?? v.size, smooth(lt / 0.3)) } : {}) }),
    variants: (c) => grid([0, 15, -15, 30, -30, 45, -45], [c.subjectKind === 'prop' ? 0.4 : 0.29], [0.0, 0.15], [38], { size1: c.subjectKind === 'prop' ? 0.55 : 0.4 }),
    pose: (c, v, lt) => singlePose(c, c.subject, c.subjectKind, v, lerp(v.size, v.size1 ?? v.size, smooth(lt / 0.3)), 0.05),
  }),
  chase_cam: R({
    id: 'chase_cam', planned: false, subjects: 1, description: 'Tracking chase camera: fixed 3/4 offset that follows the subject every frame',
    plan: (c) => ({ intent: charOrProp(c, 'medium'), motion: 'track', framingFrom: 0, extras: {}, secondaryRole: 'optional', heroSubject: c.subjectKind === 'prop', ...(c.subjectKind === 'character' ? { headSize: (v: Variant) => v.size } : {}) }),
    variants: () => grid([30, -30, 45, -45], [0.19], [0.1], [42]),
    pose: (c, v, lt) => { const s = c.subjectAt?.(lt) ?? c.subject; return singlePose(c, s, c.subjectKind, v, v.size, 0.35); },
  }),
  final_loop: R({
    id: 'final_loop', planned: false, subjects: 1, description: 'Loop-closing final shot: slow push onto the subject from the audience axis (a prop reads as an insert)',
    plan: (c) => ({ intent: charOrProp(c, 'medium'), motion: 'dolly', framingFrom: 0, extras: { requiresHeroProp: c.subjectKind === 'prop' }, secondaryRole: 'optional', heroSubject: c.subjectKind === 'prop', ...(c.subjectKind === 'character' ? { headSize: (v: Variant, lt: number) => lerp(v.size, v.size1 ?? v.size, smooth(lt / Math.max(c.d, 0.1))) } : {}) }),
    // a tight family (the subject reads as an insert / medium) and a context family (a wide that pushes in on it)
    variants: (c) => [
      ...(c.subjectKind === 'prop' ? grid([0, 20, -20, 35, -35], [0.3], [28, 40], [38], { size1: 0.38 }) : grid([0, 15, -15], [0.22], [-0.08], [38], { size1: 0.27 })),
      ...grid([0, 15, -15, 30, -30], [1], [10, 18], [46, 52], { size1: 0.85, intent: 'wide', fit: 'content' }).map((v) => ({ ...v, id: `ctx_${v.id}` })),
    ],
    pose: (c, v, lt) => {
      const u = smooth(lt / Math.max(c.d, 0.1));
      if (v.intent === 'wide') { const p = widePose(c, c.content, v, 1.12), k = lerp(1, v.size1 ?? 1, u), t = c.subjectKind === 'prop' ? c.subject.center : headOf(c.subject), tg: Vec3 = [lerp(p.target[0], t[0], u * 0.5), lerp(p.target[1], t[1], u * 0.5), lerp(p.target[2], t[2], u * 0.5)]; return { ...p, target: tg, pos: add(tg, scl(sub(p.pos, p.target), k)) }; }
      return c.subjectKind === 'prop' ? propPose(c, c.subject, v, lerp(v.size, v.size1 ?? v.size, u)) : singlePose(c, c.subject, 'character', v, lerp(v.size, v.size1 ?? v.size, u), 0.3);
    },
  }),
};

export const PLANNED_RECIPES = Object.values(CAMERA_RECIPES).filter((r) => r.planned).map((r) => r.id);
