// Motion diagnostics: prints per-frame root speed, foot heights and planted-foot slip for one actor.
//   node scripts/diag-motion.ts <actor> <from> <to>
import { readFileSync } from 'node:fs';
import { launchBrowser } from '../apps/render-worker/lib/browser.ts';
import { startServer, ROOT } from '../apps/render-worker/lib/server.ts';
import { loadLibrary } from '../apps/render-worker/lib/library.ts';

const [actor = 'zapp', from = '0', to = '1.6'] = process.argv.slice(2);
const ep = JSON.parse(readFileSync(ROOT + '/' + (process.env.EPISODE ?? 'episodes/free-coins-loop-001.json'), 'utf8'));
const lib = loadLibrary({ enforceLock: false });
const { server, url } = await startServer(0);
const b = await launchBrowser();
const p = await b.newPage();
await p.goto(url + '/apps/studio/render.html');
await p.waitForFunction(() => (window as any).__spark?.ready);
await p.evaluate(([e, l]: any) => (window as any).__spark.load(e, l, 270, 480), [ep, lib]);
const fps = 30;
const ts: number[] = [];
for (let t = Number(from); t <= Number(to); t += 1 / fps) ts.push(t);
const pr = await p.evaluate((t: number[]) => (window as any).__spark.probe(t), ts);
for (let i = 1; i < pr.length; i++) {
  const a = pr[i - 1].actors[actor], c = pr[i].actors[actor];
  const sp = (k: string) => (Math.hypot(c[k][0] - a[k][0], c[k][2] - a[k][2]) * fps).toFixed(2);
  console.log(pr[i].t.toFixed(2), 'root v', sp('root'), '| L y', c.soleL[1].toFixed(3), 'v', sp('soleL'), '| R y', c.soleR[1].toFixed(3), 'v', sp('soleR'));
}
await b.close();
server.close();
