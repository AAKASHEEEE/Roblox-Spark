// Headless evaluation of the REAL engine (no GPU): the same Production / ActorTrack / camera code the renderer runs,
// so poses, prop states and cameras are exactly those of the episode's DECLARED motion profile. Used by the story
// compiler's fit pass (profile-aware clearance + shot fitting) and by node-side tests; the browser analyzer remains the
// independent verification. Nothing is re-implemented. Textures are the only browser dependency and animation/QA never
// read them: where OffscreenCanvas is missing (node) a no-op stand-in is installed; in a browser the real one is used.
import type { Episode } from '../../schema/src/episode.ts';
import { Production, type Library } from './production.ts';
import { Renderer } from './gl/renderer.ts';

class NoopContext2D { canvas: unknown; constructor(canvas: unknown) { this.canvas = canvas; } }
const noop = () => undefined;
const ctxHandler: ProxyHandler<NoopContext2D> = {
  get(t, k) {
    if (k in t) return (t as unknown as Record<string | symbol, unknown>)[k];
    if (k === 'measureText') return () => ({ width: 0, actualBoundingBoxAscent: 0, actualBoundingBoxDescent: 0 });
    if (k === 'createLinearGradient' || k === 'createRadialGradient' || k === 'createPattern') return () => ({ addColorStop: noop });
    if (k === 'getImageData' || k === 'createImageData') return (_x: number, _y: number, w = 1, h = 1) => ({ width: w, height: h, data: new Uint8ClampedArray(Math.max(4, w * h * 4)) });
    if (k === 'getTransform') return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    return noop;
  },
  set(t, k, v) { (t as unknown as Record<string | symbol, unknown>)[k] = v; return true; },
};
class HeadlessCanvas {
  width: number; height: number;
  constructor(w: number, h: number) { this.width = w; this.height = h; }
  getContext(): unknown { return new Proxy(new NoopContext2D(this), ctxHandler); }
}
function ensureCanvas(): void {
  const g = globalThis as unknown as { OffscreenCanvas?: unknown; document?: unknown };
  if (typeof g.OffscreenCanvas === 'undefined' && typeof g.document === 'undefined') g.OffscreenCanvas = HeadlessCanvas;
}

/** projection-only stand-in for the GPU renderer (Renderer.viewProj is pure math) */
export interface ProjectionOnly { width: number; height: number; viewProj: Renderer['viewProj'] }
export function projectionRenderer(width: number, height: number): ProjectionOnly {
  const r = { width, height } as ProjectionOnly;
  r.viewProj = (cam) => Renderer.prototype.viewProj.call(r as unknown as Renderer, cam);
  return r;
}

export interface HeadlessEngine { prod: Production; renderer: ProjectionOnly; fps: number }
/** evaluate an episode without a GPU (throws RenderCompatError on a missing/unsupported declaration, like rendering) */
export function headlessEngine(ep: Episode, lib: Library, width = 1080, height = 1920): HeadlessEngine {
  ensureCanvas();
  return { prod: new Production(ep, lib), renderer: projectionRenderer(width, height), fps: ep.episode.fps };
}
