// Face track: expression per beat, deterministic blinking, and the talking mouth, combined into one FaceFrame.
// Until S3's face set lands, the mouth is shown with PLACEHOLDER mouth states: existing manifest face states whose
// mouth drawing reads as open/round. S3 replaces that with setFaceRenderer(), which receives the full FaceFrame.
import type { Rig } from '../build.ts';
import { rng } from '../math.ts';
import { CLOSED, MOUTH_LEVELS, type MouthFrame, type MouthShape } from './talking.ts';

export interface FaceFrame {
  expression: string;
  /** 0 open .. 1 closed */
  blink: number;
  mouth: MouthFrame;
}
/** per-frame face request from an action (eat chews, scream opens wide, sleep closes the eyes) */
export interface FaceCue { expression?: string; mouth?: MouthFrame; /** 0..1 eyelid override (sleep) */ eyesClosed?: number }

export interface ExpressionBeat { start: number; end: number; expressionId: string }
type FaceStates = Record<string, { eyes: string; mouth: string }>;

/**
 * Library expression -> engine face states to try, in order, when a character lacks the exact state.
 * (S3 owns expressions; this only keeps beats renderable with the face states that exist today.)
 */
export const EXPRESSION_FALLBACKS: Record<string, string[]> = {
  neutral: ['calm', 'smug', 'skeptical'], calm: ['neutral', 'smug'], curious: ['skeptical', 'neutral'],
  shock: ['shocked', 'surprised'], shocked: ['shock', 'surprised'], surprised: ['shock', 'shocked'], scared: ['shock', 'surprised', 'regret'],
  scream: ['shock', 'surprised'], determined: ['strict', 'skeptical', 'angry'], angry: ['furious', 'determined', 'strict', 'skeptical'],
  furious: ['angry', 'determined', 'skeptical'], strict: ['determined', 'skeptical'], regret: ['sad', 'skeptical'], sad: ['regret', 'crying'],
  crying: ['sad', 'regret'], smug: ['evil_grin', 'neutral', 'laughing'], evil_grin: ['smug', 'determined'], skeptical: ['suspicious', 'determined', 'smug'],
  suspicious: ['skeptical', 'determined'], confused: ['curious', 'skeptical', 'surprised'], sleepy: ['regret', 'smug'],
  happy: ['big_grin', 'laughing', 'neutral', 'smug'], big_grin: ['happy', 'laughing', 'smug'], laugh: ['laughing', 'big_grin', 'happy'],
  laughing: ['laugh', 'big_grin', 'happy'], love_eyes: ['happy', 'laughing', 'smug'],
};

/** the face state a character shows for a library expression id (exact, then fallbacks, then its default) */
export function resolveExpression(id: string, allowed: readonly string[], fallbackDefault = allowed[0]): string {
  if (allowed.includes(id)) return id;
  for (const f of EXPRESSION_FALLBACKS[id] ?? []) if (allowed.includes(f)) return f;
  return fallbackDefault;
}

/** engine mouth drawings that read as each placeholder shape */
export const PLACEHOLDER_MOUTHS: Record<MouthShape, readonly string[]> = {
  closed: [], small: [], open: ['open_grin', 'o'], wide: ['open_grin', 'o'], round: ['o', 'open_grin'],
};
/**
 * Placeholder mouth states: closed/small keep the expression; open/wide/round switch to a face state of the same
 * character whose mouth drawing is open (same eyes preferred, so the flap reads as the mouth only when possible).
 */
export function placeholderFaceState(states: FaceStates, allowed: readonly string[], expression: string, mouth: MouthFrame): string {
  const want = PLACEHOLDER_MOUTHS[mouth.shape];
  const cur = states[expression];
  // only a clearly open mouth swaps the state (a barely-open flap keeps the expression readable)
  if (mouth.open < MOUTH_LEVELS.open || !want.length || !cur || want.includes(cur.mouth)) return expression;
  let best: string | undefined, bestScore = -1;
  for (const id of allowed) {
    const s = states[id];
    if (!s) continue;
    const mi = want.indexOf(s.mouth);
    if (mi < 0) continue;
    const score = (s.eyes === cur.eyes ? 10 : 0) + (want.length - mi);
    if (score > bestScore) { best = id; bestScore = score; }
  }
  return best ?? expression;
}

export type FaceRenderer = (rig: Rig, f: FaceFrame) => void;
let faceRenderer: FaceRenderer | null = null;
/** S3 hook: draw the full FaceFrame (expression + blink + mouth). null restores the placeholder mouth states. */
export function setFaceRenderer(fn: FaceRenderer | null): void { faceRenderer = fn; }
/** put a FaceFrame on a rig: S3's renderer when registered, the placeholder mouth states otherwise */
export function applyFace(rig: Rig, f: FaceFrame): string {
  if (faceRenderer) { faceRenderer(rig, f); return f.expression; }
  const st = placeholderFaceState(rig.manifest.face.states as FaceStates, rig.manifest.allowedExpressions, f.expression, f.mouth);
  rig.setFace(st, f.blink);
  return st;
}

/** blink shape (0..1..0) over BLINK_SEC */
export const BLINK_SEC = 0.14;
/** scheduled blinks within this distance of a forced (beat-change) blink are dropped */
const BLINK_CLEAR_SEC = 0.35;

export interface FaceTrackOpts {
  /** actor seed (ActorTrack.seed) */
  seed: number;
  /** character's available face states (manifest.allowedExpressions) */
  allowed: readonly string[];
  /** expression per beat (library expression ids; resolved against `allowed`) */
  beats: ExpressionBeat[];
  /** mouth driver (talking.ts); closed when absent */
  mouth?: { at(t: number): MouthFrame };
  /** timeline length (blink schedule extent) */
  duration: number;
  /** blink on every expression change so the texture swap happens with the eyes shut (default true) */
  blinkOnChange?: boolean;
}

/** Deterministic face track for one character: pure function of t. */
export class FaceTrack {
  readonly changes: Array<{ at: number; expression: string }> = [];
  private readonly blinks: number[] = [];
  private readonly o: FaceTrackOpts;
  constructor(o: FaceTrackOpts) {
    this.o = o;
    const beats = [...o.beats].sort((a, b) => a.start - b.start);
    let prev: string | undefined;
    for (const b of beats) {
      const e = resolveExpression(b.expressionId, o.allowed);
      if (e !== prev) this.changes.push({ at: b.start, expression: e });
      prev = e;
    }
    const forced = o.blinkOnChange === false ? [] : this.changes.slice(1).map((c) => c.at - BLINK_SEC / 2);
    // same generator and spacing as ActorTrack's blink schedule
    const r = rng(o.seed);
    for (let t = 0.6 + r() * 1.5; t < o.duration + 2; t += 2.2 + r() * 2.4) if (forced.every((f) => Math.abs(f - t) > BLINK_CLEAR_SEC)) this.blinks.push(t);
    this.blinks.push(...forced);
    this.blinks.sort((a, b) => a - b);
  }
  blinkTimes(): readonly number[] { return this.blinks; }
  expressionAt(t: number): string {
    let e = this.changes[0]?.expression ?? this.o.allowed[0];
    for (const c of this.changes) if (c.at <= t) e = c.expression;
    return e;
  }
  blinkAt(t: number): number {
    for (const b of this.blinks) { const x = (t - b) / BLINK_SEC; if (x >= 0 && x <= 1) return Math.sin(Math.PI * x); }
    return 0;
  }
  at(t: number, cue?: FaceCue): FaceFrame {
    const expression = cue?.expression ? resolveExpression(cue.expression, this.o.allowed, this.expressionAt(t)) : this.expressionAt(t);
    const blink = Math.max(this.blinkAt(t), cue?.eyesClosed ?? 0);
    const mouth = cue?.mouth ?? this.o.mouth?.at(t) ?? CLOSED;
    return { expression, blink, mouth };
  }
}
