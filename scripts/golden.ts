// Golden frame hashes: one immutable set per (fixture, rendererVersion, motionProfile).
//   node scripts/golden.ts check [<episode.json> ...] [--all-frames]
//       verify fixtures against their golden files (default: every golden file, golden subset of frames)
//   node scripts/golden.ts record <episode.json> [--every 1] [--scale 1]
//       create the golden file for the fixture's DECLARED combination. Refuses to overwrite an existing golden file:
//       golden hashes are never re-recorded; a pixel change needs a new rendererVersion or motionProfile.
// Hash = SHA-256 of the raw RGBA framebuffer (renderer.readPixels) of frame i rendered at t = i / fps — the same bytes
// the render worker's capture path hashes, so goldens can come from either path.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { basename, join, relative, resolve } from 'node:path';
import { launchBrowser, findChromium } from '../apps/render-worker/lib/browser.ts';
import { startServer, ROOT } from '../apps/render-worker/lib/server.ts';
import { loadLibrary, canonical } from '../apps/render-worker/lib/library.ts';
import { ensureWebBuild } from '../apps/render-worker/render.ts';
import { resolveRenderCompat, canonicalJson, semanticContent, renderKey } from '../packages/schema/src/render-compat.ts';

export const GOLDEN_DIR = join(ROOT, 'tests', 'golden');
export interface GoldenFile {
  golden: 'blockspark.golden/1';
  fixture: string; episodeSha256: string; semanticSha256: string;
  rendererVersion: string; motionProfile: string; renderKey: string;
  resolution: [number, number]; fps: number; frames: number;
  /** frames the fast test path checks (all frames stay in frameHashes) */
  checkFrames: number[];
  hash: string;
  frameHashes: Array<[number, string]>;
  provenance: Record<string, unknown>;
}

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
export const episodeSha = (ep: unknown) => sha(canonical(ep));
export const semanticSha = (ep: unknown) => sha(canonicalJson(semanticContent(ep)));
export const goldenPath = (fixture: string, key: string) => join(GOLDEN_DIR, basename(fixture, '.json'), `${key}.json`);
export function readFixture(fixture: string): any { return JSON.parse(readFileSync(resolve(ROOT, fixture), 'utf8')); }
export function listGoldens(): GoldenFile[] {
  if (!existsSync(GOLDEN_DIR)) return [];
  return readdirSync(GOLDEN_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).flatMap((d) => readdirSync(join(GOLDEN_DIR, d.name)).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(GOLDEN_DIR, d.name, f), 'utf8')) as GoldenFile));
}
/** default subset for the fast check: every 15th frame plus the last frame */
export const subsetFrames = (n: number) => [...Array.from({ length: Math.ceil(n / 15) }, (_, i) => i * 15), n - 1].filter((v, i, a) => a.indexOf(v) === i);

/** a browser page with the render entry loaded (reuse across fixtures) */
export async function openRenderPage(): Promise<{ page: any; close: () => Promise<void> }> {
  ensureWebBuild(() => {});
  const { server, url } = await startServer(0);
  const browser = await launchBrowser();
  const page = await browser.newPage();
  await page.goto(`${url}/apps/studio/render.html`);
  await page.waitForFunction(() => (window as any).__spark?.ready);
  return { page, close: async () => { await browser.close(); server.close(); } };
}

/** load an episode (the engine enforces its declared versions) and hash frames */
export async function hashEpisodeFrames(page: any, ep: unknown, lib: unknown, frames: number[], res: [number, number]): Promise<Array<[number, string]>> {
  await page.evaluate(([e, l, w, h]: any) => (window as any).__spark.load(e, l, w, h), [ep, lib, res[0], res[1]]);
  const out: Array<[number, string]> = [];
  for (let a = 0; a < frames.length; a += 30) out.push(...(await page.evaluate((fs: number[]) => (window as any).__spark.hashFrames(fs), frames.slice(a, a + 30))));
  return out;
}

export function compareToGolden(g: GoldenFile, got: Array<[number, string]>): { compared: number; mismatched: number[] } {
  const want = new Map(g.frameHashes);
  const mismatched = got.filter(([i, h]) => want.get(i) !== h).map(([i]) => i);
  return { compared: got.length, mismatched };
}

/** a golden file only applies to the fixture content + declaration it was recorded for */
export function goldenAppliesTo(g: GoldenFile, ep: any): string | null {
  const key = renderKey(ep.render ?? { rendererVersion: '?', motionProfile: '?' });
  if (key !== g.renderKey) return `fixture declares ${key} but golden is ${g.renderKey}`;
  if (episodeSha(ep) !== g.episodeSha256) return `fixture content changed (episode sha ${episodeSha(ep).slice(0, 12)} != golden ${g.episodeSha256.slice(0, 12)}): record a NEW fixture instead of editing a golden one`;
  return null;
}

function gitHead(): string { try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT }).toString().trim(); } catch { return 'unknown'; } }

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, ...rest] = process.argv.slice(2);
  const flag = (n: string, d?: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
  const files = rest.filter((a, i) => !a.startsWith('--') && !(rest[i - 1] ?? '').startsWith('--'));
  const lib = loadLibrary();
  if (cmd === 'record') {
    const fixture = relative(ROOT, resolve(files[0] ?? ''));
    const ep = readFixture(fixture);
    const compat = resolveRenderCompat(ep); // throws on missing/unsupported declaration
    const out = goldenPath(fixture, compat.key);
    if (existsSync(out)) { console.error(`refusing to overwrite ${relative(ROOT, out)}: golden hashes are immutable (new pixels need a new rendererVersion or motionProfile)`); process.exit(1); }
    const scale = Number(flag('scale', '1')), every = Number(flag('every', '1'));
    const res: [number, number] = [Math.round(1080 * scale), Math.round(1920 * scale)];
    const N = Math.round(ep.episode.duration * ep.episode.fps);
    const frames = Array.from({ length: N }, (_, i) => i).filter((i) => i % every === 0 || i === N - 1);
    const t0 = Date.now();
    const { page, close } = await openRenderPage();
    const hashes = await hashEpisodeFrames(page, ep, lib, frames, res);
    await close();
    const g: GoldenFile = {
      golden: 'blockspark.golden/1', fixture, episodeSha256: episodeSha(ep), semanticSha256: semanticSha(ep),
      rendererVersion: compat.decl.rendererVersion, motionProfile: compat.decl.motionProfile, renderKey: compat.key,
      resolution: res, fps: ep.episode.fps, frames: N, checkFrames: subsetFrames(N).filter((i) => frames.includes(i)), hash: 'sha256(raw RGBA readPixels, frame i at t=i/fps)', frameHashes: hashes,
      provenance: { recordedAt: new Date().toISOString(), commit: gitHead(), method: 'scripts/golden.ts record (fast path: render + readPixels + SHA-256, no encode)', chromium: findChromium(), renderSeconds: (Date.now() - t0) / 1000 },
    };
    mkdirSync(join(GOLDEN_DIR, basename(fixture, '.json')), { recursive: true });
    writeFileSync(out, JSON.stringify(g, null, 1) + '\n');
    console.log(`recorded ${relative(ROOT, out)}: ${hashes.length} frames at ${res.join('x')} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } else if (cmd === 'check') {
    const goldens = listGoldens().filter((g) => !files.length || files.map((f) => relative(ROOT, resolve(f))).includes(g.fixture));
    if (!goldens.length) { console.error('no golden files matched'); process.exit(1); }
    const { page, close } = await openRenderPage();
    let bad = 0;
    for (const g of goldens) {
      const ep = readFixture(g.fixture);
      const why = goldenAppliesTo(g, ep);
      if (why) { console.log(`FAIL ${g.fixture} [${g.renderKey}]: ${why}`); bad++; continue; }
      const frames = process.argv.includes('--all-frames') ? g.frameHashes.map(([i]) => i) : g.checkFrames;
      const t0 = Date.now();
      const r = compareToGolden(g, await hashEpisodeFrames(page, ep, lib, frames, g.resolution));
      console.log(`${r.mismatched.length ? 'FAIL' : 'OK  '} ${g.fixture} [${g.renderKey}] ${r.compared - r.mismatched.length}/${r.compared} frames identical at ${g.resolution.join('x')} (${((Date.now() - t0) / 1000).toFixed(1)}s)${r.mismatched.length ? ' mismatched: ' + r.mismatched.slice(0, 12).join(',') : ''}`);
      if (r.mismatched.length) bad++;
    }
    await close();
    process.exit(bad ? 1 : 0);
  } else { console.error('usage: golden.ts check|record ...'); process.exit(1); }
}
