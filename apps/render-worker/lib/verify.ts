// Independent verification: decode the produced MP4 with Chromium's media stack (not our encoder path),
// check metadata, seek to timestamps, and dump decoded frames as PNG for visual QA / contact sheets.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchBrowser } from './browser.ts';

export interface PlaybackCheck {
  ok: boolean;
  videoWidth: number;
  videoHeight: number;
  duration: number;
  audioDecodedBytes: number;
  videoDecodedBytes: number;
  framesDecodedDuringPlay: number;
  droppedFrames: number;
  playedSeconds: number;
  errors: string[];
  frameFiles: string[];
}

/** Decode frames at times from an MP4 and compute mean absolute pixel difference between pairs (loop match check). */
export async function decodeCompare(page: any, src: string, pairs: Array<[number, number]>): Promise<number[]> {
  return page.evaluate(async ([src, pairs]: [string, Array<[number, number]>]) => {
    const v = document.createElement('video'); v.muted = true; v.src = src; document.body.appendChild(v);
    await new Promise<void>((ok) => { v.onloadeddata = () => ok(); });
    const c = document.createElement('canvas'); c.width = 270; c.height = 480; const g = c.getContext('2d', { willReadFrequently: true })!;
    const grab = async (t: number) => { await new Promise<void>((ok) => { v.onseeked = () => ok(); v.currentTime = t; }); g.drawImage(v, 0, 0, 270, 480); return g.getImageData(0, 0, 270, 480).data; };
    const out: number[] = [];
    for (const [a, b] of pairs) { const A = await grab(a), B = await grab(b); let s = 0; for (let i = 0; i < A.length; i += 4) s += Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]); out.push(s / (A.length / 4) / 3 / 255); }
    return out;
  }, [src, pairs]);
}

/** Decode the MP4's audio with Chromium's demuxer+decoder (edit list applied) and measure alignment vs the source mix. */
export async function mp4AudioAlignment(page: any, src: string, ref: Float32Array): Promise<{ lagSamples: number; lagMs: number; decodedSamples: number; snrDb: number; error?: string }> {
  const res = await page.evaluate(async (src: string) => {
    try {
      const buf = await (await fetch(src)).arrayBuffer();
      const ctx = new OfflineAudioContext(2, 48000, 48000);
      const ab = await ctx.decodeAudioData(buf);
      const d = ab.getChannelData(0);
      const u = new Uint8Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength)); let s = '';
      for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(u.subarray(i, i + 0x8000)));
      return { sr: ab.sampleRate, n: ab.length, b64: btoa(s) };
    } catch (e) { return { error: String(e) }; }
  }, src);
  if (res.error) return { lagSamples: NaN, lagMs: NaN, decodedSamples: 0, snrDb: 0, error: res.error };
  const u = Buffer.from(res.b64, 'base64'); const dec = new Float32Array(u.buffer, u.byteOffset, u.byteLength / 4);
  let best = -Infinity, lag = 0;
  for (let L = -2048; L <= 2048; L++) { let c = 0; for (let i = 4096; i < ref.length - 4096; i += 11) c += ref[i] * (dec[i + L] ?? 0); if (c > best) { best = c; lag = L; } }
  let sig = 0, noise = 0; for (let i = 0; i < ref.length; i++) { const e = (dec[i + lag] ?? 0) - ref[i]; sig += ref[i] * ref[i]; noise += e * e; }
  return { lagSamples: lag, lagMs: (lag / 48000) * 1000, decodedSamples: res.n, snrDb: +(10 * Math.log10(sig / Math.max(noise, 1e-20))).toFixed(2) };
}

export async function verifyPlayback(baseUrl: string, relPath: string, times: number[], outDir: string, playSeconds = 2): Promise<PlaybackCheck> {
  mkdirSync(outDir, { recursive: true });
  const browser = await launchBrowser();
  const page = await browser.newPage();
  await page.goto(`${baseUrl}/apps/studio/blank.html`);
  const res = await page.evaluate(async ([src, times, playSeconds]: [string, number[], number]) => {
    const errors: string[] = [];
    const v = document.createElement('video');
    v.muted = true; v.preload = 'auto'; v.src = src; v.crossOrigin = 'anonymous';
    document.body.appendChild(v);
    await new Promise<void>((ok) => { v.onloadeddata = () => ok(); v.onerror = () => { errors.push('media error ' + (v.error?.code ?? '?') + ' ' + (v.error?.message ?? '')); ok(); }; });
    const frames: string[] = [];
    if (!errors.length) {
      const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
      const g = c.getContext('2d')!;
      for (const t of times) {
        await new Promise<void>((ok) => { v.onseeked = () => ok(); v.currentTime = t; });
        g.drawImage(v, 0, 0); frames.push(c.toDataURL('image/png'));
      }
      v.currentTime = 0;
      await new Promise((r) => setTimeout(r, 100));
      const q0 = v.getVideoPlaybackQuality();
      await v.play().catch((e) => errors.push('play: ' + e));
      const start = performance.now();
      await new Promise((r) => setTimeout(r, playSeconds * 1000));
      v.pause();
      const q = v.getVideoPlaybackQuality();
      const anyV = v as any;
      return { ok: true, videoWidth: v.videoWidth, videoHeight: v.videoHeight, duration: v.duration, audioDecodedBytes: anyV.webkitAudioDecodedByteCount ?? -1, videoDecodedBytes: anyV.webkitVideoDecodedByteCount ?? -1, framesDecodedDuringPlay: q.totalVideoFrames - q0.totalVideoFrames, droppedFrames: q.droppedVideoFrames, playedSeconds: v.currentTime, playWallSeconds: (performance.now() - start) / 1000, errors, frames };
    }
    return { ok: false, videoWidth: 0, videoHeight: 0, duration: 0, audioDecodedBytes: 0, videoDecodedBytes: 0, framesDecodedDuringPlay: 0, droppedFrames: 0, playedSeconds: 0, errors, frames };
  }, [`${baseUrl}/${relPath}`, times, playSeconds]);
  await browser.close();
  const frameFiles: string[] = [];
  res.frames.forEach((d: string, i: number) => {
    const f = join(outDir, `decoded_t${times[i].toFixed(2)}.png`);
    writeFileSync(f, Buffer.from(d.split(',')[1], 'base64'));
    frameFiles.push(f);
  });
  delete res.frames;
  return { ...res, ok: res.ok && res.errors.length === 0, frameFiles };
}
