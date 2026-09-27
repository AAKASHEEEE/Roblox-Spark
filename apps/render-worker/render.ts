// RBLX SPARK render worker — one command from episode JSON to a verified 1080x1920 MP4 + reports.
//   node apps/render-worker/render.ts --episode episodes/free-coins-loop-001.json [--out out/<id>] [--scale 1] [--gpu]
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { launchBrowser, findChromium } from './lib/browser.ts';
import { startServer, ROOT } from './lib/server.ts';
import { loadLibrary, sha256, canonical } from './lib/library.ts';
import { verifyPlayback, decodeCompare } from './lib/verify.ts';
import { contactSheet } from './lib/sheet.ts';
import { validateEpisode } from '../../packages/pipeline/src/validate.ts';
import { buildQualityReport, qualityMarkdown } from '../../packages/pipeline/src/quality.ts';
import { mix, interleave, wav16, type MixCue } from '../../packages/audio/src/mix.ts';
import { muxMp4 } from '../../packages/mp4/src/mux.ts';
import { inspectMp4 } from '../../packages/mp4/src/inspect.ts';

export interface RenderOptions { analyzeOnly?: boolean; episode: string; out?: string; scale?: number; gpu?: boolean; verify?: boolean; hashEvery?: number; onProgress?: (p: { phase: string; done: number; total: number; msg?: string }) => void }

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : 'true') : def;
}

export function ensureWebBuild(log: (s: string) => void): void {
  const dist = join(ROOT, 'dist/apps/studio/src/render-entry.js');
  const newest = (dir: string): number => readdirSync(dir, { withFileTypes: true }).reduce((m, d) => {
    const p = join(dir, d.name);
    return Math.max(m, d.isDirectory() ? (d.name === 'node_modules' ? 0 : newest(p)) : d.name.endsWith('.ts') ? statSync(p).mtimeMs : 0);
  }, 0);
  const srcM = Math.max(newest(join(ROOT, 'packages')), newest(join(ROOT, 'apps/studio/src')));
  if (existsSync(dist) && statSync(dist).mtimeMs >= srcM) return;
  log('building browser bundle (tsc -p tsconfig.web.json)');
  const local = join(ROOT, 'node_modules/.bin/tsc');
  execFileSync(existsSync(local) ? local : 'tsc', ['-p', 'tsconfig.web.json'], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, NODE_OPTIONS: '' } });
}

export async function renderEpisode(o: RenderOptions): Promise<{ ok: boolean; outDir: string; mp4?: string; report?: any }> {
  const T0 = Date.now();
  const logLines: Array<{ t: number; msg: string }> = [];
  const log = (msg: string) => { const t = (Date.now() - T0) / 1000; logLines.push({ t, msg }); console.log(`[${t.toFixed(1)}s] ${msg}`); };
  const phase = (p: string, done: number, total: number, msg?: string) => o.onProgress?.({ phase: p, done, total, msg });
  const epPath = resolve(ROOT, o.episode);
  const raw = JSON.parse(readFileSync(epPath, 'utf8'));
  const id = raw?.episode?.id ?? 'episode';
  const outDir = resolve(ROOT, o.out ?? join('out', id));
  mkdirSync(outDir, { recursive: true });
  const scale = o.scale ?? 1;
  log(`episode ${relative(ROOT, epPath)} -> ${relative(ROOT, outDir)} (scale ${scale})`);

  // 1. locked library
  phase('validate', 0, 1);
  const lib = loadLibrary();
  if (lib.errors.length) { writeFileSync(join(outDir, 'validation.json'), JSON.stringify({ ok: false, libraryErrors: lib.errors }, null, 2)); log('ASSET LIBRARY ERRORS:\n  ' + lib.errors.join('\n  ')); return { ok: false, outDir }; }
  // 2. validation + safe repairs
  const v = validateEpisode(raw, lib, { repair: true });
  writeFileSync(join(outDir, 'validation.json'), JSON.stringify(v, null, 2));
  for (const f of v.findings) if (f.severity !== 'info') log(`${f.severity.toUpperCase()} ${f.code}: ${f.message}`);
  for (const r of v.repairs) log(`REPAIR ${r}`);
  if (!v.ok || !v.episode) { log('validation failed — refusing to render broken output'); return { ok: false, outDir }; }
  const ep = v.episode;
  writeFileSync(join(outDir, 'episode.json'), JSON.stringify(ep, null, 2));
  const fps = ep.episode.fps, N = Math.round(ep.episode.duration * fps);
  const W = Math.round(1080 * scale), H = Math.round(1920 * scale);

  ensureWebBuild(log);
  const { server, url } = await startServer(0);
  const browser = await launchBrowser({ gpu: o.gpu });
  try {
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (e: any) => { pageErrors.push(String(e)); log('[pageerror] ' + e); });
    await page.goto(`${url}/apps/studio/render.html`);
    await page.waitForFunction(() => (window as any).__spark?.ready);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    const info = await page.evaluate(([e, l, w, h]: any) => (window as any).__spark.load(e, l, w, h), [ep, lib, W, H]);
    log(`renderer: ${info.renderer}; contacts: ${info.contacts.map((c: any) => `${c.actor}.${c.action}@${c.t.toFixed(3)}`).join(', ')}`);

    // 3. analysis pass (no pixels): shot validation, contacts, motion probes
    phase('analyze', 0, 1);
    const t1 = Date.now();
    const times = Array.from({ length: N }, (_, i) => i / fps);
    const probes: any[] = [];
    for (let a = 0; a < N; a += 60) probes.push(...(await page.evaluate((ts: number[]) => (window as any).__spark.probe(ts), times.slice(a, a + 60))));
    const analysis: any[] = [];
    const aTimes = times.filter((_, i) => i % 3 === 0);
    for (let a = 0; a < aTimes.length; a += 60) analysis.push(...(await page.evaluate((ts: number[]) => (window as any).__spark.analyze(ts), aTimes.slice(a, a + 60))));
    const contactChecks = await page.evaluate((ts: number[]) => (window as any).__spark.analyze(ts), info.contacts.map((c: any) => c.t));
    log(`analysis pass: ${N} probes + ${aTimes.length} shot validations in ${((Date.now() - t1) / 1000).toFixed(1)}s`);
    if (o.analyzeOnly) {
      const by: Record<string, Record<string, number>> = {};
      for (const a of analysis) for (const i of a.issues) { const m = (by[a.shot] ??= {}); const k = i.code + (i.subject ? ':' + i.subject : ''); m[k] = (m[k] ?? 0) + 1; }
      const hand = contactChecks.map((c: any, k: number) => `${info.contacts[k].actor}.${info.contacts[k].action} ${(((c.handErrors[info.contacts[k].actor] ?? 1) * 100)).toFixed(1)}cm`);
      writeFileSync(join(outDir, 'analysis.json'), JSON.stringify({ issuesByShot: by, hand, analysis }, null, 2));
      log('issues by shot: ' + JSON.stringify(by)); log('contacts: ' + hand.join(', '));
      return { ok: true, outDir };
    }

    // 4. auto-derived footstep cues from sole contacts
    const steps: MixCue[] = [];
    for (const actor of ep.cast.map((c) => c.id)) {
      for (const side of ['soleL', 'soleR']) {
        let wasUp = false;
        probes.forEach((p, i) => {
          const y = p.actors[actor][side][1];
          const moving = i > 0 && Math.hypot(p.actors[actor].root[0] - probes[i - 1].actors[actor].root[0], p.actors[actor].root[2] - probes[i - 1].actors[actor].root[2]) * fps > 0.2;
          if (y > 0.03) wasUp = true;
          if (y < 0.012 && wasUp && moving) { steps.push({ sfx: 'sfx_footstep', at: p.t, gainDb: -17, pitch: 0.9 + ((i * 7) % 5) * 0.05, pan: 0 }); wasUp = false; }
        });
      }
    }
    log(`derived ${steps.length} footstep cues from foot contacts`);

    // 5. audio mix + opus encode
    phase('audio', 0, 1);
    const t2 = Date.now();
    const audioAssets = Object.fromEntries(Object.values(lib.audio).map((a) => [a.id, a]));
    const m = mix({ duration: ep.episode.duration, cues: [...ep.audio.cues, ...steps], music: ep.audio.music, ambience: ep.audio.ambience, loudnessLufs: ep.audio.loudnessLufs, duckingDb: ep.audio.duckingDb, loop: true }, audioAssets);
    writeFileSync(join(outDir, 'mix.wav'), wav16(m.left, m.right));
    const pcm = interleave(m.left, m.right);
    const opus = await page.evaluate(([b, sr, ch, br]: any) => (window as any).__spark.encodeOpus(b, sr, ch, br), [Buffer.from(pcm.buffer).toString('base64'), 48000, 2, ep.export.audioBitrateKbps * 1000]);
    log(`audio: ${m.report.integratedLufs} LUFS (target ${ep.audio.loudnessLufs}), peak ${m.report.truePeakDbfsApprox} dBFS, ${opus.sizes.length} opus packets, ${((Date.now() - t2) / 1000).toFixed(1)}s`);

    // 6. frames -> H.264
    await page.evaluate((cfg: any) => (window as any).__spark.initCapture(cfg), { bitrate: ep.export.videoBitrateKbps * 1000 * scale * scale, hashEvery: o.hashEvery ?? 15 });
    const t3 = Date.now();
    const samples: { data: Uint8Array; duration: number; isKey: boolean }[] = [];
    const hashes: Array<[number, string]> = [];
    let renderMs = 0, peakJsHeap = 0;
    const BATCH = 15;
    for (let a = 0; a < N; a += BATCH) {
      const b = Math.min(N, a + BATCH);
      const r = await page.evaluate(([a, b, f]: [number, number, boolean]) => (window as any).__spark.encodeRange(a, b, f), [a, b, b === N]);
      const buf = Buffer.from(r.b64, 'base64');
      let off = 0;
      r.sizes.forEach((s: number, k: number) => { samples.push({ data: new Uint8Array(buf.subarray(off, off + s)), duration: 1000, isKey: r.keys[k] }); off += s; });
      hashes.push(...r.hashes); renderMs += r.renderMs;
      const met = await cdp.send('Performance.getMetrics');
      peakJsHeap = Math.max(peakJsHeap, met.metrics.find((x: any) => x.name === 'JSHeapUsedSize')?.value ?? 0);
      if ((b / BATCH) % 6 === 0 || b === N) log(`frames ${b}/${N} (${((Date.now() - t3) / b).toFixed(0)} ms/frame)`);
      phase('render', b, N);
    }
    const encodeWall = Date.now() - t3;
    const meta = await page.evaluate(() => (window as any).__spark.meta());
    const stats = await page.evaluate(() => (window as any).__spark.stats());
    if (samples.length !== N) throw new Error(`encoder produced ${samples.length} samples for ${N} frames`);

    // 7. mux
    const cs = meta.colorSpace ?? {};
    const P: Record<string, number> = { bt709: 1, smpte170m: 6, bt470bg: 5 }, TR: Record<string, number> = { bt709: 1, smpte170m: 6, iec61966_2_1: 13 }, MX: Record<string, number> = { bt709: 1, smpte170m: 6, bt470bg: 5, rgb: 0 };
    const opusBuf = Buffer.from(opus.b64, 'base64');
    let ao = 0;
    const aSamples = opus.sizes.map((s: number, k: number) => { const d = new Uint8Array(opusBuf.subarray(ao, ao + s)); ao += s; return { data: d, duration: opus.durations[k] }; });
    const preSkip = opus.descB64 ? Buffer.from(opus.descB64, 'base64').readUInt16LE(10) : 312;
    const mp4 = muxMp4({
      video: { width: W, height: H, timescale: fps * 1000, avcC: new Uint8Array(Buffer.from(meta.avcCb64, 'base64')), samples, color: { primaries: P[cs.primaries] ?? 1, transfer: TR[cs.transfer] ?? 1, matrix: MX[cs.matrix] ?? 1, fullRange: !!cs.fullRange } },
      audio: { sampleRate: 48000, channels: 2, preSkip, inputSampleRate: 48000, samples: aSamples },
    });
    const mp4Path = join(outDir, `${id}.mp4`);
    writeFileSync(mp4Path, mp4);
    const inspect = inspectMp4(mp4);
    const mp4Sha = sha256(mp4);
    log(`muxed ${relative(ROOT, mp4Path)} ${(mp4.length / 1e6).toFixed(2)} MB sha256 ${mp4Sha.slice(0, 16)}…`);

    // 8. independent decode verification + contact sheet + thumbnail + loop comparison
    let playback: any = null, loopDiff: number[] = [], sheetFile = '', thumbFile = '';
    if (o.verify !== false) {
      phase('verify', 0, 1);
      const rel = relative(ROOT, mp4Path);
      const mids = ep.shots.map((s) => +((s.start + s.end) / 2).toFixed(3));
      playback = await verifyPlayback(url, rel, [0.5, ...mids], join(outDir, 'decoded'), 3);
      const vpage = await browser.newPage();
      await vpage.goto(`${url}/apps/studio/blank.html`);
      loopDiff = await decodeCompare(vpage, `${url}/${rel}`, [[0, (N - 1) / fps], [0, 8.0]]);
      const urls = playback.frameFiles.map((f: string) => 'data:image/png;base64,' + readFileSync(f).toString('base64'));
      const sheet = await contactSheet(vpage, urls.slice(1), ep.shots.map((s) => `${s.id} ${s.preset}`), 5, 216);
      sheetFile = join(outDir, 'contact-sheet.png');
      writeFileSync(sheetFile, Buffer.from(sheet.split(',')[1], 'base64'));
      thumbFile = join(outDir, 'thumbnail.png');
      writeFileSync(thumbFile, readFileSync(playback.frameFiles[0]));
      await vpage.close();
      log(`decode check: ${playback.ok ? 'OK' : 'FAILED'} ${playback.videoWidth}x${playback.videoHeight} ${playback.duration}s, audio bytes decoded ${playback.audioDecodedBytes}; loop first/last frame diff ${(loopDiff[0] * 100).toFixed(2)}% (control mid-episode ${(loopDiff[1] * 100).toFixed(2)}%)`);
    }

    // 9. reports
    const renderLog = {
      episode: id, episodeSha256: sha256(canonical(ep)), assetHashes: lib.hashes, mp4: relative(ROOT, mp4Path), mp4Sha256: mp4Sha, bytes: mp4.length,
      resolution: [W, H], fps, frames: N, frameHashes: hashes,
      timing: { totalSec: (Date.now() - T0) / 1000, encodeWallSec: encodeWall / 1000, msPerFrame: +(encodeWall / N).toFixed(1), renderOnlyMsPerFrame: +(renderMs / N).toFixed(1), realtimeFactor: +((encodeWall / 1000) / ep.episode.duration).toFixed(2) },
      memory: { peakPageJsHeapMB: +(peakJsHeap / 1e6).toFixed(1), workerRssMB: +(process.memoryUsage().rss / 1e6).toFixed(1), hostTotalGB: +(os.totalmem() / 1e9).toFixed(1) },
      host: { cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, platform: `${os.platform()} ${os.release()}`, node: process.version, chromium: findChromium(), glRenderer: info.renderer, gpu: !!o.gpu },
      drawStats: stats, encoder: meta, audio: m.report, mp4Inspect: { ...inspect, boxes: undefined, tracks: inspect.tracks.map((t) => ({ ...t, sampleDurations: [...new Set(t.sampleDurations)] })) },
      playback, loopDiff, pageErrors, log: logLines,
    };
    writeFileSync(join(outDir, 'render-log.json'), JSON.stringify(renderLog, null, 2));
    writeFileSync(join(outDir, 'analysis.json'), JSON.stringify({ analysis, contactChecks, probes, contacts: info.contacts, impacts: info.impacts }));
    const q = buildQualityReport({ ep, validation: v, analysis, contactChecks, probes, contacts: info.contacts, impacts: info.impacts, inspect, playback, loopDiff, audio: m.report, lib, timing: renderLog.timing, fps });
    writeFileSync(join(outDir, 'quality-report.json'), JSON.stringify(q, null, 2));
    writeFileSync(join(outDir, 'quality-report.md'), qualityMarkdown(q, ep, renderLog));
    log(`quality: ${q.summary.passed}/${q.summary.total} gates passed${q.summary.failed.length ? ' — FAILED: ' + q.summary.failed.join(', ') : ''}`);
    phase('done', 1, 1);
    return { ok: q.summary.failed.length === 0 && (!playback || playback.ok), outDir, mp4: mp4Path, report: q };
  } finally {
    await browser.close();
    server.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ep = arg('episode', 'episodes/free-coins-loop-001.json')!;
  const res = await renderEpisode({ episode: ep, out: arg('out'), scale: Number(arg('scale', '1')), gpu: arg('gpu') === 'true', verify: arg('no-verify') !== 'true', analyzeOnly: arg('analyze-only') === 'true' });
  console.log(res.ok ? `\nOK -> ${res.mp4}` : `\nRENDER FINISHED WITH FAILURES (see ${res.outDir})`);
  process.exit(res.ok ? 0 : 1);
}
