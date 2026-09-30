// Browser entry for the action frame strips (scripts/action-strips.ts drives it through Playwright).
// Renders each StripSpec with the real engine renderer and composes the frames side by side with labels.
import { Renderer, type Lighting } from '../../gl/renderer.ts';
import { hex } from '../../gl/scene.ts';
import { STRIP_SPECS, StripStage, type StripLibrary } from './strips.ts';

let renderer: Renderer | null = null;
let canvas: HTMLCanvasElement | null = null;
let library: StripLibrary | null = null;

function lighting(stage: StripStage): Lighting {
  const L = stage.env.lighting.morning ?? Object.values(stage.env.lighting)[0];
  return {
    sunDir: L.sunDir as [number, number, number], sunColor: hex(L.sunColor).map((c) => c * L.sunIntensity) as [number, number, number],
    skyColor: hex(L.sky).map((c) => c * L.ambientIntensity) as [number, number, number], groundColor: hex(L.ground).map((c) => c * L.ambientIntensity * 0.6) as [number, number, number],
    points: [], fogColor: hex(L.fog), fogNear: L.fogNear, fogFar: L.fogFar, exposure: L.exposure, shadowCenter: [stage.spec.from[0], 1, stage.spec.from[1]], shadowRadius: 4.5,
  };
}

const api = {
  ready: true,
  init(lib: StripLibrary, cellW = 240, cellH = 360) {
    library = lib;
    if (!canvas) { canvas = document.createElement('canvas'); document.body.appendChild(canvas); }
    renderer = new Renderer(canvas, cellW, cellH);
    return { renderer: renderer.gl.getParameter(renderer.gl.RENDERER) as string, specs: STRIP_SPECS.map((s) => s.name) };
  },
  /** render one strip: `frames` evenly spaced over the action, labelled with u and t; returns a JPEG data URL */
  strip(name: string, frames = 8): { png: string; times: number[] } {
    const spec = STRIP_SPECS.find((s) => s.name === name);
    if (!spec) throw new Error(`no strip ${name}`);
    const stage = new StripStage(spec, library!);
    const r = renderer!, W = r.width, H = r.height, pad = 4, head = 26, foot = 20;
    const out = document.createElement('canvas');
    out.width = frames * (W + pad) + pad; out.height = head + H + foot + pad;
    const g = out.getContext('2d')!;
    g.fillStyle = '#15171c'; g.fillRect(0, 0, out.width, out.height);
    g.fillStyle = '#fff'; g.font = 'bold 16px sans-serif'; g.fillText(spec.label, pad + 2, 18);
    const fs = stage.frames(frames);
    fs.forEach((f, i) => {
      stage.apply(f.t);
      r.render(stage.root, f.camera, lighting(stage), { vignette: 0.15, flash: 0 }, []);
      const x = pad + i * (W + pad);
      g.drawImage(canvas!, x, head);
      g.fillStyle = '#c9d1dc'; g.font = '13px monospace'; g.fillText(`u=${f.u.toFixed(2)}`, x + 4, head + H + 15);
    });
    return { png: out.toDataURL('image/jpeg', 0.86), times: fs.map((f) => f.t) };
  },
};
(window as unknown as { __strips: typeof api }).__strips = api;
