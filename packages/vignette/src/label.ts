// Labels for placeholder blocks: deterministic 5x7 block font (no system fonts, no images) drawn into a canvas texture.
// Works in the browser (real canvas) and in node (the headless no-op canvas; geometry is identical, pixels are not drawn).
import { plane } from '../../engine/src/gl/geometry.ts';
import { Node, type TextureSource } from '../../engine/src/gl/scene.ts';

const G: Record<string, string> = {
  A: '.###.#...##...#######...##...##...#', B: '####.#...##...#####.#...##...#####.', C: '.#####....#....#....#....#.....####',
  D: '####.#...##...##...##...##...#####.', E: '######....#....####.#....#....#####', F: '######....#....####.#....#....#....',
  G: '.#####....#....#.####...##...#.###.', H: '#...##...##...#######...##...##...#', I: '#####..#....#....#....#....#..#####',
  J: '..###...#....#....#....##...#.###..', K: '#...##..#.#.#..##...#.#..#..#.#...#', L: '#....#....#....#....#....#....#####',
  M: '#...###.###.#.##.#.##...##...##...#', N: '#...###..##.#.##..###...##...##...#', O: '.###.#...##...##...##...##...#.###.',
  P: '####.#...##...#####.#....#....#....', Q: '.###.#...##...##...##.#.##..#..##.#', R: '####.#...##...#####.#.#..#..#.#...#',
  S: '.#####....#.....###.....#....#####.', T: '#####..#....#....#....#....#....#..', U: '#...##...##...##...##...##...#.###.',
  V: '#...##...##...##...##...#.#.#...#..', W: '#...##...##...##.#.##.#.##.#.#.#.#.', X: '#...##...#.#.#...#...#.#.#...##...#',
  Y: '#...##...#.#.#...#....#....#....#..', Z: '#####....#...#...#...#...#....#####',
  '0': '.###.#...##..###.#.###..##...#.###.', '1': '..#...##....#....#....#....#...###.', '2': '.###.#...#....#...#...#...#...#####',
  '3': '####.....#....#.###.....#....#####.', '4': '...#...##..#.#.#..#.#####...#....#.', '5': '######....####.....#....#....#####.',
  '6': '.###.#....#....####.#...##...#.###.', '7': '#####....#...#...#...#....#....#...', '8': '.###.#...##...#.###.#...##...#.###.',
  '9': '.###.#...##...#.####....#....#.###.', '_': '..............................#####', '-': '...............###...............',
  ':': '.......#.........#.........#.......', '.': '..............................#....', '!': '..#....#....#....#....#.........#..',
  '?': '.###.#...#....#...#...#.........#..', '@': '.###.#...##.###.#.##.###.#.....###.', '/': '....#...#....#...#...#....#...#....',
  '(': '...#...#...#....#....#.....#.....#.', ')': '.#.....#.....#....#....#...#...#...', ' ': '...................................',
};

export interface LabelStyle { fg: string; bg: string; border?: string }
export const PLACEHOLDER_LABEL: LabelStyle = { fg: '#1d1d1d', bg: '#e9e9e9', border: '#5a5a5a' };

/** a canvas texture showing `lines` (upper-cased; unknown glyphs become '?') */
export function labelTexture(lines: string[], style: LabelStyle = PLACEHOLDER_LABEL): { tex: TextureSource; aspect: number } {
  const up = lines.map((l) => l.toUpperCase().split('').map((ch) => (G[ch] ? ch : '?')).join(''));
  const cols = Math.max(1, ...up.map((l) => l.length)), px = 4, cw = 6 * px, ch = 9 * px, pad = 2 * px;
  const w = cols * cw + 2 * pad, h = up.length * ch + 2 * pad;
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const g = c.getContext('2d') as CanvasRenderingContext2D | null;
  if (g && typeof g.fillRect === 'function') {
    g.fillStyle = style.bg; g.fillRect(0, 0, w, h);
    if (style.border) { g.fillStyle = style.border; g.fillRect(0, 0, w, px); g.fillRect(0, h - px, w, px); g.fillRect(0, 0, px, h); g.fillRect(w - px, 0, px, h); }
    g.fillStyle = style.fg;
    up.forEach((line, li) => {
      const x0 = pad + ((cols - line.length) * cw) / 2;
      [...line].forEach((chr, k) => {
        const bits = G[chr];
        for (let r = 0; r < 7; r++) for (let q = 0; q < 5; q++) if (bits[r * 5 + q] === '#') g.fillRect(x0 + k * cw + q * px, pad + li * ch + px + r * px, px, px);
      });
    });
  }
  return { tex: { key: `vignette_label:${style.fg}:${style.bg}:${up.join('|')}`, canvas: c }, aspect: w / h };
}

/** a flat label plane (decal-like, no shadow), `height` metres tall; billboard labels always face the lens */
export function labelNode(name: string, lines: string[], height: number, opts: { billboard?: boolean; style?: LabelStyle } = {}): Node {
  const { tex, aspect } = labelTexture(lines, opts.style);
  const n = new Node(name, plane(height * aspect, height), { color: [1, 1, 1], unlit: true, texture: tex });
  n.castShadow = false;
  n.decal = !opts.billboard;
  n.billboard = !!opts.billboard;
  return n;
}
