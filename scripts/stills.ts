// Render QA stills at given times (for fast visual iteration + contact sheets). Usage: node scripts/stills.ts 0.5 3.9 ...
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchBrowser } from '../apps/render-worker/lib/browser.ts';
import { startServer, ROOT } from '../apps/render-worker/lib/server.ts';
import { loadLibrary } from '../apps/render-worker/lib/library.ts';
import { contactSheet } from '../apps/render-worker/lib/sheet.ts';

const args = process.argv.slice(2);
const epFile = process.env.EPISODE ?? 'episodes/free-coins-loop-001.json';
const scaleDiv = Number(process.env.STILL_DIV ?? 2);
const times = args.map(Number);
const ep = JSON.parse(readFileSync(join(ROOT, epFile), 'utf8'));
const lib = loadLibrary({ enforceLock: false });
if (lib.errors.length) console.warn('library issues:', lib.errors);
const outDir = join(ROOT, 'out', 'stills');
mkdirSync(outDir, { recursive: true });
const { server, url } = await startServer(0);
const browser = await launchBrowser();
try {
  const page = await browser.newPage();
  page.on('pageerror', (e: any) => console.error('[pageerror]', e));
  page.on('console', (m: any) => { if (m.type() === 'error') console.error('[page]', m.text()); });
  await page.goto(`${url}/apps/studio/render.html`);
  await page.waitForFunction(() => (window as any).__spark?.ready);
  const info = await page.evaluate(([e, l, w, h]: any) => (window as any).__spark.load(e, l, w, h), [ep, lib, 1080 / scaleDiv, 1920 / scaleDiv]);
  console.log(JSON.stringify(info));
  const urls: string[] = [];
  for (const t of times) {
    const d = await page.evaluate((t: number) => (window as any).__spark.still(t), t);
    const issues = await page.evaluate(() => (window as any).__spark.lastIssues());
    urls.push(d);
    if (process.env.SAVE_EACH) writeFileSync(join(outDir, `t${t.toFixed(2)}.png`), Buffer.from(d.split(',')[1], 'base64'));
    console.log(`t=${t.toFixed(2)}`, issues.length ? JSON.stringify(issues.map((i: any) => i.code + ':' + i.message)) : 'ok');
  }
  const sheet = await contactSheet(page, urls, times.map((t) => `${t.toFixed(2)}s`), Number(process.env.COLS ?? 4), 270);
  const name = process.env.SHEET ?? 'sheet';
  writeFileSync(join(outDir, `${name}.png`), Buffer.from(sheet.split(',')[1], 'base64'));
  console.log('sheet ->', join(outDir, `${name}.png`));
} finally { await browser.close(); server.close(); }
