// End-to-end: start the studio (`npm start`), load the UI in a browser, click "Render preview", wait for the MP4.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchBrowser } from '../apps/render-worker/lib/browser.ts';
import { ROOT } from '../apps/render-worker/lib/server.ts';

const port = 5199;
const srv = spawn(process.execPath, ['apps/studio/server.ts'], { cwd: ROOT, env: { ...process.env, PORT: String(port), NODE_OPTIONS: '' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise<void>((ok) => srv.stdout!.on('data', (d) => { process.stdout.write('[studio] ' + d); if (String(d).includes('running at')) ok(); }));
const b = await launchBrowser();
try {
  const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
  p.on('pageerror', (e: any) => console.error('[pageerror]', e));
  await p.goto(`http://localhost:${port}/apps/studio/player.html`);
  await p.waitForSelector('.beat');
  await p.click('.beat:nth-child(9)'); // seek via storyboard card
  await p.waitForTimeout(500);
  writeFileSync(join(ROOT, 'out/studio-ui.png'), await p.screenshot());
  const t0 = Date.now();
  await p.click('#renderPreview');
  await p.waitForSelector('.job video', { timeout: 20 * 60 * 1000 });
  const job = await p.evaluate(async () => (await fetch('/api/jobs')).json());
  writeFileSync(join(ROOT, 'out/studio-ui-rendered.png'), await p.screenshot());
  console.log(JSON.stringify({ uiRenderSeconds: (Date.now() - t0) / 1000, job: job[job.length - 1] }, null, 2));
} finally { await b.close(); srv.kill(); }
