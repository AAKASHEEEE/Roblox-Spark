// caption_bold placement (S7): one stable, horizontally centred position per caption, kept clear of faces.
//
// The caller passes the screen rectangles occupied during the caption (faces, hero props, other on-screen graphics,
// bodies), unioned over the frames the caption is visible (the engine's projected bounds, as for the narrated captions
// in packages/engine/src/caption-placement.ts). Candidate centres start at the frame centre (0.50 H) and step outwards
// alternately down/up; each candidate is scored once and the cheapest wins, so the caption never moves while visible.
// Faces are hard constraints (with a margin); props and graphics are strong soft costs; bodies are weak soft costs.
// Pure, deterministic geometry: no DOM.
import { TEXT_STYLE_DEFS } from './styles.ts';

export interface Rect { x: number; y: number; w: number; h: number }
export type OccupiedKind = 'face' | 'prop' | 'graphic' | 'body';
export interface OccupiedRect { id: string; kind: OccupiedKind; rect: Rect }
export interface SafeInsets { left: number; right: number; top: number; bottom: number }
/** platform UI (title, buttons, description) covers the bottom ~16% and the right edge of Shorts / Reels / TikTok */
export const BOLD_SAFE: Readonly<SafeInsets> = Object.freeze({ left: 0.06, right: 0.06, top: 0.1, bottom: 0.18 });
export const FACE_MARGIN = 0.02; // of H, around every face rectangle
export const MAX_WIDTH_FRACTION = 0.86;
export const LINE_HEIGHT = 1.08;

/** text measurer: width in px of `text` at `px` font size */
export type Measure = (text: string, px: number) => number;
/** conservative Node-side estimate for a heavy uppercase sans (Noto Sans Black / DejaVu Sans Bold) */
export const estimateWidth: Measure = (text, px) => {
  let em = 0;
  for (const ch of text) em += ch === ' ' ? 0.28 : /[IJ1!.,:;'|]/.test(ch) ? 0.34 : /[MW]/.test(ch) ? 0.98 : /[-]/.test(ch) ? 0.4 : 0.74;
  return em * px;
};

export interface BoldLayout { lines: string[][]; px: number; w: number; h: number; lineWidths: number[] }
/**
 * Break display words into 1 or 2 lines at the caption_bold size (0.06 H), shrinking only when two balanced lines
 * still exceed 86% of the width. Width includes the outline.
 */
export function layoutBold(display: readonly string[], W: number, H: number, measure: Measure = estimateWidth): BoldLayout {
  const st = TEXT_STYLE_DEFS.caption_bold;
  let px = Math.round(H * st.sizeH);
  const maxW = W * MAX_WIDTH_FRACTION;
  const width = (ws: readonly string[], p: number) => measure(ws.join(' '), p) + p * st.strokeEm;
  let lines: string[][] = [display.slice()];
  if (width(display, px) > maxW && display.length > 1) {
    let best: string[][] = lines, bestW = Infinity;
    for (let k = 1; k < display.length; k++) {
      const a = display.slice(0, k), b = display.slice(k), m = Math.max(width(a, px), width(b, px));
      if (m < bestW) { bestW = m; best = [a, b]; }
    }
    lines = best;
  }
  const widest = Math.max(...lines.map((l) => width(l, px)));
  if (widest > maxW) px = Math.floor((px * maxW) / widest);
  const lineWidths = lines.map((l) => width(l, px));
  return { lines, px, w: Math.max(...lineWidths), h: px * LINE_HEIGHT * lines.length + px * st.strokeEm, lineWidths };
}

export interface BoldPlacement {
  /** block centre, fraction of H (feed to drawBoldCaption) */
  centerY: number;
  rect: Rect;
  /** no face rectangle (without margin) touches the caption */
  clearOfFaces: boolean;
  faceOverlapPx: number;
  score: number;
  warnings: string[];
}
const area = (r: Rect) => Math.max(0, r.w) * Math.max(0, r.h);
function inter(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}
const grow = (r: Rect, d: number): Rect => ({ x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d });
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

/** Choose the caption position for the whole caption. `box` = layoutBold(...) size in px. */
export function placeBold(req: { W: number; H: number; box: { w: number; h: number }; occupied: readonly OccupiedRect[]; safe?: Partial<SafeInsets>; preferY?: number }): BoldPlacement {
  const { W, H, box } = req, safe = { ...BOLD_SAFE, ...(req.safe ?? {}) }, pref = req.preferY ?? 0.5;
  const warnings: string[] = [];
  const minC = safe.top + box.h / 2 / H, maxC = 1 - safe.bottom - box.h / 2 / H;
  const x = (W - box.w) / 2;
  const cands: number[] = [];
  if (maxC < minC) { warnings.push('CAPTION_TALLER_THAN_SAFE_AREA'); cands.push((minC + maxC) / 2); }
  else for (let k = 0; k <= 60; k++) {
    const c = pref + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.01;
    if (c >= minC - 1e-9 && c <= maxC + 1e-9) cands.push(c);
  }
  const occ = req.occupied.filter((o) => area(o.rect) > 0);
  let best: BoldPlacement | null = null;
  for (const c of cands) {
    const rect: Rect = { x, y: H * c - box.h / 2, w: box.w, h: box.h };
    let s = Math.abs(c - pref) * 40, faceHit = 0, hard = 0;
    for (const o of occ) {
      if (o.kind === 'face') {
        const raw = inter(rect, o.rect), m = inter(rect, grow(o.rect, H * FACE_MARGIN));
        faceHit += raw;
        if (m > 0) { hard++; s += 1e4 + 1e4 * (m / area(grow(o.rect, H * FACE_MARGIN))); }
      } else {
        const cov = inter(rect, o.rect) / area(o.rect);
        s += cov * (o.kind === 'prop' ? 300 : o.kind === 'graphic' ? 600 : 6);
      }
    }
    if (!best || s < best.score - 1e-9) best = { centerY: r4(c), rect: { x: r4(rect.x), y: r4(rect.y), w: r4(rect.w), h: r4(rect.h) }, clearOfFaces: faceHit === 0, faceOverlapPx: Math.round(faceHit), score: r4(s), warnings: hard ? ['CAPTION_NEAR_FACE'] : [] };
  }
  best!.warnings.unshift(...warnings);
  if (!best!.clearOfFaces) best!.warnings.push('CAPTION_OVERLAPS_FACE');
  return best!;
}
