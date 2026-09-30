// caption_bold planner (S7): aligned narration phrases -> 1-4 word captions, each with exactly one highlighted keyword.
//
// Input is PHRASE-level alignment (packages/narrated/src/align.ts gives phrase start/end only). Inside a phrase the
// words are timed by an estimate: each word weighs 1 + 0.08 * letters, and a word followed by , ; : . ! ? carries its
// pause. Captions are contiguous from phrase.start to phrase.end and never cross into the gap before the next phrase.
// Grouping is a DP: 2-3 word groups preferred, breaks after punctuation rewarded, a group never ends on a function word
// ("the", "a", "to") unless the phrase ends there, and very short groups are merged when speech is fast.
// The concatenated caption words are exactly the phrase words (nothing dropped, added or reordered). Deterministic.
import { TEXT_STYLE_DEFS, type HighlightColor } from './styles.ts';

export interface AlignedPhraseIn {
  id: string;
  start: number;
  end: number;
  text: string;
  /** preferred keywords (director highlights / narrated emphasisWords); first match inside a caption wins */
  emphasis?: readonly string[];
}
export interface BoldCaption {
  /** `${phraseId}-b01`... */
  id: string;
  phraseId: string;
  start: number;
  end: number;
  /** source words, verbatim */
  words: string[];
  /** display words (upper-cased, trailing , . ; : removed) */
  display: string[];
  /** index into words of the single highlighted keyword */
  highlightIndex: number;
  highlight: string;
  highlightColor: HighlightColor;
}
export interface BoldCaptionPlan { captions: BoldCaption[]; warnings: Array<{ code: string; phraseId: string; message: string }> }
export interface BoldPlanOptions {
  /** display in capitals (default true) */
  uppercase?: boolean;
  /** shortest comfortable on-screen time (s); shorter groups are penalised (default 0.32) */
  minSeconds?: number;
  /** override the colour rule */
  colorFor?: (word: string) => HighlightColor;
}

export const MAX_WORDS = TEXT_STYLE_DEFS.caption_bold.maxWordsPerChunk;
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'so', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'by', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', "it's", 'this', 'that', 'these', 'those', 'he', 'she', 'him', 'her', 'his', 'they', 'them', 'their', 'you', 'your', 'we', 'our', 'i', 'my', 'me', 'then', 'than', 'when', 'what', 'which', 'who', 'why', 'how', 'there', 'here', 'from', 'into', 'onto', 'about', 'just', 'like', 'would', 'could', 'should', 'will', 'can', 'has', 'have', 'had', 'do', 'does', 'did', 'if', 'because', 'while', 'even', 'more', 'most', 'very', 'one', 'out', 'up', 'down', 'off', 'over', 'again', 'already', 'also', 'any', 'all', 'some', 'every', 'being', 'makes', 'make', 'gets', 'get', 'got']);
/** negation, danger and impact words: highlighted in red; everything else in yellow */
export const RED_WORDS = new Set(['not', 'no', 'never', "don't", 'dont', "can't", 'cant', "won't", 'wont', 'stop', 'nope', 'wrong', 'danger', 'dangerous', 'warning', 'warns', 'fail', 'fails', 'failed', 'banned', 'ban', 'crash', 'crashes', 'explodes', 'explosion', 'boom', 'flattens', 'flattened', 'crushed', 'squashed', 'dies', 'dead', 'trouble', 'caught', 'busted', 'worst', 'disaster', 'suspicious']);
const STRONG = new Set(['never', 'always', 'perfect', 'worst', 'best', 'forever', 'nothing', 'nobody', 'suddenly', 'huge', 'giant', 'tiny', 'impossible', 'instantly', 'wrong', 'secret', 'biggest', 'smallest', 'free', 'entire', 'exact', 'only', 'first', 'last', 'next']);

/** content-light words that should only be highlighted when nothing better is in the caption */
const WEAK = new Set(['between', 'because', 'against', 'almost', 'around', 'through', 'without', 'within', 'before', 'after', 'during', 'another', 'something', 'someone', 'thing', 'things', 'really', 'actually', 'begins', 'starts', 'tries', 'thinks', 'knows', 'sees', 'says', 'tells', 'looks', 'wants', 'goes', 'comes', 'takes', 'second', 'moment', 'way', 'time', 'which', 'obviously']);
const r3 = (x: number) => Math.round(x * 1000) / 1000;
export const bareWord = (w: string) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
const low = (w: string) => bareWord(w).toLowerCase();
const endsClause = (w: string) => /[,;:.!?]["')\]]*$/.test(w);
const endsSentence = (w: string) => /[.!?]["')\]]*$/.test(w);
const isName = (w: string, i: number) => i > 0 && /^\p{Lu}\p{Ll}+$/u.test(bareWord(w));
const isStop = (w: string) => STOP.has(low(w));
const letters = (w: string) => bareWord(w).length;

/** default colour rule */
export const highlightColorFor = (w: string): HighlightColor => (RED_WORDS.has(low(w)) ? 'red' : 'yellow');
export const displayWord = (w: string, upper = true): string => { const s = w.replace(/[,;:.]+(["')\]]*)$/u, '$1'); return upper ? s.toUpperCase() : s; };

/** keyword rank inside one caption (lower is stronger); ties -> longer word, then earlier */
function keywordRank(w: string, i: number, emphasis: Set<string>): number {
  const b = bareWord(w), l = b.toLowerCase();
  if (!b) return 99;
  if (emphasis.has(l)) return 0;
  if (/^\p{Lu}{2,}$/u.test(b) || /\d/.test(b)) return 1;
  if (RED_WORDS.has(l) || STRONG.has(l)) return 2;
  if (STOP.has(l)) return 8;
  if (WEAK.has(l)) return 6;
  if (isName(w, i)) return 5;
  if (b.length >= 5 && /(s|ed|ing|ly)$/.test(l)) return 3; // action verbs / adverbs carry the beat
  return 4;
}
export function pickHighlight(words: readonly string[], emphasis: readonly string[] = [], offset = 0): number {
  const em = new Set(emphasis.map((e) => low(e)));
  let best = 0, bestKey: [number, number, number] = [Infinity, 0, 0];
  words.forEach((w, i) => {
    const key: [number, number, number] = [keywordRank(w, i + offset, em), -letters(w), i];
    if (key[0] < bestKey[0] || (key[0] === bestKey[0] && (key[1] < bestKey[1] || (key[1] === bestKey[1] && key[2] < bestKey[2])))) { best = i; bestKey = key; }
  });
  return best;
}

const wordWeight = (w: string) => 1 + 0.08 * letters(w) + (endsSentence(w) ? 0.9 : endsClause(w) ? 0.55 : 0);

function groupWords(words: string[], dur: number, minSec: number): number[] {
  const n = words.length, wts = words.map(wordWeight), W = wts.reduce((a, b) => a + b, 0) || 1;
  const cum = [0]; for (const x of wts) cum.push(cum[cum.length - 1] + x);
  const best = new Float64Array(n + 1).fill(Infinity), from = new Int32Array(n + 1).fill(-1);
  best[0] = 0;
  for (let i = 1; i <= n; i++) for (let k = 1; k <= Math.min(MAX_WORDS, i); k++) {
    const j = i - k;
    if (best[j] === Infinity) continue;
    const g = words.slice(j, i), last = g[k - 1], chars = g.join(' ').length;
    let c = best[j] + 10;
    if (k === 1) c += letters(g[0]) >= 8 || STRONG.has(low(g[0])) || RED_WORDS.has(low(g[0])) ? 4 : 14;
    if (k === 4) c += 3;
    if (chars > 22) c += (chars - 22) * 1.5;
    if (i < n) {
      if (endsClause(last)) c -= 8;
      else if (isStop(last)) c += 12;
      if (isName(words[i], i) && isName(last, i - 1)) c += 20; // keep "Mister Smith" together
    }
    if (j > 0 && k <= 2 && g.every(isStop)) c += 10; // "of the" alone
    const sec = (dur * (cum[i] - cum[j])) / W;
    if (sec < minSec) c += (minSec - sec) * 60;
    if (c < best[i]) { best[i] = c; from[i] = j; }
  }
  const cuts: number[] = [];
  for (let i = n; i > 0; i = from[i]) cuts.unshift(i);
  return cuts;
}

/** Plan caption_bold captions for aligned phrases (sorted by start; phrases must not overlap). */
export function planBoldCaptions(phrases: readonly AlignedPhraseIn[], opts: BoldPlanOptions = {}): BoldCaptionPlan {
  const upper = opts.uppercase ?? true, minSec = opts.minSeconds ?? 0.32, colorFor = opts.colorFor ?? highlightColorFor;
  const captions: BoldCaption[] = [], warnings: BoldCaptionPlan['warnings'] = [];
  let prevEnd = -Infinity;
  for (const p of phrases) {
    const words = p.text.trim().split(/\s+/).filter(Boolean);
    if (!words.length) { warnings.push({ code: 'EMPTY_PHRASE', phraseId: p.id, message: 'phrase has no words' }); continue; }
    if (!(p.end > p.start)) { warnings.push({ code: 'BAD_TIMING', phraseId: p.id, message: `end ${p.end} is not after start ${p.start}` }); continue; }
    if (p.start < prevEnd - 1e-9) warnings.push({ code: 'PHRASE_OVERLAP', phraseId: p.id, message: `starts at ${p.start} before the previous phrase ends (${prevEnd})` });
    prevEnd = p.end;
    const dur = p.end - p.start, cuts = groupWords(words, dur, minSec);
    const wts = words.map(wordWeight), W = wts.reduce((a, b) => a + b, 0);
    let j = 0, acc = 0, t = p.start;
    cuts.forEach((i, k) => {
      const g = words.slice(j, i);
      acc += wts.slice(j, i).reduce((a, b) => a + b, 0);
      const last = k === cuts.length - 1, end = last ? p.end : r3(p.start + (dur * acc) / W);
      const hi = pickHighlight(g, p.emphasis ?? [], j);
      captions.push({ id: `${p.id}-b${String(k + 1).padStart(2, '0')}`, phraseId: p.id, start: r3(t), end, words: g, display: g.map((w) => displayWord(w, upper)), highlightIndex: hi, highlight: bareWord(g[hi]), highlightColor: colorFor(g[hi]) });
      if (end - t < 0.2) warnings.push({ code: 'CAPTION_TOO_SHORT', phraseId: p.id, message: `"${g.join(' ')}" is on screen for ${(end - t).toFixed(2)} s` });
      t = end; j = i;
    });
  }
  return { captions, warnings };
}

/** Beat-sheet adapter: phrases = beats (one beat per aligned phrase); the director's caption highlights become emphasis hints. */
export function phrasesFromBeats(beats: ReadonlyArray<{ phraseId: string; start: number; end: number; text: string; captions?: ReadonlyArray<{ highlight?: string }> }>): AlignedPhraseIn[] {
  return beats.map((b) => ({ id: b.phraseId, start: b.start, end: b.end, text: b.text, emphasis: (b.captions ?? []).map((c) => c.highlight).filter((h): h is string => !!h) }));
}

/** Invariants a plan must satisfy (used by the stills tool and available for tests / render gates). */
export function checkBoldPlan(phrases: readonly AlignedPhraseIn[], plan: BoldCaptionPlan): string[] {
  const out: string[] = [];
  for (const p of phrases) {
    const cs = plan.captions.filter((c) => c.phraseId === p.id);
    const words = p.text.trim().split(/\s+/).filter(Boolean);
    if (cs.flatMap((c) => c.words).join(' ') !== words.join(' ')) out.push(`${p.id}: caption words differ from the phrase`);
    if (cs.length && (Math.abs(cs[0].start - p.start) > 1e-3 || Math.abs(cs[cs.length - 1].end - p.end) > 1e-3)) out.push(`${p.id}: captions do not span the phrase`);
    cs.forEach((c, k) => {
      if (c.words.length < 1 || c.words.length > MAX_WORDS) out.push(`${c.id}: ${c.words.length} words`);
      if (!(c.end > c.start)) out.push(`${c.id}: empty time range`);
      if (k && Math.abs(c.start - cs[k - 1].end) > 1e-9) out.push(`${c.id}: not contiguous`);
      if (!(c.highlightIndex >= 0 && c.highlightIndex < c.words.length)) out.push(`${c.id}: no highlight`);
      if (c.highlightColor !== 'yellow' && c.highlightColor !== 'red') out.push(`${c.id}: highlight colour ${c.highlightColor}`);
    });
  }
  return out;
}
