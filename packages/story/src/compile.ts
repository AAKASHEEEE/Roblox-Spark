// Stage F — deterministic timeline compiler: semantic plan + staging + shots -> strict Episode v1.0.
// Pure function (no randomness, no clock): identical inputs always give byte-identical episode JSON.
import type { Episode, EpisodeAction } from '../../schema/src/episode.ts';
import type { EnvironmentManifest } from '../../schema/src/assets.ts';
import { ACTION_DEFS } from '../../engine/src/animation/actions.ts';
import { hashSeed } from '../../engine/src/math.ts';
import type { Registry } from './registry.ts';
import { EMOTION_FACE } from './registry.ts';
import type { NormalizedIdea, PlanBeat, RepairConstraint, StoryRequest, VisualBeatPlan } from './schemas.ts';
import { planShots } from './shots.ts';
import type { StagingPlan } from './stage.ts';
import { SLOT_SPECS } from './templates.ts';

export interface KeyEvent { beatId: string; kind: string; t: number; actor?: string }
export interface CompileOk { ok: true; episode: Episode; beatTimes: Record<string, [number, number]>; events: KeyEvent[]; notes: string[] }
export interface CompileErr { ok: false; errors: RepairConstraint[]; notes: string[] }

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const TAIL: Record<string, number> = { reversal: 2.3, payoff: 1.0, loop: 1.1 };
const MIN: Record<string, number> = { premise: 0.9, notice: 1.0, foil_notice: 0.9, warn: 0.9, race: 1.2, attempt_fail: 1.4, press_reward: 1.25, reward_reveal: 0.9, celebrate: 1.3, smart_attempt: 3.2, escalate: 1.15, leap: 1.55, threat: 2.2, instant_loss: 2.25 };
const ENGINE_ABBR: Record<string, string> = { ordinary_object_extreme: 'ooe', visible_secret_chase: 'vsc', apparent_win_instant_loss: 'awl', noob_vs_smart: 'nvs' };

export function compileEpisode(req: StoryRequest, idea: NormalizedIdea, plan: VisualBeatPlan, st: StagingPlan, reg: Registry): CompileOk | CompileErr {
  const env: EnvironmentManifest = reg.environment;
  const errors: RepairConstraint[] = [];
  const notes: string[] = [];
  const err = (code: string, message: string, beatId: string | null, field: string | null, allowed?: unknown[]) => errors.push({ code, message, beatId, field, allowed, source: 'compiler' });
  const P = plan.roles.protagonist, F = plan.roles.foil, V = plan.roles.victim, O = V === P ? F : P;
  const beats = plan.beats;
  const has = (slot: string) => beats.some((b) => b.slot === slot);
  const mark = (m: string) => { const x = env.marks[m]?.pos; if (!x) throw new Error(`mark ${m} missing`); return x; };
  const dist = (a: string, b: string) => Math.hypot(mark(a)[0] - mark(b)[0], mark(a)[2] - mark(b)[2]);
  const man = (id: string) => reg.characters[id];
  const locoDur = (actor: string, kind: string, from: string, to: string): number => {
    const d = dist(from, to), m = man(actor).locomotion;
    const vmax = (kind === 'walk' ? m.walkSpeed : m.runSpeed) * 1.25 * 0.94;
    const comfy = kind === 'walk' ? d / (m.walkSpeed * 1.1) + 0.25 : d / (m.runSpeed * 0.9) + 0.25;
    return r3(Math.max(0.45, d / vmax + 0.27, comfy));
  };
  const faceOf = (actor: string, emo: string) => EMOTION_FACE[actor]?.[emo] ?? man(actor).allowedExpressions[0];

  // ---------- 1. beat durations ----------
  const target = Math.min(22, Math.max(14, req.durationTarget));
  const head = beats.filter((b) => !(b.slot in TAIL));
  const tailSum = beats.filter((b) => b.slot in TAIL).reduce((a, b) => a + TAIL[b.slot], 0);
  const lo = (b: PlanBeat) => Math.max(MIN[b.slot] ?? 0.9, SLOT_SPECS[b.slot].duration[0] * 0.8);
  const hi = (b: PlanBeat) => b.slot === 'premise' ? 1.3 : Math.max(lo(b), SLOT_SPECS[b.slot].duration[1] * 1.3);
  // feasibility minimums from travel
  const walkIn = st.walkIn[P] ? locoDur(P, 'walk', st.start[P], st.walkIn[P]!) : 0;
  const need: Record<string, number> = {};
  if (st.raceTo[P]) need.race = Math.max(locoDur(P, 'run', st.start[P], st.raceTo[P]) + 0.2, locoDur(F, 'chase', st.start[F], st.raceTo[F]) + 0.35);
  {
    const V0 = plan.roles.victim;
    const vPress = st.pressMark[V0] ?? 'press_spot';
    const back = locoDur(V0, 'walk', vPress, st.victimBack), run = locoDur(V0, 'run', st.victimBack, st.giantFront);
    if (!has('threat')) { need.leap = 0.6 + back + 0.12 + run + 0.12; need.instant_loss = 1.35 + back + 0.12 + run + 0.12; }
    else { need.leap = Math.max(1.55, 0.6 + back + 0.1); need.instant_loss = Math.max(2.25, 1.35 + back + 0.1); need.threat = 1.0 + run + 0.6; }
  }
  if (st.smartApproach) need.smart_attempt = Math.max(0.25 + 0.3 + locoDur(F, 'walk', st.start[F], st.smartApproach) + 0.1, 1.0) + 2.1;
  const dur: Record<string, number> = {};
  for (const b of head) dur[b.id] = Math.max(need[b.slot] ?? 0, Math.min(hi(b), Math.max(lo(b), b.approxDuration)));
  for (let it = 0; it < 8; it++) {
    const sum = head.reduce((a, b) => a + dur[b.id], 0);
    const want = target - tailSum;
    if (Math.abs(sum - want) < 0.01) break;
    const k = want / sum;
    for (const b of head) dur[b.id] = Math.max(need[b.slot] ?? 0, Math.min(hi(b), Math.max(lo(b), dur[b.id] * k)));
  }
  // premise + notice must cover the walk-in
  const premise = beats[0], notice = beats.find((b) => b.slot === 'notice');
  if (walkIn && notice && dur[premise.id] + dur[notice.id] < walkIn + 0.6) dur[notice.id] = r3(walkIn + 0.6 - dur[premise.id]);
  for (const b of beats) if (b.slot in TAIL) dur[b.id] = TAIL[b.slot];
  const beatTimes: Record<string, [number, number]> = {};
  let t = 0;
  for (const b of beats) { beatTimes[b.id] = [r3(t), r3(t + dur[b.id])]; t += dur[b.id]; }
  const D = r3(t);
  for (const b of beats) beatTimes[b.id] = [beatTimes[b.id][0], b === beats[beats.length - 1] ? D : beatTimes[b.id][1]];
  if (D < 14 || D > 22) err('DURATION', `compiled duration ${D}s outside 14-22 s`, null, null);
  if (Math.abs(D - target) > 0.5) notes.push(`duration ${D}s differs from target ${target}s (slot limits)`);

  // ---------- 2. timeline builder ----------
  const actions: EpisodeAction[] = [];
  const last: Record<string, EpisodeAction | undefined> = {};
  const exprs: Episode['expressions'] = [];
  const pe: Episode['propEvents'] = [];
  const vfx: Episode['vfx'] = [];
  const cues: Episode['audio']['cues'] = [];
  const events: KeyEvent[] = [];
  const act = (actor: string, action: string, start: number, duration: number, extra: Partial<EpisodeAction> = {}): EpisodeAction => {
    if ((ACTION_DEFS as Record<string, { layer?: boolean }>)[action]?.layer) { const a = { actor, action, start: r3(start), duration: r3(duration), ...extra } as EpisodeAction; actions.push(a); return a; }
    const prev = last[actor];
    if (prev && prev.start + prev.duration > start - 1e-6) {
      const nd = r3(start - prev.start);
      // actions with a contact point (press, facepalm...) are never shortened: that would move the contact frame
      const contact = (ACTION_DEFS as Record<string, { contactU?: number }>)[prev.action]?.contactU !== undefined;
      if (nd >= 0.1 && !contact) prev.duration = nd; else start = prev.start + prev.duration;
    }
    const a = { actor, action, start: r3(start), duration: r3(Math.max(0.1, duration)), ...extra } as EpisodeAction;
    actions.push(a); last[actor] = a;
    if (!['walk', 'run', 'chase', 'dive_prone', 'turn_toward'].includes(action)) lastWasLoco[actor] = false;
    return a;
  };
  const face = (actor: string, state: string | null | undefined, at: number) => { if (state) exprs.push({ actor, state: state as never, at: r3(at) }); };
  const prop = (p: string, event: string, start: number, duration: number, extra: Record<string, unknown> = {}) => pe.push({ prop: p, event: event as never, start: r3(start), duration: r3(duration), ...extra } as never);
  const fx = (type: string, at: number, duration: number, target?: string, params?: Record<string, number | string | boolean>) => vfx.push({ type: type as never, at: r3(at), duration: r3(duration), ...(target ? { target } : {}), ...(params ? { params } : {}) });
  const sfx = (id: string, at: number, gainDb: number, extra: { pitch?: number; sync?: string } = {}) => cues.push({ sfx: id, at: r3(at), gainDb, ...extra });
  const hold = (actor: string, action: string, start: number, target: string, expression?: string | null) => act(actor, action, start, D - start, { target, ...(expression ? { expression: expression as never } : {}) });
  // facing bookkeeping: after arriving, the next non-locomotion action turns the actor to the mark's facing
  const yawNow: Record<string, number> = {}, lastWasLoco: Record<string, boolean> = {};
  const yawTo = (a: string, b: string) => Math.atan2(mark(b)[0] - mark(a)[0], mark(b)[2] - mark(a)[2]) * 180 / Math.PI;
  const wrap = (d: number) => ((d + 540) % 360) - 180;
  /** locomotion with an in-place pre-turn when the heading change exceeds 50 deg (avoids planted-foot drag) */
  const loco = (actor: string, kind: string, start: number, from: string, to: string, extra: Partial<EpisodeAction> = {}) => {
    const cur = lastWasLoco[actor] ? yawNow[actor] : env.marks[from]?.facingDeg ?? 0;
    const want = yawTo(from, to);
    if (Math.abs(wrap(want - cur)) > 50 && kind !== 'dive_prone') { act(actor, 'turn_toward', start, 0.3, { target: to }); start += 0.3; }
    const d = locoDur(actor, kind, from, to); act(actor, kind, start, d, { to, ...extra });
    yawNow[actor] = want; lastWasLoco[actor] = true;
    return start + d;
  };
  const press = (actor: string, start: number, expression: string | null | undefined, beatId: string) => {
    act(actor, 'press_button', start, 0.9, { target: 'button.press_surface', ...(expression ? { expression: expression as never } : {}) });
    const c = r3(start + 0.9 * (ACTION_DEFS.press_button.contactU ?? 0.42));
    prop('button', 'press', c - 0.028, 0.5); prop('button', 'flash', c, 0.5, { params: { hz: 8 } }); prop('button', 'reset', c + 0.47, 0.3);
    sfx('sfx_click', c, -4, { sync: `contact:${actor}:press_button` });
    events.push({ beatId, kind: 'press_contact', t: c, actor });
    return c;
  };
  let coinScale = 1, coinStanding = false, firstPress = Infinity, impact = D - 2.75, tipStart = 0, wobbleStart = -1, shadowFrom = -1;
  const grow = (at: number, scale: number, d: number, pitch: number, beatId: string) => { prop('coin', 'grow', at, d, { params: { scale } }); sfx('sfx_boing', at, -7, { pitch }); fx('sparkle_burst', at, 0.45, 'coin', { count: 20 + Math.round(scale), speed: 1.2 + scale / 10, size: 0.03 + scale / 300 }); coinScale = scale; events.push({ beatId, kind: `grow_${scale}`, t: at + d }); };
  const standUp = (at: number) => { if (coinStanding) return; prop('coin', 'stand_up', at, 0.3); sfx('sfx_whoosh', at, -16); coinStanding = true; };
  const reactor = (b: PlanBeat, at: number, fallback: string) => {
    if (!b.reactor) return;
    const a = b.reactor.action !== 'none' ? b.reactor.action : null;
    if (a && ['shock_recoil', 'arms_crossed', 'look_at', 'laugh'].includes(a)) act(b.reactor.actor, a, at, a === 'laugh' ? D - at : 0.8, { ...(a !== 'laugh' ? { target: a === 'arms_crossed' ? b.actor : fallback } : {}), ...(b.reactor.expression ? { expression: b.reactor.expression as never } : {}) });
    else face(b.reactor.actor, b.reactor.expression, at);
  };

  // cast start
  const cast = [P, F].map((id, i) => ({ id, version: man(id).version, role: (i === 0 ? 'protagonist' : 'foil') as 'protagonist' | 'foil', startMark: st.start[id], startExpression: faceOf(id, i === 0 ? 'neutral' : 'smug') as never }));
  if (walkIn) loco(P, 'walk', 0, st.start[P], st.walkIn[P]!);
  let pAt = st.walkIn[P] ?? st.start[P];
  let fAt = st.start[F];
  let victimAt = '';

  for (const b of beats) {
    const [s, e] = beatTimes[b.id];
    const d = e - s;
    const A = b.actor;
    switch (b.slot) {
      case 'premise':
        sfx('sfx_beep', s + 0.05, -14); sfx('sfx_beep', s + 0.45, -16);
        break;
      case 'notice': {
        const start = Math.max(s, walkIn ? walkIn : s);
        const target = 'button';
        act(A, b.action, start, Math.max(0.6, e - start), { target, ...(b.expressionAfter ? { expression: b.expressionAfter as never } : {}) });
        if (b.emote) { fx('emote', s + 0.25, 0.8, A, { symbol: b.emote }); sfx('sfx_blip_question', s + 0.25, -10); }
        if (e - start > 1.3 && b.action === 'look_at') act(A, 'curious_lean', start + (e - start) * 0.55, (e - start) * 0.45, { target: 'button' });
        if (walkIn && walkIn > e - 0.3) err('WALK_TOO_LONG', `walk-in (${walkIn}s) does not finish inside the notice beat`, b.id, 'approxDuration', [r3(d + 0.5)]);
        break;
      }
      case 'foil_notice':
        act(A, b.action === 'none' ? 'look_at' : b.action, s + 0.05, d, { target: 'button', ...(b.expressionAfter ? { expression: b.expressionAfter as never } : {}) });
        if (b.emote) { fx('emote', s + 0.15, 0.7, A, { symbol: b.emote }); sfx('sfx_blip_question', s + 0.15, -11, { pitch: 1.25 }); }
        break;
      case 'warn':
        act(A, b.action, s + 0.05, d + 0.4, { target: b.action === 'point' ? 'button' : P, ...(b.expressionAfter ? { expression: b.expressionAfter as never } : {}) });
        if (b.action !== 'head_shake') act(A, 'head_shake', s + 0.3, 0.7);
        if (b.emote) { fx('emote', s + 0.2, 0.8, A, { symbol: b.emote }); sfx('sfx_blip_dots', s + 0.2, -12); }
        if (pAt === st.pressMark[P]) act(P, 'curious_lean', s + 0.05, d, { target: 'button' });
        break;
      case 'race': {
        const pEnd = loco(P, 'run', s + 0.05, pAt, st.raceTo[P], b.expressionAfter ? { expression: b.expressionAfter as never } : {});
        const fEnd = loco(F, 'chase', s + 0.2, fAt, st.raceTo[F], b.reactor?.expression ? { expression: b.reactor.expression as never } : {});
        pAt = st.raceTo[P]; fAt = st.raceTo[F];
        sfx('sfx_whoosh', s + 0.05, -12); fx('speed_lines', s + 0.1, Math.min(0.8, pEnd - s - 0.1), P);
        if (Math.max(pEnd, fEnd) > e - 0.05) err('RACE_TOO_SHORT', `race needs ${r3(Math.max(pEnd, fEnd) - s + 0.1)}s`, b.id, 'approxDuration', [r3(Math.max(pEnd, fEnd) - s + 0.15)]);
        act(P, 'look_at', pEnd + 0.02, e - pEnd, { target: 'button' });
        act(F, 'look_at', fEnd + 0.02, e - fEnd, { target: P });
        break;
      }
      case 'attempt_fail': {
        firstPress = Math.min(firstPress, s + 0.1);
        const c = press(A, s + 0.1, b.expressionBefore, b.id);
        sfx('sfx_beep', c + 0.12, -18, { pitch: 0.6 });
        face(A, b.expressionAfter, c + 0.55);
        if (b.emote) { fx('emote', c + 0.5, 0.7, A, { symbol: b.emote }); sfx('sfx_blip_dots', c + 0.5, -13); }
        reactor(b, c + 0.6, A);
        act(A, 'look_at', s + 1.0, e - s - 1.0, { target: 'button' });
        break;
      }
      case 'press_reward': {
        firstPress = Math.min(firstPress, s + 0.15);
        sfx('sfx_whoosh', s + 0.05, -14);
        const c = press(A, s + 0.15, b.expressionAfter ?? b.expressionBefore, b.id);
        prop('coin', 'spawn', c + 0.07, 1.0, { to: 'desk.coin_spot', params: { from: 'button.spawn_point', flight: 0.5, flips: 1 } });
        fx('screen_flash', c, 0.16, undefined, { strength: 0.35 });
        fx('sparkle_burst', c + 0.07, 0.5, 'button.sparkle', { count: 24 });
        fx('sparkle_burst', c + 0.56, 0.55, 'desk.coin_spot', { count: 18, speed: 0.8, size: 0.03 });
        sfx('sfx_coin_pop', c + 0.07, -8); sfx('sfx_coin_ding', c + 0.56, -6);
        events.push({ beatId: b.id, kind: 'coin_spawn', t: c + 0.07 });
        act(A, 'look_at', s + 1.05, Math.max(0.3, e - s - 1.05), { target: 'coin' });
        if (A !== F && fAt) face(F, faceOf(F, 'surprised'), c + 0.3);
        if (A === F) face(P, faceOf(P, 'surprised'), c + 0.3);
        break;
      }
      case 'reward_reveal':
        prop('coin', 'spin', s + 0.3, Math.min(0.9, d - 0.1), { params: { degPerSec: 420 } }); prop('coin', 'flash', s + 0.4, Math.min(0.6, d - 0.3), { params: { hz: 3 } });
        act(A, b.action === 'none' ? 'look_at' : b.action, s + 0.05, d, { target: 'coin', ...(b.expressionAfter ? { expression: b.expressionAfter as never } : {}) });
        sfx('sfx_coin_spin', s + 0.3, -14); sfx('sfx_sparkle', s + 0.4, -14);
        break;
      case 'celebrate': {
        const dd = b.action === 'jump' ? 0.8 : b.action === 'laugh' ? d : 1.2;
        act(A, b.action, s + 0.05, dd, b.expressionAfter ? { expression: b.expressionAfter as never } : {});
        fx('confetti', s + 0.2, 1.2, `${A}.above_head`, { count: 40 }); sfx('sfx_tada', s + 0.15, -8);
        const other = A === P ? F : P;
        if (plan.engine === 'noob_vs_smart') face(F, b.reactor?.expression ?? faceOf(F, 'smug'), s + 0.2);
        if (plan.engine === 'noob_vs_smart') {
          act(F, 'arms_crossed', s + 0.2, d, { target: 'coin' });
        } else if (b.reactor) act(other, 'arms_crossed', s + 0.2, d + 0.6, { target: 'coin', ...(b.reactor.expression ? { expression: b.reactor.expression as never } : {}) });
        break;
      }
      case 'smart_attempt': {
        // the noob yields the only reachable press position; the smart character steps in and double-presses
        const exitEnd = loco(P, 'walk', s, pAt, st.noobExit!, { expression: (b.reactor?.expression ?? faceOf(P, 'curious')) as never });
        pAt = st.noobExit!;
        act(P, 'look_at', exitEnd + 0.02, 0.5, { target: 'coin' });
        const inEnd = loco(A, 'walk', s + 0.25, fAt, st.smartApproach!, b.expressionBefore ? { expression: b.expressionBefore as never } : {});
        fAt = st.smartApproach!;
        const p1 = Math.max(inEnd + 0.1, s + 1.0);
        const c1 = press(A, p1, b.expressionBefore, b.id);
        standUp(c1 + 0.1);
        const c2 = press(A, p1 + 1.0, b.expressionBefore, b.id);
        grow(c2 + 0.1, 3, 0.3, 1.3, b.id);
        face(A, b.expressionAfter, c2 + 0.45);
        fx('emote', c2 + 0.35, 0.6, A, { symbol: '!' });
        act(P, 'look_at', exitEnd + 0.55, Math.max(0.3, e - exitEnd - 0.55), { target: 'coin' });
        act(A, 'shock_recoil', p1 + 1.92, Math.max(0.4, e - p1 - 1.92), { target: 'coin' }); // startled back from the rising coin (never peers into it)
        if (p1 + 2.0 > e) err('SMART_TOO_SHORT', `smart attempt needs ${r3(p1 + 2.1 - s)}s`, b.id, 'approxDuration', [r3(p1 + 2.2 - s)]);
        break;
      }
      case 'escalate': {
        if (!coinStanding) standUp(s + 0.05);
        const ladder = coinScale < 3 ? [3, 6] : coinScale < 6 ? [6] : [coinScale + 1];
        ladder.forEach((sc, i) => grow(s + 0.4 + i * 0.4, sc, 0.3, [1.3, 1.0][i] ?? 0.9, b.id));
        const shockAt = s + 0.7;
        act(V, 'shock_recoil', shockAt, 1.0, { target: 'coin', expression: (b.reactor?.actor === V && b.reactor.expression ? b.reactor.expression : faceOf(V, 'shock')) as never });
        act(O, 'shock_recoil', shockAt + 0.05, 0.65, { target: 'coin', expression: faceOf(O, 'surprised') as never });
        fx('emote', s + 0.65, 0.75, V, { symbol: '!' }); fx('emote', s + 0.8, 0.6, O, { symbol: '!' });
        break;
      }
      case 'leap': case 'instant_loss': {
        let t0 = s;
        if (b.slot === 'instant_loss') {
          standUp(s + 0.05);
          grow(s + 0.4, 6, 0.3, 1.1, b.id);
          act(V, 'shock_recoil', s + 0.45, 0.6, { target: 'coin', expression: faceOf(V, 'shock') as never });
          act(O, 'shock_recoil', s + 0.5, 0.5, { target: 'coin', expression: faceOf(O, 'surprised') as never });
          fx('emote', s + 0.45, 0.6, V, { symbol: '!' });
          t0 = s + 0.8;
        }
        prop('coin', 'hop_to', t0, 0.55, { to: st.giantSpot, params: { height: 1.5 } });
        const land = t0 + 0.55;
        events.push({ beatId: b.id, kind: 'coin_land', t: land });
        sfx('sfx_whoosh', t0, -10, { pitch: 0.8 }); sfx('sfx_thud_small', land, -6, { sync: 'impact:coin:land' });
        fx('impact_ring', land, 0.4, st.giantSpot, { size: 0.9 }); fx('dust_puff', land, 0.6, st.giantSpot, { radius: 0.9 }); fx('screen_shake', land, 0.3, undefined, { strength: 0.03 });
        grow(land + 0.05, 11, 0.3, 0.75, b.id);
        grow(land + 0.45, 16.7, 0.4, 0.55, b.id);
        fx('screen_shake', land + 0.45, 0.35, undefined, { strength: 0.04 }); fx('screen_shake', land + 0.9, 0.45, undefined, { strength: 0.06 });
        // observer escapes, victim backs away from the desk
        let from = O === P ? pAt : fAt, oT = t0 + 0.15;
        for (const to of st.observerEscape) { oT = loco(O, 'run', oT, from, to, { expression: faceOf(O, 'surprised') as never }) + 0.02; from = to; }
        act(O, 'look_at', oT, D - oT, { target: 'coin' });
        const vFrom = V === P ? pAt : fAt;
        const vw = loco(V, 'walk', Math.max(t0 + 0.3, s + (b.slot === 'instant_loss' ? 1.05 : 0.3)), vFrom, st.victimBack);
        victimAt = st.victimBack;
        act(V, 'look_at', vw + 0.02, 0.4, { target: 'look_up_point' });
        if (!has('threat')) {
          const runStart = Math.max(vw + 0.1, e - locoDur(V, 'run', st.victimBack, st.giantFront) - 0.05);
          const runEnd = loco(V, 'run', runStart, st.victimBack, st.giantFront, { expression: faceOf(V, 'determined') as never });
          victimAt = st.giantFront;
          if (runEnd > e + 0.02) err('APPROACH_TOO_SHORT', `victim approach needs ${r3(runEnd - s + 0.1)}s`, b.id, 'approxDuration', [r3(runEnd - s + 0.15)]);
          wobbleStart = Math.max(land + 0.9, runStart);
        }
        if (Math.max(oT, vw) > e + 0.4) err('LEAP_TOO_SHORT', 'observer/victim moves overrun the beat', b.id, 'approxDuration', [r3(d + 0.4)]);
        shadowFrom = land + 0.5;
        break;
      }
      case 'threat': {
        face(V, b.expressionBefore ?? faceOf(V, 'shock'), s);
        fx('emote', s + 0.15, 0.9, V, { symbol: '!' }); sfx('sfx_rumble', s, -12);
        face(V, b.expressionAfter ?? faceOf(V, 'determined'), s + 0.65); sfx('sfx_blip_question', s + 0.65, -12, { pitch: 1.5 });
        const runEnd = loco(V, 'run', s + 1.0, victimAt || st.victimBack, st.giantFront, { expression: (b.expressionAfter ?? faceOf(V, 'determined')) as never });
        victimAt = st.giantFront;
        act(V, 'look_at', runEnd + 0.02, 0.5, { target: 'look_up_point', expression: faceOf(V, 'shock') as never });
        if (runEnd > e - 0.1) err('THREAT_TOO_SHORT', `threat run ends at ${r3(runEnd - s)}s of ${r3(d)}s`, b.id, 'approxDuration', [r3(runEnd - s + 0.6)]);
        wobbleStart = s + 1.0;
        sfx('sfx_creak', s + 1.0, -10); sfx('sfx_creak', e - 0.2, -9, { pitch: 0.85 });
        if (shadowFrom < 0) shadowFrom = s;
        break;
      }
      case 'reversal': {
        act(V, 'cower', s, 0.9);
        act(V, 'dive_prone', s + 0.9, 0.7, { to: st.diveEnd, params: { diveAt: 0.15 }, expression: (b.expressionBefore ?? faceOf(V, 'shock')) as never });
        tipStart = s + 1.0; impact = r3(tipStart + 0.65);
        prop('coin', 'tip_over', tipStart, 0.65, { params: { endDeg: 86 } });
        events.push({ beatId: b.id, kind: 'reversal_impact', t: impact });
        fx('screen_shake', impact, 0.6, undefined, { strength: 0.12 }); fx('screen_flash', impact, 0.12, undefined, { strength: 0.25 });
        fx('dust_puff', impact, 0.9, 'coin', { radius: 2.2, count: 44, size: 0.3 }); fx('impact_ring', impact, 0.45, 'coin', { size: 2.0 });
        sfx('sfx_whoosh', s + 0.95, -8, { pitch: 0.6 }); sfx('sfx_thud_big', impact, -1, { sync: 'impact:coin:tip_over' }); sfx('sfx_coin_ding', impact + 0.05, -12, { pitch: 0.5 });
        face(V, b.expressionAfter ?? faceOf(V, 'regret'), impact + 0.3);
        if (b.reactor) act(b.reactor.actor, b.reactor.action === 'none' ? 'laugh' : b.reactor.action, impact + 0.1, D - impact - 0.1, b.reactor.expression ? { expression: b.reactor.expression as never } : {});
        if (wobbleStart >= 0) prop('coin', 'wobble', wobbleStart, Math.max(0.3, tipStart - wobbleStart - 0.02), { params: { hz: 2.2, deg: 5 } });
        break;
      }
      case 'payoff':
        sfx('sfx_deflate_slide', s + 0.05, -12);
        if (b.expressionAfter) face(V, b.expressionAfter, s + 0.02);
        break;
      case 'loop': {
        const hz = r3(Math.max(1, Math.round(2.5 * d)) / d);
        prop('button', 'flash', s, d, { params: { hz, endGlow: 1 } });
        fx('sparkle_burst', s + 0.05, 0.6, 'button.sparkle', { count: 16, speed: 0.9 });
        sfx('sfx_ding_reset', s + 0.02, -7); sfx('sfx_beep', s + 0.4, -14); sfx('sfx_beep', s + 0.76, -15);
        break;
      }
    }
  }
  // meaningful-change filler: close any gap > 1.3 s with a real, visible micro-action (glance / glint), never a cut
  {
    const evs = () => [...actions.map((x) => x.start), ...exprs.map((x) => x.at), ...pe.map((x) => x.start), ...vfx.map((x) => x.at), ...beats.map((b) => beatTimes[b.id][0])].sort((a, b) => a - b).concat([D]);
    for (let guard = 0; guard < 12; guard++) {
      const ts = evs(); let gi = -1;
      for (let i = 1; i < ts.length; i++) if (ts[i] - ts[i - 1] > 1.3) { gi = i; break; }
      if (gi < 0) break;
      const at = r3(ts[gi - 1] + (ts[gi] - ts[gi - 1]) / 2);
      const bid = beats.find((b) => at >= beatTimes[b.id][0] && at < beatTimes[b.id][1])!;
      if (at < impact - 0.3 && pe.some((x) => x.prop === 'coin' && x.event === 'spawn' && x.start < at - 1)) { prop('coin', 'flash', at, 0.4, { params: { hz: 3 } }); fx('sparkle_burst', at, 0.35, 'coin', { count: 8, speed: 0.5, size: 0.02 }); }
      else fx('sparkle_burst', at, 0.35, 'button.sparkle', { count: 8, speed: 0.5, size: 0.02 });
      notes.push(`filler glint at ${at}s in ${bid.id}`);
    }
  }
  // premise flash + glow until just before the first press
  const flashEnd = r3(Math.min(firstPress - 0.12, D));
  if (flashEnd > 0.5) { prop('button', 'flash', 0, flashEnd, { params: { hz: 2.5 } }); fx('glow_pulse', 0, flashEnd, 'button.glow', { hz: 2.5, intensity: 0.6 }); }
  if (shadowFrom >= 0) fx('shadow_looming', shadowFrom, Math.max(0.5, impact - shadowFrom + 0.05), undefined, { rampIn: Math.max(0.5, impact - shadowFrom - 0.8), strength: 0.28, fadeOut: 0.35 });
  if (impact < D - 3 || impact > D - 0.8) err('REVERSAL_WINDOW', `reversal impact at ${impact}s must be in [${r3(D - 3)}, ${r3(D - 0.8)}]`, beats.find((b) => b.slot === 'reversal')?.id ?? null, 'approxDuration');
  if (errors.length) return { ok: false, errors, notes };

  // ---------- 3. shots ----------
  const sp = planShots(plan, beatTimes);
  if (sp.errors.length) return { ok: false, errors: sp.errors, notes };
  const shots: Episode['shots'] = sp.shots.map((x, i) => ({ id: `s${String(i + 1).padStart(2, '0')}`, start: r3(x.from), end: r3(x.to), preset: x.preset as never, subjects: x.subjects, purpose: x.purpose.slice(0, 120), params: x.params }));
  shots[0].start = 0; shots[shots.length - 1].end = D;
  // ---------- 4. assemble ----------
  const slug = req.idea.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').split('-').slice(0, 4).join('-') || 'idea';
  const idHash = (hashSeed(req.idea) % 46656).toString(36);
  const epId = `gen-${ENGINE_ABBR[plan.engine]}-${slug}-${idHash}-s${req.seed}`.slice(0, 64).replace(/-+$/, '');
  const ep: Episode = {
    schemaVersion: '1.0',
    episode: { id: epId, title: plan.title.slice(0, 80), logline: plan.logline.slice(0, 280), duration: D, format: 'vertical', resolution: [1080, 1920], fps: 30, seed: req.seed, comedyEngine: ({ ordinary_object_extreme: 'escalation_backfire', visible_secret_chase: 'too_good_to_be_true', apparent_win_instant_loss: 'too_good_to_be_true', noob_vs_smart: 'skeptic_reversal' } as const)[plan.engine] },
    environment: { id: env.id, version: env.version, lighting: 'morning' },
    cast: cast as never,
    props: [
      { instance: 'desk', id: reg.props.desk.id, version: reg.props.desk.version, anchor: 'hero_desk_spot', hero: false, visible: true, scale: 1 },
      { instance: 'button', id: reg.props.button.id, version: reg.props.button.version, anchor: 'button_spot', parent: 'desk', hero: true, visible: true, scale: 1 },
      { instance: 'coin', id: reg.props.coin.id, version: reg.props.coin.version, anchor: st.giantSpot, hero: false, visible: false, scale: 1 },
    ],
    beats: beats.map((b) => ({ id: b.id, start: beatTimes[b.id][0], end: beatTimes[b.id][1], intent: SLOT_SPECS[b.slot].intent, summary: b.visibleChange.slice(0, 160), informationChange: SLOT_SPECS[b.slot].infoChange })),
    actions: actions.sort((a, b) => a.start - b.start || (a.actor < b.actor ? -1 : 1)),
    expressions: exprs.sort((a, b) => a.at - b.at),
    propEvents: pe.sort((a, b) => a.start - b.start),
    shots,
    vfx: vfx.sort((a, b) => a.at - b.at),
    audio: { cues: cues.sort((a, b) => a.at - b.at), music: { id: 'mus_spark_bounce', gainDb: -20 }, ambience: { id: 'amb_classroom', gainDb: -34 }, loudnessLufs: -14, duckingDb: 6 },
    loop: { mode: 'match_cut', firstShot: shots[0].id, lastShot: shots[shots.length - 1].id, matchWindow: 0.5 },
    export: { container: 'mp4', videoCodec: 'h264', audioCodec: 'aac', videoBitrateKbps: 12000, audioBitrateKbps: 160 },
    safety: { familySafe: true, usesThirdPartyBrands: false, realMoneyOrGiveawayClaims: false, notes: `Generated from a user idea by the BlockSpark story pipeline; safety classification: ${idea.safety.classification}. Fictional in-world coins only.`.slice(0, 400) },
  };
  return { ok: true, episode: ep, beatTimes, events, notes };
}
