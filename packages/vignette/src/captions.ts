// Deterministic screen-space captions for vignette stills/video. Beat-sheet chunks are already phrase-aligned and
// limited to four words, so this layer only lays out/draws them; it never rewrites narration text or timing.
import type { StagedBeat } from './stage.ts';

const FONT = '"DejaVu Sans", "Liberation Sans", Arial, Helvetica, sans-serif';
const clean = (s: string) => s.replace(/[\p{Extended_Pictographic}\p{Cf}\p{Co}\u{FE0F}]/gu, '').replace(/\s+/g, ' ').trim();
const wordKey = (s: string) => s.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').toLowerCase();

export function captionAt(beat: Pick<StagedBeat, 'captions'>, t: number) {
  return beat.captions.find((c) => t >= c.start - 1e-9 && t < c.end - 1e-9) ?? null;
}

function splitLines(g: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  if (g.measureText(text).width <= maxWidth) return [text];
  const words = text.split(' ');
  let best = 1, score = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = g.measureText(words.slice(0, i).join(' ')).width;
    const b = g.measureText(words.slice(i).join(' ')).width;
    const next = Math.max(a, b) + Math.abs(a - b) * 0.15;
    if (next < score) { score = next; best = i; }
  }
  return [words.slice(0, best).join(' '), words.slice(best).join(' ')];
}

/** Bold Shorts caption: white, heavy black outline, one yellow highlighted word and a quick deterministic pop-in. */
export function drawCaption(g: CanvasRenderingContext2D, beat: Pick<StagedBeat, 'captions'>, t: number, width: number, height: number): boolean {
  const c = captionAt(beat, t);
  if (!c) return false;
  const text = clean(c.text);
  if (!text) return false;
  const emphasis = new Set(c.highlight ? [wordKey(c.highlight)] : []);
  let px = Math.round(height * 0.047);
  g.font = `900 ${px}px ${FONT}`;
  let lines = splitLines(g, text, width * 0.9);
  const widest = () => Math.max(...lines.map((line) => g.measureText(line).width));
  if (widest() > width * 0.9) {
    px = Math.max(22, Math.floor(px * width * 0.9 / widest()));
    g.font = `900 ${px}px ${FONT}`;
    lines = splitLines(g, text, width * 0.9);
  }
  const elapsed = Math.max(0, t - c.start), x = Math.min(1, elapsed / 0.12);
  const scale = x < 1 ? 0.78 + 0.3 * (1 - Math.pow(1 - x, 3)) - 0.08 * x : 1;
  const lineHeight = px * 1.16, blockHeight = lineHeight * lines.length;
  // Upper-middle keeps captions clear of the bottom editing/music UI and of floor-level action.
  const centerY = Math.max(blockHeight / 2 + height * 0.055, height * 0.19);
  g.save();
  g.translate(width / 2, centerY); g.scale(scale, scale); g.translate(-width / 2, -centerY);
  g.font = `900 ${px}px ${FONT}`; g.textAlign = 'left'; g.textBaseline = 'middle'; g.lineJoin = 'round'; g.miterLimit = 2;
  lines.forEach((line, row) => {
    const words = line.split(' '), gap = g.measureText(' ').width;
    const widths = words.map((word) => g.measureText(word).width);
    let left = (width - widths.reduce((a, b) => a + b, 0) - gap * (words.length - 1)) / 2;
    const y = centerY - blockHeight / 2 + lineHeight * (row + 0.5);
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      g.lineWidth = Math.max(3, px * 0.2); g.strokeStyle = 'rgba(5,7,12,0.97)'; g.strokeText(word, left, y);
      g.fillStyle = emphasis.has(wordKey(word)) ? '#ffe600' : '#ffffff'; g.fillText(word, left, y);
      left += widths[i] + gap;
    }
  });
  g.restore();
  return true;
}

/** Minimal game-style popup for ui_popup beat events; title cards/world text remain explicit planned fallbacks. */
export function drawUiPopup(g: CanvasRenderingContext2D, beat: StagedBeat, t: number, width: number, height: number): boolean {
  const active = beat.events.map((x) => x.event).find((e) => e.type === 'text_graphic' && e.textStyleId === 'ui_popup' && t >= e.at && t < e.at + e.duration);
  if (!active || active.type !== 'text_graphic') return false;
  const u = Math.min(1, Math.max(0, (t - active.at) / 0.16));
  const pop = 0.7 + 0.3 * (1 - Math.pow(1 - u, 3));
  const w = Math.min(width * 0.72, 440), h = height * 0.09, x = (width - w) / 2, y = height * 0.31;
  g.save(); g.translate(width / 2, y + h / 2); g.scale(pop, pop); g.translate(-width / 2, -(y + h / 2));
  g.fillStyle = 'rgba(12,27,47,0.93)'; g.strokeStyle = '#75e8ff'; g.lineWidth = Math.max(3, height * 0.005);
  g.beginPath(); g.roundRect(x, y, w, h, h * 0.22); g.fill(); g.stroke();
  g.font = `900 ${Math.round(height * 0.038)}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = Math.max(2, height * 0.005); g.strokeStyle = '#06101d'; g.strokeText(clean(active.text), width / 2, y + h / 2);
  g.fillStyle = '#ffffff'; g.fillText(clean(active.text), width / 2, y + h / 2); g.restore();
  return true;
}

export function drawVignetteOverlay(g: CanvasRenderingContext2D, beat: StagedBeat, t: number, width: number, height: number): void {
  drawUiPopup(g, beat, t, width, height);
  drawCaption(g, beat, t, width, height);
}
