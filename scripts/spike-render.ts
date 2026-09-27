// PHASE 1: prove headless deterministic frames -> H.264 -> MP4 without screen recording.
import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { launchBrowser } from '../apps/render-worker/lib/browser.ts';
import { startServer, ROOT } from '../apps/render-worker/lib/server.ts';
import { muxMp4 } from '../packages/mp4/src/mux.ts';
import { inspectMp4 } from '../packages/mp4/src/inspect.ts';
import { verifyPlayback } from '../apps/render-worker/lib/verify.ts';

const FRAMES = Number(process.env.SPIKE_FRAMES ?? 90);
const outDir = join(ROOT, 'out', 'spike');
mkdirSync(outDir, { recursive: true });

async function renderOnce(url: string, tag: string) {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  page.on('console', (m: any) => { if (m.type() === 'error') console.error('[page]', m.text()); });
  page.on('pageerror', (e: any) => console.error('[pageerror]', e));
  await page.goto(`${url}/apps/studio/spike.html`);
  await page.waitForFunction(() => (window as any).__spark?.ready);
  const info = await page.evaluate(() => (window as any).__spark.init({ hashEvery: 15 }));
  const t0 = Date.now();
  const samples: { data: Uint8Array; duration: number; isKey: boolean }[] = [];
  const hashes: Array<[number, string]> = [];
  let renderMs = 0;
  const BATCH = 30;
  for (let a = 0; a < FRAMES; a += BATCH) {
    const b = Math.min(FRAMES, a + BATCH);
    const r = await page.evaluate(([a, b, f]: [number, number, boolean]) => (window as any).__spark.encodeRange(a, b, f), [a, b, b === FRAMES]);
    const buf = Buffer.from(r.b64, 'base64');
    let o = 0;
    r.sizes.forEach((s: number, k: number) => { samples.push({ data: new Uint8Array(buf.subarray(o, o + s)), duration: 1000, isKey: r.keys[k] }); o += s; });
    hashes.push(...r.hashes); renderMs += r.renderMs;
  }
  const meta = await page.evaluate(() => (window as any).__spark.meta());
  const stats = await page.evaluate(() => (window as any).__spark.stats());
  await browser.close();
  const wall = Date.now() - t0;
  const mp4 = muxMp4({ video: { width: 1080, height: 1920, timescale: 30000, avcC: new Uint8Array(Buffer.from(meta.avcCb64, 'base64')), samples } });
  const file = join(outDir, `spike-${tag}.mp4`);
  writeFileSync(file, mp4);
  const sha = createHash('sha256').update(mp4).digest('hex');
  return { file, sha, wall, renderMs, frames: samples.length, hashes, info, stats, meta, bytes: mp4.length };
}

const { server, url } = await startServer(0);
try {
  const a = await renderOnce(url, 'a');
  const b = await renderOnce(url, 'b');
  const info = inspectMp4(new Uint8Array(await import('node:fs').then((f) => f.readFileSync(a.file))));
  const play = await verifyPlayback(url, 'out/spike/spike-a.mp4', [0.5, 1.5, 2.5], join(outDir, 'check'));
  const report = {
    renderer: a.info.renderer, frames: a.frames, bytes: a.bytes, wallMs: a.wall, msPerFrame: +(a.wall / a.frames).toFixed(1),
    renderOnlyMsPerFrame: +(a.renderMs / a.frames).toFixed(1), drawStats: a.stats,
    mp4: { duration: info.durationSec, tracks: info.tracks.map((t) => ({ codec: t.codec, w: t.width, h: t.height, n: t.sampleCount, fps: t.timescale / t.sampleDurations[0] })) },
    determinism: { mp4ShaA: a.sha, mp4ShaB: b.sha, identicalMp4: a.sha === b.sha, pixelHashesIdentical: JSON.stringify(a.hashes) === JSON.stringify(b.hashes), hashesChecked: a.hashes.length },
    colorSpace: a.meta.colorSpace, playback: play,
  };
  writeFileSync(join(outDir, 'spike-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  server.close();
}
