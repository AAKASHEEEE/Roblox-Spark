// Text styles (S7): one TextStyleDef per LIBRARY.textStyles ID, plus the layout/animation constants each renderer uses.
// All sizes are fractions of the frame height H (1080x1920 vertical) so stills and half-scale previews match.
import type { TextStyleDef } from '../../library/src/types.ts';

/** heavy sans stack: Noto Sans Black where installed, then the fonts the narrated captions already rely on */
export const FONT_STACK = '"Noto Sans", "DejaVu Sans", "Liberation Sans", Arial, Helvetica, sans-serif';
export const INK = '#0b0d12';
export const HIGHLIGHT = Object.freeze({ yellow: '#ffe11a', red: '#ff3b30' });
export type HighlightColor = keyof typeof HIGHLIGHT;

export interface S7TextStyle extends TextStyleDef {
  /** font size as a fraction of frame height */
  sizeH: number;
  /** stroke width as a fraction of the font size */
  strokeEm: number;
  /** animate-in duration (s) */
  inSec: number;
  /** animate-out duration (s); 0 = hard cut */
  outSec: number;
}

export const TEXT_STYLE_DEFS: Readonly<Record<string, S7TextStyle>> = Object.freeze({
  /** existing narrated preset (packages/narrated CAPTION_STYLE / engine capture.ts); listed so every textStyles ID resolves */
  shorts_default: { id: 'shorts_default', version: '1.0.0', kind: 'text_style', font: '"DejaVu Sans", "Liberation Sans", Arial, Helvetica, sans-serif', weight: 800, fill: '#ffffff', stroke: { color: 'rgba(8,10,16,0.95)', width: 0.2 }, highlightFill: '#ffe600', space: 'screen', maxWordsPerChunk: 16, animateIn: 'none', sizeH: 0.036, strokeEm: 0.2, inSec: 0, outSec: 0 },
  /** 1-4 words, centred, bold white, thick outline, one yellow/red keyword, quick pop-in, kept clear of faces */
  caption_bold: { id: 'caption_bold', version: '1.0.0', kind: 'text_style', font: FONT_STACK, weight: 900, fill: '#ffffff', stroke: { color: INK, width: 0.26 }, highlightFill: HIGHLIGHT.yellow, space: 'screen', maxWordsPerChunk: 4, animateIn: 'pop', sizeH: 0.06, strokeEm: 0.26, inSec: 0.13, outSec: 0 },
  /** extruded 3D lettering standing in the set (signs, labels, "FREE COINS") */
  world_text_3d: { id: 'world_text_3d', version: '1.0.0', kind: 'text_style', font: FONT_STACK, weight: 900, fill: '#ffd21f', stroke: { color: INK, width: 0.12 }, highlightFill: '#ffffff', space: 'world', maxWordsPerChunk: 3, animateIn: 'pop', sizeH: 0, strokeEm: 0.12, inSec: 0.3, outSec: 0.2 },
  /** game-UI style notification pill ("+1 COIN", "LEVEL UP") that pops above its target */
  ui_popup: { id: 'ui_popup', version: '1.0.0', kind: 'text_style', font: FONT_STACK, weight: 900, fill: '#ffffff', stroke: { color: '#0a2a5c', width: 0.16 }, highlightFill: HIGHLIGHT.yellow, space: 'screen', maxWordsPerChunk: 4, animateIn: 'pop', sizeH: 0.042, strokeEm: 0.16, inSec: 0.22, outSec: 0.2 },
  /** full-screen title card ("LATER...", "MEANWHILE") with a sunburst background, slides in and out */
  title_card: { id: 'title_card', version: '1.0.0', kind: 'text_style', font: FONT_STACK, weight: 900, fill: '#ffffff', stroke: { color: INK, width: 0.2 }, highlightFill: HIGHLIGHT.yellow, space: 'screen', maxWordsPerChunk: 6, animateIn: 'slide', sizeH: 0.1, strokeEm: 0.2, inSec: 0.28, outSec: 0.25 },
});
export const TEXT_STYLE_IDS: readonly string[] = Object.freeze(Object.keys(TEXT_STYLE_DEFS));
/** IDs implemented here that the library still lists as planned (for the S0 status-flip report) */
export const S7_NEW_TEXT_STYLE_IDS: readonly string[] = Object.freeze(['caption_bold', 'world_text_3d', 'ui_popup', 'title_card']);
export const fontCss = (s: S7TextStyle, px: number): string => `${s.weight} ${Math.max(1, Math.round(px))}px ${s.font}`;
