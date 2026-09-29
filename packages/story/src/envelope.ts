// Profile-aware motion envelopes, sampled from the REAL engine (headless) under the episode's DECLARED motion profile.
// Nothing here is tuned per episode: every margin is derived from asset geometry and sampling resolution (constants
// below; derivation in docs/story/CLEARANCE_AND_FRAMING.md).
import type { Episode } from '../../schema/src/episode.ts';
import { LOCOMOTION_ACTIONS } from '../../schema/src/episode.ts';
import type { Rig } from '../../engine/src/build.ts';
import type { HeadlessEngine } from '../../engine/src/headless.ts';
import { m4Invert, m4TransformPoint, type Mat4, type Vec3 } from '../../engine/src/math.ts';
import { ACTION_DEFS } from '../../engine/src/animation/actions.ts';

/** actions with a contact point (the engine's IK contacts) */
const CONTACT_ACTIONS = new Set(Object.entries(ACTION_DEFS).filter(([, d]) => d?.contactU !== undefined).map(([k]) => k));

/** padding constants (derivation: docs/story/CLEARANCE_AND_FRAMING.md) */
export const PAD = {
  /** limb capsules use the half-WIDTH of each limb box cross-section (the box faces) plus this margin: 2 mm for the gap
   *  between capsule samples along a segment (3 cm spacing) + 3 mm numeric margin. Box edges at 45 deg can protrude up to
   *  (sqrt2 - 1) x half-width (<= 3.1 cm) beyond the capsule: documented residual, see CLEARANCE_AND_FRAMING.md */
  limbMargin: 0.005,
  /** enforcement: a limb capsule (half-width + margin) may enter a moving prop by at most this much, i.e. the limb box faces
   *  by <= 1.0 cm: the same 1 cm tolerance the render QA applies to hand points, now applied to the complete limb */
  limbTolerance: 0.015,
  /** contact actions: the acting arms are exempt vs the target family from start - blend to end + blend */
  contactBlend: 0.3,
  /** spacing of capsule samples along a limb segment (m) */
  limbSpacing: 0.03,
  /** substeps per video frame inside motion windows (4 x 30 fps = 120 Hz; path between substeps swept at <= 1 cm) */
  substeps: 4,
  /** body box corners (head/torso/knee/sole probes are exact mesh corners): margin beyond the probe (QA: 3 cm inside) */
  bodyMargin: 0.02,
  /** actor-actor root distance: QA hard limit 0.45 m + 0.10 m (two torso half-depths of sway / onset pivot) */
  actorMin: 0.55,
  /** a moving prop scaled at least this much (the escalated object) is enforced even between its motion events */
  largeScale: 3,
  /** a moving prop's bounding box may not leave the environment bounds (walls, ceiling line) by more than this (m) */
  boundsTolerance: 0,
} as const;

export interface LimbSeg { name: string; a: () => Vec3; b: () => Vec3; r: number; leg: boolean }
/** arm + leg segments of a rig as capsules; radius = half-WIDTH of the limb box cross-section + margin (box faces exact,
 *  45-degree box edges may protrude by (sqrt2 - 1) x half-width: documented residual, CLEARANCE_AND_FRAMING.md) */
export function limbSegments(rig: Rig): LimbSeg[] {
  const b = rig.manifest.body, d = rig.dims;
  const aw = b.armWidth, lw = b.legWidth, half = 0.5;
  const segs: LimbSeg[] = [];
  for (const s of ['l', 'r'] as const) {
    const sh = rig.joints[`shoulder_${s}`], el = rig.joints[`elbow_${s}`], hand = s === 'l' ? rig.hand_l : rig.hand_r;
    const hp = rig.joints[`hip_${s}`], kn = rig.joints[`knee_${s}`], sole = s === 'l' ? rig.sole_l : rig.sole_r;
    // hand box extends ~1 cm past the hand node (build.ts): extend the forearm capsule end accordingly
    const handEnd = () => { const e = el.worldPos(), h = hand.worldPos(); const L = Math.hypot(h[0] - e[0], h[1] - e[1], h[2] - e[2]) || 1; const k = (L + 0.01) / L; return [e[0] + (h[0] - e[0]) * k, e[1] + (h[1] - e[1]) * k, e[2] + (h[2] - e[2]) * k] as Vec3; };
    segs.push({ name: `upperarm_${s}`, a: () => sh.worldPos() as Vec3, b: () => el.worldPos() as Vec3, r: aw * half + PAD.limbMargin, leg: false });
    segs.push({ name: `forearm_${s}`, a: () => el.worldPos() as Vec3, b: handEnd, r: aw * 0.96 * half + PAD.limbMargin, leg: false });
    segs.push({ name: `thigh_${s}`, a: () => hp.worldPos() as Vec3, b: () => kn.worldPos() as Vec3, r: lw * 1.05 * half + PAD.limbMargin, leg: true });
    segs.push({ name: `shin_${s}`, a: () => kn.worldPos() as Vec3, b: () => sole.worldPos() as Vec3, r: lw * half + PAD.limbMargin, leg: true });
  }
  void d;
  return segs;
}

interface PartBox { inst: string; world: Mat4; inv: Mat4; half: Vec3; scale: number; shape: string }
/** exact part geometry at the current evaluated time: box parts as boxes, cylinder parts as cylinders (axis = local y),
 *  sphere parts as spheres; planes (labels/decals) are skipped. World -> part-local inverse cached per sample. */
function partBoxes(e: HeadlessEngine, t: number): PartBox[] {
  const out: PartBox[] = [];
  for (const [inst, p] of e.prod.props) {
    if (!p.track.stateAt(t).visible) continue;
    const shapes = new Map(p.inst.manifest.parts.map((x) => [x.id, x.shape ?? 'box']));
    for (const [pid, n] of Object.entries(p.inst.parts)) {
      const shape = shapes.get(pid) ?? 'box';
      if (!n.geometry || n.decal || shape === 'plane') continue;
      const w = n.world, s = Math.hypot(w[0], w[1], w[2]);
      if (s < 0.02) continue;
      out.push({ inst, world: w, inv: m4Invert(w), half: n.geometry.half as Vec3, scale: s, shape });
    }
  }
  return out;
}
/**
 * how far (m) a part's world AABB (exact shape: box, cylinder r/h/r, sphere) extends through the room's walls or ceiling
 * line (<= 0 inside). The floor is not a bound (props rest on it) and the audience side (+z) is open by design.
 */
function boundsExcess(b: PartBox, room: { min: number[]; max: number[] }): number {
  const w = b.world;
  // local half extents of the shape's bounding box; cylinder axis = local y, radius = half[0]
  const h: Vec3 = b.shape === 'cylinder' ? [b.half[0], b.half[1], b.half[0]] : b.shape === 'sphere' ? [b.half[0], b.half[0], b.half[0]] : b.half;
  // column-major world matrix (includes the part scale): world extent along axis i = sum_j |W[j][i]| * h[j]
  const ext = (i: number) => Math.abs(w[i]) * h[0] + Math.abs(w[4 + i]) * h[1] + Math.abs(w[8 + i]) * h[2];
  const lo = (i: number) => w[12 + i] - ext(i), hi = (i: number) => w[12 + i] + ext(i);
  return Math.max(room.min[0] - lo(0), hi(0) - room.max[0], hi(1) - room.max[1], room.min[2] - lo(2));
}
/** signed depth (m) of a point inside a part (> 0 inside), world units */
const boxDepth = (b: PartBox, p: Vec3) => {
  const l = m4TransformPoint(b.inv, p);
  if (b.shape === 'cylinder') return Math.min(b.half[0] - Math.hypot(l[0], l[2]), b.half[1] - Math.abs(l[1])) * b.scale;
  if (b.shape === 'sphere') return (b.half[0] - Math.hypot(l[0], l[1], l[2])) * b.scale;
  return Math.min(b.half[0] - Math.abs(l[0]), b.half[1] - Math.abs(l[1]), b.half[2] - Math.abs(l[2])) * b.scale;
};

/**
 * enforced = the generator must clear it (the Run 3 mechanism classes): any limb/body part vs a MOVING prop (hop, grow,
 * wobble, tip, slide, stand-up, spawn) and actor-actor spacing. Near-contacts with STATIC furniture/devices the actor is
 * staged at (desk, button housing) are reported (enforced=false): they are profile-independent, below the render QA
 * tolerances and present in the hand-authored, visually reviewed PoC (CLEARANCE_AND_FRAMING.md).
 */
/** PROP_BOUNDS: a moving prop leaves the environment's room bounds (walls, ceiling); `actor` is the prop instance */
export interface ClearanceIssue { code: 'LIMB_CLEARANCE' | 'BODY_CLEARANCE' | 'ACTOR_CLEARANCE' | 'PROP_BOUNDS'; enforced: boolean; t: number; actor: string; what: string; limb: string; depth: number; window: MotionWindow; message: string }
export interface MotionWindow { t0: number; t1: number; kind: 'onset' | 'arrival' | 'dive' | 'prop_motion' | 'contact'; actor?: string; action?: string; start?: number; prop?: string; event?: string }

/** where motion can bring limbs/props together: locomotion onsets/arrivals/dives + prop motion (hop, grow, stand, wobble, tip) */
export function motionWindows(ep: Episode): MotionWindow[] {
  const D = ep.episode.duration, out: MotionWindow[] = [];
  for (const a of ep.actions) {
    if (!LOCOMOTION_ACTIONS.includes(a.action)) continue;
    const e = a.start + a.duration;
    if (a.action === 'dive_prone') { out.push({ t0: Math.max(0, a.start - 0.35), t1: Math.min(D, e + 0.4), kind: 'dive', actor: a.actor, action: a.action, start: a.start }); continue; }
    out.push({ t0: Math.max(0, a.start - 0.35), t1: Math.min(D, a.start + Math.min(a.duration, 1.0)), kind: 'onset', actor: a.actor, action: a.action, start: a.start });
    out.push({ t0: Math.max(0, e - 0.3), t1: Math.min(D, e + 0.4), kind: 'arrival', actor: a.actor, action: a.action, start: a.start });
  }
  for (const pe of ep.propEvents) if (['hop_to', 'grow', 'stand_up', 'wobble', 'tip_over', 'spawn'].includes(pe.event)) out.push({ t0: Math.max(0, pe.start - 0.1), t1: Math.min(D, pe.start + pe.duration + 0.25), kind: 'prop_motion', prop: pe.prop, event: pe.event, start: pe.start });
  return out;
}

/**
 * Padded limb-envelope + body + actor clearance of the episode as animated under its declared profile.
 * Samples every motion window at PAD.substeps per frame and the rest of the episode at every frame.
 * Exempt: intended contacts (the actor's arms vs the contact target prop and its parent/children during that action),
 * the reversal victim vs the tipping prop after its tip_over starts (intended cartoon flattening).
 */
export function measureClearance(e: HeadlessEngine, opts: { windows?: MotionWindow[]; wholeEpisode?: boolean } = {}): ClearanceIssue[] {
  const ep = e.prod.ep, fps = ep.episode.fps, D = ep.episode.duration;
  const wins = opts.windows ?? motionWindows(ep);
  const dt = 1 / (fps * PAD.substeps);
  // sample times: union of window samples (120 Hz) + every frame (30 Hz) for the whole episode
  const times = new Set<number>();
  for (const w of wins) for (let k = Math.ceil(w.t0 / dt - 1e-9); k * dt <= w.t1 + 1e-9; k++) times.add(+(k * dt).toFixed(6));
  if (opts.wholeEpisode !== false) for (let i = 0; i < Math.round(D * fps); i++) times.add(+(i / fps).toFixed(6));
  const sorted = [...times].sort((a, b) => a - b);
  const tip = ep.propEvents.find((x) => x.event === 'tip_over');
  const victim = ep.actions.find((a) => a.action === 'dive_prone')?.actor;
  const parentOf = new Map(ep.props.map((p) => [p.instance, p.parent]));
  const related = (inst: string) => { const s = new Set([inst]); const par = parentOf.get(inst); if (par) s.add(par); for (const [k, v] of parentOf) if (v === inst) s.add(k); return s; };
  const env = e.prod.env.colliders.filter((c) => c.id !== 'floor');
  const segs = new Map([...e.prod.rigs].map(([id, rig]) => [id, limbSegments(rig)]));
  // Legs and feet are checked against MOVING props only; against static furniture the actor stands at (desk), shoe/leg
  // contacts up to the QA tolerance (3 cm) are normal staging and stay covered by the existing bodyIssues QA.
  const legProbe = (name: string) => /probe:(toe|heel|knee)_/.test(name);
  const worst = new Map<string, ClearanceIssue>();
  /** props with a motion event: hop, grow, wobble, tip, slide, spawn, stand-up (the escalation prop) */
  const MOTION = ['hop_to', 'grow', 'wobble', 'tip_over', 'slide', 'spawn', 'stand_up'];
  const moving = new Set(ep.propEvents.filter((x) => MOTION.includes(x.event)).map((x) => x.prop));
  /** the prop is in motion at t (event active, plus 0.25 s of settle/overshoot) */
  const activeMotion = (inst: string, t: number) => ep.propEvents.some((x) => x.prop === inst && MOTION.includes(x.event) && t >= x.start - 1e-9 && t <= x.start + x.duration + 0.25);
  // attribute a contact to its cause: for a moving prop, the prop event ACTIVE at t (hop before grow before others); else the
  // actor's own locomotion window containing t; else a static 'contact'
  const PRI: Record<string, number> = { hop_to: 0, tip_over: 1, grow: 2, wobble: 3, slide: 4, stand_up: 5, spawn: 6 };
  const windowAt = (t: number, actor: string, what = ''): MotionWindow => {
    const prop = what.startsWith('prop:') ? what.slice(5) : '';
    if (prop && moving.has(prop)) {
      const act = wins.filter((w) => w.kind === 'prop_motion' && w.prop === prop && t >= (w.start ?? w.t0) - 1e-9 && t <= w.t1 + 1e-9).sort((a, b) => (PRI[a.event!] ?? 9) - (PRI[b.event!] ?? 9));
      const own = wins.filter((w) => w.actor === actor && t >= w.t0 - 1e-9 && t <= w.t1 + 1e-9);
      const onset = own.find((w) => w.kind === 'onset');
      if (onset) return onset; // an onset envelope is the actor's to fix (pre-align)
      if (act.length) return act[0];
      if (own.length) return own[0];
    }
    return wins.find((w) => w.actor === actor && t >= w.t0 - 1e-9 && t <= w.t1 + 1e-9) ?? { t0: t, t1: t, kind: 'contact' };
  };
  const put = (i0: Omit<ClearanceIssue, 'message' | 'enforced'>) => {
    const inst = i0.what.replace(/^prop:/, '');
    const live = moving.has(inst) && (activeMotion(inst, i0.t) || (e.prod.props.get(inst)?.track.stateAt(i0.t).scale ?? 0) >= PAD.largeScale);
    const iss = { ...i0, enforced: i0.code === 'ACTOR_CLEARANCE' || i0.code === 'PROP_BOUNDS' || (live && (i0.code !== 'LIMB_CLEARANCE' || i0.depth > PAD.limbTolerance)) };
    const k = `${iss.code}:${iss.actor}:${iss.what}:${iss.window.kind}:${iss.window.action ?? iss.window.event ?? ''}@${iss.window.start ?? ''}`;
    const cur = worst.get(k);
    const where = `${iss.window.kind}${iss.window.action ? ' of ' + iss.window.action + '@' + iss.window.start : iss.window.event ? ' of ' + iss.window.prop + '.' + iss.window.event + '@' + iss.window.start : ''}`;
    const text = iss.code === 'PROP_BOUNDS' ? `${iss.actor} leaves the room bounds by ${(iss.depth * 100).toFixed(1)} cm at ${iss.t.toFixed(3)}s (${where})` : `${iss.actor} ${iss.limb} ${(iss.depth * 100).toFixed(1)} cm into ${iss.what} at ${iss.t.toFixed(3)}s (${where}; padded)`;
    if (!cur || iss.depth > cur.depth) worst.set(k, { ...iss, message: `${iss.enforced ? '' : '[reported] '}${text}` });
  };
  const room = e.prod.env.manifest.bounds;
  for (const t of sorted) {
    e.prod.evaluate(t);
    e.prod.root.updateWorld(); // evaluate() updates rigs; prop part matrices need the scene-graph pass (as bodyIssues does)
    const boxes = partBoxes(e, t);
    // moving props stay inside the room (walls, ceiling line): world AABB of each part's exact shape vs the manifest bounds
    for (const bx of boxes) {
      if (!moving.has(bx.inst) || !activeMotion(bx.inst, t)) continue;
      const out = boundsExcess(bx, room);
      if (out > PAD.boundsTolerance) put({ code: 'PROP_BOUNDS', t, actor: bx.inst, what: 'env:room_bounds', limb: 'part', depth: out, window: windowAt(t, '', `prop:${bx.inst}`) });
    }
    const ids = [...e.prod.rigs.keys()];
    for (const id of ids) {
      // intended contact (same rule as the engine's handPenetrations): only an arm that is under IK this frame, and only
      // against the target prop of the actor's current action (plus its parent/children, e.g. button on desk)
      // intended contact: during a contact action (press, facepalm, pick-up, put-down: actions with a contact point) and
      // its blend in/out, the actor's ARMS are exempt against the action's target prop and its parent/children
      const contactTargets = new Set<string>();
      for (const a of ep.actions) if (a.actor === id && a.target && CONTACT_ACTIONS.has(a.action) && t >= a.start - PAD.contactBlend && t < a.start + a.duration + PAD.contactBlend) for (const x of related(a.target.split('.')[0])) contactTargets.add(x);
      for (const sp of ep.propEvents) if (sp.event === 'spawn' && t >= sp.start && t <= sp.start + sp.duration) {
        const src = typeof sp.params?.from === 'string' ? sp.params.from.split('.')[0] : undefined;
        if (src && ep.actions.some((a) => a.actor === id && a.action === 'press_button' && a.target?.split('.')[0] === src && a.start <= sp.start && sp.start - a.start < a.duration + 0.6)) contactTargets.add(sp.prop);
      }
      const armOf = (limb: string) => /^(upperarm|forearm)_[lr]$/.test(limb);
      const skip = (inst: string, limb: string) => (armOf(limb) && contactTargets.has(inst)) || (!!tip && id === victim && inst === tip.prop && t >= tip.start);
      // limbs: capsule samples vs part-accurate prop boxes and environment colliders
      for (const sg of segs.get(id)!) {
        const a = sg.a(), b = sg.b();
        const L = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
        const n = Math.max(1, Math.ceil(L / PAD.limbSpacing));
        for (let j = 0; j <= n; j++) {
          const q: Vec3 = [a[0] + (b[0] - a[0]) * (j / n), a[1] + (b[1] - a[1]) * (j / n), a[2] + (b[2] - a[2]) * (j / n)];
          for (const bx of boxes) {
            if (skip(bx.inst, sg.name) || (sg.leg && !moving.has(bx.inst))) continue;
            const d = boxDepth(bx, q) + sg.r;
            if (d > 0) put({ code: 'LIMB_CLEARANCE', t, actor: id, what: `prop:${bx.inst}`, limb: sg.name, depth: d, window: windowAt(t, id, `prop:${bx.inst}`) });
          }
          for (const c of env) {
            if (sg.leg) continue;
            const d = Math.min(q[0] - c.min[0], c.max[0] - q[0], q[1] - c.min[1], c.max[1] - q[1], q[2] - c.min[2], c.max[2] - q[2]) + sg.r;
            if (d > 0) put({ code: 'LIMB_CLEARANCE', t, actor: id, what: `env:${c.id}`, limb: sg.name, depth: d, window: windowAt(t, id) });
          }
        }
      }
      // body box corners (head, torso, knees, soles) vs part-accurate prop boxes
      for (const p of e.prod.rigs.get(id)!.probes) {
        if (p.name.startsWith('hand_')) continue;
        const w = p.worldPos() as Vec3;
        for (const bx of boxes) {
          if (legProbe(p.name) && !moving.has(bx.inst)) continue;
          if (!!tip && id === victim && bx.inst === tip.prop && t >= tip.start) continue;
          const d = boxDepth(bx, w) + PAD.bodyMargin;
          if (d > 0) put({ code: 'BODY_CLEARANCE', t, actor: id, what: `prop:${bx.inst}`, limb: p.name.replace('probe:', ''), depth: d, window: windowAt(t, id, `prop:${bx.inst}`) });
        }
      }
    }
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const a = e.prod.rigs.get(ids[i])!.root.worldPos(), b = e.prod.rigs.get(ids[j])!.root.worldPos();
      const d = PAD.actorMin - Math.hypot(a[0] - b[0], a[2] - b[2]);
      if (d > 0) put({ code: 'ACTOR_CLEARANCE', t, actor: ids[i], what: `actor:${ids[j]}`, limb: 'root', depth: d, window: windowAt(t, ids[i]) });
    }
  }
  return [...worst.values()].sort((a, b) => a.t - b.t || (a.actor < b.actor ? -1 : a.actor > b.actor ? 1 : 0));
}
