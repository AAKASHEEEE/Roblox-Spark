// Mouth drawing for face set v2: the four talking shapes S5 drives (closed / open / wide / o) and the expression mouths.
// Talking shapes take the expression's flavour through `bias` (-1 frown .. 1 smile) and `scale`, so a furious line
// reads angry and a laughing line reads happy while the lips move.
import { type Ctx, type Layout, line, ellipse, TEETH, TONGUE, THROAT } from './design.ts';

/** talking mouth shapes (visemes). `closed` = lips together (M/B/P and pauses), `open` = A/ah, `wide` = E/ee, `o` = O/oo/W */
export const MOUTH_SHAPES = ['closed', 'open', 'wide', 'o'] as const;
export type MouthShape = (typeof MOUTH_SHAPES)[number];
export const isMouthShape = (s: unknown): s is MouthShape => typeof s === 'string' && (MOUTH_SHAPES as readonly string[]).includes(s);

export interface TalkStyle {
  /** -1 frown .. 1 smile: bends the corners of every talking shape */
  bias: number;
  /** size multiplier (a scream talks bigger than a sulk) */
  scale: number;
}

/** closed lens path: corners lifted by `lift`, top edge dips to y+top, bottom edge sags to y+bottom */
function lens(g: Ctx, x: number, y: number, w: number, lift: number, top: number, bottom: number): void {
  const xl = x - w / 2, xr = x + w / 2, yc = y - lift;
  g.beginPath(); g.moveTo(xl, yc); g.quadraticCurveTo(x, y + top, xr, yc); g.quadraticCurveTo(x, y + bottom, xl, yc); g.closePath();
}

interface Fill { teethTop?: number; teethBottom?: number; tongue?: number; dividers?: number; uvula?: boolean }
/** fill the current path as an open mouth, then paint teeth/tongue clipped to it */
function openMouth(g: Ctx, L: Layout, x: number, yTop: number, yBot: number, w: number, f: Fill): void {
  g.fillStyle = L.d.mouthColor; g.fill('nonzero');
  g.save(); g.clip();
  const h = yBot - yTop;
  if (f.uvula) ellipse(g, x, yTop + h * 0.12, w * 0.05, h * 0.12, THROAT);
  if (f.tongue) ellipse(g, x + w * 0.04, yBot - h * 0.05, w * 0.3 * f.tongue, h * 0.34 * f.tongue, TONGUE);
  g.fillStyle = TEETH;
  if (f.teethTop) g.fillRect(x - w, yTop - h, w * 2, h + h * f.teethTop);
  if (f.teethBottom) g.fillRect(x - w, yBot - h * f.teethBottom, w * 2, h * 2);
  if (f.dividers && f.teethTop) for (let i = 1; i < f.dividers; i++) { const tx = x - w / 2 + (w * i) / f.dividers; line(g, tx, yTop - h, tx, yTop + h * f.teethTop, L.lw * 0.35, L.d.mouthColor); }
  g.restore();
}

// ---------------------------------------------------------------- talking shapes

export function drawTalk(g: Ctx, L: Layout, shape: MouthShape, style: TalkStyle, amount = 1): void {
  const { S, mx, my } = L;
  const sc = style.scale, b = Math.max(-1, Math.min(1, style.bias));
  const lift = b * 0.03 * S;
  g.lineCap = 'round'; g.lineJoin = 'round';
  switch (shape) {
    case 'closed': {
      const w = L.mw * 1.15 * sc;
      g.strokeStyle = L.d.mouthColor; g.lineWidth = L.lw * 1.4;
      g.beginPath(); g.moveTo(mx - w / 2, my - lift); g.quadraticCurveTo(mx, my + lift * 0.9, mx + w / 2, my - lift); g.stroke();
      break;
    }
    case 'open': {
      const w = L.mw * 1.4 * sc, h = Math.max(0.045, 0.16 * Math.max(0, Math.min(1, amount))) * S * sc;
      lens(g, mx, my, w, lift, -0.012 * S, h * 1.9);
      openMouth(g, L, mx, my - 0.012 * S, my + h, w, { teethTop: 0.26, tongue: amount > 0.5 ? 1 : 0.8 });
      break;
    }
    case 'wide': {
      const w = L.mw * 1.7 * sc, h = 0.085 * S * sc;
      lens(g, mx, my, w, lift * 1.2, -h * 0.55, h * 1.35);
      openMouth(g, L, mx, my - h * 0.3, my + h * 0.7, w, { teethTop: 0.42, teethBottom: 0.3 });
      break;
    }
    case 'o': {
      const rx = L.mw * 0.38 * sc, ry = L.mw * 0.52 * sc;
      g.beginPath(); g.ellipse(mx, my + ry * 0.35, rx, ry, 0, 0, Math.PI * 2);
      openMouth(g, L, mx, my + ry * 0.35 - ry, my + ry * 0.35 + ry, rx * 2, { tongue: 0.75 });
      break;
    }
  }
}

// ---------------------------------------------------------------- expression mouths

/** big D grin: flat-ish top with a full row of teeth, deep bottom */
export function grinD(g: Ctx, L: Layout, w: number, depth: number, lift: number, opts: { tongue?: number; teeth?: number; dx?: number } = {}): void {
  const x = L.mx + (opts.dx ?? 0);
  lens(g, x, L.my, w, lift, 0.004 * L.S, depth * 1.9);
  openMouth(g, L, x, L.my - lift * 0.6, L.my + depth, w, { teethTop: opts.teeth ?? 0.34, tongue: opts.tongue ?? 0.8, dividers: 6 });
}

/** tall laughing mouth */
export function laughOpen(g: Ctx, L: Layout, w: number, h: number): void {
  lens(g, L.mx, L.my, w, 0.03 * L.S, -0.012 * L.S, h * 1.9);
  openMouth(g, L, L.mx, L.my - 0.02 * L.S, L.my + h, w, { teethTop: 0.2, tongue: 1.25, uvula: true });
}

/** clenched teeth grimace; `down` pulls the corners down (angry) or `wobble` makes the outline shake (scared) */
export function clench(g: Ctx, L: Layout, w: number, h: number, opts: { down?: number; wobble?: number } = {}): void {
  const x = L.mx, y = L.my, dn = (opts.down ?? 0) * L.S, wob = (opts.wobble ?? 0) * L.S;
  const steps = 8;
  // top edge left -> right, bottom edge right -> left; traced twice (fill/clip, then outline after the dividers).
  // No Path2D: the node headless engine stubs 2D contexts and has no Path2D.
  const trace = () => {
  g.beginPath();
  for (let i = 0; i <= steps; i++) { const u = i / steps; const px = x - w / 2 + w * u; const arc = Math.sin(Math.PI * u); g[i ? 'lineTo' : 'moveTo'](px, y - h / 2 + dn * (1 - arc) * 0.6 - dn * arc * 0.15 + (i % 2 ? -wob : wob)); }
  for (let i = steps; i >= 0; i--) { const u = i / steps; const px = x - w / 2 + w * u; const arc = Math.sin(Math.PI * u); g.lineTo(px, y + h / 2 + dn * (1 - arc) * 0.9 + (i % 2 ? wob : -wob)); }
  g.closePath();
  };
  trace();
  g.fillStyle = TEETH; g.fill();
  g.save(); g.clip();
  line(g, x - w, y + dn * 0.3, x + w, y + dn * 0.3, L.lw * 0.55, L.d.mouthColor);
  for (let i = 1; i < 6; i++) { const tx = x - w / 2 + (w * i) / 6; line(g, tx, y - h, tx, y + h + Math.abs(dn), L.lw * 0.4, L.d.mouthColor); }
  g.restore();
  g.strokeStyle = L.d.mouthColor; g.lineWidth = L.lw * 1.0; g.lineJoin = 'round'; trace(); g.stroke();
}

/** huge scream oval with uvula, teeth and tongue */
export function screamOval(g: Ctx, L: Layout, w: number, h: number): void {
  const cy = L.my + h * 0.3;
  g.beginPath(); g.ellipse(L.mx, cy, w / 2, h / 2, 0, 0, Math.PI * 2);
  openMouth(g, L, L.mx, cy - h / 2, cy + h / 2, w, { teethTop: 0.12, teethBottom: 0.08, tongue: 1.1, uvula: true });
}

/** dropped-jaw O (shock) */
export function dropO(g: Ctx, L: Layout, w: number, h: number): void {
  const cy = L.my + h * 0.28;
  g.beginPath(); g.ellipse(L.mx, cy, w / 2, h / 2, 0, 0, Math.PI * 2);
  openMouth(g, L, L.mx, cy - h / 2, cy + h / 2, w, { tongue: 0.9 });
}

/** frown arc (curve > 0 = sadder) */
export function frown(g: Ctx, L: Layout, w: number, curve: number, dx = 0, tilt = 0): void {
  const x = L.mx + dx;
  g.strokeStyle = L.d.mouthColor; g.lineWidth = L.lw * 1.2; g.lineCap = 'round';
  g.beginPath(); g.moveTo(x - w / 2, L.my + curve * 0.5 + tilt); g.quadraticCurveTo(x, L.my - curve * 1.1, x + w / 2, L.my + curve * 0.5 - tilt); g.stroke();
}

/** wailing mouth: open, frowning corners, wobbly top lip */
export function wail(g: Ctx, L: Layout, w: number, h: number): void {
  const x = L.mx, y = L.my, S = L.S;
  const xl = x - w / 2, xr = x + w / 2;
  g.beginPath(); g.moveTo(xl, y + 0.035 * S);
  g.bezierCurveTo(x - w * 0.25, y - 0.03 * S, x + w * 0.25, y - 0.03 * S, xr, y + 0.035 * S);
  g.bezierCurveTo(x + w * 0.3, y + h * 1.25, x - w * 0.3, y + h * 1.25, xl, y + 0.035 * S);
  g.closePath();
  openMouth(g, L, x, y - 0.02 * S, y + h, w, { teethTop: 0.14, tongue: 1.1 });
}

/** tight flat line pushed to one side and tilted (suspicion, doubt) */
export function sideLine(g: Ctx, L: Layout, w: number, dx: number, tilt: number): void {
  line(g, L.mx + dx - w / 2, L.my + tilt, L.mx + dx + w / 2, L.my - tilt, L.lw * 1.15, L.d.mouthColor);
}

/** sinister crescent: very curved, thin, full of teeth, one corner higher */
export function crescent(g: Ctx, L: Layout, w: number, depth: number, skew: number): void {
  const x = L.mx, y = L.my, S = L.S;
  const xl = x - w / 2, xr = x + w / 2;
  g.beginPath(); g.moveTo(xl, y - 0.05 * S + skew); g.quadraticCurveTo(x, y + depth * 0.55, xr, y - 0.05 * S - skew);
  g.quadraticCurveTo(x, y + depth * 1.45, xl, y - 0.05 * S + skew); g.closePath();
  openMouth(g, L, x, y + depth * 0.2, y + depth, w, { teethTop: 0.55, dividers: 8 });
}

/** squiggly confused line */
export function squiggle(g: Ctx, L: Layout, w: number, dx: number, amp: number, tilt: number): void {
  g.strokeStyle = L.d.mouthColor; g.lineWidth = L.lw * 1.1; g.lineCap = 'round'; g.lineJoin = 'round';
  g.beginPath();
  const n = 5;
  for (let i = 0; i <= n; i++) { const u = i / n; const px = L.mx + dx - w / 2 + w * u; const py = L.my + (i % 2 ? -amp : amp) * (i === 0 || i === n ? 0.3 : 1) + tilt * (1 - 2 * u); g[i ? 'lineTo' : 'moveTo'](px, py); }
  g.stroke();
}

/** small yawning O */
export function yawn(g: Ctx, L: Layout, rx: number, ry: number, dx = 0): void {
  g.beginPath(); g.ellipse(L.mx + dx, L.my + ry * 0.4, rx, ry, 0, 0, Math.PI * 2);
  openMouth(g, L, L.mx + dx, L.my + ry * 0.4 - ry, L.my + ry * 1.4, rx * 2, { tongue: 0.7 });
}
