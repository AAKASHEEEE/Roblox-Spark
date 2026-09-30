// Narrated draft timeline compiler (Phase 2A): APPROVED narrated storyboard (schema 1.1) -> versioned render timeline
// + a draft Episode for the existing engine. Pure and deterministic (no clock, no Math.random; seeded choices only).
// Caption chunks drive the visual rhythm: >= 1 shot per chunk, shots split so none exceeds MAX_DRAFT_SHOT_SEC, the
// voice-over is never cut or stretched. Only registered actions/props/cameras are emitted; off-screen people are
// never instantiated (door-direction look + off-screen sound cue + reaction instead).
import { rng, hashSeed } from '../../engine/src/math.ts';
import type { NarratedStoryboard, NarratedPhrase } from './schema.ts';

export const TIMELINE_SCHEMA = 'blockspark.narrated-timeline/1';
export const MAX_DRAFT_SHOT_SEC = 2.8;
export const DRAFT_EXPORT = { width: 540, height: 960, scale: 0.5, fps: 30, videoCodec: 'h264', audioCodec: 'aac', sampleRate: 48000, channels: 2, loudnessLufs: -15, truePeakDbtpMax: -1.5, label: 'Draft Preview — Not Final Quality' } as const;
export interface DraftAssets { characters: Record<string, string>; environment: { id: string; version: string }; props: { button: string; coin: string; desk: string }; motionProfile: string; rendererVersion: string }
export interface TimelineShot { id: string; start: number; end: number; preset: string; subjects: string[]; phraseId: string; chunkId: string }
/** caption chunk; `placement` (block centre, fraction of frame height, fixed for the whole chunk) is set only by the
 *  integrated camera/caption pass (apps/render-worker/narrated-integration.ts) — the compiler never sets it */
export interface CaptionEvent { chunkId: string; phraseId: string; start: number; end: number; lines: string[]; emphasisWords: string[]; placement?: { centerY: number } }
export interface SfxCue { sfx: string; at: number; gainDb: number; sync: string }
export interface NarratedTimeline {
  schema: typeof TIMELINE_SCHEMA; storyboardSchemaVersion: string; storyboardId: string; storyboardSha256: string; audioHash: string;
  /** voice-over duration; videoDuration = whole frames covering it (the audio is padded, never cut) */
  duration: number; videoDuration: number; seed: number; export: typeof DRAFT_EXPORT;
  shots: TimelineShot[]; captions: CaptionEvent[];
  actions: Array<{ actor: string; action: string; start: number; duration: number; target?: string; phraseId: string }>;
  expressions: Array<{ actor: string; state: string; at: number; phraseId: string }>;
  propEvents: Array<{ prop: string; event: string; start: number; duration: number; to?: string; params?: Record<string, number | string>; phraseId: string }>;
  offscreenCues: Array<{ phraseId: string; mention: string; at: number; cue: string; lookAt: string | null }>;
  audio: { voiceOver: { contentHash: string; start: 0; duration: number; gainDb: 0 }; sfx: SfxCue[]; duckingDb: number };
  warnings: Array<{ phraseId: string; code: string; message: string }>;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;
/** smallest whole-frame (30 fps) duration >= d, in ms */
export const frameCeil = (d: number): number => r3(Math.ceil(d * 30 - 1e-6) / 30);
const INSTANCE: Record<string, string> = { suspicious_button: 'button', spark_coin: 'coin', student_desk: 'desk' };
/** registered actions that move the root: drafts keep geography fixed, so they become an in-place jump (declared) */
const LOCOMOTION = new Set(['walk', 'run', 'chase', 'exit_frame', 'enter_frame', 'dive_prone']);
const ACTION_SEC: Record<string, number> = { press_button: 0.9, look_at: 1.2, curious_lean: 1.3, head_shake: 0.9, arms_crossed: 1.8, victory_pose: 1.3, jump: 0.9, shock_recoil: 1.0, fall: 1.4, facepalm: 1.2, regret_freeze: 1.6, laugh: 1.6, cower: 1.2, angry_stomp: 1.2, point: 1.0, turn_toward: 1.0, idle: 1.0 };
const CONTACT_U: Record<string, number> = { press_button: 0.42, facepalm: 0.35 };
const SFX: Record<string, [string, number]> = { press: ['sfx_click', -18], spawn: ['sfx_coin_pop', -20], flash: ['sfx_beep', -26], grow: ['sfx_rumble', -24], tip_over: ['sfx_thud_big', -18], reset: ['sfx_ding_reset', -22], fall: ['sfx_thud_small', -22], jump: ['sfx_boing', -24], victory_pose: ['sfx_sparkle', -26] };
const OFFSCREEN_MOVE = /\b(leav|left|return|come back|comes back|came back|arriv|enter|open)/;

/** true when the phrase itself names (or pronoun-references) the supporting character: only then is she/he framed */
function explicitSupport(p: NarratedPhrase): boolean {
  const s = p.supportingCharacter;
  if (!s) return false;
  const t = p.text.toLowerCase();
  return new RegExp(`\\b${s}\\b`).test(t) || (s === 'zapp' && /\b(him|his)\b/.test(t)) || (s === 'kira' && /\bher\b/.test(t) && p.actor !== 'kira');
}

export function compileNarratedTimeline(sb: NarratedStoryboard, storyboardSha256: string): NarratedTimeline {
  const D = sb.audio.durationSeconds, V = frameCeil(D), rand = rng((hashSeed(sb.id) ^ sb.seed) >>> 0);
  const ph = sb.script.phrases;
  const chunks = ph.flatMap((p) => p.caption.chunks.map((c) => ({ c, p })));
  const warnings: NarratedTimeline['warnings'] = [];
  // ---- prop-state track (which prop states exist when), from the approved prop events ----
  const propEvents: NarratedTimeline['propEvents'] = [];
  const sfx: SfxCue[] = [];
  let coinShown = Infinity, coinScale = 1, coinOnFloor = false, coinTipped = false;
  const actions: NarratedTimeline['actions'] = [], expressions: NarratedTimeline['expressions'] = [], offscreenCues: NarratedTimeline['offscreenCues'] = [];
  const busyUntil: Record<string, number> = {};
  ph.forEach((p, k) => {
    const nextStart = k + 1 < ph.length ? ph[k + 1].start : D;
    let t0 = r3(Math.min(p.start + 0.05, nextStart - 0.3));
    // off-screen person moving (e.g. leaves/returns): a door-direction look first + an off-screen cue; never drawn
    for (const m of p.offscreenCharacters) {
      const moves = new RegExp(`\\b${m}\\b\\s+(?:\\w+\\s+){0,2}?${OFFSCREEN_MOVE.source}`).test(p.text.toLowerCase());
      offscreenCues.push({ phraseId: p.id, mention: m, at: p.start, cue: moves ? 'door_sound_and_look' : 'mention_only', lookAt: moves ? 'enter_back_left' : null });
      warnings.push({ phraseId: p.id, code: 'UNAVAILABLE_CHARACTER_OFFSCREEN', message: `"${m}" stays off-screen (not instantiated)` });
      if (moves) {
        sfx.push({ sfx: 'sfx_creak', at: r3(p.start), gainDb: -24, sync: `offscreen:${m}` });
        if ((busyUntil[p.actor] ?? 0) <= t0) { actions.push({ actor: p.actor, action: 'look_at', start: t0, duration: 0.8, target: 'enter_back_left', phraseId: p.id }); busyUntil[p.actor] = t0 + 0.8; t0 = r3(t0 + 0.85); }
      }
    }
    // main semantic action once per phrase, near its start (later chunks hold / cut / react instead of restarting it)
    let action = p.semanticAction;
    if (LOCOMOTION.has(action)) { warnings.push({ phraseId: p.id, code: 'DRAFT_LOCOMOTION_IN_PLACE', message: `${action} shown as an in-place jump in the draft (fixed classroom geography)` }); action = 'jump'; }
    const room = Math.max(0.3, nextStart - t0 - 0.05);
    const dur = r3(Math.min(ACTION_SEC[action] ?? 1.2, room));
    const target = p.target === 'camera' ? 'center_stage' : p.target ?? undefined;
    if ((busyUntil[p.actor] ?? 0) <= t0 + 1e-9) { actions.push({ actor: p.actor, action, start: t0, duration: dur, ...(target ? { target } : {}), phraseId: p.id }); busyUntil[p.actor] = t0 + dur; }
    expressions.push({ actor: p.actor, state: p.expression, at: r3(p.start), phraseId: p.id });
    if (p.supportingCharacter && p.supportingExpression && explicitSupport(p)) expressions.push({ actor: p.supportingCharacter, state: p.supportingExpression, at: r3(Math.min(p.start + 0.4, nextStart - 0.05)), phraseId: p.id });
    if (SFX[action]) sfx.push({ sfx: SFX[action][0], at: r3(t0 + (action === 'fall' ? dur * 0.6 : 0.1)), gainDb: SFX[action][1], sync: `action:${p.actor}:${action}` });
    // prop events: registered props and events only, in a physically ordered chain (spawn -> grow -> floor -> tip)
    const contact = action === 'press_button' ? r3(t0 + dur * CONTACT_U.press_button) : null;
    let at = contact ?? t0;
    for (const e of p.propEvents) {
      const inst = INSTANCE[e.prop];
      const push = (ev: string, start: number, duration: number, extra: Partial<NarratedTimeline['propEvents'][number]> = {}) => { propEvents.push({ prop: inst, event: ev, start: r3(start), duration: r3(duration), ...extra, phraseId: p.id }); if (SFX[ev]) sfx.push({ sfx: SFX[ev][0], at: r3(start), gainDb: SFX[ev][1], sync: `prop:${inst}:${ev}` }); };
      if (e.event === 'press' && contact !== null) { push('press', contact, 0.5); push('flash', contact + 0.03, 0.5, { params: { hz: 8 } }); }
      else if (e.event === 'flash' && inst === 'button') push('flash', at, 1.2, { params: { hz: 3 } });
      else if (e.event === 'reset' && inst === 'button') { push('reset', at, 0.3); push('flash', at + 0.35, 1.0, { params: { hz: 2.7273, endGlow: 1 } }); }
      else if (e.event === 'spawn' && inst === 'coin' && coinShown === Infinity && contact !== null) { const s = contact + 0.1; push('spawn', s, 1.0, { to: 'desk.coin_spot', params: { from: 'button.spawn_point', flight: 0.5, flips: 1 } }); coinShown = s; }
      else if (e.event === 'grow' && inst === 'coin' && coinShown < Infinity && !coinTipped) {
        let s = Math.max(at, coinShown + 1.1);
        if (coinScale === 1) { push('stand_up', s, 0.3); s += 0.35; }
        for (const sc of coinScale < 6 ? [3, 6] : [11, 16.7]) {
          if (sc > 6 && !coinOnFloor) { push('hop_to', s, 0.55, { to: 'coin_floor', params: { height: 1.2 } }); s += 0.6; coinOnFloor = true; }
          push('grow', s, 0.35, { params: { scale: sc } }); s += 0.45; coinScale = sc;
        }
        at = s;
      } else if (e.event === 'tip_over' && inst === 'coin' && coinShown < Infinity && !coinTipped) {
        if (!coinOnFloor) { push('hop_to', at, 0.55, { to: 'coin_floor', params: { height: 1.2 } }); at += 0.6; coinOnFloor = true; }
        push('tip_over', at, 0.65, { params: { endDeg: 86 } }); coinTipped = true;
      } else warnings.push({ phraseId: p.id, code: 'DRAFT_PROP_EVENT_SKIPPED', message: `${e.prop} ${e.event} not shown in the draft (prop state does not allow it here)` });
    }
  });
  const giantFrom = propEvents.find((e) => e.event === 'grow' && Number(e.params?.scale) >= 11)?.start ?? Infinity;
  const coinFrom = coinShown === Infinity ? Infinity : coinShown + 1.0;
  // after the giant coin tips onto its victim, that actor is framed with the coin (never a camera inside the coin)
  const tip = propEvents.find((e) => e.event === 'tip_over'), flattenedAt = tip ? tip.start + tip.duration * 0.5 : Infinity;
  const flattened = ph.find((p) => p.actorRole === 'affected' && p.cause === 'spark_coin')?.actor ?? null;
  // ---- shots: >= 1 per caption chunk; the gap after a chunk belongs to it; split so none exceeds the cap ----
  const shots: TimelineShot[] = [];
  let prev = '';
  chunks.forEach(({ c, p }, k) => {
    const a = k === 0 ? 0 : c.start, b = k + 1 < chunks.length ? chunks[k + 1].c.start : V;
    const parts = Math.max(1, Math.ceil((b - a) / MAX_DRAFT_SHOT_SEC - 1e-9));
    const firstChunk = p.caption.chunks[0].id === c.id;
    const prop = p.propEvents[0] ? INSTANCE[p.propEvents[0].prop] : p.target?.startsWith('button') ? 'button' : p.target?.startsWith('coin') ? 'coin' : null;
    const support = explicitSupport(p) ? p.supportingCharacter : null;
    for (let q = 0; q < parts; q++) {
      const s = r3(a + ((b - a) * q) / parts), e = q === parts - 1 ? r3(b) : r3(a + ((b - a) * (q + 1)) / parts);
      const mid = (s + e) / 2;
      const coinOk = (x: string) => x !== 'coin' || mid >= coinFrom;
      // candidates in preference order: the approved camera on the phrase's first shot, then close/medium coverage
      const cands: Array<[string, string[]]> = [];
      if (firstChunk && q === 0) cands.push([p.cameraPreset, []]);
      if (prop && coinOk(prop)) cands.push(['prop_ecu', [prop]]);
      if (support) cands.push(['two_shot', [p.actor, support]], ['over_shoulder', [support, p.actor]]);
      if (prop === 'button') cands.push(['over_shoulder', [p.actor, 'button']]);
      cands.push(['reaction_punch_in', [p.actor]], ['frontal_medium', [p.actor]]);
      if (mid >= giantFrom) cands.push(['low_angle_reveal', ['coin']], ['wide_environment', ['coin', p.actor]]);
      if (p.actorRole === 'reactor' && prop && coinOk(prop)) cands.unshift(['prop_ecu', [prop]]); // the causal prop leads a reaction beat
      if (mid >= flattenedAt && p.actor === flattened) cands.splice(0, cands.length, ...(prop === 'button' ? [['prop_ecu', ['button']] as [string, string[]]] : []), ['wide_environment', ['coin', p.actor]], ['low_angle_reveal', ['coin']]);
      const pick = cands.map(([pre, subj]) => normalize(pre, subj, p, support, prop, mid >= giantFrom, coinOk)).filter((x): x is [string, string[]] => !!x);
      const fresh = pick.filter(([pre]) => pre !== prev);
      const choice = (k === 0 && q === 0) ? pick[0] : fresh.length ? fresh[Math.floor(rand() * Math.min(2, fresh.length))] : pick[0];
      shots.push({ id: `s${String(shots.length + 1).padStart(3, '0')}`, start: s, end: e, preset: choice[0], subjects: choice[1], phraseId: p.id, chunkId: c.id });
      prev = choice[0];
    }
  });
  const captions: CaptionEvent[] = chunks.map(({ c, p }) => ({ chunkId: c.id, phraseId: p.id, start: c.start, end: c.end, lines: [...c.lines], emphasisWords: [...c.emphasisWords] }));
  sfx.sort((x, y) => x.at - y.at || (x.sfx < y.sfx ? -1 : 1));
  return {
    schema: TIMELINE_SCHEMA, storyboardSchemaVersion: sb.schemaVersion, storyboardId: sb.id, storyboardSha256, audioHash: sb.audio.contentHash,
    duration: D, videoDuration: V, seed: sb.seed, export: DRAFT_EXPORT, shots, captions, actions, expressions, propEvents: propEvents.sort((x, y) => x.start - y.start), offscreenCues,
    audio: { voiceOver: { contentHash: sb.audio.contentHash, start: 0, duration: D, gainDb: 0 }, sfx, duckingDb: 10 }, warnings,
  };
}

/** map a preset + subjects to a composition the camera solver supports; null = not usable here */
function normalize(pre: string, subj: string[], p: NarratedPhrase, support: string | null, prop: string | null, giant: boolean, coinOk: (x: string) => boolean): [string, string[]] | null {
  const actor = p.actor;
  switch (pre) {
    case 'two_shot': return support ? ['two_shot', subj.length ? subj : [actor, support]] : null;
    case 'over_shoulder': { const s = subj.length ? subj : support ? [support, actor] : prop && coinOk(prop) ? [actor, prop] : []; return s.length === 2 && s.every(coinOk) ? ['over_shoulder', s] : null; }
    case 'prop_ecu': case 'top_down_insert': { const x = subj[0] ?? prop; return x && coinOk(x) ? [pre, [x]] : null; }
    case 'low_angle_reveal': return giant ? ['low_angle_reveal', ['coin']] : ['reaction_punch_in', [actor]];
    case 'wide_environment': return giant ? ['wide_environment', subj.length ? subj : ['coin', actor]] : null;
    case 'final_loop': case 'chase_cam': return ['frontal_medium', [actor]];
    default: return [pre, subj.length ? subj : [actor]];
  }
}

const BEAT: Record<string, string> = { hook: 'hook', setup: 'setup', 'initial-benefit': 'celebrate', escalation: 'escalate', turn: 'reversal', consequence: 'effect', reaction: 'effect', 'comparison-a': 'setup', 'comparison-b': 'effect', punchline: 'payoff', closing: 'payoff' };
/** the timeline as a draft Episode (NarratedEpisodeSchema, validation profile narrated-draft) for the existing engine */
export function draftEpisode(sb: NarratedStoryboard, tl: NarratedTimeline, A: DraftAssets): Record<string, unknown> {
  const ph = sb.script.phrases, D = tl.videoDuration;
  const bounds = ph.map((p, k) => [k === 0 ? 0 : p.start, k + 1 < ph.length ? ph[k + 1].start : D]);
  return {
    schemaVersion: '1.1', render: { rendererVersion: A.rendererVersion, motionProfile: A.motionProfile },
    episode: { id: sb.id, title: sb.title, logline: ph[0].text.slice(0, 280), duration: D, format: 'vertical', resolution: [1080, 1920], fps: 30, seed: sb.seed, comedyEngine: 'narrated_story' },
    environment: { id: A.environment.id, version: A.environment.version, lighting: 'morning' },
    cast: [
      { id: 'zapp', version: A.characters.zapp, role: 'protagonist', startMark: 'zapp_desk', startFacing: 'button', startExpression: 'neutral' },
      { id: 'kira', version: A.characters.kira, role: 'foil', startMark: 'kira_desk', startExpression: 'smug' },
    ].filter((c) => sb.characters.includes(c.id)),
    props: [
      { instance: 'desk', id: 'student_desk', version: A.props.desk, anchor: 'hero_desk_spot', hero: false, visible: true, scale: 1 },
      { instance: 'button', id: 'suspicious_button', version: A.props.button, anchor: 'button_spot', parent: 'desk', hero: true, visible: true, scale: 1 },
      { instance: 'coin', id: 'spark_coin', version: A.props.coin, anchor: 'coin_floor', hero: false, visible: false, scale: 1 },
    ],
    beats: ph.map((p, k) => ({ id: `b${String(k + 1).padStart(2, '0')}`, start: r3(bounds[k][0]), end: r3(bounds[k][1]), intent: BEAT[p.storyPurpose] ?? 'effect', summary: p.text.slice(0, 160), informationChange: true })),
    actions: tl.actions.map(({ phraseId: _p, ...a }) => a),
    expressions: tl.expressions.map(({ phraseId: _p, ...e }) => e),
    propEvents: tl.propEvents.map(({ phraseId: _p, ...e }) => e),
    shots: tl.shots.map((s) => ({ id: s.id, start: s.start, end: s.end, preset: s.preset, subjects: s.subjects, purpose: `${s.phraseId}/${s.chunkId}` })),
    vfx: [],
    audio: { cues: [], loudnessLufs: tl.export.loudnessLufs, duckingDb: tl.audio.duckingDb },
    loop: { mode: 'continuous', firstShot: tl.shots[0].id, lastShot: tl.shots[tl.shots.length - 1].id, matchWindow: 0 },
    export: { container: 'mp4', videoCodec: 'h264', audioCodec: 'aac', videoBitrateKbps: 12000, audioBitrateKbps: 160 },
    safety: { familySafe: true, usesThirdPartyBrands: false, realMoneyOrGiveawayClaims: false, notes: 'Narrated draft from an approved storyboard; off-screen people are never instantiated.' },
  };
}
