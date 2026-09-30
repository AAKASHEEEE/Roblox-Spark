// Node-side canvas stand-in (same approach as packages/engine/src/headless.ts, which does not export it): textures
// are the only browser dependency of the scene and geometry / cameras / coverage never read their pixels.
class NoopContext2D { canvas: unknown; constructor(canvas: unknown) { this.canvas = canvas; } }
const noop = () => undefined;
const handler: ProxyHandler<NoopContext2D> = {
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
class HeadlessCanvas { width: number; height: number; constructor(w: number, h: number) { this.width = w; this.height = h; } getContext(): unknown { return new Proxy(new NoopContext2D(this), handler); } }
export function ensureHeadlessCanvas(): void {
  const g = globalThis as unknown as { OffscreenCanvas?: unknown; document?: unknown };
  if (typeof g.OffscreenCanvas === 'undefined' && typeof g.document === 'undefined') g.OffscreenCanvas = HeadlessCanvas;
}
