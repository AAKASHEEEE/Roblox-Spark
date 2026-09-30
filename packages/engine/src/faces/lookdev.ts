// Look-development page for characters and faces (browser only; driven by scripts/character-stills.ts through Playwright).
// Renders with the production Renderer and buildCharacter, so what it shows is what episodes get.
import type { CharacterManifest } from '../../../schema/src/assets.ts';
import { Renderer, type CameraState, type Lighting } from '../gl/renderer.ts';
import { Node, hex } from '../gl/scene.ts';
import { DEG, qEuler, type Vec3 } from '../math.ts';
import { buildCharacter, partNode, type Rig } from '../build.ts';
import { decorateCharacter } from './recipes.ts';
import { designOf } from './design.ts';
import { drawV2, faceSource, setFace, FACE_TEXTURE_SIZE, type MouthShape } from './index.ts';
import { drawLegacyFace } from './legacy.ts';

let canvas: HTMLCanvasElement | null = null;
let renderer: Renderer | null = null;

function ensure(w: number, h: number): Renderer {
  if (!canvas) { canvas = document.createElement('canvas'); document.body.appendChild(canvas); }
  if (!renderer || renderer.width !== w || renderer.height !== h) renderer = new Renderer(canvas, w, h);
  return renderer;
}

// classroom@1.1.0 "morning", converted exactly like Production.lighting()
function lighting(): Lighting {
  const s = (h: string, k: number) => hex(h).map((c) => c * k) as [number, number, number];
  return { sunDir: [-0.72, 0.78, 0.42], sunColor: s('#fff1d9', 2.1), skyColor: s('#c9dcf2', 0.62), groundColor: s('#b08a62', 0.62 * 0.6), points: [], fogColor: hex('#e7eef2'), fogNear: 18, fogFar: 45, exposure: 1.05, shadowCenter: [0, 1, 0], shadowRadius: 3.2 };
}

function stage(): Node {
  const root = new Node('lookdev');
  root.add(partNode({ id: 'floor', size: [14, 0.1, 10], pos: [0, -0.05, 0], color: '#c9d0d8', sheen: 0.1 }));
  root.add(partNode({ id: 'wall', size: [14, 8, 0.1], pos: [0, 4, -3.2], color: '#e8edf2', sheen: 0.05 }));
  return root;
}

export interface Actor { manifest: CharacterManifest; x?: number; z?: number; yawDeg?: number; state?: string; blink?: number; mouth?: MouthShape | null; seed?: number }
export interface Framing {
  /** 'full' = whole body; number = projected head height as a fraction of frame height (0.18 = camera-safety medium minimum) */
  fit: 'full' | 'group' | number;
  /** camera azimuth around the subject (deg, 0 = in front) */
  orbitDeg?: number;
  fovDeg?: number;
}

function place(a: Actor): Rig {
  const rig = buildCharacter(a.manifest);
  decorateCharacter(rig, { seed: a.seed ?? 0 });
  rig.root.pos = [a.x ?? 0, 0, a.z ?? 0];
  rig.root.rot = qEuler(0, (a.yawDeg ?? 0) * DEG, 0);
  setFace(rig, a.state ?? a.manifest.allowedExpressions[0], a.blink ?? 0, a.mouth ?? null);
  return rig;
}

function camera(rigs: Rig[], f: Framing, aspect: number): CameraState {
  const fov = (f.fovDeg ?? 30) * DEG;
  const orbit = (f.orbitDeg ?? 0) * DEG;
  const tan = Math.tan(fov / 2);
  let target: Vec3, dist: number;
  if (f.fit === 'full' || f.fit === 'group') {
    const xs = rigs.map((r) => r.root.pos[0]);
    const top = Math.max(...rigs.map((r) => r.dims.height)) + 0.28;
    const halfH = top * 0.56, halfW = (Math.max(...xs) - Math.min(...xs)) / 2 + 0.55;
    dist = Math.max(halfH / tan, halfW / (tan * aspect));
    target = [(Math.max(...xs) + Math.min(...xs)) / 2, top * 0.48, 0];
  } else {
    const r = rigs[0];
    const neckY = r.dims.legLen + r.dims.torsoH + 0.012;
    target = [r.root.pos[0], neckY + r.dims.headH * 0.42, r.root.pos[2]];
    dist = r.dims.headH / (2 * f.fit * tan);
  }
  return { pos: [target[0] + Math.sin(orbit) * dist, target[1] + 0.02, target[2] + Math.cos(orbit) * dist], target, fovY: fov };
}

const api = {
  ready: true,
  shot(actors: Actor[], framing: Framing, w = 540, h = 960): string {
    const r = ensure(w, h);
    const root = stage();
    const rigs = actors.map(place);
    for (const rig of rigs) root.add(rig.root);
    root.updateWorld();
    const cam = camera(rigs, framing, w / h);
    // first draw after a resize uploads buffers/textures; draw twice so every still is complete
    r.render(root, cam, lighting(), { vignette: 0.12, flash: 0 }, []);
    r.render(root, cam, lighting(), { vignette: 0.12, flash: 0 }, []);
    return canvas!.toDataURL('image/png');
  },
  /** the raw face texture (as the engine uploads it) composited on the skin, for texture-level review */
  faceSwatch(m: CharacterManifest, state: string, px = 256, mouth: MouthShape | null = null): string {
    const c = document.createElement('canvas'); c.width = c.height = px;
    const g = c.getContext('2d')!;
    const tex = document.createElement('canvas'); tex.width = tex.height = FACE_TEXTURE_SIZE;
    const tg = tex.getContext('2d')!;
    if (faceSource(m, state) === 'v1' && !mouth) drawLegacyFace(tg, m, state, 0); else if (faceSource(m, state) === 'v2') drawV2(tg, designOf(m), state, FACE_TEXTURE_SIZE, 0, mouth); else drawLegacyFace(tg, m, state, 0);
    g.fillStyle = m.body.skin; g.fillRect(0, 0, px, px);
    g.drawImage(tex, 0, 0, px, px);
    return c.toDataURL('image/png');
  },
  /** grid of images with labels (and an optional title bar) */
  async compose(urls: string[], labels: string[], cols: number, cellW: number, cellH: number, title = ''): Promise<string> {
    const imgs = await Promise.all(urls.map((u) => new Promise<HTMLImageElement>((ok) => { const i = new Image(); i.onload = () => ok(i); i.src = u; })));
    const rows = Math.ceil(imgs.length / cols), pad = 8, lab = 30, head = title ? 44 : 0;
    const c = document.createElement('canvas'); c.width = cols * (cellW + pad) + pad; c.height = head + rows * (cellH + lab + pad) + pad;
    const g = c.getContext('2d')!;
    g.fillStyle = '#16171b'; g.fillRect(0, 0, c.width, c.height);
    if (title) { g.fillStyle = '#fff'; g.font = 'bold 24px sans-serif'; g.fillText(title, pad + 4, 31); }
    imgs.forEach((im, k) => {
      const x = pad + (k % cols) * (cellW + pad), y = head + pad + Math.floor(k / cols) * (cellH + lab + pad);
      g.drawImage(im, x, y, cellW, cellH);
      g.fillStyle = '#e8e8e8'; g.font = '18px monospace'; g.fillText(labels[k] ?? '', x + 4, y + cellH + 22);
    });
    return c.toDataURL('image/png');
  },
  /** crop a data URL (x, y, w, h in source px) and optionally rescale to outW */
  async crop(url: string, x: number, y: number, w: number, h: number, outW = w): Promise<string> {
    const im = await new Promise<HTMLImageElement>((ok) => { const i = new Image(); i.onload = () => ok(i); i.src = url; });
    const c = document.createElement('canvas'); c.width = outW; c.height = Math.round((h * outW) / w);
    c.getContext('2d')!.drawImage(im, x, y, w, h, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  },
};
(window as unknown as { __lookdev: typeof api }).__lookdev = api;
