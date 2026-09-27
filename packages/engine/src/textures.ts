// Procedural, deterministic textures (Canvas2D, no system fonts, no images).
import type { TextureSource } from './gl/scene.ts';
import { rng } from './math.ts';

// 5x7 in-house block font. '#' = on.
const GLYPHS: Record<string, string[]> = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.####', '#....', '#....', '#....', '#....', '#....', '.####'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.####', '#....', '#....', '#.###', '#...#', '#...#', '.###.'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '#####'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['####.', '....#', '....#', '.###.', '....#', '....#', '####.'],
  '!': ['..#..', '..#..', '..#..', '..#..', '..#..', '.....', '..#..'],
  '?': ['.###.', '#...#', '....#', '...#.', '..#..', '.....', '..#..'],
  '+': ['.....', '..#..', '..#..', '#####', '..#..', '..#..', '.....'],
  '=': ['.....', '.....', '#####', '.....', '#####', '.....', '.....'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
};

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function drawText(g: Ctx, text: string, x: number, y: number, px: number, color: string, gap = 1): number {
  g.fillStyle = color;
  let cx = x;
  for (const ch of text.toUpperCase()) {
    const gl = GLYPHS[ch] ?? GLYPHS['?'];
    for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++) if (gl[r][c] === '#') g.fillRect(cx + c * px, y + r * px, px, px);
    cx += (5 + gap) * px;
  }
  return cx - x - gap * px;
}
export const textWidth = (text: string, px: number, gap = 1): number => text.length * (5 + gap) * px - gap * px;

function mk(w: number, h: number): { c: HTMLCanvasElement | OffscreenCanvas; g: Ctx } {
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const g = c.getContext('2d') as Ctx;
  return { c, g };
}

function lightningPath(g: Ctx, x: number, y: number, s: number): void {
  const P = [[0.58, 0], [0.18, 0.55], [0.46, 0.55], [0.32, 1], [0.82, 0.38], [0.52, 0.38], [0.7, 0]];
  g.beginPath();
  P.forEach(([px, py], i) => (i ? g.lineTo(x + px * s, y + py * s) : g.moveTo(x + px * s, y + py * s)));
  g.closePath();
}

const builders: Record<string, (variant?: string) => { c: HTMLCanvasElement | OffscreenCanvas }> = {
  label_free_coins: (variant) => {
    const { c, g } = mk(512, 120);
    const on = variant !== 'dim';
    g.fillStyle = '#ffd21a'; g.fillRect(0, 0, 512, 120);
    for (let i = -2; i < 22; i++) { g.fillStyle = '#1c1c20'; g.beginPath(); g.moveTo(i * 28, 0); g.lineTo(i * 28 + 14, 0); g.lineTo(i * 28 - 16, 120); g.lineTo(i * 28 - 30, 120); g.fill(); }
    g.fillStyle = '#141418'; g.fillRect(14, 14, 484, 92);
    const px = 9, w = textWidth('FREE COINS', px);
    drawText(g, 'FREE COINS', (512 - w) / 2, (120 - 7 * px) / 2, px, on ? '#ffe44d' : '#8a7a2a');
    return { c };
  },
  coin_face: () => {
    const { c, g } = mk(256, 256);
    g.fillStyle = '#e8a90f'; g.fillRect(0, 0, 256, 256);
    g.fillStyle = '#ffc928'; g.beginPath(); g.arc(128, 128, 118, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#d18e06'; g.lineWidth = 10; g.beginPath(); g.arc(128, 128, 100, 0, Math.PI * 2); g.stroke();
    g.fillStyle = '#ffe27a'; g.beginPath(); g.arc(108, 100, 60, 0, Math.PI * 2); g.globalAlpha = 0.35; g.fill(); g.globalAlpha = 1;
    g.fillStyle = '#c47f00'; lightningPath(g, 70, 58, 120); g.fill();
    g.fillStyle = '#fff1a8'; lightningPath(g, 64, 52, 120); g.fill();
    return { c };
  },
  patch_lightning_cyan: () => {
    const { c, g } = mk(128, 128);
    g.fillStyle = '#123a9e'; g.fillRect(10, 10, 108, 108);
    g.fillStyle = '#19d3e6'; lightningPath(g, 18, 16, 96); g.fill();
    return { c };
  },
  chalkboard: () => {
    const { c, g } = mk(1024, 420);
    g.fillStyle = '#2f4a3a'; g.fillRect(0, 0, 1024, 420);
    const r = rng(7);
    for (let i = 0; i < 1400; i++) { g.fillStyle = `rgba(255,255,255,${0.02 + r() * 0.03})`; g.fillRect(r() * 1024, r() * 420, 2 + r() * 10, 1 + r() * 3); }
    drawText(g, '2+2=?', 60, 60, 14, 'rgba(240,240,230,0.85)');
    drawText(g, 'NO RUNNING', 560, 300, 8, 'rgba(240,240,230,0.7)');
    g.strokeStyle = 'rgba(240,240,230,0.75)'; g.lineWidth = 6;
    g.beginPath(); g.arc(780, 150, 70, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.moveTo(690, 150); g.lineTo(870, 150); g.stroke();
    g.fillStyle = 'rgba(255,230,120,0.8)'; lightningPath(g, 110, 200, 150); g.fill();
    return { c };
  },
  floor_planks: () => {
    const { c, g } = mk(1024, 1024);
    const r = rng(11);
    const rows = 16;
    for (let row = 0; row < rows; row++) {
      let x = -r() * 300;
      while (x < 1024) {
        const w = 220 + r() * 260;
        const l = 58 + r() * 8;
        g.fillStyle = `hsl(${30 + r() * 6}, ${45 + r() * 10}%, ${l}%)`;
        g.fillRect(x, row * 64, w, 64);
        g.fillStyle = 'rgba(80,50,20,0.35)'; g.fillRect(x, row * 64, 3, 64);
        for (let k = 0; k < 3; k++) { g.fillStyle = 'rgba(120,80,40,0.12)'; g.fillRect(x + r() * w, row * 64 + 8 + r() * 48, 30 + r() * 80, 2); }
        x += w;
      }
      g.fillStyle = 'rgba(80,50,20,0.4)'; g.fillRect(0, row * 64, 1024, 3);
    }
    return { c };
  },
  window_sky: () => {
    const { c, g } = mk(256, 240);
    const grd = g.createLinearGradient(0, 0, 0, 240); grd.addColorStop(0, '#8ec5f5'); grd.addColorStop(1, '#e8f5ff');
    g.fillStyle = grd; g.fillRect(0, 0, 256, 240);
    g.fillStyle = 'rgba(255,255,255,0.9)'; for (const [x, y, s] of [[60, 70, 30], [90, 60, 36], [125, 72, 26], [190, 140, 22], [215, 132, 28]]) { g.beginPath(); g.arc(x, y, s, 0, Math.PI * 2); g.fill(); }
    g.fillStyle = '#7cc26b'; g.fillRect(0, 200, 256, 40);
    g.fillStyle = '#f2ede0'; g.fillRect(0, 0, 256, 12); g.fillRect(0, 228, 256, 12); g.fillRect(0, 0, 12, 240); g.fillRect(244, 0, 12, 240); g.fillRect(122, 0, 12, 240); g.fillRect(0, 114, 256, 12);
    return { c };
  },
  clock_face: () => {
    const { c, g } = mk(128, 128);
    g.fillStyle = '#3d63c9'; g.fillRect(0, 0, 128, 128);
    g.fillStyle = '#fbfbf6'; g.beginPath(); g.arc(64, 64, 56, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#222'; for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; g.fillRect(64 + Math.cos(a) * 46 - 3, 64 + Math.sin(a) * 46 - 3, 6, 6); }
    g.strokeStyle = '#222'; g.lineWidth = 6; g.beginPath(); g.moveTo(64, 64); g.lineTo(64, 28); g.moveTo(64, 64); g.lineTo(90, 70); g.stroke();
    return { c };
  },
  poster_read: () => {
    const { c, g } = mk(256, 336);
    g.fillStyle = '#ff7a3c'; g.fillRect(0, 0, 256, 336);
    g.fillStyle = '#fff6e0'; g.fillRect(14, 14, 228, 308);
    drawText(g, 'READ!', 36, 40, 13, '#3d63c9');
    g.fillStyle = '#3c9a52'; g.fillRect(58, 170, 140, 110); g.fillStyle = '#fff6e0'; g.fillRect(125, 170, 6, 110);
    g.fillStyle = '#ffc21a'; lightningPath(g, 150, 120, 60); g.fill();
    return { c };
  },
  poster_planet: () => {
    const { c, g } = mk(256, 256);
    g.fillStyle = '#1f2a55'; g.fillRect(0, 0, 256, 256);
    const r = rng(3); g.fillStyle = '#fff'; for (let i = 0; i < 60; i++) g.fillRect(r() * 256, r() * 256, 2, 2);
    g.fillStyle = '#ff9f43'; g.beginPath(); g.arc(128, 128, 60, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#ffe07a'; g.lineWidth = 8; g.beginPath(); g.ellipse(128, 128, 100, 26, -0.3, 0, Math.PI * 2); g.stroke();
    return { c };
  },
  emote_question: () => emote('?', '#ffffff', '#1f4fd1'),
  emote_exclaim: () => emote('!', '#ffffff', '#e8322b'),
  emote_dots: () => emote('...', '#ffffff', '#555a66'),
};

function emote(ch: string, fg: string, bg: string): { c: HTMLCanvasElement | OffscreenCanvas } {
  const { c, g } = mk(128, 128);
  g.fillStyle = bg; g.beginPath(); g.arc(64, 60, 54, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.moveTo(44, 104); g.lineTo(34, 126); g.lineTo(70, 108); g.fill();
  g.fillStyle = fg; g.beginPath(); g.arc(64, 60, 46, 0, Math.PI * 2); g.fill();
  const px = ch.length > 1 ? 6 : 9;
  const w = textWidth(ch, px);
  drawText(g, ch, 64 - w / 2, 60 - 3.5 * px, px, bg);
  return { c };
}

const cache = new Map<string, TextureSource>();
export function texture(id: string, variant?: string): TextureSource {
  const key = variant ? `${id}:${variant}` : id;
  let t = cache.get(key);
  if (!t) {
    const b = builders[id];
    if (!b) throw new Error(`unknown texture "${id}"`);
    t = { key, canvas: b(variant).c };
    cache.set(key, t);
  }
  return t;
}
export const TEXTURE_IDS = Object.keys(builders);
