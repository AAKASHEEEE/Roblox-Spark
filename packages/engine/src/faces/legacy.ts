// Face set v1: expression decals rendered from the LOCKED face states in a character manifest (face.states).
// The episode can only pick a named state; it can never alter the face geometry/colours.
// Moved verbatim from engine/src/faces.ts; the only addition is `mouth: false` (eyes + brows only), used when a
// talking mouth shape replaces the state's mouth. With the default options the pixels are unchanged.
import type { CharacterManifest } from '../../../schema/src/assets.ts';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
const S = 256;
export const LEGACY_FACE_SIZE = S;

export function drawLegacyFace(g: Ctx, ch: CharacterManifest, stateName: string, blink: number, opts: { mouth?: boolean } = {}): void {
  drawFace(g, ch, stateName, blink, opts.mouth !== false);
}

function drawFace(g: Ctx, ch: CharacterManifest, stateName: string, blink: number, withMouth = true): void {
  const f = ch.face;
  const st = f.states[stateName];
  if (!st) throw new Error(`${ch.id} has no face state "${stateName}"`);
  g.clearRect(0, 0, S, S);
  g.lineCap = 'round'; g.lineJoin = 'round';
  const ey = f.eyeY * S;
  const ew = f.eyeW * S, eh = f.eyeH * S;
  // character's LEFT eye is on screen-right when facing camera
  const eyes: Array<{ x: number; side: 'L' | 'R' }> = [
    { x: S * (0.5 + f.eyeSpacing / 2), side: 'L' },
    { x: S * (0.5 - f.eyeSpacing / 2), side: 'R' },
  ];
  const canBlink = st.eyes === 'oval' || st.eyes === 'narrow' || st.eyes === 'half_lid' || st.eyes === 'side_glance';
  const open = canBlink ? 1 - blink : 1;
  for (const e of eyes) {
    g.fillStyle = f.eyeColor;
    const inward = e.side === 'L' ? -1 : 1;
    switch (st.eyes) {
      case 'oval':
      case 'side_glance': {
        const dx = st.eyes === 'side_glance' ? 0.03 * S : 0;
        if (open < 0.2) { line(g, e.x - ew * 0.55, ey, e.x + ew * 0.55, ey, 0.03 * S, f.eyeColor); break; }
        g.beginPath(); g.ellipse(e.x + dx, ey, ew / 2, (eh / 2) * open, 0, 0, Math.PI * 2); g.fill();
        g.fillStyle = 'rgba(255,255,255,0.9)'; g.beginPath(); g.arc(e.x + dx - ew * 0.14, ey - eh * 0.2 * open, ew * 0.14, 0, Math.PI * 2); g.fill();
        break;
      }
      case 'circle_wide': {
        g.fillStyle = '#ffffff'; g.beginPath(); g.arc(e.x, ey - 0.01 * S, ew * 0.95, 0, Math.PI * 2); g.fill();
        g.strokeStyle = f.eyeColor; g.lineWidth = 0.018 * S; g.stroke();
        g.fillStyle = f.eyeColor; g.beginPath(); g.arc(e.x, ey - 0.01 * S, ew * 0.32, 0, Math.PI * 2); g.fill();
        break;
      }
      case 'squeeze': {
        g.strokeStyle = f.eyeColor; g.lineWidth = 0.035 * S;
        g.beginPath();
        g.moveTo(e.x + inward * -ew * 0.55, ey - eh * 0.28); g.lineTo(e.x + inward * ew * 0.35, ey); g.lineTo(e.x + inward * -ew * 0.55, ey + eh * 0.28);
        g.stroke();
        break;
      }
      case 'half_lid': {
        if (open < 0.2) { line(g, e.x - ew * 0.55, ey, e.x + ew * 0.55, ey, 0.03 * S, f.eyeColor); break; }
        g.save(); g.beginPath(); g.rect(e.x - ew, ey - eh * 0.05, ew * 2, eh); g.clip();
        g.beginPath(); g.ellipse(e.x, ey, ew / 2, (eh / 2) * open, 0, 0, Math.PI * 2); g.fill(); g.restore();
        line(g, e.x - ew * 0.62, ey - eh * 0.05, e.x + ew * 0.62, ey - eh * 0.05, 0.028 * S, f.eyeColor);
        break;
      }
      case 'narrow': {
        if (open < 0.2) { line(g, e.x - ew * 0.55, ey, e.x + ew * 0.55, ey, 0.03 * S, f.eyeColor); break; }
        g.beginPath(); g.ellipse(e.x, ey + eh * 0.08, ew / 2, eh * 0.26 * open, 0, 0, Math.PI * 2); g.fill();
        break;
      }
    }
    // brows: [raise, angleDeg]; positive angle raises the INNER end (worried), negative lowers it (determined/angry)
    const [raise, ang] = e.side === 'L' ? st.browL : st.browR;
    const bw = f.browWidth * S, bt = f.browThickness * S;
    const by = ey - eh * 0.5 - 0.075 * S - raise * 0.09 * S;
    const a = (ang * Math.PI) / 180 * (e.side === 'L' ? 1 : -1);
    g.save(); g.translate(e.x, by); g.rotate(a);
    g.fillStyle = f.browColor; roundRect(g, -bw / 2, -bt / 2, bw, bt, bt / 2); g.fill();
    g.restore();
  }
  if (!withMouth) return;
  // mouth
  const my = f.mouthY * S, mw = f.mouthW * S;
  const mx = S / 2;
  const lw = 0.03 * S;
  g.strokeStyle = f.mouthColor; g.fillStyle = f.mouthColor; g.lineWidth = lw;
  switch (st.mouth) {
    case 'half_smile':
      g.beginPath(); g.moveTo(mx - mw * 0.45, my - 0.005 * S); g.quadraticCurveTo(mx, my + 0.03 * S, mx + mw * 0.5, my - 0.035 * S); g.stroke(); break;
    case 'flat':
      line(g, mx - mw * 0.4, my, mx + mw * 0.4, my, lw, f.mouthColor); break;
    case 'tight':
      g.beginPath(); g.moveTo(mx - mw * 0.2, my + 0.004 * S); g.quadraticCurveTo(mx + mw * 0.05, my - 0.008 * S, mx + mw * 0.22, my + 0.006 * S); g.stroke(); break;
    case 'o':
      g.beginPath(); g.ellipse(mx, my + 0.01 * S, mw * 0.2, mw * 0.27, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#c4474a'; g.beginPath(); g.ellipse(mx, my + 0.045 * S, mw * 0.12, mw * 0.08, 0, 0, Math.PI * 2); g.fill(); break;
    case 'smug':
      g.beginPath(); g.moveTo(mx - mw * 0.35, my + 0.01 * S); g.quadraticCurveTo(mx + mw * 0.1, my + 0.02 * S, mx + mw * 0.45, my - 0.04 * S); g.stroke(); break;
    case 'grin':
      g.beginPath(); g.moveTo(mx - mw * 0.5, my - 0.02 * S); g.quadraticCurveTo(mx, my + 0.07 * S, mx + mw * 0.5, my - 0.02 * S); g.stroke(); break;
    case 'open_grin':
      g.beginPath(); g.moveTo(mx - mw * 0.55, my - 0.03 * S); g.quadraticCurveTo(mx, my - 0.01 * S, mx + mw * 0.55, my - 0.03 * S);
      g.quadraticCurveTo(mx, my + 0.16 * S, mx - mw * 0.55, my - 0.03 * S); g.fill();
      g.fillStyle = '#ffffff'; g.fillRect(mx - mw * 0.4, my - 0.022 * S, mw * 0.8, 0.02 * S);
      g.fillStyle = '#d0575a'; g.beginPath(); g.ellipse(mx, my + 0.06 * S, mw * 0.2, 0.025 * S, 0, 0, Math.PI * 2); g.fill(); break;
    case 'frown':
      g.beginPath(); g.moveTo(mx - mw * 0.4, my + 0.02 * S); g.quadraticCurveTo(mx, my - 0.04 * S, mx + mw * 0.4, my + 0.02 * S); g.stroke(); break;
    case 'wobbly':
      g.beginPath(); g.moveTo(mx - mw * 0.45, my);
      for (let i = 1; i <= 6; i++) g.lineTo(mx - mw * 0.45 + (i * mw * 0.9) / 6, my + (i % 2 ? -1 : 1) * 0.012 * S);
      g.stroke(); break;
  }
}

function line(g: Ctx, x1: number, y1: number, x2: number, y2: number, w: number, c: string): void {
  g.strokeStyle = c; g.lineWidth = w; g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
}
function roundRect(g: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath(); g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.arcTo(x + w, y, x + w, y + r, r); g.lineTo(x + w, y + h - r);
  g.arcTo(x + w, y + h, x + w - r, y + h, r); g.lineTo(x + r, y + h); g.arcTo(x, y + h, x, y + h - r, r); g.lineTo(x, y + r); g.arcTo(x, y, x + r, y, r); g.closePath();
}
