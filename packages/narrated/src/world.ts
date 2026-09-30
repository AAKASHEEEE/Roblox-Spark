// Narrated world state (Checkpoint 1): an authoritative, deterministic, engine-independent scene simulation.
// The approved storyboard is folded through the action contracts (contracts.ts) into per-entity continuous tracks;
// sampleWorld(t) answers where everyone and everything is, what they do and what touches what. Cameras do not
// exist here: shots are only annotations and can never change a transform. No rendering engine is called.
import type { NarratedStoryboard, NarratedPhrase } from './schema.ts';
import { CONTRACTS, CONTRACT_SET_VERSION, type ContractId, type ContractInstance, type Bridge, type PlanError } from './contracts.ts';

export const WORLD_SCHEMA = 'blockspark.narrated-world/1';
export type Vec3 = [number, number, number];
export type Posture = 'standing' | 'walking' | 'jumping' | 'falling' | 'prone' | 'implied_seated';
export type PropPhase = 'hidden' | 'spawned' | 'growing' | 'upright' | 'tipping' | 'resting' | 'reset';

// ---------- versioned mark layout (existing marks keep their coordinates; added marks change no geometry) ----------
export const MARK_IDS = ['zapp_desk', 'kira_desk', 'button_desk', 'coin_spawn', 'kira_safe', 'zapp_impact', 'classroom_door'] as const;
export type MarkId = (typeof MARK_IDS)[number];
export interface Mark { id: MarkId; pos: Vec3; facingDeg: number; source: 'environment' | 'prop_anchor' | 'added'; offscreenOnly: boolean }
export const MARK_LAYOUT = {
  id: 'classroom-staging', version: '1.0.0', environment: 'classroom@1.1.0',
  existing: ['zapp_desk', 'kira_desk', 'kira_safe'] as const,
  added: {
    coin_spawn: { pos: [-2.1, 0, -1.4] as Vec3, facingDeg: 0, offscreenOnly: false },
    zapp_impact: { pos: [-2.1, 0, 1.2] as Vec3, facingDeg: 0, offscreenOnly: false },
    // off-screen direction only: the classroom has no door geometry; never framed, never a mesh or a character
    classroom_door: { pos: [-4.4, 0, -3.4] as Vec3, facingDeg: 45, offscreenOnly: true },
  },
} as const;

export interface WorldAssets { layout: string; marks: Record<MarkId, Mark>; coin: { radius: number; thickness: number }; button: { base: Vec3; pressSurface: Vec3; spawnPoint: Vec3 }; desk: { center: Vec3; half: Vec3 }; body: { height: number; radius: number } }
type LibLike = { environments: Record<string, any>; props: Record<string, any> };
const add = (a: readonly number[], b: readonly number[]): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export function worldAssets(lib: LibLike): WorldAssets {
  const env = lib.environments[MARK_LAYOUT.environment];
  if (!env) throw new Error(`mark layout ${MARK_LAYOUT.id}@${MARK_LAYOUT.version} needs ${MARK_LAYOUT.environment}`);
  const desk = lib.props['student_desk@1.0.0'], btn = lib.props['suspicious_button@1.0.0'], coin = lib.props['spark_coin@1.0.0'];
  const deskAt = env.anchors.hero_desk_spot as Vec3, base = add(deskAt, desk.anchors.button_spot);
  const marks = {} as Record<MarkId, Mark>;
  for (const id of MARK_LAYOUT.existing) marks[id] = { id, pos: [...env.marks[id].pos] as Vec3, facingDeg: env.marks[id].facingDeg, source: 'environment', offscreenOnly: false };
  marks.button_desk = { id: 'button_desk', pos: base, facingDeg: 0, source: 'prop_anchor', offscreenOnly: false };
  for (const [id, m] of Object.entries(MARK_LAYOUT.added)) marks[id as MarkId] = { id: id as MarkId, pos: [...m.pos] as Vec3, facingDeg: m.facingDeg, source: 'added', offscreenOnly: m.offscreenOnly };
  const d = coin.dimensions as number[];
  return {
    layout: `${MARK_LAYOUT.id}@${MARK_LAYOUT.version}`, marks, coin: { radius: Math.max(d[0], d[2]) / 2, thickness: d[1] },
    button: { base, pressSurface: add(base, btn.anchors.press_surface), spawnPoint: add(base, btn.anchors.spawn_point) },
    desk: { center: add(deskAt, [0, desk.dimensions[1] / 2, 0]), half: [desk.dimensions[0] / 2, desk.dimensions[1] / 2, desk.dimensions[2] / 2] },
    body: { height: 1.96, radius: 0.2 }, // block biped: head top ~1.96 m (face probe 1.70 + half head 0.26); body capsule radius
  };
}

// ---------- state types ----------
export interface ActorState { id: string; pos: Vec3; yawDeg: number; mark: string | null; posture: Posture; action: string | null; contract: string | null; heldPose: string; lookTarget: string | null; expression: string; velocity: Vec3; grounded: boolean; contacts: string[]; bodyPitchDeg: number }
export interface PropState { id: string; visible: boolean; parent: string; anchor: string | null; pos: Vec3; scale: number; rotDeg: Vec3; basePoint: Vec3; pivot: Vec3 | null; phase: PropPhase; velocity: Vec3; contacts: string[]; radius: number; thickness: number; upright: number; capDepth?: number; glow?: number }
export interface EventState { id: string; type: string; t: number; source: string; target: string | null; pos: Vec3 | null; once: true; contract: string }
export interface OffScreenState { id: string; mark: 'classroom_door'; direction: Vec3; latestCue: string | null; cueAt: number | null; instantiated: false }
export interface WorldState { schema: typeof WORLD_SCHEMA; t: number; actors: Record<string, ActorState>; props: Record<string, PropState>; events: EventState[]; offscreen: Record<string, OffScreenState> }

// ---------- tracks ----------
interface PathPlan { pts: Vec3[]; heads: number[]; cum: number[]; len: number; speed: number; tw0: number; tw1: number; yawIn: number; yawOut: number; tauCorner: number }
interface FallPlan { feet: Vec3; samples: Array<[number, number]> } // [t, pitchDeg]
interface ActorSeg { t0: number; t1: number; kind: 'hold' | 'turn' | 'path' | 'jump' | 'fall'; contract: string; action: string | null; posture: Posture; endPosture: Posture; heldPose: string; mark: string | null; endMark: string | null; p0: Vec3; yaw0: number; p1: Vec3; yaw1: number; path?: PathPlan; jumpH?: number; fall?: FallPlan }
interface ActorTrack { id: string; start: { pos: Vec3; yaw: number; mark: string }; segs: ActorSeg[]; looks: Array<{ t: number; v: string | null }>; exprs: Array<{ t: number; v: string }>; contacts: Array<{ t0: number; t1: number; with: string }> }
interface CoinPlan { hidden: Vec3; spawn: { t0: number; t1: number; from: Vec3; to: Vec3 } | null; base: Vec3 | null; stand: { t0: number; t1: number } | null; grows: Array<{ t0: number; t1: number; s0: number; s1: number }>; tip: { t0: number; tc: number; t1: number; freeT: number; thetaC: number; thetaR: number; pivot: Vec3; scale: number; coupled: Array<[number, number]> } | null }
export interface WorldPlan {
  schema: typeof WORLD_SCHEMA; contracts: string; layout: string; storyboardId: string; seed: number; fps: number; duration: number; frames: number;
  assets: WorldAssets; actors: Record<string, ActorTrack>; coin: CoinPlan; button: { pressT: number | null; resetT: number | null; flashes: Array<[number, number]> };
  events: EventState[]; instances: ContractInstance[]; bridges: Bridge[]; errors: PlanError[]; warnings: Array<{ code: string; phraseId: string | null; message: string }>;
  offscreen: Record<string, { cues: Array<{ t: number; cue: string }> }>; status: 'ok' | 'unavailable';
}

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const smooth = (u: number) => { const x = clamp(u, 0, 1); return x * x * (3 - 2 * x); };
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
const lerp3 = (a: Vec3, b: Vec3, u: number): Vec3 => [lerp(a[0], b[0], u), lerp(a[1], b[1], u), lerp(a[2], b[2], u)];
const dist2 = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[2] - b[2]);
const dist3 = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const DEG = Math.PI / 180;
const yawTo = (from: readonly number[], to: readonly number[]) => Math.atan2(to[0] - from[0], to[2] - from[2]) / DEG;
const angDiff = (a: number, b: number) => { let d = (b - a) % 360; if (d > 180) d -= 360; if (d < -180) d += 360; return d; };
const turnSec = (dDeg: number) => Math.max(0.3, (1.5 * Math.abs(dDeg)) / 300); // smoothstep peak rate <= 300 deg/s

// ---------- coin geometry: the solid is a slab [0, 2R] x [-2th, 0] in (along-face, face-normal) coordinates ----------
function coinSlabDistance(p: Vec3, pivot: Vec3, thetaDeg: number, R: number, th: number): number {
  const t = thetaDeg * DEG, u = [0, Math.cos(t), Math.sin(t)], n = [0, -Math.sin(t), Math.cos(t)];
  const v = [p[0] - pivot[0], p[1] - pivot[1], p[2] - pivot[2]];
  const s = v[1] * u[1] + v[2] * u[2], d = v[1] * n[1] + v[2] * n[2];
  const dx = Math.max(-s, 0, s - 2 * R), dy = Math.max(-2 * th - d, 0, d);
  const inside = s >= 0 && s <= 2 * R && d <= 0 && d >= -2 * th;
  return inside ? -Math.min(s, 2 * R - s, -d, d + 2 * th) : Math.hypot(dx, dy);
}
/** body centre-line points of a standing (pitch 0) to prone (pitch 90, falling toward +z) biped with fixed feet */
function bodyPoints(feet: Vec3, pitchDeg: number, H: number, r: number): Vec3[] {
  const L = H - 2 * r, b = [0, Math.cos(pitchDeg * DEG), Math.sin(pitchDeg * DEG)];
  return Array.from({ length: 25 }, (_, k) => [feet[0], r + b[1] * (L * k) / 24, feet[2] + b[2] * (L * k) / 24] as Vec3);
}
export function coinBodyGap(feet: Vec3, pitchDeg: number, pivot: Vec3, thetaDeg: number, R: number, th: number, H: number, r: number): number {
  return Math.min(...bodyPoints(feet, pitchDeg, H, r).map((p) => coinSlabDistance(p, pivot, thetaDeg, R, th))) - r;
}
/** largest coin angle in [lo, 89.9] that keeps the body clear (bisection; deterministic) */
function touchAngle(feet: Vec3, pitch: number, pivot: Vec3, R: number, th: number, H: number, r: number, lo: number): number {
  if (coinBodyGap(feet, pitch, pivot, 89.9, R, th, H, r) >= 0) return 89.9;
  let a = lo, b = 89.9;
  for (let k = 0; k < 40; k++) { const m = (a + b) / 2; if (coinBodyGap(feet, pitch, pivot, m, R, th, H, r) >= 0) a = m; else b = m; }
  return a;
}

// ---------- sampling ----------
function pathAt(pp: PathPlan, t: number): { pos: Vec3; yaw: number; moving: boolean; vel: Vec3 } {
  if (t < pp.tw0) return { pos: pp.pts[0], yaw: lerp(pp.yawIn, pp.yawIn + angDiff(pp.yawIn, pp.heads[0]), smooth((t - (pp.tw0 - turnSec(angDiff(pp.yawIn, pp.heads[0])))) / turnSec(angDiff(pp.yawIn, pp.heads[0])))), moving: false, vel: [0, 0, 0] };
  if (t >= pp.tw1) { const last = pp.heads[pp.heads.length - 1], d = angDiff(last, pp.yawOut), T = turnSec(d); return { pos: pp.pts[pp.pts.length - 1], yaw: lerp(last, last + d, smooth((t - pp.tw1) / T)), moving: false, vel: [0, 0, 0] }; }
  const s = (t - pp.tw0) * pp.speed;
  let k = 0;
  while (k < pp.heads.length - 1 && s > pp.cum[k + 1]) k++;
  const u = (s - pp.cum[k]) / Math.max(1e-9, pp.cum[k + 1] - pp.cum[k]);
  const pos = lerp3(pp.pts[k], pp.pts[k + 1], u);
  let yaw = pp.heads[k];
  // corner blending over +-tauCorner around each waypoint (<= 270 deg/s for 90 deg corners)
  for (let j = 1; j < pp.heads.length; j++) {
    const tc = pp.tw0 + pp.cum[j] / pp.speed;
    if (Math.abs(t - tc) < pp.tauCorner) { const d = angDiff(pp.heads[j - 1], pp.heads[j]); yaw = pp.heads[j - 1] + d * smooth((t - (tc - pp.tauCorner)) / (2 * pp.tauCorner)); }
  }
  const dir = [pp.pts[k + 1][0] - pp.pts[k][0], 0, pp.pts[k + 1][2] - pp.pts[k][2]], l = Math.hypot(dir[0], dir[2]) || 1;
  return { pos, yaw, moving: true, vel: [(dir[0] / l) * pp.speed, 0, (dir[2] / l) * pp.speed] };
}
function fallPitch(fp: FallPlan, t: number): number {
  const s = fp.samples;
  if (t <= s[0][0]) return s[0][1];
  if (t >= s[s.length - 1][0]) return s[s.length - 1][1];
  let k = Math.floor(((t - s[0][0]) / (s[s.length - 1][0] - s[0][0])) * (s.length - 1));
  k = clamp(k, 0, s.length - 2);
  while (k < s.length - 2 && s[k + 1][0] < t) k++;
  const u = (t - s[k][0]) / Math.max(1e-9, s[k + 1][0] - s[k][0]);
  return lerp(s[k][1], s[k + 1][1], u);
}
const stepAt = <T>(xs: Array<{ t: number; v: T }>, t: number, def: T): T => { let v = def; for (const x of xs) { if (x.t > t + 1e-9) break; v = x.v; } return v; };

function actorAt(tr: ActorTrack, t: number): ActorState {
  let seg: ActorSeg | null = null;
  for (const s of tr.segs) { if (s.t0 > t + 1e-9) break; seg = s; }
  const base = { id: tr.id, lookTarget: stepAt(tr.looks, t, null), expression: stepAt(tr.exprs, t, 'neutral'), contacts: tr.contacts.filter((c) => t >= c.t0 - 1e-9 && t < c.t1 - 1e-9).map((c) => c.with).sort() };
  if (!seg) return { ...base, pos: [...tr.start.pos] as Vec3, yawDeg: tr.start.yaw, mark: tr.start.mark, posture: 'standing', action: null, contract: null, heldPose: 'idle', velocity: [0, 0, 0], grounded: true, bodyPitchDeg: 0 };
  const done = t >= seg.t1 - 1e-9;
  const rest = { mark: done ? seg.endMark : seg.mark, heldPose: seg.heldPose };
  if (done) return { ...base, ...rest, pos: [...seg.p1] as Vec3, yawDeg: seg.yaw1, posture: seg.endPosture, action: seg.kind === 'hold' && seg.t1 === Infinity ? seg.action : null, contract: null, velocity: [0, 0, 0], grounded: true, bodyPitchDeg: seg.endPosture === 'prone' ? 90 : 0, contacts: base.contacts };
  const u = (t - seg.t0) / Math.max(1e-9, seg.t1 - seg.t0);
  const live = { ...base, ...rest, action: seg.action, contract: seg.contract };
  switch (seg.kind) {
    case 'hold': return { ...live, pos: [...seg.p0] as Vec3, yawDeg: seg.yaw0, posture: seg.posture, velocity: [0, 0, 0], grounded: true, bodyPitchDeg: seg.posture === 'prone' ? 90 : 0 };
    case 'turn': return { ...live, pos: [...seg.p0] as Vec3, yawDeg: lerp(seg.yaw0, seg.yaw0 + angDiff(seg.yaw0, seg.yaw1), smooth(u)), posture: 'standing', velocity: [0, 0, 0], grounded: true, bodyPitchDeg: 0 };
    case 'path': { const p = pathAt(seg.path!, t); return { ...live, pos: p.pos, yawDeg: p.yaw, posture: p.moving ? 'walking' : 'standing', velocity: p.vel, grounded: true, bodyPitchDeg: 0 }; }
    case 'jump': { const h = seg.jumpH!; return { ...live, pos: [seg.p0[0], seg.p0[1] + 4 * h * u * (1 - u), seg.p0[2]], yawDeg: seg.yaw0, posture: 'jumping', velocity: [0, (4 * h * (1 - 2 * u)) / (seg.t1 - seg.t0), 0], grounded: u < 0.05 || u > 0.95, bodyPitchDeg: 0 }; }
    case 'fall': { const ph = fallPitch(seg.fall!, t); return { ...live, pos: [...seg.p0] as Vec3, yawDeg: seg.yaw0, posture: 'falling', velocity: [0, 0, 0], grounded: true, bodyPitchDeg: ph }; }
  }
}

function coinAt(plan: WorldPlan, t: number): PropState {
  const cp = plan.coin, A = plan.assets.coin, R1 = A.radius, T1 = A.thickness;
  const mk = (x: Partial<PropState> & { pos: Vec3; scale: number; phase: PropPhase; visible: boolean }): PropState => ({ id: 'coin', parent: x.visible ? 'floor' : 'button', anchor: x.visible ? 'coin_spawn' : 'button.spawn_point', rotDeg: [0, 0, 0], basePoint: cp.base ?? cp.hidden, pivot: null, velocity: [0, 0, 0], contacts: [], radius: R1 * x.scale, thickness: T1 * x.scale, upright: 0, ...x });
  if (!cp.spawn || t < cp.spawn.t0) return mk({ pos: [...cp.hidden] as Vec3, scale: 1, phase: 'hidden', visible: false, basePoint: cp.hidden });
  if (t < cp.spawn.t1) {
    const u = (t - cp.spawn.t0) / (cp.spawn.t1 - cp.spawn.t0), p = lerp3(cp.spawn.from, cp.spawn.to, u);
    return mk({ pos: [p[0], p[1] + 4 * 0.35 * u * (1 - u), p[2]], scale: 1, phase: 'spawned', visible: true, rotDeg: [720 * u, 0, 0], parent: 'air', anchor: null, basePoint: cp.base! });
  }
  const b = cp.base!, contactsFloor = ['floor'];
  if (!cp.stand || t < cp.stand.t0) return mk({ pos: [b[0], (T1 / 2), b[2]], scale: 1, phase: 'resting', visible: true, rotDeg: [720, 0, 0], contacts: contactsFloor });
  const uprightAt = (x: number) => (x < cp.stand!.t1 ? smooth((x - cp.stand!.t0) / (cp.stand!.t1 - cp.stand!.t0)) : 1);
  let scale = 1, growing = t < cp.stand.t1;
  for (const g of cp.grows) { if (t < g.t0) break; if (t < g.t1) { scale = lerp(g.s0, g.s1, smooth((t - g.t0) / (g.t1 - g.t0))); growing = true; } else scale = g.s1; }
  const tip = cp.tip;
  if (!tip || t < tip.t0) {
    const up = uprightAt(t), h = lerp(T1 / 2, R1, up) * scale;
    return mk({ pos: [b[0], h, b[2]], scale, phase: growing ? 'growing' : 'upright', visible: true, rotDeg: [720 + 90 * up, 0, 0], upright: up, contacts: contactsFloor });
  }
  const R = R1 * tip.scale, th = (T1 / 2) * tip.scale;
  let theta: number;
  if (t < tip.tc) theta = 90 * Math.pow((t - tip.t0) / tip.freeT, 3);
  else if (t < tip.t1) { const s = tip.coupled; theta = s[s.length - 1][1]; for (let k = 0; k < s.length - 1; k++) if (t < s[k + 1][0]) { theta = lerp(s[k][1], s[k + 1][1], (t - s[k][0]) / Math.max(1e-9, s[k + 1][0] - s[k][0])); break; } }
  else theta = tip.thetaR;
  theta = Math.min(theta, t >= tip.tc ? tip.thetaR : tip.thetaC);
  const a = theta * DEG, P = tip.pivot;
  return mk({ pos: [P[0], P[1] + R * Math.cos(a) + th * Math.sin(a), P[2] + R * Math.sin(a) - th * Math.cos(a)], scale: tip.scale, phase: t < tip.t1 ? 'tipping' : 'resting', visible: true, rotDeg: [810 + theta, 0, 0], upright: 1 - theta / 90, basePoint: [...P] as Vec3, pivot: [...P] as Vec3, contacts: t >= tip.tc - 1e-9 ? ['floor', 'zapp'] : contactsFloor });
}

export function sampleWorld(plan: WorldPlan, t: number): WorldState {
  const actors: Record<string, ActorState> = {};
  for (const [id, tr] of Object.entries(plan.actors)) actors[id] = actorAt(tr, t);
  const coin = coinAt(plan, t), bt = plan.button;
  const pressed = bt.pressT !== null && t >= bt.pressT, reset = bt.resetT !== null && t >= bt.resetT;
  const cap = !pressed ? 0 : !reset ? 1 : Math.max(0, 1 - (t - bt.resetT!) / 0.3);
  const glow = bt.flashes.some(([a, b]) => t >= a && t < b) ? 1 : 0;
  const B = plan.assets.button.base;
  const button: PropState = { id: 'button', visible: true, parent: 'desk', anchor: 'button_desk', pos: [...B] as Vec3, scale: 1, rotDeg: [0, 0, 0], basePoint: [...B] as Vec3, pivot: null, phase: reset ? 'reset' : 'resting', velocity: [0, 0, 0], contacts: actors.zapp?.contacts.includes('button') ? ['zapp'] : [], radius: 0, thickness: 0, upright: 1, capDepth: r4(cap), glow };
  const offscreen: Record<string, OffScreenState> = {};
  for (const [id, o] of Object.entries(plan.offscreen)) { const last = [...o.cues].filter((c) => c.t <= t).pop(); offscreen[id] = { id, mark: 'classroom_door', direction: [...plan.assets.marks.classroom_door.pos] as Vec3, latestCue: last?.cue ?? null, cueAt: last?.t ?? null, instantiated: false }; }
  return { schema: WORLD_SCHEMA, t, actors, props: { coin, button }, events: plan.events.filter((e) => e.t <= t + 1e-9), offscreen };
}

// ---------- planner: storyboard -> contract instances -> tracks ----------
export interface PlanOptions { walkSpeed?: number; ladder?: number[]; reach?: number; facingTolDeg?: number; tipFreeSec?: number; fallSec?: number; jumpHeight?: number }
const LOOK_ACTIONS = new Set(['look_at', 'curious_lean', 'shock_recoil', 'turn_toward', 'point', 'laugh', 'cower', 'regret_freeze', 'facepalm', 'angry_stomp', 'idle']);
const lookRef = (target: string | null): string | null => !target ? null : target.startsWith('button') ? 'button' : target.startsWith('coin') ? 'coin' : target === 'camera' ? 'camera' : target.split('.')[0];

export function buildWorldPlan(sb: NarratedStoryboard, assets: WorldAssets, o: PlanOptions = {}): WorldPlan {
  const speed = o.walkSpeed ?? 1.1, ladder = o.ladder ?? [3, 6, 11, 16.7], reach = o.reach ?? 0.55, tol = o.facingTolDeg ?? 25;
  const freeT = o.tipFreeSec ?? 1.0, fallT = o.fallSec ?? 0.6, jumpH = o.jumpHeight ?? 0.49;
  const fps = 30, V = Math.round(Math.ceil(sb.audio.durationSeconds * fps - 1e-6)) / fps, M = assets.marks;
  const plan: WorldPlan = {
    schema: WORLD_SCHEMA, contracts: CONTRACT_SET_VERSION, layout: assets.layout, storyboardId: sb.id, seed: sb.seed, fps, duration: +V.toFixed(3), frames: Math.round(V * fps),
    assets, actors: {}, coin: { hidden: [...assets.button.spawnPoint] as Vec3, spawn: null, base: null, stand: null, grows: [], tip: null }, button: { pressT: null, resetT: null, flashes: [] },
    events: [], instances: [], bridges: [], errors: [], warnings: [], offscreen: {}, status: 'ok',
  };
  for (const id of sb.characters) {
    const m = M[`${id}_desk` as MarkId];
    if (!m) { plan.errors.push({ code: 'NO_START_MARK', contract: 'move_to', phraseId: null, t: 0, message: `no ${id}_desk mark in ${assets.layout}` }); continue; }
    plan.actors[id] = { id, start: { pos: [...m.pos] as Vec3, yaw: m.facingDeg, mark: m.id }, segs: [], looks: [], exprs: [{ t: 0, v: id === 'kira' ? 'smug' : 'neutral' }], contacts: [] };
  }
  let nInst = 0, nEv = 0, nBr = 0;
  const inst = (contract: ContractId, actor: string | null, prop: string | null, t0: number, t1: number, phraseId: string | null, params: Record<string, string | number> = {}, bridgeFor: string | null = null) => { const x: ContractInstance = { id: `c${String(++nInst).padStart(3, '0')}`, contract, actor, prop, t0: r4(t0), t1: r4(t1), phraseId, bridgeFor, params }; plan.instances.push(x); return x; };
  const ev = (type: string, t: number, source: string, target: string | null, pos: Vec3 | null, contract: string) => plan.events.push({ id: `e${String(++nEv).padStart(3, '0')}`, type, t: r4(t), source, target, pos: pos ? (pos.map(r4) as Vec3) : null, once: true, contract });
  const err = (code: string, contract: ContractId, phraseId: string | null, t: number, message: string) => { plan.errors.push({ code, contract, phraseId, t: r4(t), message }); plan.status = 'unavailable'; };
  const end = (id: string) => { const tr = plan.actors[id], s = tr.segs[tr.segs.length - 1]; return s ? { t: s.t1, pos: s.p1, yaw: s.yaw1, posture: s.endPosture, mark: s.endMark } : { t: 0, pos: tr.start.pos, yaw: tr.start.yaw, posture: 'standing' as Posture, mark: tr.start.mark as string | null }; };
  const push = (id: string, seg: Omit<ActorSeg, 'p0' | 'yaw0' | 'mark'> & { p0?: Vec3; yaw0?: number; mark?: string | null }): ActorSeg => {
    const e = end(id);
    if (seg.t0 < e.t - 1e-9) throw new Error(`internal: overlapping segments for ${id} at ${seg.t0} < ${e.t}`);
    if (seg.t0 > e.t + 1e-9) plan.actors[id].segs.push({ t0: e.t, t1: seg.t0, kind: 'hold', contract: 'hold', action: null, posture: e.posture, endPosture: e.posture, heldPose: 'hold', mark: e.mark, endMark: e.mark, p0: e.pos, yaw0: e.yaw, p1: e.pos, yaw1: e.yaw });
    const s: ActorSeg = { p0: e.pos, yaw0: e.yaw, mark: e.mark, ...seg };
    plan.actors[id].segs.push(s); return s;
  };
  const look = (id: string, t: number, v: string | null) => plan.actors[id]?.looks.push({ t: r4(t), v });
  const expr = (id: string, t: number, v: string) => plan.actors[id]?.exprs.push({ t: r4(t), v });
  const holdFor = (id: string, t0: number, dur: number, contract: ContractInstance, action: string, posture: Posture = 'standing') => { const e = end(id); return push(id, { t0: Math.max(t0, e.t), t1: Math.max(t0, e.t) + dur, kind: 'hold', contract: contract.id, action, posture, endPosture: posture, heldPose: action, endMark: e.mark, p1: e.pos, yaw1: e.yaw }); };
  const turn = (id: string, t0: number, yaw: number, contract: string): number => { const e = end(id), d = angDiff(e.yaw, yaw); if (Math.abs(d) < 0.5) return Math.max(t0, e.t); const T = turnSec(d), s = Math.max(t0, e.t); push(id, { t0: s, t1: s + T, kind: 'turn', contract, action: 'turn_toward', posture: 'standing', endPosture: 'standing', heldPose: 'idle', endMark: e.mark, p1: e.pos, yaw1: e.yaw + d }); return s + T; };
  /** straight segments must stay clear of the hero desk and the visible coin footprint (inflated by the body radius) */
  const pathClear = (pts: Vec3[], t: number): string | null => {
    const r = assets.body.radius, D = assets.desk, c = sampleWorld(plan, t).props.coin;
    const boxes: Array<[string, number, number, number, number]> = [['desk', D.center[0] - D.half[0] - r, D.center[0] + D.half[0] + r, D.center[2] - D.half[2] - r, D.center[2] + D.half[2] + r]];
    if (c.visible && c.scale > 1.5) boxes.push(['coin', c.basePoint[0] - c.radius - r, c.basePoint[0] + c.radius + r, c.basePoint[2] - c.thickness / 2 - r, c.basePoint[2] + c.thickness / 2 + r]);
    for (let k = 1; k < pts.length; k++) { const n = Math.max(1, Math.ceil(dist2(pts[k - 1], pts[k]) / 0.05)); for (let q = 0; q <= n; q++) { const p = lerp3(pts[k - 1], pts[k], q / n); for (const [nm, x0, x1, z0, z1] of boxes) if (p[0] > x0 && p[0] < x1 && p[2] > z0 && p[2] < z1) return nm; } }
    return null;
  };
  const walk = (id: string, t0: number, pts: Vec3[], mark: MarkId | null, contract: string, finalYaw?: number): ActorSeg => {
    const e = end(id), all = [e.pos, ...pts].filter((p, k, a) => k === 0 || dist2(p, a[k - 1]) > 1e-6) as Vec3[];
    const blocked = pathClear(all, Math.max(t0, e.t));
    if (blocked) err('PATH_BLOCKED', 'move_to', null, Math.max(t0, e.t), `${id}'s path to ${mark ?? 'target'} crosses the ${blocked}`);
    const heads = all.slice(1).map((p, k) => yawTo(all[k], p)), cum = [0];
    for (let k = 1; k < all.length; k++) cum.push(cum[k - 1] + dist2(all[k - 1], all[k]));
    const len = cum[cum.length - 1], s = Math.max(t0, e.t), tp = turnSec(angDiff(e.yaw, heads[0])), tw0 = s + tp, tw1 = tw0 + len / speed;
    const yawOut = mark ? M[mark].facingDeg : finalYaw ?? heads[heads.length - 1], last = heads[heads.length - 1], tq = turnSec(angDiff(last, yawOut));
    return push(id, { t0: s, t1: tw1 + tq, kind: 'path', contract, action: 'walk', posture: 'walking', endPosture: 'standing', heldPose: 'idle', endMark: mark, p1: [...all[all.length - 1]] as Vec3, yaw1: last + angDiff(last, yawOut), path: { pts: all, heads, cum, len, speed, tw0, tw1, yawIn: e.yaw, yawOut, tauCorner: 0.25 } });
  };
  const bridge = (contract: ContractId, actor: string, reason: string, forContract: string, s: ActorSeg | { t0: number; t1: number; p0: Vec3; p1: Vec3 }) => plan.bridges.push({ id: `b${String(++nBr).padStart(2, '0')}`, contract, actor, reason, forContract, t0: r4(s.t0), t1: r4(s.t1), from: s.p0.map(r4) as Vec3, to: s.p1.map(r4) as Vec3 });

  const ph = sb.script.phrases, sel = sb.characters;
  // ---------- pre-pass: requirements that span phrases ----------
  const growPhrases = ph.filter((p) => p.propEvents.some((e) => e.prop === 'spark_coin' && e.event === 'grow'));
  const tipPhrase = ph.find((p) => p.actorRole === 'affected' && p.cause === 'spark_coin') ?? null;
  const SAFE = /\b(?:moved|moves|move|stepped|steps|got|gets|ran|runs)\b[^.]*?\b(?:safely|out of the way|to safety)\b/i;
  const safeReq = ph.flatMap((p, k) => { const m = SAFE.exec(p.text); if (!m) return []; const before = p.text.slice(0, m.index).toLowerCase(); const who = sel.filter((c) => before.includes(c)).sort((a, b) => before.lastIndexOf(b) - before.lastIndexOf(a))[0]; return who ? [{ actor: who, phrase: p, k, already: /\b(already|has|had)\b/i.test(p.text.slice(0, m.index + m[0].length)) }] : []; });
  // "<Name> [word] sitting|sits|sat|seated": the sitter must be a selected character ("a button sitting on the desk" is not)
  const SIT = new RegExp(`\\b(${sel.join('|')})\\b\\s+(?:\\w+\\s+)?(?:sit|sits|sitting|sat|seated)\\b`, 'i');
  const seatReq = ph.flatMap((p, k) => { const m = SIT.exec(p.text); return m ? [{ actor: m[1].toLowerCase(), phrase: p, k }] : []; });
  let hazardGrownAt: number | null = null, hazardResolvedAt: number | null = null;
  const pendingSafe = safeReq.map((r) => ({ ...r, done: false }));
  const pendingImpact = tipPhrase ? { actor: tipPhrase.actor, done: false } : null;
  const pendingSeat = seatReq.map((r) => ({ ...r, done: false }));
  const safeMark = (id: string) => M[`${id}_safe` as MarkId] ? (`${id}_safe` as MarkId) : null;
  const deskMark = (id: string) => (`${id}_desk` as MarkId);

  const schedulePending = (now: number, k: number) => {
    for (const r of pendingSafe) {
      if (r.done || hazardGrownAt === null || !plan.actors[r.actor]) continue;
      const mk = safeMark(r.actor), deadline = r.already ? r.phrase.start - 0.3 : r.phrase.end;
      if (!mk) { err('NO_SAFE_MARK', 'move_safely', r.phrase.id, now, `no ${r.actor}_safe mark in ${assets.layout}`); r.done = true; continue; }
      const c = inst('move_safely', r.actor, null, 0, 0, r.phrase.id, { to: mk });
      const s = walk(r.actor, Math.max(hazardGrownAt + 0.4, end(r.actor).t), [M[mk].pos], mk, c.id);
      c.t0 = r4(s.t0); c.t1 = r4(s.t1); r.done = true;
      look(r.actor, s.t1, 'coin');
      ev('reached_safe', s.t1, r.actor, mk, M[mk].pos, c.id);
      if (s.t1 > deadline + 1e-9) err('MOVE_SAFELY_LATE', 'move_safely', r.phrase.id, s.t1, `${r.actor} reaches ${mk} at ${r4(s.t1)} s, after the narration needs it (${r4(deadline)} s)`);
    }
    if (pendingImpact && !pendingImpact.done && hazardGrownAt !== null && plan.actors[pendingImpact.actor]) {
      const id = pendingImpact.actor, e = end(id), wp: Vec3[] = [[-0.9, 0, e.pos[2]], [-0.9, 0, M.zapp_impact.pos[2]], [...M.zapp_impact.pos] as Vec3];
      const c = inst('move_to', id, null, 0, 0, null, { to: 'zapp_impact' }, 'tip_coin_onto');
      const s = walk(id, Math.max(now, e.t), wp, 'zapp_impact', c.id);
      c.t0 = r4(s.t0); c.t1 = r4(s.t1); pendingImpact.done = true;
      bridge('move_to', id, 'tip_coin_onto requires the patient standing at zapp_impact', 'tip_coin_onto', s);
      ev('reached_mark', s.t1, id, 'zapp_impact', M.zapp_impact.pos, c.id);
    }
    for (const r of pendingSeat) {
      if (r.done || !plan.actors[r.actor] || k < r.k - 1) continue;
      const e = end(r.actor), desk = M[deskMark(r.actor)];
      if (dist2(e.pos, desk.pos) <= 0.05) { r.done = true; continue; }
      if (hazardResolvedAt === null && plan.coin.tip) continue; // wait until the coin has come to rest
      const c = inst('move_to', r.actor, null, 0, 0, null, { to: desk.id }, 'remain_still');
      const s = walk(r.actor, Math.max(now, e.t, (hazardResolvedAt ?? 0) + 0.8), [desk.pos], desk.id, c.id);
      c.t0 = r4(s.t0); c.t1 = r4(s.t1); r.done = true;
      bridge('move_to', r.actor, `implied_seated at ${desk.id} requires ${r.actor} at or behind ${desk.id}`, 'remain_still', s);
      if (s.t1 > r.phrase.start + 1e-9) err('SEAT_BRIDGE_LATE', 'remain_still', r.phrase.id, s.t1, `${r.actor} reaches ${desk.id} at ${r4(s.t1)} s, after the phrase starts (${r.phrase.start} s)`);
      ev('reached_mark', s.t1, r.actor, desk.id, desk.pos, c.id);
    }
  };

  ph.forEach((p, k) => {
    const S = p.start, nextS = k + 1 < ph.length ? ph[k + 1].start : V, id = p.actor;
    const text = p.text.toLowerCase();
    // off-screen person cues (never an actor): direction = classroom_door
    for (const m of p.offscreenCharacters) {
      const cue = /\b(could|might|may|would|will)\s+(return|come back)/.test(text) ? 'mention' : /\b(leave|leaves|left|leaving)\b/.test(text) ? 'leaves' : /\b(return|returns|returned|comes back|came back|enters|walks in)\b/.test(text) ? 'returns' : 'mention';
      const c = inst('off_screen_teacher_cue', null, null, S + 0.05, S + 0.05, p.id, { person: m, cue });
      (plan.offscreen[m] ??= { cues: [] }).cues.push({ t: r4(S + 0.05), cue });
      ev('offscreen_cue', S + 0.05, 'classroom_door', m, M.classroom_door.pos, c.id);
      if (plan.actors[id] && end(id).posture !== 'prone') { const lc = inst('look_at', id, null, 0, 0, p.id, { target: 'classroom_door' }); const s = holdFor(id, S + 0.05, 0.8, lc, 'look_at', end(id).posture === 'implied_seated' ? 'implied_seated' : 'standing'); lc.t0 = r4(s.t0); lc.t1 = r4(s.t1); look(id, s.t0, 'classroom_door'); }
    }
    if (/\bdoor\b[^.]*\bclos(es|ed|ing)\b/.test(text)) { const c = inst('off_screen_teacher_cue', null, null, S + 0.05, S + 0.05, p.id, { person: 'teacher', cue: 'door_close' }); (plan.offscreen.teacher ??= { cues: [] }).cues.push({ t: r4(S + 0.05), cue: 'door_close' }); ev('offscreen_cue', S + 0.05, 'classroom_door', 'teacher', M.classroom_door.pos, c.id); }
    if (!plan.actors[id]) return;
    const t0 = Math.max(S + 0.05, end(id).t);
    expr(id, t0, p.expression);
    if (p.supportingCharacter && p.supportingExpression && new RegExp(`\\b${p.supportingCharacter}\\b|\\b(him|her)\\b`).test(text)) expr(p.supportingCharacter, S + 0.4, p.supportingExpression);
    const prone = end(id).posture === 'prone';
    const a = p.semanticAction;
    // ---------- main contract ----------
    if (tipPhrase && p.id === tipPhrase.id) {
      // tip_coin_onto + fall_prone: strict preconditions at the tip start, never silently continued
      const tt = S + 0.04, w = sampleWorld(plan, tt), coin = w.props.coin, pat = w.actors[id];
      const fails: string[] = [];
      if (!coin.visible) fails.push('coin_visible');
      if (coin.phase !== 'upright' || coin.upright < 0.999) fails.push('coin_upright');
      if (!plan.coin.base || dist3([coin.pos[0], coin.pos[1] - coin.radius, coin.pos[2]], plan.coin.base) > 0.01) fails.push('coin_at_base');
      if (!pat || dist2(pat.pos, M.zapp_impact.pos) > 0.05 || pat.posture !== 'standing') fails.push('patient_at_zapp_impact');
      for (const other of sel.filter((c) => c !== id)) { const mk = safeMark(other); if (!mk || dist2(w.actors[other].pos, M[mk].pos) > 0.05) fails.push(`${other}_at_${mk ?? 'safe_mark'}`); }
      const c = inst('tip_coin_onto', id, 'coin', tt, tt, p.id, { patient: id });
      if (fails.length) { err('TIP_PRECONDITION_FAILED', 'tip_coin_onto', p.id, tt, `tip_coin_onto unavailable: failed ${fails.join(', ')}`); return; }
      const S1 = coin.scale, R = assets.coin.radius * S1, th = (assets.coin.thickness / 2) * S1, b = plan.coin.base!, pivot: Vec3 = [b[0], 0, b[2] + th];
      const H = assets.body.height, r = assets.body.radius, feet: Vec3 = [...M.zapp_impact.pos] as Vec3;
      const thetaC = touchAngle(feet, 0, pivot, R, th, H, r, 0);
      const tc = tt + freeT * Math.pow(thetaC / 90, 1 / 3);
      const samples: Array<[number, number]> = [], pitch: Array<[number, number]> = [];
      let prev = thetaC;
      for (let q = 0; q <= 180; q++) { const u = q / 180, tq = tc + u * fallT, phi = 90 * smooth(u); const th2 = Math.max(prev, touchAngle(feet, phi, pivot, R, th, H, r, prev)); prev = th2; samples.push([tq, th2]); pitch.push([tq, phi]); }
      const thetaR = samples[samples.length - 1][1];
      plan.coin.tip = { t0: tt, tc, t1: tc + fallT, freeT, thetaC, thetaR, pivot, scale: S1, coupled: samples };
      c.t1 = r4(tc + fallT); c.params.thetaC = r4(thetaC); c.params.thetaR = r4(thetaR);
      ev('tip_start', tt, 'coin', id, pivot, c.id);
      look(id, tt + 0.25, 'coin'); expr(id, tt + 0.25, pat.expression === 'shock' ? 'shock' : (id === 'zapp' ? 'shock' : 'surprised'));
      // the patient holds its pose until the contact instant; the fall starts exactly at contact
      const e = end(id);
      if (e.t < tc) push(id, { t0: e.t, t1: tc, kind: 'hold', contract: plan.instances.find((x) => x.actor === id && x.contract === 'confident_pose')?.id ?? c.id, action: 'arms_crossed', posture: 'standing', endPosture: 'standing', heldPose: 'arms_crossed', endMark: 'zapp_impact', p1: e.pos, yaw1: e.yaw });
      const fc = inst('fall_prone', id, 'coin', tc, tc + fallT, p.id, { cause: 'coin' });
      push(id, { t0: tc, t1: tc + fallT, kind: 'fall', contract: fc.id, action: 'fall_prone', posture: 'falling', endPosture: 'prone', heldPose: 'prone', endMark: 'zapp_impact', p1: end(id).pos, yaw1: end(id).yaw, fall: { feet, samples: pitch } });
      plan.actors[id].contacts.push({ t0: tc, t1: Infinity, with: 'coin' }, { t0: tc + fallT, t1: Infinity, with: 'floor' });
      ev('coin_patient_contact', tc, 'coin', id, pivot, c.id);
      ev('patient_prone', tc + fallT, id, 'floor', feet, fc.id);
      ev('coin_rest', tc + fallT, 'coin', 'floor', pivot, c.id);
      expr(id, tc + fallT + 0.2, 'regret');
      hazardResolvedAt = tc + fallT;
    } else if (prone) {
      if (LOOK_ACTIONS.has(a) || a === 'look_at') { const c = inst('look_at', id, null, t0, t0 + 1.2, p.id, { target: lookRef(p.target) ?? 'none', headOnly: 1 }); look(id, t0, lookRef(p.target)); void c; }
      else err('GET_UP_UNAVAILABLE', 'look_at', p.id, t0, `${id} is prone; ${a} would need get_up, which is not implemented (Zapp stays prone)`);
    } else if (a === 'press_button') {
      const e = end(id), target = assets.button.pressSurface, yawB = yawTo(e.pos, target);
      const pc = inst('press_button', id, 'button', 0, 0, p.id, {});
      let s0 = t0;
      if (dist2(e.pos, target) > reach) { const dir = [target[0] - e.pos[0], target[2] - e.pos[2]], l = Math.hypot(dir[0], dir[1]); const ap: Vec3 = [target[0] - (dir[0] / l) * (reach - 0.1), 0, target[2] - (dir[1] / l) * (reach - 0.1)]; const bc = inst('move_to', id, null, s0, s0, p.id, { to: 'press_reach' }, pc.id); const w = walk(id, s0, [ap], null, bc.id, yawTo(ap, target)); bc.t0 = r4(w.t0); bc.t1 = r4(w.t1); bridge('move_to', id, `press_button requires ${id} within ${reach} m of button_desk`, pc.id, w); s0 = w.t1; }
      const e2 = end(id), yawNeed = yawTo(e2.pos, target);
      if (Math.abs(angDiff(e2.yaw, yawNeed)) > tol) { const bc = inst('move_to', id, null, s0, s0, p.id, { to: 'face_button', kind: 'turn_toward' }, pc.id); const t1 = turn(id, s0, yawNeed, bc.id); const seg = plan.actors[id].segs[plan.actors[id].segs.length - 1]; bc.t0 = r4(seg.t0); bc.t1 = r4(t1); bridge('move_to', id, `press_button requires ${id} facing button_desk (error ${r4(Math.abs(angDiff(e2.yaw, yawNeed)))} deg > ${tol})`, pc.id, seg); s0 = t1; }
      void yawB;
      const e3 = end(id);
      if (dist2(e3.pos, target) > reach + 1e-6 || Math.abs(angDiff(e3.yaw, yawTo(e3.pos, target))) > tol + 1e-6) { err('PRESS_PRECONDITION_FAILED', 'press_button', p.id, s0, `${id} cannot reach or face the button`); return; }
      const s = holdFor(id, s0, 0.9, pc, 'press_button');
      pc.t0 = r4(s.t0); pc.t1 = r4(s.t1);
      const contact = s.t0 + 0.9 * 0.42;
      plan.button.pressT = r4(contact); plan.button.flashes.push([r4(contact + 0.03), r4(contact + 0.53)]);
      plan.actors[id].contacts.push({ t0: contact - 0.05, t1: contact + 0.15, with: 'button' });
      ev('press_contact', contact, id, 'button', target, pc.id);
      look(id, s.t0, 'button');
      if (p.propEvents.some((x) => x.prop === 'spark_coin' && x.event === 'spawn')) {
        const sc = inst('spawn_coin', null, 'coin', contact + 0.1, contact + 0.75, p.id, { to: 'coin_spawn' });
        const to: Vec3 = [M.coin_spawn.pos[0], assets.coin.thickness / 2, M.coin_spawn.pos[2]];
        plan.coin.spawn = { t0: contact + 0.1, t1: contact + 0.75, from: [...assets.button.spawnPoint] as Vec3, to };
        plan.coin.base = [...M.coin_spawn.pos] as Vec3;
        ev('coin_spawn', contact + 0.1, 'button', 'coin', assets.button.spawnPoint, sc.id);
        ev('coin_land', contact + 0.75, 'coin', 'floor', M.coin_spawn.pos, sc.id);
      }
    } else if (a === 'jump') {
      const c = inst('jump', id, null, t0, t0 + 0.9, p.id, { height: jumpH });
      const e = end(id);
      push(id, { t0, t1: t0 + 0.9, kind: 'jump', contract: c.id, action: 'jump', posture: 'jumping', endPosture: 'standing', heldPose: 'idle', endMark: e.mark, p1: e.pos, yaw1: e.yaw, jumpH });
      ev('takeoff', t0 + 0.05, id, 'floor', e.pos, c.id); ev('landing', t0 + 0.85, id, 'floor', e.pos, c.id);
      if (/celebrat/.test(text)) { const cc = inst('celebrate', id, null, 0, 0, p.id, {}); const s = holdFor(id, t0 + 0.95, 1.3, cc, 'victory_pose'); cc.t0 = r4(s.t0); cc.t1 = r4(s.t1); }
    } else if (a === 'victory_pose') {
      const c = inst('celebrate', id, null, 0, 0, p.id, {}); const s = holdFor(id, t0, 1.3, c, 'victory_pose'); c.t0 = r4(s.t0); c.t1 = r4(s.t1);
    } else if (a === 'head_shake') {
      const c = inst('warning', id, null, 0, 0, p.id, { target: lookRef(p.target) ?? p.supportingCharacter ?? 'none' }); const s = holdFor(id, t0, 0.9, c, 'head_shake'); c.t0 = r4(s.t0); c.t1 = r4(s.t1); look(id, s.t0, lookRef(p.target) ?? p.supportingCharacter);
    } else if (a === 'arms_crossed' && /\b(confident|cool|brave|calm)\b/.test(text)) {
      const c = inst('confident_pose', id, null, 0, 0, p.id, {}); const s = holdFor(id, t0, Math.max(0.8, nextS - t0 - 0.05), c, 'arms_crossed'); c.t0 = r4(s.t0); c.t1 = r4(s.t1);
    } else if (a === 'arms_crossed' || seatReq.some((r) => r.phrase.id === p.id && r.actor === id)) {
      const seated = seatReq.some((r) => r.phrase.id === p.id && r.actor === id);
      const e = end(id);
      if (seated && dist2(e.pos, M[deskMark(id)].pos) > 0.05) { err('SEAT_PRECONDITION_FAILED', 'remain_still', p.id, t0, `${id} must be at ${deskMark(id)} for implied_seated`); return; }
      const c = inst('remain_still', id, null, 0, 0, p.id, seated ? { posture: 'implied_seated', framing: 'waist_up_only; legs and chair never shown', warning: 'AUTHORED_SEATED_ANIMATION_UNAVAILABLE' } : { posture: 'standing' });
      const s = holdFor(id, t0, seated ? Math.max(0.8, V - t0) : Math.max(0.8, Math.min(1.8, nextS - t0 - 0.05)), c, seated ? 'implied_seated_still' : 'arms_crossed', seated ? 'implied_seated' : 'standing');
      c.t0 = r4(s.t0); c.t1 = r4(s.t1);
      if (seated) plan.warnings.push({ code: 'AUTHORED_SEATED_ANIMATION_UNAVAILABLE', phraseId: p.id, message: `${id} is only implied seated at ${deskMark(id)}: no authored seated animation or chair exists; framing must be waist-up and never show legs or a chair` });
    } else {
      const tgt = p.propEvents.some((x) => x.prop === 'spark_coin') ? 'coin' : lookRef(p.target) ?? p.supportingCharacter;
      const c = inst('look_at', id, null, 0, 0, p.id, { target: tgt ?? 'none', engineAction: a });
      const s = holdFor(id, t0, 1.2, c, a); c.t0 = r4(s.t0); c.t1 = r4(s.t1); look(id, s.t0, tgt);
    }
    // ---------- prop contracts of this phrase ----------
    for (const x of p.propEvents) {
      if (x.prop === 'suspicious_button' && x.event === 'flash') { plan.button.flashes.push([r4(S + 0.05), r4(S + 1.25)]); ev('button_flash', S + 0.05, 'button', null, assets.button.base, 'flash'); }
      if (x.prop === 'suspicious_button' && x.event === 'reset') { const c = inst('reset_button', null, 'button', S + 0.05, S + 0.35, p.id, {}); if (plan.button.pressT === null) { err('RESET_PRECONDITION_FAILED', 'reset_button', p.id, S, 'the button was never pressed'); continue; } plan.button.resetT = r4(S + 0.05); plan.button.flashes.push([r4(S + 0.4), r4(S + 1.4)]); ev('button_reset', S + 0.05, 'button', null, assets.button.base, c.id); }
    }
    const gi = growPhrases.findIndex((q) => q.id === p.id);
    if (gi >= 0) {
      if (!plan.coin.spawn || plan.coin.spawn.t1 > S) { err('GROW_PRECONDITION_FAILED', 'grow_coin', p.id, S, 'the coin is not resting at coin_spawn'); }
      else {
        const per = Math.ceil(ladder.length / growPhrases.length), steps = ladder.slice(gi * per, gi * per + per);
        let t = S + 0.06;
        if (!plan.coin.stand) { plan.coin.stand = { t0: t, t1: t + 0.3 }; ev('coin_stand', t, 'coin', null, plan.coin.base, 'grow'); t += 0.34; }
        for (const s1 of steps) {
          const s0 = plan.coin.grows.length ? plan.coin.grows[plan.coin.grows.length - 1].s1 : 1, d = s1 > 6 ? 0.5 : 0.4;
          const c = inst('grow_coin', null, 'coin', t, t + d, p.id, { from: s0, to: s1 });
          plan.coin.grows.push({ t0: t, t1: t + d, s0, s1 });
          ev('grow_step', t + d, 'coin', null, plan.coin.base, c.id);
          // clearance: the upright coin box must stay >= 0.10 m from every actor capsule
          for (const [aid, tr] of Object.entries(plan.actors)) { const ap = actorAt(tr, t + d).pos, Rs = assets.coin.radius * s1, ths = (assets.coin.thickness / 2) * s1, b = plan.coin.base!; const dx = Math.max(0, Math.abs(ap[0] - b[0]) - Rs), dz = Math.max(0, Math.abs(ap[2] - b[2]) - ths); if (Math.hypot(dx, dz) - assets.body.radius < 0.1) err('GROW_CLEARANCE', 'grow_coin', p.id, t + d, `coin at scale ${s1} comes within 0.10 m of ${aid}`); }
          t += d + 0.1;
        }
        if (steps.length && steps[steps.length - 1] >= ladder[ladder.length - 1]) hazardGrownAt = plan.coin.grows[plan.coin.grows.length - 1].t1;
      }
    }
    schedulePending(end(id).t, k);
  });
  for (const r of pendingSafe) if (!r.done) err('MOVE_SAFELY_UNSCHEDULED', 'move_safely', r.phrase.id, r.phrase.start, `${r.actor} could not be moved to safety (no hazard or no free time)`);
  if (pendingImpact && !pendingImpact.done) err('TIP_PRECONDITION_FAILED', 'tip_coin_onto', tipPhrase!.id, tipPhrase!.start, 'the patient was never moved to zapp_impact');
  plan.events.sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : 1));
  for (const tr of Object.values(plan.actors)) { tr.looks.sort((a, b) => a.t - b.t); tr.exprs.sort((a, b) => a.t - b.t); }
  return plan;
}

// ---------- trace + summary ----------
export interface TraceFrame { i: number; t: number; a: Record<string, [number, number, number, number, string, string | null, string | null, string, number, number]>; c: [number, number, number, number, number, string, number, number, number, number]; b: [string, number, number]; ev: string[] }
export interface WorldTrace { schema: typeof WORLD_SCHEMA; storyboardId: string; fps: number; duration: number; frames: TraceFrame[]; shots: Array<{ id: string; start: number; end: number; handoff: Record<string, [number, number, number, number, string]> }>; legend: Record<string, string> }
export function traceWorld(plan: WorldPlan, shots: Array<{ id: string; start: number; end: number }> = []): WorldTrace {
  const frames: TraceFrame[] = [];
  let prevT = -1;
  for (let i = 0; i < plan.frames; i++) {
    const t = i / plan.fps, w = sampleWorld(plan, t), a: TraceFrame['a'] = {};
    for (const [id, s] of Object.entries(w.actors)) a[id] = [r4(s.pos[0]), r4(s.pos[1]), r4(s.pos[2]), r4(s.yawDeg), s.posture, s.action, s.lookTarget, s.expression, r4(s.bodyPitchDeg), s.contacts.length];
    const c = w.props.coin, b = w.props.button;
    frames.push({ i, t: r4(t), a, c: [r4(c.pos[0]), r4(c.pos[1]), r4(c.pos[2]), r4(c.scale), r4(c.rotDeg[0]), c.phase, c.visible ? 1 : 0, r4(c.basePoint[0]), r4(c.basePoint[2]), c.contacts.length], b: [b.phase, b.capDepth ?? 0, b.glow ?? 0], ev: plan.events.filter((e) => e.t > prevT + 1e-9 && e.t <= t + 1e-9).map((e) => e.id) });
    prevT = t;
  }
  const hand = shots.map((s) => { const w = sampleWorld(plan, s.start); return { id: s.id, start: s.start, end: s.end, handoff: Object.fromEntries(Object.entries(w.actors).map(([id, x]) => [id, [r4(x.pos[0]), r4(x.pos[1]), r4(x.pos[2]), r4(x.yawDeg), x.posture]])) as Record<string, [number, number, number, number, string]> }; });
  return { schema: WORLD_SCHEMA, storyboardId: plan.storyboardId, fps: plan.fps, duration: plan.duration, frames, shots: hand, legend: { a: 'x,y,z,yawDeg,posture,action,lookTarget,expression,bodyPitchDeg,contactCount', c: 'x,y,z,scale,rotXDeg,phase,visible,baseX,baseZ,contactCount', b: 'phase,capDepth,glow' } };
}

/** travel windows per entity: displacement outside them is "unexplained" */
function travelWindows(plan: WorldPlan): Record<string, Array<[number, number]>> {
  const w: Record<string, Array<[number, number]>> = {};
  for (const [id, tr] of Object.entries(plan.actors)) w[id] = tr.segs.filter((s) => s.kind !== 'hold').map((s) => [s.t0, s.t1]);
  const cp = plan.coin, cw: Array<[number, number]> = [];
  if (cp.spawn) cw.push([cp.spawn.t0, cp.spawn.t1]);
  if (cp.stand) cw.push([cp.stand.t0, cp.stand.t1]);
  for (const g of cp.grows) cw.push([g.t0, g.t1]);
  if (cp.tip) cw.push([cp.tip.t0, cp.tip.t1]);
  w.coin = cw;
  return w;
}
export function summarizeWorld(plan: WorldPlan, trace: WorldTrace, sha256: (s: string) => string) {
  const F = trace.frames, first = F[0], last = F[F.length - 1], win = travelWindows(plan), dt = 1 / plan.fps;
  const inWin = (id: string, t0: number, t1: number) => (win[id] ?? []).some(([a, b]) => t1 > a - 1e-9 && t0 < b + 1e-9);
  const maxUnexplained: Record<string, number> = {};
  const pathLen: Record<string, number> = {};
  for (let i = 1; i < F.length; i++) {
    for (const id of Object.keys(F[i].a)) { const p = F[i].a[id], q = F[i - 1].a[id], d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); pathLen[id] = (pathLen[id] ?? 0) + d; if (!inWin(id, F[i - 1].t, F[i].t)) maxUnexplained[id] = Math.max(maxUnexplained[id] ?? 0, d); }
    const c = F[i].c, q = F[i - 1].c, d = Math.hypot(c[0] - q[0], c[1] - q[1], c[2] - q[2]);
    if (!inWin('coin', F[i - 1].t, F[i].t)) maxUnexplained.coin = Math.max(maxUnexplained.coin ?? 0, d);
  }
  // base drift during growth: lowest point of the upright/standing coin vs the fixed base
  let drift = 0;
  const R1 = plan.assets.coin.radius, T1 = plan.assets.coin.thickness;
  for (const f of F) { if (f.c[5] !== 'growing' && f.c[5] !== 'upright') continue; const w = sampleWorld(plan, f.t).props.coin; const low = w.pos[1] - lerp(T1 / 2, R1, w.upright) * w.scale; drift = Math.max(drift, Math.hypot(w.pos[0] - plan.coin.base![0], low, w.pos[2] - plan.coin.base![2])); }
  const zc = F.map((f) => f.a.zapp?.[9] ?? 0), contactStarts = F.filter((f, i) => i > 0 && f.c[9] > F[i - 1].c[9] && f.c[9] === 2).map((f) => f.t);
  const contactEv = plan.events.filter((e) => e.type === 'coin_patient_contact');
  const fallStart = plan.instances.find((x) => x.contract === 'fall_prone')?.t0 ?? null;
  const pos = (f: TraceFrame, id: string) => (f.a[id] ? f.a[id].slice(0, 3) as number[] : null);
  const disp = (id: string) => { const a = pos(first, id), b = pos(last, id); return a && b ? r4(Math.hypot(a[0] - b[0], a[2] - b[2])) : null; };
  const maxFrom = (id: string) => { const a = pos(first, id)!; return r4(Math.max(...F.map((f) => Math.hypot(f.a[id][0] - a[0], f.a[id][2] - a[2])))); };
  void zc;
  const traceJson = JSON.stringify(trace);
  return {
    schema: 'blockspark.narrated-world-summary/1', world: plan.schema, contracts: plan.contracts, layout: plan.layout, storyboardId: plan.storyboardId, seed: plan.seed,
    duration: plan.duration, fps: plan.fps, frames: F.length, status: plan.status,
    actors: Object.fromEntries(Object.keys(plan.actors).map((id) => [id, { initial: { pos: pos(first, id), yawDeg: first.a[id][3], posture: first.a[id][4] }, final: { pos: pos(last, id), yawDeg: last.a[id][3], posture: last.a[id][4] }, netDisplacement: disp(id), maxDistanceFromStart: maxFrom(id), pathLength: r4(pathLen[id] ?? 0) }])),
    coin: { initial: { pos: first.c.slice(0, 3), scale: first.c[3], rotXDeg: first.c[4], phase: first.c[5] }, final: { pos: last.c.slice(0, 3), scale: last.c[3], rotXDeg: last.c[4], phase: last.c[5], thicknessM: r4(T1 * last.c[3]), radiusM: r4(R1 * last.c[3]) }, base: plan.coin.base, pivot: plan.coin.tip?.pivot.map(r4) ?? null, baseDriftDuringGrowthM: r4(drift), thetaContactDeg: plan.coin.tip ? r4(plan.coin.tip.thetaC) : null, thetaRestDeg: plan.coin.tip ? r4(plan.coin.tip.thetaR) : null },
    contact: { events: contactEv.length, time: contactEv[0]?.t ?? null, frameTransitions: contactStarts.length },
    zapp: { fallStart: fallStart, finalPosture: last.a.zapp?.[4] ?? null },
    maxUnexplainedDisplacementPerFrameM: Object.fromEntries(Object.entries({ ...Object.fromEntries(Object.keys(plan.actors).map((k) => [k, 0])), coin: 0, ...maxUnexplained }).map(([k, v]) => [k, r4(v)])),
    failedPreconditions: plan.errors, bridges: plan.bridges, warnings: plan.warnings,
    events: plan.events.map((e) => `${e.t} ${e.type} ${e.source}->${e.target ?? '-'}`),
    traceSha256: sha256(traceJson), traceBytes: traceJson.length, frameStepSec: r4(dt),
  };
}
