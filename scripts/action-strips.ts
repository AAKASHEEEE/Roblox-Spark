// Frame strip per library action (S5 stills): renders every StripSpec (packages/engine/src/animation/lib/strips.ts)
// with the real engine renderer and writes one JPEG per action plus an index.
//   node scripts/action-strips.ts [--out docs/animation/strips] [--frames 8] [--only sit,grab]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchBrowser } from '../apps/render-worker/lib/browser.ts';
import { startServer, ROOT } from '../apps/render-worker/lib/server.ts';
import { loadLibrary } from '../apps/render-worker/lib/library.ts';
import { ensureWebBuild } from '../apps/render-worker/render.ts';

const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const outDir = join(ROOT, arg('--out', 'docs/animation/strips'));
const frames = Number(arg('--frames', '8'));
const only = arg('--only', '').split(',').filter(Boolean);
mkdirSync(outDir, { recursive: true });

ensureWebBuild((s) => console.log(s));
const lib = loadLibrary({ enforceLock: true });
if (lib.errors.length) throw new Error(`library: ${lib.errors.join('; ')}`);
const { server, url } = await startServer(0);
const browser = await launchBrowser();
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e: any) => errors.push(String(e)));
  await page.goto(`${url}/apps/studio/blank.html`);
  await page.addScriptTag({ type: 'module', url: '/dist/packages/engine/src/animation/lib/strip-entry.js' });
  await page.waitForFunction(() => (window as any).__strips?.ready);
  const info = await page.evaluate((l: any) => (window as any).__strips.init(l), { characters: lib.characters, props: lib.props, environments: lib.environments });
  console.log(`renderer: ${info.renderer}; ${info.specs.length} strips`);
  const names: string[] = info.specs.filter((n: string) => !only.length || only.includes(n));
  const index: Array<{ name: string; file: string; times: number[] }> = [];
  for (const n of names) {
    const r = await page.evaluate(([name, f]: [string, number]) => (window as any).__strips.strip(name, f), [n, frames] as [string, number]);
    const file = `${n}.jpg`;
    writeFileSync(join(outDir, file), Buffer.from(r.png.split(',')[1], 'base64'));
    index.push({ name: n, file, times: r.times.map((t: number) => Math.round(t * 1000) / 1000) });
    console.log(`  ${n}`);
  }
  if (errors.length) throw new Error(`page errors:\n${errors.join('\n')}`);
  if (!only.length) {
    const md = ['# Action frame strips', '', `One strip per library action, ${frames} frames evenly spaced over the action (u = 0..1), rendered with the engine renderer.`,
      'Props are grey-box placeholders named with the S4 anchor roles until S4\'s props land; mouths use the placeholder mouth states until S3 lands.', '',
      'Regenerate: `node scripts/action-strips.ts`.', '', ...index.map((e) => `## ${e.name}\n\n![${e.name}](${e.file})\n`)];
    writeFileSync(join(outDir, 'README.md'), md.join('\n'));
    writeFileSync(join(outDir, 'index.json'), JSON.stringify({ frames, strips: index }, null, 2) + '\n');
  }
  console.log(`-> ${outDir}`);
} finally { await browser.close(); server.close(); }
