// Browser-only prop preview renderer (QA stills): renders one prop, optionally next to Zapp, on a neutral stage with a
// 0.5 m floor grid, and composes contact sheets. Driven by scripts/props.ts sheet through Playwright (window.__props).
// Debug/QA tooling: never part of an episode render.
import type { CharacterManifest, PropManifest } from '../../../schema/src/assets.ts';
import { buildCharacter } from '../build.ts';
import { Renderer, type CameraState, type Lighting } from '../gl/renderer.ts';
import { roundedBox, plane } from '../gl/geometry.ts';
import { Node, hex, type TextureSource } from '../gl/scene.ts';
import { DEG, m4LookAt, m4Mul, m4Perspective, m4TransformPoint, qEuler, type Vec3 } from '../math.ts';
import { blockTextWidth, drawBlockText } from './font.ts';
import { propBuilder } from './index.ts';
import { anchorLocal, type RiggedProp } from './rig.ts';
import { doorwayWall } from './door.ts';
import { rollWheels, steer } from './car.ts';

export interface CellOpts {
  prop: PropManifest;
  zapp?: CharacterManifest;
  /** where Zapp stands: beside the prop (default), at a prop floor anchor (facing the grip), or absent */
  zappAt?: 'side' | 'none' | string;
  state?: string; u?: number; from?: string;
  /** prop yaw (deg) and camera azimuth / elevation (deg) */
  yaw?: number; az?: number; el?: number;
  steer?: number; roll?: number; text?: string;
  /** door only: stand it in a wall built with doorwayWall() */
  wall?: boolean;
  /** draw grip / surface / floor markers */
  markers?: boolean;
  /** close-up inset of the prop (default: automatic for props smaller than 0.6 m) */
  inset?: boolean;
  w: number; h: number;
}

let canvas: HTMLCanvasElement | null = null;
let renderer: Renderer | null = null;
function ensure(w: number, h: number): Renderer {
  if (!canvas) { canvas = document.createElement('canvas'); document.body.appendChild(canvas); }
  if (!renderer || renderer.width !== w || renderer.height !== h) renderer = new Renderer(canvas, w, h);
  return renderer;
}

let gridTex: TextureSource | null = null;
function grid(): TextureSource {
  if (gridTex) return gridTex;
  const c = document.createElement('canvas'); c.width = c.height = 1024;
  const g = c.getContext('2d')!;
  g.fillStyle = '#e6e0d3'; g.fillRect(0, 0, 1024, 1024);
  for (let i = 0; i <= 32; i++) { // 16 m / 0.5 m
    const x = Math.round(i * 32); g.fillStyle = i % 2 ? '#d3ccbd' : '#bfb7a6';
    const t = i % 2 ? 2 : 4; g.fillRect(x - t / 2, 0, t, 1024); g.fillRect(0, x - t / 2, 1024, t);
  }
  gridTex = { key: 'props_preview_grid', canvas: c };
  return gridTex;
}

function stage(backdrop = true): Node {
  const root = new Node('preview');
  const floor = new Node('floor', roundedBox(60, 0.1, 60, 0), { color: hex('#e6e0d3'), sheen: 0.1 }).at(0, -0.05, 0);
  floor.castShadow = false;
  const gp = new Node('grid', plane(16, 16), { color: [1, 1, 1], texture: grid(), sheen: 0.05 }).at(0, 0.001, 0);
  gp.rot = qEuler(-90 * DEG, 0, 0); gp.decal = true; gp.castShadow = false;
  const wall = new Node('backdrop', roundedBox(60, 14, 0.2, 0), { color: hex('#cfe0ee'), sheen: 0 }).at(0, 7, -9);
  wall.castShadow = false;
  wall.visible = backdrop;
  root.add(floor, gp, wall);
  return root;
}

type Box = { min: Vec3; max: Vec3 };
function bounds(n: Node, skip: Set<Node>): Box {
  const b: Box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  n.traverse((m) => {
    if (!m.geometry || skip.has(m)) return;
    const h = m.geometry.half;
    for (let i = 0; i < 8; i++) {
      const p = m4TransformPoint(m.world, [i & 1 ? h[0] : -h[0], i & 2 ? h[1] : -h[1], i & 4 ? h[2] : -h[2]]);
      for (let k = 0; k < 3; k++) { b.min[k] = Math.min(b.min[k], p[k]); b.max[k] = Math.max(b.max[k], p[k]); }
    }
  }, true);
  return b;
}

/** camera looking at `b` from azimuth/elevation, distance solved so the box fills `fill` of the frame */
function fit(b: Box, aspect: number, azDeg: number, elDeg: number, fovDeg = 30, fill = 0.86): CameraState {
  const az = azDeg * DEG, el = elDeg * DEG;
  const dir: Vec3 = [Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)];
  let target: Vec3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
  const fovY = fovDeg * DEG, ty = Math.tan(fovY / 2), tx = ty * aspect;
  const corners: Vec3[] = [];
  for (let i = 0; i < 8; i++) corners.push([i & 1 ? b.max[0] : b.min[0], i & 2 ? b.max[1] : b.min[1], i & 4 ? b.max[2] : b.min[2]]);
  let dist = 5;
  for (let it = 0; it < 6; it++) {
    const eye: Vec3 = [target[0] + dir[0] * dist, target[1] + dir[1] * dist, target[2] + dir[2] * dist];
    const V = m4LookAt(eye, target);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const c of corners) { const p = m4TransformPoint(V, c); const z = -p[2]; x0 = Math.min(x0, p[0] / z); x1 = Math.max(x1, p[0] / z); y0 = Math.min(y0, p[1] / z); y1 = Math.max(y1, p[1] / z); }
    const need = Math.max((x1 - x0) / (2 * tx), (y1 - y0) / (2 * ty)) / fill;
    // recentre: shift target by the screen-space midpoint (camera right / up axes from the view matrix rows)
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    const right: Vec3 = [V[0], V[4], V[8]], up: Vec3 = [V[1], V[5], V[9]];
    target = [target[0] + (right[0] * mx + up[0] * my) * dist, target[1] + (right[1] * mx + up[1] * my) * dist, target[2] + (right[2] * mx + up[2] * my) * dist];
    dist *= need;
  }
  return { pos: [target[0] + dir[0] * dist, target[1] + dir[1] * dist, target[2] + dir[2] * dist], target, fovY };
}

function lighting(b: Box): Lighting {
  const c: Vec3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
  const r = Math.max(1, Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) * 0.65);
  return {
    sunDir: [-0.55, 0.85, 0.55], sunColor: hex('#fff1d9').map((x) => x * 2.1) as Vec3, skyColor: hex('#c9dcf2').map((x) => x * 0.66) as Vec3,
    groundColor: hex('#b08a62').map((x) => x * 0.4) as Vec3, points: [], fogColor: hex('#e7eef2'), fogNear: 60, fogFar: 140, exposure: 1.05,
    shadowCenter: c, shadowRadius: r,
  };
}

const warmed = new WeakSet<Renderer>();
function shoot(r: Renderer, root: Node, cam: CameraState, b: Box): string {
  // a freshly created Renderer drops shadow casters on its very first frame: draw once to warm it up
  if (!warmed.has(r)) { r.render(root, cam, lighting(b), { vignette: 0.12, flash: 0 }); warmed.add(r); }
  r.render(root, cam, lighting(b), { vignette: 0.12, flash: 0 });
  return canvas!.toDataURL('image/png');
}

const MARK = [['grip', '#18b84a', 'G'], ['surface', '#1f6fe0', 'S'], ['floor', '#e0322b', 'F']] as const;

/** Render one preview cell and return a PNG data URL. */
export async function cell(o: CellOpts): Promise<string> {
  const r = ensure(o.w, o.h);
  const root = stage(Math.cos((o.az ?? 24) * DEG) > 0);
  const b = propBuilder(o.prop);
  const rig = b.build('preview', { seed: 1, text: o.text }) as RiggedProp;
  if (o.state) b.applyState(rig, o.state, o.u ?? 1, o.from);
  if (o.steer !== undefined) steer(rig, o.steer);
  if (o.roll !== undefined) rollWheels(rig, o.roll);
  const pr = rig.instance.root;
  pr.rot = qEuler(0, (o.yaw ?? 0) * DEG, 0);
  root.add(pr);
  if (o.wall) for (const w of doorwayWall({ length: 4.2, height: 2.9, thickness: 0.16, doorX: 0, color: '#9ec3a8' })) {
    const n = new Node(w.id, roundedBox(w.size[0], w.size[1], w.size[2], 0), { color: hex(w.color), sheen: 0.1 }).at(w.pos[0], w.pos[1], w.pos[2]);
    pr.add(n);
  }
  root.updateWorld();
  const propOnly = bounds(pr, new Set());
  const where = o.zappAt ?? 'side';
  let zappRoot: Node | null = null;
  if (o.zapp && where !== 'none') {
    const z = buildCharacter(o.zapp);
    z.setFace(o.zapp.allowedExpressions.includes('happy') ? 'happy' : o.zapp.allowedExpressions[0], 0);
    if (where === 'side') z.root.pos = [propOnly.min[0] - 0.3 - 0.43, 0, 0];
    else {
      const a = o.prop.anchors[where];
      if (!a) throw new Error(`preview: anchor ${where} missing on ${o.prop.id}`);
      const y = (o.yaw ?? 0) * DEG, c = Math.cos(y), s = Math.sin(y);
      const p: Vec3 = [a[0] * c + a[2] * s, 0, -a[0] * s + a[2] * c];
      const g = anchorLocal(rig, 'grip');
      const gw: Vec3 = [g[0] * c + g[2] * s, g[1], -g[0] * s + g[2] * c];
      z.root.pos = p;
      z.root.rot = qEuler(0, Math.atan2(gw[0] - p[0], gw[2] - p[2]), 0);
    }
    root.add(z.root); zappRoot = z.root;
    root.updateWorld();
  }
  const skip = new Set<Node>();
  root.children.slice(0, 3).forEach((n) => n.traverse((m) => skip.add(m)));
  const all = bounds(root, skip);
  const aspect = o.w / o.h;
  const cam = fit(all, aspect, o.az ?? 24, o.el ?? 12);
  const main = shoot(r, root, cam, all);

  const small = Math.max(...o.prop.dimensions) < 0.6;
  let insetUrl: string | null = null;
  if ((o.inset ?? small) && zappRoot) {
    zappRoot.visible = false;
    insetUrl = shoot(r, root, fit(propOnly, 1, o.az ?? 24, Math.max(o.el ?? 12, 24), 30, 0.8), propOnly);
    zappRoot.visible = true;
  }
  // 2D overlay: inset + anchor markers
  const out = document.createElement('canvas'); out.width = o.w; out.height = o.h;
  const g = out.getContext('2d')!;
  const load = (u: string) => new Promise<HTMLImageElement>((ok) => { const i = new Image(); i.onload = () => ok(i); i.src = u; });
  g.drawImage(await load(main), 0, 0);
  if (o.markers) {
    const P = m4Mul(m4Perspective(cam.fovY, aspect, 0.05, 200), m4LookAt(cam.pos, cam.target));
    const y = (o.yaw ?? 0) * DEG, c = Math.cos(y), s = Math.sin(y);
    for (const [name, col, letter] of MARK) {
      const a = anchorLocal(rig, name);
      const w: Vec3 = [a[0] * c + a[2] * s, a[1], -a[0] * s + a[2] * c];
      const q = m4TransformPoint(P, w);
      const sx = (q[0] / q[3] * 0.5 + 0.5) * o.w, sy = (1 - (q[1] / q[3] * 0.5 + 0.5)) * o.h;
      g.fillStyle = '#ffffff'; g.beginPath(); g.arc(sx, sy, 9, 0, Math.PI * 2); g.fill();
      g.fillStyle = col; g.beginPath(); g.arc(sx, sy, 7, 0, Math.PI * 2); g.fill();
      drawBlockText(g, letter, sx - 2.5 * 1.6, sy - 3.5 * 1.6, 1.6, '#ffffff');
    }
  }
  if (insetUrl) {
    const s = Math.round(Math.min(o.w, o.h) * 0.42), x = o.w - s - 8, yy = 8;
    g.fillStyle = '#ffffff'; g.fillRect(x - 3, yy - 3, s + 6, s + 6);
    g.drawImage(await load(insetUrl), x, yy, s, s);
  }
  return out.toDataURL('image/png');
}

/** Contact sheet with block-font captions (no system fonts). */
export async function compose(cells: Array<{ url: string; label: string; sub?: string }>, cols: number, cw: number, ch: number, title: string): Promise<string> {
  const pad = 8, capH = 44, head = 56, rows = Math.ceil(cells.length / cols);
  const c = document.createElement('canvas');
  c.width = pad + cols * (cw + pad); c.height = head + rows * (ch + capH + pad) + pad;
  const g = c.getContext('2d')!;
  g.fillStyle = '#15171c'; g.fillRect(0, 0, c.width, c.height);
  drawBlockText(g, title, pad + 4, 16, 4, '#ffffff');
  const load = (u: string) => new Promise<HTMLImageElement>((ok) => { const i = new Image(); i.onload = () => ok(i); i.src = u; });
  for (const [k, cl] of cells.entries()) {
    const x = pad + (k % cols) * (cw + pad), y = head + Math.floor(k / cols) * (ch + capH + pad);
    g.drawImage(await load(cl.url), x, y, cw, ch);
    const px = Math.min(3, Math.floor(cw / Math.max(1, blockTextWidth(cl.label, 1)))) || 1;
    drawBlockText(g, cl.label, x + 4, y + ch + 6, px, '#ffffff');
    if (cl.sub) drawBlockText(g, cl.sub, x + 4, y + ch + 6 + 7 * px + 6, 2, '#9aa3ad');
  }
  return c.toDataURL('image/png');
}

(window as unknown as { __props: unknown }).__props = { ready: true, cell, compose };
