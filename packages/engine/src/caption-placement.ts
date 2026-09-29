// Deterministic per-caption-chunk placement. Pure geometry: no rendering, no DOM, no story modules.
//
// The integration layer supplies projected screen-space bounds (faces, hero prop, interaction point, bodies) for
// every sampled frame inside a caption chunk. Occupancy is unioned per entity across ALL sampled frames, three fixed
// candidate bands (upper / middle / lower) are scored once, and ONE rectangle is returned for the whole chunk: the
// caption never moves mid-chunk and never changes band frame-by-frame. Text, line breaks, emphasis and timing are
// never read for anything but size estimation and are never returned or modified.
import { CAPTION_DEFAULT_STYLE, CAPTION_LINE_HEIGHT, CAPTION_MAX_WIDTH, CAPTION_OUTLINE, captionFontPx, captionText, type CaptionChunkPlacement } from './capture.ts';

export interface Rect { x: number; y: number; w: number; h: number }
export type OccupiedType = 'primary_face' | 'supporting_face' | 'hero_prop' | 'interaction' | 'body';
export interface OccupiedRegion {
  entityId: string;
  type: OccupiedType;
  /** projected screen-space bounds, pixels */
  rect: Rect;
  /** 0..1; for `body`, >= ACTIVE_BODY_IMPORTANCE marks the active (speaking/acting) body */
  importance: number;
}
export interface CaptionPlacementFrame { time: number; occupied: OccupiedRegion[] }
/** insets as fractions of the frame (left/right of width, top/bottom of height) */
export interface SafeArea { left: number; right: number; top: number; bottom: number }
export interface CaptionPlacementRequest {
  frameWidth: number;
  frameHeight: number;
  lines: string[];
  chunkStart: number;
  chunkEnd: number;
  frames: CaptionPlacementFrame[];
  safeArea?: Partial<SafeArea> | null;
  options?: Partial<CaptionPlacementOptions> | null;
}
export type CaptionBand = 'upper' | 'middle' | 'lower';
export type CaptionViolation = 'PRIMARY_FACE' | 'INTERACTION' | 'HERO_PROP' | 'BOTH_FACES';
export interface CaptionCandidate { band: CaptionBand; rect: Rect; centerY: number; score: number; violations: CaptionViolation[] }
export interface CaptionPlacementResult {
  band: CaptionBand;
  rect: Rect;
  /** block centre as a fraction of frame height: feed to capture.ts as `placement.centerY` */
  centerY: number;
  /** total penalty of the chosen candidate: LOWER IS BETTER (0 = clear lower band) */
  score: number;
  overlapMetrics: Record<string, number>;
  warnings: string[];
  /** one rectangle for the whole [chunkStart, chunkEnd): always true by construction */
  stableForWholeChunk: boolean;
  chunkStart: number;
  chunkEnd: number;
  violations: CaptionViolation[];
  /** every candidate in fixed band order (upper, middle, lower) for quality gates / debugging */
  candidates: CaptionCandidate[];
}
export interface CaptionPlacementOptions {
  /** max fraction of any primary face area the caption may cover */
  maxPrimaryFaceFraction: number;
  /** a face counts as "covered" for the two-face rule above this fraction */
  faceTouchFraction: number;
  /** max fraction of the hero prop the caption may cover ("most of" = above this) */
  maxHeroPropFraction: number;
  /** clearance around the interaction point, fraction of frame height */
  interactionClearance: number;
  /** estimated advance width per character, in em (DejaVu Sans 800 caps-heavy text, conservative) */
  charWidthEm: number;
  /** padding around the text block, in em (outline half-width is added on top) */
  paddingEm: number;
  /** nominal block centres (fraction of frame height), clamped into the safe area */
  bandCenters: Record<CaptionBand, number>;
}

export const CAPTION_BOTTOM_EXCLUSION = 0.16;
export const CAPTION_MAX_LINES = 2;
export const CAPTION_MAX_CHARS = 32;
export const ACTIVE_BODY_IMPORTANCE = 0.5;
export const DEFAULT_SAFE_AREA: Readonly<SafeArea> = Object.freeze({ left: (1 - CAPTION_MAX_WIDTH) / 2, right: (1 - CAPTION_MAX_WIDTH) / 2, top: 0.08, bottom: CAPTION_BOTTOM_EXCLUSION });
export const DEFAULT_PLACEMENT_OPTIONS: Readonly<CaptionPlacementOptions> = Object.freeze({
  maxPrimaryFaceFraction: 0.08, faceTouchFraction: 0.08, maxHeroPropFraction: 0.5, interactionClearance: 0.02,
  charWidthEm: 0.66, paddingEm: 0.3,
  bandCenters: Object.freeze({ upper: 0.22, middle: 0.5, lower: CAPTION_DEFAULT_STYLE.centerY }) as Record<CaptionBand, number>,
});
/** Overlap priority (highest first). Weight ranges never cross: base * [0.8, 1.2] importance multiplier. */
export const OVERLAP_WEIGHTS = Object.freeze({ primary_face: 1000, interaction: 400, hero_prop: 150, supporting_face: 60, body_active: 20, body_background: 6 });
export const HARD_VIOLATION_PENALTY = 10000;
/** deterministic tie-break / preference: lower when clear, upper next, middle only when both are worse */
export const BAND_BIAS: Readonly<Record<CaptionBand, number>> = Object.freeze({ lower: 0, upper: 2, middle: 6 });
export const BAND_ORDER: readonly CaptionBand[] = Object.freeze(['upper', 'middle', 'lower']);
const PREFERENCE: readonly CaptionBand[] = ['lower', 'upper', 'middle'];

const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
const r2 = (v: number) => Math.round(v * 100) / 100;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const area = (r: Rect) => Math.max(0, r.w) * Math.max(0, r.h);
function intersect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  return { x, y, w: Math.max(0, Math.min(a.x + a.w, b.x + b.w) - x), h: Math.max(0, Math.min(a.y + a.h, b.y + b.h) - y) };
}
function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}
const inflate = (r: Rect, d: number): Rect => ({ x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d });
/** fraction of `target` covered by `cap`; degenerate (point/line) targets count as 1 when touched */
function coverage(cap: Rect, target: Rect): number {
  const a = area(target), i = intersect(cap, target);
  if (a > 0) return area(i) / a;
  const inside = target.x >= cap.x && target.x <= cap.x + cap.w && target.y >= cap.y && target.y <= cap.y + cap.h;
  return inside ? 1 : 0;
}
const validRect = (r: Rect | undefined | null): r is Rect => !!r && [r.x, r.y, r.w, r.h].every(Number.isFinite) && r.w >= 0 && r.h >= 0;
const impMul = (imp: number) => 0.8 + 0.4 * clamp(Number.isFinite(imp) ? imp : 0.5, 0, 1);
type WeightKey = keyof typeof OVERLAP_WEIGHTS;
const weightKey = (o: { type: OccupiedType; importance: number }): WeightKey =>
  o.type === 'body' ? (o.importance >= ACTIVE_BODY_IMPORTANCE ? 'body_active' : 'body_background') : o.type;

interface UnionEntity { key: string; entityId: string; type: OccupiedType; wk: WeightKey; importance: number; rect: Rect }

/** Per-entity union of projected bounds over every sampled frame, clipped to the frame. Sorted for determinism. */
function unionOccupancy(frames: CaptionPlacementFrame[], W: number, H: number, warnings: Set<string>): UnionEntity[] {
  const frame: Rect = { x: 0, y: 0, w: W, h: H };
  const m = new Map<string, UnionEntity>();
  for (const f of frames) for (const o of f.occupied ?? []) {
    if (!validRect(o?.rect)) { warnings.add('CAPTION_INVALID_OCCUPIED_RECT'); continue; }
    const key = `${o.type}:${o.entityId}`, prev = m.get(key);
    if (prev) { prev.rect = union(prev.rect, o.rect); prev.importance = Math.max(prev.importance, o.importance); prev.wk = weightKey(prev); }
    else { const e = { key, entityId: o.entityId, type: o.type, importance: o.importance, rect: { ...o.rect }, wk: 'body_background' as WeightKey }; e.wk = weightKey(e); m.set(key, e); }
  }
  return [...m.values()]
    .map((e) => (area(e.rect) > 0 ? { ...e, rect: intersect(e.rect, frame), offFrame: area(intersect(e.rect, frame)) === 0 } : { ...e, offFrame: false })) // off-frame parts cannot be covered
    .filter((e) => !e.offFrame).map(({ offFrame: _o, ...e }) => e)
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** conservative caption rectangle size (px) for the planned lines at the existing font sizing/outline */
export function captionBoxSize(W: number, H: number, lines: string[], safe: SafeArea, opt: CaptionPlacementOptions = DEFAULT_PLACEMENT_OPTIONS): { w: number; h: number; px: number; lines: number } {
  const clean = lines.map(captionText).filter(Boolean).slice(0, CAPTION_MAX_LINES);
  const n = Math.max(1, clean.length), px = captionFontPx(H);
  const chars = Math.max(1, ...clean.map((l) => [...l].length));
  const pad = px * (opt.paddingEm + CAPTION_OUTLINE / 2);
  const text = Math.min(chars * opt.charWidthEm * px, W * CAPTION_MAX_WIDTH); // capture.ts shrinks the font to fit 90% width
  const maxW = W * (1 - safe.left - safe.right);
  return { w: Math.min(text + 2 * pad, maxW), h: px * CAPTION_LINE_HEIGHT * n + 2 * pad, px, lines: n };
}

export function resolveSafeArea(s?: Partial<SafeArea> | null): SafeArea {
  const f = (v: number | undefined, d: number) => (Number.isFinite(v) ? clamp(v as number, 0, 0.45) : d);
  return {
    left: Math.max(f(s?.left, DEFAULT_SAFE_AREA.left), 0), right: Math.max(f(s?.right, DEFAULT_SAFE_AREA.right), 0),
    top: f(s?.top, DEFAULT_SAFE_AREA.top),
    bottom: Math.max(f(s?.bottom, DEFAULT_SAFE_AREA.bottom), CAPTION_BOTTOM_EXCLUSION), // platform UI region is never used
  };
}

/** fixed candidate rectangle for a band: horizontally centred within the margins, vertically inside the safe area */
export function bandRect(band: CaptionBand, W: number, H: number, box: { w: number; h: number }, safe: SafeArea, opt: CaptionPlacementOptions = DEFAULT_PLACEMENT_OPTIONS): Rect {
  const minY = H * safe.top, maxY = H * (1 - safe.bottom);
  const h = Math.min(box.h, maxY - minY);
  const y = clamp(H * opt.bandCenters[band] - h / 2, minY, maxY - h);
  const left = W * safe.left, right = W * (1 - safe.right);
  const w = Math.min(box.w, right - left);
  const x = clamp((W - w) / 2, left, right - w);
  return { x: r2(x), y: r2(y), w: r2(w), h: r2(h) };
}

function scoreCandidate(band: CaptionBand, rect: Rect, ents: UnionEntity[], H: number, opt: CaptionPlacementOptions) {
  const per: Record<string, number> = {};
  const max: Record<string, number> = { primary_face: 0, supporting_face: 0, hero_prop: 0, interaction: 0, body_active: 0, body_background: 0 };
  let penalty = 0, facesTouched = 0, faceCount = 0, interactionHit = 0;
  const violations = new Set<CaptionViolation>();
  for (const e of ents) {
    const cov = coverage(rect, e.rect);
    per[e.key] = r4(cov);
    max[e.wk] = Math.max(max[e.wk], cov);
    penalty += OVERLAP_WEIGHTS[e.wk] * impMul(e.importance) * cov;
    if (e.type === 'primary_face' || e.type === 'supporting_face') { faceCount++; if (cov > opt.faceTouchFraction) facesTouched++; }
    if (e.type === 'primary_face' && cov > opt.maxPrimaryFaceFraction) violations.add('PRIMARY_FACE');
    if (e.type === 'hero_prop' && cov > opt.maxHeroPropFraction) violations.add('HERO_PROP');
    if (e.type === 'interaction' && area(intersect(rect, inflate(e.rect, H * opt.interactionClearance))) > 0) { violations.add('INTERACTION'); interactionHit = 1; }
  }
  if (faceCount >= 2 && facesTouched >= 2) violations.add('BOTH_FACES');
  const v = [...violations].sort();
  const score = Math.round((penalty + v.length * HARD_VIOLATION_PENALTY + BAND_BIAS[band]) * 1e6) / 1e6;
  return { score, violations: v, per, max, facesTouched, faceCount, interactionHit };
}

/** Choose ONE stable caption rectangle for a caption chunk. Deterministic: same input => byte-identical JSON. */
export function placeCaption(req: CaptionPlacementRequest): CaptionPlacementResult {
  const W = req.frameWidth, H = req.frameHeight;
  if (!(W > 0 && H > 0 && Number.isFinite(W) && Number.isFinite(H))) throw new Error(`caption placement: invalid frame ${W}x${H}`);
  const opt: CaptionPlacementOptions = { ...DEFAULT_PLACEMENT_OPTIONS, ...(req.options ?? {}), bandCenters: { ...DEFAULT_PLACEMENT_OPTIONS.bandCenters, ...(req.options?.bandCenters ?? {}) } };
  const safe = resolveSafeArea(req.safeArea);
  const warnings = new Set<string>();
  if (!(req.chunkEnd > req.chunkStart)) warnings.add('CAPTION_INVALID_CHUNK');
  if (req.lines.length > CAPTION_MAX_LINES) warnings.add('CAPTION_TOO_MANY_LINES');
  if (req.lines.some((l) => [...captionText(l)].length > CAPTION_MAX_CHARS)) warnings.add('CAPTION_LINE_TOO_LONG');
  // sampled frames in [chunkStart, chunkEnd) (same window rule as capture.ts); every one contributes to the union
  const all = req.frames ?? [];
  let frames = all.filter((f) => f.time >= req.chunkStart - 1e-9 && f.time < req.chunkEnd - 1e-9);
  if (!frames.length && all.length) { warnings.add('CAPTION_FRAMES_OUTSIDE_CHUNK'); frames = all; }
  if (!all.length) warnings.add('CAPTION_NO_GEOMETRY');
  const ents = unionOccupancy(frames, W, H, warnings);
  const box = captionBoxSize(W, H, req.lines, safe, opt);
  const cands = BAND_ORDER.map((band) => { const rect = bandRect(band, W, H, box, safe, opt); return { band, rect, ...scoreCandidate(band, rect, ents, H, opt) }; });
  const best = [...cands].sort((a, b) => a.score - b.score || PREFERENCE.indexOf(a.band) - PREFERENCE.indexOf(b.band))[0];
  if (best.violations.length) warnings.add('CAPTION_PLACEMENT_CONFLICT');
  const bottomLimit = H * (1 - CAPTION_BOTTOM_EXCLUSION);
  const overlapMetrics: Record<string, number> = {};
  const metrics: Record<string, number> = {
    primary_face_max: r4(best.max.primary_face), interaction_max: r4(best.max.interaction), hero_prop_max: r4(best.max.hero_prop),
    supporting_face_max: r4(best.max.supporting_face), body_active_max: r4(best.max.body_active), body_background_max: r4(best.max.body_background),
    interaction_clearance_hit: best.interactionHit, faces_touched: best.facesTouched, faces_present: best.faceCount,
    bottom_ui_overlap_px: r2(Math.max(0, best.rect.y + best.rect.h - bottomLimit)),
    edge_overflow_px: r2(Math.max(0, W * safe.left - best.rect.x, best.rect.x + best.rect.w - W * (1 - safe.right), H * safe.top - best.rect.y)),
    frames_sampled: frames.length, entities: ents.length, hard_violations: best.violations.length, penalty: best.score,
  };
  for (const k of Object.keys(metrics).sort()) overlapMetrics[k] = metrics[k];
  for (const k of Object.keys(best.per).sort()) overlapMetrics[`entity:${k}`] = best.per[k];
  const centerY = r4((best.rect.y + best.rect.h / 2) / H);
  return {
    band: best.band, rect: best.rect, centerY, score: best.score, overlapMetrics, warnings: [...warnings].sort(),
    stableForWholeChunk: true, chunkStart: req.chunkStart, chunkEnd: req.chunkEnd, violations: best.violations,
    candidates: cands.map((c) => ({ band: c.band, rect: c.rect, centerY: r4((c.rect.y + c.rect.h / 2) / H), score: c.score, violations: c.violations })),
  };
}

/** Integration hook: attach a placement to a planned caption chunk. Text, line breaks, emphasis and timing are copied verbatim. */
export function withCaptionPlacement<C extends { start: number; end: number; lines: string[]; emphasisWords: string[] }>(caption: C, result: CaptionPlacementResult): C & { placement: CaptionChunkPlacement } {
  if (Math.abs(result.chunkStart - caption.start) > 1e-9 || Math.abs(result.chunkEnd - caption.end) > 1e-9) throw new Error('caption placement: chunk timing mismatch');
  return { ...caption, placement: { centerY: result.centerY } };
}
