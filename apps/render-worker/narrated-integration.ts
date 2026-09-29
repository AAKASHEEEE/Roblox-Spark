// Narrated Continuity Checkpoint 2 — integration of the three worker modules (narrated drafts ONLY).
//
// Pipeline order (per frame / per shot / per caption chunk):
//   approved storyboard -> audio hash check (caller) -> WorldPlan -> sampleWorld(t) -> NarratedEngineAdapter.applySnapshot
//   -> posed engine geometry -> CameraSafetyScene (posed, never stale) -> safe camera per shot (+ screen-direction carry)
//   -> projected occupied bounds over each caption chunk -> ONE stable caption placement per chunk (camera re-selected
//   when no hard-rule-safe band exists) -> blocking continuity / camera / caption / semantic gates -> render only if all pass.
// Cameras are read-only consumers of the posed scene: they never write actor or prop transforms. Caption placement is a
// read-only consumer of projected bounds: it never changes a camera or the world. Visual Comedy never reaches this file.
// Browser-safe (no node imports): the renderer page uses NarratedScene + the integrated timeline produced here.
import type { Production } from '../../packages/engine/src/production.ts';
import type { Rig } from '../../packages/engine/src/build.ts';
import type { Node } from '../../packages/engine/src/gl/scene.ts';
import type { CameraState, Lighting, PointLight } from '../../packages/engine/src/gl/renderer.ts';
import { m4TransformPoint, DEG, type Vec3 } from '../../packages/engine/src/math.ts';
import {
  evaluateCameraCandidate, buildSafeFallbackCandidates, nextScreenDirectionState, projectToScreen, CAMERA_SAFETY_DEFAULTS,
  type Bounds3, type CameraCandidate, type CameraIntent, type CameraObstacle, type CameraSafetyResult, type CameraSafetyScene, type ProjectedEntity, type ScreenDirectionState,
} from '../../packages/engine/src/camera-safety.ts';
import { placeCaption, type CaptionPlacementResult, type OccupiedRegion, type Rect } from '../../packages/engine/src/caption-placement.ts';
import { sampleWorld, type WorldPlan, type WorldState } from '../../packages/narrated/src/world.ts';
import type { NarratedStoryboard, NarratedPhrase } from '../../packages/narrated/src/schema.ts';
import type { NarratedTimeline, CaptionEvent } from '../../packages/narrated/src/timeline.ts';
import { NarratedEngineAdapter, PENETRATION_TOLERANCE_M, type AdapterDiagnostics } from './narrated-world-adapter.ts';

export const INTEGRATED_TIMELINE_SCHEMA = 'blockspark.narrated-integrated-timeline/1';
export const ANALYSIS_SCHEMA = 'blockspark.narrated-continuity-analysis/1';
/** blocking minimum posed-scene Zapp/coin clearance (m); never lowered to pass */
export const MIN_COIN_CLEARANCE_M = 0.02;
export const MAX_HEAD_STEP_M = 0.08;
export const MAX_HEAD_STEP_DEG = 12;
export const MAX_COIN_BASE_DRIFT_M = 0.01;
export const MIN_JUMP_M = 0.25;
export const MAX_PRESS_HAND_GAP_M = 0.08;
export const KIRA_HAZARD_MARGIN_M = 0.5;
export const MIN_SHOT_SEC = 0.6;
/** camera samples per shot (every CAMERA_SAMPLE_FRAMES frames + the last frame) */
export const CAMERA_SAMPLE_FRAMES = 3;
export const CAPTION_SAMPLE_FRAMES = 2;
export const PRIMARY_FACE_CAPTION_MAX = 0.08;
export const HERO_PROP_CAPTION_MAX = 0.5;

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const r3 = (x: number) => Math.round(x * 1e3) / 1e3;
const d2 = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[2] - b[2]);
const d3 = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const PROP_OBSTACLES = ['desk', 'button', 'coin'];

// ───────────────────────────── posed scene ─────────────────────────────

/** Narrated-only runtime over a Production: WorldState (through the adapter) is the only writer of actor/prop transforms. */
export class NarratedScene {
  readonly adapter: NarratedEngineAdapter;
  readonly prod: Production;
  readonly plan: WorldPlan;
  constructor(prod: Production, plan: WorldPlan) {
    this.prod = prod; this.plan = plan;
    // WorldState prop transforms are absolute: the button must not inherit the desk transform twice
    const b = prod.props.get('button');
    if (b && b.inst.root.parent && b.inst.root.parent !== prod.root) { const p = b.inst.root.parent; p.children.splice(p.children.indexOf(b.inst.root), 1); b.inst.root.parent = null; prod.root.add(b.inst.root); }
    // static set dressing the world does not own (the desk) is placed once from its episode track
    for (const [id, p] of prod.props) if (id !== 'coin' && id !== 'button') p.track.apply(0);
    this.adapter = new NarratedEngineAdapter();
    this.adapter.initialize(plan, prod);
  }
  /** sample the authoritative world at t and apply it; the posed scene world matrices are up to date on return */
  pose(t: number, previous: WorldState | null): { world: WorldState; diag: AdapterDiagnostics } {
    const world = sampleWorld(this.plan, t);
    const diag = this.adapter.applySnapshot(world, previous, this.prod);
    this.prod.root.updateWorld();
    return { world, diag };
  }
  lighting(world: WorldState): Lighting {
    const L = this.prod.lighting(), pts: PointLight[] = [];
    const b = this.prod.props.get('button'), glow = world.props.button?.glow ?? 0;
    const g = b?.inst.anchors.glow;
    if (g && glow > 0.01) { const p = g.worldPos(); pts.push({ pos: [p[0], p[1] + 0.05, p[2] + 0.05], color: [1, 0.22, 0.18], intensity: 0.9 * glow, range: 0.45 }); }
    L.points = pts;
    return L;
  }
}

// ───────────────────────────── geometry extraction ─────────────────────────────

function nodeBox(n: Node): Bounds3 | null {
  const h = n.geometry?.half;
  if (!h) return null;
  const w = n.world;
  if (Math.hypot(w[0], w[1], w[2]) < 0.02) return null;
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    const p = m4TransformPoint(w, [sx * h[0], sy * h[1], sz * h[2]]);
    for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]); }
  }
  return { min, max };
}
const union = (bs: Bounds3[]): Bounds3 | null => bs.length ? { min: [0, 1, 2].map((k) => Math.min(...bs.map((b) => b.min[k]))) as Vec3, max: [0, 1, 2].map((k) => Math.max(...bs.map((b) => b.max[k]))) as Vec3 } : null;
const pad = (p: readonly number[], r: number): Bounds3 => ({ min: [p[0] - r, p[1] - r, p[2] - r], max: [p[0] + r, p[1] + r, p[2] + r] });

export interface ActorGeo { id: string; head: Bounds3; body: Bounds3; face: { center: Vec3; normal: Vec3; halfWidth: number; halfHeight: number }; root: Vec3; yawDeg: number; velocity: Vec3; posture: string; waistUp: boolean; waistY: number; handR: Vec3; handL: Vec3; chest: Vec3 }
/** everything the camera and caption layers may read about one frame: extracted from the POSED scene only */
export interface FrameGeo { i: number; t: number; obstacles: CameraObstacle[]; actors: Record<string, ActorGeo>; props: Record<string, Bounds3 | null>; interaction: Vec3 | null; interactionKind: string | null; coinVisible: boolean; coinScale: number }

function rigGeo(id: string, rig: Rig, w: WorldState, diag: AdapterDiagnostics): { geo: ActorGeo; obs: CameraObstacle[] } {
  const obs: CameraObstacle[] = [], body: Bounds3[] = [], head: Bounds3[] = [], hair: Bounds3[] = [];
  const f = rig.face.world, [hw, hh] = rig.manifest.body.headSize;
  const n = Math.hypot(f[8], f[9], f[10]) || 1;
  for (const m of rig.meshes) {
    if (!m.visible) continue;
    const b = nodeBox(m);
    if (!b) continue;
    // head-bone parts (hair, cap, brim) move rigidly with the head: they are part of the head volume, so an actor's own
    // hair AABB never counts as occluding the actor's own face; the crown above the face is ALSO kept as a 'hair' obstacle
    const onHead = m.name === 'head_mesh' || m.parent?.name === 'neck';
    obs.push({ entityId: id, type: onHead ? 'head' : 'body', bounds: b });
    (onHead ? head : body).push(b);
    if (onHead && m.name !== 'head_mesh') hair.push(b);
  }
  const faceTop = rig.face.worldPos()[1] + (hh / 2) * Math.abs(f[5] / (Math.hypot(f[4], f[5], f[6]) || 1)) + 0.02;
  const crown = union(hair.filter((b) => b.max[1] > faceTop).map((b) => ({ min: [b.min[0], Math.max(b.min[1], faceTop), b.min[2]] as Vec3, max: b.max })));
  if (crown) obs.push({ entityId: id, type: 'hair', bounds: crown });
  const a = w.actors[id], ad = diag.actors[id];
  const hips = rig.joints.hips.worldPos();
  const neck = rig.joints.neck.worldPos();
  return {
    obs,
    geo: {
      id, head: union(head.slice(0, 1).length ? head : body)!, body: union(body)!, root: [...ad.appliedRoot] as Vec3, yawDeg: a.yawDeg, velocity: [...a.velocity] as Vec3, posture: a.posture,
      face: { center: rig.face.worldPos(), normal: [f[8] / n, f[9] / n, f[10] / n], halfWidth: (hw / 2) * 0.9, halfHeight: (hh / 2) * 0.9 },
      waistUp: !!ad.framing.waist_up_required, waistY: hips[1] + 0.05, handR: rig.hand_r.worldPos(), handL: rig.hand_l.worldPos(), chest: [(hips[0] + neck[0]) / 2, (hips[1] + neck[1]) / 2, (hips[2] + neck[2]) / 2],
    },
  };
}

export function extractFrameGeo(ns: NarratedScene, i: number, w: WorldState, diag: AdapterDiagnostics): FrameGeo {
  const prod = ns.prod, obstacles: CameraObstacle[] = [], actors: Record<string, ActorGeo> = {}, props: Record<string, Bounds3 | null> = {};
  for (const c of prod.env.colliders) if (c.id !== 'floor') obstacles.push({ entityId: `env:${c.id}`, type: 'environment', bounds: { min: [...c.min] as Vec3, max: [...c.max] as Vec3 } });
  for (const [id, rig] of prod.rigs) { if (!w.actors[id]) continue; const g = rigGeo(id, rig, w, diag); actors[id] = g.geo; obstacles.push(...g.obs); }
  for (const id of PROP_OBSTACLES) {
    const p = prod.props.get(id);
    if (!p || !p.inst.root.visible) { props[id] = null; continue; }
    const bs: Bounds3[] = [];
    for (const n of Object.values(p.inst.parts)) { if (!n.geometry || n.decal || !n.visible) continue; const b = nodeBox(n); if (b) { bs.push(b); obstacles.push({ entityId: id, type: 'prop', bounds: b }); } }
    props[id] = union(bs);
  }
  // causal interaction point: the press contact (hand -> press surface) or the coin/patient contact
  const P = ns.plan, pressT = P.button.pressT, tip = P.coin.tip;
  let interaction: Vec3 | null = null, interactionKind: string | null = null;
  if (pressT !== null && w.t >= pressT - 0.35 && w.t <= pressT + 0.25) { interaction = [...P.assets.button.pressSurface] as Vec3; interactionKind = 'press'; }
  else if (tip && w.t >= tip.tc - 0.35 && w.t <= tip.t1 && actors.zapp) { interaction = actors.zapp.chest; interactionKind = 'coin_contact'; }
  const coin = w.props.coin;
  return { i, t: w.t, obstacles, actors, props, interaction, interactionKind, coinVisible: !!coin?.visible, coinScale: coin?.scale ?? 0 };
}

// ───────────────────────────── shot specs (motivated coverage) ─────────────────────────────

export interface ShotSpec { intent: CameraIntent; active: string; subjects: string[]; optional: string[]; heroProps: string[]; reason: string; requiresHeroProp: boolean }
export interface WindowFacts { jump: boolean; press: boolean; coinSpawn: boolean; grow: boolean; tip: boolean; kiraWalk: boolean; zappWalk: boolean; reset: boolean; seated: string[]; last: boolean; first: boolean }

function windowFacts(plan: WorldPlan, s: number, e: number, first: boolean, last: boolean): WindowFacts {
  const inW = (t: number | null | undefined) => t !== null && t !== undefined && t >= s - 1e-9 && t < e - 1e-9;
  const ev = (type: string) => plan.events.filter((x) => x.type === type).map((x) => x.t);
  const seg = (id: string, kind: string) => (plan.actors[id]?.segs ?? []).some((q) => q.kind === kind && q.t0 < e && q.t1 > s);
  const seated = Object.keys(plan.actors).filter((id) => plan.actors[id].segs.some((q) => q.posture === 'implied_seated' && q.t0 < e && q.t1 > s));
  const tip = plan.coin.tip;
  return {
    jump: seg('zapp', 'jump'), press: inW(plan.button.pressT), coinSpawn: ev('coin_spawn').some(inW) || ev('coin_land').some(inW), grow: ev('grow_step').some(inW) || ev('coin_stand').some(inW),
    tip: !!tip && tip.t0 < e && tip.t1 > s, kiraWalk: seg('kira', 'path'), zappWalk: seg('zapp', 'path'), reset: inW(plan.button.resetT), seated, first, last,
  };
}
const explicitlyNamed = (p: NarratedPhrase, who: string) => new RegExp(`\\b${who}\\b`, 'i').test(p.text) || (who === 'zapp' && /\b(him|his)\b/i.test(p.text) && p.actor !== 'zapp');

/** one visual intent per timeline shot, from the beat's semantics and the WORLD events inside the shot window */
export function shotSpec(p: NarratedPhrase, f: WindowFacts, geoMid: FrameGeo, phraseShotIndex: number): ShotSpec {
  const actor = p.actor, other = actor === 'zapp' ? 'kira' : 'zapp', both = [actor, other];
  const coinReady = geoMid.coinVisible;
  if (f.tip) return { intent: 'wide', active: 'zapp', subjects: ['zapp', 'kira'], optional: ['kira'], heroProps: ['coin'], reason: 'tip/contact/fall: impact geography wide (coin + patient; Kira outside the hazard, optional)', requiresHeroProp: true };
  if (f.kiraWalk) return { intent: 'wide', active: 'kira', subjects: ['kira', 'zapp'], optional: ['zapp'], heroProps: [], reason: 'Kira visibly walks (move safely / return): full-body wide on Kira', requiresHeroProp: false };
  if (f.press) return { intent: 'prop', active: 'zapp', subjects: ['zapp'], optional: [], heroProps: ['button'], reason: 'press: hand/button contact and interaction point visible', requiresHeroProp: true };
  if (f.jump) return { intent: 'wide', active: 'zapp', subjects: ['zapp', 'kira'], optional: ['kira'], heroProps: [], reason: 'jump: full-body framing so the vertical displacement reads', requiresHeroProp: false };
  if (f.coinSpawn && coinReady) return { intent: 'prop', active: 'zapp', subjects: ['zapp'], optional: ['zapp'], heroProps: ['coin'], reason: 'coin spawn visible', requiresHeroProp: true };
  if ((f.grow || f.zappWalk) && coinReady) return { intent: 'prop', active: 'zapp', subjects: ['zapp', 'kira'], optional: ['kira'], heroProps: ['coin'], reason: 'coin growth / scale: coin base + Zapp for scale (prop-led wide; his face may turn to the coin)', requiresHeroProp: true };
  if (f.last) return { intent: 'wide', active: 'zapp', subjects: ['zapp', 'kira'], optional: ['kira'], heroProps: ['coin'], reason: 'ending: Zapp prone under the resting coin, Kira at her desk (consequence preserved)', requiresHeroProp: true };
  if (f.reset) return { intent: 'prop', active: 'zapp', subjects: ['zapp'], optional: ['zapp'], heroProps: ['button'], reason: 'button reset insert (consequence stays in the world)', requiresHeroProp: true };
  const seated = f.seated.includes(actor);
  if (seated) return { intent: 'close', active: actor, subjects: [actor, other], optional: [other], heroProps: [], reason: `${actor} implied_seated: waist-up close (no chair/legs shown)`, requiresHeroProp: false };
  if (f.first) return { intent: phraseShotIndex === 0 ? 'wide' : 'medium', active: actor, subjects: both, optional: [], heroProps: [], reason: 'opening comparison: both characters and the classroom geography (both required)', requiresHeroProp: false };
  const warning = p.semanticAction === 'head_shake' && !!p.supportingCharacter && explicitlyNamed(p, p.supportingCharacter);
  if (warning) return { intent: 'medium', active: actor, subjects: both, optional: [], heroProps: [], reason: `${actor} warns ${other}: speaker + listener required`, requiresHeroProp: false };
  if (p.actorRole === 'reactor' && p.propEvents.some((e) => e.prop === 'spark_coin') && coinReady) return { intent: 'wide', active: actor, subjects: both, optional: [other], heroProps: ['coin'], reason: 'reaction to the coin: coin + reacting face', requiresHeroProp: true };
  const intent: CameraIntent = phraseShotIndex % 2 === 1 ? 'reaction' : 'medium';
  return { intent, active: actor, subjects: both, optional: [other], heroProps: [], reason: `${actor} ${p.semanticAction}: active-character ${intent} (supporting actor optional)`, requiresHeroProp: false };
}

// ───────────────────────────── camera-safety scene from posed geometry ─────────────────────────────

export function cameraScene(g: FrameGeo, spec: ShotSpec, W: number, H: number, sd: ScreenDirectionState | undefined): CameraSafetyScene {
  const entities: ProjectedEntity[] = [];
  for (const a of Object.values(g.actors)) entities.push({ entityId: a.id, kind: 'character', face: a.face, facing: [Math.sin(a.yawDeg * DEG), 0, Math.cos(a.yawDeg * DEG)], ...(a.waistUp ? { waistUpRequired: true, waistY: a.waistY } : {}) });
  for (const id of spec.heroProps) { const b = g.props[id]; if (b) entities.push({ entityId: id, kind: 'prop', bounds: b, ...(g.interaction && ((id === 'button' && g.interactionKind === 'press') || (id === 'coin' && g.interactionKind === 'coin_contact')) ? { interactionPoint: g.interaction } : {}) }); }
  const ids = Object.keys(g.actors).sort();
  const actors = ['zapp', 'kira'].filter((id) => g.actors[id]).map((id) => ({ id, position: g.actors[id].root, facing: [Math.sin(g.actors[id].yawDeg * DEG), 0, Math.cos(g.actors[id].yawDeg * DEG)] as Vec3, movement: g.actors[id].velocity }));
  // optional supporting actors are shot subjects only in wides; single-character coverage keeps them as obstacles
  // (collision / occlusion still apply) and records them as optional drops, never as required ones
  const subjects = [spec.active, ...spec.subjects.filter((s) => s !== spec.active && (spec.intent === 'wide' || !spec.optional.includes(s)))].filter((s) => ids.includes(s));
  return {
    frameWidth: W, frameHeight: H, subjectIds: subjects, optionalSubjectIds: spec.optional.filter((s) => s !== spec.active), heroPropIds: spec.heroProps.filter((id) => g.props[id]),
    obstacles: g.obstacles, projectedEntities: entities, activeSubjectId: spec.active, screenDirection: { ...(sd ?? {}), actors },
  };
}

/** candidate family per intent: vetted geometry-solved shots plus deterministic orbit/distance variants */
export function candidatesFor(scene: CameraSafetyScene, spec: ShotSpec, shotId: string): CameraCandidate[] {
  const base = buildSafeFallbackCandidates(scene);
  const want: Record<CameraIntent, string[]> = {
    wide: ['elevated_wide', 'two_character_medium'], medium: spec.optional.length < spec.subjects.length - 1 ? ['two_character_medium', 'frontal_medium'] : ['frontal_medium', 'two_character_medium'],
    close: ['reaction_close', 'frontal_medium'], reaction: ['reaction_close', 'frontal_medium'], extreme_close: ['reaction_close'], prop: ['prop_insert', 'frontal_medium', 'elevated_wide'], over_shoulder: ['two_character_medium', 'frontal_medium'],
  };
  const out: CameraCandidate[] = generatedCandidates(scene, spec, shotId);
  for (const b of base.filter((x) => want[spec.intent].includes(x.fallback))) {
    const { fallback, ...c } = b;
    // the vetted solver assumes ~0.3 m heads; the blocky cast has 0.52 m heads + hair, so distance variants reach further
    const ks = fallback === 'elevated_wide' ? [1, 0.85, 0.7, 0.55, 0.45] : fallback === 'prop_insert' ? [1, 1.4, 1.8, 2.4, 3] : [1, 1.35, 1.7, 2.1, 2.5];
    for (const yaw of [0, -20, 20, -40, 40, -60, 60]) for (const k of ks) {
      const v = [c.transform.position[0] - c.target[0], c.transform.position[1] - c.target[1], c.transform.position[2] - c.target[2]];
      const cs = Math.cos(yaw * DEG), sn = Math.sin(yaw * DEG);
      const rv: Vec3 = [(v[0] * cs + v[2] * sn) * k, v[1] * k, (-v[0] * sn + v[2] * cs) * k];
      out.push({ ...c, id: `${shotId}:${fallback}:y${yaw}:d${k}`, transform: { position: [c.target[0] + rv[0], c.target[1] + rv[1], c.target[2] + rv[2]] }, requiresHeroProp: spec.requiresHeroProp && scene.heroPropIds.length > 0 });
    }
  }
  return out;
}

/**
 * Deterministic candidates sized from the POSED bounds: the camera orbits the subject (face-normal side and audience
 * side), at distances derived from the intent's head-height band (portrait 9:16) or from the content bounds (wide/prop).
 */
function generatedCandidates(scene: CameraSafetyScene, spec: ShotSpec, shotId: string): CameraCandidate[] {
  const heads = new Map<string, Bounds3>(), bodies = new Map<string, Bounds3>();
  for (const o of scene.obstacles) {
    if (o.type === 'head' || o.type === 'hair') heads.set(o.entityId, union([o.bounds, ...(heads.has(o.entityId) ? [heads.get(o.entityId)!] : [])])!);
    if (o.type !== 'environment') bodies.set(o.entityId, union([o.bounds, ...(bodies.has(o.entityId) ? [bodies.get(o.entityId)!] : [])])!);
  }
  const ent = new Map((scene.projectedEntities ?? []).map((e) => [e.entityId, e]));
  const active = spec.active, ah = heads.get(active);
  if (!ah) return [];
  const c = (b: Bounds3): Vec3 => [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
  const hc = c(ah), headH = ah.max[1] - ah.min[1];
  const fn = ent.get(active)?.face?.normal ?? [0, 0, 1];
  const faceYaw = Math.atan2(fn[0], fn[2]) / DEG, prone = Math.abs(fn[1]) > 0.6;
  const out: CameraCandidate[] = [];
  const push = (kind: string, intent: CameraIntent, target: Vec3, yawDeg: number, dist: number, dy: number, fov: number, extra: Partial<CameraCandidate> = {}) => {
    const p: Vec3 = [target[0] + Math.sin(yawDeg * DEG) * dist, target[1] + dy, target[2] + Math.cos(yawDeg * DEG) * dist];
    out.push({ id: `${shotId}:${kind}:a${Math.round(yawDeg)}:d${dist.toFixed(2)}:h${dy.toFixed(2)}`, intent, transform: { position: p }, target, fov, activeSubjectId: active, requiresHeroProp: spec.requiresHeroProp && scene.heroPropIds.length > 0, ...extra });
  };
  const yaws = [...new Set((prone ? [0, 25, -25, 50, -50] : [faceYaw, faceYaw + 15, faceYaw - 15, faceYaw + 35, faceYaw - 35, faceYaw + 60, faceYaw - 60, faceYaw + 75, faceYaw - 75, 0, 25, -25]).map((y) => Math.round(y)))];
  const tanV = (fov: number) => Math.tan((fov * DEG) / 2);
  const required = spec.subjects.filter((s) => !spec.optional.includes(s) && heads.has(s));
  if (spec.intent === 'medium' || spec.intent === 'reaction' || spec.intent === 'close' || spec.intent === 'over_shoulder') {
    const seated = ent.get(active)?.waistUpRequired === true;
    const two = spec.intent !== 'reaction' && spec.intent !== 'close' && required.length >= 2;
    if (two) {
      const bh = heads.get(required.find((s) => s !== active)!)!, m: Vec3 = [(hc[0] + c(bh)[0]) / 2, (hc[1] + c(bh)[1]) / 2 - 0.3, (hc[2] + c(bh)[2]) / 2];
      const sep = Math.hypot(hc[0] - c(bh)[0], hc[2] - c(bh)[2]), axisYaw = Math.atan2(c(bh)[0] - hc[0], c(bh)[2] - hc[2]) / DEG;
      for (const frac of [0.15, 0.17, 0.2]) for (const off of [90, -90, 70, -70, 110, -110]) {
        const d = Math.max(headH / (frac * 2 * tanV(38)), (sep / 2 + 0.45) / (tanV(38) * (9 / 16) * 0.9));
        push('two_shot', 'medium', m, axisYaw + off, d, 0.15, 38, { framedSubjectIds: required.slice(0, 2) });
      }
    }
    const fracs = seated ? [0.4, 0.44, 0.48] : spec.intent === 'medium' ? [0.21, 0.25, 0.29] : [0.32, 0.4, 0.48];
    const intent: CameraIntent = seated ? 'close' : spec.intent === 'over_shoulder' ? 'medium' : spec.intent;
    for (const frac of fracs) for (const y of yaws) for (const lift of seated ? [0, 0.15, 0.3] : [0.1, 0.6, 1.1]) {
      const d = headH / (frac * 2 * tanV(38));
      const t: Vec3 = seated ? [hc[0], hc[1] - headH * 0.15, hc[2]] : intent === 'medium' ? [hc[0], hc[1] - headH * 0.55, hc[2]] : [hc[0], hc[1] - headH * 0.2, hc[2]];
      push(seated ? 'seated_close' : intent, intent, t, y, d, lift, 38);
    }
  } else {
    // wide / prop: fit the content (required actors + hero props, or the prop alone)
    const ids = spec.intent === 'prop' ? (scene.heroPropIds.length ? [...scene.heroPropIds, ...(spec.optional.includes(active) ? [] : [active])] : [active]) : [...new Set([...required, active, ...scene.heroPropIds])];
    const content = union(ids.map((id) => bodies.get(id)).filter((b): b is Bounds3 => !!b));
    if (!content) return out;
    const cc = c(content), half = [(content.max[0] - content.min[0]) / 2, (content.max[1] - content.min[1]) / 2, (content.max[2] - content.min[2]) / 2];
    const fov = spec.intent === 'wide' ? 42 : 38;
    for (const k of spec.intent === 'wide' ? [1.05, 1.2, 1.4] : [1.3, 1.7, 2.2]) for (const y of [0, 20, -20, 40, -40, faceYaw, faceYaw + 30, faceYaw - 30]) for (const el of [0.25, 0.45]) {
      const sy = Math.abs(Math.cos(y * DEG)) * half[0] + Math.abs(Math.sin(y * DEG)) * half[2];
      const dist = Math.max((sy * k + 0.3) / (tanV(fov) * (9 / 16)), (half[1] * k + 0.3) / tanV(fov)) + Math.max(half[0], half[2]);
      push(spec.intent === "wide" ? "wide" : "prop", spec.intent, cc, Math.round(y), dist, Math.min(dist * el, 3.7 - cc[1]), fov);
    }
  }
  return out;
}

export interface ShotCamera { id: string; intent: CameraIntent; kind: string; position: Vec3; target: Vec3; fovDeg: number }
interface Ranked { cand: CameraCandidate; minScore: number; results: CameraSafetyResult[] }

function inCameraVolume(prod: Production, p: Vec3): boolean {
  const cs = prod.env.manifest.cameraSafe;
  return p[0] >= cs.min[0] && p[0] <= cs.max[0] && p[1] >= cs.min[1] && p[1] <= cs.max[1] && p[2] >= cs.min[2] && p[2] <= cs.max[2];
}

/** every candidate evaluated on the posed scene at EVERY sample of the shot; only fully accepted candidates survive */
function rankOverShot(prod: Production, geos: FrameGeo[], spec: ShotSpec, W: number, H: number, sd: ScreenDirectionState | undefined, shotId: string, limit = 8): { ranked: Ranked[]; rejections: Record<string, number>; evaluated: number } {
  const mid = geos[Math.floor(geos.length / 2)];
  const cands = candidatesFor(cameraScene(mid, spec, W, H, sd), spec, shotId).filter((c) => inCameraVolume(prod, c.transform.position));
  const rejections: Record<string, number> = {};
  const ranked: Ranked[] = [];
  let evaluated = 0;
  for (const c of cands.sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const results: CameraSafetyResult[] = [];
    let ok = true;
    // mid first (cheap rejection), then every sample (first sample carries the previous shot's screen direction)
    for (const g of [mid, ...geos]) {
      const r = evaluateCameraCandidate(cameraScene(g, spec, W, H, g === geos[0] ? sd : { ...sd, previousCameraSide: undefined }), c); evaluated++;
      results.push(r);
      if (!r.accepted) { ok = false; for (const x of r.rejectionReasons) { const k = x.split(':')[0]; rejections[k] = (rejections[k] ?? 0) + 1; } break; }
    }
    if (ok) ranked.push({ cand: c, minScore: Math.min(...results.map((r) => r.score)), results: results.slice(1) });
  }
  ranked.sort((a, b) => b.minScore - a.minScore || (a.cand.id < b.cand.id ? -1 : 1));
  return { ranked: ranked.slice(0, limit), rejections, evaluated };
}

// ───────────────────────────── caption projection ─────────────────────────────

function projRect(cand: CameraCandidate, pts: Vec3[], W: number, H: number): Rect | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { const q = projectToScreen(cand, p, W / H); if (!(q.z > 0.05) || !Number.isFinite(q.x)) continue; x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); }
  if (!Number.isFinite(x0)) return null;
  return { x: x0 * W, y: y0 * H, w: Math.max(1, (x1 - x0) * W), h: Math.max(1, (y1 - y0) * H) };
}
const boxPts = (b: Bounds3): Vec3[] => [0, 1, 2, 3, 4, 5, 6, 7].map((k) => [k & 1 ? b.max[0] : b.min[0], k & 2 ? b.max[1] : b.min[1], k & 4 ? b.max[2] : b.min[2]] as Vec3);
function facePts(f: ActorGeo['face']): Vec3[] {
  const n = f.normal, up: Vec3 = [0, 1, 0];
  let r: Vec3 = [up[1] * n[2] - up[2] * n[1], up[2] * n[0] - up[0] * n[2], up[0] * n[1] - up[1] * n[0]];
  const l = Math.hypot(...r) || 1; r = [r[0] / l, r[1] / l, r[2] / l];
  const u: Vec3 = [n[1] * r[2] - n[2] * r[1], n[2] * r[0] - n[0] * r[2], n[0] * r[1] - n[1] * r[0]];
  return [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([a, b]) => [f.center[0] + r[0] * a * f.halfWidth + u[0] * b * f.halfHeight, f.center[1] + r[1] * a * f.halfWidth + u[1] * b * f.halfHeight, f.center[2] + r[2] * a * f.halfWidth + u[2] * b * f.halfHeight] as Vec3);
}
/** projected occupied regions of one posed frame through one camera (primary face, supporting face, hero prop, interaction, bodies) */
export function occupiedRegions(g: FrameGeo, spec: ShotSpec, cand: CameraCandidate, W: number, H: number): OccupiedRegion[] {
  const out: OccupiedRegion[] = [];
  for (const a of Object.values(g.actors)) {
    const isActive = a.id === spec.active, framed = spec.subjects.includes(a.id);
    const fr = projRect(cand, facePts(a.face), W, H);
    if (fr) out.push({ entityId: a.id, type: isActive ? 'primary_face' : 'supporting_face', rect: fr, importance: isActive ? 1 : 0.6 });
    const br = projRect(cand, boxPts(a.body), W, H);
    if (br) out.push({ entityId: a.id, type: 'body', rect: br, importance: isActive ? 0.8 : framed ? 0.4 : 0.2 });
  }
  for (const id of spec.heroProps) { const b = g.props[id]; if (!b) continue; const r = projRect(cand, boxPts(b), W, H); if (r) out.push({ entityId: id, type: 'hero_prop', rect: r, importance: 1 }); }
  if (g.interaction) { const r = projRect(cand, boxPts(pad(g.interaction, 0.05)), W, H); if (r) out.push({ entityId: `interaction:${g.interactionKind}`, type: 'interaction', rect: r, importance: 1 }); }
  return out;
}

// ───────────────────────────── camera / caption co-ordination ─────────────────────────────

/**
 * Pick one safe camera per shot of a caption chunk such that ONE caption band has no hard violation. Cameras are tried
 * in ranked order (odometer, last shot fastest); caption placement never changes a camera, it can only reject it.
 * No safe camera for a shot => camera blocked (null); every combination violating => CAPTION_CAMERA_COMPOSITION_BLOCKED.
 */
export function coordinateChunk<T>(lists: T[][], place: (choice: T[]) => CaptionPlacementResult, maxTries = 64): { chosen: T[] | null; placement: CaptionPlacementResult | null; retries: number; blocked: 'CAPTION_CAMERA_COMPOSITION_BLOCKED' | null } {
  if (!lists.length || !lists.every((l) => l.length)) return { chosen: null, placement: null, retries: 0, blocked: null };
  const idx = lists.map(() => 0);
  let first: CaptionPlacementResult | null = null, retries = 0;
  for (let guard = 0; guard < maxTries; guard++) {
    const choice = idx.map((k, j) => lists[j][k]);
    const res = place(choice);
    first ??= res;
    if (!res.violations.length) return { chosen: choice, placement: res, retries, blocked: null };
    retries++;
    let j = idx.length - 1;
    while (j >= 0 && idx[j] + 1 >= lists[j].length) { idx[j] = 0; j--; }
    if (j < 0) break;
    idx[j]++;
  }
  return { chosen: null, placement: first, retries, blocked: 'CAPTION_CAMERA_COMPOSITION_BLOCKED' };
}

// ───────────────────────────── integrated timeline ─────────────────────────────

export interface IntegratedShot { id: string; sourceShot: string; start: number; end: number; phraseId: string; chunkId: string; spec: ShotSpec; camera: ShotCamera | null; coverage: 'single' | 'sequential_speaker' | 'sequential_listener'; blocked: string | null; screenDirection: string; minScore: number | null; droppedOptional: string[]; cameraRejections: Record<string, number> }
export type IntegratedCaption = CaptionEvent;
export interface IntegratedTimeline {
  schema: typeof INTEGRATED_TIMELINE_SCHEMA; storyboardId: string; storyboardSha256: string; audioHash: string; seed: number; fps: number; frames: number; width: number; height: number;
  shots: IntegratedShot[]; captions: IntegratedCaption[]; captionPlacements: Array<{ chunkId: string; band: string; centerY: number; violations: string[]; warnings: string[]; overlap: Record<string, number>; cameraRetries: number; blocked: string | null }>;
  sequentialCoverage: Array<{ sourceShot: string; phraseId: string; reason: string; split: [string, string] | null; outcome: string }>;
}

export interface IntegrationInput { sb: NarratedStoryboard; tl: NarratedTimeline; plan: WorldPlan; prod: Production; width: number; height: number; onProgress?: (stage: string, done: number, total: number) => void }
export interface IntegrationResult { timeline: IntegratedTimeline; analysis: ReturnType<typeof analyze>; geos: FrameGeo[] }

export function integrateNarrated(inp: IntegrationInput): IntegrationResult {
  const { sb, tl, plan, prod, width: W, height: H } = inp;
  const ns = new NarratedScene(prod, plan), N = plan.frames, fps = plan.fps;
  // ---- pass 1: every frame through the adapter, in order (WorldState is the only transform writer) ----
  const geos: FrameGeo[] = [], diags: AdapterDiagnostics[] = [], worlds: WorldState[] = [];
  const hands: Array<{ t: number; gap: number }> = [];
  const boundary = new Set(tl.shots.map((s) => Math.round(s.start * fps)));
  const fresh = new NarratedEngineAdapter(); fresh.initialize(plan, prod);
  const resetDev: Array<{ frame: number; t: number; maxRootDevM: number; maxPropDevM: number }> = [];
  let prev: WorldState | null = null;
  for (let i = 0; i < N; i++) {
    let { world, diag } = ns.pose(i / fps, prev);
    if (boundary.has(i) && i > 0) {
      // shot-boundary reset probe: a fresh random-access evaluation must equal the sequential one exactly
      const f = fresh.applySnapshot(world, null, prod);
      let rd = 0, pd = 0;
      for (const [id, a] of Object.entries(diag.actors)) rd = Math.max(rd, d3(a.appliedRoot, f.actors[id].appliedRoot));
      for (const [id, q] of Object.entries(diag.props)) pd = Math.max(pd, d3(q.measuredPos, f.props[id].measuredPos));
      resetDev.push({ frame: i, t: r3(world.t), maxRootDevM: r4(rd), maxPropDevM: r4(pd) });
      ({ world, diag } = ns.pose(i / fps, prev)); // restore the sequential application (pure: identical transforms)
    }
    const g = extractFrameGeo(ns, i, world, diag);
    if (plan.button.pressT !== null && Math.abs(world.t - plan.button.pressT) <= 0.2 && g.actors.zapp) hands.push({ t: world.t, gap: Math.min(d3(g.actors.zapp.handR, plan.assets.button.pressSurface), d3(g.actors.zapp.handL, plan.assets.button.pressSurface)) });
    geos.push(g); diags.push(diag); worlds.push(world); prev = world;
    if (i % 300 === 0) inp.onProgress?.('pose', i, N);
  }
  // ---- pass 2+3: shots -> safe cameras, chunk by chunk with caption co-ordination ----
  const phrase = new Map(sb.script.phrases.map((p) => [p.id, p]));
  const shots: IntegratedShot[] = [], placements: IntegratedTimeline['captionPlacements'] = [], seq: IntegratedTimeline['sequentialCoverage'] = [];
  const captions: IntegratedCaption[] = [];
  let sd: ScreenDirectionState | undefined;
  const frameRange = (s: number, e: number) => { const a = Math.round(s * fps), b = Math.max(a + 1, Math.min(N, Math.round(e * fps))); return [a, b] as const; };
  const samplesOf = (s: number, e: number) => { const [a, b] = frameRange(s, e); const out: FrameGeo[] = []; for (let k = a; k < b; k += CAMERA_SAMPLE_FRAMES) out.push(geos[k]); if (out[out.length - 1] !== geos[b - 1]) out.push(geos[b - 1]); return out; };
  const byPhraseIdx = new Map<string, number>();
  const chunkIds = [...new Set(tl.shots.map((s) => s.chunkId))];
  let chunkNo = 0;
  for (const chunkId of chunkIds) {
    inp.onProgress?.('cameras', chunkNo++, chunkIds.length);
    const src = tl.shots.filter((s) => s.chunkId === chunkId);
    const cap = tl.captions.find((c) => c.chunkId === chunkId)!;
    // build the shot list for this chunk (sequential coverage may split a source shot in two)
    type Plan = { id: string; sourceShot: string; start: number; end: number; phraseId: string; spec: ShotSpec; coverage: IntegratedShot['coverage']; ranked: Ranked[]; rej: Record<string, number> };
    const planned: Plan[] = [];
    let sdLocal = sd;
    for (const s of src) {
      const p = phrase.get(s.phraseId)!, k = byPhraseIdx.get(p.id) ?? 0; byPhraseIdx.set(p.id, k + 1);
      const facts = windowFacts(plan, s.start, s.end, p.id === sb.script.phrases[0].id, s === tl.shots[tl.shots.length - 1]);
      const geosS = samplesOf(s.start, s.end), spec = shotSpec(p, facts, geosS[Math.floor(geosS.length / 2)], k);
      const rk = rankOverShot(prod, geosS, spec, W, H, sdLocal, s.id);
      const required = spec.subjects.filter((x) => !spec.optional.includes(x));
      if (rk.ranked.length || required.length < 2 || s.end - s.start < 2 * MIN_SHOT_SEC) {
        planned.push({ id: s.id, sourceShot: s.id, start: s.start, end: s.end, phraseId: s.phraseId, spec, coverage: 'single', ranked: rk.ranked, rej: rk.rejections });
        if (!rk.ranked.length && required.length >= 2) seq.push({ sourceShot: s.id, phraseId: p.id, reason: 'two required actors; no safe simultaneous camera', split: null, outcome: 'blocked: shot too short for sequential coverage' });
      } else {
        // sequential coverage inside the same interval: speaker/active first, listener/affected reaction second
        const mid = r3((s.start + s.end) / 2), other = required.find((x) => x !== spec.active)!;
        const a: ShotSpec = { ...spec, intent: spec.intent === 'wide' ? 'wide' : 'medium', subjects: [spec.active, other], optional: [other], reason: `${spec.reason} — sequential 1/2: ${spec.active}` };
        const b: ShotSpec = { ...spec, intent: 'reaction', active: other, subjects: [other, spec.active], optional: [spec.active], heroProps: [], requiresHeroProp: false, reason: `${spec.reason} — sequential 2/2: ${other} reaction` };
        const ra = rankOverShot(prod, samplesOf(s.start, mid), a, W, H, sdLocal, `${s.id}a`);
        const rb = rankOverShot(prod, samplesOf(mid, s.end), b, W, H, undefined, `${s.id}b`);
        const ok = ra.ranked.length > 0 && rb.ranked.length > 0;
        seq.push({ sourceShot: s.id, phraseId: p.id, reason: `two required actors (${spec.active}, ${other}); no readable simultaneous portrait medium (rejections: ${Object.entries(rk.rejections).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([k2, v]) => `${k2}×${v}`).join(', ') || 'none'})`, split: [`${s.id}a`, `${s.id}b`], outcome: ok ? 'sequential coverage accepted' : 'blocked: no safe sequential coverage' });
        planned.push({ id: `${s.id}a`, sourceShot: s.id, start: s.start, end: mid, phraseId: s.phraseId, spec: a, coverage: 'sequential_speaker', ranked: ra.ranked, rej: ra.rejections });
        planned.push({ id: `${s.id}b`, sourceShot: s.id, start: mid, end: s.end, phraseId: s.phraseId, spec: b, coverage: 'sequential_listener', ranked: rb.ranked, rej: rb.rejections });
      }
      const best = planned[planned.length - 1].ranked[0];
      if (best) sdLocal = nextScreenDirectionState(cameraScene(geos[frameRange(s.start, s.end)[1] - 1], planned[planned.length - 1].spec, W, H, sdLocal), best.cand);
    }
    // caption co-ordination: choose a camera per shot so the chunk has a hard-rule-safe caption band
    const [ca, cb] = frameRange(cap.start, cap.end);
    const tryPlace = (choice: CameraCandidate[]): CaptionPlacementResult => {
      const frames = [];
      for (let k = ca; k < cb; k += CAPTION_SAMPLE_FRAMES) {
        const t = k / fps, j = planned.findIndex((q) => t >= q.start - 1e-9 && t < q.end - 1e-9);
        if (j < 0) continue;
        frames.push({ time: t, occupied: occupiedRegions(geos[k], planned[j].spec, choice[j], W, H) });
      }
      return placeCaption({ frameWidth: W, frameHeight: H, lines: cap.lines, chunkStart: cap.start, chunkEnd: cap.end, frames });
    };
    const lists = planned.map((q) => q.ranked.map((r) => r.cand));
    const co = coordinateChunk(lists, tryPlace);
    const chosen = co.chosen, retries = co.retries, capBlocked = co.blocked;
    const pl = co.placement;
    placements.push({ chunkId, band: pl?.band ?? 'none', centerY: pl?.centerY ?? NaN, violations: pl?.violations ?? [], warnings: pl?.warnings ?? [], overlap: pl?.overlapMetrics ?? {}, cameraRetries: retries, blocked: capBlocked });
    captions.push(pl && !capBlocked ? { ...cap, lines: [...cap.lines], emphasisWords: [...cap.emphasisWords], placement: { centerY: pl.centerY } } : { ...cap, lines: [...cap.lines], emphasisWords: [...cap.emphasisWords] });
    planned.forEach((q, j) => {
      const c = chosen?.[j] ?? q.ranked[0]?.cand ?? null, r = c ? q.ranked.find((x) => x.cand === c)! : null;
      const g0 = geos[frameRange(q.start, q.end)[0]];
      const sdRes = c ? evaluateCameraCandidate(cameraScene(g0, q.spec, W, H, sd), c).screenDirectionResult : 'n/a';
      shots.push({
        id: q.id, sourceShot: q.sourceShot, start: q.start, end: q.end, phraseId: q.phraseId, chunkId, spec: q.spec, coverage: q.coverage,
        camera: c ? { id: c.id, intent: c.intent, kind: c.id.split(':')[1], position: c.transform.position.map(r4) as Vec3, target: c.target.map(r4) as Vec3, fovDeg: c.fov } : null,
        blocked: c ? null : 'CAMERA_SAFETY_BLOCKED', screenDirection: sdRes, minScore: r ? r4(r.minScore) : null, droppedOptional: r ? [...new Set(r.results.flatMap((x) => x.diagnostics.droppedOptionalSubjects))].sort() : [], cameraRejections: q.rej,
      });
      if (c) sd = nextScreenDirectionState(cameraScene(geos[frameRange(q.start, q.end)[1] - 1], q.spec, W, H, sd), c);
    });
  }
  const timeline: IntegratedTimeline = { schema: INTEGRATED_TIMELINE_SCHEMA, storyboardId: sb.id, storyboardSha256: tl.storyboardSha256, audioHash: tl.audioHash, seed: sb.seed, fps, frames: N, width: W, height: H, shots, captions, captionPlacements: placements, sequentialCoverage: seq };
  inp.onProgress?.('gates', 0, 1);
  const analysis = analyze({ sb, tl, plan, prod, W, H, geos, diags, worlds, timeline, hands, resetDev });
  return { timeline, analysis, geos };
}

// ───────────────────────────── analysis + blocking gates ─────────────────────────────

export interface Gate { id: string; group: 'world' | 'camera' | 'caption' | 'semantic'; name: string; pass: boolean; detail: string }

function quatAngleDeg(a: readonly number[], b: readonly number[]): number { const d = Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])); return (2 * Math.acos(d)) / DEG; }

function analyze(x: { sb: NarratedStoryboard; tl: NarratedTimeline; plan: WorldPlan; prod: Production; W: number; H: number; geos: FrameGeo[]; diags: AdapterDiagnostics[]; worlds: WorldState[]; timeline: IntegratedTimeline; hands: Array<{ t: number; gap: number }>; resetDev: Array<{ frame: number; t: number; maxRootDevM: number; maxPropDevM: number }> }) {
  const { plan, diags, worlds, geos, timeline, W, H } = x, fps = plan.fps, N = plan.frames, M = plan.assets.marks;
  const gates: Gate[] = [];
  const g = (id: string, group: Gate['group'], name: string, pass: boolean, detail: string) => gates.push({ id, group, name, pass, detail });
  const ev = (type: string) => plan.events.filter((e) => e.type === type).map((e) => e.t);
  // ---- world / motion ----
  const applied = diags.filter((d, i) => Math.abs(d.t - worlds[i].t) < 1e-9 && Object.values(d.actors).every((a) => a.rootDeviationM <= 1e-5)).length;
  const maxRootDev = Math.max(...diags.flatMap((d) => Object.values(d.actors).map((a) => a.rootDeviationM)));
  const unplanned = Math.max(...diags.map((d) => d.maxUnplannedDeltaM));
  const resetFlags = diags.filter((d) => d.transformResetByShot).length;
  const maxResetDev = Math.max(0, ...x.resetDev.map((r) => Math.max(r.maxRootDevM, r.maxPropDevM)));
  const kiraSafe = Math.min(...diags.map((d) => d.actors.kira ? d2(d.actors.kira.appliedRoot, M.kira_safe.pos) : Infinity));
  const zappImpact = Math.min(...diags.filter((d) => d.t <= (plan.coin.tip?.tc ?? Infinity)).map((d) => d2(d.actors.zapp.appliedRoot, M.zapp_impact.pos)));
  const jumpSeg = plan.actors.zapp.segs.find((s) => s.kind === 'jump');
  const jumpH = jumpSeg ? Math.max(...diags.filter((d) => d.t >= jumpSeg.t0 && d.t <= jumpSeg.t1).map((d) => d.actors.zapp.appliedRoot[1] - d.actors.zapp.groundOffsetM - jumpSeg.p0[1])) : 0;
  const pressGap = x.hands.length ? Math.min(...x.hands.map((h) => h.gap)) : Infinity, pressGapT = x.hands.find((h) => h.gap === pressGap)?.t ?? null;
  const growFrom = (plan.coin.stand?.t0 ?? Infinity) + 0.34, tipT0 = plan.coin.tip?.t0 ?? Infinity;
  const drift = diags.filter((d) => d.t >= growFrom && d.t < tipT0 - 1e-3 && d.props.coin?.lowestPoint).map((d) => d3(d.props.coin.lowestPoint!, plan.coin.base!));
  const coinDrift = drift.length ? Math.max(...drift) : 0;
  const onsets = diags.filter((d) => d.contacts.onsetThisFrame).map((d) => r3(d.t)), falls = diags.filter((d) => d.contacts.fallStartedThisFrame).map((d) => r3(d.t));
  const pen = diags.filter((d) => d.penetration.checked);
  const minGap = pen.length ? Math.min(...pen.map((d) => d.penetration.zappMinGapM ?? Infinity)) : Infinity;
  const minGapAt = pen.find((d) => d.penetration.zappMinGapM === minGap);
  const maxDepth = pen.length ? Math.max(...pen.map((d) => d.penetration.zappMaxDepthM)) : 0;
  const headInside = pen.some((d) => d.penetration.headInsideCoin);
  const kiraGap = pen.length ? Math.min(...pen.map((d) => d.penetration.kiraMinGapM ?? Infinity)) : Infinity;
  const tc = plan.coin.tip?.tc ?? null;
  const kiraAtContact = tc !== null ? diags[Math.min(N - 1, Math.ceil(tc * fps))].penetration.kiraMinGapM : null;
  const proneFrom = ev('patient_prone')[0] ?? Infinity;
  const notProne = worlds.filter((w) => w.t >= proneFrom + 1e-6 && w.actors.zapp.posture !== 'prone').map((w) => r3(w.t));
  const resetT = plan.button.resetT ?? Infinity;
  const stoodAfterReset = diags.filter((d) => d.t >= resetT && d.actors.zapp.posture !== 'prone').length;
  const coinThk = diags.filter((d) => d.props.coin?.visible && d.props.coin.thicknessM !== null).map((d) => d.props.coin.thicknessM! / Math.max(1e-9, d.props.coin.radiusM!));
  const thkDev = coinThk.length ? Math.max(...coinThk) - Math.min(...coinThk) : 0;
  const coinFinal = diags[N - 1].props.coin;
  let headStep = 0, headAng = 0, headStepAt = 0, headAngAt = 0;
  for (let i = 1; i < N; i++) for (const [id, a] of Object.entries(diags[i].actors)) {
    const p = diags[i - 1].actors[id];
    if (!p) continue;
    for (let k = 0; k < Math.min(a.headLocal.length, p.headLocal.length); k++) { const s = d3(a.headLocal[k], p.headLocal[k]); if (s > headStep) { headStep = s; headStepAt = diags[i].t; } }
    const ang = quatAngleDeg(a.headQuatLocal, p.headQuatLocal); if (ang > headAng) { headAng = ang; headAngAt = diags[i].t; }
  }
  const adapterBlocking = [...new Set(diags.flatMap((d) => d.blocking.map((b) => b.code)))];
  g('W01', 'world', 'WorldState applied at every sampled frame', applied === N, `${applied}/${N} frames, max root deviation ${maxRootDev} m`);
  g('W02', 'world', 'no unexplained actor/prop teleport', unplanned <= 1e-5, `max |applied - planned| per-frame delta ${unplanned} m`);
  g('W03', 'world', 'no shot-boundary transform reset', resetFlags === 0 && maxResetDev <= 1e-6, `${x.resetDev.length} boundaries probed, max deviation ${maxResetDev} m, reset flags ${resetFlags}`);
  g('W04', 'world', 'Kira reaches kira_safe', kiraSafe <= 0.02, `min distance ${r4(kiraSafe)} m (event ${ev('reached_safe')[0] ?? 'none'} s)`);
  g('W05', 'world', 'Zapp reaches zapp_impact', zappImpact <= 0.02, `min distance before contact ${r4(zappImpact)} m (event ${ev('reached_mark').find((t) => t < (tc ?? Infinity)) ?? 'none'} s)`);
  g('W06', 'world', 'jump has real vertical displacement', jumpH >= MIN_JUMP_M, `peak ${r4(jumpH)} m (>= ${MIN_JUMP_M})`);
  g('W07', 'world', 'press has valid hand/button contact', pressGap <= MAX_PRESS_HAND_GAP_M, `min hand/press-surface gap ${r4(pressGap)} m at ${pressGapT} s (<= ${MAX_PRESS_HAND_GAP_M})`);
  g('W08', 'world', 'coin base drift <= 0.01 m while growing', coinDrift <= MAX_COIN_BASE_DRIFT_M, `max drift ${r4(coinDrift)} m over ${drift.length} frames`);
  g('W09', 'world', 'exactly one coin/Zapp contact', onsets.length === 1, `contacts at ${onsets.join(', ') || 'none'} (planned ${tc !== null ? r3(tc) : 'none'})`);
  g('W10', 'world', 'fall begins on contact', onsets.length === 1 && falls.length === 1 && falls[0] === onsets[0], `fall start ${falls.join(', ') || 'none'}`);
  g('W11', 'world', 'no Zapp/coin penetration', maxDepth <= PENETRATION_TOLERANCE_M && !headInside && !adapterBlocking.includes('COIN_BODY_PENETRATION'), `max depth ${maxDepth} m, head inside ${headInside}`);
  g('W12', 'world', `actual posed Zapp/coin clearance >= ${MIN_COIN_CLEARANCE_M} m`, minGap >= MIN_COIN_CLEARANCE_M, `min ${minGap === Infinity ? 'n/a' : r4(minGap)} m at t=${minGapAt ? r3(minGapAt.t) : 'n/a'} (frame ${minGapAt ? Math.round(minGapAt.t * fps) : 'n/a'})`);
  g('W13', 'world', 'Kira outside the hazard', kiraGap > 0 && (kiraAtContact ?? Infinity) >= KIRA_HAZARD_MARGIN_M, `min Kira/coin gap ${r4(kiraGap)} m; at contact ${kiraAtContact === null ? 'n/a' : r4(kiraAtContact)} m (>= ${KIRA_HAZARD_MARGIN_M})`);
  g('W14', 'world', 'Zapp prone through episode end', notProne.length === 0 && worlds[N - 1].actors.zapp.posture === 'prone', `prone from ${proneFrom} s; non-prone frames after: ${notProne.length}`);
  g('W15', 'world', 'button reset does not stand Zapp up', stoodAfterReset === 0, `reset at ${plan.button.resetT} s; non-prone frames after reset ${stoodAfterReset}`);
  g('W16', 'world', `local head displacement <= ${MAX_HEAD_STEP_M} m/frame`, headStep <= MAX_HEAD_STEP_M, `max ${r4(headStep)} m at ${r3(headStepAt)} s`);
  g('W17', 'world', `local head angular change <= ${MAX_HEAD_STEP_DEG} deg/frame`, headAng <= MAX_HEAD_STEP_DEG, `max ${r3(headAng)} deg at ${r3(headAngAt)} s`);
  g('W18', 'world', 'coin keeps its thickness (uniform scale)', thkDev <= 1e-4 && !adapterBlocking.includes('NON_UNIFORM_PROP_SCALE'), `thickness/radius ratio spread ${thkDev.toExponential(2)} (diagnostics rounded to 1e-6 m); final thickness ${coinFinal?.thicknessM} m`);
  g('W19', 'world', 'no adapter blocking diagnostics', adapterBlocking.length === 0, adapterBlocking.join(', ') || 'none');
  // ---- camera: the chosen camera re-evaluated on the posed scene at EVERY frame ----
  const shotAt = (t: number) => timeline.shots.find((s) => t >= s.start - 1e-9 && t < s.end - 1e-9) ?? timeline.shots[timeline.shots.length - 1];
  const cam = { collisions: 0, pathCollisions: 0, faceMin: Infinity, faceMinAt: 0, propMin: Infinity, propMinAt: 0, clutterMax: 0, clutterAt: 0, headCropped: 0, subjectSmall: 0, screenDir: 0, requiredDropped: 0, occlusion: 0, frames: 0, rejectedFrames: [] as Array<{ t: number; shot: string; reasons: string[] }>, headHeights: {} as Record<string, { min: number; max: number }> };
  let sdState: ScreenDirectionState | undefined, lastShot = '';
  for (let i = 0; i < N; i++) {
    const s = shotAt(i / fps);
    if (!s.camera) continue;
    const c: CameraCandidate = { id: s.camera.id, intent: s.camera.intent, transform: { position: s.camera.position }, target: s.camera.target, fov: s.camera.fovDeg, activeSubjectId: s.spec.active, requiresHeroProp: s.spec.requiresHeroProp && s.spec.heroProps.length > 0, ...(s.camera.kind === 'two_character_medium' ? { framedSubjectIds: s.spec.subjects.filter((q) => !s.spec.optional.includes(q)) } : {}) };
    const first = s.id !== lastShot;
    const sc = cameraScene(geos[i], s.spec, W, H, first ? sdState : { ...sdState, previousCameraSide: undefined });
    const r = evaluateCameraCandidate(sc, c);
    cam.frames++;
    const R = r.rejectionReasons.join(' ');
    if (/COLLISION|LENS/i.test(R) && !/PATH/i.test(R)) cam.collisions++;
    if (/PATH/i.test(R)) cam.pathCollisions++;
    if (/OCCLU/i.test(R)) cam.occlusion++;
    if (/HEAD_CROP|CROP/i.test(R)) cam.headCropped++;
    if (/TOO_SMALL|TOO_LARGE/i.test(R)) cam.subjectSmall++;
    if (/SCREEN_DIRECTION|reversed_unmotivated/i.test(R) || r.screenDirectionResult.startsWith('reversed_unmotivated')) cam.screenDir++;
    cam.requiredDropped += r.diagnostics.droppedRequiredSubjects.length ? 1 : 0;
    // prop inserts do not require faces (the evaluator exempts them); every other intent reports its required faces
    if (s.spec.intent !== 'prop') for (const id of r.diagnostics.requiredSubjects) { const v = r.faceVisibility[id]; if (v !== undefined && v < cam.faceMin) { cam.faceMin = v; cam.faceMinAt = i / fps; } }
    for (const id of sc.heroPropIds) { const v = r.propVisibility[id]; if (v !== undefined && v < cam.propMin) { cam.propMin = v; cam.propMinAt = i / fps; } }
    if (r.foregroundCoverage > cam.clutterMax) { cam.clutterMax = r.foregroundCoverage; cam.clutterAt = i / fps; }
    for (const [id, hh] of Object.entries(r.diagnostics.requiredHeadHeightPct)) { const m = (cam.headHeights[`${s.spec.intent}:${id}`] ??= { min: Infinity, max: -Infinity }); m.min = Math.min(m.min, hh); m.max = Math.max(m.max, hh); }
    if (!r.accepted) cam.rejectedFrames.push({ t: r3(i / fps), shot: s.id, reasons: r.rejectionReasons.slice(0, 4) });
    if (first) lastShot = s.id;
    const nextIsNew = i + 1 >= N || shotAt((i + 1) / fps).id !== s.id;
    if (nextIsNew) sdState = nextScreenDirectionState(sc, c);
  }
  const blockedShots = timeline.shots.filter((s) => !s.camera);
  const seqBlocked = timeline.sequentialCoverage.filter((q) => q.outcome.startsWith('blocked'));
  const requiredInFrames = timeline.shots.every((s) => s.camera && s.spec.subjects.filter((q) => !s.spec.optional.includes(q)).every((q) => !s.droppedOptional.includes(q)));
  g('C01', 'camera', 'no lens/body/head/hair/prop collision', cam.collisions === 0, `${cam.collisions} frames with lens collision over ${cam.frames} evaluated frames`);
  g('C02', 'camera', 'no camera path collision', cam.pathCollisions === 0, `${cam.pathCollisions} frames (static cameras: path = lens position)`);
  g('C03', 'camera', 'required face visibility threshold', cam.faceMin >= CAMERA_SAFETY_DEFAULTS.ecuMinFaceVisibility && cam.rejectedFrames.every((f) => !f.reasons.some((q) => /FACE/i.test(q))), `min required-face visibility ${r3(cam.faceMin)} at ${r3(cam.faceMinAt)} s`);
  g('C04', 'camera', 'hero-prop visibility threshold', cam.propMin === Infinity || cam.propMin >= CAMERA_SAFETY_DEFAULTS.minHeroPropVisibility, `min hero-prop visibility ${cam.propMin === Infinity ? 'n/a' : r3(cam.propMin)} at ${r3(cam.propMinAt)} s`);
  g('C05', 'camera', 'foreground clutter <= 35%', cam.clutterMax <= CAMERA_SAFETY_DEFAULTS.maxForegroundCoverage, `max ${r3(cam.clutterMax)} at ${r3(cam.clutterAt)} s`);
  g('C06', 'camera', 'non-ECU head not cropped', cam.headCropped === 0, `${cam.headCropped} frames`);
  g('C07', 'camera', 'required subject size appropriate for intent', cam.subjectSmall === 0, `${cam.subjectSmall} frames outside the intent head-size band`);
  g('C08', 'camera', 'no unmotivated screen-direction reversal', cam.screenDir === 0, `${cam.screenDir} frames`);
  g('C09', 'camera', 'no required actor silently dropped', cam.requiredDropped === 0 && requiredInFrames && seqBlocked.length === 0, `${cam.requiredDropped} frames; sequential-coverage blocks ${seqBlocked.length}`);
  g('C10', 'camera', 'no camera safety fallback failure (every shot has an accepted camera on every frame)', blockedShots.length === 0 && cam.rejectedFrames.length === 0, blockedShots.length ? `CAMERA_SAFETY_BLOCKED: ${blockedShots.map((s) => s.id).join(', ')}` : `${cam.rejectedFrames.length} rejected frames${cam.rejectedFrames[0] ? ` (first ${cam.rejectedFrames[0].t} s ${cam.rejectedFrames[0].shot}: ${cam.rejectedFrames[0].reasons.join('; ')})` : ''}`);
  g('C11', 'camera', 'head/face/prop occlusion', cam.occlusion === 0, `${cam.occlusion} frames with an occlusion rejection`);
  // ---- captions ----
  const pls = timeline.captionPlacements;
  const typed = timeline.captions.every((c) => typeof c.placement?.centerY === 'number' && Number.isFinite(c.placement.centerY));
  const inSafe = timeline.captions.every((c) => c.placement && c.placement.centerY >= 0.08 && c.placement.centerY <= 0.84);
  const faceMax = Math.max(0, ...pls.map((p) => p.overlap.primary_face_max ?? 0)), propMax = Math.max(0, ...pls.map((p) => p.overlap.hero_prop_max ?? 0));
  const inter = pls.filter((p) => (p.overlap.interaction_clearance_hit ?? 0) > 0 || p.violations.includes('INTERACTION')).length;
  const conflicts = pls.filter((p) => p.warnings.includes('CAPTION_PLACEMENT_CONFLICT') && p.violations.length), blocked = pls.filter((p) => p.blocked);
  const cap0 = x.tl.captions;
  const unchanged = cap0.length === timeline.captions.length && cap0.every((c, k) => { const d = timeline.captions[k]; return d.start === c.start && d.end === c.end && d.lines.join('|') === c.lines.join('|') && d.emphasisWords.join('|') === c.emphasisWords.join('|'); });
  g('K01', 'caption', 'placement declared in typed render data', typed, `${timeline.captions.filter((c) => c.placement).length}/${timeline.captions.length} chunks carry placement.centerY`);
  g('K02', 'caption', 'caption inside the safe area', inSafe && pls.every((p) => (p.overlap.bottom_ui_overlap_px ?? 0) === 0 && (p.overlap.edge_overflow_px ?? 0) === 0), `centres ${[...new Set(pls.map((p) => p.band))].join('/')}`);
  g('K03', 'caption', 'caption covers <= 8% of the primary face', faceMax <= PRIMARY_FACE_CAPTION_MAX, `max ${r4(faceMax)}`);
  g('K04', 'caption', 'caption avoids the interaction point', inter === 0, `${inter} chunks`);
  g('K05', 'caption', 'caption covers <= 50% of the hero prop', propMax <= HERO_PROP_CAPTION_MAX, `max ${r4(propMax)}`);
  g('K06', 'caption', 'caption stable through each chunk', timeline.captions.every((c) => !!c.placement), 'one placement per chunk (placeCaption: stableForWholeChunk)');
  g('K07', 'caption', 'no unresolved CAPTION_PLACEMENT_CONFLICT', conflicts.length === 0, conflicts.map((p) => p.chunkId).join(', ') || 'none');
  g('K08', 'caption', 'no CAPTION_CAMERA_COMPOSITION_BLOCKED', blocked.length === 0, blocked.map((p) => p.chunkId).join(', ') || 'none');
  g('K09', 'caption', 'caption text, line breaks, emphasis and timing unchanged', unchanged, `${cap0.length} chunks compared`);
  // ---- semantic ----
  const byGate = (id: string) => gates.find((q) => q.id === id)!.pass;
  const kiraMoved = d2(diags[0].actors.kira.appliedRoot, M.kira_safe.pos) >= 1.0 && byGate('W04');
  const kiraWalkShots = timeline.shots.filter((s) => s.spec.active === 'kira' && s.spec.intent === 'wide' && s.camera);
  const pressShots = timeline.shots.filter((s) => s.spec.heroProps.includes('button') && s.spec.intent === 'prop' && s.camera && plan.button.pressT !== null && plan.button.pressT >= s.start && plan.button.pressT < s.end);
  const jumpShot = jumpSeg ? timeline.shots.find((s) => s.camera && jumpSeg.t0 < s.end && jumpSeg.t1 > s.start && s.spec.intent === 'wide') : null;
  const tip = plan.coin.tip;
  const tipRot = tip ? diags.filter((d) => d.t >= tip.t0 && d.t <= tip.t1).map((d) => d.props.coin.rotDeg[0]) : [];
  const monotonic = tipRot.every((v, k) => !k || v >= tipRot[k - 1] - 1e-6);
  g('S01', 'semantic', '"jump" visibly moves vertically', byGate('W06') && !!jumpShot, `peak ${r4(jumpH)} m; covering wide ${jumpShot?.id ?? 'none'}`);
  g('S02', 'semantic', '"move safely" visibly changes Kira\'s location', kiraMoved && kiraWalkShots.length > 0, `Kira desk->safe ${r4(d2(diags[0].actors.kira.appliedRoot, M.kira_safe.pos))} m; shots ${kiraWalkShots.map((s) => s.id).join(', ') || 'none'}`);
  g('S03', 'semantic', '"press" shows reachable contact', byGate('W07') && pressShots.length > 0, `press shot ${pressShots.map((s) => s.id).join(', ') || 'none'}`);
  g('S04', 'semantic', '"grow" retains a fixed base', byGate('W08'), `drift ${r4(coinDrift)} m`);
  g('S05', 'semantic', '"tip" uses continuous rotation', tipRot.length > 2 && monotonic, `${tipRot.length} frames, ${r3(tipRot[0] ?? 0)} -> ${r3(tipRot[tipRot.length - 1] ?? 0)} deg, monotonic ${monotonic}`);
  g('S06', 'semantic', '"flatten/fall" has one visible contact and coherent end positions', byGate('W09') && byGate('W10') && byGate('W14') && timeline.shots.some((s) => s.camera && tc !== null && tc >= s.start && tc < s.end && s.spec.heroProps.includes('coin')), `contact ${onsets.join(', ')}; end Zapp ${worlds[N - 1].actors.zapp.posture}, coin ${coinFinal?.phase}`);
  g('S07', 'semantic', '"reset" preserves the consequence', byGate('W15') && coinFinal?.visible === true && worlds[N - 1].props.coin.phase === 'resting', `final coin ${worlds[N - 1].props.coin.phase} visible=${coinFinal?.visible}, Zapp ${worlds[N - 1].actors.zapp.posture}`);
  g('S08', 'semantic', 'no teacher character instantiated', !x.prod.rigs.has('teacher') && Object.keys(plan.actors).every((a) => a === 'zapp' || a === 'kira') && Object.values(plan.offscreen).every((o) => o.cues.length >= 0), `rigs: ${[...x.prod.rigs.keys()].join(', ')}`);
  const failed = gates.filter((q) => !q.pass).map((q) => q.id);
  const shotDur = timeline.shots.map((s) => s.end - s.start);
  return {
    schema: ANALYSIS_SCHEMA, frames: N, fps, resolution: [W, H], storyboardId: x.sb.id, audioHash: x.tl.audioHash,
    summary: { total: gates.length, passed: gates.length - failed.length, failed, blocking: failed.length > 0 },
    world: {
      framesApplied: applied, maxRootDeviationM: maxRootDev, maxUnplannedDeltaM: unplanned, shotResetDeviations: x.resetDev, maxShotResetDeviationM: maxResetDev,
      coinBaseDriftM: r4(coinDrift), contact: { count: onsets.length, times: onsets, planned: tc !== null ? r3(tc) : null, fallStart: falls },
      coinZappClearance: { minM: minGap === Infinity ? null : r4(minGap), t: minGapAt ? r3(minGapAt.t) : null, frame: minGapAt ? Math.round(minGapAt.t * fps) : null, maxDepthM: maxDepth, headInsideCoin: headInside, thresholdM: MIN_COIN_CLEARANCE_M },
      kira: { reachedSafeMinDistM: r4(kiraSafe), safeAt: ev('reached_safe')[0] ?? null, returnedDeskAt: ev('reached_mark').find((t) => t > (tc ?? 0)) ?? null, minHazardGapM: kiraGap === Infinity ? null : r4(kiraGap), hazardGapAtContactM: kiraAtContact === null ? null : r4(kiraAtContact), displacementDeskToSafeM: r4(d2(diags[0].actors.kira.appliedRoot, M.kira_safe.pos)) },
      zapp: { reachedImpactMinDistM: r4(zappImpact), jumpPeakM: r4(jumpH), pressHandGapM: r4(pressGap), pressHandGapT: pressGapT, finalPosture: worlds[N - 1].actors.zapp.posture, proneFrom, nonProneAfter: notProne.length },
      head: { maxLocalDisplacementM: r4(headStep), atT: r3(headStepAt), maxAngularDeltaDeg: r3(headAng), angularAtT: r3(headAngAt) },
      coinFinal: coinFinal ? { phase: worlds[N - 1].props.coin.phase, thicknessM: coinFinal.thicknessM, radiusM: coinFinal.radiusM, rotDeg: coinFinal.rotDeg } : null,
      adapterBlocking,
    },
    camera: { evaluatedFrames: cam.frames, collisions: cam.collisions, pathCollisions: cam.pathCollisions, occlusionFrames: cam.occlusion, faceVisibilityMin: r3(cam.faceMin), faceVisibilityMinAt: r3(cam.faceMinAt), heroPropVisibilityMin: cam.propMin === Infinity ? null : r3(cam.propMin), heroPropVisibilityMinAt: r3(cam.propMinAt), foregroundClutterMax: r3(cam.clutterMax), foregroundClutterAt: r3(cam.clutterAt), headCroppedFrames: cam.headCropped, subjectSizeFrames: cam.subjectSmall, screenDirectionViolations: cam.screenDir, requiredActorDropFrames: cam.requiredDropped, subjectHeadHeights: Object.fromEntries(Object.entries(cam.headHeights).map(([k, v]) => [k, { min: r4(v.min), max: r4(v.max) }])), rejectedFrames: cam.rejectedFrames.slice(0, 60), rejectedFrameCount: cam.rejectedFrames.length, blockedShots: blockedShots.map((s) => ({ id: s.id, spec: s.spec.reason, rejections: s.cameraRejections })) },
    captions: { chunks: pls.length, primaryFaceMax: r4(faceMax), heroPropMax: r4(propMax), interactionHits: inter, conflicts: conflicts.map((p) => p.chunkId), compositionBlocked: blocked.map((p) => p.chunkId), cameraRetries: pls.reduce((a, p) => a + p.cameraRetries, 0), bands: Object.fromEntries(['upper', 'middle', 'lower'].map((b) => [b, pls.filter((p) => p.band === b).length])) },
    shots: { count: timeline.shots.length, meanSec: r3(shotDur.reduce((a, b) => a + b, 0) / shotDur.length), minSec: r3(Math.min(...shotDur)), maxSec: r3(Math.max(...shotDur)), sequentialCoverage: timeline.sequentialCoverage, requiredActorDrops: timeline.shots.filter((s) => !s.camera).length },
    gates,
  };
}

// ───────────────────────────── render-time camera ─────────────────────────────

/** the integrated camera for frame time t (static per shot; cameras never touch the world) */
export function cameraAt(tl: Pick<IntegratedTimeline, 'shots'>, t: number): CameraState {
  const s = tl.shots.find((x) => t >= x.start - 1e-9 && t < x.end - 1e-9) ?? tl.shots[tl.shots.length - 1];
  if (!s.camera) throw new Error(`CAMERA_SAFETY_BLOCKED: shot ${s.id} has no safe camera; refusing to render`);
  return { pos: [...s.camera.position] as Vec3, target: [...s.camera.target] as Vec3, fovY: s.camera.fovDeg * DEG };
}
