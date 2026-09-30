// Overlay compositor (S7): draws everything screen-space for one frame, in a fixed order:
//   ui_popup graphics -> title_card graphics -> caption_bold caption (captions stay readable over a title card).
// world_text_3d graphics live in the 3D scene (world-text.ts WorldTextLayer), not here.
import type { BoldCaption } from './bold.ts';
import type { OccupiedRect } from './placement.ts';
import { drawBoldCaption, drawTitleCard, drawUiPopup, popupRect, type Ctx2D } from './render.ts';

/** a beat-sheet `text_graphic` event (packages/director/src/beat-sheet.ts) */
export interface TextGraphicEvent { textStyleId: string; at: number; duration: number; text: string; target?: string }
export type ScreenAnchor = (target: string, t: number) => { x: number; y: number } | undefined;

export const activeAt = <E extends { at: number; duration: number }>(events: readonly E[], t: number): Array<{ e: E; lt: number }> =>
  events.filter((e) => t >= e.at - 1e-9 && t < e.at + e.duration - 1e-9).map((e) => ({ e, lt: t - e.at }));
export const captionAt = (caps: readonly BoldCaption[], t: number): BoldCaption | undefined => caps.find((c) => t >= c.start - 1e-9 && t < c.end - 1e-9);

/** beat-sheet beats -> flat text-graphic event list */
export function textGraphicsFromBeats(beats: ReadonlyArray<{ events: ReadonlyArray<{ type: string } & Record<string, unknown>> }>): TextGraphicEvent[] {
  const out: TextGraphicEvent[] = [];
  for (const b of beats) for (const e of b.events) if (e.type === 'text_graphic') out.push({ textStyleId: String(e.textStyleId), at: Number(e.at), duration: Number(e.duration), text: String(e.text), target: e.target as string | undefined });
  return out;
}

/** screen rectangles the popups occupy over [t0, t1): captions are placed clear of them */
export function graphicOccupancy(g: Ctx2D, W: number, H: number, events: readonly TextGraphicEvent[], t0: number, t1: number, anchor?: ScreenAnchor): OccupiedRect[] {
  const out: OccupiedRect[] = [];
  events.forEach((e, i) => {
    if (e.at >= t1 || e.at + e.duration <= t0) return;
    if (e.textStyleId === 'ui_popup') out.push({ id: `graphic:${i}`, kind: 'graphic', rect: popupRect(g, W, H, e.text, { anchor: e.target ? anchor?.(e.target, Math.max(t0, e.at)) : null }) });
  });
  return out;
}

export interface OverlayFrame {
  captions: readonly BoldCaption[];
  /** caption id -> centre or shot-segment centres from placeBold / placeBoldCaption; missing = frame centre */
  placements: ReadonlyMap<string, number | readonly { start: number; end: number; centerY: number }[]>;
  graphics: readonly TextGraphicEvent[];
  anchor?: ScreenAnchor;
}
export function drawOverlay(g: Ctx2D, W: number, H: number, t: number, f: OverlayFrame): void {
  for (const { e, lt } of activeAt(f.graphics, t)) if (e.textStyleId === 'ui_popup') drawUiPopup(g, W, H, e.text, lt, e.duration, { anchor: e.target ? f.anchor?.(e.target, t) : null });
  for (const { e, lt } of activeAt(f.graphics, t)) if (e.textStyleId === 'title_card') drawTitleCard(g, W, H, e.text, lt, e.duration);
  const c = captionAt(f.captions, t);
  if (c) {
    const p = f.placements.get(c.id);
    const centerY = typeof p === 'number' ? p : p?.find((s) => t >= s.start - 1e-9 && t < s.end - 1e-9)?.centerY ?? 0.5;
    drawBoldCaption(g, W, H, c, centerY, t - c.start);
  }
}
