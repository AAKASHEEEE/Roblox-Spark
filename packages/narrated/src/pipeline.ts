// Narrated Story, Phase 1: SCRIPT + UPLOADED VOICE-OVER -> aligned phrases -> captions -> constrained storyboard.
// Deterministic rules planner only (no LLM). One phrase = one beat, built exclusively from the capability registry
// (characters, story-usable actions, locked faces, the built environment, camera presets). Anything the script asks
// for that is not built is substituted with a declared, explained stand-in, never invented.
// Rejection precedence: invalid input > unsafe > protected IP > unavailable > story incompatible > timeline incompatible.
import { v } from '../../schema/src/v.ts';
import { EXPRESSIONS } from '../../schema/src/episode.ts';
import { rng, hashSeed } from '../../engine/src/math.ts';
import { scanIdea } from '../../story/src/lexicon.ts';
import { findBannedTerms, BANNED_TERMS } from '../../pipeline/src/validate.ts';
import { EMOTION_FACE, type Registry } from '../../story/src/registry.ts';
import { CAPTION_PRESETS, CAPTION_STYLE, NARRATED_SCHEMA_VERSION, STORY_PATTERNS, forbiddenKeyPaths, validateNarratedStoryboard, type NarratedStoryboard, type NarratedPhrase, type StoryPattern, type StoryPurpose, type VocabIds } from './schema.ts';
import { AUDIO_DURATION_LIMITS, type DecodedAudio } from './audio.ts';
import { wordCount, type NarrationAligner, type AlignmentResult } from './align.ts';
import { fitsCaption, planCaption } from './captions.ts';

export const NARRATED_REJECTIONS = ['invalid_input', 'unsafe', 'protected_ip', 'unavailable', 'story_incompatible', 'timeline_incompatible'] as const;
export type NarratedRejectCategory = (typeof NARRATED_REJECTIONS)[number];
export interface NarratedRejection { category: NarratedRejectCategory; reason: string; also: Array<{ category: NarratedRejectCategory; reason: string }> }
export const MAX_PHRASES = 80;

export const NarratedRequestSchema = v.object({
  title: v.string({ min: 1, max: 80 }),
  script: v.string({ min: 1, max: 6000 }),
  audioHash: v.string({ pattern: /^[0-9a-f]{64}$/ }),
  characters: v.array(v.string({ pattern: /^[a-z][a-z0-9_-]{0,31}$/ }), { min: 1, max: 2 }),
  storyPattern: v.enum(STORY_PATTERNS),
  seed: v.int({ min: 0, max: 2147483647 }),
  captionPreset: v.enum(CAPTION_PRESETS),
});
export type NarratedRequest = { title: string; script: string; audioHash: string; characters: string[]; storyPattern: StoryPattern; seed: number; captionPreset: (typeof CAPTION_PRESETS)[number] };
export interface AudioMeta { originalFilename: string; format: DecodedAudio['format']; codec: string; durationSeconds: number; sampleRate: number; channels: number; contentHash: string }
export interface NarratedResult { status: 'accepted' | 'rejected'; rejection: NarratedRejection | null; storyboard: NarratedStoryboard | null; alignment: AlignmentResult | null }

export function vocabIds(reg: Registry): VocabIds {
  return { characters: reg.ids.characters, actions: reg.ids.actions, expressions: EXPRESSIONS, environments: reg.ids.environments, cameras: reg.cameras };
}
export function perCharacterVocab(reg: Registry): Record<string, { actions: string[]; expressions: string[] }> {
  return Object.fromEntries(Object.entries(reg.characters).map(([id, c]) => [id, { actions: c.allowedActions.filter((a) => reg.ids.actions.includes(a)), expressions: [...c.allowedExpressions] }]));
}

/** one caption phrase per non-empty line; blank lines separate sections. Text is data: it is never evaluated. */
export function parseScript(script: string): Array<{ text: string; section: number }> {
  const out: Array<{ text: string; section: number }> = [];
  let section = 1, gap = false;
  for (const raw of script.replace(/\r\n?/g, '\n').split('\n')) {
    const text = raw.replace(/[\t ]+/g, ' ').trim();
    if (!text) { gap = out.length > 0; continue; }
    if (gap) { section++; gap = false; }
    out.push({ text, section });
  }
  return out;
}

const BRAND_TERMS = new Set(BANNED_TERMS.slice(0, BANNED_TERMS.indexOf('free robux')).map((t) => t.trim()));
function contentRejections(title: string, lines: string[]): Array<{ category: NarratedRejectCategory; reason: string }> {
  const out: Array<{ category: NarratedRejectCategory; reason: string }> = [];
  const texts = [title, ...lines];
  const unsafe = new Set<string>(), ip = new Set<string>();
  // the independent story safety scan (terms + contextual intent) on the whole script and on each line
  for (const t of [texts.join('\n'), ...texts]) {
    const s = scanIdea(t);
    for (const x of s.safety) unsafe.add(`${x.category} (${x.term})`);
    // captions print the script verbatim, so even a style-qualified brand mention would appear on screen
    for (const x of s.ip) ip.add(x.name);
  }
  for (const b of findBannedTerms(texts)) (BRAND_TERMS.has(b) ? ip : unsafe).add(BRAND_TERMS.has(b) ? b : `banned term (${b})`);
  if (unsafe.size) out.push({ category: 'unsafe', reason: `the script contains content that family-safe episodes cannot show: ${[...unsafe].slice(0, 6).join(', ')}` });
  if (ip.size) out.push({ category: 'protected_ip', reason: `the script names protected brands, characters or real people that captions would display: ${[...ip].slice(0, 6).join(', ')}` });
  return out;
}

// ---------- beat rules ----------
type Emotion = keyof (typeof EMOTION_FACE)['zapp'];
interface PurposeRule { emotion: Emotion; action: string; cameras: string[]; support: Emotion | null; text: string }
const PURPOSE: Record<StoryPurpose, PurposeRule> = {
  hook: { emotion: 'curious', action: 'curious_lean', cameras: ['frontal_medium', 'low_angle_reveal'], support: null, text: 'hooks the viewer with the premise' },
  setup: { emotion: 'neutral', action: 'look_at', cameras: ['wide_environment', 'frontal_medium'], support: null, text: 'sets up the situation' },
  'initial-benefit': { emotion: 'happy', action: 'victory_pose', cameras: ['frontal_medium', 'low_angle_reveal', 'reaction_punch_in'], support: null, text: 'shows the apparent benefit' },
  escalation: { emotion: 'surprised', action: 'shock_recoil', cameras: ['reaction_punch_in', 'low_angle_reveal', 'chase_cam'], support: 'shock', text: 'raises the stakes' },
  turn: { emotion: 'shock', action: 'shock_recoil', cameras: ['reaction_punch_in', 'two_shot'], support: 'smug', text: 'marks the turn in the story' },
  consequence: { emotion: 'regret', action: 'regret_freeze', cameras: ['frontal_medium', 'reaction_punch_in', 'over_shoulder'], support: 'laugh', text: 'shows the consequence' },
  reaction: { emotion: 'skeptical', action: 'head_shake', cameras: ['reaction_punch_in', 'two_shot'], support: 'shock', text: 'reacts to what just happened' },
  'comparison-a': { emotion: 'determined', action: 'point', cameras: ['over_shoulder', 'frontal_medium'], support: 'skeptical', text: 'shows the first side of the comparison' },
  'comparison-b': { emotion: 'smug', action: 'arms_crossed', cameras: ['over_shoulder', 'two_shot'], support: 'shock', text: 'shows the other side of the comparison' },
  punchline: { emotion: 'laugh', action: 'laugh', cameras: ['two_shot', 'reaction_punch_in'], support: 'shock', text: 'lands the punchline' },
  closing: { emotion: 'happy', action: 'turn_toward', cameras: ['final_loop', 'frontal_medium'], support: null, text: 'closes the story' },
};
/** verbs in the narration -> a registered action that demonstrates them (first match wins) */
const VERBS: Array<[RegExp, string]> = [
  [/\b(chas(e|es|ed|ing))\b/i, 'chase'], [/\b(run|runs|ran|running|rush(es|ed)?|sprint(s|ed)?|escape[sd]?)\b/i, 'run'],
  [/\b(walk(s|ed|ing)?|go(es)?|went|head(s|ed)? to)\b/i, 'walk'], [/\b(jump(s|ed|ing)?|leap(s|t)?|bounce[sd]?)\b/i, 'jump'],
  [/\b(fall(s|ing)?|fell|trip(s|ped)?|collapse[sd]?)\b/i, 'fall'], [/\b(press(es|ed)?|button)\b/i, 'press_button'],
  [/\b(laugh(s|ed|ing)?|hilarious|funny)\b/i, 'laugh'], [/\b(celebrat(e|es|ed|ing)|win(s)?|won|party|perfect|amazing|awesome)\b/i, 'victory_pose'],
  [/\b(scared|afraid|terrified|hide[sd]?|hiding)\b/i, 'cower'], [/\b(angry|mad|furious|scream(s|ed|ing)?|yell(s|ed)?|rage)\b/i, 'angry_stomp'],
  [/\b(shock(ed)?|suddenly|gasp(s|ed)?)\b/i, 'shock_recoil'], [/\b(forgot|mistake|oops|facepalm|embarrass(ed|ing)?)\b/i, 'facepalm'],
  [/\b(miss(es|ed|ing)?|regret(s|ted)?|sad|lonely|alone|cry|cries|cried)\b/i, 'regret_freeze'], [/\b(never|refuse[sd]?|nope)\b/i, 'head_shake'],
  [/\b(imagine|wonder(s|ed)?|curious|think(s)?|thought)\b/i, 'curious_lean'], [/\b(point(s|ed)? at|blame[sd]?)\b/i, 'point'],
  [/\b(look(s|ed)?|see[sn]?|saw|watch(es|ed)?|notice[sd]?|stare[sd]?)\b/i, 'look_at'], [/\b(wait(s|ed|ing)?|bored|unimpressed)\b/i, 'arms_crossed'],
  [/\b(leave[sd]?|left|walk(s|ed)? away|exit(s|ed)?)\b/i, 'exit_frame'], [/\b(arrive[sd]?|enter(s|ed)?|show(s|ed)? up|come[s]? in)\b/i, 'enter_frame'],
];
/** things the script may describe that no rig/prop can show yet -> substitute (never invented) */
const UNBUILT: Array<[RegExp, string, string, string]> = [
  [/\b(drive|drives|drove|driving|car|cars)\b/i, 'driving', 'run', 'no vehicle asset exists; shown as running'],
  [/\b(fly|flies|flew|flying)\b/i, 'flying', 'jump', 'no floating rig exists (hover unavailable); shown as a jump'],
  [/\b(eat|eats|ate|eating|drink|drinks|drank|meal|meals|food)\b/i, 'eating/drinking', 'look_at', 'hand attachment and food props are not built; shown as a look'],
  [/\b(hold|holds|holding|grab|grabs|grabbed|pick(s|ed)? up|throw|throws|threw|phone|phones)\b/i, 'holding an object', 'point', 'hand attachment is not built; shown as a point gesture'],
  [/\b(sleep|sleeps|slept|asleep|nap)\b/i, 'sleeping', 'regret_freeze', 'no sleep animation exists; shown as a freeze'],
];
const TURN = /^(but|however|until|suddenly|unfortunately|except|then one day|one day|and then)\b|\b(but then|until one day|the worst part)\b/i;
const ESCALATE = /\b(worst|even|more|again|bigger|every day|forever|keeps?)\b|!$/i;
const VERB_TEXT: Record<string, string> = {
  idle: 'stands still', walk: 'walks across the room', run: 'runs', chase: 'gives chase', enter_frame: 'enters the frame', exit_frame: 'leaves the frame', dive_prone: 'dives to the floor',
  point: 'points', press_button: 'presses the button', look_at: 'looks over', turn_toward: 'turns to the camera', curious_lean: 'leans in curiously', shock_recoil: 'recoils in shock',
  cower: 'cowers', arms_crossed: 'crosses their arms', head_shake: 'shakes their head', victory_pose: 'celebrates', laugh: 'laughs', facepalm: 'facepalms', regret_freeze: 'freezes in regret',
  angry_stomp: 'stomps angrily', jump: 'jumps', fall: 'falls over',
};

function purposes(pattern: StoryPattern, lines: Array<{ text: string; section: number }>): StoryPurpose[] {
  const N = lines.length, sections = new Set(lines.map((l) => l.section)).size;
  let turned = false;
  return lines.map((l, k): StoryPurpose => {
    if (k === 0) return 'hook';
    if (k === N - 1 && N > 2) return pattern === 'narrated_comedy' ? 'punchline' : 'closing';
    const isTurn = TURN.test(l.text);
    if (pattern === 'comparison') return isTurn && !turned ? ((turned = true), 'turn') : (sections > 1 ? l.section % 2 === 1 : k % 2 === 1) ? 'comparison-a' : 'comparison-b';
    if (isTurn) { const first = !turned; turned = true; return first ? 'turn' : 'escalation'; }
    if (pattern === 'hypothetical') return turned ? (ESCALATE.test(l.text) ? 'escalation' : 'consequence') : k === 1 && /\b(imagine|what if|if you)\b/i.test(l.text) ? 'setup' : 'initial-benefit';
    if (pattern === 'escalating_consequence') return turned ? 'consequence' : k === 1 ? 'setup' : 'escalation';
    return turned ? (k % 2 ? 'reaction' : 'consequence') : 'setup';
  });
}

function planBeats(req: NarratedRequest, lines: Array<{ text: string; section: number }>, al: AlignmentResult, reg: Registry): NarratedPhrase[] {
  const rand = rng((hashSeed(req.script) ^ req.seed) >>> 0);
  const chars = req.characters, per = perCharacterVocab(reg), P = purposes(req.storyPattern, lines);
  const face = (who: string, e: Emotion) => { const f = EMOTION_FACE[who]?.[e]; return f && per[who].expressions.includes(f) ? f : per[who].expressions[0]; };
  const name = (id: string) => reg.characters[id]?.displayName ?? id;
  let prevCam = '';
  return lines.map((l, k) => {
    const a = al.phrases[k], purpose = P[k], rule = PURPOSE[purpose];
    const warnings: Array<{ code: string; message: string }> = [], subs: NarratedPhrase['substitutions'] = [];
    const actor = chars.length > 1 && (purpose === 'comparison-b' || purpose === 'reaction') ? chars[1] : chars[0];
    const other = chars.find((c) => c !== actor) ?? null;
    const supporting = other && rule.support ? other : null;
    // action: narration verb > unbuilt substitution > purpose default; must be story-usable AND allowed for this rig
    let action = rule.action;
    const verb = VERBS.find(([re]) => re.test(l.text));
    const unbuilt = UNBUILT.find(([re]) => re.test(l.text));
    if (unbuilt && (!verb || unbuilt[0].exec(l.text)!.index <= verb[0].exec(l.text)!.index)) { action = unbuilt[2]; subs.push({ requested: unbuilt[1], used: unbuilt[2], reason: unbuilt[3] }); warnings.push({ code: 'ACTION_SUBSTITUTED', message: `"${unbuilt[1]}" is not available: ${unbuilt[3]}` }); }
    else if (verb) action = verb[1];
    if (!per[actor].actions.includes(action)) { warnings.push({ code: 'ACTION_UNAVAILABLE', message: `${action} is not available for ${name(actor)}; using ${rule.action}` }); subs.push({ requested: action, used: rule.action, reason: 'action not available for this character' }); action = rule.action; }
    const target = action === 'facepalm' ? `${actor}.face` : action === 'press_button' ? 'button.press_surface'
      : ['look_at', 'point', 'curious_lean', 'turn_toward'].includes(action) ? (action === 'turn_toward' ? 'camera' : other ?? 'board_center') : null;
    // environment: only the built classroom; other places are declared substitutions
    for (const p of scanIdea(l.text).places.filter((x) => x.kind !== 'classroom')) { subs.push({ requested: p.mention, used: reg.environment.id, reason: `no "${p.mention}" environment is built` }); warnings.push({ code: 'ENVIRONMENT_SUBSTITUTED', message: `no "${p.mention}" environment is built; staged in the ${reg.environment.id}` }); }
    for (const o of scanIdea(l.text).objects.filter((x) => x.kind === 'unavailable')) warnings.push({ code: 'PROP_UNAVAILABLE', message: `no "${o.mention}" prop exists; conveyed by gesture and caption only` });
    // camera: purpose candidates, seeded choice, never the same preset twice in a row (1-2 s visual-change grammar)
    const cams = rule.cameras.filter((c) => reg.cameras.includes(c) && c !== prevCam);
    const camera = (cams.length ? cams : reg.cameras.filter((c) => c !== prevCam))[Math.floor(rand() * (cams.length || reg.cameras.length - 1))];
    prevCam = camera;
    const cap = planCaption(l.text, a.start, a.end);
    warnings.push(...cap.warnings);
    if (a.method === 'split-region' || a.method === 'word-proportional') warnings.push({ code: 'ALIGNMENT_ESTIMATED', message: `timing estimated by word count (${a.method}); no pause was detected for this phrase` });
    else if (a.confidence < 0.6) warnings.push({ code: 'ALIGNMENT_LOW_CONFIDENCE', message: `phrase timing confidence ${a.confidence}` });
    const expression = face(actor, rule.emotion), supExpr = supporting ? face(supporting, rule.support!) : null;
    return {
      id: `p${String(k + 1).padStart(2, '0')}`, section: l.section, text: l.text, words: wordCount(l.text), start: a.start, end: a.end,
      alignmentMethod: a.method, alignmentConfidence: a.confidence, storyPurpose: purpose, actor, supportingCharacter: supporting,
      semanticAction: action, target, expression, supportingExpression: supExpr, environment: reg.environment.id, cameraPreset: camera,
      visualIntent: `${name(actor)} ${VERB_TEXT[action] ?? action} (${expression})${supporting ? `; ${name(supporting)} reacts (${supExpr})` : ''} — ${rule.text}.`,
      substitutions: subs.slice(0, 6), caption: { lines: cap.lines, emphasisWords: cap.emphasisWords, wordsPerSecond: cap.wordsPerSecond }, warnings: warnings.slice(0, 12),
    };
  });
}

function rank(all: Array<{ category: NarratedRejectCategory; reason: string }>): NarratedRejection | null {
  if (!all.length) return null;
  const s = all.map((r, i) => ({ r, i })).sort((a, b) => NARRATED_REJECTIONS.indexOf(a.r.category) - NARRATED_REJECTIONS.indexOf(b.r.category) || a.i - b.i).map((x) => x.r);
  return { ...s[0], also: s.slice(1, 9) };
}

export interface NarratedDeps { registry: Registry; aligner: NarrationAligner; sha256: (s: string) => string }
/** the audio is resolved by the caller from the request's content hash (server: verified upload store) */
export async function generateNarratedStoryboard(requestIn: unknown, audio: { meta: AudioMeta; decoded: DecodedAudio; path: string | null } | null, deps: NarratedDeps): Promise<NarratedResult> {
  const reject = (r: NarratedRejection | null): NarratedResult => ({ status: 'rejected', rejection: r, storyboard: null, alignment: null });
  const bad = forbiddenKeyPaths(requestIn);
  if (bad.length) return reject(rank([{ category: 'invalid_input', reason: `forbidden key(s): ${bad.join(', ')}` }]));
  const parsed = NarratedRequestSchema.parse(requestIn);
  if (!parsed.ok) return reject(rank([{ category: 'invalid_input', reason: parsed.issues.slice(0, 4).map((i) => `${i.path}: ${i.message}`).join('; ') }]));
  const req = parsed.value as NarratedRequest, reg = deps.registry;
  const lines = parseScript(req.script);
  const reasons: Array<{ category: NarratedRejectCategory; reason: string }> = [];
  if (!audio || audio.meta.contentHash !== req.audioHash) reasons.push({ category: 'invalid_input', reason: 'the voice-over for this content hash is not available; re-upload the same voice-over file' });
  reasons.push(...contentRejections(req.title, lines.map((l) => l.text)));
  const unknown = req.characters.filter((c) => !reg.characters[c]);
  if (unknown.length) reasons.push({ category: 'unavailable', reason: `unknown character(s): ${unknown.join(', ')} (registered: ${reg.ids.characters.join(', ')})` });
  if (new Set(req.characters).size !== req.characters.length) reasons.push({ category: 'invalid_input', reason: 'characters must be distinct' });
  if (lines.length < 2) reasons.push({ category: 'story_incompatible', reason: 'the script needs at least two phrase lines (one caption phrase per line)' });
  if (lines.length > MAX_PHRASES) reasons.push({ category: 'story_incompatible', reason: `the script has ${lines.length} phrase lines (maximum ${MAX_PHRASES})` });
  const long = lines.map((l, i) => ({ l, i })).filter(({ l }) => !fitsCaption(l.text) || !/[\p{L}\p{N}]/u.test(l.text));
  if (long.length) reasons.push({ category: 'story_incompatible', reason: `line(s) ${long.map((x) => x.i + 1).slice(0, 8).join(', ')} cannot be shown as a two-line caption of at most ${CAPTION_STYLE.shorts_default.maxCharsPerLine} characters per line; split them into shorter lines` });
  if (audio && lines.length && audio.meta.durationSeconds < lines.length * 0.4) reasons.push({ category: 'timeline_incompatible', reason: `${lines.length} phrases cannot fit in ${audio.meta.durationSeconds.toFixed(2)} s of audio (minimum 0.4 s per phrase)` });
  if (reasons.length) return reject(rank(reasons));

  const al = await deps.aligner.align({ audioPath: audio!.path, audio: audio!.decoded, phrases: lines.map((l) => l.text), seed: req.seed });
  const phrases = planBeats(req, lines, al, reg);
  const warnings: Array<{ code: string; message: string }> = [];
  if (al.level === 'low') warnings.push({ code: 'ALIGNMENT_LOW_CONFIDENCE', message: `low alignment confidence (${al.confidence}): ${al.note}. Timings are estimates; check them against the audio.` });
  else if (al.level === 'medium') warnings.push({ code: 'ALIGNMENT_ESTIMATED', message: `medium alignment confidence (${al.confidence}): some phrases were merged or split. ${al.note}` });
  const D = audio!.meta.durationSeconds;
  if (D < AUDIO_DURATION_LIMITS.targetMin || D > AUDIO_DURATION_LIMITS.targetMax) warnings.push({ code: 'DURATION_OUTSIDE_TARGET', message: `voice-over is ${D.toFixed(2)} s; narrated shorts target ${AUDIO_DURATION_LIMITS.targetMin}-${AUDIO_DURATION_LIMITS.targetMax} s` });
  const fast = phrases.filter((p) => p.warnings.some((w) => w.code === 'READING_SPEED_HIGH')).length;
  if (fast) warnings.push({ code: 'READING_SPEED_HIGH', message: `${fast} caption(s) exceed the reading-speed limit` });
  const m = audio!.meta, st = CAPTION_STYLE[req.captionPreset];
  const idSource = JSON.stringify([NARRATED_SCHEMA_VERSION, req.title, req.script, req.audioHash, req.characters, req.storyPattern, req.seed, req.captionPreset, al.aligner]);
  const sb: NarratedStoryboard = {
    schemaVersion: NARRATED_SCHEMA_VERSION, mode: 'narrated_story', id: `nr-${deps.sha256(idSource).slice(0, 12)}`, title: req.title, seed: req.seed,
    storyPattern: req.storyPattern, captionPreset: req.captionPreset,
    audio: { source: 'uploaded', format: m.format, codec: m.codec, originalFilename: m.originalFilename, durationSeconds: m.durationSeconds, sampleRate: m.sampleRate, channels: m.channels, contentHash: m.contentHash },
    characters: [...req.characters], script: { originalText: req.script, phrases },
    alignment: { method: al.aligner, level: al.level, confidence: al.confidence, phraseCount: phrases.length, speechRegions: al.speechRegions.length, estimatedPhrases: al.estimatedPhrases, note: al.note.slice(0, 300) },
    captionStyle: { preset: req.captionPreset, anchor: st.anchor, centerY: st.centerY, bottomSafe: st.bottomSafe, maxLines: st.maxLines, maxCharsPerLine: st.maxCharsPerLine },
    timeline: phrases.map((p, i) => ({ beatId: `b${String(i + 1).padStart(2, '0')}`, phraseId: p.id, start: p.start, end: p.end, cameraPreset: p.cameraPreset, actor: p.actor, semanticAction: p.semanticAction })),
    validation: { status: warnings.length || phrases.some((p) => p.warnings.length) ? 'warning' : 'ok', errors: [], warnings },
  };
  // the planner's own output must pass the strict schema + semantic validator (registry-only vocabulary)
  const v2 = validateNarratedStoryboard(sb, vocabIds(reg), perCharacterVocab(reg));
  if (!v2.ok) return { ...reject(rank([{ category: 'timeline_incompatible', reason: `storyboard failed validation: ${v2.issues.slice(0, 3).map((i) => `${i.path}: ${i.message}`).join('; ')}` }])), alignment: al };
  return { status: 'accepted', rejection: null, storyboard: v2.value, alignment: al };
}
