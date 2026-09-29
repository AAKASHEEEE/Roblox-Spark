// Phrase-level caption planner: <= 2 lines, balanced break, no short orphan word, names kept together, punctuation
// preserved, emphasis words stored separately, reading speed measured. Captions are data only (burn-in is Phase 2).
import { CAPTION_STYLE } from './schema.ts';

export interface CaptionPlan { lines: string[]; emphasisWords: string[]; wordsPerSecond: number; warnings: Array<{ code: string; message: string }> }
const STYLE = CAPTION_STYLE.shorts_default;
const STRONG = new Set(['never', 'always', 'perfect', 'worst', 'best', 'forever', 'nothing', 'nobody', 'suddenly', 'huge', 'giant', 'tiny', 'impossible', 'instantly', 'wrong', 'secret', 'biggest', 'smallest']);
const WEAK = new Set(['everything', 'everyone', 'finally', 'only', 'real', 'actually', 'right', 'first', 'last', 'free', 'every', 'no']);
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'you', 'your', 'would', 'could', 'should', 'that', 'this', 'they', 'their', 'there', 'then', 'what', 'when', 'which', 'about', 'from', 'into', 'were', 'have', 'will', 'just', 'like']);
const bare = (w: string) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
const isName = (w: string, i: number) => i > 0 && /^\p{Lu}\p{Ll}+/u.test(bare(w));

/** longest phrase that can fit in the caption box (checked at input time so no caption is ever truncated) */
export const fitsCaption = (text: string): boolean => splitLines(text.trim().split(/\s+/)) !== null;

function splitLines(words: string[]): string[] | null {
  const full = words.join(' ');
  if (full.length <= STYLE.maxCharsPerLine && (words.length <= 5 || full.length <= 20)) return [full];
  let best: { cost: number; lines: string[] } | null = null;
  for (let k = 1; k < words.length; k++) {
    const a = words.slice(0, k).join(' '), b = words.slice(k).join(' ');
    if (a.length > STYLE.maxCharsPerLine || b.length > STYLE.maxCharsPerLine) continue;
    let cost = Math.abs(a.length - b.length);
    if (k === 1 || k === words.length - 1) cost += bare(k === 1 ? words[0] : words[k]).length <= 4 ? 40 : 12; // orphan
    if (/[,;:!?.]$/.test(words[k - 1])) cost -= 10; // break after punctuation
    if (isName(words[k], k) && isName(words[k - 1], k - 1)) cost += 30; // keep multi-word names together
    if (STOP.has(bare(words[k - 1]).toLowerCase())) cost += 6; // do not end line 1 on a function word
    if (!best || cost < best.cost) best = { cost, lines: [a, b] };
  }
  return best?.lines ?? (full.length <= STYLE.maxCharsPerLine ? [full] : null);
}

export function planCaption(text: string, start: number, end: number): CaptionPlan {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const warnings: CaptionPlan['warnings'] = [];
  const lines = splitLines(words) ?? [text.slice(0, STYLE.maxCharsPerLine)];
  // strength rank (ALL-CAPS/numbers > strong > weak), then position; at most two
  const rankOf = (b: string) => /^\p{Lu}{2,}$/u.test(b) || /^\d+$/.test(b) ? 0 : STRONG.has(b.toLowerCase()) ? 1 : WEAK.has(b.toLowerCase()) ? 2 : 9;
  const emph = [...new Set(words.map(bare).filter(Boolean))].map((b, i) => ({ b, i, r: rankOf(b) })).filter((x) => x.r < 9).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.b);
  if (!emph.length) { const c = words.map(bare).filter((b) => b.length >= 6 && !STOP.has(b.toLowerCase())).sort((a, b) => b.length - a.length || (a < b ? -1 : 1)); if (c[0]) emph.push(c[0]); }
  const dur = Math.max(0.001, end - start), wps = Math.round((words.length / dur) * 100) / 100;
  if (wps > STYLE.maxWordsPerSecond) warnings.push({ code: 'READING_SPEED_HIGH', message: `${wps} words/s exceeds ${STYLE.maxWordsPerSecond} words/s; the caption may be hard to read` });
  if (dur < 0.6) warnings.push({ code: 'CAPTION_TOO_SHORT', message: `caption visible for only ${dur.toFixed(2)} s` });
  return { lines, emphasisWords: emph.slice(0, 2), wordsPerSecond: wps, warnings };
}
