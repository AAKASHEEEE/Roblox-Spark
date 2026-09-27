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
