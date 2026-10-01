// Browser entry for vignette stills/video. Scene validation, builder registration, exact-time posing and final camera
// calculation are shared with the S7 renderer through VignetteRenderSession so review pixels cannot drift from video.
import type { ManifestLibrary } from '../../engine/src/build-dispatch.ts';
import type { ShotChoice, CameraComposition } from './camera.ts';
import { beatAt } from './stage.ts';
import { drawVignetteOverlay } from './captions.ts';
import { VignetteRenderSession } from '../../captions/src/preview/vignette-render-session.ts';

let composite: HTMLCanvasElement | null = null, session: VignetteRenderSession | null = null;

function renderAt(t: number): HTMLCanvasElement {
  if (!session || !composite) throw new Error('load() first');
  const frame = session.frame(t);
  session.render(frame);
  const g = composite.getContext('2d')!;
  g.clearRect(0, 0, composite.width, composite.height);
  g.drawImage(session.canvas, 0, 0);
  drawVignetteOverlay(g, frame.beat, t, composite.width, composite.height);
  return composite;
}

const toB64 = (bytes: Uint8Array): string => {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
};

const api = {
  ready: true,
  load(sheet: unknown, lib: ManifestLibrary, shots: Record<string, ShotChoice>, w: number, h: number, compositions: readonly CameraComposition[] = []) {
    session = new VignetteRenderSession({ sheet, library: lib, shots, compositions, width: w, height: h });
    if (!composite) composite = document.createElement('canvas');
    composite.width = w; composite.height = h;
    return { beats: session.plan.beats.length, sets: session.plan.sets.map((x) => x.id), duration: session.plan.duration, compositions: session.compositions.length };
  },
  still(t: number): string { return renderAt(t).toDataURL('image/png'); },
  async encode(duration: number, fps: number, bitrate: number): Promise<{ b64: string; frames: number; bytes: number; codec: string }> {
    if (!composite || !session) throw new Error('load() first');
    if (!Number.isFinite(duration) || duration <= 0 || duration > session.plan.duration + 0.1) throw new Error('bad duration');
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
  describe(t: number) { const b = session ? beatAt(session.plan, t) : null; return b ? { beat: b.phraseId, set: b.setId } : null; },
};
(window as unknown as { __vignette: typeof api }).__vignette = api;
