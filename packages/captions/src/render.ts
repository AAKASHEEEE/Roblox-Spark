// Screen-space text renderers (S7): caption_bold, ui_popup and title_card drawn with Canvas2D over a finished frame.
// Every function is a pure function of (inputs, local time lt): random-access safe for frame-by-frame encoding.
import { FONT_STACK, HIGHLIGHT, INK, TEXT_STYLE_DEFS, fontCss } from './styles.ts';
import { layoutBold, placeBold, type BoldPlacement, type Measure, type OccupiedRect } from './placement.ts';
import type { BoldCaption } from './bold.ts';

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const easeOutCubic = (t: number) => 1 - (1 - clamp(t, 0, 1)) ** 3;
const easeInCubic = (t: number) => clamp(t, 0, 1) ** 3;
const easeOutBack = (t: number, s = 1.9) => { const u = clamp(t, 0, 1) - 1; return 1 + (s + 1) * u ** 3 + s * u ** 2; };

/** canvas measurer bound to a context (uses the real font metrics) */
export function canvasMeasure(g: Ctx2D, font = FONT_STACK, weight = 900): Measure {
  return (text, px) => { g.font = `${weight} ${px}px ${font}`; return g.measureText(text).width; };
}

// ---------------------------------------------------------------- caption_bold

/** quick pop-in: 0.7 -> 1.12 over 60 ms, settle to 1.0 by 130 ms; opacity 0 -> 1 over 40 ms */
export function boldPop(lt: number): { scale: number; alpha: number } {
  const T = TEXT_STYLE_DEFS.caption_bold.inSec, a = T * 0.46;
  if (lt <= 0) return { scale: 0.7, alpha: 0 };
  const scale = lt < a ? 0.7 + 0.42 * easeOutCubic(lt / a) : lt < T ? 1.12 - 0.12 * easeOutCubic((lt - a) / (T - a)) : 1;
  return { scale, alpha: clamp(lt / 0.04, 0, 1) };
}

/** place a caption against the occupied rectangles using the real font metrics */
export function placeBoldCaption(g: Ctx2D, W: number, H: number, cap: BoldCaption, occupied: readonly OccupiedRect[]): BoldPlacement {
  const lay = layoutBold(cap.display, W, H, canvasMeasure(g));
  return placeBold({ W, H, box: lay, occupied });
}

/** Draw one caption_bold caption at its placement centre. `lt` = t - caption.start. */
export function drawBoldCaption(g: Ctx2D, W: number, H: number, cap: BoldCaption, centerY: number, lt: number): void {
  const st = TEXT_STYLE_DEFS.caption_bold;
  const lay = layoutBold(cap.display, W, H, canvasMeasure(g));
  const { scale, alpha } = boldPop(lt);
  if (alpha <= 0) return;
  const px = lay.px, lh = px * 1.08, cy = H * centerY;
  g.save();
  g.globalAlpha = alpha;
  g.translate(W / 2, cy); g.scale(scale, scale); g.translate(-W / 2, -cy);
  g.font = fontCss(st, px); g.textBaseline = 'middle'; g.textAlign = 'left'; g.lineJoin = 'round'; g.miterLimit = 2;
  const space = g.measureText(' ').width;
  const hiColor = HIGHLIGHT[cap.highlightColor];
  // index of each word across lines
  let wi = 0;
  const rows = lay.lines.map((line, k) => {
    const widths = line.map((w) => g.measureText(w).width), total = widths.reduce((a, b) => a + b, 0) + space * (line.length - 1);
    let x = (W - total) / 2;
    const y = cy + (k - (lay.lines.length - 1) / 2) * lh;
    return line.map((w, j) => { const r = { w, x, y, hi: wi === cap.highlightIndex }; x += widths[j] + space; wi++; return r; });
  }).flat();
  // 1) soft drop shadow, 2) thick outline for every word, 3) fills: outlines never cut into a neighbour's fill
  g.lineWidth = px * st.strokeEm;
  g.strokeStyle = 'rgba(0,0,0,0.45)';
  for (const r of rows) g.strokeText(r.w, r.x, r.y + px * 0.07);
  g.strokeStyle = st.stroke!.color;
  for (const r of rows) g.strokeText(r.w, r.x, r.y);
  for (const r of rows) { g.fillStyle = r.hi ? hiColor : st.fill; g.fillText(r.w, r.x, r.y); }
  g.restore();
}

// ---------------------------------------------------------------- ui_popup

export type PopupIcon = 'coin' | 'star' | 'bell' | 'up' | 'none';
/** icon from the popup text: coins/money -> coin, level/up -> arrow, message/notification -> bell, else star */
export function popupIconFor(text: string): PopupIcon {
  const t = text.toLowerCase();
  if (/coin|robux|cash|money|\$/.test(t)) return 'coin';
  if (/level|up\b|xp|rank/.test(t)) return 'up';
  if (/message|notif|ping|dm|new/.test(t)) return 'bell';
  return 'star';
}
function roundRect(g: Ctx2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
function drawPopupIcon(g: Ctx2D, icon: PopupIcon, cx: number, cy: number, r: number): void {
  if (icon === 'none') return;
  g.lineWidth = r * 0.16; g.strokeStyle = INK;
  if (icon === 'coin') {
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fillStyle = '#ffc21a'; g.fill(); g.stroke();
    g.beginPath(); g.arc(cx, cy, r * 0.68, 0, Math.PI * 2); g.lineWidth = r * 0.1; g.strokeStyle = '#d98a00'; g.stroke();
    // lightning bolt (the Spark coin mark)
    g.beginPath(); g.moveTo(cx + r * 0.12, cy - r * 0.5); g.lineTo(cx - r * 0.26, cy + r * 0.06); g.lineTo(cx - r * 0.02, cy + r * 0.06); g.lineTo(cx - r * 0.14, cy + r * 0.5); g.lineTo(cx + r * 0.28, cy - r * 0.08); g.lineTo(cx + r * 0.04, cy - r * 0.08); g.closePath();
    g.fillStyle = '#fff4c2'; g.fill();
  } else if (icon === 'star') {
    g.beginPath();
    for (let k = 0; k < 10; k++) { const a = -Math.PI / 2 + (k * Math.PI) / 5, rr = k % 2 ? r * 0.45 : r; g.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr); }
    g.closePath(); g.fillStyle = '#ffd21f'; g.fill(); g.stroke();
  } else if (icon === 'up') {
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fillStyle = '#39d353'; g.fill(); g.stroke();
    g.beginPath(); g.moveTo(cx, cy - r * 0.6); g.lineTo(cx + r * 0.5, cy); g.lineTo(cx + r * 0.2, cy); g.lineTo(cx + r * 0.2, cy + r * 0.55); g.lineTo(cx - r * 0.2, cy + r * 0.55); g.lineTo(cx - r * 0.2, cy); g.lineTo(cx - r * 0.5, cy); g.closePath(); g.fillStyle = '#ffffff'; g.fill();
  } else {
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fillStyle = '#ff4d6d'; g.fill(); g.stroke();
    g.beginPath(); g.moveTo(cx - r * 0.45, cy + r * 0.3); g.quadraticCurveTo(cx - r * 0.4, cy - r * 0.55, cx, cy - r * 0.55); g.quadraticCurveTo(cx + r * 0.4, cy - r * 0.55, cx + r * 0.45, cy + r * 0.3); g.closePath(); g.fillStyle = '#fff'; g.fill();
    g.beginPath(); g.arc(cx, cy + r * 0.42, r * 0.14, 0, Math.PI * 2); g.fill();
  }
}

export interface PopupOpts {
  /** screen anchor (px) the popup rises from, e.g. the projected target; default: upper third, centred */
  anchor?: { x: number; y: number } | null;
  icon?: PopupIcon;
}
/** popup rectangle at full scale (px), for placement of other overlays (captions avoid it) */
export function popupRect(g: Ctx2D, W: number, H: number, text: string, opts: PopupOpts = {}): { x: number; y: number; w: number; h: number } {
  const st = TEXT_STYLE_DEFS.ui_popup, px = Math.round(H * st.sizeH), h = px * 1.9;
  g.font = fontCss(st, px);
  const icon = opts.icon ?? popupIconFor(text), iconW = icon === 'none' ? 0 : h * 0.9;
  const w = Math.min(W * 0.84, g.measureText(text.toUpperCase()).width + px * 1.6 + iconW);
  const ax = opts.anchor?.x ?? W / 2, ay = opts.anchor ? opts.anchor.y - H * 0.07 : H * 0.3;
  const x = clamp(ax - w / 2, W * 0.05, W * 0.95 - w), y = clamp(ay - h / 2, H * 0.09, H * 0.8 - h);
  return { x, y, w, h };
}
/** Draw a ui_popup at local time lt of a graphic lasting d seconds. */
export function drawUiPopup(g: Ctx2D, W: number, H: number, text: string, lt: number, d: number, opts: PopupOpts = {}): void {
  const st = TEXT_STYLE_DEFS.ui_popup;
  if (lt < 0 || lt > d) return;
  const rect = popupRect(g, W, H, text, opts), px = Math.round(H * st.sizeH);
  const inU = lt / st.inSec, outU = (lt - (d - st.outSec)) / st.outSec;
  const scale = (lt < st.inSec ? Math.max(0, easeOutBack(inU)) : 1) * (outU > 0 ? 1 - 0.35 * easeInCubic(outU) : 1);
  const alpha = (lt < 0.05 ? lt / 0.05 : 1) * (outU > 0 ? 1 - easeInCubic(outU) : 1);
  const rise = H * 0.018 * easeOutCubic(lt / d);
  const { x, w, h } = rect, y = rect.y - rise, cx = x + w / 2, cy = y + h / 2, r = h / 2;
  g.save();
  g.globalAlpha = clamp(alpha, 0, 1);
  g.translate(cx, cy); g.scale(scale, scale); g.translate(-cx, -cy);
  // lip (3D button base), body gradient, gloss band, white rim, ink outline
  roundRect(g, x, y + h * 0.1, w, h, r); g.fillStyle = '#0b3f8f'; g.fill();
  roundRect(g, x, y, w, h, r);
  const grad = g.createLinearGradient(0, y, 0, y + h); grad.addColorStop(0, '#5fd8ff'); grad.addColorStop(0.55, '#2a8ff0'); grad.addColorStop(1, '#1a62d6');
  g.fillStyle = grad; g.fill();
  g.lineWidth = H * 0.005; g.strokeStyle = '#ffffff'; g.stroke();
  roundRect(g, x - H * 0.003, y - H * 0.003, w + H * 0.006, h * 1.1 + H * 0.006, r + H * 0.003); g.lineWidth = H * 0.003; g.strokeStyle = INK; g.stroke();
  roundRect(g, x + r * 0.5, y + h * 0.1, w - r, h * 0.3, h * 0.15); g.fillStyle = 'rgba(255,255,255,0.28)'; g.fill();
  const icon = opts.icon ?? popupIconFor(text), iconW = icon === 'none' ? 0 : h * 0.9;
  drawPopupIcon(g, icon, x + r * 0.95, cy, h * 0.34);
    const displayText = text.toUpperCase();
    let textPx = px;
    g.font = fontCss(st, textPx);
    const availableTextW = Math.max(px, w - iconW - px * 0.9);
    const measuredTextW = g.measureText(displayText).width;
    if (measuredTextW > availableTextW) textPx = Math.max(Math.round(H * 0.022), Math.floor((textPx * availableTextW) / measuredTextW));
    g.font = fontCss(st, textPx); g.textBaseline = 'middle'; g.textAlign = 'center'; g.lineJoin = 'round';
  const tx = x + iconW + (w - iconW) / 2 - px * 0.1;
  g.lineWidth = textPx * st.strokeEm; g.strokeStyle = st.stroke!.color; g.strokeText(displayText, tx, cy + textPx * 0.04);
  g.fillStyle = st.fill; g.fillText(displayText, tx, cy + textPx * 0.04);
  g.restore();
}

// ---------------------------------------------------------------- title_card

export interface TitleCardOpts { subtitle?: string; palette?: [string, string]; textColor?: string }
function wrapTitle(g: Ctx2D, text: string, maxW: number): string[] {
  const words = text.toUpperCase().split(/\s+/).filter(Boolean);
  if (g.measureText(words.join(' ')).width <= maxW || words.length < 2) return [words.join(' ')];
  let best: string[] = [words.join(' ')], bw = Infinity;
  for (let k = 1; k < words.length; k++) { const a = words.slice(0, k).join(' '), b = words.slice(k).join(' '), m = Math.max(g.measureText(a).width, g.measureText(b).width); if (m < bw) { bw = m; best = [a, b]; } }
  return best;
}
/** Draw a full-screen title card at local time lt of a card lasting d seconds (slides in from the right, out to the left). */
export function drawTitleCard(g: Ctx2D, W: number, H: number, text: string, lt: number, d: number, opts: TitleCardOpts = {}): void {
  const st = TEXT_STYLE_DEFS.title_card;
  if (lt < 0 || lt > d) return;
  const [c0, c1] = opts.palette ?? ['#ffcf1f', '#ffb000'];
  const inU = easeOutCubic(lt / st.inSec), outU = easeInCubic((lt - (d - st.outSec)) / st.outSec);
  const off = lt < st.inSec ? (1 - inU) * W : lt > d - st.outSec ? -outU * W : 0;
  g.save();
  g.translate(off, 0);
  // sunburst: 24 rays rotating slowly around the upper-centre, radial vignette
  const cx = W / 2, cy = H * 0.46, R = Math.hypot(W, H);
  g.fillStyle = c1; g.fillRect(0, 0, W, H);
  g.fillStyle = c0;
  const rot = lt * 0.25;
  for (let k = 0; k < 24; k += 2) {
    const a0 = rot + (k * Math.PI * 2) / 24, a1 = rot + ((k + 1) * Math.PI * 2) / 24;
    g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a0) * R, cy + Math.sin(a0) * R); g.lineTo(cx + Math.cos(a1) * R, cy + Math.sin(a1) * R); g.closePath(); g.fill();
  }
  const vg = g.createRadialGradient(cx, cy, H * 0.15, cx, cy, H * 0.75); vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(60,20,0,0.45)');
  g.fillStyle = vg; g.fillRect(0, 0, W, H);
  // leading edge band sells the wipe
  g.fillStyle = INK; g.fillRect(W - H * 0.006, 0, H * 0.006, H); g.fillRect(0, 0, H * 0.006, H);
  // title: tilted, text pops 0.1 s after the card lands, then breathes
  const tl = lt - st.inSec * 0.6, pop = tl <= 0 ? 0 : tl < 0.2 ? easeOutBack(tl / 0.2, 2.2) : 1 + 0.015 * Math.sin((tl - 0.2) * 3);
  if (pop > 0) {
    let px = Math.round(H * st.sizeH);
    g.font = fontCss(st, px);
    let lines = wrapTitle(g, text, W * 0.84);
    const widest = Math.max(...lines.map((l) => g.measureText(l).width));
    if (widest > W * 0.84) { px = Math.floor((px * W * 0.84) / widest); g.font = fontCss(st, px); lines = wrapTitle(g, text, W * 0.84); }
    g.translate(cx, cy); g.rotate(-0.06); g.scale(pop, pop);
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
    const lh = px * 1.05;
    lines.forEach((l, k) => {
      const y = (k - (lines.length - 1) / 2) * lh;
      g.lineWidth = px * st.strokeEm * 1.4; g.strokeStyle = 'rgba(0,0,0,0.35)'; g.strokeText(l, px * 0.05, y + px * 0.09);
      g.lineWidth = px * st.strokeEm; g.strokeStyle = st.stroke!.color; g.strokeText(l, 0, y);
      g.fillStyle = opts.textColor ?? st.fill; g.fillText(l, 0, y);
    });
    if (opts.subtitle) {
      const sp = Math.round(px * 0.38), y = (lines.length / 2) * lh + sp * 0.9;
      g.font = `${st.weight} ${sp}px ${st.font}`;
      g.lineWidth = sp * 0.22; g.strokeStyle = st.stroke!.color; g.strokeText(opts.subtitle.toUpperCase(), 0, y);
      g.fillStyle = HIGHLIGHT.yellow; g.fillText(opts.subtitle.toUpperCase(), 0, y);
    }
  }
  g.restore();
}
