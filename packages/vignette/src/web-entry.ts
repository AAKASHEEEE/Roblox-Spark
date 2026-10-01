// Browser entry for vignette stills/video: rebuilds the deterministic stage from BeatSheet + locked library and uses
// the solved cameras. The same renderAt(frame/fps) feeds PNG review stills and WebCodecs H.264 video.
import { Renderer } from '../../engine/src/gl/renderer.ts';
import { applyShake } from '../../engine/src/camera.ts';
import type { ManifestLibrary } from '../../engine/src/build-dispatch.ts';
import { validateBeatSheet } from '../../director/src/beat-sheet.ts';
import { stageBeatSheet, beatAt, type StagePlan } from './stage.ts';
import { VignetteScene } from './scene.ts';
import { poseAt, type ShotChoice } from './camera.ts';
import { drawVignetteOverlay } from './captions.ts';
import { registerRuntimeLibrary } from './runtime-library.ts';

let warm = false;
let canvas: HTMLCanvasElement | null = null, composite: HTMLCanvasElement | null = null, renderer: Renderer | null = null;
let scene: VignetteScene | null = null, plan: StagePlan | null = null, shots: Record<string, ShotChoice> = {};

function renderAt(t: number): HTMLCanvasElement {
  if (!scene || !plan || !renderer || !canvas || !composite) throw new Error('load() first');
  const f = scene.pose(t), b = beatAt(plan, t), shot = shots[b.phraseId];
  const p = poseAt(shot, b.start, t), fx = scene.vfx(f);
  const cam = applyShake({ pos: p.pos, target: p.target, fovY: (p.fovDeg * Math.PI) / 180, ...(p.roll ? { roll: p.roll } : {}) }, fx.shake, t, plan.seed);
  // The first draw uploads meshes/textures; warm once so frame zero is complete.
  const n = warm ? 1 : 2;
  for (let i = 0; i < n; i++) renderer.render(scene.root, cam, scene.lighting(f), fx.post, fx.particles);
  warm = true;
  const g = composite.getContext('2d')!;
  g.clearRect(0, 0, composite.width, composite.height);
  g.drawImage(canvas, 0, 0);
  drawVignetteOverlay(g, b, t, composite.width, composite.height);
  return composite;
}

const toB64 = (bytes: Uint8Array): string => {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
};

const api = {
  ready: true,
  load(sheet: unknown, lib: ManifestLibrary, s: Record<string, ShotChoice>, w: number, h: number) {
    const v = validateBeatSheet(sheet);
    if (!v.value) throw new Error('beat sheet invalid');
    // Browser and Node analysis are separate realms: register identical builders before staging/rendering.
    registerRuntimeLibrary(lib);
    plan = stageBeatSheet(v.value, lib);
    scene = new VignetteScene(plan, lib);
    shots = s; warm = false;
    if (!canvas) { canvas = document.createElement('canvas'); document.body.appendChild(canvas); }
    if (!composite) composite = document.createElement('canvas');
    composite.width = w; composite.height = h;
    if (!renderer || renderer.width !== w || renderer.height !== h) renderer = new Renderer(canvas, w, h);
    return { beats: plan.beats.length, sets: plan.sets.map((x) => x.id), duration: plan.duration };
  },
  still(t: number): string { return renderAt(t).toDataURL('image/png'); },
  async encode(duration: number, fps: number, bitrate: number): Promise<{ b64: string; frames: number; bytes: number; codec: string }> {
    if (!composite || !plan) throw new Error('load() first');
    if (!Number.isFinite(duration) || duration <= 0 || duration > plan.duration + 0.1) throw new Error('bad duration');
    if (!Number.isInteger(fps) || fps < 1 || fps > 60) throw new Error('bad fps');
    const codec = 'avc1.640028', chunks: Uint8Array[] = [];
    let failure: Error | null = null;
    const encoder = new VideoEncoder({
      output(chunk) { const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data); chunks.push(data); },
      error(error) { failure = error as Error; },
    });
    encoder.configure({ codec, width: composite.width, height: composite.height, bitrate, framerate: fps, latencyMode: 'quality', hardwareAcceleration: 'no-preference', avc: { format: 'annexb' } } as VideoEncoderConfig);
    const frames = Math.round(duration * fps);
    for (let i = 0; i < frames; i++) {
      const source = renderAt(i / fps);
      const frame = new VideoFrame(source, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
      encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 }); frame.close();
      while (encoder.encodeQueueSize > 4) await new Promise((resolve) => setTimeout(resolve, 1));
      if (failure) throw failure;
    }
    await encoder.flush(); encoder.close();
    if (failure) throw failure;
    const bytes = chunks.reduce((sum, x) => sum + x.byteLength, 0), joined = new Uint8Array(bytes);
    let offset = 0; for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
    return { b64: toB64(joined), frames, bytes, codec };
  },
  describe(t: number) { const b = plan ? beatAt(plan, t) : null; return b ? { beat: b.phraseId, set: b.setId } : null; },
};
(window as unknown as { __vignette: typeof api }).__vignette = api;
