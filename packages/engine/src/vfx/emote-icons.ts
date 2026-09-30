// Emote icons (S7): original vector drawings on Canvas2D. No fonts, no images, no randomness: the same symbol always
// draws the same pixels. Each icon is a 256x256 RGBA texture with transparent background, used on billboards above or
// beside a character's head (see emote-layer.ts).
import type { TextureSource } from '../gl/scene.ts';

export const EMOTE_SYMBOLS = ['exclaim', 'question', 'sweat', 'anger', 'hearts', 'tears', 'dots'] as const;
export type EmoteSymbol = (typeof EMOTE_SYMBOLS)[number];
/** legacy single-character symbols from the engine `emote` VFX (params.symbol) */
export const LEGACY_EMOTE_SYMBOL: Readonly<Record<string, EmoteSymbol>> = Object.freeze({ '!': 'exclaim', '?': 'question', '...': 'dots' });
export const emoteSymbol = (s: string): EmoteSymbol => (EMOTE_SYMBOLS as readonly string[]).includes(s) ? (s as EmoteSymbol) : LEGACY_EMOTE_SYMBOL[s] ?? 'exclaim';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
const SIZE = 256;
const INK = '#161a24';

function canvas(): { c: HTMLCanvasElement | OffscreenCanvas; g: Ctx } {
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(SIZE, SIZE) : Object.assign(document.createElement('canvas'), { width: SIZE, height: SIZE });
  const g = c.getContext('2d') as Ctx;
  g.lineJoin = 'round'; g.lineCap = 'round';
  return { c, g };
}

/** round speech bubble with a tail at the lower left, thick ink outline */
function bubble(g: Ctx, fill: string): void {
  const path = () => {
    g.beginPath();
    g.arc(128, 116, 92, Math.PI * 0.72, Math.PI * 0.62 + Math.PI * 2 - 0.02);
    g.lineTo(58, 236); g.closePath();
  };
  path(); g.lineWidth = 22; g.strokeStyle = INK; g.stroke();
  path(); g.fillStyle = fill; g.fill();
  g.beginPath(); g.ellipse(96, 72, 26, 14, -0.6, 0, Math.PI * 2); g.fillStyle = 'rgba(255,255,255,0.55)'; g.fill();
}

function exclaim(g: Ctx): void {
  bubble(g, '#ffffff');
  g.fillStyle = '#e8322b'; g.strokeStyle = INK; g.lineWidth = 8;
  g.beginPath(); g.moveTo(108, 44); g.lineTo(148, 44); g.lineTo(138, 138); g.lineTo(118, 138); g.closePath(); g.fill(); g.stroke();
  g.beginPath(); g.arc(128, 170, 17, 0, Math.PI * 2); g.fill(); g.stroke();
}

function question(g: Ctx): void {
  bubble(g, '#ffffff');
  g.strokeStyle = INK; g.lineWidth = 38;
  const q = () => { g.beginPath(); g.arc(128, 86, 34, Math.PI * 1.05, Math.PI * 0.45); g.quadraticCurveTo(128, 124, 128, 142); g.stroke(); };
  q(); g.strokeStyle = '#1f6ff2'; g.lineWidth = 22; q();
  g.fillStyle = '#1f6ff2'; g.lineWidth = 8; g.strokeStyle = INK;
  g.beginPath(); g.arc(128, 178, 15, 0, Math.PI * 2); g.fill(); g.stroke();
}

function drop(g: Ctx, x: number, y: number, s: number, fill: string): void {
  g.beginPath();
  g.moveTo(x, y - 60 * s);
  g.bezierCurveTo(x + 10 * s, y - 30 * s, x + 42 * s, y - 6 * s, x + 42 * s, y + 22 * s);
  g.arc(x, y + 22 * s, 42 * s, 0, Math.PI);
  g.bezierCurveTo(x - 42 * s, y - 6 * s, x - 10 * s, y - 30 * s, x, y - 60 * s);
  g.closePath();
  g.lineWidth = 12 * Math.max(0.6, s); g.strokeStyle = INK; g.stroke();
  g.fillStyle = fill; g.fill();
  g.beginPath(); g.ellipse(x - 16 * s, y + 12 * s, 9 * s, 16 * s, 0.3, 0, Math.PI * 2); g.fillStyle = 'rgba(255,255,255,0.8)'; g.fill();
}

function sweat(g: Ctx): void { drop(g, 128, 120, 1.55, '#7fd3ff'); }

function tears(g: Ctx): void {
  // two falling tear streams with drops, reads as "crying" beside the face
  for (const [x, s] of [[86, 1], [170, 0.82]] as const) {
    g.strokeStyle = INK; g.lineWidth = 34; g.beginPath(); g.moveTo(x, 20); g.lineTo(x, 132 - 30 * (1 - s)); g.stroke();
    g.strokeStyle = '#5cc2ff'; g.lineWidth = 20; g.beginPath(); g.moveTo(x, 20); g.lineTo(x, 132 - 30 * (1 - s)); g.stroke();
    drop(g, x, 176 - 30 * (1 - s), 0.85 * s, '#5cc2ff');
  }
}

function anger(g: Ctx): void {
  // manga-style "vein" mark: four bulging arcs around a centre, red with ink outline
  g.translate(128, 128);
  const arm = () => { g.beginPath(); g.moveTo(-18, -86); g.quadraticCurveTo(-24, -24, -86, -18); g.moveTo(18, -86); g.quadraticCurveTo(24, -24, 86, -18); };
  for (const [w, col] of [[44, INK], [26, '#ff3b30']] as const) {
    g.lineWidth = w; g.strokeStyle = col;
    for (let k = 0; k < 2; k++) { g.save(); g.rotate(k * Math.PI); arm(); g.stroke(); g.restore(); }
  }
  g.setTransform(1, 0, 0, 1, 0, 0);
}

function heart(g: Ctx, x: number, y: number, s: number, fill: string): void {
  const path = () => {
    g.beginPath();
    g.moveTo(x, y + 70 * s);
    g.bezierCurveTo(x - 110 * s, y + 4 * s, x - 70 * s, y - 88 * s, x, y - 34 * s);
    g.bezierCurveTo(x + 70 * s, y - 88 * s, x + 110 * s, y + 4 * s, x, y + 70 * s);
    g.closePath();
  };
  path(); g.lineWidth = 20 * s; g.strokeStyle = INK; g.stroke();
  path(); g.fillStyle = fill; g.fill();
  g.beginPath(); g.ellipse(x - 34 * s, y - 26 * s, 16 * s, 10 * s, -0.7, 0, Math.PI * 2); g.fillStyle = 'rgba(255,255,255,0.75)'; g.fill();
}
function hearts(g: Ctx): void { heart(g, 128, 124, 1.35, '#ff3d7f'); }

function dots(g: Ctx): void {
  bubble(g, '#ffffff');
  g.fillStyle = '#555a66';
  for (const x of [84, 128, 172]) { g.beginPath(); g.arc(x, 118, 15, 0, Math.PI * 2); g.fill(); }
}

const DRAW: Record<EmoteSymbol, (g: Ctx) => void> = { exclaim, question, sweat, anger, hearts, tears, dots };

const cache = new Map<string, TextureSource>();
/** emote icon texture (cached per symbol; accepts legacy '!', '?', '...') */
export function emoteTexture(symbol: string): TextureSource {
  const s = emoteSymbol(symbol), key = `s7_emote_${s}`;
  let t = cache.get(key);
  if (!t) { const { c, g } = canvas(); DRAW[s](g); t = { key, canvas: c }; cache.set(key, t); }
  return t;
}
/** draw an emote icon into any 2D context (stills, UI previews): centred at (x, y), `size` px wide */
export function drawEmoteIcon(g: Ctx, symbol: string, x: number, y: number, size: number): void {
  const tex = emoteTexture(symbol);
  g.drawImage(tex.canvas as CanvasImageSource, x - size / 2, y - size / 2, size, size);
}
