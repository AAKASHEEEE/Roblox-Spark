// Re-grade an existing render without re-rendering pixels: re-runs the (cheap, deterministic) analysis pass and
// rebuilds quality-report.{json,md} using the render's own log (MP4 inspection, decode check, loudness).
//   node scripts/requality.ts [out/free-coins-loop-001]
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { launchBrowser } from '../apps/render-worker/lib/browser.ts';
import { startServer, ROOT } from '../apps/render-worker/lib/server.ts';
import { loadLibrary, sha256, canonical } from '../apps/render-worker/lib/library.ts';
import { validateEpisode } from '../packages/pipeline/src/validate.ts';
import { buildQualityReport, qualityMarkdown } from '../packages/pipeline/src/quality.ts';
import { ensureWebBuild } from '../apps/render-worker/render.ts';

const dir = resolve(ROOT, process.argv[2] ?? 'out/free-coins-loop-001');
const log = JSON.parse(readFileSync(join(dir, 'render-log.json'), 'utf8'));
const ep = JSON.parse(readFileSync(join(dir, 'episode.json'), 'utf8'));
if (sha256(canonical(ep)) !== log.episodeSha256) throw new Error('episode.json does not match the rendered episode');
const lib = loadLibrary();
for (const [k, h] of Object.entries(log.assetHashes)) if (lib.hashes[k] !== h) throw new Error(`asset ${k} changed since render; re-render instead`);
const v = validateEpisode(ep, lib, { repair: true });
ensureWebBuild(() => {});
const { server, url } = await startServer(0);
const b = await launchBrowser();
const p = await b.newPage();
await p.goto(`${url}/apps/studio/render.html`); await p.waitForFunction(() => (window as any).__spark?.ready);
const info = await p.evaluate(([e, l, w, h]: any) => (window as any).__spark.load(e, l, w, h), [ep, lib, log.resolution[0], log.resolution[1]]);
const fps = ep.episode.fps, N = Math.round(ep.episode.duration * fps);
const times = Array.from({ length: N }, (_, i) => i / fps);
const probes: any[] = [], analysis: any[] = [];
for (let a = 0; a < N; a += 60) probes.push(...(await p.evaluate((ts: number[]) => (window as any).__spark.probe(ts), times.slice(a, a + 60))));
const aT = times.filter((_, i) => i % 3 === 0);
for (let a = 0; a < aT.length; a += 60) analysis.push(...(await p.evaluate((ts: number[]) => (window as any).__spark.analyze(ts), aT.slice(a, a + 60))));
const contactChecks = await p.evaluate((ts: number[]) => (window as any).__spark.analyze(ts), info.contacts.map((c: any) => c.t));
await b.close(); server.close();
const inspect = { ...log.mp4Inspect, tracks: log.mp4Inspect.tracks.map((t: any) => ({ ...t, sampleDurations: t.sampleDurations })) };
const q = buildQualityReport({ ep, validation: v, analysis, contactChecks, probes, contacts: info.contacts, impacts: info.impacts, inspect, playback: log.playback, loopDiff: log.loopDiff, audio: log.audio, lib, timing: log.timing, fps });
writeFileSync(join(dir, 'quality-report.json'), JSON.stringify(q, null, 2));
writeFileSync(join(dir, 'quality-report.md'), qualityMarkdown(q, ep, log));
console.log(`quality: ${q.summary.passed}/${q.summary.total}${q.summary.failed.length ? ' FAILED ' + q.summary.failed.join(',') : ''}`);
