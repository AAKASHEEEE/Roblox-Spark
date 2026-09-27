// Headless render page entry: the render worker drives this through Playwright.
import type { Episode } from '../../../packages/schema/src/episode.ts';
import { Renderer } from '../../../packages/engine/src/gl/renderer.ts';
import { Production, type Library, type FrameIssue } from '../../../packages/engine/src/production.ts';
import { FrameCapture, encodeOpus } from '../../../packages/engine/src/capture.ts';

let prod: Production | null = null;
let renderer: Renderer | null = null;
let canvas: HTMLCanvasElement | null = null;
let cap: FrameCapture | null = null;
let fps = 30;
const lastIssues: FrameIssue[] = [];

function ensure(w: number, h: number): void {
  if (!canvas) { canvas = document.createElement('canvas'); document.body.appendChild(canvas); }
  if (!renderer || renderer.width !== w || renderer.height !== h) renderer = new Renderer(canvas, w, h);
}

const api = {
  ready: true,
  load(ep: Episode, lib: Library, w = 1080, h = 1920) {
    ensure(w, h);
    prod = new Production(ep, lib);
    fps = ep.episode.fps;
    return { renderer: renderer!.gl.getParameter(renderer!.gl.RENDERER) as string, contacts: prod.contacts(), impacts: [...prod.props].flatMap(([id, p]) => p.track.impacts.map((i) => ({ prop: id, ...i }))) };
  },
  /** Render one frame at time t and return it as PNG data URL (QA stills / thumbnails / contact sheets). */
  still(t: number): string {
    const f = prod!.render(renderer!, t);
    lastIssues.splice(0, lastIssues.length, ...prod!.validateFrame(renderer!, f));
    return canvas!.toDataURL('image/png');
  },
  /** Evaluate (no draw) + validate a list of times; returns per-frame issues and hand contact errors. */
  analyze(times: number[]) {
    const out: Array<{ t: number; shot: string; issues: FrameIssue[]; handErrors: Record<string, number>; cam: number[] }> = [];
    for (const t of times) {
      const f = prod!.evaluate(t);
      out.push({ t, shot: f.shot.id, issues: prod!.validateFrame(renderer!, f), handErrors: f.handErrors, cam: [...f.cam.pos, ...f.cam.target] });
    }
    return out;
  },
  /** World-space probes for motion QA (foot slip, teleport detection). */
  probe(times: number[]) {
    return times.map((t) => {
      prod!.evaluate(t);
      const actors: Record<string, { root: number[]; soleL: number[]; soleR: number[]; head: number[]; stance: string | null }> = {};
      for (const [id, rig] of prod!.rigs) {
        const foot = (side: string, sole: { worldPos(): number[] }) => { const ys = rig.probes.filter((p) => p.name === `probe:toe_${side}` || p.name === `probe:heel_${side}`).map((p) => p.worldPos()[1]); const w = sole.worldPos(); return [w[0], Math.min(...ys), w[2]]; };
        actors[id] = { root: rig.root.worldPos(), soleL: foot('l', rig.sole_l), soleR: foot('r', rig.sole_r), head: rig.face.worldPos(), stance: prod!.tracks.get(id)!.lastStance ?? null };
      }
      const props: Record<string, { pos: number[]; visible: boolean; scale: number }> = {};
      for (const [id, p] of prod!.props) { const s = p.track.stateAt(t); props[id] = { pos: p.inst.root.worldPos(), visible: s.visible, scale: s.scale }; }
      return { t, actors, props };
    });
  },
  initCapture(cfg: { bitrate: number; hashEvery: number; keyframeInterval?: number }) {
    cap = new FrameCapture({ width: renderer!.width, height: renderer!.height, fps, bitrate: cfg.bitrate, keyframeInterval: cfg.keyframeInterval ?? fps * 2, codec: 'avc1.640028', hashEvery: cfg.hashEvery }, canvas!, () => renderer!.readPixels());
    return true;
  },
  encodeRange: (a: number, b: number, final: boolean) => cap!.encodeRange(a, b, (i) => { prod!.render(renderer!, i / fps); }, final),
  meta: () => cap!.meta,
  stats: () => renderer!.stats,
  encodeOpus: (pcmB64: string, sr: number, ch: number, br: number) => encodeOpus(pcmB64, sr, ch, br),
  lastIssues: () => lastIssues,
};
(window as unknown as { __spark: typeof api }).__spark = api;
