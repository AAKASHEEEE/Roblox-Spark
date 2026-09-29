// Story-generation gates (S01-S11) + the muted-story heuristic. Computed from the compiled episode, the semantic
// plan, compile-time key events and (when available) the browser analysis pass. These are HEURISTICS about
// readability/causality — they do not and cannot prove an episode is funny or understood by people.
import type { Episode } from '../../schema/src/episode.ts';
import type { KeyEvent } from './compile.ts';
import type { VisualBeatPlan } from './schemas.ts';
import { TEMPLATES } from './templates.ts';

export interface StoryGate { id: string; name: string; pass: boolean; kind: 'measured' | 'proxy' | 'static'; detail: string; group: 'story'; beatId?: string | null; field?: string | null }
export interface AnalysisLite {
  frames: Array<{ t: number; shot: string; issues: Array<{ code: string; message: string; subject?: string }>; cam: number[]; screen?: Record<string, { area: number; cx: number; cy: number; visible: boolean }> }>;
  probes: Array<{ t: number; actors: Record<string, { root: number[]; head: number[] }>; props: Record<string, { pos: number[]; visible: boolean; scale: number }> }>;
}

const REACTION_TYPES = new Set(['shock_recoil', 'cower', 'laugh', 'victory_pose', 'facepalm', 'regret_freeze', 'head_shake', 'arms_crossed', 'curious_lean', 'look_at', 'angry_stomp', 'jump']);

export function storyGates(ep: Episode, plan: VisualBeatPlan, events: KeyEvent[], a?: AnalysisLite | null): StoryGate[] {
  const G: StoryGate[] = [];
  const g = (id: string, name: string, pass: boolean, kind: StoryGate['kind'], detail: string, beatId: string | null = null, field: string | null = null) => G.push({ id, name, pass, kind, detail, group: 'story', beatId, field });
  const D = ep.episode.duration;
  const s0 = ep.shots[0];
  const beatAt = (t: number) => ep.beats.find((b) => t >= b.start && t < b.end)?.id ?? ep.beats[ep.beats.length - 1].id;
  // S01 opening readability
  let s01 = s0.start === 0 && s0.preset === 'prop_ecu' && s0.subjects.includes('button') && s0.end <= 1.5;
  let s01d = `opening shot ${s0.preset} on ${s0.subjects.join('+')} for ${s0.end}s`;
  if (a) { const f = a.frames.find((x) => x.t >= 0.4); const sc = f?.screen?.button; if (sc) { s01 = s01 && sc.visible && sc.area >= 0.05; s01d += `; button covers ${(sc.area * 100).toFixed(1)}% of frame at t=${f!.t.toFixed(2)}`; } }
  g('S01', 'Opening readability (premise prop fills the first second)', s01, a ? 'measured' : 'static', s01d, 'b01', s0.end > 1.5 ? 'approxDuration' : 'shotHint');
  // S02 causal-prop visibility at every press contact
  const presses = events.filter((e) => e.kind === 'press_contact');
  const vis = presses.map((p) => {
    const shot = ep.shots.find((s) => p.t >= s.start && p.t < s.end)!;
    const f = a?.frames.reduce((best, x) => (Math.abs(x.t - p.t) < Math.abs(best.t - p.t) ? x : best), a.frames[0]);
    const occluded = !!a?.frames.some((x) => Math.abs(x.t - p.t) < 0.05 && x.issues.some((i) => i.code === 'PROP_OCCLUDED'));
    const onScreen = (f?.screen?.button ? f.screen.button.visible : shot.subjects.includes('button')) && !occluded;
    return { t: p.t, ok: onScreen && (shot.subjects.includes('button') || shot.subjects.includes(p.actor ?? '')), shot: shot.id };
  });
  const bad02 = vis.find((x) => !x.ok);
  g('S02', 'Causal prop visible at every cause (press contact)', !bad02, a ? 'measured' : 'static', vis.map((x) => `${x.t.toFixed(2)}s ${x.shot} ${x.ok ? 'ok' : 'NOT VISIBLE'}`).join('; ') || 'no presses', bad02 ? beatAt(bad02.t) : null, 'shotHint');
  // S03 character introduction: protagonist framed by 3 s; foil framed within the first 45% (before the escalation)
  const firstShotOf = (id: string) => ep.shots.find((s) => s.subjects.includes(id))?.start ?? Infinity;
  const pIntro = firstShotOf(plan.roles.protagonist), fIntro = firstShotOf(plan.roles.foil);
  const introBeat = plan.beats.find((b) => b.slot === 'celebrate') ?? plan.beats[1];
  g('S03', 'Characters introduced before they matter', pIntro <= 3.0 && fIntro <= 0.45 * D, 'static', `protagonist ${plan.roles.protagonist} first framed at ${pIntro.toFixed(2)}s (<= 3.0); foil ${plan.roles.foil} at ${fIntro.toFixed(2)}s (<= ${(0.45 * D).toFixed(2)})`, pIntro > 3 ? 'b02' : introBeat.id, 'shotHint');
  // S04 cause/result ordering
  const chain = ['press_contact', 'coin_spawn', 'grow_3', 'coin_land', 'reversal_impact'];
  const tOf = (k: string) => events.filter((e) => e.kind === k).map((e) => e.t);
  const lastPress = Math.max(...tOf('press_contact'));
  const spawn = Math.min(...tOf('coin_spawn'));
  const order: string[] = [];
  let ok04 = spawn > Math.min(...tOf('press_contact')) && spawn - Math.max(...tOf('press_contact').filter((x) => x < spawn)) <= 0.6;
  order.push(`press ${Math.min(...tOf('press_contact')).toFixed(2)} -> spawn ${spawn.toFixed(2)}`);
  const land = Math.min(...tOf('coin_land')), imp = Math.min(...tOf('reversal_impact'));
  ok04 = ok04 && land < imp && spawn < land;
  order.push(`spawn -> land ${land.toFixed(2)} -> impact ${imp.toFixed(2)}`);
  for (const b of plan.beats) if (b.causeBeatId) { const cb = plan.beats.find((x) => x.id === b.causeBeatId); if (!cb || cb.id >= b.id) { ok04 = false; order.push(`${b.id} cause ${b.causeBeatId} invalid`); } }
  void chain; void lastPress;
  g('S04', 'Every cause precedes its result (press->coin->growth->impact)', ok04, 'static', order.join('; '));
  // S05 reaction timing: a face change / emote / reaction action within 0.9 s after each information event
  const info = events.filter((e) => ['coin_spawn', 'grow_6', 'grow_16.7', 'coin_land', 'reversal_impact'].includes(e.kind) || (e.kind.startsWith('grow_') && e.kind === 'grow_3'));
  const reacts = [...ep.expressions.map((x) => x.at), ...ep.vfx.filter((v) => v.type === 'emote').map((v) => v.at), ...ep.actions.filter((x) => REACTION_TYPES.has(x.action) || x.expression).map((x) => x.start)];
  const late = info.filter((e) => !reacts.some((r) => r >= e.t - 0.35 && r <= e.t + 0.9));
  g('S05', 'Reaction within 0.9 s of every information change', late.length === 0, 'static', late.length ? `no reaction after ${late.map((e) => `${e.kind}@${e.t.toFixed(2)}`).join(', ')}` : `${info.length} information events all followed by a reaction`, late[0] ? beatAt(late[0].t) : null, 'reactor');
  // S06 reversal timing
  g('S06', 'Largest reversal lands in the final 3 s (and before the payoff)', imp >= D - 3 && imp <= D - 0.8, 'static', `impact ${imp.toFixed(2)}s, window [${(D - 3).toFixed(2)}, ${(D - 0.8).toFixed(2)}]`, plan.beats.find((b) => b.slot === 'reversal')?.id ?? null, 'approxDuration');
  // S07 loop framing similarity
  const last = ep.shots[ep.shots.length - 1];
  let ok07 = last.preset === 'final_loop' && JSON.stringify(last.subjects) === JSON.stringify(s0.subjects);
  let d07 = `last shot ${last.preset} on ${last.subjects.join('+')}`;
  if (a && a.frames.length > 1) {
    const f0 = a.frames[0], fl = a.frames[a.frames.length - 1];
    const dp = Math.hypot(f0.cam[0] - fl.cam[0], f0.cam[1] - fl.cam[1], f0.cam[2] - fl.cam[2]);
    ok07 = ok07 && dp < 0.08; d07 += `; camera position difference first/last analysed frame ${(dp * 100).toFixed(1)} cm`;
  }
  g('S07', 'Final composition matches the opening (loop)', ok07, a ? 'measured' : 'static', d07, plan.beats[plan.beats.length - 1].id, 'shotHint');
  // S08 long static intervals (timeline events + measured motion)
  const evT = [...ep.shots.map((s) => s.start), ...ep.actions.map((x) => x.start), ...ep.expressions.map((x) => x.at), ...ep.propEvents.map((x) => x.start), ...ep.vfx.map((x) => x.at)].filter((x) => x <= D).sort((x, y) => x - y).concat([D]);
  let gap = 0, gapAt = 0;
  for (let i = 1; i < evT.length; i++) if (evT[i] - evT[i - 1] > gap) { gap = evT[i] - evT[i - 1]; gapAt = evT[i - 1]; }
  let still = 0;
  if (a && a.probes.length > 1) {
    // longest run of consecutive frames with no actor/prop/camera movement > 5 mm
    let run = 0;
    for (let i = 1; i < a.probes.length; i++) {
      const p = a.probes[i], q = a.probes[i - 1];
      let moved = false;
      for (const id of Object.keys(p.actors)) if (Math.hypot(p.actors[id].head[0] - q.actors[id].head[0], p.actors[id].head[1] - q.actors[id].head[1], p.actors[id].head[2] - q.actors[id].head[2]) > 0.005) moved = true;
      for (const id of Object.keys(p.props)) if (p.props[id].visible && (Math.hypot(p.props[id].pos[0] - q.props[id].pos[0], p.props[id].pos[1] - q.props[id].pos[1], p.props[id].pos[2] - q.props[id].pos[2]) > 0.005 || p.props[id].scale !== q.props[id].scale)) moved = true;
      const tt = p.t;
      const active = ep.propEvents.some((x) => tt >= x.start && tt <= x.start + x.duration) || ep.vfx.some((x) => tt >= x.at && tt <= x.at + x.duration) || ep.shots.some((x) => tt >= x.start && tt < x.end && Number((x.params ?? {}).push ?? 0.06) > 0);
      run = moved || active ? 0 : run + 1;
      still = Math.max(still, run);
    }
  }
  const stillSec = still / ep.episode.fps;
  g('S08', 'No long static interval (events <= 1.5 s apart, no frozen motion > 1 s)', gap <= 1.5 && stillSec <= 1.0, a ? 'measured' : 'static', `longest event gap ${gap.toFixed(2)}s after t=${gapAt.toFixed(2)}; longest fully static run ${a ? stillSec.toFixed(2) + 's' : 'n/a'}`, gap > 1.5 ? beatAt(gapAt) : null, 'approxDuration');
  // S09 repeated camera presets
  let rep = '';
  for (let i = 1; i < ep.shots.length; i++) if (ep.shots[i].preset === ep.shots[i - 1].preset && ep.shots[i].subjects.join() === ep.shots[i - 1].subjects.join()) rep = `${ep.shots[i - 1].id}/${ep.shots[i].id}`;
  const counts: Record<string, number> = {};
  for (const s of ep.shots) counts[s.preset] = (counts[s.preset] ?? 0) + 1;
  const distinct = Object.keys(counts).length, maxShare = Math.max(...Object.values(counts)) / ep.shots.length;
  g('S09', 'Shot variety (no repeated consecutive setup, >= 5 presets, none > 40%)', !rep && distinct >= 5 && maxShare <= 0.4, 'static', `${ep.shots.length} shots, ${distinct} presets, max share ${(maxShare * 100).toFixed(0)}%${rep ? `, repeated ${rep}` : ''}`, null, 'shotHint');
  // S10 excessive character travel
  const travel: Record<string, number> = {};
  if (a && a.probes.length > 1) for (let i = 1; i < a.probes.length; i++) for (const id of Object.keys(a.probes[i].actors)) { const p = a.probes[i].actors[id].root, q = a.probes[i - 1].actors[id].root; travel[id] = (travel[id] ?? 0) + Math.hypot(p[0] - q[0], p[2] - q[2]); }
  const maxTravel = Math.max(0, ...Object.values(travel));
  g('S10', 'No excessive character travel (<= 10 m per actor)', maxTravel <= 10, a ? 'measured' : 'static', a ? Object.entries(travel).map(([k, v]) => `${k} ${v.toFixed(1)} m`).join(', ') : 'n/a without analysis', null, null);
  // S11 action/prop compatibility (compile-time guarantee re-checked on the timeline)
  const badAct = ep.actions.filter((x) => ['pick_up', 'hold', 'put_down', 'throw', 'drink', 'hover'].includes(x.action));
  const badPress = ep.actions.filter((x) => x.action === 'press_button' && x.target !== 'button.press_surface');
  g('S11', 'Actions compatible with props (no carry/throw/drink without attachment)', !badAct.length && !badPress.length, 'static', badAct.length || badPress.length ? `${[...badAct, ...badPress].map((x) => `${x.actor}.${x.action}`).join(', ')}` : 'all actions registered and prop-compatible');
  void TEMPLATES;
  return G;
}

/** 0-100 heuristic: share of muted-readability signals present (labelled heuristic in every report). */
export function mutedStoryScore(gates: StoryGate[], plan: VisualBeatPlan): number {
  const w: Record<string, number> = { S01: 15, S02: 15, S03: 10, S04: 15, S05: 15, S06: 10, S07: 5, S08: 10, S09: 5 };
  let s = 0, tot = 0;
  for (const [id, wt] of Object.entries(w)) { tot += wt; if (gates.find((x) => x.id === id)?.pass) s += wt; }
  const reactionBeats = plan.beats.filter((b) => b.expressionAfter || b.emote || b.reactor?.expression).length / plan.beats.length;
  return Math.round((s / tot) * 90 + reactionBeats * 10);
}
