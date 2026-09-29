// Drives the supervised workflow in a real browser against `npm start` (apps/studio/server.ts): one screenshot per UI state
// (docs/studio/*.png), a browser-refresh check, and ONE real render of the brief's example idea (known-compatible sample).
//   node scripts/studio-screenshots.ts [--preview]   (default: final 1080x1920; --preview: 540x960)
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchBrowser } from '../apps/render-worker/lib/browser.ts';
import { ROOT } from '../apps/render-worker/lib/server.ts';

const IDEA = 'Zapp presses a free-coins button, celebrates, and the coin becomes too large.';
const UNSAFE = 'Kira waits behind the door with a cricket bat for Zapp.'; // frozen held-out-2 sample (HB14)
const port = 5197, quality = process.argv.includes('--preview') ? 'preview' : 'final';
const dir = join(ROOT, 'docs/studio');
mkdirSync(dir, { recursive: true });
const srv = spawn(process.execPath, ['apps/studio/server.ts'], { cwd: ROOT, env: { ...process.env, PORT: String(port), NODE_OPTIONS: '' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise<void>((ok) => srv.stdout!.on('data', (d) => { process.stdout.write(`[studio] ${d}`); if (String(d).includes('running at')) ok(); }));
const b = await launchBrowser();
const t0 = Date.now(), T: Record<string, number | string | boolean> = {};
const lap = (k: string) => { T[k] = +((Date.now() - t0) / 1000).toFixed(1); };
try {
  const p = await b.newPage({ viewport: { width: 1320, height: 900 } });
  p.on('pageerror', (e: unknown) => console.error('[pageerror]', e));
  const ready = () => p.waitForSelector('#engine option:nth-child(2)', { state: 'attached' });
  await p.goto(`http://localhost:${port}/`); await ready();
  await p.evaluate(() => localStorage.clear()); await p.reload(); await ready();
  const fill = async (idea: string) => { await p.fill('#idea', idea); await p.fill('#duration', '17'); await p.fill('#seed', '17'); };
  await fill(IDEA);
  await p.screenshot({ path: join(dir, '1-create.png') }); lap('create');
  await fill(UNSAFE); await p.click('#generate');
  await p.waitForSelector('#storyboard .panel.bad', { timeout: 120000 });
  T.unsafeApproveDisabled = await p.$eval('[data-act=approve]', (e) => (e as HTMLButtonElement).disabled);
  await p.screenshot({ path: join(dir, '2-rejected.png') }); lap('rejected');
  await p.click('[data-act=back]'); await fill(IDEA); await p.click('#generate');
  await p.waitForSelector('#storyboard .card', { timeout: 180000 });
  T.cards = await p.$$eval('#storyboard .card', (x) => x.length);
  await p.screenshot({ path: join(dir, '3-storyboard.png'), fullPage: true }); lap('storyboard');
  await p.click('[data-act=approve]');
  await p.waitForSelector('#approved .panel.good');
  await p.screenshot({ path: join(dir, '4-approved.png') }); lap('approved');
  await p.reload(); await p.waitForSelector('#approved .panel.good', { timeout: 30000 });
  T.refreshKeepsApproval = true;
  await p.selectOption('#quality', quality);
  await p.click('[data-act=render]');
  await p.waitForFunction(() => document.querySelector('#render ol.stages li.on')?.textContent === 'Rendering', null, { timeout: 300000 });
  await p.waitForTimeout(8000);
  await p.screenshot({ path: join(dir, '5-rendering.png') }); lap('renderingShot');
  await p.waitForSelector('#render video, #render .panel.bad', { timeout: 25 * 60 * 1000 }); lap('renderFinished');
  await p.waitForFunction(() => ((document.querySelector('#render video') as HTMLVideoElement | null)?.readyState ?? 0) >= 1, null, { timeout: 15000 }).then(() => { T.videoLoaded = true; }, () => { T.videoLoaded = false; });
  await p.screenshot({ path: join(dir, '6-complete.png') });
  await p.reload(); await p.waitForSelector('#render video, #render .panel.bad', { timeout: 30000 });
  T.refreshKeepsResult = true;
  const job = await p.evaluate(async () => { const all = await (await fetch('/api/jobs')).json(); return all[all.length - 1]; });
  for (const k of ['mp4', 'episodeJson']) T[`http_${k}`] = await p.evaluate(async (u: string) => (await fetch(u)).status, job.outputs[k]);
  console.log(JSON.stringify({ timings: T, job: { id: job.id, state: job.state, stage: job.stage, error: job.error, gates: job.gates, quality: job.quality, media: job.media, outputs: job.outputs, renderSeconds: job.finishedAt && job.startedAt ? (job.finishedAt - job.startedAt) / 1000 : null } }, null, 1));
} finally { await b.close(); srv.kill(); }
