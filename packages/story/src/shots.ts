// Stage E — shot planner (deterministic). Semantic presets per beat, PoC-calibrated parameters, subject resolution,
// opening/loop rules and a no-repeat rule. Cameras stay on the audience side (the solver enforces it).
import type { PlanBeat, RepairConstraint, VisualBeatPlan } from './schemas.ts';
import { SLOT_SPECS } from './templates.ts';

export interface ShotReq { beatId: string; from: number; to: number; preset: string; subjects: string[]; params: Record<string, number | boolean>; purpose: string }
type P = Record<string, number | boolean>;

/** calibrated parameter sets (derived from the tuned PoC); times are relative to the beat start */
function params(preset: string, slot: string, d: number): P {
  switch (preset) {
    case 'prop_ecu': return slot === 'premise' || slot === 'loop' ? { fill: 0.78, elev: 0.42, yaw: -12, push: 0.08, fov: 34 } : { fill: 0.26, elev: 0.12, lift: 3.2, fov: 44, push: 0.06, yaw: 8 };
    case 'frontal_medium': return { dist: 2.0, bias: 0.35, solveAt: 0.4, push: 0.08 };
    case 'reaction_punch_in': return slot === 'payoff' ? { dist: 2.0, fromDist: 2.5, bias: 0.9, solveAt: 0 } : slot === 'threat' ? { dist: 1.3, fromDist: 1.7, bias: 0.4, solveAt: 0.35 } : { dist: 1.75, fromDist: 2.3, bias: 0.65, solveAt: 0.35 };
    case 'two_shot': return { fill: 0.82, push: 0.04 };
    case 'top_down_insert': return { fill: 0.9, minRadius: 0.5, push: 0.1 };
    case 'low_angle_reveal': return slot === 'threat' ? { side: 0.3, height: 0.25, fill: 0.95, minDist: 3.2, aim: 0.55, fov: 50, push: 0.05 } : { solveAt: Math.max(0, d - 0.05), side: -0.35, height: 0.35, fill: 0.7, minDist: 2.4, aim: 0.4, fov: 44 };
    case 'wide_environment': return slot === 'reversal' ? { solveAt: 0, margin: 0.7, elev: 0.2, fov: 42, push: 0.02 } : slot === 'race' ? { solveAt: 0, margin: 0.8, elev: 0.15, fov: 44, push: 0.02 } : { solveAt: Math.max(0, d - 0.1), margin: 0.7, elev: 0.12, fov: 40, push: 0.03 };
    case 'over_shoulder': return { back: 0.6, side: 0.35, up: 0.1, fov: 40, push: 0.05, targetLift: -0.25 };
    case 'final_loop': return { pullback: 0.12 };
    default: return {};
  }
}

export function planShots(plan: VisualBeatPlan, beatTimes: Record<string, [number, number]>): { shots: ShotReq[]; errors: RepairConstraint[] } {
  const { protagonist: Pr, foil: F, victim: V } = plan.roles;
  const O = V === Pr ? F : Pr;
  const errors: RepairConstraint[] = [];
  const shots: ShotReq[] = [];
  const subj = (b: PlanBeat, preset: string): string[] => {
    switch (b.slot) {
      case 'premise': case 'loop': case 'press_reward': return ['button'];
      case 'attempt_fail': return preset === 'prop_ecu' ? ['button'] : [b.actor];
      case 'reward_reveal': return ['desk'];
      case 'celebrate': return preset === 'two_shot' ? [b.actor, b.actor === Pr ? F : Pr] : [b.actor];
      case 'race': return [Pr, F, 'button'];
      case 'escalate': return ['coin'];
      case 'leap': case 'reversal': return preset === 'wide_environment' ? ['coin', V, O] : ['coin'];
      case 'instant_loss': return preset === 'wide_environment' ? ['coin', V, O] : ['coin'];
      case 'threat': return preset === 'low_angle_reveal' ? ['coin'] : [V];
      case 'smart_attempt': return preset === 'prop_ecu' ? ['button'] : preset === 'two_shot' ? [b.actor, Pr] : preset === 'wide_environment' ? [b.actor, Pr, 'button'] : [b.actor];
      case 'warn': return preset === 'two_shot' ? [b.actor, Pr] : [b.actor];
      default: return [b.actor];
    }
  };
  let foilFramed = false;
  for (const b of plan.beats) {
    const spec = SLOT_SPECS[b.slot];
    const [t0, t1] = beatTimes[b.id];
    const d = t1 - t0;
    let preset = b.shotHint ?? spec.shots[0];
    if (!spec.shots.includes(preset)) { errors.push({ code: 'SHOT_NOT_ALLOWED', message: `${preset} not allowed for slot ${b.slot}`, beatId: b.id, field: 'shotHint', allowed: spec.shots, source: 'compiler' }); preset = spec.shots[0]; }
    // two-part beats: cause insert then reaction, or reaction then reveal
    const split: Record<string, [string, string, number] | undefined> = {
      attempt_fail: ['prop_ecu', preset === 'prop_ecu' ? 'frontal_medium' : preset, 0.55],
      smart_attempt: ['wide_environment', 'prop_ecu', 0.35],
      threat: ['reaction_punch_in', 'low_angle_reveal', 0.45],
      instant_loss: ['low_angle_reveal', 'wide_environment', 0.4],
      // cut on impact: the second wide is solved on the aftermath (flattened prop + victim) so the payoff is centred
      reversal: ['wide_environment', 'wide_environment', 0.7],
    };
    const sp = split[b.slot];
    if (sp && d >= 1.2) {
      // cut points never hide a cause: smart_attempt keeps both presses (contacts at +0.48 s and +1.48 s) in the insert
      const cut = b.slot === 'smart_attempt' ? t0 + Math.min(d - 1.6, 1.25) : b.slot === 'instant_loss' ? t0 + 0.8 : b.slot === 'threat' ? t0 + Math.min(0.95, d * sp[2]) : t0 + d * sp[2];
      const prevWide = shots.length && shots[shots.length - 1].preset === 'wide_environment';
      if (b.slot === 'reversal' && prevWide) shots.push({ beatId: b.id, from: t0, to: cut, preset: 'low_angle_reveal', subjects: ['coin'], params: rel({ ...params('low_angle_reveal', 'threat', cut - t0), solveAt: 0 }, t0), purpose: `${b.purpose} (low_angle_reveal)` });
      else shots.push({ beatId: b.id, from: t0, to: cut, preset: sp[0], subjects: subj(b, sp[0]), params: rel(b.slot === 'instant_loss' ? { ...params(sp[0], b.slot, 0.8), solveAt: 0.75 } : params(sp[0], b.slot, cut - t0), t0), purpose: `${b.purpose} (${sp[0]})` });
      if (b.slot === 'reversal') { shots.push({ beatId: b.id, from: cut, to: t1, preset: 'wide_environment', subjects: ['coin', V], params: { solveAt: +(t1 - 0.05).toFixed(3), margin: 0.6, elev: 0.28, fov: 40, push: 0 }, purpose: 'Aftermath: flattened by the prize' }); continue; }
      // a reaction half that shows a not-yet-introduced foil reacting becomes a two-shot (introduces the foil)
      const introFoil = !foilFramed && b.reactor?.actor === F && b.slot === 'attempt_fail';
      const p2 = introFoil ? 'two_shot' : sp[1];
      shots.push({ beatId: b.id, from: cut, to: t1, preset: p2, subjects: introFoil ? [b.actor, F] : subj(b, p2), params: rel(params(p2, b.slot, t1 - cut), cut), purpose: `${b.purpose} (${p2})` });
    } else shots.push({ beatId: b.id, from: t0, to: t1, preset: b.slot === 'celebrate' && !foilFramed ? 'two_shot' : preset, subjects: subj(b, b.slot === 'celebrate' && !foilFramed ? 'two_shot' : preset), params: rel(params(b.slot === 'celebrate' && !foilFramed ? 'two_shot' : preset, b.slot, d), t0), purpose: b.purpose });
    if (shots.some((x) => x.subjects.includes(F))) foilFramed = true;
  }
  // no two consecutive shots with identical preset + subjects: re-assign one of them to an alternative setup that
  // differs from BOTH neighbours (slot preferences first, then generic coverage setups)
  const FALLBACK = ['low_angle_reveal', 'two_shot', 'frontal_medium', 'reaction_punch_in', 'wide_environment'];
  const key = (x: ShotReq) => `${x.preset}|${x.subjects.join()}`;
  for (let i = 0; i + 1 < shots.length; i++) {
    if (key(shots[i]) !== key(shots[i + 1])) continue;
    let fixed = false;
    for (const j of [i, i + 1]) {
      const sh = shots[j];
      const b = plan.beats.find((x) => x.id === sh.beatId)!;
      if (b.slot === 'premise' || b.slot === 'loop') continue;
      for (const alt of [...SLOT_SPECS[b.slot].shots, ...FALLBACK]) {
        if (alt === sh.preset) continue;
        const cand = { ...sh, preset: alt, subjects: subj(b, alt) };
        if (alt === 'two_shot' && cand.subjects.length < 2) cand.subjects = [V, O];
        if ((j > 0 && key(cand) === key(shots[j - 1])) || (j + 1 < shots.length && key(cand) === key(shots[j + 1]))) continue;
        shots[j] = { ...cand, params: rel(params(alt, b.slot, sh.to - sh.from), sh.from) };
        fixed = true; break;
      }
      if (fixed) break;
    }
  }
  return { shots, errors };
}

/** convert relative solveAt to absolute time */
function rel(p: P, t0: number): P {
  const o = { ...p };
  if (typeof o.solveAt === 'number') o.solveAt = +(t0 + (o.solveAt as number)).toFixed(3);
  return o;
}
