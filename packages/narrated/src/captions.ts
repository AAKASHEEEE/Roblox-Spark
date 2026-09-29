// Phrase-level caption planner. One phrase (one beat) may show several consecutive caption CHUNKS: each chunk has at
// most 2 lines of at most 32 characters, breaks prefer punctuation, avoid orphans and keep names together, and the
// chunks' words concatenate to exactly the phrase's words (nothing dropped, duplicated or reordered). Chunk timing is
// deterministic: the phrase duration is shared by spoken word count; chunks are contiguous from phrase.start to
// phrase.end. Captions are data only (burn-in is Phase 2).
import { CAPTION_STYLE } from './schema.ts';

export interface CaptionChunk { id: string; start: number; end: number; lines: string[]; emphasisWords: string[]; wordsPerSecond: number }
export interface CaptionPlan { chunks: CaptionChunk[]; wordsPerSecond: number; warnings: Array<{ code: string; message: string }> }
const STYLE = CAPTION_STYLE.shorts_default;
const STRONG = new Set(['never', 'always', 'perfect', 'worst', 'best', 'forever', 'nothing', 'nobody', 'suddenly', 'huge', 'giant', 'tiny', 'impossible', 'instantly', 'wrong', 'secret', 'biggest', 'smallest']);
const WEAK = new Set(['everything', 'everyone', 'finally', 'only', 'real', 'actually', 'right', 'first', 'last', 'free', 'every', 'no']);
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'you', 'your', 'would', 'could', 'should', 'that', 'this', 'they', 'their', 'there', 'then', 'what', 'when', 'which', 'about', 'from', 'into', 'were', 'have', 'will', 'just', 'like']);
const bare = (w: string) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
const isName = (w: string, i: number) => i > 0 && /^\p{Lu}\p{Ll}+/u.test(bare(w));
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** a line can only fail to fit when a single word is longer than the caption line */
export const fitsCaption = (text: string): boolean => text.trim().split(/\s+/).every((w) => w.length <= STYLE.maxCharsPerLine);

/** best 1-2 line layout of `words` (null = does not fit one chunk) and its cost */
function layout(words: string[]): { lines: string[]; cost: number } | null {
  const full = words.join(' ');
  if (full.length <= STYLE.maxCharsPerLine && (words.length <= 5 || full.length <= 20)) return { lines: [full], cost: 0 };
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
  return best ?? (full.length <= STYLE.maxCharsPerLine ? { lines: [full], cost: 0 } : null);
}

/** fewest chunks first, then natural boundaries (punctuation, no orphan chunk, names kept together); deterministic */
function chunkWords(words: string[]): string[][] {
  const n = words.length, best = new Float64Array(n + 1).fill(Infinity), from = new Int32Array(n + 1).fill(-1);
  best[0] = 0;
  for (let i = 1; i <= n; i++) for (let j = Math.max(0, i - 16); j < i; j++) {
    if (best[j] === Infinity) continue;
    const lay = layout(words.slice(j, i));
    if (!lay) continue;
    let c = best[j] + lay.cost + 25;
    if (i < n) {
      if (/[,;:.!?]$/.test(words[i - 1])) c -= 12;
      if (STOP.has(bare(words[i - 1]).toLowerCase())) c += 8;
      if (isName(words[i], i) && isName(words[i - 1], i - 1)) c += 30;
    }
    if (i - j === 1 && n > 1) c += 40; // one-word chunk
    if (i < n) c += Math.max(0, 26 - words.slice(j, i).join(' ').length); // avoid a stub chunk before a long one
    if (c < best[i]) { best[i] = c; from[i] = j; }
  }
  const out: string[][] = [];
  for (let i = n; i > 0; i = from[i]) out.unshift(words.slice(from[i], i));
  return out;
}

function emphasis(words: string[]): string[] {
  const rankOf = (b: string) => /^\p{Lu}{2,}$/u.test(b) || /^\d+$/.test(b) ? 0 : STRONG.has(b.toLowerCase()) ? 1 : WEAK.has(b.toLowerCase()) ? 2 : 9;
  const emph = [...new Set(words.map(bare).filter(Boolean))].map((b, i) => ({ b, i, r: rankOf(b) })).filter((x) => x.r < 9).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.b);
  if (!emph.length) { const c = words.map(bare).filter((b) => b.length >= 6 && !STOP.has(b.toLowerCase())).sort((a, b) => b.length - a.length || (a < b ? -1 : 1)); if (c[0]) emph.push(c[0]); }
  return emph.slice(0, 2);
}

export function planCaptionChunks(phraseId: string, text: string, start: number, end: number): CaptionPlan {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const warnings: CaptionPlan['warnings'] = [];
  const groups = chunkWords(words);
  const dur = Math.max(0.001, end - start), W = words.length;
  let acc = 0, prev = start;
  const chunks = groups.map((g, k): CaptionChunk => {
    acc += g.length;
    const last = k === groups.length - 1;
    // share the phrase by spoken word count; at least 1 ms per chunk; the last chunk ends exactly at phrase.end
    const e = last ? end : Math.min(end - 0.001 * (groups.length - 1 - k), Math.max(prev + 0.001, r3(start + (dur * acc) / W)));
    const c: CaptionChunk = { id: `${phraseId}-c${String(k + 1).padStart(2, '0')}`, start: prev, end: e, lines: layout(g)!.lines, emphasisWords: emphasis(g), wordsPerSecond: Math.round((g.length / Math.max(0.001, e - prev)) * 100) / 100 };
    prev = e;
    return c;
  });
  const wps = Math.round((W / dur) * 100) / 100;
  if (wps > STYLE.maxWordsPerSecond) warnings.push({ code: 'READING_SPEED_HIGH', message: `${wps} words/s exceeds ${STYLE.maxWordsPerSecond} words/s; the caption may be hard to read` });
  const short = chunks.filter((c) => c.end - c.start < 0.6);
  if (short.length) warnings.push({ code: 'CAPTION_TOO_SHORT', message: `caption chunk(s) ${short.map((c) => c.id).join(', ')} visible for less than 0.6 s` });
  return { chunks, wordsPerSecond: wps, warnings };
}
