// Independent AAC verification: decode our AAC-LC access units with Chromium's AAC decoder (WebCodecs AudioDecoder,
// FFmpeg-based) and compare against the source PCM. Used by tests and by the render worker's verification step.
import { launchBrowser } from './browser.ts';
import { startServer } from './server.ts';

export interface AacRoundTrip { ok: boolean; error?: string; decodedFrames: number; decodedSamples: number; snrDb: number[]; bestLag: number; peakAbsErr: number }

/** frames: raw AAC access units; ref: planar source PCM; priming: expected encoder delay in samples */
export async function aacRoundTrip(frames: Uint8Array[], asc: Uint8Array, ref: Float32Array[], priming: number, page?: any): Promise<AacRoundTrip> {
  let own: { browser: any; close: () => void } | null = null;
  if (!page) {
    const { server, url } = await startServer(0);
    const browser = await launchBrowser();
    page = await browser.newPage();
    await page.goto(`${url}/apps/studio/blank.html`);
    own = { browser, close: () => server.close() };
  }
  try {
    const total = frames.reduce((a, f) => a + f.length, 0);
    const cat = new Uint8Array(total); let o = 0; const sizes: number[] = [];
    for (const f of frames) { cat.set(f, o); o += f.length; sizes.push(f.length); }
    const dec = await page.evaluate(async ([b64, sizes, asc, ch]: [string, number[], number[], number]) => {
      const bin = atob(b64); const all = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) all[i] = bin.charCodeAt(i);
      const outs: Float32Array[][] = [];
      let err: string | null = null;
      const d = new AudioDecoder({ output: (ad) => { const planes: Float32Array[] = []; for (let c = 0; c < ad.numberOfChannels; c++) { const p = new Float32Array(ad.numberOfFrames); ad.copyTo(p, { planeIndex: c, format: 'f32-planar' }); planes.push(p); } outs.push(planes); ad.close(); }, error: (e) => { err = String(e); } });
      d.configure({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: ch, description: new Uint8Array(asc) });
      let off = 0;
      sizes.forEach((s, i) => { d.encode ? 0 : 0; d.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round((i * 1024 * 1e6) / 48000), data: all.subarray(off, off + s) })); off += s; });
      await d.flush();
      const n = outs.reduce((a, p) => a + p[0].length, 0);
      const res: string[] = [];
      for (let c = 0; c < ch; c++) { const buf = new Float32Array(n); let k = 0; for (const p of outs) { buf.set(p[c], k); k += p[c].length; } const u = new Uint8Array(buf.buffer); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(u.subarray(i, i + 0x8000))); res.push(btoa(s)); }
      return { err, frames: outs.length, n, planes: res };
    }, [Buffer.from(cat).toString('base64'), sizes, Array.from(asc), ref.length]);
    if (dec.err) return { ok: false, error: dec.err, decodedFrames: dec.frames, decodedSamples: dec.n, snrDb: [], bestLag: 0, peakAbsErr: 1 };
    const planes = dec.planes.map((b: string) => { const u = Buffer.from(b, 'base64'); return new Float32Array(u.buffer, u.byteOffset, u.byteLength / 4); });
    // find the alignment lag around the expected priming (decoders are allowed to differ in how they report delay)
    const n = ref[0].length;
    const corr = (lag: number) => { let s = 0; for (let i = 0; i < n; i += 7) { const j = i + lag; if (j >= 0 && j < planes[0].length) s += ref[0][i] * planes[0][j]; } return s; };
    let bestLag = priming, best = -Infinity;
    for (let lag = 0; lag <= 2 * priming; lag++) { const c = corr(lag); if (c > best) { best = c; bestLag = lag; } }
    const snrDb: number[] = []; let peak = 0;
    for (let c = 0; c < ref.length; c++) {
      let sig = 0, noise = 0;
      for (let i = 0; i < n; i++) { const d = (planes[c][i + bestLag] ?? 0) - ref[c][i]; sig += ref[c][i] * ref[c][i]; noise += d * d; peak = Math.max(peak, Math.abs(d)); }
      snrDb.push(+(10 * Math.log10(sig / Math.max(noise, 1e-20))).toFixed(2));
    }
    return { ok: true, decodedFrames: dec.frames, decodedSamples: dec.n, snrDb, bestLag, peakAbsErr: +peak.toFixed(5) };
  } finally {
    if (own) { await own.browser.close(); own.close(); }
  }
}
