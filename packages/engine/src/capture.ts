// Browser-side deterministic frame capture + WebCodecs encode.
// Frames are rendered at t = frameIndex / fps (never wall-clock), so output is independent of render speed.

export interface CaptureConfig {
  width: number;
  height: number;
  fps: number;
  bitrate: number;
  keyframeInterval: number; // frames
  codec: string; // e.g. avc1.640028 (High@4.0)
  /** SHA-256 of raw pixels every N frames (0 = off) for determinism checks */
  hashEvery: number;
  /** DEBUG ONLY: burn a text label into frames (action reels). Never set for production renders. */
  overlay?: Array<{ from: number; to: number; text: string }> | null;
  /** Narrated drafts: burned-in caption chunks, shown for exactly [start, end) with the planned line breaks */
  captions?: Array<{ start: number; end: number; lines: string[]; emphasisWords: string[] }> | null;
  /** caption placement (fractions of the frame height): block centre and the bottom UI-safe margin kept clear */
  captionStyle?: { centerY: number; bottomSafe: number } | null;
}
/** caption text is plain words: pictographs / invisible format characters are never drawn (no tofu boxes) */
export const captionText = (s: string): string => s.replace(/[\p{Extended_Pictographic}\p{Cf}\p{Co}\u{FE0F}]/gu, '').replace(/\s+/g, ' ').trim();
const CAPTION_FONT = '"DejaVu Sans", "Liberation Sans", Arial, Helvetica, sans-serif';

export interface EncodedBatch {
  /** base64 of concatenated chunk payloads */
  b64: string;
  sizes: number[];
  keys: boolean[];
  hashes: Array<[number, string]>;
  renderMs: number;
  encodeWaitMs: number;
}

export interface EncoderMeta {
  avcCb64: string | null;
  colorSpace: { primaries?: string | null; transfer?: string | null; matrix?: string | null; fullRange?: boolean | null } | null;
  codec: string;
}

export function toB64(u8: Uint8Array): string {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + CH)));
  return btoa(s);
}
export function fromB64(b64: string): Uint8Array {
  const s = atob(b64);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}
/** SHA-256 of raw pixels: the SAME function the capture path uses for frame hashes (golden hashes depend on it) */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', data as unknown as ArrayBuffer));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

export class FrameCapture {
  private encoder: VideoEncoder;
  private pending: Array<{ data: Uint8Array; key: boolean }> = [];
  meta: EncoderMeta;
  private error: Error | null = null;

  private cfg: CaptureConfig;
  private canvas: HTMLCanvasElement;
  private readPixels: () => Uint8Array;
  constructor(cfg: CaptureConfig, canvas: HTMLCanvasElement, readPixels: () => Uint8Array) { this.cfg = cfg; this.canvas = canvas; this.readPixels = readPixels;
    this.meta = { avcCb64: null, colorSpace: null, codec: cfg.codec };
    this.encoder = new VideoEncoder({
      output: (chunk, md) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        this.pending.push({ data, key: chunk.type === 'key' });
        const dc = md?.decoderConfig;
        if (dc?.description && !this.meta.avcCb64) {
          const desc = dc.description instanceof ArrayBuffer ? new Uint8Array(dc.description) : new Uint8Array((dc.description as ArrayBufferView).buffer);
          this.meta.avcCb64 = toB64(desc);
        }
        if (dc?.colorSpace) this.meta.colorSpace = dc.colorSpace as EncoderMeta['colorSpace'];
      },
      error: (e) => { this.error = e as Error; },
    });
    this.encoder.configure({
      codec: cfg.codec, width: cfg.width, height: cfg.height, bitrate: cfg.bitrate, framerate: cfg.fps,
      bitrateMode: 'variable', latencyMode: 'quality', hardwareAcceleration: 'no-preference', avc: { format: 'avc' },
    } as VideoEncoderConfig);
  }

  private overlayCanvas: HTMLCanvasElement | null = null;
  /** debug label compositing (monospace system font is acceptable here: debug reels only) */
  private composite(i: number): HTMLCanvasElement {
    const c = this.overlayCanvas ?? (this.overlayCanvas = Object.assign(document.createElement('canvas'), { width: this.cfg.width, height: this.cfg.height }));
    const g = c.getContext('2d')!;
    g.drawImage(this.canvas, 0, 0);
    const t = i / this.cfg.fps;
    if (this.cfg.captions?.length) this.drawCaption(g, t);
    const lab = (this.cfg.overlay ?? []).find((o) => t >= o.from && t < o.to);
    if (lab) {
      const px = Math.round(this.cfg.height / 40);
      g.font = `bold ${px}px monospace`; g.fillStyle = 'rgba(0,0,0,0.65)'; g.fillRect(0, 0, this.cfg.width, px * 1.8);
      g.fillStyle = '#ffe44d'; g.fillText(lab.text, px * 0.5, px * 1.3);
    }
    return c;
  }

  /** lower-middle caption: white bold text, dark outline, emphasis in electric yellow; auto-fit to 90% width */
  private drawCaption(g: CanvasRenderingContext2D, t: number): void {
    const c = this.cfg.captions!.find((x) => t >= x.start - 1e-9 && t < x.end - 1e-9);
    if (!c) return;
    const W = this.cfg.width, H = this.cfg.height, st = this.cfg.captionStyle ?? { centerY: 0.72, bottomSafe: 0.16 };
    const lines = c.lines.map(captionText).filter(Boolean).slice(0, 2);
    const emph = new Set(c.emphasisWords.map((w) => w.toLowerCase()));
    let px = Math.round(H * 0.036);
    g.font = `800 ${px}px ${CAPTION_FONT}`;
    const widest = Math.max(...lines.map((l) => g.measureText(l).width));
    if (widest > W * 0.9) px = Math.floor((px * W * 0.9) / widest);
    g.font = `800 ${px}px ${CAPTION_FONT}`; g.textBaseline = 'middle'; g.lineJoin = 'round'; g.miterLimit = 2;
    const lh = px * 1.22, block = lh * lines.length;
    const top = Math.min(H * st.centerY - block / 2, H * (1 - st.bottomSafe) - block);
    lines.forEach((l, k) => {
      const words = l.split(' '), space = g.measureText(' ').width;
      const widths = words.map((w) => g.measureText(w).width), total = widths.reduce((a, b) => a + b, 0) + space * (words.length - 1);
      let x = (W - total) / 2;
      const y = top + lh * (k + 0.5);
      words.forEach((w, j) => {
        g.lineWidth = Math.max(2, px * 0.2); g.strokeStyle = 'rgba(8,10,16,0.95)'; g.strokeText(w, x, y);
        g.fillStyle = emph.has(w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').toLowerCase()) ? '#ffe600' : '#ffffff'; g.fillText(w, x, y);
        x += widths[j] + space;
      });
    });
  }

  /** Render + encode frames [from, to). renderFrame must draw frame i synchronously into the canvas. */
  async encodeRange(from: number, to: number, renderFrame: (i: number) => void, final: boolean): Promise<EncodedBatch> {
    let renderMs = 0, encodeWaitMs = 0;
    const hashes: Array<[number, string]> = [];
    for (let i = from; i < to; i++) {
      const t0 = performance.now();
      renderFrame(i);
      if (this.cfg.hashEvery && i % this.cfg.hashEvery === 0) hashes.push([i, await sha256Hex(this.readPixels())]);
      const src = this.cfg.overlay?.length || this.cfg.captions?.length ? this.composite(i) : this.canvas;
      const frame = new VideoFrame(src, { timestamp: Math.round((i * 1e6) / this.cfg.fps), duration: Math.round(1e6 / this.cfg.fps) });
      renderMs += performance.now() - t0;
      this.encoder.encode(frame, { keyFrame: i % this.cfg.keyframeInterval === 0 });
      frame.close();
      const t1 = performance.now();
      while (this.encoder.encodeQueueSize > 3) await new Promise((r) => setTimeout(r, 1));
      encodeWaitMs += performance.now() - t1;
      if (this.error) throw this.error;
    }
    if (final) await this.encoder.flush();
    if (this.error) throw this.error;
    const out = this.pending; this.pending = [];
    const total = out.reduce((s, c) => s + c.data.length, 0);
    const cat = new Uint8Array(total);
    let o = 0;
    for (const c of out) { cat.set(c.data, o); o += c.data.length; }
    return { b64: toB64(cat), sizes: out.map((c) => c.data.length), keys: out.map((c) => c.key), hashes, renderMs, encodeWaitMs };
  }
}

/** Encode interleaved float32 stereo PCM (48 kHz) to Opus packets with WebCodecs. */
export async function encodeOpus(pcmB64: string, sampleRate: number, channels: number, bitrate = 160000): Promise<{ b64: string; sizes: number[]; durations: number[]; descB64: string | null }> {
  const raw = fromB64(pcmB64);
  const pcm = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const packets: Array<{ data: Uint8Array; duration: number }> = [];
  let desc: Uint8Array | null = null;
  let err: Error | null = null;
  const ae = new AudioEncoder({
    output: (chunk, md) => {
      const d = new Uint8Array(chunk.byteLength); chunk.copyTo(d);
      packets.push({ data: d, duration: Math.round(((chunk.duration ?? 20000) * sampleRate) / 1e6) });
      const dd = md?.decoderConfig?.description;
      if (dd && !desc) desc = dd instanceof ArrayBuffer ? new Uint8Array(dd) : new Uint8Array((dd as ArrayBufferView).buffer);
    },
    error: (e) => { err = e as Error; },
  });
  ae.configure({ codec: 'opus', sampleRate, numberOfChannels: channels, bitrate, opus: { frameDuration: 20000, complexity: 10 } } as AudioEncoderConfig);
  const frames = pcm.length / channels;
  const block = 4800;
  for (let f = 0; f < frames; f += block) {
    const n = Math.min(block, frames - f);
    const data = pcm.subarray(f * channels, (f + n) * channels);
    const ad = new AudioData({ format: 'f32', sampleRate, numberOfFrames: n, numberOfChannels: channels, timestamp: Math.round((f * 1e6) / sampleRate), data: new Float32Array(data) });
    ae.encode(ad); ad.close();
  }
  await ae.flush();
  if (err) throw err;
  const total = packets.reduce((s, p) => s + p.data.length, 0);
  const cat = new Uint8Array(total);
  let o = 0;
  for (const p of packets) { cat.set(p.data, o); o += p.data.length; }
  const d: Uint8Array | null = desc;
  return { b64: toB64(cat), sizes: packets.map((p) => p.data.length), durations: packets.map((p) => p.duration), descB64: d ? toB64(d) : null };
}
