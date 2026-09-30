// S7 stills: caption_bold, ui_popup, title_card, world_text_3d, every planned VFX and the emote icons, rendered over the
// approved narrated scene (same WorldState poses and safe cameras as the narrated draft render).
//   node packages/captions/tools/render-stills.ts [--out packages/captions/stills]
// Captions come from the aligned phrases (beat sheet beats = one per aligned phrase; director highlights are hints).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { launchBrowser } from '../../../apps/render-worker/lib/browser.ts';
import { startServer, ROOT } from '../../../apps/render-worker/lib/server.ts';
import { loadLibrary, sha256 } from '../../../apps/render-worker/lib/library.ts';
import { contactSheet } from '../../../apps/render-worker/lib/sheet.ts';
import { draftEpisodeFor, prepareIntegration } from '../../../apps/studio/narrated-draft.ts';
import { compileNarratedTimeline } from '../../narrated/src/timeline.ts';
import { validateEpisode } from '../../pipeline/src/validate.ts';
import { planBoldCaptions, phrasesFromBeats, checkBoldPlan, type BoldCaption } from '../src/bold.ts';
import { textGraphicsFromBeats, type TextGraphicEvent } from '../src/graphics.ts';
import type { VfxEvent } from '../../engine/src/vfx/runtime.ts';

const { values: a } = parseArgs({ options: { out: { type: 'string', default: 'packages/captions/stills' }, storyboard: { type: 'string', default: 'tests/fixtures/narrated/approved-narrated-v0.1.json' }, beats: { type: 'string', default: 'packages/director/fixtures/free-coins-classroom.beats.json' } } });
const outDir = join(ROOT, a.out!);
mkdirSync(outDir, { recursive: true });
const sbText = readFileSync(join(ROOT, a.storyboard!), 'utf8'), sb = JSON.parse(sbText), sha = sha256(sbText);
const sheet = JSON.parse(readFileSync(join(ROOT, a.beats!), 'utf8'));
const lib = loadLibrary();
if (lib.errors.length) throw new Error(lib.errors.join('; '));

// integrated timeline: reuse the narrated analysis output when it matches this storyboard, else compute it
const cache = join(ROOT, 'out/narrated-continuity-integration/render-timeline.json');
let integrated: any = existsSync(cache) ? JSON.parse(readFileSync(cache, 'utf8')).integrated : null;
if (!integrated || integrated.storyboardSha256 !== sha) { console.log('integrating narrated storyboard (camera safety pass)...'); integrated = prepareIntegration(sb, sha, lib).integrated; }
const tl = compileNarratedTimeline(sb, sha);
const v = validateEpisode(draftEpisodeFor(sb, tl, lib), lib as never, { repair: true, profile: 'narrated-draft' });
if (!v.ok || !v.episode) throw new Error('draft episode invalid');

// captions from the aligned phrases
const phrases = phrasesFromBeats(sheet.beats);
const plan = planBoldCaptions(phrases);
const bad = checkBoldPlan(phrases, plan);
if (bad.length) throw new Error(`caption plan invariants: ${bad.join('; ')}`);
const beatGraphics = textGraphicsFromBeats(sheet.beats);
// demo graphics for styles the fixture does not use yet
const demoGraphics: TextGraphicEvent[] = [
  ...beatGraphics,
  { textStyleId: 'world_text_3d', at: 21.2, duration: 4.2, text: 'FREE COINS!', target: 'suspicious_button' },
  { textStyleId: 'title_card', at: 59.86, duration: 1.4, text: '5 minutes later...' },
];

const W = 1080, H = 1920;
execFileSync(join(ROOT, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.web.json'], { cwd: ROOT, stdio: 'inherit' });
const { server, url } = await startServer(0);
const browser = await launchBrowser();
const index: Array<{ file: string; group: string; label: string; t: number; notes?: unknown }> = [];
try {
  const page = await browser.newPage({ viewport: { width: 400, height: 400 } });
  page.on('pageerror', (e: any) => console.error('[pageerror]', e));
  page.on('console', (m: any) => { if (m.type() === 'error') console.error('[page]', m.text()); });
  await page.goto(`${url}/apps/studio/blank.html`);
  await page.addScriptTag({ type: 'module', url: '/dist/packages/captions/src/preview/stills-page.js' });
  await page.waitForFunction(() => (window as any).__s7?.ready);
  console.log(await page.evaluate(([e, l, s, i, w, h]: any) => (window as any).__s7.init(e, l, s, i, w, h), [v.episode, lib, sb, integrated, W, H]));
  type PlacementResult = { segments: Array<{ start: number; end: number; centerY: number; clearOfFaces: boolean; faceOverlapPx: number; warnings: string[] }>; centerY: number; clearOfFaces: boolean; faceOverlapPx: number; warnings: string[] };
  const placements: Record<string, PlacementResult> = await page.evaluate(([c, g]: any) => (window as any).__s7.place(c, g), [plan.captions, demoGraphics]);
  const placementSegments = Object.fromEntries(Object.entries(placements).map(([k, p]) => [k, p.segments]));
  const save = (name: string, dataUrl: string) => { writeFileSync(join(outDir, name), Buffer.from(dataUrl.split(',')[1], 'base64')); return name; };
  const frame = async (f: { t: number; vfx?: VfxEvent[]; graphics?: TextGraphicEvent[]; captions?: BoldCaption[]; showBoxes?: boolean }) => (await page.evaluate(([f, p]: any) => (window as any).__s7.frame({ ...f, placements: p }), [f, placementSegments])) as { url: string; faces: any[] };
  const capAt = (id: string) => plan.captions.find((c) => c.id === id)!;
  const mid = (c: BoldCaption) => +(c.start + Math.min(0.5, (c.end - c.start) * 0.6)).toFixed(3);

  // ---------------- caption_bold
  const capIds = ['p01-b02', 'p02-b02', 'p03-b02', 'p05-b02', 'p06-b01', 'p07-b01', 'p10-b01', 'p12-b02', 'p13-b02', 'p14-b03'];
  const capUrls: string[] = [], boxUrls: string[] = [], labels: string[] = [];
  for (const id of capIds) {
    const c = capAt(id), t = mid(c);
    const f = await frame({ t, captions: plan.captions });
    const file = save(`caption_bold-${id}.jpg`, f.url);
    capUrls.push(f.url); labels.push(`${id} ${c.display.join(' ')}`);
    boxUrls.push((await frame({ t, captions: plan.captions, showBoxes: true })).url);
    index.push({ file, group: 'caption_bold', label: `${id}: "${c.words.join(' ')}" highlight=${c.highlight} (${c.highlightColor})`, t, notes: placements[id] });
  }
  save('sheet-caption_bold.jpg', await contactSheet(page, capUrls, labels, 5, 270));
  save('sheet-caption_bold-face-boxes.jpg', await contactSheet(page, boxUrls, capIds.map((id) => `${id} faces (dashed)`), 5, 270));
  const pc = capAt('p06-b01'), pcMid = mid(pc);
  const pcY = placements[pc.id].segments.find((s) => pcMid >= s.start && pcMid < s.end)?.centerY ?? placements[pc.id].centerY;
  save('caption_bold-pop-in.jpg', await page.evaluate(([c, y, ts, t]: any) => (window as any).__s7.popStrip(c, y, ts, t), [pc, pcY, [0.0, 0.02, 0.04, 0.06, 0.09, 0.13, 0.3], pcMid]));
  index.push({ file: 'caption_bold-pop-in.jpg', group: 'caption_bold', label: 'pop-in: +0 / 20 / 40 / 60 / 90 / 130 / 300 ms', t: pc.start });

  // ---------------- graphics styles
  const gUrls: string[] = [], gLabels: string[] = [];
  const gShot = async (name: string, label: string, t: number, withCaption = true) => {
    const f = await frame({ t, graphics: demoGraphics, captions: withCaption ? plan.captions : [] });
    save(name, f.url); gUrls.push(f.url); gLabels.push(label); index.push({ file: name, group: 'graphics', label, t });
  };
  await gShot('ui_popup-plus1coin-in.jpg', 'ui_popup +1 COIN (pop-in, 0.1 s)', 36.1);
  await gShot('ui_popup-plus1coin.jpg', 'ui_popup +1 COIN (held)', 36.8);
  await gShot('title_card-in.jpg', 'title_card (slide-in, 0.14 s)', 60.0, false);
  await gShot('title_card.jpg', 'title_card (held)', 60.7, false);
  await gShot('world_text_3d-in.jpg', 'world_text_3d FREE COINS! (pop-in)', 21.32, false);
  await gShot('world_text_3d.jpg', 'world_text_3d FREE COINS!', 22.4);
  save('sheet-graphics.jpg', await contactSheet(page, gUrls, gLabels, 3, 270));

  // ---------------- planned VFX + emotes
  const fx: Array<[string, VfxEvent, number]> = [
    ['sparkle', { vfxId: 'sparkle', at: 33.0, target: 'spark_coin' }, 33.45],
    ['smoke_puff', { vfxId: 'smoke_puff', at: 33.0, target: 'spark_coin' }, 33.25],
    ['fire', { vfxId: 'fire', at: 22.0, target: 'suspicious_button', duration: 3 }, 23.2],
    ['explosion', { vfxId: 'explosion', at: 22.0, target: 'suspicious_button' }, 22.18],
    ['explosion-late', { vfxId: 'explosion', at: 22.0, target: 'suspicious_button' }, 22.6],
    ['zoom_punch-off', { vfxId: 'zoom_punch', at: 99, duration: 0.45 }, 32.27],
    ['zoom_punch-on', { vfxId: 'zoom_punch', at: 32.2 }, 32.27],
    ['emote_exclaim', { vfxId: 'emote_exclaim', at: 6.2, target: 'zapp' }, 6.45],
    ['emote_question', { vfxId: 'emote_question', at: 26.2, target: 'kira' }, 26.6],
    ['emote_sweat', { vfxId: 'emote_sweat', at: 29.2, target: 'zapp' }, 29.6],
    ['emote_anger', { vfxId: 'emote_anger', at: 29.2, target: 'kira' }, 29.6],
    ['emote_hearts', { vfxId: 'emote_hearts', at: 33.9, target: 'zapp' }, 34.6],
    ['emote_tears', { vfxId: 'emote_tears', at: 29.1, target: 'zapp' }, 29.6],
  ];
  const fUrls: string[] = [], fLabels: string[] = [];
  for (const [name, e, t] of fx) {
    const f = await frame({ t, vfx: [e] });
    const file = save(`vfx-${name}.jpg`, f.url);
    fUrls.push(f.url); fLabels.push(`${name} @${t}`); index.push({ file, group: 'vfx', label: `${e.vfxId} (event at ${e.at}, target ${e.target ?? 'screen'})`, t });
  }
  save('sheet-vfx.jpg', await contactSheet(page, fUrls, fLabels, 5, 270));
  save('emote-icons.png', await page.evaluate(() => (window as any).__s7.emoteSheet()));
  index.push({ file: 'emote-icons.png', group: 'vfx', label: 'emote icon set', t: 0 });

  const allSegments = Object.values(placements).flatMap((p) => p.segments);
  const summary = { captions: plan.captions.length, placementSegments: allSegments.length, placed: Object.keys(placements).length, clearOfFaces: Object.values(placements).filter((p) => p.clearOfFaces).length, faceConflicts: Object.entries(placements).filter(([, p]) => !p.clearOfFaces).map(([id, p]) => ({ id, ...p })), centredSegments: allSegments.filter((p) => p.centerY === 0.5).length };
  writeFileSync(join(outDir, 'stills-index.json'), JSON.stringify({ summary, placements, stills: index }, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
} finally { await browser.close(); server.close(); }
