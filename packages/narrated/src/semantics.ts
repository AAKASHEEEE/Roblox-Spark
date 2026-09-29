// Deterministic phrase semantics for narrated beats (no LLM): who acts, how they relate to the narration, which
// registered action demonstrates the main verb, which prop events the narration implies, and which people must stay
// off-screen. Rules, in priority order:
//   actor: 1 explicit grammatical subject naming a selected character, 2 subject pronoun resolved by character
//          pronoun (else the previous actor), 3 a selected character named elsewhere (object / observed / affected),
//          4 the current story subject, 5 alternation fallback. Blank lines never force a different actor.
//   action: the EARLIEST non-negated verb rule in the actor's own clause (verb + object: "notices the button" is a
//          look, "presses/slams/touches the button" is a press); a thing as subject ("the button flashes", "the coin
//          grows") yields a reaction plus prop-event metadata; "the coin flattens Zapp" makes Zapp affected, coin = cause.
//   people who are not built (or not selected): off-screen with a warning; blocking only when such a person is the
//          main subject performing a visible action.
import { scanIdea } from '../../story/src/lexicon.ts';
import type { PROP_EVENTS } from '../../schema/src/episode.ts';

export type Emotion = 'neutral' | 'curious' | 'determined' | 'happy' | 'shock' | 'regret' | 'skeptical' | 'smug' | 'laugh' | 'surprised';
export type ActorRole = 'agent' | 'affected' | 'reactor' | 'overview' | 'fallback';
export interface PropEvent { prop: string; event: (typeof PROP_EVENTS)[number] }
export interface PhraseSemantics {
  actor: string; actorRole: ActorRole; supporting: string | null;
  action: string | null; emotion: Emotion | null; target: string | null; cause: string | null;
  propEvents: PropEvent[]; offscreen: string[]; blocking: string | null;
  substitution: { requested: string; used: string; reason: string } | null;
}
export interface SemanticState { storySubject: string | null; lastActor: string | null; lastThing: string | null; fallback: number }
export const newSemanticState = (): SemanticState => ({ storySubject: null, lastActor: null, lastThing: null, fallback: 0 });

/** subject pronoun per character (character metadata: the locked manifests carry no pronoun field yet) */
export const CHARACTER_PRONOUNS: Readonly<Record<string, 'he' | 'she'>> = { zapp: 'he', kira: 'she' };
const PRONOUN_FORMS: Record<'he' | 'she', RegExp> = { he: /\b(he|him|his|himself)\b/, she: /\b(she|her|hers|herself)\b/ };
export const PROP_ANCHOR: Readonly<Record<string, string>> = { suspicious_button: 'button.press_surface', spark_coin: 'coin.center', student_desk: 'desk.top_center' };
const PROP_NAME: Record<string, string> = { suspicious_button: 'button', spark_coin: 'coin', student_desk: 'desk' };
/** events each registered prop can actually show (registry: the button presses/flashes/resets; the desk is static) */
const PROP_ALLOWED: Record<string, readonly string[]> = { suspicious_button: ['press', 'flash', 'reset'], spark_coin: ['spawn', 'spin', 'stand_up', 'grow', 'wobble', 'tip_over', 'slide'], student_desk: [] };
const propNoun = (w: string) => /^buttons?$/.test(w) ? 'suspicious_button' : /^coins?$/.test(w) ? 'spark_coin' : /^desks?$/.test(w) ? 'student_desk' : null;
const LOCATIVE = new Set(['on', 'at', 'under', 'beside', 'near', 'behind', 'by', 'over', 'against', 'onto', 'into', 'from', 'across']);
const DISCOURSE = new Set(['then', 'and', 'so', 'but', 'now', 'suddenly', 'meanwhile', 'finally', 'also', 'still', 'even', 'soon', 'later', 'well', 'instead', 'again']);
const DET = new Set(['the', 'a', 'an', 'this', 'that', 'these', 'those', 'his', 'her', 'its', 'their', 'one', 'every', 'each', 'some', 'my', 'your', 'our', 'another']);
/** leading subordinate/prepositional clause before a comma: the main clause starts after it */
const LEAD = /^(?:(?:then|and|so|but)\s+)?(?:the (?:second|moment|minute|instant)|at (?:that|this|the)|right (?:after|before)|as soon as|when|whenever|while|if|after|before|once|since|until|because|during|in the)\b/i;
const NEG = /\b(not|never|don't|doesn't|didn't|won't|can't|cannot|stop)\s+(?:\w+\s+){0,1}$/;
const OFFSCREEN_VERB = /^\s*(?:\w+ly\s+)?(?:(?:could|would|will|might|may|can|has|had|is|was|finally|just|suddenly)\s+)?(leav|left|return|come back|comes back|came back|arriv|enter|walk(?:s|ed)? (?:in|out)|open|knock|call|shout|yell|see|sees|saw|watch|notic|catch|caught|hear|look|check|step(?:s|ped)? (?:in|out))/i;
const toks = (s: string) => s.toLowerCase().replace(/[’]/g, "'").split(/\s+/).map((w) => w.replace(/^[^a-z0-9']+|[^a-z0-9'-]+$/g, '').replace(/'s$/, '')).filter(Boolean);

interface VerbRule { re: RegExp; action: string; emotion?: Emotion; button?: true; sub?: [string, string] }
const VERB_RULES: VerbRule[] = [
  { re: /\b(tells?|told|warns?|warned|asks?|asked|begs?|begged|reminds?|reminded)\b(?=[^.]*\b(not|never|don't|stop)\b)/, action: 'head_shake', emotion: 'skeptical' },
  { re: /\b(press(?:es|ed|ing)?|slam(?:s|med|ming)?|hit(?:s|ting)?|smash(?:es|ed)?|tap(?:s|ped)?|push(?:es|ed)?|touch(?:es|ed)?|punch(?:es|ed)?|mash(?:es|ed)?)\b/, action: 'press_button', emotion: 'determined', button: true },
  { re: /\b(notice[sd]?|noticing|spot(?:s|ted)?|see[sn]?|saw|watch(?:es|ed)?|looks? at|looked at|stare[sd]? at|discover(?:s|ed)?|finds?|found)\b/, action: 'look_at', emotion: 'curious' },
  { re: /\b(?:looks?|acts?|pretends? to be|tries to look|tries to act) (?:confident|cool|calm|brave|innocent|casual|chill)\b/, action: 'arms_crossed', emotion: 'smug' },
  { re: /\b(celebrat(?:e|es|ed|ing)|cheer(?:s|ed|ing)?|part(?:y|ies|ying)|danc(?:e|es|ed|ing)|perfect|amazing|awesome|wins?|won)\b/, action: 'victory_pose', emotion: 'happy' },
  { re: /\b(jump(?:s|ed|ing)?|leap(?:s|t)?|hop(?:s|ped)?|bounce[sd]?)\b/, action: 'jump', emotion: 'happy' },
  { re: /\b(chas(?:e|es|ed|ing))\b/, action: 'chase', emotion: 'determined' },
  { re: /\b(run(?:s)?|ran|running|rush(?:es|ed)?|sprint(?:s|ed)?|dash(?:es|ed)?|race[sd]?|flee[sd]?|fled)\b/, action: 'run', emotion: 'determined' },
  { re: /\b(laugh(?:s|ed|ing)?|giggle[sd]?|chuckle[sd]?|hilarious|funny)\b/, action: 'laugh', emotion: 'laugh' },
  { re: /\b(scared|afraid|terrified|hide[sd]?|hiding|cower(?:s|ed)?)\b/, action: 'cower', emotion: 'shock' },
  { re: /\b(angry|mad|furious|scream(?:s|ed|ing)?|yell(?:s|ed)?|rage|stomp(?:s|ed)?)\b/, action: 'angry_stomp', emotion: 'determined' },
  { re: /\b(shocked|gasp(?:s|ed)?|freeze[sd]?|froze)\b/, action: 'shock_recoil', emotion: 'shock' },
  { re: /\b(forgets?|forgot|forgotten|mistake|oops|facepalm(?:s|ed)?|embarrass(?:ed|ing)?)\b/, action: 'facepalm', emotion: 'regret' },
  { re: /\b(miss(?:es|ed|ing)?|regret(?:s|ted)?|sad|lonely|alone|cr(?:y|ies|ied))\b/, action: 'regret_freeze', emotion: 'regret' },
  { re: /\b(never|refuse[sd]?|nope)\b/, action: 'head_shake', emotion: 'skeptical' },
  { re: /\b(imagine[sd]?|wonder(?:s|ed)?|curious|thinks?|thought)\b/, action: 'curious_lean', emotion: 'curious' },
  { re: /\b(point(?:s|ed)?|blame[sd]?)\b/, action: 'point', emotion: 'determined' },
  { re: /\b(wait(?:s|ed|ing)?|bored|unimpressed|stay(?:s|ed)?|sit(?:s|ting)?|sat|reads?|reading)\b/, action: 'arms_crossed', emotion: 'smug' },
  { re: /\b(leave[sd]?|left|walk(?:s|ed)? away|exit(?:s|ed)?)\b/, action: 'exit_frame' },
  { re: /\b(arrive[sd]?|enter(?:s|ed)?|show(?:s|ed)? up|comes? in|came in)\b/, action: 'enter_frame' },
  { re: /\b(walk(?:s|ed|ing)?|go(?:es)?|went|head(?:s|ed)? to)\b/, action: 'walk' },
  { re: /\b(fall(?:s|ing)?|fell|trip(?:s|ped)?|collapse[sd]?|slip(?:s|ped)?)\b/, action: 'fall', emotion: 'shock' },
  // described but not buildable: a declared stand-in, never an invented action
  { re: /\b(drive|drives|drove|driving|cars?)\b/, action: 'run', sub: ['driving', 'no vehicle asset exists; shown as running'] },
  { re: /\b(fly|flies|flew|flying)\b/, action: 'jump', sub: ['flying', 'no floating rig exists (hover unavailable); shown as a jump'] },
  { re: /\b(eat|eats|ate|eating|drink|drinks|drank|meals?|food)\b/, action: 'look_at', sub: ['eating/drinking', 'hand attachment and food props are not built; shown as a look'] },
  { re: /\b(hold|holds|holding|grab|grabs|grabbed|picks? up|picked up|throw|throws|threw|phones?)\b/, action: 'point', sub: ['holding an object', 'hand attachment is not built; shown as a point gesture'] },
  { re: /\b(sleep|sleeps|slept|asleep|nap)\b/, action: 'regret_freeze', sub: ['sleeping', 'no sleep animation exists; shown as a freeze'] },
];
const PROP_VERBS: Array<[RegExp, PropEvent['event']]> = [
  [/\b(flash(?:es|ed|ing)?|blink(?:s|ed|ing)?|glow(?:s|ed|ing)?|beep(?:s|ed)?|lights? up|lit up)\b/, 'flash'],
  [/\b(reset(?:s|ting)?)\b/, 'reset'],
  [/\b(appear(?:s|ed)?|pop(?:s|ped)? (?:out|up)|spawn(?:s|ed)?|drops? out|comes? out)\b/, 'spawn'],
  [/\b(grow(?:s|ing|n)?|grew|gets? (?:bigger|taller|wider|huge|larger)|expand(?:s|ed|ing)?|swell(?:s|ed|ing)?|fill(?:s|ed)?|taller|wider|bigger)\b/, 'grow'],
  [/\b(tip(?:s|ped)?|topple[sd]?|tilt(?:s|ed)?|falls? over|fell over|flatten(?:s|ed)?|crush(?:es|ed)?|squash(?:es|ed)?)\b/, 'tip_over'],
  [/\b(spin(?:s|ning)?|spun)\b/, 'spin'], [/\b(wobble[sd]?)\b/, 'wobble'], [/\b(stand(?:s)? up|stood up)\b/, 'stand_up'], [/\b(slide[sd]?|slid)\b/, 'slide'],
];
const AFFECT = '(?:flatten(?:s|ed)?|crush(?:es|ed)?|squash(?:es|ed)?|squish(?:es|ed)?|pin(?:s|ned)?|trap(?:s|ped)?|lands? on|landed on|falls? on|fell on|knock(?:s|ed)? (?:over|down)|topple[sd]? onto|hits)';

/** earliest non-negated verb rule in `scope` (rule order breaks ties) */
function verbIntent(scope: string, lastThing: string | null): (VerbRule & { at: number; target: string | null }) | null {
  let best: (VerbRule & { at: number; target: string | null }) | null = null;
  for (const r of VERB_RULES) {
    const re = new RegExp(r.re.source, 'g');
    for (let m = re.exec(scope); m; m = re.exec(scope)) {
      if (NEG.test(scope.slice(0, m.index))) continue;
      const after = toks(scope.slice(m.index + m[0].length)).slice(0, 5);
      const prop = after.map(propNoun).find(Boolean) ?? (after[0] === 'it' ? lastThing : null);
      if (r.button && prop !== 'suspicious_button') continue; // pressing needs the button as its object
      if (!best || m.index < best.at) best = { ...r, at: m.index, target: prop ? PROP_ANCHOR[prop] : null };
      break;
    }
  }
  return best;
}

export function interpretPhrase(text: string, selected: readonly string[], cast: readonly string[], state: SemanticState): PhraseSemantics {
  const lower = ` ${text.toLowerCase().replace(/[’]/g, "'")} `;
  const main = LEAD.test(text.trim()) && text.includes(',') ? text.slice(text.indexOf(',') + 1) : text;
  const mt = toks(main);
  let i = 0;
  while (i < mt.length && DISCOURSE.has(mt[i])) i++;
  // ---- main-clause subject ----
  let subj: { kind: 'character' | 'pronoun' | 'person' | 'thing' | 'none'; id?: string; mention?: string; prop?: string | null } = { kind: 'none' };
  const w0 = mt[i] ?? '';
  if (cast.includes(w0)) subj = { kind: 'character', id: w0 };
  else if (w0 === 'he' || w0 === 'she' || w0 === 'they') subj = { kind: 'pronoun', id: w0 };
  else if (w0 === 'it') subj = { kind: 'thing', prop: state.lastThing };
  else if (DET.has(w0)) for (const w of mt.slice(i + 1, i + 4)) {
    const p = propNoun(w);
    if (p) { subj = { kind: 'thing', prop: p }; break; }
    const person = scanIdea(w).characters.find((c) => c.kind !== 'cast');
    if (person) { subj = { kind: 'person', mention: person.mention }; break; }
  }
  // ---- selected characters referenced in the phrase (name or pronoun) ----
  const named = selected.filter((c) => new RegExp(`\\b${c}('s)?\\b`).test(lower)).sort((a, b) => lower.search(new RegExp(`\\b${a}\\b`)) - lower.search(new RegExp(`\\b${b}\\b`)));
  // ---- actor ----
  let actor: string | null = null, role: ActorRole = 'agent';
  if (subj.kind === 'character' && selected.includes(subj.id!)) actor = subj.id!;
  else if (subj.kind === 'pronoun') {
    const c = selected.filter((x) => CHARACTER_PRONOUNS[x] === subj.id);
    actor = c.length === 1 ? c[0] : state.lastActor && (!c.length || c.includes(state.lastActor)) ? state.lastActor : c[0] ?? null;
  }
  const explicit = !!actor;
  if (!actor && named.length) { actor = named[0]; role = named.length > 1 ? 'overview' : subj.kind === 'thing' || subj.kind === 'person' ? 'reactor' : 'agent'; }
  if (!actor && state.storySubject) { actor = state.storySubject; role = 'reactor'; }
  if (!actor) { actor = selected[state.fallback++ % selected.length]; role = 'fallback'; }
  const others = selected.filter((c) => c !== actor);
  const supporting = others.find((c) => named.includes(c) || (CHARACTER_PRONOUNS[c] && PRONOUN_FORMS[CHARACTER_PRONOUNS[c]].test(lower))) ?? null;
  // ---- people who are not built / not selected: off-screen, or blocking when they must visibly act ----
  const offscreen: string[] = [];
  let blocking: string | null = null;
  const people = [...scanIdea(text).characters.filter((c) => c.kind !== 'cast').map((c) => c.mention), ...cast.filter((c) => !selected.includes(c) && new RegExp(`\\b${c}\\b`).test(lower))];
  for (const m of [...new Set(people)]) {
    if (subj.kind === 'person' && subj.mention === m) {
      const after = main.slice(main.toLowerCase().indexOf(m) + m.length);
      if (!OFFSCREEN_VERB.test(after)) { blocking = `"${m}" would have to ${toks(after)[0] ?? 'act'} on screen, but no such character is built or selected`; continue; }
    }
    offscreen.push(m);
  }
  // ---- prop events per clause ("it" and a carried subject resolve to the last prop) ----
  const propEvents: PropEvent[] = [];
  let thing = state.lastThing, lastNamedProp: string | null = null;
  for (const clause of text.split(/,|;|\band\b|\bthen\b|\bwhich\b/i)) {
    const ct = toks(clause);
    // the clause's own subject: whichever comes first, a prop noun or "it" (the carried prop)
    const first = ct.findIndex((w) => propNoun(w) || w === 'it');
    const p = first < 0 ? null : ct[first] === 'it' ? thing : propNoun(ct[first]);
    // locations ("on the front desk") are not what later "it" refers to
    ct.forEach((w, k) => { const q = propNoun(w); if (q && !ct.slice(Math.max(0, k - 4), k).some((x) => LOCATIVE.has(x))) lastNamedProp = q; });
    const target = p ?? thing;
    if (p) thing = p;
    if (!target) continue;
    for (const [re, ev] of PROP_VERBS) if (re.test(clause.toLowerCase()) && PROP_ALLOWED[target]?.includes(ev) && !propEvents.some((e) => e.prop === target && e.event === ev)) propEvents.push({ prop: target, event: ev });
  }
  // ---- action ----
  let action: string | null = null, emotion: Emotion | null = null, target: string | null = null, cause: string | null = null, substitution: PhraseSemantics['substitution'] = null;
  const pron = CHARACTER_PRONOUNS[actor];
  const affected = new RegExp(`\\b${AFFECT}\\s+(?:\\w+\\s+){0,2}?(${actor}|${pron === 'he' ? 'him' : pron === 'she' ? 'her' : actor})\\b`).test(lower);
  if (affected) { role = 'affected'; action = 'fall'; emotion = 'shock'; cause = subj.kind === 'thing' ? subj.prop ?? null : null; }
  else if (role !== 'overview') {
    // the actor's own clause: after the explicit subject, or right after the actor's name when named as object/observed
    const at = lower.search(new RegExp(`\\b${actor}\\b`));
    const ml = main.toLowerCase(), sAt = ml.search(new RegExp(`\\b${w0}\\b`));
    const scope = explicit ? ml.slice(Math.max(0, sAt) + w0.length) : at >= 0 && role !== 'reactor' ? lower.slice(at + actor.length) : at >= 0 ? toks(lower.slice(at + actor.length)).slice(0, 3).join(' ') : role === 'fallback' ? lower : '';
    const v = scope ? verbIntent(scope, state.lastThing) : null;
    if (v) { action = v.action; emotion = v.emotion ?? null; target = v.target; if (v.sub) substitution = { requested: v.sub[0], used: v.action, reason: v.sub[1] }; }
    if (action === 'press_button' && !propEvents.some((e) => e.event === 'press')) propEvents.unshift({ prop: 'suspicious_button', event: 'press' });
    if (!action && propEvents.length) {
      // a thing is the subject: the actor reacts; the prop event is metadata for the renderer
      const ev = propEvents[propEvents.length - 1];
      [action, emotion, target] = ev.event === 'flash' ? ['curious_lean', 'curious', PROP_ANCHOR[ev.prop]] : ev.event === 'reset' ? ['look_at', 'regret', PROP_ANCHOR[ev.prop]]
        : ev.event === 'spawn' ? ['curious_lean', 'happy', PROP_ANCHOR[ev.prop]] : ['shock_recoil', 'shock', null];
      if (role === 'agent') role = 'reactor';
    }
    if (subj.kind === 'thing' && role === 'agent') role = 'reactor';
  }
  // ---- state for the next phrase ----
  if (explicit) state.storySubject = actor;
  state.lastActor = actor;
  state.lastThing = lastNamedProp ?? thing ?? state.lastThing;
  return { actor, actorRole: role, supporting, action, emotion, target, cause, propEvents: propEvents.slice(0, 6), offscreen, blocking, substitution };
}

export const PROP_DISPLAY = PROP_NAME;
