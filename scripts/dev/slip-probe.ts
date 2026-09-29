// dev: G21-style planted-foot slip per frame for an episode file (which actor/action produces the slip samples)
// node scripts/dev/slip-probe.ts <episode.json> [minSpeed=0.3]
import { readFileSync } from 'node:fs';
import { launchBrowser } from '../../apps/render-worker/lib/browser.ts';
import { startServer } from '../../apps/render-worker/lib/server.ts';
import { loadLibrary } from '../../apps/render-worker/lib/library.ts';
import { ensureWebBuild } from '../../apps/render-worker/render.ts';
const [file] = process.argv.slice(2);
const ep = JSON.parse(readFileSync(file, 'utf8')); const lib = loadLibrary(); ensureWebBuild(() => {});
const { server, url } = await startServer(0); const browser = await launchBrowser(); const page = await browser.newPage();
await page.goto(`${url}/apps/studio/render.html`); await page.waitForFunction(() => (window as any).__spark?.ready);
await page.evaluate(([e, l]: any) => (window as any).__spark.load(e, l, 270, 480), [ep, lib]);
const fps = ep.episode.fps, N = Math.round(ep.episode.duration * fps);
const times = Array.from({ length: N }, (_, i) => i / fps);
const P: any[] = []; for (let a = 0; a < N; a += 60) P.push(...(await page.evaluate((ts: number[]) => (window as any).__spark.probe(ts), times.slice(a, a + 60))));
const actionAt = (id: string, t: number) => ep.actions.filter((x: any) => x.actor === id && t >= x.start && t < x.start + x.duration).map((x: any) => x.action).join('+') || '-';
const rows: any[] = [];
for (let i = 2; i < P.length; i++) for (const id of Object.keys(P[i].actors)) {
  const z = P[i - 2].actors[id], a = P[i - 1].actors[id], b = P[i].actors[id];
  if (!a.stance || a.stance !== b.stance) continue;
  const s = b.stance === 'l' ? 'soleL' : 'soleR';
  const rv = Math.hypot(b.root[0] - a.root[0], b.root[2] - a.root[2]) * fps; if (rv <= 0.3) continue;
  if (b[s][1] >= 0.02 || a[s][1] >= 0.02 || z.stance !== a.stance) continue;
  const v = Math.hypot(b[s][0] - a[s][0], b[s][2] - a[s][2]) * fps;
  rows.push({ t: +P[i].t.toFixed(3), id, action: actionAt(id, P[i].t), rootV: +rv.toFixed(2), slip: +v.toFixed(3), footY: +b[s][1].toFixed(3) });
}
const by: Record<string, number[]> = {}; for (const r of rows) (by[r.action] ??= []).push(r.slip);
for (const [k, v] of Object.entries(by)) { v.sort((x, y) => x - y); console.log(k.padEnd(14), 'n', v.length, 'median', v[Math.floor(v.length / 2)].toFixed(3), 'p95', v[Math.floor(v.length * 0.95)].toFixed(3), 'max', v[v.length - 1].toFixed(3)); }
for (const r of rows.filter((r) => r.slip > 0.3).slice(0, 25)) console.log(JSON.stringify(r));
await browser.close(); server.close();
