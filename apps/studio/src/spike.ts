// PHASE 1 SPIKE: one blocky figure, one button, one light, one camera -> deterministic frames -> WebCodecs.
import { roundedBox, cylinder, plane } from '../../../packages/engine/src/gl/geometry.ts';
import { Node, hex } from '../../../packages/engine/src/gl/scene.ts';
import { Renderer } from '../../../packages/engine/src/gl/renderer.ts';
import { FrameCapture } from '../../../packages/engine/src/capture.ts';
import { qEuler } from '../../../packages/engine/src/math.ts';

const W = 1080, H = 1920, FPS = 30;
const canvas = document.createElement('canvas');
document.body.appendChild(canvas);
const r = new Renderer(canvas, W, H);

const root = new Node('root');
root.add(new Node('floor', roundedBox(12, 0.2, 12, 0), { color: hex('#b98c5e'), sheen: 0.1 }).at(0, -0.1, 0));
root.add(new Node('wall', roundedBox(12, 6, 0.2, 0), { color: hex('#8fb7a8'), sheen: 0 }).at(0, 3, -3));
const fig = new Node('fig').at(-0.6, 0, 0);
const torso = new Node('torso', roundedBox(0.56, 0.62, 0.3, 0.05), { color: hex('#2459d6') }).at(0, 1.11, 0);
const head = new Node('head', roundedBox(0.5, 0.5, 0.5, 0.07), { color: hex('#f2c230'), sheen: 0.2 }).at(0, 0.58, 0);
const armR = new Node('armR').at(0.36, 0.26, 0);
armR.add(new Node('armRm', roundedBox(0.16, 0.66, 0.16, 0.04), { color: hex('#2459d6') }).at(0, -0.3, 0));
torso.add(head, armR);
fig.add(torso);
for (const s of [-1, 1]) fig.add(new Node('leg', roundedBox(0.24, 0.8, 0.26, 0.04), { color: hex('#3a3a40') }).at(0.14 * s, 0.4, 0));
root.add(fig);
const desk = new Node('desk', roundedBox(0.9, 0.75, 0.6, 0.02), { color: hex('#c9a26b') }).at(0.35, 0.375, 0);
const btnBase = new Node('btnBase', cylinder(0.12, 0.05, 32, 0.01), { color: hex('#2b2b30') }).at(0.35, 0.775, 0.05);
const btnCap = new Node('btnCap', cylinder(0.085, 0.05, 32, 0.015), { color: hex('#e8322b'), emissive: [0, 0, 0], sheen: 1 }).at(0, 0.04, 0);
btnBase.add(btnCap);
root.add(desk, btnBase);
const label = document.createElement('canvas'); label.width = 256; label.height = 64;
const lg = label.getContext('2d')!; lg.fillStyle = '#ffd400'; lg.fillRect(0, 0, 256, 64); lg.fillStyle = '#111'; lg.fillRect(8, 8, 240, 48);
root.add(new Node('label', plane(0.3, 0.075), { color: [1, 1, 1], texture: { key: 'spike-label', canvas: label } }).at(0.35, 0.6, 0.301));

function renderFrame(i: number): void {
  const t = i / FPS;
  armR.rot = qEuler(-Math.min(1, t / 1.5) * 1.2, 0, 0.1);
  head.rot = qEuler(0, Math.sin(t * 2) * 0.3, 0);
  const glow = 0.5 + 0.5 * Math.sin(t * 8);
  btnCap.material!.emissive = [0.6 * glow, 0.05 * glow, 0.03 * glow];
  r.render(root,
    { pos: [0.2 + t * 0.05, 1.3, 3.2 - t * 0.2], target: [0, 1.0, 0], fovY: 50 * Math.PI / 180 },
    { sunDir: [-0.5, 1, 0.6], sunColor: [2.2, 2.0, 1.8], skyColor: [0.45, 0.5, 0.6], groundColor: [0.25, 0.2, 0.15], points: [{ pos: [0.35, 1.0, 0.3], color: [1, 0.2, 0.1], intensity: glow * 0.6, range: 0.8 }], fogColor: hex('#dfe8ee'), fogNear: 8, fogFar: 30, exposure: 1, shadowCenter: [0, 1, 0], shadowRadius: 3.5 },
    { vignette: 0.35, flash: 0 });
}

let cap: FrameCapture | null = null;
(window as any).__spark = {
  ready: true,
  init(cfg: { hashEvery: number }) {
    cap = new FrameCapture({ width: W, height: H, fps: FPS, bitrate: 10_000_000, keyframeInterval: 60, codec: 'avc1.640028', hashEvery: cfg.hashEvery }, canvas, () => r.readPixels());
    return { renderer: (r.gl.getParameter(r.gl.RENDERER) as string) };
  },
  encodeRange: (a: number, b: number, final: boolean) => cap!.encodeRange(a, b, renderFrame, final),
  meta: () => cap!.meta,
  stats: () => r.stats,
};
