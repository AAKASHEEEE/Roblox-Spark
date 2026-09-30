// Talking: mouth-shape flaps for the speaking character, driven by the voice-over envelope or by phrase timing.
// Pure functions of t (random access, deterministic): the envelope follower is a finite peak-hold window evaluated
// directly at t, and the phrase driver lays syllables out from the text alone.
import { clamp } from '../math.ts';

/** placeholder mouth vocabulary (S3's face set replaces the drawing, not these names) */
export const MOUTH_SHAPES = ['closed', 'small', 'open', 'wide', 'round'] as const;
export type MouthShape = (typeof MOUTH_SHAPES)[number];
export interface MouthFrame { shape: MouthShape; /** 0 closed .. 1 fully open */ open: number }
export const CLOSED: MouthFrame = { shape: 'closed', open: 0 };

/** a stretch of speech by one character (a narration phrase, or a line of dialogue) */
export interface SpeechSpan { speaker: string; start: number; end: number; text?: string }

/** open-amount thresholds between shapes */
export const MOUTH_LEVELS = { small: 0.12, open: 0.35, wide: 0.7 } as const;
export function shapeFor(open: number, vowel?: Vowel): MouthShape {
  if (open < MOUTH_LEVELS.small) return 'closed';
  if (vowel === 'round' && open >= MOUTH_LEVELS.small) return 'round';
  if (open < MOUTH_LEVELS.open) return 'small';
  if (open < MOUTH_LEVELS.wide || vowel === 'narrow') return 'open';
  return 'wide';
}

// ---------------------------------------------------------------- syllables from text (phrase-timing driver)

export type Vowel = 'open' | 'round' | 'narrow' | 'closed';
export interface Syllable { start: number; end: number; vowel: Vowel; /** peak opening 0..1 */ peak: number; wordEnd: boolean }

const vowelOf = (g: string): Vowel => (/[ou]/.test(g) ? 'round' : /[ei]/.test(g) && !/a/.test(g) ? 'narrow' : 'open');
/** syllable nuclei of a word: vowel groups (y counts as a vowel when not first), silent final e dropped */
export function wordSyllables(word: string): Vowel[] {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return /\d/.test(word) ? ['open', 'narrow'] : [];
  const groups = w.replace(/^y/, '').match(/[aeiouy]+/g) ?? [];
  if (groups.length > 1 && /[^aeiou]e$/.test(w) && !/le$/.test(w)) groups.pop();
  if (!groups.length) return ['closed'];
  return groups.map((g) => vowelOf(g));
}

/** minimum syllable length (s); faster text is merged so the jaw never buzzes */
export const MIN_SYLLABLE_SEC = 0.085;
/** pause weight of punctuation, in syllable units */
const PAUSE: Record<string, number> = { ',': 1.2, ';': 1.4, ':': 1.2, '.': 1.8, '!': 1.8, '?': 1.8, '-': 0.6 };

/**
 * Lay syllables out across a span: every syllable gets one unit, punctuation adds pause units, each word end adds a
 * short gap. Deterministic (text + timing only). Stressed syllables (the first of each word) open wider.
 */
export function layoutSyllables(span: SpeechSpan): Syllable[] {
  const dur = Math.max(0, span.end - span.start);
  type Word = { syl: Vowel[]; pause: number };
  let words: Word[] = (span.text ?? '').split(/\s+/).filter(Boolean).map((tok) => {
    const p = tok.match(/[,;:.!?-]+$/)?.[0];
    return { syl: wordSyllables(tok), pause: 0.25 + (p ? Math.max(...[...p].map((ch) => PAUSE[ch] ?? 0)) : 0) };
  }).filter((w) => w.syl.length);
  if (!words.length) {
    // no text: flap at a steady conversational rate (~4.5 syllables/s) in two-syllable "words"
    const n = Math.max(1, Math.round((dur * 4.5) / 2));
    words = Array.from({ length: n }, (_, k) => ({ syl: [k % 3 === 1 ? 'round' : 'open', 'open'] as Vowel[], pause: 0.25 }));
  }
  words[words.length - 1].pause = 0; // no trailing gap: the last syllable ends with the span
  const units = words.reduce((s, w) => s + w.syl.length + w.pause, 0);
  const unitSec = dur / Math.max(1e-6, units);
  const out: Syllable[] = [];
  let t = span.start;
  for (const w of words) {
    const wordSec = w.syl.length * unitSec;
    // fast text: fewer, longer flaps per word so the jaw never buzzes (always at least one per word)
    const n = Math.max(1, Math.min(w.syl.length, Math.floor(wordSec / MIN_SYLLABLE_SEC)));
    const len = wordSec / n;
    for (let k = 0; k < n; k++) {
      const v = w.syl[Math.floor((k * w.syl.length) / n)];
      out.push({ start: t + k * len, end: t + (k + 1) * len, vowel: v, peak: k === 0 ? 1 : 0.72, wordEnd: k === n - 1 });
    }
    t += wordSec + w.pause * unitSec;
  }
  return out;
}

/** mouth opening inside one syllable: fast open, slower close (jaw-like), 0 at both ends */
function syllableOpen(x: number): number {
  if (x <= 0 || x >= 1) return 0;
  return x < 0.35 ? Math.sin((Math.PI / 2) * (x / 0.35)) : Math.cos((Math.PI / 2) * ((x - 0.35) / 0.65)) ** 1.4;
}

/** phrase-timing driver: mouth for `speaker` at t from its speech spans (closed outside speech) */
export class PhraseMouth {
  private readonly syl: Syllable[];
  readonly speaker: string;
  constructor(spans: SpeechSpan[], speaker: string) {
    this.speaker = speaker;
    this.syl = spans.filter((s) => s.speaker === speaker).sort((a, b) => a.start - b.start).flatMap((s) => layoutSyllables(s));
  }
  syllables(): readonly Syllable[] { return this.syl; }
  /** syllable active at t (binary search) */
  syllableAt(t: number): Syllable | undefined {
    let lo = 0, hi = this.syl.length - 1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1, s = this.syl[m];
      if (t < s.start) hi = m - 1; else if (t >= s.end) lo = m + 1; else return s;
    }
    return undefined;
  }
  at(t: number): MouthFrame {
    const s = this.syllableAt(t);
    if (!s) return CLOSED;
    const vowelScale = s.vowel === 'closed' ? 0.25 : s.vowel === 'narrow' ? 0.8 : s.vowel === 'round' ? 0.85 : 1;
    const open = clamp(syllableOpen((t - s.start) / (s.end - s.start)) * s.peak * vowelScale, 0, 1);
    return { shape: shapeFor(open, s.vowel), open };
  }
}

// ---------------------------------------------------------------- envelope driver

/** amplitude envelope of the voice-over: RMS frames at `rate` Hz starting at `offset` s */
export interface VoiceEnvelope { rate: number; frames: ArrayLike<number>; offset?: number }

/** RMS envelope of mono PCM (e.g. DecodedAudio.pcm at analysisRate), hop = 1 / hz */
export function envelopeFromPcm(pcm: ArrayLike<number>, sampleRate: number, hz = 100): VoiceEnvelope {
  const hop = Math.max(1, Math.round(sampleRate / hz)), n = Math.floor(pcm.length / hop);
  const frames = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = i * hop; k < (i + 1) * hop; k++) s += pcm[k] * pcm[k];
    frames[i] = Math.sqrt(s / hop);
  }
  return { rate: sampleRate / hop, frames, offset: 0 };
}

export interface EnvelopeMouthOpts {
  /** peak-hold release (s): how slowly the mouth closes after a loud frame */
  releaseSec?: number;
  /** attack smoothing (s): frames this far ahead are looked at so the jaw opens on the onset, not after it */
  leadSec?: number;
  /** fraction of the speaker's loud level treated as silence */
  floor?: number;
}

/**
 * Envelope driver: open(t) = normalized peak-hold of the envelope over a finite window around t (a pure function of
 * t). Only frames inside the speaker's spans count, so a second voice on the same track never moves this mouth.
 * The vowel shape comes from the phrase text when available.
 */
export class EnvelopeMouth {
  private readonly ref: number;
  private readonly phrases: PhraseMouth;
  private readonly spans: SpeechSpan[];
  private readonly o: Required<EnvelopeMouthOpts>;
  readonly env: VoiceEnvelope;
  readonly speaker: string;
  constructor(env: VoiceEnvelope, spans: SpeechSpan[], speaker: string, opts: EnvelopeMouthOpts = {}) {
    this.env = env; this.speaker = speaker;
    this.o = { releaseSec: opts.releaseSec ?? 0.09, leadSec: opts.leadSec ?? 0.03, floor: opts.floor ?? 0.12 };
    this.spans = spans.filter((s) => s.speaker === speaker);
    this.phrases = new PhraseMouth(spans, speaker);
    // reference level: 95th percentile of in-speech frames (robust to clicks), fixed at construction
    const vals: number[] = [];
    for (let i = 0; i < env.frames.length; i++) if (this.speaking(this.frameTime(i))) vals.push(env.frames[i]);
    vals.sort((a, b) => a - b);
    this.ref = vals.length ? Math.max(1e-6, vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.95))]) : 1;
  }
  private frameTime(i: number): number { return (this.env.offset ?? 0) + i / this.env.rate; }
  speaking(t: number): boolean { return this.spans.some((s) => t >= s.start && t < s.end); }
  /** normalized loudness at t (peak-hold with exponential release, finite window) */
  level(t: number): number {
    if (!this.speaking(t)) return 0;
    const r = this.env.rate, off = this.env.offset ?? 0;
    const i1 = Math.floor((t - off + this.o.leadSec) * r), i0 = Math.floor((t - off - 4 * this.o.releaseSec) * r);
    let best = 0;
    for (let i = Math.max(0, i0); i <= Math.min(this.env.frames.length - 1, i1); i++) {
      const ft = this.frameTime(i);
      if (!this.speaking(ft)) continue;
      const age = Math.max(0, t - ft);
      best = Math.max(best, this.env.frames[i] * Math.exp(-age / this.o.releaseSec));
    }
    return clamp((best / this.ref - this.o.floor) / (1 - this.o.floor), 0, 1);
  }
  at(t: number): MouthFrame {
    const open = this.level(t);
    const vowel = this.phrases.syllableAt(t)?.vowel;
    return { shape: shapeFor(open, vowel), open };
  }
}

/** the mouth driver a character uses: the envelope when one is supplied, phrase timing otherwise */
export function mouthDriver(spans: SpeechSpan[], speaker: string, env?: VoiceEnvelope, opts?: EnvelopeMouthOpts): { at(t: number): MouthFrame } {
  return env ? new EnvelopeMouth(env, spans, speaker, opts) : new PhraseMouth(spans, speaker);
}
