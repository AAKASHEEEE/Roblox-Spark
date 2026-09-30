// Staging (S6): beat sheet -> placements, entrances/exits through doors, prop placement and action timing, folded into
// ONE authoritative world plan in the narrated WorldState format (packages/narrated/src/world.ts) under the existing
// action contracts (packages/narrated/src/contracts.ts): move_to (walking, path_clear), press_button (reach / facing
// bridges, contact at u = 0.42), spawn_coin, grow_coin, tip_coin_onto + fall_prone (the fall starts exactly at the
// coin/body contact), warning, celebrate, confident_pose, remain_still, look_at. sampleWorld(plan, t) then answers where
// everyone is at any t, and the existing NarratedEngineAdapter poses the engine rigs from it.
// Multi-set: every set lives at its own world origin (sets.ts); a character moving to another set is re-placed at the
// cut. Presence intervals say which actors are on screen when.
import { sampleWorld, coinBodyGap, WORLD_SCHEMA, type WorldPlan, type WorldAssets, type Posture, type Mark, type MarkId } from '../../narrated/src/world.ts';
import { CONTRACTS, CONTRACT_SET_VERSION, type ContractId, type ContractInstance } from '../../narrated/src/contracts.ts';
import type { BeatSheet, BeatT } from '../../director/src/beat-sheet.ts';
import { LIBRARY, type Library } from '../../library/src/ids.ts';
import { resolveManifestKey, type ManifestLibrary } from '../../engine/src/build-dispatch.ts';
import type { CharacterManifest } from '../../schema/src/assets.ts';
import { layoutSets, type SetLayout, type Vec3, type Box2 } from './sets.ts';
import { planPath, BODY_RADIUS } from './path.ts';
import { placeholderCharacter } from './placeholders.ts';
import { resolveAction, resolveAsset, resolveCue, resolveExpression, type ActionPlay, type FaceResolution, type ResolvedItem } from './resolve.ts';

export const STAGE_SCHEMA = 'blockspark.vignette-stage/1';
export const WALK_SPEED = 1.1; // move_to contract validation: speed <= 1.1 m/s
export const RUN_SPEED = 2.2;
export const FPS = 30;

type Beat = BeatT;
type ActorTrackT = WorldPlan['actors'][string];
type Seg = ActorTrackT['segs'][number];
type BeatEvent = Beat['events'][number];

export interface StageIssue { severity: 'error' | 'warning' | 'info'; code: string; beat: string | null; entity?: string; t?: number; message: string }
export interface Presence { setId: string; beat: string; t0: number; t1: number }
export interface StagedCast {
  id: string; ref: string; role: string; placement: string; placementKind: 'mark' | 'enter' | 'exit'; actionId: string;
  play: ActionPlay & { status: string; note?: string }; face: FaceResolution; lookAt: string | null; lookTarget: string | null;
  from: Vec3; to: Vec3; moveT0: number | null; moveT1: number | null; actionT0: number; actionT1: number; enterAt: number | null; exitAt: number | null;
  /** labels drawn over the actor for placeholder behaviour in this beat */
  labels: string[];
}
export interface PropSpan { beat: string; setId: string; t0: number; t1: number; kind: 'mark' | 'door' | 'held' | 'on' | 'world'; target: string; pos: Vec3; yawDeg: number; state: string }
export interface StagedProp { instance: string; propId: string; ref: string; world: 'coin' | 'button' | null; resolution: ResolvedItem; spans: PropSpan[] }
export interface DoorTimeline { setId: string; doorId: string; initialOpen: boolean; changes: Array<{ t: number; open: boolean; by: string }> }
export interface StagedEvent { beat: string; index: number; event: BeatEvent; space: 'world' | 'screen' | 'audio'; witness: string[]; resolution: ResolvedItem | null }
export interface StagedBeat {
  phraseId: string; index: number; start: number; end: number; setId: string; lighting: string; text: string;
  cast: StagedCast[]; props: string[]; events: StagedEvent[]; camera: Beat['camera']; captions: Beat['captions'];
  /** times where something visible happens (events, contacts, arrivals) — camera and coverage sample them */
  keyTimes: number[];
}
export interface StagedCharacter { id: string; ref: string; key: string; resolution: ResolvedItem; manifest: CharacterManifest }
export interface StagePlan {
  schema: typeof STAGE_SCHEMA; sheetId: string; title: string; seed: number; fps: number; duration: number;
  sets: SetLayout[]; world: WorldPlan; beats: StagedBeat[]; props: Record<string, StagedProp>; doors: DoorTimeline[];
  presence: Record<string, Presence[]>; characters: Record<string, StagedCharacter>;
  resolution: ResolvedItem[]; issues: StageIssue[];
  /** NarratedEngineAdapter options: world prop ids -> engine prop instances */
  adapter: { propInstances: Record<string, string> };
  contracts: { version: string; used: Record<string, number> };
}

const bare = (r: string) => r.split('@')[0];
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const DEG = Math.PI / 180;
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const smooth = (u: number) => { const x = clamp(u, 0, 1); return x * x * (3 - 2 * x); };
const d2 = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[2] - b[2]);
const yawTo = (from: readonly number[], to: readonly number[]) => Math.atan2(to[0] - from[0], to[2] - from[2]) / DEG;
const angDiff = (a: number, b: number) => { let d = (b - a) % 360; if (d > 180) d -= 360; if (d < -180) d += 360; return d; };
const turnSec = (dDeg: number) => Math.max(0.3, (1.5 * Math.abs(dDeg)) / 300);
const add = (a: readonly number[], b: readonly number[]): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const parsePlacement = (p: string): [string, string] => (p.includes(':') ? (p.split(':') as [string, string]) : ['mark', p]);
const firstEvent = (b: Beat, pred: (e: BeatEvent) => boolean) => b.events.filter(pred).sort((x, y) => x.at - y.at)[0];
const sfxLike = (b: Beat, re: RegExp) => firstEvent(b, (e) => (e.type === 'sfx' && re.test(e.sfxId)) || (e.type === 'vfx' && re.test(e.vfxId)));

/** body height / radius of the fall contract (block biped: head top ~1.96 m) */
const BODY = { height: 1.96, radius: BODY_RADIUS };
/** coin growth ladder of the grow_coin contract (scale steps) */
export const GROW_LADDER = [3, 6, 11, 16.7];

export interface StageOptions { library?: Library }

export function stageBeatSheet(sheet: BeatSheet, lib: ManifestLibrary, opts: StageOptions = {}): StagePlan {
  const library = opts.library ?? LIBRARY;
  const issues: StageIssue[] = [];
  const issue = (severity: StageIssue['severity'], code: string, beat: string | null, message: string, extra: { entity?: string; t?: number } = {}) => issues.push({ severity, code, beat, message, ...extra, ...(extra.t !== undefined ? { t: r4(extra.t) } : {}) });
  const sets = layoutSets(sheet, lib, library);
  const setOf = (id: string) => sets.find((s) => s.id === bare(id))!;
  for (const s of sets) for (const n of s.notes) issue(n.startsWith('placeholder set') ? 'info' : 'warning', n.startsWith('placeholder set') ? 'SET_PLACEHOLDER' : 'SET_LAYOUT', null, `${s.id}: ${n}`);
  const beats = sheet.beats;
  const duration = r4(beats[beats.length - 1].end);

  // ---------------------------------------------------------------- resolution (characters, props, cues)
  const resolution: ResolvedItem[] = [];
  const seen = new Set<string>();
  const note = (r: ResolvedItem) => { const k = `${r.kind}:${r.id}`; if (!seen.has(k)) { seen.add(k); resolution.push(r); } };
  for (const s of sets) note({ kind: 'sets', id: s.id, status: s.status, resolution: s.resolution, source: s.resolution === 'available' ? `assets ${s.key}` : 'grey placeholder room' });
  const characters: Record<string, StagedCharacter> = {};
  for (const b of beats) for (const c of b.cast) {
    const id = bare(c.characterId);
    if (characters[id]) continue;
    const res = resolveAsset('characters', c.characterId, lib, library);
    note(res);
    const key = res.resolution === 'available' ? resolveManifestKey(c.characterId, lib.characters) : undefined;
    const manifest = key ? lib.characters[key] : placeholderCharacter(id);
    characters[id] = { id, ref: c.characterId, key: key ?? `${manifest.id}@${manifest.version}`, resolution: res, manifest };
  }
  const props: Record<string, StagedProp> = {};
  const propInstances: Record<string, string> = {};
  for (const b of beats) for (const p of b.props) {
    const inst = p.instanceId ?? bare(p.propId);
    if (props[inst]) continue;
    const res = resolveAsset('props', p.propId, lib, library);
    note(res);
    const pid = bare(p.propId);
    const world = pid === 'spark_coin' && !propInstances.coin && res.resolution === 'available' ? 'coin' : pid === 'suspicious_button' && !propInstances.button && res.resolution === 'available' ? 'button' : null;
    if (world) propInstances[world] = inst;
    props[inst] = { instance: inst, propId: pid, ref: p.propId, world, resolution: res, spans: [] };
  }
  for (const m of sheet.music) note(resolveCue('music', m.musicId, library));

  // ---------------------------------------------------------------- world assets (coin / button / door bindings)
  const firstSetOf = (inst: string) => { const b = beats.find((x) => x.props.some((p) => (p.instanceId ?? bare(p.propId)) === inst)); return b ? setOf(b.setId) : sets[0]; };
  const propRef = (inst: string) => props[inst] ? resolveManifestKey(props[inst].ref, lib.props) : undefined;
  const coinM = propInstances.coin ? lib.props[propRef(propInstances.coin)!] : lib.props['spark_coin@1.0.0'];
  const btnM = propInstances.button ? lib.props[propRef(propInstances.button)!] : lib.props['suspicious_button@1.0.0'];
  const btnSet = propInstances.button ? firstSetOf(propInstances.button) : sets[0];
  const btnMark = propInstances.button ? beats.flatMap((b) => b.props).find((p) => (p.instanceId ?? bare(p.propId)) === propInstances.button)!.placement : null;
  const btnBase: Vec3 = btnMark && btnSet.marks[btnMark] ? [btnSet.marks[btnMark].pos[0], btnSet.marks[btnMark].surfaceY, btnSet.marks[btnMark].pos[2]] : add(btnSet.origin, [0, -50, 0]);
  const hero = btnSet.dressing[0];
  const deskM = hero ? lib.props[hero.propRef] : undefined;
  const firstDoor = sets.flatMap((s) => Object.values(s.doors))[0];
  const mk = (id: MarkId, pos: Vec3, facingDeg = 0, offscreenOnly = false): Mark => ({ id, pos, facingDeg, source: 'added', offscreenOnly });
  const markOr = (s: SetLayout, id: string, fb: Vec3) => (s.marks[id] ? s.marks[id].pos : fb);
  const cls = sets[0];
  const assets: WorldAssets = {
    layout: `vignette-stage:${sets.map((s) => s.key).join('+')}`,
    marks: {
      zapp_desk: mk('zapp_desk', markOr(cls, 'zapp_desk', cls.origin)), kira_desk: mk('kira_desk', markOr(cls, 'kira_desk', cls.origin)), button_desk: mk('button_desk', btnBase),
      coin_spawn: mk('coin_spawn', markOr(cls, 'coin_spawn', cls.origin)), kira_safe: mk('kira_safe', markOr(cls, 'kira_safe', cls.origin)), zapp_impact: mk('zapp_impact', markOr(cls, 'zapp_impact', cls.origin)),
      // the adapter's door look target: the first door the sheet uses (world position, at floor level)
      classroom_door: mk('classroom_door', firstDoor ? [...firstDoor.threshold] as Vec3 : add(cls.origin, [-5, 0, 0]), firstDoor?.facingDeg ?? 90, false),
    },
    coin: { radius: Math.max(coinM.dimensions[0], coinM.dimensions[2]) / 2, thickness: coinM.dimensions[1] },
    button: { base: btnBase, pressSurface: add(btnBase, btnM.anchors.press_surface), spawnPoint: add(btnBase, btnM.anchors.spawn_point) },
    desk: hero && deskM ? { center: add(hero.pos, [0, deskM.dimensions[1] / 2, 0]), half: [deskM.dimensions[0] / 2, deskM.dimensions[1] / 2, deskM.dimensions[2] / 2] } : { center: add(cls.origin, [0, -50, 0]), half: [0.01, 0.01, 0.01] },
    body: { height: BODY.height, radius: BODY.radius },
  };
  const plan: WorldPlan = {
    schema: WORLD_SCHEMA, contracts: CONTRACT_SET_VERSION, layout: assets.layout, storyboardId: sheet.id, seed: sheet.seed, fps: FPS, duration, frames: Math.round(duration * FPS),
    assets, actors: {}, coin: { hidden: [...assets.button.spawnPoint] as Vec3, spawn: null, base: null, stand: null, grows: [], tip: null }, button: { pressT: null, resetT: null, flashes: [] },
    events: [], instances: [], bridges: [], errors: [], warnings: [], offscreen: {}, status: 'ok',
  };

  // ---------------------------------------------------------------- track builder (world.ts segment semantics)
  let nInst = 0, nEv = 0, nBr = 0;
  const used: Record<string, number> = {};
  const inst = (contract: ContractId, actor: string | null, prop: string | null, t0: number, t1: number, phraseId: string | null, params: Record<string, string | number> = {}, bridgeFor: string | null = null) => {
    if (!CONTRACTS[contract]) throw new Error(`unknown contract ${contract}`);
    used[contract] = (used[contract] ?? 0) + 1;
    const x: ContractInstance = { id: `c${String(++nInst).padStart(3, '0')}`, contract, actor, prop, t0: r4(t0), t1: r4(t1), phraseId, bridgeFor, params };
    plan.instances.push(x); return x;
  };
  const ev = (type: string, t: number, source: string, target: string | null, pos: Vec3 | null, contract: string) => plan.events.push({ id: `e${String(++nEv).padStart(3, '0')}`, type, t: r4(t), source, target, pos: pos ? (pos.map(r4) as Vec3) : null, once: true, contract });
  const err = (code: string, contract: ContractId, beat: string | null, t: number, message: string) => { plan.errors.push({ code, contract, phraseId: beat, t: r4(t), message }); issue('error', code, beat, message, { t }); };
  const end = (id: string) => { const tr = plan.actors[id], s = tr.segs[tr.segs.length - 1]; return s ? { t: s.t1, pos: s.p1, yaw: s.yaw1, posture: s.endPosture, mark: s.endMark } : { t: 0, pos: tr.start.pos, yaw: tr.start.yaw, posture: 'standing' as Posture, mark: tr.start.mark as string | null }; };
  const push = (id: string, seg: Omit<Seg, 'p0' | 'yaw0' | 'mark'> & { p0?: Vec3; yaw0?: number; mark?: string | null }): Seg => {
    const e = end(id);
    if (seg.t0 < e.t - 1e-9) throw new Error(`internal: overlapping segments for ${id} at ${seg.t0} < ${e.t}`);
    if (seg.t0 > e.t + 1e-9) plan.actors[id].segs.push({ t0: e.t, t1: seg.t0, kind: 'hold', contract: 'hold', action: null, posture: e.posture, endPosture: e.posture, heldPose: 'hold', mark: e.mark, endMark: e.mark, p0: e.pos, yaw0: e.yaw, p1: e.pos, yaw1: e.yaw });
    const s: Seg = { p0: e.pos, yaw0: e.yaw, mark: e.mark, ...seg };
    plan.actors[id].segs.push(s); return s;
  };
  /** cut: the actor is re-placed (new set, first appearance, or not carried over) */
  const place = (id: string, t: number, pos: Vec3, yaw: number, mark: string | null, posture: Posture) => {
    const e = end(id), t0 = Math.max(t, e.t);
    return push(id, { t0, t1: t0 + 1e-3, kind: 'hold', contract: 'place', action: null, posture, endPosture: posture, heldPose: 'idle', endMark: mark, p0: pos, yaw0: yaw, mark, p1: pos, yaw1: yaw });
  };
  const hold = (id: string, t0: number, t1: number, action: string | null, contract: string, posture: Posture = 'standing') => { const e = end(id), s = Math.max(t0, e.t); return push(id, { t0: s, t1: Math.max(s + 0.05, t1), kind: 'hold', contract, action, posture, endPosture: posture, heldPose: action ?? 'idle', endMark: e.mark, p1: e.pos, yaw1: e.yaw }); };
  const turn = (id: string, t0: number, yaw: number, contract: string): number => { const e = end(id), d = angDiff(e.yaw, yaw); const s = Math.max(t0, e.t); if (Math.abs(d) < 0.5) return s; const T = turnSec(d); push(id, { t0: s, t1: s + T, kind: 'turn', contract, action: 'turn_toward', posture: 'standing', endPosture: 'standing', heldPose: 'idle', endMark: e.mark, p1: e.pos, yaw1: e.yaw + d }); return s + T; };
  const walk = (id: string, t0: number, pts: Vec3[], mark: string | null, contract: string, speed: number, yawOut: number): Seg => {
    const e = end(id), all = [e.pos, ...pts].filter((p, k, a) => k === 0 || d2(p, a[k - 1]) > 1e-6) as Vec3[];
    if (all.length < 2) return hold(id, t0, t0 + 0.05, null, contract);
    const heads = all.slice(1).map((p, k) => yawTo(all[k], p)), cum = [0];
    for (let k = 1; k < all.length; k++) cum.push(cum[k - 1] + d2(all[k - 1], all[k]));
    const len = cum[cum.length - 1], s = Math.max(t0, e.t), tp = turnSec(angDiff(e.yaw, heads[0])), tw0 = s + tp, tw1 = tw0 + len / speed;
    const last = heads[heads.length - 1], tq = turnSec(angDiff(last, yawOut));
    return push(id, { t0: s, t1: tw1 + tq, kind: 'path', contract, action: 'walk', posture: 'walking', endPosture: 'standing', heldPose: 'idle', endMark: mark, p1: [...all[all.length - 1]] as Vec3, yaw1: last + angDiff(last, yawOut), path: { pts: all, heads, cum, len, speed, tw0, tw1, yawIn: e.yaw, yawOut, tauCorner: 0.25 } });
  };
  const look = (id: string, t: number, v: string | null) => plan.actors[id].looks.push({ t: r4(t), v });
  const expr = (id: string, t: number, v: string) => plan.actors[id].exprs.push({ t: r4(t), v });
  const bridge = (contract: ContractId, actor: string, reason: string, forContract: string, s: { t0: number; t1: number; p0: Vec3; p1: Vec3 }) => plan.bridges.push({ id: `b${String(++nBr).padStart(2, '0')}`, contract, actor, reason, forContract, t0: r4(s.t0), t1: r4(s.t1), from: s.p0.map(r4) as Vec3, to: s.p1.map(r4) as Vec3 });
  const walkTime = (from: Vec3, yaw: number, pts: Vec3[], speed: number, yawOut: number) => { const all = [from, ...pts]; let L = 0; for (let k = 1; k < all.length; k++) L += d2(all[k - 1], all[k]); const h0 = yawTo(all[0], all[1]), hl = yawTo(all[all.length - 2], all[all.length - 1]); return turnSec(angDiff(yaw, h0)) + L / speed + turnSec(angDiff(hl, yawOut)); };

  // ---------------------------------------------------------------- dynamic walk obstacles (the coin as it grows / lies)
  const coinBox = (t: number): Box2 | null => {
    if (!propInstances.coin) return null;
    const c = sampleWorld(plan, t).props.coin;
    if (!c.visible || c.scale < 1.5) return null;
    const tip = plan.coin.tip, b = c.basePoint, R = c.radius, th = c.thickness / 2;
    if (tip && t >= tip.t0) return { id: 'prop:coin', x0: b[0] - R, x1: b[0] + R, z0: tip.pivot[2] - 2 * th, z1: tip.pivot[2] + 2 * R };
    return { id: 'prop:coin', x0: b[0] - R, x1: b[0] + R, z0: b[2] - th, z1: b[2] + th };
  };
  const route = (set: SetLayout, from: Vec3, to: Vec3, t: number, beat: string, who: string) => {
    const cb = coinBox(t);
    const res = planPath(from, to, [...set.obstacles, ...(cb ? [cb] : [])], set.walk);
    if (res.blockedBy) err('PATH_BLOCKED', 'move_to', beat, t, `${who}: no clear path to [${to.map((x) => x.toFixed(2)).join(', ')}] (blocked by ${res.blockedBy})`);
    if (res.pts.length > 2) issue('info', 'PATH_ROUTED', beat, `${who} is routed around obstacles (${res.pts.length - 2} waypoint(s), ${res.length.toFixed(2)} m)`, { entity: who, t });
    return res.pts.slice(1);
  };

  // ---------------------------------------------------------------- doors
  const doors: DoorTimeline[] = [];
  const doorTl = (setId: string, doorId: string) => { let d = doors.find((x) => x.setId === setId && x.doorId === doorId); if (!d) { d = { setId, doorId, initialOpen: false, changes: [] }; doors.push(d); } return d; };
  const doorOpen = (setId: string, doorId: string, t: number) => { const d = doors.find((x) => x.setId === setId && x.doorId === doorId); if (!d) return false; let o = d.initialOpen; for (const c of d.changes) if (c.t <= t + 1e-9) o = c.open; return o; };
  // initial door state = the first beat's door-prop state before any door event
  for (const b of beats) {
    const s = setOf(b.setId);
    for (const p of b.props) if (s.doors[p.placement] && !doors.some((d) => d.setId === s.id && d.doorId === p.placement)) doorTl(s.id, p.placement).initialOpen = p.state === 'open';
    for (const e of b.events) if (e.type === 'door_open' || e.type === 'door_close') doorTl(s.id, e.doorId).changes.push({ t: e.at, open: e.type === 'door_open', by: e.by ?? 'unspecified' });
  }
  for (const d of doors) d.changes.sort((a, b) => a.t - b.t);

  // ---------------------------------------------------------------- beats
  const staged: StagedBeat[] = [];
  const presence: Record<string, Presence[]> = {};
  const lastBeatOf: Record<string, number> = {};
  const lastSetOf: Record<string, string> = {};
  const gone = new Set<string>(); // exited through a door and not re-entered

  beats.forEach((b, bi) => {
    const set = setOf(b.setId), B = b.phraseId, S = b.start, E = b.end, nextS = bi + 1 < beats.length ? beats[bi + 1].start : E;
    const keyTimes = new Set<number>([S + 0.05, (S + E) / 2, E - 0.05]);
    for (const e of b.events) keyTimes.add(e.at);
    const entities = new Set([...b.cast.map((c) => bare(c.characterId)), ...b.props.map((p) => p.instanceId ?? bare(p.propId))]);
    const worldLook = (t: string | undefined): string | null => {
      if (!t || t === 'camera') return null;
      const pr = props[t];
      if (pr?.world) return pr.world;
      if (set.doors[t]) return 'classroom_door';
      return t;
    };
    const targetPos = (t: string | undefined, now: number): Vec3 | null => {
      if (!t) return null;
      if (t === 'camera') return add(set.origin, [0, 1.5, 9]);
      if (plan.actors[t] && entities.has(t)) return sampleWorld(plan, now).actors[t].pos;
      const p = b.props.find((x) => (x.instanceId ?? bare(x.propId)) === t);
      if (p) { const [k, tg] = parsePlacement(p.placement); if (props[t]?.world === 'button') return assets.button.pressSurface; if (props[t]?.world === 'coin') { const c = sampleWorld(plan, now).props.coin; return c.visible ? c.pos : set.marks[tg]?.pos ?? null; } if (k === 'mark') return set.marks[tg]?.pos ?? set.doors[tg]?.threshold ?? null; }
      if (set.doors[t]) return set.doors[t].threshold;
      if (set.marks[t]) return set.marks[t].pos;
      return null;
    };
    const cast: StagedCast[] = [];

    // ---- 1. placement + presence + movement
    for (const c of b.cast) {
      const id = bare(c.characterId), ch = characters[id];
      const [kind, target] = parsePlacement(c.placement);
      const play = resolveAction(c.actionId, library);
      const face = resolveExpression(c.expressionId, ch.manifest, library);
      const labels: string[] = [];
      if (play.placeholder) labels.push(`ACTION ${c.actionId}`);
      if (play.note) issue('info', play.status === 'planned' ? 'ACTION_PLACEHOLDER' : 'ACTION_FALLBACK', B, `${id}: ${play.note}`, { entity: id });
      if (face.note) issue('info', 'EXPRESSION_FALLBACK', B, `${id}: ${face.note}`, { entity: id });
      const enterE = kind === 'enter' ? firstEvent(b, (e) => e.type === 'enter' && bare(e.characterId) === id && e.doorId === target) : undefined;
      const exitE = kind === 'exit' ? firstEvent(b, (e) => e.type === 'exit' && bare(e.characterId) === id && e.doorId === target) : undefined;
      const door = kind !== 'mark' ? set.doors[target] : undefined;
      const markPos = kind === 'mark' ? set.marks[target] : undefined;
      if (kind === 'mark' && !markPos) issue('error', 'MARK_UNKNOWN', B, `${id}: mark ${target} does not exist in ${set.id}`, { entity: id });
      if (kind !== 'mark' && !door) issue('error', 'DOOR_UNKNOWN', B, `${id}: door ${target} does not exist in ${set.id}`, { entity: id });
      const speed = play.locomotion === 'run' ? RUN_SPEED : WALK_SPEED;
      const carried = b.carryOver.includes(id);
      const continuing = !!plan.actors[id] && lastBeatOf[id] === bi - 1 && lastSetOf[id] === set.id && !gone.has(id);
      if (!plan.actors[id]) {
        const p0 = door ? (kind === 'enter' ? door.threshold : door.inside) : markPos?.pos ?? set.origin;
        plan.actors[id] = { id, start: { pos: [...p0] as Vec3, yaw: markPos?.facingDeg ?? door?.facingDeg ?? 0, mark: target }, segs: [], looks: [], exprs: [{ t: 0, v: face.applied }], contacts: [] };
      }
      if (continuing && !carried) issue('warning', 'CARRYOVER_MISSING', B, `${id} continues from the previous beat in ${set.id} but is not in carryOver: kept continuous (no cut)`, { entity: id });
      if (!continuing && carried) issue('warning', 'CARRYOVER_BROKEN', B, `${id} is carried over but was not staged in ${set.id} in the previous beat: re-placed at the cut`, { entity: id });
      let from: Vec3 = end(id).pos, moveT0: number | null = null, moveT1: number | null = null, enterAt: number | null = null, exitAt: number | null = null;
      let visibleFrom = S, visibleTo = nextS;
      const prone = end(id).posture === 'prone';
      if (!continuing) {
        // cut placement: where the beat needs the actor at its start
        let p0: Vec3, yaw: number;
        if (kind === 'enter' && door) { p0 = door.threshold; yaw = door.facingDeg; }
        else if (kind === 'exit' && door && exitE) {
          // start far enough inside the room to walk out by the exit time (60 % of the available time)
          const a = door.facingDeg * DEG, dist = clamp((exitE.at - S) * 0.6 * WALK_SPEED, 0.8, 3.0);
          p0 = add(door.inside, [Math.sin(a) * dist, 0, Math.cos(a) * dist]); yaw = door.facingDeg + 180;
        } else { p0 = markPos?.pos ?? set.origin; yaw = markPos?.facingDeg ?? 0; }
        const posture: Posture = play.posture === 'implied_seated' ? 'implied_seated' : prone && c.actionId === 'flattened' ? 'prone' : 'standing';
        place(id, S, p0, yaw, kind === 'mark' ? target : null, posture);
        from = p0;
        if (prone && c.actionId !== 'flattened') issue('warning', 'PRONE_RESET_AT_CUT', B, `${id} was prone; the cut re-places ${id} standing (no get_up exists)`, { entity: id });
      } else if (end(id).posture === 'implied_seated' && play.posture !== 'implied_seated' && kind === 'mark' && markPos && d2(end(id).pos, markPos.pos) > 0.05) {
        issue('info', 'IMPLIED_STAND', B, `${id} leaves an implied seat to move (no authored stand_up)`, { entity: id });
      }
      const t0 = Math.max(S + 0.05, end(id).t);
      if (kind === 'enter' && door) {
        const at = enterE?.at ?? S + 0.1;
        enterAt = at; visibleFrom = at;
        if (!doorOpen(set.id, target, at)) issue('warning', 'DOOR_CLOSED_AT_ENTER', B, `${id} enters through ${target} at ${at} s but the door is closed`, { entity: id, t: at });
        if (continuing) { const s = walk(id, t0, [door.threshold], null, 'move_to', speed, door.facingDeg + 180); if (s.t1 > at) issue('warning', 'ENTER_LATE', B, `${id} reaches ${target} at ${r4(s.t1)} s, after the enter event (${at})`, { entity: id }); }
        hold(id, t0, at, null, 'hold');
        const c1 = inst('move_to', id, null, at, at, B, { to: `${target}:inside`, kind: 'enter' });
        const pts = route(set, door.threshold, door.inside, at, B, id);
        const s = walk(id, at, pts, null, c1.id, speed, door.facingDeg);
        c1.t0 = r4(s.t0); c1.t1 = r4(s.t1); moveT0 = s.t0; moveT1 = s.t1;
        ev('enter', at, id, target, door.threshold, c1.id);
        gone.delete(id);
      } else if (kind === 'exit' && door) {
        const at = exitE?.at ?? E - 0.1;
        exitAt = at; visibleTo = at + 0.05;
        const e0 = end(id);
        const pts = route(set, e0.pos, door.inside, t0, B, id).concat([door.threshold]);
        const need = walkTime(e0.pos, e0.yaw, pts, speed, door.facingDeg + 180);
        const c1 = inst('move_to', id, null, 0, 0, B, { to: `${target}:threshold`, kind: 'exit' });
        const s = walk(id, Math.max(t0, at - need), pts, null, c1.id, speed, door.facingDeg + 180);
        c1.t0 = r4(s.t0); c1.t1 = r4(s.t1); moveT0 = s.t0; moveT1 = s.t1;
        if (s.t1 > at + 1 / FPS) issue('warning', 'EXIT_LATE', B, `${id} reaches ${target} at ${r4(s.t1)} s, after the exit event (${at})`, { entity: id, t: s.t1 });
        if (!doorOpen(set.id, target, at)) issue('warning', 'DOOR_CLOSED_AT_EXIT', B, `${id} exits through ${target} at ${at} s but the door is closed`, { entity: id, t: at });
        ev('exit', at, id, target, door.threshold, c1.id);
        gone.add(id);
      } else if (markPos && d2(end(id).pos, markPos.pos) > 0.05) {
        if (end(id).posture === 'prone') issue('error', 'GET_UP_UNAVAILABLE', B, `${id} is prone and cannot walk to ${target} (no get_up)`, { entity: id });
        else {
          const isMove = play.contract === 'move_to';
          const c1 = inst('move_to', id, null, 0, 0, B, { to: target }, isMove ? null : c.actionId);
          const pts = route(set, end(id).pos, markPos.pos, t0, B, id);
          const s = walk(id, t0, pts, target, c1.id, speed, markPos.facingDeg);
          c1.t0 = r4(s.t0); c1.t1 = r4(s.t1); moveT0 = s.t0; moveT1 = s.t1;
          if (!isMove) bridge('move_to', id, `${c.actionId} happens at ${target}: ${id} walks there first`, c1.id, s);
          ev('reached_mark', s.t1, id, target, markPos.pos, c1.id);
          keyTimes.add(s.t1);
          if (s.t1 > E) issue('warning', 'MOVE_OVERRUNS_BEAT', B, `${id} reaches ${target} at ${r4(s.t1)} s, ${r4(s.t1 - E)} s after the beat ends (${E})`, { entity: id, t: s.t1 });
        }
      }
      const to = end(id).pos;
      (presence[id] ??= []).push({ setId: set.id, beat: B, t0: r4(visibleFrom), t1: r4(visibleTo) });
      lastBeatOf[id] = bi; lastSetOf[id] = set.id;
      cast.push({ id, ref: c.characterId, role: c.role, placement: c.placement, placementKind: kind as StagedCast['placementKind'], actionId: c.actionId, play, face, lookAt: c.lookAt ?? null, lookTarget: worldLook(c.lookAt), from, to, moveT0, moveT1, actionT0: end(id).t, actionT1: end(id).t, enterAt, exitAt, labels });
    }

    // ---- 2. props: placement spans (coin / button are world-driven; the rest are placed by staging)
    for (const p of b.props) {
      const id = p.instanceId ?? bare(p.propId), pr = props[id];
      const [kind, target] = parsePlacement(p.placement);
      let pos: Vec3 = set.origin, yawDeg = 0, k: PropSpan['kind'] = 'mark';
      if (kind === 'held') { k = 'held'; if (!b.cast.some((c) => bare(c.characterId) === target)) issue('error', 'HOLDER_MISSING', B, `${id} is held by ${target}, who is not in the beat`); }
      else if (kind === 'on') k = 'on';
      else if (set.doors[target]) { k = 'door'; pos = set.doors[target].threshold; yawDeg = set.doors[target].facingDeg - 90; }
      else if (set.marks[target]) { pos = [set.marks[target].pos[0], set.marks[target].surfaceY, set.marks[target].pos[2]]; yawDeg = set.marks[target].facingDeg; }
      else issue('error', 'MARK_UNKNOWN', B, `prop ${id}: placement ${p.placement} does not exist in ${set.id}`);
      if (pr.world) k = 'world';
      const prev = pr.spans[pr.spans.length - 1];
      if (prev && prev.setId === set.id && b.carryOver.includes(id) && prev.target !== target && !pr.world) issue('warning', 'PROP_JUMP_CUT', B, `${id} moves from ${prev.target} to ${target} with no action moving it (placed at the beat start)`, { entity: id });
      pr.spans.push({ beat: B, setId: set.id, t0: S, t1: nextS, kind: k, target, pos, yawDeg, state: p.state });
      if (pr.resolution.resolution === 'placeholder' && p.state && k !== 'door') issue('info', 'PROP_STATE_PLACEHOLDER', B, `${id} (placeholder block) state "${p.state}" is shown on its label only`, { entity: id });
    }

    // ---- 3. main actions
    const btnInBeat = b.props.find((p) => props[p.instanceId ?? bare(p.propId)]?.world === 'button');
    const coinInBeat = b.props.find((p) => props[p.instanceId ?? bare(p.propId)]?.world === 'coin');
    let pressContact: number | null = null;
    for (const sc of cast) {
      const id = sc.id, play = sc.play, e0 = end(id);
      let t0 = Math.max(S + 0.05, e0.t);
      const holdEnd = nextS - 0.02;
      expr(id, Math.max(S + 0.05, sc.enterAt ?? S + 0.05), sc.face.applied);
      if (sc.placementKind === 'exit' || sc.placementKind === 'enter') {
        look(id, S + 0.05, sc.lookTarget);
        if (sc.placementKind === 'enter') hold(id, t0, holdEnd, 'look_at', 'look_at');
        sc.actionT0 = t0; sc.actionT1 = end(id).t;
        continue;
      }
      // turn toward the look target when it is far outside the head's range (seated / prone actors only turn the head)
      const tp = targetPos(sc.lookAt ?? undefined, t0);
      if (tp && e0.posture === 'standing' && play.contract !== 'press_button' && play.contract !== 'fall_prone') {
        const need = yawTo(e0.pos, tp);
        if (Math.abs(angDiff(e0.yaw, need)) > 55) { const lc = inst('look_at', id, null, t0, t0, B, { target: sc.lookAt!, kind: 'turn_toward' }); t0 = turn(id, t0, need, lc.id); lc.t1 = r4(t0); }
      }
      look(id, t0, sc.lookTarget);
      if (sc.lookAt === 'camera') issue('info', 'LOOK_AT_CAMERA', B, `${id} looks at the camera: body turned to the audience side (the engine has no camera look target)`, { entity: id });
      else if (sc.lookAt && sc.lookTarget && !plan.actors[sc.lookTarget] && sc.lookTarget !== 'coin' && sc.lookTarget !== 'button' && sc.lookTarget !== 'classroom_door') issue('warning', 'LOOK_TARGET_BODY_ONLY', B, `${id} looks at ${sc.lookAt}: the pose adapter resolves only actors, the coin, the button and the first door; body turned, head neutral`, { entity: id });
      const posture: Posture = e0.posture === 'prone' ? 'prone' : play.posture === 'implied_seated' ? 'implied_seated' : 'standing';
      if (e0.posture === 'prone' && play.contract !== 'fall_prone' && play.contract !== 'look_at' && play.contract !== 'remain_still') issue('error', 'GET_UP_UNAVAILABLE', B, `${id} is prone; ${sc.actionId} needs standing (no get_up)`, { entity: id });
      switch (play.contract) {
        case 'move_to': { const c1 = inst('remain_still', id, null, t0, holdEnd, B, { after: 'move_to' }); hold(id, t0, holdEnd, null, c1.id, posture); break; }
        case 'remain_still': {
          const c1 = inst('remain_still', id, null, t0, holdEnd, B, posture === 'implied_seated' ? { posture: 'implied_seated', framing: 'waist_up_only', warning: 'AUTHORED_SEATED_ANIMATION_UNAVAILABLE' } : { posture });
          hold(id, t0, holdEnd, posture === 'implied_seated' ? null : play.pose === 'idle' ? null : play.pose, c1.id, posture);
          if (posture === 'implied_seated' && !plan.warnings.some((w) => w.phraseId === B && w.message.startsWith(id))) plan.warnings.push({ code: 'AUTHORED_SEATED_ANIMATION_UNAVAILABLE', phraseId: B, message: `${id} is only implied seated: no authored seated animation or chair exists; framing must be waist-up` });
          break;
        }
        case 'confident_pose': case 'look_at': { const c1 = inst(play.contract, id, null, t0, holdEnd, B, { target: sc.lookAt ?? 'none', pose: play.pose }); hold(id, t0, holdEnd, posture === 'prone' ? null : play.pose, c1.id, posture); break; }
        case 'warning': { const c1 = inst('warning', id, null, t0, t0 + play.seconds, B, { target: sc.lookAt ?? 'none' }); hold(id, t0, t0 + play.seconds, 'head_shake', c1.id, posture); keyTimes.add(t0 + play.seconds / 2); break; }
        case 'celebrate': {
          const c1 = inst('celebrate', id, null, t0, t0 + play.seconds, B, { pose: play.pose });
          // celebration timed to the beat's celebration cue (confetti / tada) when there is one
          const cue = sfxLike(b, /confetti|tada/);
          const s0 = cue && cue.at - 0.3 > t0 && cue.at - 0.3 + play.seconds < E ? cue.at - 0.3 : t0;
          hold(id, s0, s0 + play.seconds, play.pose, c1.id, 'standing'); c1.t0 = r4(s0); c1.t1 = r4(s0 + play.seconds); keyTimes.add(s0 + 0.5 * play.seconds);
          break;
        }
        case 'jump': { const c1 = inst('jump', id, null, t0, t0 + 0.9, B, { height: 0.49 }); push(id, { t0, t1: t0 + 0.9, kind: 'jump', contract: c1.id, action: 'jump', posture: 'jumping', endPosture: 'standing', heldPose: 'idle', endMark: e0.mark, p1: e0.pos, yaw1: e0.yaw, jumpH: 0.49 }); keyTimes.add(t0 + 0.45); break; }
        case 'press_button': {
          if (!btnInBeat) { issue('error', 'PRESS_NO_BUTTON', B, `${id} presses a button but no button prop is in the beat`, { entity: id }); break; }
          const pc = inst('press_button', id, 'button', 0, 0, B, {});
          const target = assets.button.pressSurface, reach = 0.55, tol = 25;
          let s0 = t0;
          const e1 = end(id);
          if (d2(e1.pos, target) > reach) {
            const dir = [target[0] - e1.pos[0], target[2] - e1.pos[2]], l = Math.hypot(dir[0], dir[1]);
            const ap: Vec3 = [target[0] - (dir[0] / l) * (reach - 0.1), 0, target[2] - (dir[1] / l) * (reach - 0.1)];
            const bc = inst('move_to', id, null, s0, s0, B, { to: 'press_reach' }, pc.id);
            const w = walk(id, s0, route(set, e1.pos, ap, s0, B, id), null, bc.id, WALK_SPEED, yawTo(ap, target));
            bc.t0 = r4(w.t0); bc.t1 = r4(w.t1); bridge('move_to', id, `press_button requires ${id} within ${reach} m of the button`, pc.id, w); s0 = w.t1;
          }
          const e2 = end(id), need = yawTo(e2.pos, target);
          if (Math.abs(angDiff(e2.yaw, need)) > tol) { const bc = inst('move_to', id, null, s0, s0, B, { to: 'face_button', kind: 'turn_toward' }, pc.id); const t1 = turn(id, s0, need, bc.id); const seg = plan.actors[id].segs[plan.actors[id].segs.length - 1]; bc.t0 = r4(seg.t0); bc.t1 = r4(t1); bridge('move_to', id, `press_button requires ${id} facing the button`, pc.id, seg); s0 = t1; }
          const e3 = end(id);
          if (d2(e3.pos, target) > reach + 1e-6 || Math.abs(angDiff(e3.yaw, yawTo(e3.pos, target))) > tol + 1e-6) { err('PRESS_PRECONDITION_FAILED', 'press_button', B, s0, `${id} cannot reach or face the button`); break; }
          // contact (u = 0.42 of 0.9 s) on the beat's click cue when it is reachable in time
          const cue = sfxLike(b, /click|zoom_punch/);
          const want = cue ? cue.at - 0.9 * 0.42 : s0;
          const start = Math.max(s0, want);
          if (cue && Math.abs(start + 0.378 - cue.at) > 1 / FPS) issue('warning', 'CONTACT_OFF_CUE', B, `${id}'s press contact lands at ${r4(start + 0.378)} s, cue ${cue.type === 'sfx' ? cue.sfxId : ''} at ${cue.at}`, { entity: id });
          const s = hold(id, start, start + 0.9, 'press_button', pc.id);
          pc.t0 = r4(s.t0); pc.t1 = r4(s.t1);
          const contact = s.t0 + 0.9 * 0.42;
          if (plan.button.pressT !== null) issue('warning', 'BUTTON_PRESSED_AGAIN', B, `the world button model holds one press (first at ${plan.button.pressT} s); this press only animates`, { entity: id });
          else plan.button.pressT = r4(contact);
          pressContact = contact;
          plan.button.flashes.push([r4(contact + 0.03), r4(contact + 0.53)]);
          plan.actors[id].contacts.push({ t0: contact - 0.05, t1: contact + 0.15, with: 'button' });
          ev('press_contact', contact, id, 'button', target, pc.id);
          look(id, s.t0, 'button');
          keyTimes.add(contact);
          hold(id, s.t1, holdEnd, null, pc.id);
          break;
        }
        case 'fall_prone': { /* scheduled with the prop contracts below (coupled to a tip, or a plain fall) */ break; }
      }
      sc.actionT0 = t0; sc.actionT1 = end(id).t;
    }

    // ---- 4. prop contracts from states
    if (btnInBeat) {
      const st = btnInBeat.state;
      if (st === 'flashing') { const cue = sfxLike(b, /flash|beep/); const t = cue?.at ?? S + 0.05; plan.button.flashes.push([r4(t), r4(t + 1.2)]); ev('button_flash', t, 'button', null, assets.button.base, 'flash'); keyTimes.add(t); }
      if (st === 'reset') {
        const cue = sfxLike(b, /reset|glow_pulse/); const t = cue?.at ?? S + 0.05;
        const c1 = inst('reset_button', null, 'button', t, t + 0.3, B, {});
        if (plan.button.pressT === null) err('RESET_PRECONDITION_FAILED', 'reset_button', B, t, 'the button was never pressed');
        else { plan.button.resetT = r4(t); plan.button.flashes.push([r4(t + 0.35), r4(t + 1.35)]); ev('button_reset', t, 'button', null, assets.button.base, c1.id); keyTimes.add(t + 0.3); }
      }
      if (st === 'pressed' && pressContact === null) issue('warning', 'PRESSED_WITHOUT_PRESS', B, `button state "pressed" but nobody presses it in this beat`);
    }
    if (coinInBeat) {
      const st = coinInBeat.state, cp = plan.coin, cm = set.marks[parsePlacement(coinInBeat.placement)[1]];
      if (st === 'spawned' && !cp.spawn) {
        if (pressContact === null) err('SPAWN_PRECONDITION_FAILED', 'spawn_coin', B, S, 'spawn_coin needs a press contact in the same beat');
        else if (!cm) err('SPAWN_PRECONDITION_FAILED', 'spawn_coin', B, S, `coin placement ${coinInBeat.placement} is not a mark`);
        else {
          const pop = sfxLike(b, /coin_pop|pop/);
          const t0 = pop && pop.at >= pressContact + 0.05 && pop.at <= pressContact + 1.5 ? pop.at : pressContact + 0.1;
          const c1 = inst('spawn_coin', null, 'coin', t0, t0 + 0.65, B, { to: coinInBeat.placement });
          cp.spawn = { t0, t1: t0 + 0.65, from: [...assets.button.spawnPoint] as Vec3, to: [cm.pos[0], assets.coin.thickness / 2, cm.pos[2]] };
          cp.base = [...cm.pos] as Vec3;
          ev('coin_spawn', t0, 'button', 'coin', assets.button.spawnPoint, c1.id); ev('coin_land', t0 + 0.65, 'coin', 'floor', cm.pos, c1.id);
          keyTimes.add(t0 + 0.3); keyTimes.add(t0 + 0.65);
        }
      }
      if (st === 'growing' || st === 'giant') {
        if (!cp.spawn || cp.spawn.t1 > S + 1e-6) err('GROW_PRECONDITION_FAILED', 'grow_coin', B, S, 'the coin is not resting at its base');
        else {
          const done = cp.grows.length ? cp.grows[cp.grows.length - 1].s1 : 1;
          const steps = st === 'growing' ? GROW_LADDER.filter((x) => x > done).slice(0, 2) : GROW_LADDER.filter((x) => x > done);
          const cue = sfxLike(b, /boing|rumble|grow/);
          let t = Math.max(S + 0.06, cue && cue.at < E - 1 ? cue.at - 0.34 : S + 0.3);
          if (!cp.stand) { cp.stand = { t0: t, t1: t + 0.3 }; ev('coin_stand', t, 'coin', null, cp.base, 'grow'); t += 0.34; }
          const gap = steps.length ? clamp((E - 0.4 - t) / steps.length - 0.5, 0.1, 0.9) : 0.1;
          for (const s1 of steps) {
            const s0 = cp.grows.length ? cp.grows[cp.grows.length - 1].s1 : 1, d = s1 > 6 ? 0.5 : 0.4;
            const c1 = inst('grow_coin', null, 'coin', t, t + d, B, { from: s0, to: s1 });
            cp.grows.push({ t0: t, t1: t + d, s0, s1 });
            ev('grow_step', t + d, 'coin', null, cp.base, c1.id);
            keyTimes.add(t + d);
            // clearance: the upright coin box stays >= 0.10 m from every actor capsule in the set
            const w = sampleWorld(plan, t + d);
            for (const [aid, a] of Object.entries(w.actors)) {
              if (!presence[aid]?.some((p) => p.setId === set.id && p.t0 <= t + d && p.t1 >= t + d)) continue;
              const Rs = assets.coin.radius * s1, ths = (assets.coin.thickness / 2) * s1, bb = cp.base!;
              const dx = Math.max(0, Math.abs(a.pos[0] - bb[0]) - Rs), dz = Math.max(0, Math.abs(a.pos[2] - bb[2]) - ths);
              if (Math.hypot(dx, dz) - BODY.radius < 0.1) err('GROW_CLEARANCE', 'grow_coin', B, t + d, `coin at scale ${s1} comes within 0.10 m of ${aid}`);
            }
            t += d + gap;
          }
          if (st === 'giant' && done < GROW_LADDER[GROW_LADDER.length - 1] && !steps.length) issue('warning', 'GIANT_WITHOUT_GROWTH', B, 'coin state giant but the ladder is already complete');
        }
      }
      if (st === 'tipped' && !cp.tip) {
        const patientC = cast.find((c) => c.play.contract === 'fall_prone');
        const creak = sfxLike(b, /creak|wobble/), thud = sfxLike(b, /thud_big|crash|flatten/);
        const tt = creak?.at ?? S + 0.04;
        const w = sampleWorld(plan, tt), coin = w.props.coin;
        const fails: string[] = [];
        if (!coin.visible) fails.push('coin_visible');
        if (coin.phase !== 'upright' || coin.upright < 0.999) fails.push('coin_upright');
        const pat = patientC ? w.actors[patientC.id] : undefined;
        if (!patientC || !pat) fails.push('patient_in_beat');
        const S1 = coin.scale, R = assets.coin.radius * S1, th = (assets.coin.thickness / 2) * S1, bb = cp.base ?? coin.basePoint, pivot: Vec3 = [bb[0], 0, bb[2] + th];
        // the patient must stand inside the landing zone of the tipping coin (in front of it, within its width)
        if (pat && !(pat.pos[2] > pivot[2] && pat.pos[2] < pivot[2] + 2 * R && Math.abs(pat.pos[0] - bb[0]) < R)) fails.push('patient_in_landing_zone');
        if (pat && pat.posture !== 'standing') fails.push('patient_standing');
        for (const other of cast.filter((c) => c !== patientC)) {
          const a = w.actors[other.id];
          if (a && a.pos[2] > pivot[2] - 0.3 && a.pos[2] < pivot[2] + 2 * R + 0.5 && Math.abs(a.pos[0] - bb[0]) < R + 0.5) fails.push(`${other.id}_outside_hazard`);
        }
        const c1 = inst('tip_coin_onto', patientC?.id ?? null, 'coin', tt, tt, B, { patient: patientC?.id ?? 'none' });
        if (fails.length) err('TIP_PRECONDITION_FAILED', 'tip_coin_onto', B, tt, `tip_coin_onto unavailable: failed ${fails.join(', ')}`);
        else {
          const id = patientC!.id, feet: Vec3 = [...pat!.pos] as Vec3;
          const thetaC = touchAngle(feet, 0, pivot, R, th, BODY.height, BODY.radius, 0);
          // free fall timed so the contact lands on the beat's impact cue (thud), within the contract's 1.2-2.0 s
          const frac = Math.pow(thetaC / 90, 1 / 3);
          const freeT = thud && thud.at > tt + 0.3 ? clamp((thud.at - tt) / frac, 0.6, 2.0) : 1.0;
          const tc = tt + freeT * frac, fallT = 0.6;
          if (thud && Math.abs(tc - thud.at) > 1 / FPS) issue('warning', 'CONTACT_OFF_CUE', B, `coin/${id} contact at ${r4(tc)} s, impact cue at ${thud.at}`, { entity: id });
          const samples: Array<[number, number]> = [], pitch: Array<[number, number]> = [];
          let prev = thetaC;
          for (let q = 0; q <= 180; q++) { const u = q / 180, tq = tc + u * fallT, phi = 90 * smooth(u); const th2 = Math.max(prev, touchAngle(feet, phi, pivot, R, th, BODY.height, BODY.radius, prev)); prev = th2; samples.push([tq, th2]); pitch.push([tq, phi]); }
          const thetaR = samples[samples.length - 1][1];
          cp.tip = { t0: tt, tc, t1: tc + fallT, freeT, thetaC, thetaR, pivot, scale: S1, coupled: samples };
          c1.t1 = r4(tc + fallT); c1.params.thetaC = r4(thetaC); c1.params.thetaR = r4(thetaR);
          ev('tip_start', tt, 'coin', id, pivot, c1.id);
          const e = end(id);
          // the patient holds until the contact instant; the fall starts exactly at contact and stays prone
          if (e.t < tc) push(id, { t0: e.t, t1: tc, kind: 'hold', contract: c1.id, action: 'shock_recoil', posture: 'standing', endPosture: 'standing', heldPose: 'shock_recoil', endMark: e.mark, p1: e.pos, yaw1: e.yaw });
          const fc = inst('fall_prone', id, 'coin', tc, tc + fallT, B, { cause: 'coin' });
          push(id, { t0: tc, t1: tc + fallT, kind: 'fall', contract: fc.id, action: 'fall_prone', posture: 'falling', endPosture: 'prone', heldPose: 'prone', endMark: e.mark, p1: end(id).pos, yaw1: end(id).yaw, fall: { feet, samples: pitch } });
          plan.actors[id].contacts.push({ t0: tc, t1: Infinity, with: 'coin' }, { t0: tc + fallT, t1: Infinity, with: 'floor' });
          ev('coin_patient_contact', tc, 'coin', id, pivot, c1.id); ev('patient_prone', tc + fallT, id, 'floor', feet, fc.id); ev('coin_rest', tc + fallT, 'coin', 'floor', pivot, c1.id);
          look(id, tt + 0.25, 'coin');
          keyTimes.add(tc); keyTimes.add(tc + fallT); keyTimes.add(tt + 0.4);
          patientC!.actionT0 = tt; patientC!.actionT1 = tc + fallT;
        }
      }
    }
    // plain falls (no coin coupling) and prone holds
    for (const sc of cast) {
      if (sc.play.contract !== 'fall_prone') continue;
      const e = end(sc.id);
      if (e.posture === 'prone') { const c1 = inst('remain_still', sc.id, null, Math.max(S, e.t), nextS, B, { posture: 'prone' }); hold(sc.id, Math.max(S + 0.05, e.t), nextS - 0.02, null, c1.id, 'prone'); continue; }
      if (plan.coin.tip && plan.coin.tip.t0 >= S && plan.coin.tip.t0 < E) continue;
      const t0 = Math.max(S + 0.3, e.t), fallT = 0.6;
      const fc = inst('fall_prone', sc.id, null, t0, t0 + fallT, B, { cause: 'self' });
      const pitch: Array<[number, number]> = Array.from({ length: 31 }, (_, q) => [t0 + (q / 30) * fallT, 90 * smooth(q / 30)] as [number, number]);
      push(sc.id, { t0, t1: t0 + fallT, kind: 'fall', contract: fc.id, action: 'fall_prone', posture: 'falling', endPosture: 'prone', heldPose: 'prone', endMark: e.mark, p1: e.pos, yaw1: e.yaw, fall: { feet: [...e.pos] as Vec3, samples: pitch } });
      plan.actors[sc.id].contacts.push({ t0: t0 + fallT, t1: Infinity, with: 'floor' });
      ev('patient_prone', t0 + fallT, sc.id, 'floor', e.pos, fc.id);
      keyTimes.add(t0 + fallT);
      sc.actionT0 = t0; sc.actionT1 = t0 + fallT;
    }

    // ---- 5. events: space + witnesses + resolution
    const events: StagedEvent[] = b.events.map((e, index): StagedEvent => {
      switch (e.type) {
        case 'enter': case 'exit': return { beat: B, index, event: e, space: 'world', witness: [bare(e.characterId)], resolution: null };
        case 'door_open': case 'door_close': {
          const doorProp = b.props.find((p) => p.placement === e.doorId);
          return { beat: B, index, event: e, space: 'world', witness: doorProp ? [doorProp.instanceId ?? bare(doorProp.propId)] : [`door:${e.doorId}`], resolution: null };
        }
        case 'vfx': { const r = resolveCue('vfx', e.vfxId, library); note(r); return { beat: B, index, event: e, space: e.target ? 'world' : 'screen', witness: e.target ? [e.target] : [], resolution: r }; }
        case 'text_graphic': { const r = resolveCue('textStyles', e.textStyleId, library); note(r); return { beat: B, index, event: e, space: e.target ? 'world' : 'screen', witness: e.target ? [e.target] : [], resolution: r }; }
        case 'sfx': { const r = resolveCue('sfx', e.sfxId, library); note(r); return { beat: B, index, event: e, space: 'audio', witness: [], resolution: r }; }
      }
      return { beat: B, index, event: e, space: 'screen', witness: [], resolution: null };
    });
    note(resolveCue('cameraRecipes', b.camera.recipeId, library));
    staged.push({
      phraseId: B, index: bi, start: S, end: E, setId: set.id, lighting: b.lighting, text: b.text, cast, props: b.props.map((p) => p.instanceId ?? bare(p.propId)), events,
      camera: b.camera, captions: b.captions, keyTimes: [...keyTimes].filter((t) => t >= S && t <= E).map(r4).sort((x, y) => x - y).filter((t, k, a) => k === 0 || t - a[k - 1] > 0.02),
    });
  });

  plan.events.sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : 1));
  for (const tr of Object.values(plan.actors)) { tr.looks.sort((a, b) => a.t - b.t); tr.exprs.sort((a, b) => a.t - b.t); }
  if (plan.errors.length) plan.status = 'unavailable';
  // hard overlap check at every beat's key times (actors in the same set closer than two body radii)
  for (const sb of staged) for (const t of [sb.start + 0.05, sb.end - 0.05]) {
    const w = sampleWorld(plan, t), ids = sb.cast.map((c) => c.id).filter((id) => presence[id]?.some((p) => p.beat === sb.phraseId && p.t0 <= t && p.t1 >= t));
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const d = d2(w.actors[ids[i]].pos, w.actors[ids[j]].pos);
      if (d < 0.45 && w.actors[ids[i]].posture !== 'prone' && w.actors[ids[j]].posture !== 'prone') issue('warning', 'ACTOR_OVERLAP', sb.phraseId, `${ids[i]} and ${ids[j]} are ${(d * 100).toFixed(0)} cm apart at ${r4(t)} s`);
    }
  }
  return {
    schema: STAGE_SCHEMA, sheetId: sheet.id, title: sheet.title, seed: sheet.seed, fps: FPS, duration, sets, world: plan, beats: staged, props, doors, presence, characters,
    resolution, issues, adapter: { propInstances }, contracts: { version: CONTRACT_SET_VERSION, used },
  };
}

/** largest coin angle in [lo, 89.9] that keeps the body clear (bisection; same solve as the narrated world plan) */
function touchAngle(feet: Vec3, pitch: number, pivot: Vec3, R: number, th: number, H: number, r: number, lo: number): number {
  if (coinBodyGap(feet, pitch, pivot, 89.9, R, th, H, r) >= 0) return 89.9;
  let a = lo, b = 89.9;
  for (let k = 0; k < 40; k++) { const m = (a + b) / 2; if (coinBodyGap(feet, pitch, pivot, m, R, th, H, r) >= 0) a = m; else b = m; }
  return a;
}

/** is actor `id` on screen (present in its beat's set) at t? */
export function actorPresent(plan: StagePlan, id: string, t: number, setId?: string): boolean {
  return (plan.presence[id] ?? []).some((p) => t >= p.t0 - 1e-9 && t < p.t1 - 1e-9 && (!setId || p.setId === setId));
}
/** beat active at t (the last beat that started at or before t) */
export function beatAt(plan: StagePlan, t: number): StagedBeat {
  let b = plan.beats[0];
  for (const x of plan.beats) if (x.start <= t + 1e-9) b = x;
  return b;
}
