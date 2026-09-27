// Prints an actor's hand positions vs a prop anchor over a time range: node scripts/diag-hand.ts zapp button.press_surface 1.0 1.6
import { readFileSync } from 'node:fs';
import { launchBrowser } from '../apps/render-worker/lib/browser.ts';
import { startServer, ROOT } from '../apps/render-worker/lib/server.ts';
import { loadLibrary } from '../apps/render-worker/lib/library.ts';
const [actor, anchor, a, b] = process.argv.slice(2);
const ep = JSON.parse(readFileSync(ROOT + '/episodes/free-coins-loop-001.json', 'utf8'));
const { server, url } = await startServer(0); const br = await launchBrowser(); const p = await br.newPage();
await p.goto(url + '/apps/studio/render.html'); await p.waitForFunction(() => (window as any).__spark?.ready);
await p.evaluate(([e, l]: any) => (window as any).__spark.load(e, l, 270, 480), [ep, loadLibrary()]);
const rows = await p.evaluate(([actor, anchor, a, b]: any) => (window as any).__spark.hands(actor, anchor, Number(a), Number(b)), [actor, anchor, a, b]);
for (const r of rows) console.log(r);
await br.close(); server.close();
