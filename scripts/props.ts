// S4 prop library tooling.
//   node scripts/props.ts write   write new manifests from the authoring catalog (packages/engine/src/props) into
//                                 assets/props; refuses to change an existing file (publish a new version instead).
//                                 Then run `npm run assets:lock`.
//   node scripts/props.ts check   catalog self-check + authoring catalog == files on disk
//   node scripts/props.ts sheet   render QA stills into assets/props/stills (prop sheet with Zapp, states, anchors)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, startServer } from '../apps/render-worker/lib/server.ts';
import { canonical, loadLibrary } from '../apps/render-worker/lib/library.ts';
import { launchBrowser } from '../apps/render-worker/lib/browser.ts';
import { ensureWebBuild } from '../apps/render-worker/render.ts';
import type { PropManifest } from '../packages/schema/src/assets.ts';
import { LEGACY_PROP_IDS, NEW_PROPS, PLANNED_PROP_IDS, checkPropCatalog, legacyRevision } from '../packages/engine/src/props/index.ts';

const PROPS_DIR = join(ROOT, 'assets', 'props');
const file = (m: { id: string; version: string }) => join(PROPS_DIR, `${m.id}@${m.version}.json`);
const legacy100 = (id: string): PropManifest => JSON.parse(readFileSync(join(PROPS_DIR, `${id}@1.0.0.json`), 'utf8'));
const authored = (): PropManifest[] => [...NEW_PROPS, ...LEGACY_PROP_IDS.map((id) => legacyRevision(legacy100(id)))];

function write(): void {
  let added = 0, same = 0;
  const refused: string[] = [];
  for (const m of authored()) {
    const f = file(m);
    if (existsSync(f)) {
      if (canonical(JSON.parse(readFileSync(f, 'utf8'))) === canonical(m)) same++;
      else refused.push(`${m.id}@${m.version}`);
      continue;
    }
    writeFileSync(f, JSON.stringify(m, null, 2) + '\n'); added++;
  }
  console.log(`props: ${added} written, ${same} unchanged`);
  if (refused.length) { console.error(`REFUSED (published manifests differ from the catalog; bump the version):\n  ${refused.join('\n  ')}`); process.exit(1); }
}

function check(): number {
  const lib = loadLibrary({ enforceLock: true });
  const mine = authored();
  const issues = [...lib.errors.filter((e) => e.includes('props/')), ...checkPropCatalog(mine)];
  for (const m of mine) {
    const disk = lib.props[`${m.id}@${m.version}`];
    if (!disk) issues.push(`${m.id}@${m.version}: not published in assets/props (run write)`);
    else if (canonical(disk) !== canonical(m)) issues.push(`${m.id}@${m.version}: published manifest differs from the authoring catalog`);
  }
  console.log(issues.length ? `prop check: ${issues.length} issue(s)\n  ${issues.join('\n  ')}` : `prop check: clean (${mine.length} manifests: ${PLANNED_PROP_IDS.length} new, ${LEGACY_PROP_IDS.length} legacy revisions)`);
  return issues.length;
}

type Cell = Record<string, unknown> & { label: string; sub?: string };
const dims = (m: PropManifest) => m.dimensions.map((d) => d.toFixed(2)).join(' X ') + ' M';
/** per-prop view tweaks so the scale shot reads (car in side view, bed at an angle to show its length) */
const VIEW: Record<string, { yaw?: number; az?: number; el?: number }> = {
  car: { yaw: 90, az: 18, el: 10 }, bed: { yaw: 60 }, couch: { az: 18 }, door: { az: 20 }, sign_board: { az: 14 }, tv: { az: 14 },
  phone: { el: 16 }, laptop: { az: 18 }, spark_coin: { el: 16 },
};

async function sheet(): Promise<void> {
  ensureWebBuild((s) => console.log(s));
  const lib = loadLibrary({ enforceLock: false });
  const zapp = lib.characters['zapp@1.0.0'];
  const ids = [...PLANNED_PROP_IDS.map((id) => `${id}@1.0.0`), ...LEGACY_PROP_IDS.map((id) => `${id}@1.1.0`)];
  const props = ids.map((k) => { const m = lib.props[k]; if (!m) throw new Error(`${k} missing: run write + assets:lock first`); return m; });
  const P = (id: string) => props.find((m) => m.id === id)!;
  const outDir = join(PROPS_DIR, 'stills');
  mkdirSync(outDir, { recursive: true });
  const { server, url } = await startServer(0);
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e: unknown) => console.error('[pageerror]', e));
    page.on('console', (m: { type(): string; text(): string }) => { if (m.type() === 'error') console.error('[page]', m.text()); });
    await page.goto(`${url}/apps/studio/blank.html`);
    await page.addScriptTag({ type: 'module', url: '/dist/packages/engine/src/props/preview.js' });
    await page.waitForFunction(() => (window as any).__props?.ready);
    const render = async (name: string, title: string, cells: Cell[], cols: number, w: number, h: number) => {
      const urls: Array<{ url: string; label: string; sub?: string }> = [];
      for (const c of cells) {
        const { label, sub, ...opts } = c;
        urls.push({ url: await page.evaluate((o: unknown) => (window as any).__props.cell(o), { ...opts, w, h }), label, sub });
      }
      const png = await page.evaluate(([u, c, ww, hh, t]: any) => (window as any).__props.compose(u, c, ww, hh, t), [urls, cols, w, h, title]);
      writeFileSync(join(outDir, `${name}.png`), Buffer.from(png.split(',')[1], 'base64'));
      console.log(`${name}.png: ${cells.length} cells`);
    };

    // 1) every prop next to Zapp (small props get a close-up inset)
    await render('prop-sheet', 'PROP LIBRARY - EVERY PROP NEXT TO ZAPP (1.93 M) - FLOOR GRID 0.5 M', props.map((m) => ({ prop: m, zapp, ...VIEW[m.id], label: `${m.id} ${m.version}`, sub: dims(m) })), 7, 360, 450);

    // 2) states
    const S = (id: string, state: string, extra: Record<string, unknown> = {}, label = `${id} ${state}`): Cell => ({ prop: P(id), zapp, zappAt: 'none', state, ...VIEW[id], ...extra, label });
    await render('prop-states', 'PROP STATES', [
      S('door', 'closed', { wall: true, zappAt: 'use_front' }, 'door closed (in wall)'),
      S('door', 'ajar', { wall: true }), S('door', 'open', { wall: true, u: 0.5 }, 'door opening u=0.5'),
      S('door', 'open', { wall: true, zappAt: 'use_front' }, 'door open (in wall)'),
      S('door', 'open', { wall: true, az: 200, el: 14 }, 'door open (back side)'),
      S('phone', 'screen_off', { el: 45 }), S('phone', 'screen_on', { el: 45 }),
      S('laptop', 'closed', { el: 25 }), S('laptop', 'open', { el: 25 }), S('laptop', 'closed', { el: 25, u: 0.5 }, 'laptop closing u=0.5'),
      S('fridge', 'door_closed', { zappAt: 'use_front' }), S('fridge', 'door_open', { zappAt: 'use_front' }), S('fridge', 'door_open', { az: 0, el: 8 }, 'fridge door_open front'),
      S('tv', 'off'), S('tv', 'on'),
      S('car', 'parked', { yaw: 0, az: 35, el: 22 }), S('car', 'driving', { yaw: 0, az: 35, el: 22, steer: 25, u: 0.3 }, 'car driving steer 25'),
      S('car', 'parked', { yaw: 90, az: 0, el: 4, roll: 0.45 }, 'car rolled 0.45 m (wheels)'),
      S('lamp', 'off'), S('lamp', 'on'), S('stove', 'off', { el: 35 }), S('stove', 'on', { el: 35 }),
      S('gift_box', 'closed', { el: 20 }), S('gift_box', 'open', { el: 20 }), S('trash_can', 'closed', { el: 20 }), S('trash_can', 'open', { el: 20 }),
      S('pizza', 'whole', { el: 40 }), S('pizza', 'slice', { el: 40 }),
    ], 7, 320, 380);

    // 3) anchor contract: G = grip, S = surface, F = floor on every prop
    await render('prop-anchors', 'ANCHORS: G = GRIP  S = SURFACE  F = FLOOR', props.map((m) => ({ prop: m, zappAt: 'none', markers: true, ...VIEW[m.id], el: Math.max(VIEW[m.id]?.el ?? 12, 20), label: m.id })), 7, 300, 300);
  } finally { await browser.close(); server.close(); }
}

const cmd = process.argv[2];
if (cmd === 'write') write();
else if (cmd === 'check') process.exit(check() ? 1 : 0);
else if (cmd === 'sheet') await sheet();
else { console.error('usage: node scripts/props.ts write|check|sheet'); process.exit(2); }
