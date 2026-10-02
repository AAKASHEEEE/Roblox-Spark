// S6 staging / camera / multi-set run: analysis report + one still per beat.
//   node scripts/vignette-stage.ts [--sheet packages/director/fixtures/free-coins-classroom.beats.json] [--report out/director/report.json] [--out out/vignette/<id>]
//                                  [--no-stills] [--width 540 --height 960] [--extra 0.5,3.2 (extra stills at times)]
// Exit code 2 when the sheet is blocked (staging contract errors, camera safety blocked beats, coverage < 90 %).
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT } from '../apps/render-worker/lib/server.ts';
import { loadLibrary } from '../apps/render-worker/lib/library.ts';
import { launchBrowser } from '../apps/render-worker/lib/browser.ts';
import { ensureHeadlessCanvas } from '../packages/vignette/src/headless.ts';
import { runVignette, reportMarkdown } from '../packages/vignette/src/pipeline.ts';

const argv = process.argv.slice(2);
const arg = (n: string, d: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const sheetPath = resolve(ROOT, arg('sheet', 'packages/director/fixtures/free-coins-classroom.beats.json'));
const sheet = JSON.parse(readFileSync(sheetPath, 'utf8'));
const reportArg = arg('report', '');
const directorReport = reportArg ? JSON.parse(readFileSync(resolve(ROOT, reportArg), 'utf8')) : undefined;
const out = resolve(ROOT, arg('out', `out/vignette/${sheet.id}`));
const W = Number(arg('width', '540')), H = Number(arg('height', '960'));
mkdirSync(out, { recursive: true });

const lib = loadLibrary();
if (lib.errors.length) console.warn(`library: ${lib.errors.length} error(s): ${lib.errors.slice(0, 3).join('; ')}`);
const narrated = sheet.source?.narrated ? resolve(ROOT, sheet.source.narrated) : null;
const phrases = narrated && existsSync(narrated) ? (JSON.parse(readFileSync(narrated, 'utf8')).script?.phrases ?? []).map((p: { id: string; start: number; end: number; text: string }) => ({ id: p.id, start: p.start, end: p.end, text: p.text })) : undefined;

ensureHeadlessCanvas();
const T0 = Date.now();
const run = runVignette(sheet, lib, { ...(phrases?.length ? { phrases } : {}), ...(directorReport ? { directorReport } : {}), onProgress: (s, d, t) => process.stdout.write(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${s} ${d}/${t}\n`) });
const { report } = run;
console.log(`analysis in ${((Date.now() - T0) / 1000).toFixed(1)} s`);

// ---------------------------------------------------------------- stills (headless Chromium, WebGL2)
const stills: Record<string, string> = {};
if (!argv.includes('--no-stills')) {
  execFileSync('npx', ['tsc', '-p', 'tsconfig.web.json'], { cwd: ROOT, stdio: 'inherit' });
  const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
  const server = createServer((req, res) => {
    const rel = normalize(decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)).replace(/^\/+/, '');
    const file = join(ROOT, rel);
    if (!(rel.startsWith('dist/') || rel.startsWith('packages/vignette/web/')) || !file.startsWith(ROOT) || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 400, height: 700 } });
    page.on('pageerror', (e: Error) => console.error('page error:', e.message));
    await page.goto(`${url}/packages/vignette/web/stills.html`);
    await page.waitForFunction(() => (window as unknown as { __vignette?: { ready: boolean } }).__vignette?.ready, null, { timeout: 60000 });
    const libSub = { characters: lib.characters, props: lib.props, environments: lib.environments };
    await page.evaluate(([s, l, sh, w, h, compositions]: [unknown, unknown, unknown, number, number, unknown]) => (window as unknown as { __vignette: { load: (...a: unknown[]) => unknown } }).__vignette.load(s, l, sh, w, h, compositions), [sheet, libSub, run.shots, W, H, run.compositions]);
    mkdirSync(join(out, 'stills'), { recursive: true });
    for (const b of run.stage.beats) {
      const t = stillTime(b);
      const data: string = await page.evaluate((tt: number) => (window as unknown as { __vignette: { still: (t: number) => string } }).__vignette.still(tt), t);
      const file = join(out, 'stills', `${b.phraseId}.png`);
      writeFileSync(file, Buffer.from(data.split(',')[1], 'base64'));
      stills[b.phraseId] = relative(out, file);
      console.log(`still ${b.phraseId} @ ${t.toFixed(2)} s (${b.setId}, ${b.camera.recipeId})`);
    }
    // optional extra stills at given times: --extra 0.5,3.2
    for (const t of arg('extra', '').split(',').filter(Boolean).map(Number)) {
      const data: string = await page.evaluate((tt: number) => (window as unknown as { __vignette: { still: (t: number) => string } }).__vignette.still(tt), t);
      writeFileSync(join(out, 'stills', `t${t.toFixed(2)}.png`), Buffer.from(data.split(',')[1], 'base64'));
    }
  } finally { await browser.close(); server.close(); }
}

/** the beat's representative moment: its middle key time (an event / contact / arrival), else the middle */
function stillTime(b: { start: number; end: number; keyTimes: number[] }): number {
  const k = b.keyTimes.filter((t) => t > b.start + 0.3 && t < b.end - 0.2);
  return k.length ? k[Math.floor((k.length - 1) / 2)] : (b.start + b.end) / 2;
}

const stillTimes = Object.fromEntries(run.stage.beats.map((b) => [b.phraseId, Math.round(stillTime(b) * 1000) / 1000]));
writeFileSync(join(out, 'analysis-report.json'), JSON.stringify({ ...report, stills: Object.fromEntries(Object.entries(stills).map(([k, v]) => [k, { file: v, t: stillTimes[k] }])), timingSec: (Date.now() - T0) / 1000 }, null, 2));
writeFileSync(join(out, 'analysis-report.md'), reportMarkdown(report, stills));
writeFileSync(join(out, 'shots.json'), JSON.stringify(run.shots, null, 2));
const s = report.summary;
console.log(`${report.sheetId}: ${s.blocking ? 'BLOCKED' : 'PASS'} — coverage ${(s.coveragePct * 100).toFixed(1)}% (threshold ${(s.coverageThreshold * 100).toFixed(0)}%), cameras ${s.camerasAccepted} recipe / ${s.camerasFallback} fallback / ${s.camerasBlocked} blocked, staging ${s.stagingErrors} error(s) ${s.stagingWarnings} warning(s)`);
for (const r of s.reasons) console.log(`  ${r}`);
console.log(`report: ${relative(ROOT, join(out, 'analysis-report.md'))}`);
process.exit(s.blocking ? 2 : 0);
