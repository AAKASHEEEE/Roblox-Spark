// Character and face stills (S3): turnarounds, cast lineup, crowd variants, the expression sheet and Kira's before/after.
// Usage: npm run build && node scripts/character-stills.ts [--out docs/characters] [--only turnaround,expressions,kira,crowd,lineup]
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchBrowser } from '../apps/render-worker/lib/browser.ts';
import { startServer, ROOT } from '../apps/render-worker/lib/server.ts';
import { loadLibrary } from '../apps/render-worker/lib/library.ts';

const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
const outDir = join(ROOT, arg('--out') ?? 'docs/characters');
const only = new Set((arg('--only') ?? 'turnaround,expressions,kira,crowd,lineup').split(','));
mkdirSync(outDir, { recursive: true });

const lib = loadLibrary({ enforceLock: false });
if (lib.errors.length) { console.error('library issues:\n  ' + lib.errors.join('\n  ')); process.exit(1); }
const semver = (a: string, b: string) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
const latest = (id: string) => Object.values(lib.characters).filter((m) => m.id === id).sort((a, b) => semver(b.version, a.version))[0];
const CAST = ['zapp', 'kira', 'teacher', 'mom', 'dad', 'friend_boy', 'friend_girl', 'noob', 'pro', 'crowd_kid'];
const V2 = ['big_grin', 'laugh', 'furious', 'scream', 'shocked', 'scared', 'sad', 'crying', 'suspicious', 'sleepy', 'evil_grin', 'confused', 'love_eyes'];
const MOUTHS = ['closed', 'open', 'wide', 'o'];

const { server, url } = await startServer(0);
const browser = await launchBrowser();
const save = (name: string, data: string) => { writeFileSync(join(outDir, name), Buffer.from(data.split(',')[1], 'base64')); console.log('->', join(outDir, name)); };
try {
  const page = await browser.newPage();
  page.on('pageerror', (e: any) => console.error('[pageerror]', e));
  page.on('console', (m: any) => { if (m.type() === 'error' && !m.text().includes('404')) console.error('[page]', m.text()); });
  await page.goto(`${url}/apps/studio/blank.html`);
  await page.addScriptTag({ type: 'module', url: '/dist/packages/engine/src/faces/lookdev.js' });
  await page.waitForFunction(() => (window as any).__lookdev?.ready);
  const shot = (actors: unknown[], framing: unknown, w = 540, h = 960): Promise<string> => page.evaluate(([a, f, w, h]: any) => (window as any).__lookdev.shot(a, f, w, h), [actors, framing, w, h]);
  const compose = (urls: string[], labels: string[], cols: number, cw: number, ch: number, title: string): Promise<string> => page.evaluate(([u, l, c, w, h, t]: any) => (window as any).__lookdev.compose(u, l, c, w, h, t), [urls, labels, cols, cw, ch, title]);
  const crop = (u: string, x: number, y: number, w: number, h: number, outW?: number): Promise<string> => page.evaluate(([u, x, y, w, h, o]: any) => (window as any).__lookdev.crop(u, x, y, w, h, o ?? w), [u, x, y, w, h, outW]);

  if (only.has('turnaround')) {
    const yaws = [0, 45, 90, 135, 180];
    for (const id of CAST) {
      const m = latest(id);
      const urls: string[] = [];
      for (const y of yaws) urls.push(await shot([{ manifest: m, yawDeg: y }], { fit: 'full' }));
      save(`turnaround-${id}.png`, await compose(urls, yaws.map((y) => `${y}°`), yaws.length, 360, 640, `${m.displayName} — ${id}@${m.version} turnaround (540x960 renders)`));
    }
  }
  if (only.has('lineup')) {
    const ms = CAST.map(latest);
    const actors = ms.map((m, i) => ({ manifest: m, x: (i - (ms.length - 1) / 2) * 1.05, state: m.allowedExpressions[0] }));
    const img = await shot(actors, { fit: 'group', fovDeg: 28 }, 1920, 1080);
    save('lineup.png', await compose([img], [ms.map((m) => m.id).join('  ')], 1, 1920, 1080, 'Cast lineup (height comparison, default expressions)'));
  }
  if (only.has('crowd')) {
    const m = latest('crowd_kid');
    const seeds = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const actors = seeds.map((s, i) => ({ manifest: m, x: (i - (seeds.length - 1) / 2) * 0.82, seed: s, state: 'neutral' }));
    const img = await shot(actors, { fit: 'group', fovDeg: 26 }, 1920, 1080);
    save('crowd_kid-variants.png', await compose([img], [`seeds ${seeds.join(', ')} (seed 0 = manifest colours)`], 1, 1920, 1080, 'crowd_kid colour variants (decorate(rig, { seed }))'));
  }
  if (only.has('expressions')) {
    // native pixels: each cell is cut 1:1 out of a 540x960 frame whose head is 18% of frame height (camera-safety medium minimum)
    const rows = ['zapp', 'kira', 'teacher', 'friend_boy', 'friend_girl', 'dad'];
    const cols = [...V2.map((s) => ({ state: s, mouth: null as string | null, label: s })), ...MOUTHS.map((mo) => ({ state: 'neutral', mouth: mo, label: `talk:${mo}` }))];
    const urls: string[] = [], labels: string[] = [];
    for (const id of rows) {
      const m = latest(id);
      for (const c of cols) {
        const state = c.state === 'neutral' && !(m.face.states as Record<string, unknown>).neutral ? m.allowedExpressions[0] : c.state;
        const full = await shot([{ manifest: m, state, mouth: c.mouth }], { fit: 0.18, orbitDeg: 0 });
        urls.push(await crop(full, 150, 318, 240, 240)); labels.push(`${id}:${c.label}`.slice(0, 22));
      }
    }
    save('expression-sheet.png', await compose(urls, labels, cols.length, 240, 240, 'Face set v2 (13 planned expressions) + talking mouth shapes — native 540x960 pixels, head = 18% of frame height'));
    // one uncropped frame so the crop scale is verifiable
    save('expression-frame-540.png', await shot([{ manifest: latest('teacher'), state: 'furious' }], { fit: 0.18 }));
  }
  if (only.has('kira')) {
    const before = lib.characters['kira@1.1.0'], after = latest('kira');
    const yaws = [0, 30, 45, 60];
    const urls: string[] = [], labels: string[] = [];
    for (const sign of [1, -1]) for (const [tag, m] of [['1.1.0', before], [after.version, after]] as const) for (const y of yaws) {
      const full = await shot([{ manifest: m, yawDeg: sign * y, state: sign > 0 ? 'smug' : 'surprised' }], { fit: 0.3 });
      urls.push(await crop(full, 70, 200, 400, 400)); labels.push(`kira@${tag} yaw ${sign * y}°`);
    }
    save('kira-1.2.0-before-after.png', await compose(urls, labels, yaws.length, 400, 400, `Kira side hair: 1.1.0 (rows 1, 3) vs ${after.version} (rows 2, 4); close framing, head = 30% of frame height`));
    const fb = [await shot([{ manifest: before, state: 'smug' }], { fit: 'full' }), await shot([{ manifest: after, state: 'smug' }], { fit: 'full' })];
    save('kira-1.2.0-full-body.png', await compose(fb, ['kira@1.1.0', `kira@${after.version}`], 2, 540, 960, 'Kira identity check (full body, front)'));
  }
} finally { await browser.close(); server.close(); }
