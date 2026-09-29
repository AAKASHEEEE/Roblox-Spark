// dev: per-frame root / stance / sole trace of one actor over a window (locomotion onset debugging)
// node scripts/dev/feet-trace.ts <episode.json> <actor> <from> <to>
import { readFileSync } from 'node:fs';
import { launchBrowser } from '../../apps/render-worker/lib/browser.ts';
import { startServer } from '../../apps/render-worker/lib/server.ts';
import { loadLibrary } from '../../apps/render-worker/lib/library.ts';
import { ensureWebBuild } from '../../apps/render-worker/render.ts';
const [file, actor, from, to] = process.argv.slice(2);
const ep = JSON.parse(readFileSync(file, 'utf8')); const lib = loadLibrary(); ensureWebBuild(() => {});
const { server, url } = await startServer(0); const browser = await launchBrowser(); const page = await browser.newPage();
await page.goto(`${url}/apps/studio/render.html`); await page.waitForFunction(() => (window as any).__spark?.ready);
await page.evaluate(([e, l]: any) => (window as any).__spark.load(e, l, 270, 480), [ep, lib]);
const fps = ep.episode.fps; const times: number[] = [];
for (let i = Math.round(Number(from) * fps); i <= Math.round(Number(to) * fps); i++) times.push(i / fps);
const P = await page.evaluate((ts: number[]) => (window as any).__spark.probe(ts), times);
const f = (v: number[]) => v.map((x) => x.toFixed(3)).join(',');
for (let i = 1; i < P.length; i++) {
  const a = P[i - 1].actors[actor], b = P[i].actors[actor];
  const sp = (k: string) => (Math.hypot(b[k][0] - a[k][0], b[k][2] - a[k][2]) * fps).toFixed(3);
  console.log(P[i].t.toFixed(3), 'st', b.stance ?? '-', 'rootV', (Math.hypot(b.root[0] - a.root[0], b.root[2] - a.root[2]) * fps).toFixed(3), 'L', f(b.soleL), 'vL', sp('soleL'), 'R', f(b.soleR), 'vR', sp('soleR'));
}
await browser.close(); server.close();
