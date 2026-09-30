// Browser page module for S7 stills (driven by packages/captions/tools/render-stills.ts through Playwright).
// Renders the approved narrated scene (WorldState-posed, integrated safe cameras) exactly like the draft renderer, then
// adds S7 layers: VFX particles/post/shake/zoom, emote billboards, world_text_3d, and the 2D overlay (ui_popup,
// title_card, caption_bold placed clear of the projected faces).
import type { Episode } from '../../../schema/src/episode.ts';
import { Renderer, type CameraState } from '../../../engine/src/gl/renderer.ts';
import { Production, type Library } from '../../../engine/src/production.ts';
import type { Node } from '../../../engine/src/gl/scene.ts';
import { applyShake } from '../../../engine/src/camera.ts';
import { m4TransformPoint, type Vec3 } from '../../../engine/src/math.ts';
import { buildWorldPlan, worldAssets, type WorldState } from '../../../narrated/src/world.ts';
import type { NarratedStoryboard } from '../../../narrated/src/schema.ts';
import { NarratedScene, cameraAt, type IntegratedTimeline } from '../../../../apps/render-worker/narrated-integration.ts';
import { evalVfxEvents, applyZoom, EmoteLayer, drawEmoteIcon, EMOTE_SYMBOLS, type VfxEvent } from '../../../engine/src/vfx/index.ts';
import { WorldTextLayer } from '../world-text.ts';
import { drawOverlay, graphicOccupancy, type TextGraphicEvent } from '../graphics.ts';
import { placeBoldCaption, drawBoldCaption, type Ctx2D } from '../render.ts';
import type { OccupiedRect, Rect } from '../placement.ts';
import type { BoldCaption } from '../bold.ts';

/** beat-sheet / library prop ids -> scene instance ids */
const INSTANCE: Record<string, string> = { suspicious_button: 'button', spark_coin: 'coin', student_desk: 'desk' };
let W = 1080, H = 1920;
let canvas: HTMLCanvasElement, out: HTMLCanvasElement, renderer: Renderer, prod: Production, scene: NarratedScene, tl: IntegratedTimeline;
const emotes = new EmoteLayer(), worldText = new WorldTextLayer();
let prev: WorldState | null = null;

function corners(n: Node): Vec3[] {
  const h = n.geometry?.half; if (!h) return [];
  const w = n.world, o: Vec3[] = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) { const p = m4TransformPoint(w, [sx * h[0], sy * h[1], sz * h[2]]); o.push([p[0], p[1], p[2]]); }
  return o;
}
function project(cam: CameraState, pts: Vec3[]): Rect | null {
  const { vp } = renderer.viewProj(cam);
  const ps = pts.map((p) => m4TransformPoint(vp, p)).filter((c) => c[3] > 0).map((c) => ({ x: ((c[0] / c[3] + 1) / 2) * W, y: (1 - (c[1] / c[3] + 1) / 2) * H }));
  if (!ps.length) return null;
  const x0 = Math.max(0, Math.min(...ps.map((p) => p.x))), x1 = Math.min(W, Math.max(...ps.map((p) => p.x))), y0 = Math.max(0, Math.min(...ps.map((p) => p.y))), y1 = Math.min(H, Math.max(...ps.map((p) => p.y)));
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}
function meshes(root: Node): Node[] { const o: Node[] = []; root.traverse((n) => { if (n.geometry && n.material && !n.name.startsWith('s7:')) o.push(n); }, true); return o; }
const inst = (id: string) => INSTANCE[id] ?? id;
function worldPoint(id: string): Vec3 | undefined {
  const rig = prod.rigs.get(id);
  if (rig) return rig.face.worldPos();
  const p = prod.props.get(inst(id));
  if (!p) return undefined;
  const pts = meshes(p.inst.root).flatMap(corners);
  if (!pts.length) return p.inst.root.worldPos();
  const c = (k: number) => (Math.min(...pts.map((q) => q[k])) + Math.max(...pts.map((q) => q[k]))) / 2;
  return [c(0), Math.max(...pts.map((q) => q[1])), c(2)];
}

interface PlacementSegment { start: number; end: number; centerY: number; clearOfFaces: boolean; faceOverlapPx: number; warnings: string[] }
interface FrameIn { t: number; vfx?: VfxEvent[]; graphics?: TextGraphicEvent[]; captions?: BoldCaption[]; placements?: Record<string, number | PlacementSegment[]>; showBoxes?: boolean }
function pose(t: number): CameraState {
  const { world } = scene.pose(t, prev && prev.t < t ? prev : null);
  prev = world;
  return cameraAt(tl, t);
}
function occupied(cam: CameraState): OccupiedRect[] {
  const o: OccupiedRect[] = [];
  for (const [id, rig] of prod.rigs) {
    const head = meshes(rig.root).find((n) => n.name === 'head_mesh');
    const r = head ? project(cam, corners(head)) : null;
    if (r) o.push({ id, kind: 'face', rect: r });
    const b = project(cam, meshes(rig.root).flatMap(corners));
    if (b) o.push({ id, kind: 'body', rect: b });
  }
  for (const [id, p] of prod.props) { if (id === 'desk') continue; const r = project(cam, meshes(p.inst.root).filter((n) => n.visible).flatMap(corners)); if (r) o.push({ id, kind: 'prop', rect: r }); }
  return o;
}

const api = {
  ready: true,
  init(ep: Episode, lib: Library, sb: NarratedStoryboard, itl: IntegratedTimeline, w: number, h: number) {
    W = w; H = h;
    canvas = document.createElement('canvas'); document.body.appendChild(canvas);
    out = Object.assign(document.createElement('canvas'), { width: W, height: H });
    renderer = new Renderer(canvas, W, H);
    prod = new Production(ep, lib);
    const plan = buildWorldPlan(sb, worldAssets(lib as never));
    if (plan.status !== 'ok') throw new Error('world plan unavailable');
    scene = new NarratedScene(prod, plan); tl = itl;
    prod.root.add(emotes.root, worldText.root);
    return { renderer: renderer.gl.getParameter(renderer.gl.RENDERER) as string };
  },
  /**
   * Caption id -> shot-segment placements. A caption remains stable within a camera shot and may choose a new band only
   * at a hard camera cut, where the entire picture changes anyway. This avoids the impossible case where faces occupy
   * every band only because the caption spans two different compositions.
   */
  place(captions: BoldCaption[], graphics: TextGraphicEvent[] = []): Record<string, { segments: PlacementSegment[]; centerY: number; clearOfFaces: boolean; faceOverlapPx: number; warnings: string[] }> {
    const g = out.getContext('2d')!, res: Record<string, { segments: PlacementSegment[]; centerY: number; clearOfFaces: boolean; faceOverlapPx: number; warnings: string[] }> = {};
    for (const c of captions) {
      const cuts = [...new Set([c.start, c.end, ...tl.shots.flatMap((s) => [s.start, s.end]).filter((t) => t > c.start + 1e-6 && t < c.end - 1e-6)])].sort((a, b) => a - b);
      const segments: PlacementSegment[] = [];
      for (let k = 0; k < cuts.length - 1; k++) {
        const start = cuts[k], end = cuts[k + 1], occ: OccupiedRect[] = [];
        const firstFrame = Math.ceil(start * tl.fps - 1e-9), lastFrame = Math.ceil(end * tl.fps - 1e-9);
        for (let i = firstFrame; i < lastFrame; i++) {
          const t = Math.min(end - 1e-6, Math.max(start, i / tl.fps)), cam = pose(t);
          occ.push(...occupied(cam));
          occ.push(...graphicOccupancy(g, W, H, graphics, start, end, (id) => { const p = worldPoint(id); const r = p ? project(cam, [p]) : null; return r ? { x: r.x, y: r.y } : undefined; }));
        }
        const p = placeBoldCaption(g, W, H, c, occ);
        segments.push({ start, end, centerY: p.centerY, clearOfFaces: p.clearOfFaces, faceOverlapPx: p.faceOverlapPx, warnings: p.warnings });
      }
      res[c.id] = { segments, centerY: segments[0]?.centerY ?? 0.5, clearOfFaces: segments.every((s) => s.clearOfFaces), faceOverlapPx: segments.reduce((n, s) => n + s.faceOverlapPx, 0), warnings: [...new Set(segments.flatMap((s) => s.warnings))] };
    }
    return res;
  },
  /** full frame: scene + S7 layers + overlay; returns a JPEG data URL and the projected face rectangles */
  frame(f: FrameIn, quality = 0.9): { url: string; faces: OccupiedRect[] } {
    let cam = pose(f.t);
    const vf = evalVfxEvents(f.vfx ?? [], f.t, (id) => worldPoint(id), prod.ep.episode.seed);
    cam = applyZoom(applyShake(cam, vf.shake, f.t, prod.ep.episode.seed), vf.zoom);
    emotes.update(vf.emotes, (id) => prod.rigs.get(id)?.headTop.worldPos(), cam);
    worldText.update(f.graphics ?? [], f.t, (id) => { const p = worldPoint(id); return p ? [p[0], p[1] + 0.08, p[2]] : undefined; });
    const light = scene.lighting(prev!);
    for (const l of vf.lights) { const p = worldPoint(l.target); if (p) light.points.push({ pos: p, color: l.color, intensity: l.intensity, range: 0.9 }); }
    renderer.render(prod.root, cam, light, vf.post, vf.particles);
    const g = out.getContext('2d')!;
    g.drawImage(canvas, 0, 0);
    const faces = occupied(cam).filter((o) => o.kind === 'face');
    const placements = new Map(Object.entries(f.placements ?? {}));
    drawOverlay(g, W, H, f.t, { captions: f.captions ?? [], placements, graphics: f.graphics ?? [], anchor: (id) => { const p = worldPoint(id); const r = p ? project(cam, [p]) : null; return r ? { x: r.x, y: r.y } : undefined; } });
    if (f.showBoxes) { g.lineWidth = 3; g.setLineDash([12, 8]); g.strokeStyle = '#00e5ff'; for (const o of faces) g.strokeRect(o.rect.x, o.rect.y, o.rect.w, o.rect.h); g.setLineDash([]); }
    return { url: out.toDataURL('image/jpeg', quality), faces };
  },
  /** pop-in strip: the same caption at several local times, cropped around the caption band */
  popStrip(c: BoldCaption, centerY: number, times: number[], t: number): string {
    api.frame({ t });
    const cellH = Math.round(H * 0.16), strip = Object.assign(document.createElement('canvas'), { width: W, height: cellH * times.length }), s = strip.getContext('2d')!;
    const tmp = Object.assign(document.createElement('canvas'), { width: W, height: H }), g = tmp.getContext('2d')!;
    times.forEach((lt, k) => {
      g.drawImage(canvas, 0, 0);
      drawBoldCaption(g, W, H, c, centerY, lt);
      s.drawImage(tmp, 0, H * centerY - cellH / 2, W, cellH, 0, k * cellH, W, cellH);
      s.font = `700 ${Math.round(cellH * 0.16)}px monospace`; s.fillStyle = '#00e5ff'; s.fillText(`+${Math.round(lt * 1000)} ms`, 20, k * cellH + cellH * 0.2);
    });
    return strip.toDataURL('image/jpeg', 0.9);
  },
  /** all emote icons on a checkerboard (transparency visible) */
  emoteSheet(): string {
    const n = EMOTE_SYMBOLS.length, cell = 300, c = Object.assign(document.createElement('canvas'), { width: cell * n, height: cell + 50 }), g = c.getContext('2d') as Ctx2D;
    for (let y = 0; y < cell; y += 25) for (let x = 0; x < cell * n; x += 25) { g.fillStyle = ((x + y) / 25) % 2 ? '#d9dde6' : '#f4f6fa'; g.fillRect(x, y, 25, 25); }
    g.fillStyle = '#111'; g.fillRect(0, cell, cell * n, 50);
    EMOTE_SYMBOLS.forEach((s, k) => { drawEmoteIcon(g, s, k * cell + cell / 2, cell / 2, 240); g.fillStyle = '#fff'; g.font = '700 26px monospace'; g.textAlign = 'center'; g.fillText(s, k * cell + cell / 2, cell + 34); });
    return c.toDataURL('image/png');
  },
};
(window as unknown as { __s7: typeof api }).__s7 = api;
