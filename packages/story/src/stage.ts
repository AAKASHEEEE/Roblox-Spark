// Stage D — staging planner (deterministic). Chooses marks, paths, contact anchors and screen direction from the
// environment's named marks; checks every path against collision geometry with a body-width clearance.
import type { EnvironmentManifest } from '../../schema/src/assets.ts';
import type { Engine, RepairConstraint, VisualBeatPlan } from './schemas.ts';

export interface Move { actor: string; slot: string; from: string; to: string; kind: 'walk' | 'run' | 'chase' | 'dive_prone'; clearance: number }
export interface StagingPlan {
  engine: Engine; variant: number;
  start: Record<string, string>;
  pressMark: Record<string, string>;
  walkIn: Record<string, string | null>;
  raceTo: Record<string, string>;
  smartApproach: string | null;
  noobExit?: string;
  victimBack: string; giantFront: string; diveEnd: string; giantSpot: string;
  observerEscape: string[];
  screenDirection: string;
  contacts: Array<{ actor: string; anchor: string }>;
  safetyMargins: { actorActor: number; pathCollider: number; endpointSlack: number };
  moves: Move[];
}

/** torso half-width (0.27 m) + margin; the probe-based body check in the analysis pass is the ground truth */
const BODY_HALF_WIDTH = 0.3;
/** low furniture (tops below hip height) only needs leg/arm clearance; tall geometry needs torso half-width */
const LOW_CLEARANCE = 0.18;
const DESK = { id: 'prop:desk', min: [-0.5, -0.31], max: [0.5, 0.31], low: true };

function colliders2d(env: EnvironmentManifest): Array<{ id: string; min: number[]; max: number[]; low: boolean }> {
  const out: Array<{ id: string; min: number[]; max: number[]; low: boolean }> = [DESK];
  for (const p of env.pieces) {
    if (!p.collide || p.id === 'floor' || p.pos[1] - (p.size[1] || 0) / 2 > 1.2) continue;
    const shape = p.shape ?? 'box';
    const hx = shape === 'cylinder' || shape === 'sphere' ? p.size[0] : p.size[0] / 2, hz = shape === 'cylinder' || shape === 'sphere' ? p.size[0] : p.size[2] / 2;
    out.push({ id: `env:${p.id}`, min: [p.pos[0] - hx, p.pos[2] - hz], max: [p.pos[0] + hx, p.pos[2] + hz], low: p.pos[1] + (p.size[1] || 0) / 2 <= 0.85 });
  }
  return out;
}
/** min distance from segment a-b (xz) to an AABB, ignoring `slack` metres at both ends */
function segClearance(a: number[], b: number[], box: { min: number[]; max: number[] }, slack: number): number {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  let best = Infinity;
  const n = Math.max(8, Math.ceil(L / 0.05));
  for (let i = 0; i <= n; i++) {
    const u = i / n; if (u * L < slack || (1 - u) * L < slack) continue;
    const x = a[0] + (b[0] - a[0]) * u, z = a[1] + (b[1] - a[1]) * u;
    const dx = Math.max(box.min[0] - x, 0, x - box.max[0]), dz = Math.max(box.min[1] - z, 0, z - box.max[1]);
    best = Math.min(best, Math.hypot(dx, dz));
  }
  return best;
}

export function stagePlan(plan: VisualBeatPlan, env: EnvironmentManifest): { staging: StagingPlan; errors: RepairConstraint[] } {
  const P = plan.roles.protagonist, F = plan.roles.foil, V = plan.roles.victim;
  const O = V === P ? F : P;
  const v = plan.stagingVariant;
  const slots = plan.beats.map((b) => b.slot);
  const s: StagingPlan = {
    engine: plan.engine, variant: v, start: {}, pressMark: { [P]: 'press_spot' }, walkIn: { [P]: null, [F]: null }, raceTo: {}, smartApproach: null,
    victimBack: 'wp_desk_back_left', giantFront: 'giant_front', diveEnd: 'dive_end', giantSpot: 'giant_spot', observerEscape: ['observe_safe'],
    screenDirection: 'audience side only (+z); protagonist enters from screen-left, foil holds screen-right; giant prop lands screen-left and falls toward camera',
    contacts: [], safetyMargins: { actorActor: 0.6, pathCollider: BODY_HALF_WIDTH, endpointSlack: 0.35 }, moves: [],
  };
  if (plan.engine === 'visible_secret_chase') {
    s.start[P] = v === 2 ? 'enter_back_left' : 'race_left';
    s.start[F] = v === 1 ? 'watch_right' : 'race_right';
    s.raceTo = { [P]: 'press_spot', [F]: 'foil_spot' };
  } else if (plan.engine === 'noob_vs_smart') {
    // one reachable press position (button on the presser's right): the noob yields it to the smart character
    s.start[P] = v === 2 ? 'press_spot' : 'enter_back_left';
    s.walkIn[P] = v === 2 ? null : 'press_spot';
    s.start[F] = v === 1 ? 'watch_left' : 'smart_wait';
    s.pressMark[F] = 'press_spot';
    s.smartApproach = 'press_spot';
    s.noobExit = 'wp_desk_back_right';
    s.observerEscape = ['observe_safe'];
  } else {
    s.start[P] = v === 2 ? 'press_spot' : 'enter_back_left';
    s.walkIn[P] = v === 2 ? null : 'press_spot';
    s.start[F] = v === 1 ? 'watch_right' : 'foil_spot';
  }
  // observer escape starts from wherever the observer stands when the prop leaps
  const obsAt = s.noobExit && O === P ? s.noobExit : O === P ? s.pressMark[P] : plan.engine === 'visible_secret_chase' ? 'foil_spot' : s.start[F];
  if (O === F && plan.engine !== 'noob_vs_smart') s.observerEscape = ['observe_safe'];
  for (const b of plan.beats) if (b.action === 'press_button') s.contacts.push({ actor: b.actor, anchor: 'button.press_surface' });
  // moves
  const mk = (actor: string, slot: string, from: string, to: string, kind: Move['kind']) => s.moves.push({ actor, slot, from, to, kind, clearance: 0 });
  if (s.walkIn[P]) mk(P, 'premise', s.start[P], s.walkIn[P]!, 'walk');
  if (s.raceTo[P]) { mk(P, 'race', s.start[P], s.raceTo[P], 'run'); mk(F, 'race', s.start[F], s.raceTo[F], 'chase'); }
  if (s.noobExit) mk(P, 'smart_attempt', s.pressMark[P], s.noobExit, 'walk');
  if (s.smartApproach) mk(F, 'smart_attempt', s.start[F], s.smartApproach, 'walk');
  const victimPress = s.pressMark[V] ?? 'press_spot';
  const leapSlot = slots.includes('leap') ? 'leap' : 'instant_loss';
  mk(V, leapSlot, victimPress, s.victimBack, 'walk');
  mk(V, slots.includes('threat') ? 'threat' : leapSlot, s.victimBack, s.giantFront, 'run');
  mk(V, 'reversal', s.giantFront, s.diveEnd, 'dive_prone');
  let from = obsAt;
  for (const to of s.observerEscape) { mk(O, leapSlot, from, to, 'run'); from = to; }
  // clearance checks
  const cols = colliders2d(env);
  const errors: RepairConstraint[] = [];
  const pos = (m: string) => { const x = env.marks[m]?.pos; if (!x) throw new Error(`stager: mark ${m} missing in ${env.id}@${env.version}`); return [x[0], x[2]]; };
  for (const m of s.moves) {
    const a = pos(m.from), b = pos(m.to);
    // margin = clearance minus what this collider requires (negative = blocked)
    const margins = cols.map((c) => segClearance(a, b, c, s.safetyMargins.endpointSlack) - (c.low ? LOW_CLEARANCE : BODY_HALF_WIDTH));
    m.clearance = +(Math.min(...margins) + BODY_HALF_WIDTH).toFixed(3);
    if (m.kind !== 'dive_prone' && Math.min(...margins) < 0) errors.push({ code: 'PATH_BLOCKED', message: `${m.actor} ${m.kind} ${m.from}->${m.to} passes ${m.clearance.toFixed(2)} m from geometry (< ${BODY_HALF_WIDTH})`, beatId: plan.beats.find((x) => x.slot === m.slot)?.id ?? null, field: 'stagingVariant', source: 'compiler' });
  }
  return { staging: s, errors };
}
