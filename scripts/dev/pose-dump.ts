// dev: dump pose samples of one actor over a window of an episode file (action-reel debugging)
// node scripts/dev/pose-dump.ts <episode.json> <actor> <from> <to> [target]
import { readFileSync } from 'node:fs';
import { launchBrowser } from '../../apps/render-worker/lib/browser.ts';
import { startServer } from '../../apps/render-worker/lib/server.ts';
import { loadLibrary } from '../../apps/render-worker/lib/library.ts';
import { ensureWebBuild } from '../../apps/render-worker/render.ts';
const [file, actor, from, to, target] = process.argv.slice(2);
const ep = JSON.parse(readFileSync(file, 'utf8')); const lib = loadLibrary(); ensureWebBuild(() => {});
const { server, url } = await startServer(0); const browser = await launchBrowser(); const page = await browser.newPage();
await page.goto(`${url}/apps/studio/render.html`); await page.waitForFunction(() => (window as any).__spark?.ready);
await page.evaluate(([e, l]: any) => (window as any).__spark.load(e, l, 270, 480), [ep, lib]);
const times: number[] = []; for (let t = Number(from); t <= Number(to) + 1e-6; t += 0.1) times.push(+t.toFixed(3));
const P = await page.evaluate(([ts, a, tg]: any) => (window as any).__spark.pose(ts, a, tg), [times, actor, target]);
for (const p of P) { const want = p.target ? Math.atan2(p.target[0] - p.head[0], p.target[2] - p.head[2]) * 180 / Math.PI : NaN; console.log(p.t.toFixed(2), 'yaw', p.yaw.toFixed(1), 'faceYaw', p.faceYaw.toFixed(1), 'want', want.toFixed(1), 'head', p.head.map((x: number) => x.toFixed(2)).join(','), 'fwdY', p.fwdY.toFixed(2)); }
await browser.close(); server.close();
