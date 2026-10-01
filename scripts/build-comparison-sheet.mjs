#!/usr/bin/env node
// Build packages/captions/full-render-v2/comparison-sheet.jpg (FEAT-004).
//
// PRIMARY content is the redesigned v2 render's OWN decoded frames, plus a v1-vs-v2
// old-vs-new strip. Competitor influence is represented ONLY as derived pacing/motion
// CHARTS computed from the .scratch analysis (bars of cuts-per-minute, median shot,
// translation% and zoom%) — NO competitor footage, characters, UI, logos or trade
// dress is reproduced. The raw competitor stills stay in .scratch/ and are never used.
//
// Rendering: extract frames with ffmpeg, lay them out in an HTML page, and screenshot
// with the installed Chromium (playwright-core) so text/charts render crisply. Output
// is a real JPEG.
//
// Usage: node scripts/build-comparison-sheet.mjs
// Env:   FFMPEG_PATH (falls back to ffmpeg-static), CHROMIUM_PATH (falls back to
//        playwright-core's bundled Chromium).

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const FFMPEG = process.env.FFMPEG_PATH || require('ffmpeg-static');
const { chromium } = require('playwright-core');
const ROOT = resolve(process.cwd());

const V2 = join(ROOT, 'packages/captions/full-render-v2/zapp-vs-kira-competitor-performance-v2.mp4');
const V1 = join(ROOT, 'packages/captions/full-render/zapp-vs-kira-full-s7.mp4');
const OUT = join(ROOT, 'packages/captions/full-render-v2/comparison-sheet.jpg');

function ff(args) {
  const r = spawnSync(FFMPEG, args, { encoding: 'buffer', maxBuffer: 1 << 28 });
  if (r.status !== 0) {
    process.stderr.write((r.stderr ? r.stderr.toString() : '') + '\n');
    throw new Error(`ffmpeg exited ${r.status}`);
  }
}

function grabDataUri(src, t, w, h, tmp, tag) {
  const out = join(tmp, `${tag}.jpg`);
  ff(['-hide_banner', '-y', '-ss', String(t), '-i', src, '-frames:v', '1',
    '-vf', `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=0x0d0d12`,
    '-q:v', '3', out]);
  return 'data:image/jpeg;base64,' + readFileSync(out).toString('base64');
}

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), 'cmp-'));
  try {
    const v2Frames = [
      { t: 3.0, label: 'p01 · teacher exits (door open)' },
      { t: 11.0, label: 'p03 · Zapp celebrate' },
      { t: 20.0, label: 'p04 · dance (full body)' },
      { t: 32.2, label: 'p07 · button-press contact' },
      { t: 45.0, label: 'p10 · coin growth / scale reveal' },
      { t: 57.0, label: 'p12 · impact + recoil' },
      { t: 61.0, label: 'p13 · teacher returns' },
      { t: 67.0, label: 'p14 · final payoff' },
    ].map((f, i) => ({ ...f, uri: grabDataUri(V2, f.t, 256, 454, tmp, `v2_${i}`) }));

    const cmpTimes = [
      { t: 3.0, label: 'teacher exit (~3.0s)' },
      { t: 32.2, label: 'button press (~32.2s)' },
      { t: 57.0, label: 'impact (~57.0s)' },
    ];
    const strip = cmpTimes.map((f, i) => ({
      ...f,
      v1: grabDataUri(V1, f.t, 220, 392, tmp, `v1_${i}`),
      v2: grabDataUri(V2, f.t, 220, 392, tmp, `v2c_${i}`),
    }));

    // Derived pacing metrics. Competitor band = mean of the three references from
    // .scratch analysis; v1/v2 from decoded render analysis + verification.json.
    const metrics = [
      { name: 'cuts / min', comp: 42.0, v1: 33.0, v2: 27.7, max: 50, fmt: (v) => v.toFixed(0) },
      { name: 'translation %', comp: 36.4, v1: 12.2, v2: 23.3, max: 60, fmt: (v) => v.toFixed(1) },
      { name: 'zoom %', comp: 24.2, v1: 5.6, v2: 15.6, max: 40, fmt: (v) => v.toFixed(1) },
      { name: 'median shot (s)', comp: 1.66, v1: 1.63, v2: 1.80, max: 3, fmt: (v) => v.toFixed(2) },
    ];

    const bar = (m) => {
      const series = [
        { k: 'comp', c: '#4a5568', v: m.comp },
        { k: 'v1', c: '#f59e0b', v: m.v1 },
        { k: 'v2', c: '#0ea5e9', v: m.v2 },
      ];
      const bars = series.map((s) => {
        const h = Math.round((s.v / m.max) * 220);
        return `<div class="bcol"><div class="bval">${m.fmt(s.v)}</div><div class="bar" style="height:${h}px;background:${s.c}"></div></div>`;
      }).join('');
      return `<div class="metric"><div class="bars">${bars}</div><div class="mname">${m.name}</div></div>`;
    };

    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    *{margin:0;padding:0;box-sizing:border-box;font-family:'DejaVu Sans',Arial,sans-serif}
    body{width:1080px;background:#0d0d12;color:#e5e7eb}
    .wrap{padding:34px 24px 26px}
    h1{font-size:31px;color:#fff}
    .sub{font-size:18px;color:#9ca3af;margin-top:6px}
    .sec{font-size:22px;color:#0ea5e9;margin:26px 0 12px;font-weight:700}
    .grid4{display:grid;grid-template-columns:repeat(4,255px);gap:12px}
    .tile{width:255px}
    .tile img{width:255px;height:453px;object-fit:cover;border-radius:6px;display:block}
    .cap{font-size:15px;color:#d1d5db;margin-top:5px;height:20px}
    .strip{display:flex;gap:26px}
    .pair{display:flex;flex-direction:column}
    .pairimgs{display:flex;gap:6px}
    .pairimgs img{width:220px;height:391px;object-fit:cover;border-radius:5px;display:block}
    .pairlbls{display:flex;gap:6px;font-size:14px;margin-top:4px}
    .pairlbls span{width:220px}
    .old{color:#fbbf24}.new{color:#38bdf8}
    .moment{font-size:15px;color:#9ca3af;margin-top:2px}
    .chart{display:flex;justify-content:space-between;padding:0 6px}
    .metric{display:flex;flex-direction:column;align-items:center;width:248px}
    .bars{display:flex;align-items:flex-end;gap:8px;height:250px}
    .bcol{display:flex;flex-direction:column;align-items:center;justify-content:flex-end}
    .bar{width:44px;border-radius:4px 4px 0 0}
    .bval{font-size:14px;color:#e5e7eb;margin-bottom:3px}
    .mname{font-size:17px;color:#fff;margin-top:10px;font-weight:600}
    .legend{font-size:17px;color:#9ca3af;margin:6px 0 16px}
    .legend b{color:#fff}
    .sw{display:inline-block;width:14px;height:14px;border-radius:3px;vertical-align:middle;margin:0 5px 0 14px}
    .foot{font-size:15px;color:#6b7280;margin-top:22px;line-height:1.4}
    </style></head><body><div class="wrap">
    <h1>Zapp vs Kira — Competitor-Performance Redesign (v2)</h1>
    <div class="sub">Comparison sheet · v2's own decoded frames · old-vs-new at matched moments · derived pacing charts</div>

    <div class="sec">1 · v2 story beats (frames decoded from the redesigned render)</div>
    <div class="grid4">
      ${v2Frames.map((f) => `<div class="tile"><img src="${f.uri}"><div class="cap">${f.label}</div></div>`).join('')}
    </div>

    <div class="sec">2 · Old S7 (v1) vs redesigned (v2) at matched moments</div>
    <div class="strip">
      ${strip.map((s) => `<div class="pair"><div class="pairimgs"><img src="${s.v1}"><img src="${s.v2}"></div><div class="pairlbls"><span class="old">old S7</span><span class="new">redesigned v2</span></div><div class="moment">${s.label}</div></div>`).join('')}
    </div>

    <div class="sec">3 · Derived pacing metrics (charts computed from analysis — not competitor footage)</div>
    <div class="legend"><span class="sw" style="background:#4a5568"></span><b>competitor pacing band</b><span class="sw" style="background:#f59e0b"></span><b>old S7 (v1)</b><span class="sw" style="background:#0ea5e9"></span><b>redesigned (v2)</b></div>
    <div class="chart">${metrics.map(bar).join('')}</div>

    <div class="foot">Competitor references (reported / lived / noob-vs-pro) were analysed only to extract general pacing and cinematography principles.
    This sheet reproduces no competitor characters, maps, UI, logos, captions or footage; the competitor pacing band above is a derived numeric average, and the raw competitor stills are kept out of source control (.scratch/). All image tiles are frames from Blockspark's own v1 and v2 renders.</div>
    </div></body></html>`;

    const browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || undefined,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage({ viewport: { width: 1080, height: 2200 }, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'networkidle' });
    const box = await (await page.$('body')).boundingBox();
    const fullH = Math.ceil(box.height);
    await page.setViewportSize({ width: 1080, height: fullH });
    await page.screenshot({ path: OUT, type: 'jpeg', quality: 90, clip: { x: 0, y: 0, width: 1080, height: fullH } });
    await browser.close();
    process.stderr.write(`[comparison] wrote ${OUT} (${Math.ceil(box.height)}px tall)\n`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (!existsSync(V2) || !existsSync(V1)) throw new Error('v1/v2 render mp4 missing');
main().catch((e) => { console.error(e); process.exit(1); });
