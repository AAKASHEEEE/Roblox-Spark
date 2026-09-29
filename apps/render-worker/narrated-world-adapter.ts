// Narrated world -> engine adapter (Continuity Checkpoint 2). Drives engine rigs and props from the authoritative
// WorldState (packages/narrated/src/world.ts). The adapter never plans motion: root position, facing, vertical
// displacement, body pitch, posture, look target, expression and every prop transform are copied from the snapshot.
// The plan is read only for procedural PHASE (gait distance along the planned path, local time inside an action) so
// the joint poses can be evaluated at random access. Transforms are a pure function of (plan, snapshot): cameras,
// shot boundaries, out-of-order probes and the `previous` argument can never change them (previous only feeds
// diagnostics such as per-frame deltas and foot slip).
import type { Rig } from '../../packages/engine/src/build.ts';
import type { PropInstance } from '../../packages/engine/src/build.ts';
import type { Vec3 } from '../../packages/engine/src/math.ts';
import type { ActionPose, JointPose } from '../../packages/engine/src/animation/pose.ts';
import {
  actionPose, applyMotionFrame, blendPoses, blendWindow, bodySamplePoints, braceLayer, fallPose, gaitPose, hasProceduralAction, jumpPose, neutralUpperBodyPose, pronePose,
  smoothstep, transitionWeight, LOOK_BLEND_SEC, MIN_BLEND_SEC, RELEASE_BLEND_SEC,
} from '../../packages/engine/src/animation/narrated-motion.ts';
import { ACTION_DEFS, IDLE_POSE } from '../../packages/engine/src/animation/actions.ts';
import { applyButtonState, applyPropTransform, discLowestPoint, discSignedDistance, discWorldSize, measuredPropTransform } from '../../packages/engine/src/prop-transform.ts';
import type { WorldPlan, WorldState, ActorState, Posture } from '../../packages/narrated/src/world.ts';

export const ADAPTER_SCHEMA = 'blockspark.narrated-engine-adapter/1';
/** body/coin penetration beyond this depth (m) is blocking */
export const PENETRATION_TOLERANCE_M = 0.02;
export const SEATED_WARNING = 'AUTHORED_SEATED_ANIMATION_UNAVAILABLE';
/** forward flinch window before a planned coin contact (s) */
export const BRACE_SEC = 0.45;

/** structural view of the engine scene (Production satisfies it: rigs + props maps) */
export interface EngineScene { rigs: ReadonlyMap<string, Rig>; props: ReadonlyMap<string, { inst: PropInstance }> }
export interface AdapterOptions { /** world prop id -> engine prop instance id */ propInstances?: Record<string, string>; /** world actor id -> engine rig id */ actorRigs?: Record<string, string>; /** record missing entities instead of throwing */ allowMissing?: boolean }

export interface AdapterWarning { code: string; entity: string; message: string }
export interface ActorApplied {
  plannedRoot: Vec3; appliedRoot: Vec3; rootDeviationM: number; yawDeg: number; pitchDeg: number; groundOffsetM: number;
  posture: Posture; poseSource: string; stance: 'l' | 'r' | null; soleL: Vec3; soleR: Vec3; headTop: Vec3; lookTarget: string | null; expression: string;
  gaitDistanceM: number | null; framing: { waist_up_required: boolean }; contacts: string[];
}
export interface PropApplied { visible: boolean; pos: Vec3; scale: number; rotDeg: Vec3; phase: string; measuredPos: Vec3; measuredScale: number; lowestPoint: Vec3 | null; thicknessM: number | null; radiusM: number | null; capDepth?: number; glow?: number }
export interface AdapterDiagnostics {
  schema: typeof ADAPTER_SCHEMA; t: number;
  actors: Record<string, ActorApplied>;
  props: Record<string, PropApplied>;
  poseTransitions: Array<{ actor: string; t: number; from: string; to: string; blendSec: number }>;
  contacts: { coinZapp: boolean; onsetThisFrame: boolean; fallStartedThisFrame: boolean; actorContacts: Record<string, string[]> };
  penetration: { checked: boolean; zappMinGapM: number | null; zappMaxDepthM: number; headInsideCoin: boolean; kiraMinGapM: number | null; toleranceM: number; blocking: boolean };
  footSlipM: Record<string, number>;
  missing: string[];
  warnings: AdapterWarning[];
  blocking: Array<{ code: string; message: string }>;
  /** largest applied transform change since `previous` (m); 0 without previous */
  maxTransformDeltaM: number;
  /** largest |applied delta - planned delta| since `previous` (m): > 1e-6 means something other than the world moved it */
  maxUnplannedDeltaM: number;
  /** true when any transform differs from the pure (plan, snapshot) evaluation, e.g. a camera/shot event reset it */
  transformResetByShot: boolean;
}

export class NarratedAdapterError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(`${code}: ${message}`); this.code = code; }
}

export interface NarratedWorldAdapter {
  initialize(plan: WorldPlan, scene: EngineScene): void;
  applySnapshot(snapshot: WorldState, previous: WorldState | null, scene: EngineScene): AdapterDiagnostics;
  reset(): void;
}

type PlanSeg = WorldPlan['actors'][string]['segs'][number];
type MKind = 'action' | 'rest' | 'turn' | 'gait' | 'jump' | 'fall' | 'prone' | 'seated' | 'layer';
interface MSeg { t0: number; t1: number; kind: MKind; action: string | null; holds: boolean; label: string; plan: PlanSeg | null; blendSec: number }

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
const r6v = (v: readonly number[]): Vec3 => [r6(v[0]), r6(v[1]), r6(v[2])];
const d3 = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const d2 = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[2] - b[2]);
const lerp3 = (a: Vec3, b: Vec3, u: number): Vec3 => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
const idle = (): ActionPose => ({ joints: { ...IDLE_POSE } });
const HEAD_Y = 1.7;

/** the narrated engine-motion adapter */
export class NarratedEngineAdapter implements NarratedWorldAdapter {
  private plan: WorldPlan | null = null;
  private opts: AdapterOptions;
  private segs = new Map<string, MSeg[]>();
  private memoEnd = new Map<string, ActionPose>();
  private warned = new Map<string, AdapterWarning>();
  private missing: string[] = [];
  constructor(opts: AdapterOptions = {}) { this.opts = opts; }

  private rigId(id: string) { return this.opts.actorRigs?.[id] ?? id; }
  private propId(id: string) { return this.opts.propInstances?.[id] ?? id; }

  initialize(plan: WorldPlan, scene: EngineScene): void {
    this.reset();
    if (plan.status !== 'ok') throw new NarratedAdapterError('WORLD_PLAN_UNAVAILABLE', `world plan ${plan.storyboardId} is ${plan.status}: ${plan.errors.map((e) => e.code).join(', ')}`);
    this.plan = plan;
    const missing: string[] = [];
    for (const id of Object.keys(plan.actors)) if (!scene.rigs.has(this.rigId(id))) missing.push(`actor:${id}`);
    for (const id of ['coin', 'button']) if (!scene.props.has(this.propId(id))) missing.push(`prop:${id}`);
    this.missing = missing;
    if (missing.length && !this.opts.allowMissing) throw new NarratedAdapterError('MISSING_ENGINE_ENTITY', `engine scene lacks ${missing.join(', ')}`);
    for (const [id, tr] of Object.entries(plan.actors)) this.segs.set(id, this.expand(id, tr.segs));
    for (const w of plan.warnings) if (w.code === SEATED_WARNING) this.warn(SEATED_WARNING, w.message.split(' ')[0], `${w.message} (engine: closest safe upper-body pose; no seated animation is claimed)`);
  }

  reset(): void { this.plan = null; this.segs.clear(); this.memoEnd.clear(); this.warned.clear(); this.missing = []; this.last = null; }

  private warn(code: string, entity: string, message: string) { const k = `${code}:${entity}`; if (!this.warned.has(k)) this.warned.set(k, { code, entity, message }); }

  /** plan segments -> engine motion segments (phase bookkeeping only; roots always come from the snapshot) */
  private expand(actor: string, segs: PlanSeg[]): MSeg[] {
    const out: MSeg[] = [];
    const push = (s: Omit<MSeg, 'blendSec'> & { blendSec?: number }) => { if (s.t1 > s.t0 + 1e-9) out.push({ blendSec: MIN_BLEND_SEC, ...s }); };
    for (const s of segs) {
      const d = s.t1 - s.t0;
      if (s.kind === 'path') {
        const p = s.path!;
        push({ t0: s.t0, t1: p.tw0, kind: 'turn', action: 'turn_toward', holds: false, label: 'turn_toward', plan: s });
        push({ t0: p.tw0, t1: p.tw1, kind: 'gait', action: 'walk', holds: false, label: 'walk', plan: s, blendSec: Math.min(MIN_BLEND_SEC, 0.4 * (p.tw1 - p.tw0)) });
        push({ t0: p.tw1, t1: s.t1, kind: 'rest', action: null, holds: false, label: 'idle', plan: s, blendSec: RELEASE_BLEND_SEC });
      } else if (s.kind === 'turn') push({ t0: s.t0, t1: s.t1, kind: 'turn', action: 'turn_toward', holds: false, label: 'turn_toward', plan: s });
      else if (s.kind === 'jump') push({ t0: s.t0, t1: s.t1, kind: 'jump', action: 'jump', holds: false, label: 'jump', plan: s, blendSec: 0.1 });
      else if (s.kind === 'fall') push({ t0: s.t0, t1: s.t1, kind: 'fall', action: 'fall_prone', holds: true, label: 'fall_prone', plan: s });
      else if (s.posture === 'prone') push({ t0: s.t0, t1: s.t1, kind: 'prone', action: null, holds: true, label: 'prone', plan: s });
      else if (s.posture === 'implied_seated') push({ t0: s.t0, t1: s.t1, kind: 'seated', action: null, holds: true, label: 'implied_seated_fallback', plan: s });
      else if (!s.action) push({ t0: s.t0, t1: s.t1, kind: 'rest', action: null, holds: false, label: 'rest', plan: s });
      else if (s.action === 'head_shake') push({ t0: s.t0, t1: s.t1, kind: 'layer', action: 'head_shake', holds: false, label: 'warning_head_shake', plan: s });
      else if (hasProceduralAction(s.action)) push({ t0: s.t0, t1: s.t1, kind: 'action', action: s.action, holds: (ACTION_DEFS as Record<string, { holds: boolean } | undefined>)[s.action]?.holds ?? false, label: s.action === 'arms_crossed' ? 'confident_arms_crossed' : s.action === 'victory_pose' ? 'celebrate' : s.action, plan: s, blendSec: blendWindow(s.action, d) });
      else { this.warn('UNSUPPORTED_PROCEDURAL_ACTION', actor, `${actor}: ${s.action} has no procedural pose; look_at used`); push({ t0: s.t0, t1: s.t1, kind: 'action', action: 'look_at', holds: true, label: `look_at(${s.action})`, plan: s }); }
    }
    // after the final planned segment the end posture persists (prone stays prone; nothing stands him up)
    const last = segs[segs.length - 1];
    if (last && Number.isFinite(last.t1)) {
      const k: MKind = last.endPosture === 'prone' ? 'prone' : last.endPosture === 'implied_seated' ? 'seated' : 'rest';
      out.push({ t0: last.t1, t1: Infinity, kind: k, action: null, holds: true, label: k === 'rest' ? 'rest' : k === 'prone' ? 'prone' : 'implied_seated_fallback', plan: null, blendSec: k === 'prone' ? 0 : RELEASE_BLEND_SEC });
    }
    // rest segments following a non-holding action ease back to idle
    for (let k = 1; k < out.length; k++) if (out[k].kind === 'rest' && !out[k - 1].holds) out[k].blendSec = RELEASE_BLEND_SEC;
    return out;
  }

  private segIndex(actor: string, t: number): number {
    const ss = this.segs.get(actor)!;
    let k = -1;
    for (let i = 0; i < ss.length; i++) { if (ss[i].t0 > t + 1e-9) break; k = i; }
    return k;
  }

  private lookPoint(target: string | null, w: WorldState): Vec3 | null {
    const P = this.plan!;
    if (!target) return null;
    if (target === 'button') return [...P.assets.button.pressSurface] as Vec3;
    if (target === 'coin') { const c = w.props.coin; return c?.visible ? [...c.pos] as Vec3 : [...P.assets.button.spawnPoint] as Vec3; }
    if (target === 'classroom_door') { const m = P.assets.marks.classroom_door.pos; return [m[0], HEAD_Y, m[2]]; }
    const a = w.actors[target];
    if (a) return a.posture === 'prone' ? [a.pos[0], 0.3, a.pos[2] + 1.4] : [a.pos[0], a.pos[1] + HEAD_Y, a.pos[2]];
    this.warn('LOOK_TARGET_UNRESOLVED', target, `look target ${target} has no world position (cameras are never look targets for the engine)`);
    return null;
  }

  /** the segment's own pose at t (no blending) */
  private raw(actor: string, k: number, t: number, w: WorldState, rig: Rig): { pose: ActionPose; layers: JointPose[] } {
    const s = this.segs.get(actor)![k], legLen = rig.dims.legLen, seed = this.plan!.seed, lt = t - s.t0, d = s.t1 - s.t0;
    const ctx = { lt, d, t, seed, legLen };
    switch (s.kind) {
      case 'gait': { const p = s.plan!.path!, dist = Math.min(p.len, Math.max(0, (t - p.tw0) * p.speed)); return { pose: gaitPose(dist, p.len, t < p.tw1 ? p.speed : 0, legLen, t, seed), layers: [] }; }
      case 'turn': return { pose: actionPose('turn_toward', { ...ctx, target: undefined }), layers: [] };
      case 'jump': return { pose: jumpPose(lt / Math.max(1e-6, d)), layers: [] };
      case 'fall': case 'prone': return { pose: pronePose(), layers: [] };
      case 'seated': return { pose: neutralUpperBodyPose(), layers: [] };
      case 'action': {
        const target = s.action === 'press_button' ? [...this.plan!.assets.button.pressSurface] as Vec3 : this.lookPoint(w.actors[actor].lookTarget, w) ?? undefined;
        return { pose: actionPose(s.action!, { ...ctx, target }), layers: [] };
      }
      case 'layer': { const base = k > 0 ? this.restOf(actor, k - 1, w, rig) : idle(); return { pose: base, layers: [actionPose(s.action!, ctx).joints] }; }
      case 'rest': return { pose: k > 0 ? this.restOf(actor, k - 1, w, rig) : idle(), layers: [] };
    }
  }
  /** the pose a finished segment leaves behind */
  private restOf(actor: string, k: number, w: WorldState, rig: Rig): ActionPose {
    const s = this.segs.get(actor)![k];
    if (s.kind === 'rest' || s.kind === 'layer') return k > 0 ? this.restOf(actor, k - 1, w, rig) : idle();
    if (!s.holds) return idle();
    return this.raw(actor, k, s.t1 - 1e-6, w, rig).pose;
  }
  /** fully blended pose at t for segment k (continuous across every segment boundary) */
  private full(actor: string, k: number, t: number, w: WorldState, rig: Rig, pitch: number): { pose: ActionPose; layers: JointPose[]; weight: number } {
    const r = this.fullUnbraced(actor, k, t, w, rig, pitch), b = this.braceWeight(actor, t, this.segs.get(actor)![k].kind);
    return b > 0 ? { ...r, pose: braceLayer(r.pose, b) } : r;
  }
  /** the tip patient flinches forward over the last BRACE_SEC before the planned contact (joints only; root untouched) */
  private braceWeight(actor: string, t: number, kind: MKind): number {
    const tip = this.plan!.coin.tip, patient = this.plan!.instances.find((x) => x.contract === 'tip_coin_onto')?.params.patient;
    if (!tip || patient !== actor || kind === 'fall' || kind === 'prone' || t >= tip.tc || t < tip.tc - BRACE_SEC) return 0;
    return smoothstep((t - (tip.tc - BRACE_SEC)) / BRACE_SEC);
  }
  private fullUnbraced(actor: string, k: number, t: number, w: WorldState, rig: Rig, pitch: number): { pose: ActionPose; layers: JointPose[]; weight: number } {
    const s = this.segs.get(actor)![k], cur = this.raw(actor, k, t, w, rig);
    if (k === 0) return { ...cur, weight: 1 };
    const from = this.fromPose(actor, k, w, rig);
    // the fall is driven by the WORLD body pitch (it starts on the contact frame): lead forward, then settle prone
    if (s.kind === 'fall') return { pose: fallPose(from, pitch / 90), layers: [], weight: pitch / 90 };
    const wt = s.kind === 'prone' && this.segs.get(actor)![k - 1].kind === 'fall' ? 1 : transitionWeight(t - s.t0, s.blendSec);
    const layers = cur.layers.map((j) => Object.fromEntries(Object.entries(j).map(([n, e]) => [n, [e![0] * wt, e![1] * wt, e![2] * wt]]))) as JointPose[];
    return { pose: blendPoses(from, cur.pose, wt), layers, weight: wt };
  }
  /** pose at the start of segment k = the blended pose segment k-1 had reached (memoised: a pure function of the plan) */
  private fromPose(actor: string, k: number, w: WorldState, rig: Rig): ActionPose {
    const key = `${actor}#${k}`;
    const m = this.memoEnd.get(key);
    if (m) return m;
    const ss = this.segs.get(actor)!, prev = ss[k - 1], te = ss[k].t0 - 1e-6;
    const pitch = prev.kind === 'fall' ? 90 : prev.kind === 'prone' ? 90 : 0;
    const p = this.full(actor, k - 1, te, w, rig, pitch).pose;
    this.memoEnd.set(key, p);
    return p;
  }

  private lookFor(actor: string, a: ActorState, w: WorldState, gait: boolean): { at: Vec3 | null; weight: number } {
    const looks = this.plan!.actors[actor].looks;
    let i = -1;
    for (let q = 0; q < looks.length; q++) { if (looks[q].t > w.t + 1e-9) break; i = q; }
    const cur = this.lookPoint(a.lookTarget, w), base = gait ? 0.5 : 1;
    if (i < 0 || w.t - looks[i].t >= LOOK_BLEND_SEC || looks[i].v !== a.lookTarget) return { at: cur, weight: cur ? base : 0 };
    const u = smoothstep((w.t - looks[i].t) / LOOK_BLEND_SEC), prev = i > 0 ? this.lookPoint(looks[i - 1].v, w) : null;
    if (cur && prev) return { at: lerp3(prev, cur, u), weight: base };
    if (cur) return { at: cur, weight: base * u };
    return { at: prev, weight: prev ? base * (1 - u) : 0 };
  }

  /** pure evaluation + application of one snapshot (the only function that writes scene transforms) */
  private evaluate(w: WorldState, scene: EngineScene): Omit<AdapterDiagnostics, 'poseTransitions' | 'contacts' | 'footSlipM' | 'maxTransformDeltaM' | 'maxUnplannedDeltaM' | 'transformResetByShot'> {
    if (!this.plan) throw new NarratedAdapterError('ADAPTER_NOT_INITIALIZED', 'initialize(plan, scene) first');
    const actors: Record<string, ActorApplied> = {}, props: Record<string, PropApplied> = {}, missing: string[] = [], blocking: AdapterDiagnostics['blocking'] = [];
    for (const [id, a] of Object.entries(w.actors)) {
      const rig = scene.rigs.get(this.rigId(id));
      if (!rig || !this.segs.has(id)) { missing.push(`actor:${id}`); continue; }
      const k = this.segIndex(id, w.t), s = k >= 0 ? this.segs.get(id)![k] : null;
      const pitch = a.bodyPitchDeg;
      const f = s ? this.full(id, k, w.t, w, rig, pitch) : { pose: idle(), layers: [], weight: 1 };
      // the snapshot posture is authoritative: after prone, nothing but a get-up (none exists) may stand the actor up
      let pose = f.pose, source = s?.label ?? 'idle';
      if (a.posture === 'prone' && s?.kind !== 'prone' && s?.kind !== 'fall') { pose = pronePose(); source = 'prone(forced by world posture)'; }
      const gait = s?.kind === 'gait' && a.posture === 'walking';
      const look = this.lookFor(id, a, w, gait);
      const ground = a.posture === 'falling' || a.posture === 'prone' ? 'all' : 'feet';
      const res = applyMotionFrame(rig, { t: w.t, seed: this.plan.seed, root: [...a.pos] as Vec3, yawDeg: a.yawDeg, pitchDeg: pitch, pose, layers: f.layers, lookAt: look.at, lookWeight: look.weight, idle: pose.still || a.posture === 'prone' ? 0.15 : 1, ground, expression: a.expression });
      if (!res.expressionApplied) this.warn('EXPRESSION_UNAVAILABLE', id, `${id} has no face state ${a.expression}`);
      const seated = a.posture === 'implied_seated';
      if (seated) this.warn(SEATED_WARNING, id, `${id} is implied_seated at ${a.mark ?? 'its mark'}: closest safe upper-body pose used; framing must be waist-up`);
      const p = s?.plan?.path, dist = s?.kind === 'gait' && p ? Math.min(p.len, Math.max(0, (w.t - p.tw0) * p.speed)) : null;
      actors[id] = {
        plannedRoot: r6v(a.pos), appliedRoot: r6v(res.rootWorld), rootDeviationM: r6(d3([res.rootWorld[0], res.rootWorld[1] - res.groundOffset, res.rootWorld[2]], a.pos)), yawDeg: r6(a.yawDeg), pitchDeg: r6(pitch), groundOffsetM: r6(res.groundOffset),
        posture: a.posture, poseSource: source, stance: res.stance ?? null, soleL: r6v(res.soleL), soleR: r6v(res.soleR), headTop: r6v(rig.headTop.worldPos()), lookTarget: a.lookTarget, expression: a.expression,
        gaitDistanceM: dist === null ? null : r6(dist), framing: { waist_up_required: seated }, contacts: [...a.contacts],
      };
    }
    for (const [id, st] of Object.entries(w.props)) {
      const e = scene.props.get(this.propId(id));
      if (!e) { missing.push(`prop:${id}`); continue; }
      applyPropTransform(e.inst, { pos: st.pos, scale: st.scale, rotDeg: st.rotDeg, visible: st.visible });
      const disc = e.inst.manifest.collision.shape === 'cylinder';
      if (id === 'button') applyButtonState(e.inst, st.capDepth ?? 0, st.glow ?? 0);
      const m = measuredPropTransform(e.inst), sz = disc ? discWorldSize(e.inst) : null;
      props[id] = { visible: st.visible, pos: r6v(st.pos), scale: r6(st.scale), rotDeg: r6v(st.rotDeg), phase: st.phase, measuredPos: r6v(m.pos), measuredScale: r6(m.scale), lowestPoint: disc && st.visible ? r6v(discLowestPoint(e.inst)) : null, thicknessM: sz ? r6(sz.thickness) : null, radiusM: sz ? r6(sz.radius) : null, ...(id === 'button' ? { capDepth: st.capDepth ?? 0, glow: st.glow ?? 0 } : {}) };
      if (sz && Math.abs(sz.scaleY - sz.scaleX) > 1e-6 * sz.scaleX) blocking.push({ code: 'NON_UNIFORM_PROP_SCALE', message: `${id} thickness scale ${sz.scaleY} != radial ${sz.scaleX}` });
    }
    // deterministic body / coin penetration on the posed rigs
    const pen: AdapterDiagnostics['penetration'] = { checked: false, zappMinGapM: null, zappMaxDepthM: 0, headInsideCoin: false, kiraMinGapM: null, toleranceM: PENETRATION_TOLERANCE_M, blocking: false };
    const coin = scene.props.get(this.propId('coin'));
    if (coin && w.props.coin?.visible && w.props.coin.scale > 1.01) {
      pen.checked = true;
      for (const id of Object.keys(actors)) {
        const pts = bodySamplePoints(scene.rigs.get(this.rigId(id))!);
        let gap = Infinity;
        for (const q of pts) { const sd = discSignedDistance(coin.inst, q.p); gap = Math.min(gap, sd); if (id === 'zapp' && q.head && sd < 0) pen.headInsideCoin = true; }
        if (id === 'zapp') { pen.zappMinGapM = r6(gap); pen.zappMaxDepthM = r6(Math.max(0, -gap)); }
        if (id === 'kira') pen.kiraMinGapM = r6(gap);
      }
      if (pen.zappMaxDepthM > PENETRATION_TOLERANCE_M || pen.headInsideCoin) { pen.blocking = true; blocking.push({ code: 'COIN_BODY_PENETRATION', message: `zapp penetrates the coin by ${pen.zappMaxDepthM} m (tolerance ${PENETRATION_TOLERANCE_M})${pen.headInsideCoin ? '; head inside the coin' : ''}` }); }
      if ((pen.kiraMinGapM ?? Infinity) < 0) blocking.push({ code: 'KIRA_IN_HAZARD', message: `kira intersects the coin by ${-pen.kiraMinGapM!} m` });
    }
    const allMissing = [...new Set([...this.missing, ...missing])].sort();
    for (const m of allMissing) blocking.push({ code: 'MISSING_ENGINE_ENTITY', message: `${m} has no engine entity` });
    return { schema: ADAPTER_SCHEMA, t: w.t, actors, props, penetration: pen, missing: allMissing, warnings: [...this.warned.values()].sort((a, b) => (a.code + a.entity < b.code + b.entity ? -1 : 1)), blocking };
  }

  private last: { t: number; rec: ReturnType<NarratedEngineAdapter['evaluate']> } | null = null;

  applySnapshot(snapshot: WorldState, previous: WorldState | null, scene: EngineScene): AdapterDiagnostics {
    if (this.missing.length && !this.opts.allowMissing) throw new NarratedAdapterError('MISSING_ENGINE_ENTITY', this.missing.join(', '));
    // any mutation of the scene since the last application (a camera/shot event touching actors or props) is detected
    // here and then overwritten: the snapshot, never the scene's previous state, decides every transform
    let reset = false;
    if (this.last) {
      for (const [id, a] of Object.entries(this.last.rec.actors)) { const rig = scene.rigs.get(this.rigId(id)); if (rig && d3(rig.root.pos, a.appliedRoot) > 1e-5) reset = true; }
      for (const [id, q] of Object.entries(this.last.rec.props)) { const e = scene.props.get(this.propId(id)); if (e && (e.inst.root.visible !== q.visible || d3(measuredPropTransform(e.inst).pos, q.measuredPos) > 1e-4 * Math.max(1, q.scale) || Math.abs(e.inst.root.scl[1] - e.inst.root.scl[0]) > 1e-9)) reset = true; }
    }
    const prevRec = previous ? (this.last && this.last.t === previous.t ? this.last.rec : this.evaluate(previous, scene)) : null;
    const rec = this.evaluate(snapshot, scene);
    this.last = { t: snapshot.t, rec };
    const poseTransitions: AdapterDiagnostics['poseTransitions'] = [], footSlipM: Record<string, number> = {};
    let maxDelta = 0, maxUnplanned = 0;
    if (previous && prevRec) {
      for (const [id, a] of Object.entries(rec.actors)) {
        const p = prevRec.actors[id];
        if (!p) continue;
        const dApplied = d2(a.appliedRoot, p.appliedRoot), dPlanned = d2(a.plannedRoot, p.plannedRoot);
        maxDelta = Math.max(maxDelta, d3(a.appliedRoot, p.appliedRoot));
        maxUnplanned = Math.max(maxUnplanned, Math.abs(dApplied - dPlanned));
        const ss = this.segs.get(id)!;
        for (const s of ss) if (s.t0 > previous.t + 1e-9 && s.t0 <= snapshot.t + 1e-9) { const k = ss.indexOf(s); poseTransitions.push({ actor: id, t: r6(s.t0), from: k > 0 ? ss[k - 1].label : 'start', to: s.label, blendSec: s.kind === 'fall' ? r6(s.t1 - s.t0) : s.blendSec }); }
        // foot slip: the planted (stance) sole must not slide between consecutive walking frames
        if (a.posture === 'walking' && p.posture === 'walking' && a.stance && a.stance === p.stance) { const k = a.stance === 'l' ? 'soleL' : 'soleR'; footSlipM[id] = r6(d2(a[k], p[k])); }
        else footSlipM[id] = 0;
      }
      for (const [id, q] of Object.entries(rec.props)) { const p = prevRec.props[id]; if (p && q.visible && p.visible) { maxDelta = Math.max(maxDelta, d3(q.measuredPos, p.measuredPos)); maxUnplanned = Math.max(maxUnplanned, Math.abs(d3(q.measuredPos, p.measuredPos) - d3(q.pos, p.pos))); } }
    }
    const z = snapshot.actors.zapp, zp = previous?.actors.zapp;
    const coinZapp = !!z?.contacts.includes('coin'), was = !!zp?.contacts.includes('coin');
    const contacts: AdapterDiagnostics['contacts'] = {
      coinZapp, onsetThisFrame: !!previous && coinZapp && !was, fallStartedThisFrame: !!previous && z?.posture === 'falling' && zp?.posture !== 'falling',
      actorContacts: Object.fromEntries(Object.entries(snapshot.actors).map(([id, a]) => [id, [...a.contacts]])),
    };
    if (contacts.onsetThisFrame && z?.posture !== 'falling') rec.blocking.push({ code: 'FALL_NOT_AT_CONTACT', message: `coin contact at ${snapshot.t} but zapp is ${z?.posture}` });
    return { ...rec, poseTransitions, contacts, footSlipM, maxTransformDeltaM: r6(maxDelta), maxUnplannedDeltaM: r6(maxUnplanned), transformResetByShot: reset || maxUnplanned > 1e-5 };
  }
}
