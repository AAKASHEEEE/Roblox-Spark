// Procedural screen and label textures for props (Canvas2D, deterministic, original artwork: no logos, no real UI).
// In node (no OffscreenCanvas / document) makeCanvas() returns null and callers skip the texture; pose logic never
// depends on textures.
import type { TextureSource } from '../gl/scene.ts';
import { blockTextWidth, drawBlockText, wrapWords } from './font.ts';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type Cnv = HTMLCanvasElement | OffscreenCanvas;

function makeCanvas(w: number, h: number): { c: Cnv; g: Ctx } | null {
  const G = globalThis as unknown as { OffscreenCanvas?: typeof OffscreenCanvas; document?: Document };
  let c: Cnv | null = null;
  if (typeof G.OffscreenCanvas !== 'undefined') c = new G.OffscreenCanvas(w, h);
  else if (G.document) c = Object.assign(G.document.createElement('canvas'), { width: w, height: h });
  if (!c) return null;
  const g = c.getContext('2d') as Ctx | null;
  return g && typeof (g as { fillRect?: unknown }).fillRect === 'function' ? { c, g } : null;
}

const centered = (g: Ctx, text: string, cx: number, y: number, px: number, color: string) => drawBlockText(g, text, cx - blockTextWidth(text, px) / 2, y, px, color);
const rect = (g: Ctx, x: number, y: number, w: number, h: number, color: string) => { g.fillStyle = color; g.fillRect(x, y, w, h); };

const painters: Record<string, (g: Ctx, w: number, h: number, text?: string) => void> = {
  phone(g, w, h) {
    rect(g, 0, 0, w, h, '#2a6fdb');
    rect(g, 0, 0, w, 34, '#153a7a');
    centered(g, '12:30', w / 2, 70, 7, '#ffffff');
    const cols = ['#ffd21a', '#39b56a', '#e8322b', '#ff7a1a', '#9b5de5', '#20c3d0', '#f4f4f2', '#ff6fa8', '#8bd346', '#ffb020', '#5a8dee', '#f15bb5'];
    for (let i = 0; i < 12; i++) { const cx = 28 + (i % 3) * 72, cy = 150 + Math.floor(i / 3) * 72; rect(g, cx, cy, 56, 56, cols[i]); rect(g, cx + 14, cy + 14, 28, 28, 'rgba(255,255,255,0.35)'); }
    rect(g, 16, h - 76, w - 32, 60, 'rgba(10,20,50,0.45)');
    for (let i = 0; i < 3; i++) rect(g, 40 + i * 64, h - 66, 40, 40, ['#39b56a', '#e8322b', '#ffd21a'][i]);
  },
  laptop(g, w, h) {
    rect(g, 0, 0, w, h, '#1fa3a3');
    rect(g, 0, h - 28, w, 28, '#1c1c20');
    rect(g, 8, h - 22, 16, 16, '#ffd21a');
    rect(g, 60, 36, w - 120, h - 100, '#f4f4f2');
    rect(g, 60, 36, w - 120, 26, '#3f7fd9');
    for (const [i, c] of ['#e8322b', '#ffd21a', '#39b56a'].entries()) rect(g, w - 84 + i * 8, 44, 6, 10, c);
    drawBlockText(g, 'HOMEWORK', 76, 80, 5, '#1c1c20');
    for (let i = 0; i < 5; i++) rect(g, 76, 130 + i * 22, (w - 180) * (0.55 + 0.4 * ((i * 37) % 10) / 10), 10, '#9aa3ad');
  },
  tv(g, w, h) {
    rect(g, 0, 0, w, h, '#5ec2ff');
    g.fillStyle = '#ffe14d'; g.beginPath(); g.arc(w * 0.8, h * 0.22, h * 0.11, 0, Math.PI * 2); g.fill();
    rect(g, w * 0.12, h * 0.16, w * 0.16, h * 0.06, '#ffffff'); rect(g, w * 0.16, h * 0.11, w * 0.08, h * 0.06, '#ffffff');
    g.fillStyle = '#4cc36a'; g.beginPath(); g.ellipse(w * 0.25, h * 0.95, w * 0.45, h * 0.4, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#2f9e52'; g.beginPath(); g.ellipse(w * 0.85, h * 1.0, w * 0.4, h * 0.36, 0, 0, Math.PI * 2); g.fill();
    // a small blocky figure (generic, not any existing character)
    const fx = w * 0.52, fy = h * 0.5;
    rect(g, fx, fy, 34, 34, '#ffd21a'); rect(g, fx - 4, fy + 36, 42, 44, '#e8322b'); rect(g, fx, fy + 80, 14, 40, '#2b2f36'); rect(g, fx + 20, fy + 80, 14, 40, '#2b2f36');
    rect(g, fx + 8, fy + 10, 5, 7, '#1c1c20'); rect(g, fx + 21, fy + 10, 5, 7, '#1c1c20');
    rect(g, 16, 14, 84, 30, '#e8322b'); drawBlockText(g, 'LIVE', 24, 21, 3, '#ffffff');
  },
  ban(g, w, h) {
    rect(g, 0, 0, w, h, '#e8322b');
    rect(g, 12, 12, w - 24, h - 24, '#ffffff');
    const px = Math.floor(Math.min((w - 60) / blockTextWidth('BAN', 1), (h - 60) / 7));
    centered(g, 'BAN', w / 2, (h - 7 * px) / 2, px, '#e8322b');
  },
  sign(g, w, h, text = 'NOTICE') {
    rect(g, 0, 0, w, h, '#f4efe2');
    rect(g, 10, 10, w - 20, 8, '#c8312b'); rect(g, 10, h - 18, w - 20, 8, '#c8312b');
    // largest block size at which the whole text fits in at most 3 lines
    let best: { lines: string[]; px: number } = { lines: [], px: 0 };
    for (let maxChars = Math.max(1, text.length); maxChars >= 1; maxChars--) {
      const lines = wrapWords(text, maxChars, 99);
      if (lines.length > 3) break;
      const longest = Math.max(1, ...lines.map((l) => l.length));
      const px = Math.floor(Math.min((w - 80) / blockTextWidth('X'.repeat(longest), 1), (h - 80) / (lines.length * 9)));
      if (px > best.px) best = { lines, px };
    }
    const lh = best.px * 9, y0 = (h - best.lines.length * lh + 2 * best.px) / 2;
    best.lines.forEach((l, i) => centered(g, l, w / 2, y0 + i * lh, best.px, '#1c1c20'));
  },
};
export const PAINTERS = Object.keys(painters);

const SIZES: Record<string, [number, number]> = { phone: [256, 512], laptop: [512, 320], tv: [640, 360], ban: [512, 240], sign: [1024, 540] };
const cache = new Map<string, TextureSource | null>();
/** texture for a painter (sign takes its text); null where no canvas exists (node) */
export function propTexture(painter: string, text?: string): TextureSource | null {
  const key = `prop_${painter}${text !== undefined ? ':' + text.toUpperCase() : ''}`;
  if (cache.has(key)) return cache.get(key)!;
  const p = painters[painter];
  if (!p) throw new Error(`unknown prop painter "${painter}"`);
  const [w, h] = SIZES[painter];
  const cv = makeCanvas(w, h);
  let t: TextureSource | null = null;
  if (cv) { p(cv.g, w, h, text); t = { key, canvas: cv.c }; }
  cache.set(key, t);
  return t;
}
