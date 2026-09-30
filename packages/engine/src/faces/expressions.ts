// Face set v2: the planned library expressions (LIBRARY.expressions, status 'planned', owner S3).
// Exaggerated on purpose: each face has to read at 540 px frame width, where a medium-shot head is ~80-110 px wide.
// Every expression is drawn from the character's locked face layout (eye spacing, colours, mouth position), so the
// cast keeps its identity; only the shapes change. Order of drawing: eyes (with lid erasures) -> brows -> mouth -> extras.
import { type Ctx, type Layout, type Side, WHITE, TEAR, TEAR_EDGE, HEART, mix, brow, dotEye, wideEye, happyArc, squeeze, lid, cheekPush, heart, drop, blush, line, ellipse } from './design.ts';
import { type TalkStyle, grinD, laughOpen, clench, screamOval, dropO, frown, wail, sideLine, crescent, squiggle, yawn } from './mouths.ts';

export interface FaceDraw {
  /** eyes + brows (always drawn) */
  upper(g: Ctx, L: Layout, blink: number): void;
  /** the expression's own mouth (replaced by a talking shape while speaking) */
  mouth(g: Ctx, L: Layout): void;
  /** tears, sweat, blush... drawn last, also while talking */
  extras?(g: Ctx, L: Layout): void;
  talk: TalkStyle;
  /** emote bubble S7 may show with it (planned vfx ids) */
  emoteVfxId?: string;
  /** can the eyes blink (false for closed/heart eyes and frozen stares) */
  blinks: boolean;
}

const open = (blink: number) => 1 - blink;
const each = (L: Layout, fn: (x: number, side: Side, inward: number) => void) => { for (const e of L.eyes) fn(e.x, e.side, e.inward); };

export const FACE_SET_V2: Record<string, FaceDraw> = {
  big_grin: {
    blinks: true, talk: { bias: 1, scale: 1.1 },
    upper(g, L, blink) {
      each(L, (x) => { dotEye(g, L, x, L.ey, 1.05, 1.05, open(blink)); if (blink < 0.8) cheekPush(g, x, L.ey + L.eh * 0.22, L.ew * 0.95); });
      each(L, (x, side) => brow(g, L, side, x, 0.5, 8, { arch: 0.012 }));
    },
    mouth(g, L) { grinD(g, L, L.mw * 1.9, 0.17 * L.S, 0.045 * L.S, { tongue: 0.9, teeth: 0.28 }); },
  },
  laugh: {
    blinks: false, talk: { bias: 1, scale: 1.2 },
    upper(g, L) {
      each(L, (x) => happyArc(g, L, x, L.ey + L.eh * 0.1, L.ew * 1.35, 0.6));
      each(L, (x, side) => brow(g, L, side, x, 0.62, 14, { arch: 0.01 }));
    },
    mouth(g, L) { laughOpen(g, L, L.mw * 1.7, 0.16 * L.S); },
    extras(g, L) { blush(g, L, '#ff6f7d', 0.35, false); },
  },
  furious: {
    blinks: true, talk: { bias: -0.7, scale: 1.1 }, emoteVfxId: 'emote_anger',
    upper(g, L, blink) {
      each(L, (x, side, inward) => {
        const r = L.ew * 0.78, o = open(blink);
        wideEye(g, L, x, L.ey + L.eh * 0.05, r, 0.42, inward * 0.12, 0.1, o);
        if (o >= 0.2) { const [x0, y0, x1, y1] = inward < 0 ? lid(g, x - r, L.ey - r * 0.35, x + r, L.ey - r * 1.05, r * 0.3, r * 2, -1) : lid(g, x - r, L.ey - r * 1.05, x + r, L.ey - r * 0.35, r * 0.3, r * 2, -1); line(g, x0 + r * 0.25, y0 + (y1 - y0) * 0.12, x1 - r * 0.25, y1 - (y1 - y0) * 0.12, L.lw * 1.1, L.d.eyeColor); }
      });
      each(L, (x, side) => brow(g, L, side, x, -0.45, -36, { thick: 1.55, width: 1.15 }));
    },
    mouth(g, L) { clench(g, L, L.mw * 1.65, 0.11 * L.S, { down: 0.04 }); },
    extras(g, L) {
      // anger flush: three hot strokes on each cheek
      const c = mix(L.d.skin, '#e2231a', 0.7);
      each(L, (x, _s, inward) => { const cx = x - inward * L.ew * 0.1, cy = L.ey + L.eh * 1.0; for (let k = -1; k <= 1; k++) line(g, cx + k * L.ew * 0.35 - L.ew * 0.12, cy + L.eh * 0.14, cx + k * L.ew * 0.35 + L.ew * 0.12, cy - L.eh * 0.14, L.lw * 0.6, c); });
    },
  },
  scream: {
    blinks: false, talk: { bias: -0.2, scale: 1.4 },
    upper(g, L) {
      each(L, (x) => wideEye(g, L, x, L.ey - L.eh * 0.05, L.ew * 0.95, 0.2));
      each(L, (x, side) => brow(g, L, side, x, 0.95, 26, { thick: 1.2 }));
    },
    mouth(g, L) { screamOval(g, L, L.mw * 1.45, 0.25 * L.S); },
  },
  shocked: {
    blinks: false, talk: { bias: 0, scale: 1.15 },
    upper(g, L) {
      each(L, (x) => { wideEye(g, L, x, L.ey - L.eh * 0.1, L.ew * 1.05, 0.16); });
      each(L, (x, side) => brow(g, L, side, x, 1.1, 0, { arch: 0.018 }));
    },
    mouth(g, L) { dropO(g, L, L.mw * 0.72, 0.17 * L.S); },
    extras(g, L) {
      // shock lines above the brows
      const y = L.ey - L.eh * 0.5 - 0.22 * L.S;
      for (const k of [-1, 0, 1]) line(g, L.mx + k * 0.07 * L.S, y - 0.02 * L.S, L.mx + k * 0.1 * L.S, y - 0.065 * L.S, L.lw * 0.7, L.d.eyeColor);
    },
  },
  scared: {
    blinks: true, talk: { bias: -0.5, scale: 1 }, emoteVfxId: 'emote_sweat',
    upper(g, L, blink) {
      each(L, (x, _s, inward) => wideEye(g, L, x, L.ey, L.ew * 0.85, 0.22, inward * 0.25, 0.3, open(blink)));
      each(L, (x, side) => brow(g, L, side, x, 0.65, 34, { thick: 1.1 }));
    },
    mouth(g, L) { clench(g, L, L.mw * 1.4, 0.095 * L.S, { down: 0.025, wobble: 0.009 }); },
    extras(g, L) { drop(g, L.eyes[1].x - L.ew * 1.25, L.ey - L.eh * 0.9, 0.055 * L.S, TEAR, TEAR_EDGE, L.lw * 0.5); },
  },
  sad: {
    blinks: true, talk: { bias: -1, scale: 0.9 },
    upper(g, L, blink) {
      each(L, (x, _s, inward) => {
        const o = open(blink);
        dotEye(g, L, x, L.ey + L.eh * 0.08, 1.15, 1.05, o, false);
        if (o >= 0.2) {
          // droop: outer end of the lid lower than the inner end, plus two wet highlights
          const r = L.ew * 0.7;
          lid(g, x + inward * r, L.ey - L.eh * 0.42, x - inward * r, L.ey - L.eh * 0.05, r * 0.2, L.eh, -1);
          ellipse(g, x - L.ew * 0.12, L.ey + L.eh * 0.12, L.ew * 0.15, L.ew * 0.15, WHITE);
          ellipse(g, x + L.ew * 0.14, L.ey + L.eh * 0.32, L.ew * 0.07, L.ew * 0.07, WHITE);
        }
      });
      each(L, (x, side) => brow(g, L, side, x, 0.35, 32));
    },
    mouth(g, L) { frown(g, L, L.mw * 1.2, 0.06 * L.S); },
    extras(g, L) { drop(g, L.eyes[0].x + L.ew * 0.25, L.ey + L.eh * 0.85, 0.04 * L.S, TEAR, TEAR_EDGE, L.lw * 0.45); },
  },
  crying: {
    blinks: false, talk: { bias: -1, scale: 1.15 }, emoteVfxId: 'emote_tears',
    upper(g, L) {
      each(L, (x, _s, inward) => squeeze(g, L, x, L.ey + L.eh * 0.05, inward, L.ew * 1.3, L.eh * 0.75));
      each(L, (x, side) => brow(g, L, side, x, 0.55, 36, { thick: 1.1 }));
    },
    mouth(g, L) { wail(g, L, L.mw * 1.45, 0.11 * L.S); },
    extras(g, L) {
      // two thick tear streams from under the eyes to the jaw
      for (const e of L.eyes) {
        const x = e.x - e.inward * L.ew * 0.15, y0 = L.ey + L.eh * 0.35, y1 = 0.97 * L.S, w = 0.05 * L.S;
        g.fillStyle = TEAR; g.strokeStyle = TEAR_EDGE; g.lineWidth = L.lw * 0.5;
        g.beginPath(); g.moveTo(x - w / 2, y0); g.bezierCurveTo(x - w * 0.8, y0 + (y1 - y0) * 0.4, x - w * 0.3, y1 - 0.06 * L.S, x - w * 0.55, y1);
        g.lineTo(x + w * 0.55, y1); g.bezierCurveTo(x + w * 0.3, y1 - 0.06 * L.S, x + w * 0.8, y0 + (y1 - y0) * 0.4, x + w / 2, y0); g.closePath(); g.fill(); g.stroke();
        line(g, x - w * 0.12, y0 + 0.03 * L.S, x - w * 0.2, y0 + 0.12 * L.S, L.lw * 0.45, WHITE);
      }
    },
  },
  suspicious: {
    blinks: true, talk: { bias: -0.3, scale: 0.9 },
    upper(g, L, blink) {
      each(L, (x, side) => {
        const o = open(blink), r = L.ew * 0.8, cy = L.ey + L.eh * 0.12;
        const slit = side === 'L' ? 0.4 : 0.52; // the character's left eye squints harder
        wideEye(g, L, x, cy, r, 0.5, -0.45, 0.05, o);
        if (o >= 0.2) {
          const [x0, y0, x1, y1] = lid(g, x - r, cy - r * (1 - slit * 2) - r * 0.05, x + r, cy - r * (1 - slit * 2) + r * 0.05, r * 0.3, r * 2, -1);
          lid(g, x - r, cy + r * 0.55, x + r, cy + r * 0.5, r * 0.3, r * 2, 1);
          line(g, x0 + r * 0.2, y0, x1 - r * 0.2, y1, L.lw * 1.2, L.d.eyeColor);
        }
      });
      each(L, (x, side) => side === 'L' ? brow(g, L, side, x, -0.35, -18, { thick: 1.2 }) : brow(g, L, side, x, -0.05, -6, { thick: 1.2 }));
    },
    mouth(g, L) { sideLine(g, L, L.mw * 0.75, -0.045 * L.S, 0.012 * L.S); },
  },
  sleepy: {
    blinks: true, talk: { bias: 0, scale: 0.85 },
    upper(g, L, blink) {
      each(L, (x) => {
        const o = open(blink) * 0.55;
        const w = L.ew * 1.15, cy = L.ey + L.eh * 0.2;
        if (o < 0.2) { line(g, x - w * 0.6, cy, x + w * 0.6, cy, L.lw * 1.1, L.d.eyeColor); return; }
        // heavy lid: lower half of the eye under a thick flat lid line
        ellipse(g, x, cy, w / 2, (L.eh / 2) * 0.9, L.d.eyeColor);
        const [x0, y0, x1, y1] = lid(g, x - w / 2, cy - (L.eh / 2) * 0.9 * (1 - 2 * o), x + w / 2, cy - (L.eh / 2) * 0.9 * (1 - 2 * o) + L.eh * 0.04, w * 0.2, L.eh * 1.2, -1);
        line(g, x0 + w * 0.12, y0, x1 - w * 0.12, y1, L.lw * 1.15, L.d.eyeColor);
      });
      each(L, (x, side) => brow(g, L, side, x, -0.12, 12, { thick: 0.9 }));
    },
    mouth(g, L) { yawn(g, L, L.mw * 0.22, L.mw * 0.3, 0.02 * L.S); },
    extras(g, L) {
      // drool drop at the mouth corner + dark under-eye rings
      drop(g, L.mx - L.mw * 0.12, L.my + L.mw * 0.9, 0.03 * L.S, TEAR, TEAR_EDGE, L.lw * 0.4);
      const ring = mix(L.d.skin, '#3a2a55', 0.35);
      for (const e of L.eyes) { g.strokeStyle = ring; g.lineWidth = L.lw * 0.6; g.beginPath(); g.arc(e.x, L.ey + L.eh * 0.2, L.ew * 0.62, Math.PI * 0.2, Math.PI * 0.8); g.stroke(); }
    },
  },
  evil_grin: {
    blinks: true, talk: { bias: 0.8, scale: 1 },
    upper(g, L, blink) {
      const shade = mix(L.d.skin, '#1a0f24', 0.3);
      each(L, (x, side, inward) => {
        const o = open(blink), r = L.ew * 0.72;
        ellipse(g, x, L.ey + L.eh * 0.02, r * 1.35, r * 1.1, shade);
        dotEye(g, L, x, L.ey + L.eh * 0.05, 1.1, 0.9, o, false);
        if (o >= 0.2) {
          const [x0, y0, x1, y1] = inward < 0 ? lid(g, x - r, L.ey - r * 0.05, x + r, L.ey - r * 0.75, r * 0.2, r * 1.2, -1) : lid(g, x - r, L.ey - r * 0.75, x + r, L.ey - r * 0.05, r * 0.2, r * 1.2, -1);
          line(g, x0 + r * 0.1, y0, x1 - r * 0.1, y1, L.lw * 1.1, L.d.eyeColor);
          lid(g, x - r, L.ey + L.eh * 0.34, x + r, L.ey + L.eh * 0.34, r * 0.2, r, 1);
          ellipse(g, x + inward * r * 0.25, L.ey + L.eh * 0.12, L.ew * 0.1, L.ew * 0.1, WHITE);
        }
      });
      each(L, (x, side) => side === 'L' ? brow(g, L, side, x, 0.05, -32, { thick: 1.3 }) : brow(g, L, side, x, -0.2, -28, { thick: 1.3 }));
    },
    mouth(g, L) { crescent(g, L, L.mw * 2.0, 0.12 * L.S, 0.018 * L.S); },
  },
  confused: {
    blinks: true, talk: { bias: -0.2, scale: 0.95 }, emoteVfxId: 'emote_question',
    upper(g, L, blink) {
      const o = open(blink);
      const [a, b] = L.eyes; // a = character's left (screen-right): wide; b = squint
      wideEye(g, L, a.x, L.ey - L.eh * 0.08, L.ew * 0.9, 0.36, 0.2, -0.3, o);
      dotEye(g, L, b.x, L.ey + L.eh * 0.12, 1.05, 0.4, o, false);
      brow(g, L, a.side, a.x, 0.9, 12, { arch: 0.016, thick: 1.1 });
      brow(g, L, b.side, b.x, -0.25, -18, { thick: 1.1 });
    },
    mouth(g, L) { squiggle(g, L, L.mw * 0.95, -0.03 * L.S, 0.014 * L.S, 0.012 * L.S); },
  },
  love_eyes: {
    blinks: false, talk: { bias: 0.9, scale: 1 }, emoteVfxId: 'emote_hearts',
    upper(g, L) {
      each(L, (x) => heart(g, x, L.ey, L.ew * 2.1, HEART, mix(HEART, '#000000', 0.45), L.lw * 0.55));
      each(L, (x, side) => brow(g, L, side, x, 0.55, 10, { arch: 0.012 }));
    },
    mouth(g, L) { grinD(g, L, L.mw * 1.35, 0.1 * L.S, 0.03 * L.S, { tongue: 1, teeth: 0.3 }); },
    extras(g, L) { blush(g, L, '#ff4f8b', 0.6); },
  },
};

export const FACE_SET_V2_IDS = Object.keys(FACE_SET_V2);
