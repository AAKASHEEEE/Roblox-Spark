// Lists planted-foot slip samples (same definition as gate G21) over the whole episode.
import { readFileSync } from 'node:fs';
import { launchBrowser } from '../apps/render-worker/lib/browser.ts';
import { startServer, ROOT } from '../apps/render-worker/lib/server.ts';
import { loadLibrary } from '../apps/render-worker/lib/library.ts';
const ep = JSON.parse(readFileSync(ROOT + '/episodes/free-coins-loop-001.json', 'utf8'));
const { server, url } = await startServer(0); const b = await launchBrowser(); const p = await b.newPage();
await p.goto(url + '/apps/studio/render.html'); await p.waitForFunction(() => (window as any).__spark?.ready);
await p.evaluate(([e, l]: any) => (window as any).__spark.load(e, l, 270, 480), [ep, loadLibrary()]);
const pr = await p.evaluate((t: number[]) => (window as any).__spark.probe(t), Array.from({ length: 510 }, (_, i) => i / 30));
for (let i = 2; i < pr.length; i++) for (const id of Object.keys(pr[i].actors)) {
  const z = pr[i - 2].actors[id], a = pr[i - 1].actors[id], c = pr[i].actors[id];
  if (!a.stance || a.stance !== c.stance) continue;
  const s = c.stance === 'l' ? 'soleL' : 'soleR';
  const mv = Math.hypot(c.root[0] - a.root[0], c.root[2] - a.root[2]) * 30;
  if (mv > 0.3 && c[s][1] < 0.02 && a[s][1] < 0.02) console.log(id, pr[i].t.toFixed(2), 'slip', (Math.hypot(c[s][0] - a[s][0], c[s][2] - a[s][2]) * 30).toFixed(2), 'root', mv.toFixed(2), 'prevStanceSame', z.stance === a.stance, 'y', a[s][1].toFixed(3), c[s][1].toFixed(3));
}
await b.close(); server.close();
