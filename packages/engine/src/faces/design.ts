// Face set v2 drawing primitives. Every feature is an OPAQUE fill (the face decal is alpha-tested at 0.5), so tints
// such as blush or eye shadow are mixed with the character's skin instead of being drawn translucent. Lid cuts use
// `destination-out`, so the head's own skin shows through and no skin colour has to be guessed.
import type { CharacterManifest } from '../../../schema/src/assets.ts';

export type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
export type Side = 'L' | 'R';

/** the locked per-character face layout (from the manifest) plus the skin the decal sits on */
export interface FaceDesign {
  eyeColor: string; browColor: string; mouthColor: string; skin: string;
  eyeSpacing: number; eyeY: number; eyeW: number; eyeH: number;
  browThickness: number; browWidth: number; mouthY: number; mouthW: number;
}

/** layout used when an expression is drawn without a character (ExpressionDef.draw, library previews) */
export const DEFAULT_DESIGN: FaceDesign = {
  eyeColor: '#111114', browColor: '#141012', mouthColor: '#2e1512', skin: '#e8b98f',
  eyeSpacing: 0.34, eyeY: 0.51, eyeW: 0.11, eyeH: 0.18, browThickness: 0.055, browWidth: 0.22, mouthY: 0.75, mouthW: 0.22,
};

export function designOf(ch: CharacterManifest, skin = ch.body.skin): FaceDesign {
  const f = ch.face;
  return {
    eyeColor: f.eyeColor, browColor: f.browColor, mouthColor: f.mouthColor, skin,
    eyeSpacing: f.eyeSpacing, eyeY: f.eyeY, eyeW: f.eyeW, eyeH: f.eyeH, browThickness: f.browThickness, browWidth: f.browWidth, mouthY: f.mouthY, mouthW: f.mouthW,
  };
}

export const WHITE = '#ffffff';
export const TEETH = '#fbfbf6';
export const TONGUE = '#e0575f';
export const THROAT = '#6e1f22';
export const TEAR = '#6fd0ff';
export const TEAR_EDGE = '#1f78c4';
export const HEART = '#ff2f63';

/** sRGB hex mix, a -> b by t */
export function mix(a: string, b: string, t: number): string {
  const p = (h: string) => { const v = parseInt(h.slice(1), 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; };
  const x = p(a), y = p(b);
  return '#' + x.map((c, i) => Math.round(c + (y[i] - c) * t).toString(16).padStart(2, '0')).join('');
}

/** resolved pixel layout for one canvas size; exaggerated relative to face set v1 */
export interface Layout {
  S: number; d: FaceDesign;
  ey: number; ew: number; eh: number; lw: number;
  eyes: Array<{ x: number; side: Side; inward: number }>;
  mx: number; my: number; mw: number;
  bw: number; bt: number;
}
export function layout(d: FaceDesign, S: number): Layout {
  return {
    S, d,
    ey: d.eyeY * S, ew: d.eyeW * S * 1.18, eh: d.eyeH * S * 1.1, lw: 0.036 * S,
    // the character's LEFT eye is on screen-right when facing the camera (same as face set v1)
    eyes: [{ x: S * (0.5 + d.eyeSpacing / 2), side: 'L', inward: -1 }, { x: S * (0.5 - d.eyeSpacing / 2), side: 'R', inward: 1 }],
    mx: S / 2, my: d.mouthY * S, mw: d.mouthW * S,
    bw: d.browWidth * S * 1.08, bt: d.browThickness * S * 1.3,
  };
}

// ---------------------------------------------------------------- shapes

export function line(g: Ctx, x1: number, y1: number, x2: number, y2: number, w: number, c: string): void {
  g.strokeStyle = c; g.lineWidth = w; g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
}
export function roundRect(g: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  r = Math.min(r, w / 2, h / 2);
  g.beginPath(); g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.arcTo(x + w, y, x + w, y + r, r); g.lineTo(x + w, y + h - r);
  g.arcTo(x + w, y + h, x + w - r, y + h, r); g.lineTo(x + r, y + h); g.arcTo(x, y + h, x, y + h - r, r); g.lineTo(x, y + r); g.arcTo(x, y, x + r, y, r); g.closePath();
}
export function ellipse(g: Ctx, x: number, y: number, rx: number, ry: number, fill: string): void {
  g.fillStyle = fill; g.beginPath(); g.ellipse(x, y, Math.max(0.5, rx), Math.max(0.5, ry), 0, 0, Math.PI * 2); g.fill();
}
/** erase (the head skin shows through): used for eyelids and cheek pushes */
export function erase(g: Ctx, path: () => void): void {
  g.save(); g.globalCompositeOperation = 'destination-out'; g.fillStyle = '#000'; g.beginPath(); path(); g.fill(); g.restore();
}

/** eyebrow as a rounded bar: raise -1..1, angleDeg > 0 lifts the inner end (worried), < 0 drops it (angry) */
export function brow(g: Ctx, L: Layout, side: Side, x: number, raise: number, angleDeg: number, opts: { thick?: number; width?: number; arch?: number } = {}): void {
  const bw = L.bw * (opts.width ?? 1), bt = L.bt * (opts.thick ?? 1);
  const y = L.ey - L.eh * 0.5 - 0.08 * L.S - raise * 0.11 * L.S;
  const a = (angleDeg * Math.PI) / 180 * (side === 'L' ? 1 : -1);
  g.save(); g.translate(x, y); g.rotate(a);
  g.fillStyle = L.d.browColor;
  const arch = (opts.arch ?? 0) * L.S;
  if (Math.abs(arch) < 0.5) { roundRect(g, -bw / 2, -bt / 2, bw, bt, bt / 2); g.fill(); }
  else {
    g.strokeStyle = L.d.browColor; g.lineWidth = bt; g.lineCap = 'round';
    g.beginPath(); g.moveTo(-bw / 2, 0); g.quadraticCurveTo(0, -arch * 2, bw / 2, 0); g.stroke();
  }
  g.restore();
}

/** solid dark eye with highlight (the house style); open 0..1 squashes it; <0.2 draws a closed lash line */
export function dotEye(g: Ctx, L: Layout, x: number, y: number, sw: number, sh: number, open: number, highlight = true): void {
  const w = L.ew * sw, h = L.eh * sh;
  if (open < 0.2) { line(g, x - w * 0.6, y, x + w * 0.6, y, L.lw, L.d.eyeColor); return; }
  ellipse(g, x, y, w / 2, (h / 2) * open, L.d.eyeColor);
  if (highlight) ellipse(g, x - w * 0.16, y - h * 0.2 * open, w * 0.16, w * 0.16 * Math.min(1, open * 1.4), WHITE);
}

/** white eye with outline and pupil (wide / staring eyes) */
export function wideEye(g: Ctx, L: Layout, x: number, y: number, r: number, pupil: number, px = 0, py = 0, open = 1): void {
  if (open < 0.2) { line(g, x - r, y, x + r, y, L.lw, L.d.eyeColor); return; }
  g.fillStyle = WHITE; g.beginPath(); g.ellipse(x, y, r, r * open, 0, 0, Math.PI * 2); g.fill();
  g.strokeStyle = L.d.eyeColor; g.lineWidth = L.lw * 0.8; g.stroke();
  const pr = r * pupil;
  ellipse(g, x + px * r, y + py * r * open, pr, pr * Math.min(1, open * 1.2), L.d.eyeColor);
}

/** closed happy arc (^) — bows upward */
export function happyArc(g: Ctx, L: Layout, x: number, y: number, w: number, lift = 0.5): void {
  g.strokeStyle = L.d.eyeColor; g.lineWidth = L.lw * 1.25; g.lineCap = 'round';
  g.beginPath(); g.moveTo(x - w / 2, y + w * 0.12); g.quadraticCurveTo(x, y - w * lift, x + w / 2, y + w * 0.12); g.stroke();
}

/** squeezed-shut chevron (> <), pointing toward the nose */
export function squeeze(g: Ctx, L: Layout, x: number, y: number, inward: number, w: number, h: number): void {
  g.strokeStyle = L.d.eyeColor; g.lineWidth = L.lw * 1.25; g.lineCap = 'round'; g.lineJoin = 'round';
  g.beginPath(); g.moveTo(x - inward * w * 0.5, y - h * 0.5); g.lineTo(x + inward * w * 0.4, y); g.lineTo(x - inward * w * 0.5, y + h * 0.5); g.stroke();
}

/**
 * Eyelid: erase the band above (dir -1) or below (dir +1) the straight line through (xa,ya)-(xb,yb), extended by `ext`
 * on both sides and `depth` px deep. Returns the extended endpoints so the caller can draw the lid edge.
 */
export function lid(g: Ctx, xa: number, ya: number, xb: number, yb: number, ext: number, depth: number, dir: -1 | 1): [number, number, number, number] {
  const k = (yb - ya) / (xb - xa || 1e-6);
  const x0 = Math.min(xa, xb) - ext, x1 = Math.max(xa, xb) + ext;
  const y0 = ya + k * (x0 - xa), y1 = ya + k * (x1 - xa);
  erase(g, () => { g.moveTo(x0, y0); g.lineTo(x1, y1); g.lineTo(x1, y1 + dir * depth); g.lineTo(x0, y0 + dir * depth); g.closePath(); });
  return [x0, y0, x1, y1];
}
/** erase a cheek arc under an eye (happy squint): everything inside the circle below the eye centre */
export function cheekPush(g: Ctx, x: number, y: number, r: number): void {
  erase(g, () => { g.arc(x, y + r, r, 0, Math.PI * 2); });
}

export function heart(g: Ctx, x: number, y: number, s: number, fill: string, edge: string, edgeW: number): void {
  g.beginPath();
  g.moveTo(x, y + s * 0.42);
  g.bezierCurveTo(x - s * 0.62, y + s * 0.02, x - s * 0.55, y - s * 0.5, x, y - s * 0.2);
  g.bezierCurveTo(x + s * 0.55, y - s * 0.5, x + s * 0.62, y + s * 0.02, x, y + s * 0.42);
  g.closePath();
  g.fillStyle = fill; g.fill(); g.strokeStyle = edge; g.lineWidth = edgeW; g.stroke();
  ellipse(g, x - s * 0.22, y - s * 0.16, s * 0.09, s * 0.07, WHITE);
}

export function drop(g: Ctx, x: number, y: number, s: number, fill = TEAR, edge = TEAR_EDGE, edgeW = 3): void {
  g.beginPath(); g.moveTo(x, y - s);
  g.bezierCurveTo(x + s * 0.2, y - s * 0.45, x + s * 0.62, y - s * 0.05, x + s * 0.62, y + s * 0.3);
  g.arc(x, y + s * 0.3, s * 0.62, 0, Math.PI);
  g.bezierCurveTo(x - s * 0.62, y - s * 0.05, x - s * 0.2, y - s * 0.45, x, y - s);
  g.closePath(); g.fillStyle = fill; g.fill(); g.strokeStyle = edge; g.lineWidth = edgeW; g.stroke();
  ellipse(g, x - s * 0.2, y + s * 0.2, s * 0.14, s * 0.2, WHITE);
}

/** blush ovals (skin-mixed, opaque) with two hatch strokes each */
export function blush(g: Ctx, L: Layout, tint: string, amount: number, hatch = true): void {
  const c = mix(L.d.skin, tint, amount), hc = mix(L.d.skin, tint, Math.min(1, amount + 0.3));
  for (const e of L.eyes) {
    const x = e.x - e.inward * L.ew * 0.25, y = L.ey + L.eh * 0.95;
    ellipse(g, x, y, L.ew * 0.85, L.eh * 0.26, c);
    if (hatch) for (let k = -1; k <= 1; k += 2) line(g, x + k * L.ew * 0.3 - L.ew * 0.1, y + L.eh * 0.12, x + k * L.ew * 0.3 + L.ew * 0.1, y - L.eh * 0.12, L.lw * 0.5, hc);
  }
}
