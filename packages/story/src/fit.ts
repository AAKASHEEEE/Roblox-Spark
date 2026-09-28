// Profile-aware fit pass (between Stage F compile and Stage G validation). The compiled episode is evaluated with the
// REAL engine, headless, under its DECLARED motion profile, and two things are fitted from sampled animation:
//   1. staging clearance: complete limb + body + locomotion envelopes vs moving props and other actors
//      (envelope.ts); remedies are generic knobs: pre-align heading before a locomotion move, raise the leap arc;
//   2. camera framing over the COMPLETE shot: face feature bounds (head yaw/pitch, recoil), emote bounds (expression
//      beats), subject action-safe placement, face readability, camera-to-prop clearance, hard shot QA.
// Every decision is a knob of compileEpisode (FitKnobs), so compile(req, idea, plan, staging, registry, knobs) remains
// a pure function and the record replays byte-identically. Nothing is keyed to episodes; every threshold is derived
// in docs/story/CLEARANCE_AND_FRAMING.md. What cannot be fitted becomes a repair constraint (never silently dropped).
import type { Episode, EpisodeShot } from '../../schema/src/episode.ts';
import type { Library } from '../../engine/src/production.ts';
import { headlessEngine, type HeadlessEngine } from '../../engine/src/headless.ts';
import { dot, m4TransformPoint, norm, sub, type Vec3 } from '../../engine/src/math.ts';
import { applyShake, solveShot } from '../../engine/src/camera.ts';
import { evalVfx } from '../../engine/src/vfx.ts';
import { ACTION_DEFS } from '../../engine/src/animation/actions.ts';
import { DEFAULT_HOP_HEIGHT, HELD_REACTIONS, TAKEOFF_HOLD, type CompileErr, type CompileOk, type FitKnobs } from './compile.ts';
import { measureClearance, type ClearanceIssue } from './envelope.ts';
import type { RepairConstraint } from './schemas.ts';

/** framing thresholds (derivation: docs/story/CLEARANCE_AND_FRAMING.md) */
export const FRAME = {
  /** face feature region (eyes, brows, mouth) must stay this far inside the frame edge (QA: face centre inside 0.02) */
  edge: 0.03,
  /** subject centre: action-safe box shrunk by this (QA soft check uses the box itself) */
  safePad: 0.01,
  /** face readability: cos(angle between face normal and direction to camera); QA flags < 0.15 */
  faceDot: 0.2,
  /** QA-equivalent readability and soft-issue tolerance (pipeline accepts soft issues on < 34 % of a shot's frames) */
  qaFaceDot: 0.15, qaSoftFraction: 0.34,
  /** camera distance outside any visible prop surface (QA flags within 0.05 m) */
  cameraProp: 0.15,
  /** emote billboard centre inside the frame by this margin */
  emoteEdge: 0.02,
  /** maximum candidates evaluated per shot */
  maxCandidates: 240,
} as const;
/** leap arc heights tried by the clearance fit (m); 1.5 = the template default */
export const HOP_LADDER = [DEFAULT_HOP_HEIGHT, 1.9, 2.3, 2.8, 3.4] as const;

export interface FitReport {
  profile: string;
  knobs: FitKnobs;
  iterations: number;
  decisions: string[];
  /** reported, not enforced (static-furniture near contacts, framing QA-acceptable but below the padded target) */
  warnings: string[];
  residual: RepairConstraint[];
  clearance: { enforced: number; reported: number };
  framing: Array<{ shot: string; preset: string; fitted: Record<string, number | boolean> | null; ok: boolean; qaOk: boolean; worst: string }>;
  ms: number;
}

type Compile = (knobs?: FitKnobs) => CompileOk | CompileErr;
const FACE_PRESETS = new Set(['frontal_medium', 'reaction_punch_in', 'two_shot']);
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
/** replace the knob set in place (a removed knob must disappear, which Object.assign would not do) */
const setKnobs = (dst: FitKnobs, src: FitKnobs) => { for (const k of Object.keys(dst)) delete (dst as unknown as Record<string, unknown>)[k]; Object.assign(dst, clone(src)); };

export function fitCompile(compile: Compile, lib: Library): { compiled: CompileOk | CompileErr; report: FitReport | null } {
  const t0 = performance.now();
  const knobs: FitKnobs = { preAlign: [], shots: {} };
  let c = compile(clone(knobs));
  if (!c.ok) return { compiled: c, report: null };
  const report: FitReport = { profile: c.episode.render.motionProfile, knobs, iterations: 0, decisions: [], warnings: [], residual: [], clearance: { enforced: 0, reported: 0 }, framing: [], ms: 0 };
  const beatAt = (ep: Episode, t: number) => ep.beats.find((b) => t >= b.start - 1e-9 && t < b.end)?.id ?? ep.beats[ep.beats.length - 1].id;

  // ---------- 1. clearance ----------
  // remedies, each generic and derived from the sampled contact: pre-align the heading before a locomotion move whose
  // ONSET envelope collides; raise the leap arc when the moving prop's hop collides; delay the later-starting move of two
  // actors that come closer than PAD.actorMin. A remedy that makes the plan uncompilable (needs more time than the beat
  // has) is withdrawn and the compiler's own constraint (e.g. a longer beat) is handed to the repair loop.
  let issues: ClearanceIssue[] = [];
  let hopCap: number = HOP_LADDER[HOP_LADDER.length - 1];
  const withdrawn = new Set<string>();
  const timingConstraints: RepairConstraint[] = [];
  let measured: CompileOk | null = null;
  for (let it = 0; it < 12; it++) {
    report.iterations = it + 1;
    issues = measureClearance(headlessEngine(c.episode, lib, 270, 480)); measured = c;
    const proposal = clone(knobs);
    const applied: string[] = [];
    // a raised leap arc that leaves the room (walls, ceiling line) steps back one rung and caps the ladder there; handled
    // before the collision remedies so the same round never raises it again (the remaining collision goes to repair)
    const oob = issues.find((x) => x.enforced && x.code === 'PROP_BOUNDS' && x.window.event === 'hop_to');
    if (oob && (proposal.hopHeight ?? DEFAULT_HOP_HEIGHT) > DEFAULT_HOP_HEIGHT + 1e-9) {
      const cur = proposal.hopHeight!, back = [...HOP_LADDER].reverse().find((h) => h < cur - 1e-9) ?? DEFAULT_HOP_HEIGHT;
      hopCap = back;
      if (back === DEFAULT_HOP_HEIGHT) delete proposal.hopHeight; else proposal.hopHeight = back;
      applied.push(`hop:${back}`); report.decisions.push(`leap arc ${cur} -> ${back} m (arc capped by the room): ${oob.message}`);
    }
    for (const i of issues.filter((x) => x.enforced && x.code !== 'PROP_BOUNDS')) {
      const w = i.window;
      if ((i.code === 'LIMB_CLEARANCE' || i.code === 'BODY_CLEARANCE') && w.kind === 'onset' && w.actor === i.actor) {
        const mv = c.moves.find((m) => m.actor === i.actor && Math.abs(m.start - (w.start ?? -1)) < 1e-6);
        const id = mv ? `pre:${mv.key}` : '';
        if (mv && mv.kind !== 'dive_prone' && !proposal.preAlign.includes(mv.key) && !withdrawn.has(id)) { proposal.preAlign.push(mv.key); applied.push(id); report.decisions.push(`pre-align ${mv.key}: ${i.message}`); }
      } else if ((i.code === 'LIMB_CLEARANCE' || i.code === 'BODY_CLEARANCE') && w.kind === 'prop_motion' && w.event === 'hop_to') {
        // (a) the actor stands idle at takeoff right after a held reaction (recoil/cower): keep that reaction through the
        //     takeoff; the sampled reaction pose is re-checked next round. (b) otherwise raise the arc, capped by the room.
        const hopStart = w.start ?? i.t;
        const prev = c.episode.actions.filter((a) => a.actor === i.actor && a.start < hopStart - 1e-6 && !(ACTION_DEFS as Record<string, { layer?: boolean }>)[a.action]?.layer).sort((a, b) => a.start - b.start).pop();
        const idleAfterReaction = !!prev && HELD_REACTIONS.has(prev.action) && prev.start + prev.duration < hopStart + TAKEOFF_HOLD - 1e-6;
        const holdId = `hold:${i.actor}`;
        if (idleAfterReaction && !(proposal.holdReaction ?? []).includes(i.actor) && !withdrawn.has(holdId)) {
          proposal.holdReaction = [...(proposal.holdReaction ?? []), i.actor].sort();
          applied.push(holdId); report.decisions.push(`hold ${i.actor} ${prev!.action} through the leap takeoff: ${i.message}`);
        } else if (!applied.some((a) => a.startsWith('hop:') || a.startsWith('hold:'))) {
          const cur = proposal.hopHeight ?? DEFAULT_HOP_HEIGHT, next = HOP_LADDER.find((h) => h > cur + 1e-9 && h <= hopCap + 1e-9);
          if (next !== undefined) { proposal.hopHeight = next; applied.push(`hop:${next}`); report.decisions.push(`leap arc ${cur} -> ${next} m: ${i.message}`); }
        }
      } else if (i.code === 'ACTOR_CLEARANCE') {
        // delay the move that starts later among the two actors' moves active at the contact
        // only when BOTH actors are moving at the contact (delaying one of them separates their paths in time); a mover
        // passing a stationary actor is a staging-path problem for the repair loop
        const other = i.what.replace('actor:', '');
        const cur = c as CompileOk;
        const movingAt = (actor: string) => cur.episode.actions.some((a) => a.actor === actor && ['walk', 'run', 'chase', 'enter_frame', 'exit_frame'].includes(a.action) && i.t >= a.start - 1e-6 && i.t <= a.start + a.duration + 1e-6);
        const active = movingAt(i.actor) && movingAt(other) ? c.moves.filter((m) => (m.actor === i.actor || m.actor === other) && m.start <= i.t + 1e-6).sort((a, b) => b.start - a.start) : [];
        const mv = active[0];
        if (mv && !applied.some((a) => a === `delay:${mv.key}`)) {
          const cur = proposal.moveDelay?.[mv.key] ?? 0;
          const id = `delay:${mv.key}:${cur + 0.2}`;
          if (cur < 1.2 - 1e-9 && !withdrawn.has(id)) { proposal.moveDelay = { ...(proposal.moveDelay ?? {}), [mv.key]: Math.round((cur + 0.2) * 1000) / 1000 }; applied.push(`delay:${mv.key}`, id); report.decisions.push(`delay ${mv.key} by ${cur + 0.2}s: ${i.message}`); }
        }
      }
    }
    if (!applied.length) break;
    let n = compile(clone(proposal));
    if (!n.ok) {
      // withdraw timing-changing remedies of this round (pre-align / delay), keep the arc change, and report the compiler's
      // time requirement to the repair loop
      for (const a of applied) if (a.startsWith('pre:') || a.startsWith('hold:') || /^delay:.*:[\d.]+$/.test(a)) withdrawn.add(a);
      for (const er of n.errors) if (!timingConstraints.some((x) => x.code === er.code && x.beatId === er.beatId)) timingConstraints.push({ ...er, message: `${er.message} (needed by a clearance remedy: ${applied.filter((a) => !a.startsWith('hop:')).join(', ')})` });
      report.decisions.push(`remedies ${applied.join(', ')} need more time than the beat has (${n.errors.map((e) => e.code).join(',')}): withdrawn, duration constraint passed to repair`);
      const keep = clone(knobs); if (proposal.hopHeight !== knobs.hopHeight) keep.hopHeight = proposal.hopHeight;
      if (JSON.stringify(keep) === JSON.stringify(knobs)) continue;
      n = compile(clone(keep));
      if (!n.ok) break;
      setKnobs(knobs, keep); c = n; continue;
    }
    setKnobs(knobs, proposal); c = n;
  }
  if (measured !== c) issues = measureClearance(headlessEngine(c.episode, lib, 270, 480)); // round limit hit right after a change
  const enforcedLeft = issues.filter((i) => i.enforced);
  report.clearance = { enforced: enforcedLeft.length, reported: issues.length - enforcedLeft.length };
  for (const i of issues.filter((x) => !x.enforced).slice(0, 8)) report.warnings.push(`clearance ${i.message}`);
  const seen = new Set<string>();
  for (const i of enforcedLeft) {
    const k = `${i.code}:${i.window.kind}:${i.window.action ?? i.window.event}:${i.window.start}`;
    if (seen.has(k)) continue; seen.add(k);
    report.residual.push({ code: i.code, message: `${i.message} (not removable by the fit knobs)`, beatId: beatAt(c.episode, i.window.start ?? i.t), field: 'stagingVariant', source: 'analysis' });
  }
  if (enforcedLeft.length) report.residual.push(...timingConstraints);

  // ---------- 2. framing ----------
  const ep = clone(c.episode);
  const e = headlessEngine(ep, lib, 1080, 1920);
  const order = ep.shots.map((_, i) => i).filter((i) => ep.shots[i].preset !== 'final_loop');
  for (const idx of order) {
    const sh = ep.shots[idx];
    const planned = { ...(sh.params ?? {}) } as Record<string, number | boolean>;
    const frames = sampleShot(e, idx);
    const base = evalShot(e, idx, true, frames);
    if (base.ok) { report.framing.push({ shot: sh.id, preset: sh.preset, fitted: null, ok: true, qaOk: true, worst: '' }); continue; }
    let best: { cand: Record<string, number | boolean> | null; ev: ShotEval } = { cand: null, ev: base };
    let found: Record<string, number | boolean> | null = null;
    for (const cand of candidates(sh, planned).slice(0, FRAME.maxCandidates)) {
      sh.params = { ...planned, ...cand };
      const cheap = evalShot(e, idx, false, frames);
      const ev = cheap.ok ? evalShot(e, idx, true, frames) : cheap;
      if (ev.ok) { found = cand; best = { cand, ev }; break; }
      if (better(ev, best.ev)) best = { cand, ev };
    }
    if (found) {
      sh.params = { ...planned, ...found }; knobs.shots[sh.id] = found;
      report.framing.push({ shot: sh.id, preset: sh.preset, fitted: found, ok: true, qaOk: true, worst: base.worst });
      report.decisions.push(`framing ${sh.id} ${sh.preset} ${JSON.stringify(found)}: ${base.worst}`);
    } else if (best.cand && best.ev.qaOk) {
      sh.params = { ...planned, ...best.cand }; knobs.shots[sh.id] = best.cand;
      report.framing.push({ shot: sh.id, preset: sh.preset, fitted: best.cand, ok: false, qaOk: true, worst: best.ev.worst });
      report.warnings.push(`framing ${sh.id} ${sh.preset}: padded target not reached (${best.ev.worst}); QA-acceptable parameters ${JSON.stringify(best.cand)}`);
    } else {
      sh.params = planned;
      report.framing.push({ shot: sh.id, preset: sh.preset, fitted: null, ok: false, qaOk: base.qaOk, worst: base.worst });
      if (!base.qaOk) report.residual.push({ code: 'FRAMING_UNFIT', message: `${sh.id} ${sh.preset}: no camera parameters keep the animated face/subjects framed over the whole shot (${base.worst})`, beatId: beatAt(ep, sh.start), field: 'shotHint', disallow: [sh.preset], source: 'analysis' });
      else report.warnings.push(`framing ${sh.id} ${sh.preset}: padded target not reached (${base.worst}); planned parameters are QA-acceptable`);
    }
  }
  for (const idx of ep.shots.map((_, i) => i).filter((i) => ep.shots[i].preset === 'final_loop')) {
    const ev = evalShot(e, idx, true);
    report.framing.push({ shot: ep.shots[idx].id, preset: 'final_loop', fitted: null, ok: ev.ok, qaOk: ev.qaOk, worst: ev.worst });
    if (!ev.qaOk) report.residual.push({ code: 'FRAMING_UNFIT', message: `${ep.shots[idx].id} final_loop (mirrors the opening): ${ev.worst}`, beatId: beatAt(ep, ep.shots[idx].start), field: null, source: 'analysis' });
  }
  if (Object.keys(knobs.shots).length) {
    const n = compile(clone(knobs));
    if (!n.ok) return { compiled: n, report };
    c = n;
  }
  report.knobs = clone(knobs);
  report.ms = Math.round(performance.now() - t0);
  return { compiled: c, report };
}

interface ShotEval { ok: boolean; qaOk: boolean; score: number; worst: string }
const better = (a: ShotEval, b: ShotEval) => (a.qaOk !== b.qaOk ? a.qaOk : a.score < b.score);

/** face feature region (eyes, brows, mouth) in face-plane uv, from the character's face manifest */
function featureUv(face: { eyeSpacing: number; eyeW: number; eyeH: number; eyeY: number; browWidth: number; mouthY: number; mouthW: number }): [number, number, number, number] {
  const hx = Math.max(face.eyeSpacing / 2 + Math.max(face.eyeW, face.browWidth) / 2 + 0.02, face.mouthW / 2);
  return [Math.max(0, 0.5 - hx), Math.max(0, face.eyeY - face.eyeH / 2 - 0.12), Math.min(1, 0.5 + hx), Math.min(1, face.mouthY + 0.08)];
}

interface ActorFrame { feat: Vec3[]; head: Vec3[]; face: Vec3; faceN: Vec3; bbox: Vec3[]; emote: Vec3 | null }
interface FrameData { t: number; actors: Record<string, ActorFrame>; shake: number }
/** sample the animation of shot `idx` once (camera independent): face feature/head corners, probes, emote, shake */
function sampleShot(e: HeadlessEngine, idx: number): FrameData[] {
  const ep = e.prod.ep, sh = ep.shots[idx], fps = ep.episode.fps;
  const out: FrameData[] = [];
  const k0 = Math.ceil(sh.start * fps - 1e-9), k1 = Math.ceil(sh.end * fps - 1e-9);
  for (let k = k0; k < k1; k++) {
    const t = k / fps;
    const f = e.prod.evaluate(t);
    if (f.shot.id !== sh.id) continue;
    const vf = evalVfx(ep.vfx, t, (id, tt) => e.prod.point(id, tt), ep.episode.seed);
    const actors: Record<string, ActorFrame> = {};
    for (const sid of sh.subjects) {
      const id = sid.split('.')[0], rig = e.prod.rigs.get(id);
      if (!rig) continue;
      const m = rig.manifest, w = m.body.headSize[0] * 0.98, h = rig.dims.headH * 0.98, fw = rig.face.world;
      const [u0, v0, u1, v1] = featureUv(m.face as never);
      const at = (u: number, v: number) => m4TransformPoint(fw, [(u - 0.5) * w, (0.5 - v) * h, 0]).slice(0, 3) as unknown as Vec3;
      const tight = sh.preset === 'reaction_punch_in' || sh.preset === 'over_shoulder';
      const em = e.prod.emoteNodes.get(id);
      actors[id] = {
        feat: [at(u0, v0), at(u1, v0), at(u0, v1), at(u1, v1)], head: [at(0, 0), at(1, 0), at(0, 1), at(1, 1)],
        face: rig.face.worldPos() as Vec3, faceN: norm([fw[8], fw[9], fw[10]]),
        bbox: (tight ? rig.probes.filter((p) => p.name.startsWith('probe:head')) : rig.probes).map((p) => p.worldPos() as Vec3),
        emote: em?.visible ? (em.worldPos() as Vec3) : null,
      };
    }
    out.push({ t, actors, shake: vf.shake });
  }
  return out;
}

/** framing of shot `idx` with its CURRENT params over all sampled frames; full = also the hard shot QA (occlusion etc.) */
export function evalShot(e: HeadlessEngine, idx: number, full: boolean, frames?: FrameData[]): ShotEval {
  const ep = e.prod.ep, sh: EpisodeShot = ep.shots[idx];
  const data = frames ?? sampleShot(e, idx);
  const safe = e.prod.env.manifest.composition.actionSafe;
  const needFace = (si: number) => FACE_PRESETS.has(sh.preset) || (sh.preset === 'over_shoulder' && si > 0);
  // emote billboards sit ~0.56 m above the face: required in frame only in shots that include the space above the head by
  // design (two-shot, over-shoulder, wides). Medium and tight face shots crop above the head (the PoC-calibrated medium
  // at 2 m shows up to face + 0.31 m); there the face itself carries the reaction.
  const needEmote = ['two_shot', 'over_shoulder', 'wide_environment', 'low_angle_reveal'].includes(sh.preset);
  let faceOut = 0, headOut = 0, emoteOut = 0, camNear = 0, qaHard = 0, faceCentreOut = 0;
  const lowDot: Record<string, number> = {}, unsafe: Record<string, number> = {}, qaTurned: Record<string, number> = {}, qaUnsafe: Record<string, number> = {};
  let worst = '';
  for (const fd of data) {
    const t = fd.t;
    const solved = solveShot(sh, t, e.prod, e.prod.camEnv, e.prod.firstShot);
    const cam = applyShake(solved.cam, fd.shake, t, ep.episode.seed);
    const { vp } = e.renderer.viewProj(cam);
    const proj = (p: Vec3) => { const c = m4TransformPoint(vp, p); return c[3] <= 0 ? null : { x: (c[0] / c[3] + 1) / 2, y: 1 - (c[1] / c[3] + 1) / 2 }; };
    sh.subjects.forEach((sid, si) => {
      const id = sid.split('.')[0], a = fd.actors[id];
      if (!a) return;
      if (!(sh.preset === 'over_shoulder' && si === 0)) {
        const pts = a.bbox.map(proj).filter(Boolean) as Array<{ x: number; y: number }>;
        if (pts.length) {
          const cx = (Math.min(...pts.map((p) => p.x)) + Math.max(...pts.map((p) => p.x))) / 2, cy = (Math.min(...pts.map((p) => p.y)) + Math.max(...pts.map((p) => p.y))) / 2;
          if (cx < safe.left + FRAME.safePad || cx > safe.right - FRAME.safePad || cy < safe.top + FRAME.safePad || cy > safe.bottom - FRAME.safePad) unsafe[id] = (unsafe[id] ?? 0) + 1;
          if (cx < safe.left || cx > safe.right || cy < safe.top || cy > safe.bottom) qaUnsafe[id] = (qaUnsafe[id] ?? 0) + 1;
        }
      }
      if (needFace(si)) {
        if (a.feat.map(proj).some((p) => !p || p.x < FRAME.edge || p.x > 1 - FRAME.edge || p.y < FRAME.edge || p.y > 1 - FRAME.edge)) { faceOut++; worst ||= `${id} face features leave the frame at ${t.toFixed(2)}s`; }
        if (sh.preset !== 'reaction_punch_in' && a.head.map(proj).some((p) => !p || p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1)) { headOut++; worst ||= `${id} head cropped at ${t.toFixed(2)}s`; }
        const fc = proj(a.face);
        if (!fc || fc.x < 0.02 || fc.x > 0.98 || fc.y < 0.02 || fc.y > 0.98) faceCentreOut++;
        const d = dot(norm(sub(cam.pos, a.face)), a.faceN);
        if (d < FRAME.faceDot) { lowDot[id] = (lowDot[id] ?? 0) + 1; worst ||= `${id} face turned (cos ${d.toFixed(2)}) at ${t.toFixed(2)}s`; }
        if (d < FRAME.qaFaceDot) qaTurned[id] = (qaTurned[id] ?? 0) + 1;
      }
      if (needEmote && a.emote) { const p = proj(a.emote); if (!p || p.x < FRAME.emoteEdge || p.x > 1 - FRAME.emoteEdge || p.y < FRAME.emoteEdge || p.y > 1 - FRAME.emoteEdge) { emoteOut++; worst ||= `${id} emote out of frame at ${t.toFixed(2)}s`; } }
    });
    for (const [inst, p] of e.prod.props) {
      if (!p.track.stateAt(t).visible) continue;
      if (e.prod.propDepth(inst, cam.pos, t) > -FRAME.cameraProp) { camNear++; worst ||= `camera within ${FRAME.cameraProp} m of ${inst} at ${t.toFixed(2)}s`; }
    }
  }
  if (full) {
    // hard shot QA on the real scene state (occlusion rays need the posed rigs): evaluate() applies the current params
    for (const fd of data) {
      const f = e.prod.evaluate(fd.t);
      const hard = e.prod.validateFrame(e.renderer as never, f).filter((x) => ['SUBJECT_OUT_OF_FRAME', 'SUBJECT_BEHIND_CAMERA', 'FACE_OUT_OF_FRAME', 'FACE_OCCLUDED', 'CAMERA_IN_PROP'].includes(x.code));
      if (hard.length) { qaHard++; worst ||= `${hard[0].code} ${hard[0].message} at ${fd.t.toFixed(2)}s`; }
    }
    // the cause must be seen: in a shot that frames the hero prop, its press surface stays unoccluded on every frame and
    // at every press contact (the analyzer checks both: sampled frames + contact times)
    const hero = ep.props.find((p) => p.hero)?.instance;
    if (hero && sh.subjects.includes(hero)) {
      const times = [...data.map((fd) => fd.t), ...e.prod.contacts().filter((c) => c.action === 'press_button' && c.t >= sh.start && c.t < sh.end).map((c) => c.t)];
      for (const t of times) {
        const f = e.prod.evaluate(t);
        if (f.shot.id !== sh.id) continue;
        const occ = e.prod.propOcclusion(f, hero, 'press_surface');
        if (occ.length) { qaHard++; worst ||= `PROP_OCCLUDED ${occ[0].message} at ${t.toFixed(2)}s`; }
      }
    }
  }
  const n = Math.max(1, data.length);
  const anyLow = Object.values(lowDot).some((x) => x > 0), anyUnsafe = Object.values(unsafe).some((x) => x > 0);
  if (!worst && anyUnsafe) worst = `subject centre outside the padded action-safe area on ${Math.max(...Object.values(unsafe))}/${n} frames`;
  const ok = faceOut === 0 && headOut === 0 && emoteOut === 0 && camNear === 0 && qaHard === 0 && !anyLow && !anyUnsafe;
  const qaOk = qaHard === 0 && faceCentreOut === 0 && Object.values(qaTurned).every((x) => x / n < FRAME.qaSoftFraction) && Object.values(qaUnsafe).every((x) => x / n < FRAME.qaSoftFraction);
  const score = 100 * qaHard + 50 * faceCentreOut + 10 * (faceOut + emoteOut + camNear) + 3 * headOut + Object.values(lowDot).reduce((x, y) => x + y, 0) + Object.values(unsafe).reduce((x, y) => x + y, 0);
  return { ok, qaOk, score, worst };
}

/** deterministic candidate parameter sets per preset, ordered by size of change (smallest first) */
export function candidates(sh: EpisodeShot, p: Record<string, number | boolean>): Array<Record<string, number | boolean>> {
  const num = (k: string, d: number) => (typeof p[k] === 'number' ? (p[k] as number) : d);
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  const out: Array<{ c: Record<string, number | boolean>; cost: number; key: string }> = [];
  const add = (c: Record<string, number | boolean>, cost: number) => { const key = JSON.stringify(Object.entries(c).sort()); if (cost > 0 && !out.some((x) => x.key === key)) out.push({ c, cost, key }); };
  const solveOpts = (planned: number | undefined) => [planned, r3(sh.start + 0.05), r3((sh.start + sh.end) / 2), r3(Math.max(sh.start, sh.end - 0.1))].filter((v, i, a) => v !== undefined && a.indexOf(v) === i) as number[];
  const yaws = [0, 12, -12, 24, -24];
  switch (sh.preset) {
    case 'frontal_medium': case 'reaction_punch_in': {
      const d = num('dist', sh.preset === 'frontal_medium' ? 2.1 : 0.95), fd = num('fromDist', 1.7), b = num('bias', sh.preset === 'frontal_medium' ? 0.45 : 0.35);
      const step = sh.preset === 'frontal_medium' ? 0.35 : 0.3;
      const sa = typeof p.solveAt === 'number' ? (p.solveAt as number) : undefined;
      for (const dd of [0, 1, 2, 3, 4]) for (const s of solveOpts(sa)) for (const bb of [0, 1]) for (const y of yaws) {
        const c: Record<string, number | boolean> = {};
        if (dd) c.dist = r3(d + dd * step);
        if (sh.preset === 'reaction_punch_in' && dd) c.fromDist = r3(Math.max(fd, d + dd * step + 0.4));
        if (s !== sa) c.solveAt = s;
        if (bb) c.bias = r3(Math.min(1, b + 0.3));
        if (y) c.yaw = r3(num('yaw', 0) + y);
        add(c, dd + (s !== sa ? 0.6 : 0) + bb * 0.8 + Math.abs(y) / 12);
      }
      break;
    }
    case 'two_shot': {
      const fill = num('fill', 0.92);
      for (const df of [0, 1, 2, 3]) for (const y of [0, 12, -12, 24, -24, 36, -36]) for (const h of [0, 1]) {
        const c: Record<string, number | boolean> = {};
        if (df) c.fill = r3(Math.max(0.45, fill - 0.1 * df));
        if (y) c.yaw = r3(num('yaw', 0) + y);
        if (h) c.height = r3(num('height', -0.1) + 0.2);
        add(c, df + Math.abs(y) / 12 + h * 0.8);
      }
      break;
    }
    case 'over_shoulder': {
      for (const db of [0, 1, 2]) for (const ds of [0, 1]) for (const df of [0, 1]) {
        const c: Record<string, number | boolean> = {};
        if (db) c.back = r3(num('back', 0.75) + 0.3 * db);
        if (ds) c.side = r3(num('side', 0.42) + 0.2);
        if (df) c.fov = r3(num('fov', 38) + 6);
        add(c, db + ds + df);
      }
      break;
    }
    case 'wide_environment': {
      const sa = typeof p.solveAt === 'number' ? (p.solveAt as number) : undefined;
      for (const dm of [0, 1, 2, 3]) for (const s of solveOpts(sa)) for (const df of [0, 1]) {
        const c: Record<string, number | boolean> = {};
        if (dm) c.margin = r3(num('margin', 0.5) + [0, 0.3, 0.6, 1.0][dm]);
        if (s !== sa) c.solveAt = s;
        if (df) c.fov = r3(num('fov', 38) + 6);
        add(c, dm + (s !== sa ? 0.6 : 0) + df);
      }
      break;
    }
    case 'low_angle_reveal': {
      for (const dm of [0, 1, 2]) for (const df of [0, 1]) for (const ds of [0, 1]) {
        const c: Record<string, number | boolean> = {};
        if (dm) c.minDist = r3(num('minDist', 1.2) + 0.6 * dm);
        if (df) c.fill = r3(Math.max(0.45, num('fill', 0.75) - 0.15));
        if (ds) c.side = r3(-num('side', 0.25));
        add(c, dm + df + ds);
      }
      break;
    }
    case 'prop_ecu': case 'top_down_insert': {
      for (const df of [0, 1, 2]) for (const y of sh.preset === 'prop_ecu' ? [0, 15, -15, 30, -30] : [0]) for (const de of sh.preset === 'prop_ecu' ? [0, 1] : [0]) {
        const c: Record<string, number | boolean> = {};
        if (df) c.fill = r3(Math.max(0.2, num('fill', 0.62) - 0.12 * df));
        if (y) c.yaw = r3(num('yaw', 0) + y);
        if (de) c.elev = r3(num('elev', 0.32) + 0.15);
        add(c, df + Math.abs(y) / 15 + de);
      }
      break;
    }
    default: break;
  }
  return out.sort((a, b) => a.cost - b.cost || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).map((x) => x.c);
}
