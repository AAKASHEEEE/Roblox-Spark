// Episode validation: strict schema + semantic checks + safe automatic repairs.
// Never executes anything from the episode; the episode is inert data.
import { EpisodeSchema, LOCOMOTION_ACTIONS, type Episode } from '../../schema/src/episode.ts';
import { checkRenderDeclaration } from '../../schema/src/render-compat.ts';
import type { AudioManifest, CharacterManifest, EnvironmentManifest, PropManifest } from '../../schema/src/assets.ts';
import { ACTION_DEFS, ACTION_REQUIREMENTS, unmetRequirements } from '../../engine/src/animation/actions.ts';

export interface Lib {
  characters: Record<string, CharacterManifest>;
  props: Record<string, PropManifest>;
  environments: Record<string, EnvironmentManifest>;
  audio: Record<string, AudioManifest>;
}
export type Severity = 'error' | 'warning' | 'info';
export interface Finding { severity: Severity; code: string; message: string; path?: string }
export interface ValidationResult { ok: boolean; episode?: Episode; findings: Finding[]; repairs: string[]; metrics: Record<string, number>; profile?: ValidationProfile }

/**
 * Validation profiles.
 *  - story-episode (default): every check, including story structure — for anything meant to be published.
 *  - action-reel: diagnostic reels that exercise engine actions. Asset, reference, timeline, feasibility, causality,
 *    audio-sync and safety checks all apply; story-structure checks are NOT applicable and are reported as info.
 */
export type ValidationProfile = 'story-episode' | 'action-reel';
export const VALIDATION_PROFILES: readonly ValidationProfile[] = ['story-episode', 'action-reel'];
/** findings that judge story structure / editing (not applicable to diagnostic action reels) */
export const STORY_STRUCTURE_CODES: ReadonlySet<string> = new Set([
  'HERO_PROP', 'PREMISE_NOT_VISIBLE', 'SLOW_OPENING', 'STALE_STRETCH', 'NO_FACIAL_REACTION', 'NO_REVERSAL', 'REVERSAL_TOO_EARLY',
  'LOOP', 'BEAT_COVERAGE', 'SHOT_VARIETY', 'SHOT_TOO_SHORT', 'SHOT_TOO_LONG', 'UNUSED_PROP',
]);

/** Terms that must never appear (brand/trade-dress + platform-safety + family-safety). */
export const BANNED_TERMS = [
  'roblox', 'robux', 'rbx ', 'bloxburg', 'adopt me', 'brookhaven', 'fortnite', 'v-bucks', 'vbucks', 'minecraft', 'minecoins',
  'free robux', 'giveaway', 'link in bio', 'dm me', 'gift card', 'real money', 'cash app', 'paypal',
  'gun', 'pistol', 'rifle', 'blood', 'gore', 'kill', 'suicide', 'drugs', 'alcohol', 'beer', 'sexy', 'nude',
];
const ALLOWED_LICENSE_SOURCES = new Set(['original-procedural', 'original-authored', 'commissioned', 'licensed-commercial', 'cc0']);

export function findBannedTerms(texts: string[]): string[] {
  const hits = new Set<string>();
  for (const t of texts) {
    const s = ' ' + t.toLowerCase() + ' ';
    for (const b of BANNED_TERMS) {
      const re = new RegExp(`(^|[^a-z])${b.trim().replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}([^a-z]|$)`);
      if (re.test(s)) hits.add(b.trim());
    }
  }
  return [...hits];
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

export function validateEpisode(raw: unknown, lib: Lib, opts: { repair?: boolean; profile?: ValidationProfile } = {}): ValidationResult {
  const profile = opts.profile ?? 'story-episode';
  if (!VALIDATION_PROFILES.includes(profile)) throw new Error(`unknown validation profile ${JSON.stringify(profile)}`);
  const findings: Finding[] = [];
  const repairs: string[] = [];
  const na = (code: string) => profile === 'action-reel' && STORY_STRUCTURE_CODES.has(code);
  const err = (code: string, message: string, path?: string) => findings.push(na(code) ? { severity: 'info', code, message: `[not applicable: validation profile action-reel] ${message}`, path } : { severity: 'error', code, message, path });
  const warn = (code: string, message: string, path?: string) => findings.push(na(code) ? { severity: 'info', code, message: `[not applicable: validation profile action-reel] ${message}`, path } : { severity: 'warning', code, message, path });
  const info = (code: string, message: string) => findings.push({ severity: 'info', code, message });

  // rendering compatibility first: a missing/unsupported declaration is reported with its own code, never defaulted
  const compat = checkRenderDeclaration(raw);
  if (!compat.ok) { err(compat.code, compat.message, compat.path); return { ok: false, findings, repairs, metrics: {} }; }
  const parsed = EpisodeSchema.parse(raw);
  if (!parsed.ok) {
    for (const i of parsed.issues) err('SCHEMA', i.message, i.path);
    return { ok: false, findings, repairs, metrics: {} };
  }
  const ep: Episode = JSON.parse(JSON.stringify(parsed.value));
  const D = ep.episode.duration;
  const fps = ep.episode.fps;
  const frame = 1 / fps;

  // ---------- assets / licensing ----------
  const env = lib.environments[`${ep.environment.id}@${ep.environment.version}`];
  if (!env) err('MISSING_ASSET', `environment ${ep.environment.id}@${ep.environment.version} not in library`);
  else if (!env.lighting[ep.environment.lighting]) err('MISSING_ASSET', `lighting preset ${ep.environment.lighting} not defined for ${env.id}`);
  const chars = new Map<string, CharacterManifest>();
  for (const c of ep.cast) {
    const m = lib.characters[`${c.id}@${c.version}`];
    if (!m) { err('MISSING_ASSET', `character ${c.id}@${c.version} not in library`); continue; }
    if (chars.has(c.id)) err('DUPLICATE_CAST', `${c.id} cast twice`);
    chars.set(c.id, m);
    if (!m.allowedExpressions.includes(c.startExpression as never)) err('INVALID_EXPRESSION', `${c.id} cannot use expression ${c.startExpression}`);
    if (env && !env.marks[c.startMark]) err('UNKNOWN_MARK', `${c.id} start mark ${c.startMark} not in ${env.id}`);
  }
  const props = new Map<string, PropManifest>();
  for (const p of ep.props) {
    const m = lib.props[`${p.id}@${p.version}`];
    if (!m) { err('MISSING_ASSET', `prop ${p.id}@${p.version} not in library`); continue; }
    if (m.status !== 'ready') err('ASSET_NOT_READY', `prop ${p.id}@${p.version} is ${m.status}`);
    if (props.has(p.instance)) err('DUPLICATE_PROP', `prop instance ${p.instance} declared twice`);
    props.set(p.instance, m);
    if (p.scale > m.maxScale) err('FORBIDDEN_TRANSFORM', `${p.instance} initial scale ${p.scale} > max ${m.maxScale}`);
    if (p.parent) { const par = ep.props.find((x) => x.instance === p.parent); const pm = par && lib.props[`${par.id}@${par.version}`]; if (!pm) err('UNKNOWN_PARENT', `${p.instance} parent ${p.parent} missing`); else if (!pm.anchors[p.anchor]) err('UNKNOWN_ANCHOR', `${p.instance}: parent ${p.parent} has no anchor ${p.anchor}`); }
    else if (env && !env.anchors[p.anchor] && !env.marks[p.anchor]) err('UNKNOWN_ANCHOR', `${p.instance}: environment anchor ${p.anchor} missing`);
  }
  const heroes = ep.props.filter((p) => p.hero);
  if (heroes.length !== 1) err('HERO_PROP', `exactly one hero (causal) prop required, found ${heroes.length}`);
  const allAssets: Array<{ id: string; license: { source: string } }> = [env, ...chars.values(), ...props.values()].filter(Boolean) as never;
  const audioIds = [...ep.audio.cues.map((c) => c.sfx), ...(ep.audio.music ? [ep.audio.music.id] : []), ...(ep.audio.ambience ? [ep.audio.ambience.id] : [])];
  const audioById = new Map<string, AudioManifest[]>();
  for (const a of Object.values(lib.audio)) audioById.set(a.id, [...(audioById.get(a.id) ?? []), a]);
  for (const id of new Set(audioIds)) {
    const v = audioById.get(id);
    if (!v) err('MISSING_ASSET', `audio ${id} not in library`);
    else { if (v.length > 1) err('AMBIGUOUS_AUDIO_VERSION', `audio ${id} has ${v.length} versions; pin one`); allAssets.push(v[0]); }
  }
  for (const a of allAssets) if (!ALLOWED_LICENSE_SOURCES.has(a.license.source)) err('UNLICENSED_ASSET', `${a.id} has disallowed license source ${a.license.source}`);

  // ---------- reference resolution ----------
  const actorSubs = new Set(['face', 'head', 'feet', 'above_head']);
  const resolvable = (ref: string): boolean => {
    const [b, s] = ref.split('.');
    if (!s && env && (env.marks[b] || env.anchors[b])) return true;
    if (chars.has(b)) return !s || actorSubs.has(s);
    const pm = props.get(b);
    if (pm) return !s || !!(pm.anchors[s] || pm.effectAnchors[s] || pm.grips[s]);
    return false;
  };
  const refCheck = (ref: string | undefined, where: string) => { if (ref && !resolvable(ref)) err('UNRESOLVED_REFERENCE', `${where}: "${ref}" is not a mark, anchor, actor or prop anchor`); };
  ep.cast.forEach((c, i) => refCheck(c.startFacing, `cast[${i}].startFacing`));
  ep.actions.forEach((a, i) => { refCheck(a.target, `actions[${i}].target`); refCheck(a.to, `actions[${i}].to`); });
  ep.propEvents.forEach((e, i) => { refCheck(e.to, `propEvents[${i}].to`); if (typeof e.params?.from === 'string') refCheck(e.params.from, `propEvents[${i}].params.from`); if (!props.has(e.prop)) err('UNKNOWN_PROP', `propEvents[${i}] references unknown prop ${e.prop}`); });
  ep.shots.forEach((s, i) => s.subjects.forEach((x) => refCheck(x, `shots[${i}].subjects`)));
  ep.vfx.forEach((v, i) => refCheck(v.target, `vfx[${i}].target`));

  // ---------- actions ----------
  const byActor = new Map<string, typeof ep.actions>();
  ep.actions.forEach((a, i) => {
    const m = chars.get(a.actor);
    if (!m) { err('UNKNOWN_ACTOR', `actions[${i}] actor ${a.actor} not cast`); return; }
    const def = ACTION_DEFS[a.action];
    if (!def) err('INVALID_ACTION', `actions[${i}]: ${a.action} has no runtime implementation`);
    if (!m.allowedActions.includes(a.action)) err('INVALID_ACTION', `${a.actor} is not allowed to ${a.action}`);
    if (a.expression && !m.allowedExpressions.includes(a.expression)) err('INVALID_EXPRESSION', `${a.actor} cannot use expression ${a.expression}`);
    if (a.start + a.duration > D + 1e-6) err('TIMELINE_OVERFLOW', `actions[${i}] ${a.actor}.${a.action} ends at ${r3(a.start + a.duration)} > ${D}`);
    // stories may not rely on actions whose engine features do not exist yet (reels exercise their poses on purpose)
    const unmet = unmetRequirements(a.action);
    if (unmet.length) {
      const msg = `actions[${i}] ${a.actor}.${a.action}: ${ACTION_REQUIREMENTS[a.action]!.reason} (requires: ${unmet.join(', ')})`;
      if (profile === 'action-reel') info('ACTION_UNAVAILABLE', `[allowed in action-reel: pose exercised without the feature] ${msg}`); else err('ACTION_UNAVAILABLE', msg);
    }
    if (['press_button', 'pick_up', 'point', 'turn_toward', 'look_at'].includes(a.action) && !a.target) err('MISSING_TARGET', `actions[${i}] ${a.action} needs a target`);
    if (LOCOMOTION_ACTIONS.includes(a.action) && !a.to) err('MISSING_TARGET', `actions[${i}] ${a.action} needs "to"`);
    if (!def?.layer) byActor.set(a.actor, [...(byActor.get(a.actor) ?? []), a]);
  });
  ep.expressions.forEach((e, i) => { const m = chars.get(e.actor); if (!m) err('UNKNOWN_ACTOR', `expressions[${i}] actor ${e.actor}`); else if (!m.allowedExpressions.includes(e.state)) err('INVALID_EXPRESSION', `${e.actor} cannot use ${e.state}`); });
  for (const [actor, list] of byActor) {
    list.sort((a, b) => a.start - b.start);
    for (let k = 1; k < list.length; k++) {
      const prev = list[k - 1], cur = list[k];
      const overlap = prev.start + prev.duration - cur.start;
      if (overlap > 1e-6) {
        if (opts.repair && overlap <= 0.2 && prev.duration - overlap >= 0.1) { const nd = r3(prev.duration - overlap); repairs.push(`trimmed ${actor}.${prev.action}@${prev.start} duration ${prev.duration} -> ${nd} to remove ${r3(overlap)}s overlap`); prev.duration = nd; }
        else err('TIMELINE_OVERLAP', `${actor}: ${prev.action}@${prev.start} overlaps ${cur.action}@${cur.start} by ${r3(overlap)}s`);
      }
    }
    // locomotion feasibility (speed) along the compiled path
    let pos = env ? env.marks[ep.cast.find((c) => c.id === actor)!.startMark]?.pos : undefined;
    const m = chars.get(actor)!;
    for (const a of list) {
      if (!LOCOMOTION_ACTIONS.includes(a.action) || !a.to || !pos || !env) continue;
      const to = env.marks[a.to]?.pos ?? env.anchors[a.to];
      if (!to) continue;
      const dist = Math.hypot(to[0] - pos[0], to[2] - pos[2]);
      const vmax = (a.action === 'walk' ? m.locomotion.walkSpeed : m.locomotion.runSpeed) * 1.25;
      const ta = Math.min(0.25, a.duration * 0.25);
      const v = dist / Math.max(1e-6, a.duration - ta);
      if (v > vmax) err('IMPOSSIBLE_ACTION', `${actor} ${a.action}@${a.start}: needs ${v.toFixed(2)} m/s over ${dist.toFixed(2)} m, max ${vmax.toFixed(2)} m/s`);
      pos = to;
    }
  }

  // ---------- props ----------
  ep.propEvents.forEach((e, i) => {
    const m = props.get(e.prop); if (!m) return;
    const need: Record<string, string> = { grow: 'uniform_scale', press: 'press_depress', reset: 'press_depress', flash: 'glow', spin: 'spin', slide: 'translate', hop_to: 'translate', spawn: 'translate', stand_up: 'rotate', tip_over: 'rotate', wobble: 'rotate' };
    const t = need[e.event];
    if (t && !m.allowedTransformations.includes(t as never)) err('FORBIDDEN_TRANSFORM', `propEvents[${i}]: ${e.prop} (${m.id}) does not allow ${t} (${e.event})`);
    if (e.event === 'grow' && Number(e.params?.scale ?? 0) > m.maxScale) err('FORBIDDEN_TRANSFORM', `propEvents[${i}]: grow to ${e.params?.scale} exceeds maxScale ${m.maxScale}`);
    if (e.start + e.duration > D + 1e-6) err('TIMELINE_OVERFLOW', `propEvents[${i}] ends after episode`);
  });

  // ---------- causality: every press has an actor contact ----------
  const contacts = ep.actions.filter((a) => ACTION_DEFS[a.action]?.contactU !== undefined).map((a) => ({ a, t: a.start + a.duration * ACTION_DEFS[a.action].contactU! }));
  for (const e of ep.propEvents.filter((x) => x.event === 'press')) {
    const c = contacts.find((c) => c.a.action === 'press_button' && c.a.target?.split('.')[0] === e.prop && Math.abs(c.t - e.start) <= 0.1);
    if (!c) err('CAUSALITY', `${e.prop} press@${e.start} has no press_button contact within 0.1 s (contacts: ${contacts.map((c) => r3(c.t)).join(', ') || 'none'})`);
  }
  const spawns = ep.propEvents.filter((x) => x.event === 'spawn');
  for (const s of spawns) {
    const src = typeof s.params?.from === 'string' ? s.params.from.split('.')[0] : undefined;
    const press = ep.propEvents.find((x) => x.event === 'press' && x.prop === src && x.start <= s.start + 1e-6 && s.start - x.start < 0.6);
    if (src && props.get(src) && !press) err('CAUSALITY', `${s.prop} spawns from ${src}@${s.start} without a preceding press (unexplained appearance)`);
  }
  // unexplained visibility: props that become visible need spawn/show
  for (const p of ep.props.filter((p) => !p.visible)) if (!ep.propEvents.some((e) => e.prop === p.instance && (e.event === 'spawn' || e.event === 'show'))) warn('UNUSED_PROP', `${p.instance} is hidden and never shown`);

  // ---------- shots ----------
  const shots = [...ep.shots].sort((a, b) => a.start - b.start);
  if (Math.abs(shots[0].start) > 1e-6) { if (opts.repair) { repairs.push(`first shot start ${shots[0].start} -> 0`); shots[0].start = 0; } else err('SHOT_COVERAGE', 'first shot must start at 0'); }
  for (let k = 1; k < shots.length; k++) {
    const gap = shots[k].start - shots[k - 1].end;
    if (Math.abs(gap) > 1e-6) {
      if (opts.repair && Math.abs(gap) <= 0.25) { repairs.push(`snapped ${shots[k - 1].id}.end ${shots[k - 1].end} -> ${shots[k].start}`); shots[k - 1].end = shots[k].start; }
      else err('SHOT_COVERAGE', `${gap > 0 ? 'gap' : 'overlap'} of ${r3(Math.abs(gap))}s between ${shots[k - 1].id} and ${shots[k].id}`);
    }
  }
  const last = shots[shots.length - 1];
  if (Math.abs(last.end - D) > 1e-6) { if (opts.repair && Math.abs(last.end - D) <= 0.25) { repairs.push(`last shot end ${last.end} -> ${D}`); last.end = D; } else err('SHOT_COVERAGE', `last shot ends at ${last.end}, episode is ${D}`); }
  ep.shots = shots;
  const presets = new Set(shots.map((s) => s.preset));
  if (shots.length < 6) err('SHOT_VARIETY', `need >= 6 camera compositions, found ${shots.length}`);
  for (const s of shots) {
    const len = s.end - s.start;
    if (len < 0.4) warn('SHOT_TOO_SHORT', `${s.id} lasts ${r3(len)}s (< 0.4 s reads as a glitch)`);
    if (len > 3.0) warn('SHOT_TOO_LONG', `${s.id} lasts ${r3(len)}s (> 3 s without a cut)`);
  }
  info('SHOT_STATS', `${shots.length} shots, ${presets.size} distinct presets: ${[...presets].join(', ')}`);

  // ---------- storytelling gates ----------
  const hero = heroes[0]?.instance;
  if (hero && !shots[0].subjects.some((s) => s.split('.')[0] === hero)) err('PREMISE_NOT_VISIBLE', `opening shot must show hero prop ${hero}`);
  if (shots[0].end > 1.5) warn('SLOW_OPENING', `opening shot lasts ${shots[0].end}s; premise should read within 1 s`);
  // visual-change cadence
  const changes = new Set<number>();
  shots.forEach((s) => changes.add(r3(s.start)));
  ep.actions.forEach((a) => changes.add(r3(a.start)));
  ep.expressions.forEach((e) => changes.add(r3(e.at)));
  ep.propEvents.forEach((e) => changes.add(r3(e.start)));
  ep.vfx.forEach((v) => changes.add(r3(v.at)));
  const ts = [...changes].filter((t) => t <= D).sort((a, b) => a - b).concat([D]);
  let maxGap = 0, gapAt = 0;
  for (let k = 1; k < ts.length; k++) if (ts[k] - ts[k - 1] > maxGap) { maxGap = ts[k] - ts[k - 1]; gapAt = ts[k - 1]; }
  if (maxGap > 1.5) err('STALE_STRETCH', `no meaningful visual change for ${r3(maxGap)}s after t=${gapAt} (max 1.5 s)`);
  // facial reaction at information changes
  const faceTimes = [...ep.expressions.map((e) => e.at), ...ep.actions.filter((a) => a.expression).map((a) => a.start), ...ep.vfx.filter((v) => v.type === 'emote').map((v) => v.at)];
  for (const b of ep.beats.filter((b) => b.informationChange)) {
    if (b.intent === 'hook' || b.intent === 'loop') continue;
    if (!faceTimes.some((t) => t >= b.start - 0.35 && t <= b.end)) warn('NO_FACIAL_REACTION', `beat ${b.id} (${b.intent}) changes information but no expression change/emote occurs in it`);
  }
  // final reversal in the last 3 s
  const rev = ep.beats.find((b) => b.intent === 'reversal');
  const bigImpacts = ep.propEvents.filter((e) => e.event === 'tip_over' || (e.event === 'grow' && Number(e.params?.scale) >= 10));
  const lastImpact = Math.max(-1, ...ep.propEvents.filter((e) => e.event === 'tip_over').map((e) => e.start + e.duration));
  if (!rev) err('NO_REVERSAL', 'no beat with intent "reversal"');
  if (lastImpact < D - 3 - 1e-6) err('REVERSAL_TOO_EARLY', `largest physical reversal lands at ${r3(lastImpact)}s; must land in the final 3 s (>= ${D - 3})`);
  void bigImpacts;
  // loop
  if (ep.loop.firstShot !== shots[0].id) err('LOOP', `loop.firstShot ${ep.loop.firstShot} is not the first shot ${shots[0].id}`);
  if (ep.loop.lastShot !== last.id) err('LOOP', `loop.lastShot ${ep.loop.lastShot} is not the last shot ${last.id}`);
  if (last.preset !== 'final_loop') err('LOOP', `last shot must use preset final_loop (got ${last.preset})`);
  if (JSON.stringify(last.subjects) !== JSON.stringify(shots[0].subjects)) err('LOOP', 'final_loop subjects must equal opening shot subjects');
  // beats contiguous
  const beats = [...ep.beats].sort((a, b) => a.start - b.start);
  for (let k = 1; k < beats.length; k++) if (Math.abs(beats[k].start - beats[k - 1].end) > 1e-6) warn('BEAT_COVERAGE', `beats ${beats[k - 1].id}/${beats[k].id} not contiguous`);

  // ---------- audio sync ----------
  const impactTimes: Record<string, number> = {};
  for (const e of ep.propEvents) if (e.event === 'tip_over') impactTimes[`impact:${e.prop}:tip_over`] = e.start + e.duration;
  for (const e of ep.propEvents) if (e.event === 'hop_to') impactTimes[`impact:${e.prop}:land`] = e.start + e.duration;
  ep.audio.cues.forEach((c, i) => {
    if (c.at > D) err('TIMELINE_OVERFLOW', `audio.cues[${i}] after end`);
    const m = c.sync?.match(/^contact:([a-z0-9_]+):([a-z_]+)$/);
    let want: number | undefined;
    if (m) { const cands = contacts.filter((x) => x.a.actor === m[1] && x.a.action === m[2]); want = cands.length ? cands.reduce((b, x) => (Math.abs(x.t - c.at) < Math.abs(b.t - c.at) ? x : b)).t : undefined; }
    else if (c.sync && impactTimes[c.sync] !== undefined) want = impactTimes[c.sync];
    if (want !== undefined && Math.abs(want - c.at) > frame) {
      if (opts.repair) { repairs.push(`moved cue ${c.sfx} ${c.at} -> ${r3(want)} (sync ${c.sync})`); c.at = r3(want); }
      else err('AV_SYNC', `cue ${c.sfx}@${c.at} is ${r3(Math.abs(want - c.at))}s off its sync point ${c.sync} (${r3(want)})`);
    }
  });

  // ---------- safety ----------
  const texts = [ep.episode.title, ep.episode.logline, ep.safety.notes, ...ep.beats.map((b) => b.summary), ...ep.shots.map((s) => s.purpose)];
  const banned = findBannedTerms(texts);
  if (banned.length) err('UNSAFE_OR_PROTECTED_TERM', `banned terms present: ${banned.join(', ')}`);

  const metrics = { shots: shots.length, distinctPresets: presets.size, maxStaleGap: r3(maxGap), actions: ep.actions.length, cues: ep.audio.cues.length, reversalAt: r3(lastImpact) };
  const ok = !findings.some((f) => f.severity === 'error');
  return { ok, episode: ep, findings, repairs, metrics, profile };
}
