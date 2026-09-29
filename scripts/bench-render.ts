// Rendered validation of generated episodes (no manual edits: episodes are read from the benchmark output).
//   node scripts/bench-render.ts --run out/bench/run2-rules [--scale 0.25] [--ids A01,B01] [--parallel 3] [--out out/bench-renders/diag]
//        [--select first-per-engine (pre-declared full-render rule: lowest accepted idea id per dataset engine)]
//        [--resume --limit N (batched/interrupted runs: ids with a result.json are never re-rendered; summary aggregates all)]
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { renderEpisode } from '../apps/render-worker/render.ts';
import { ROOT } from '../apps/render-worker/lib/server.ts';
import { loadLibrary } from '../apps/render-worker/lib/library.ts';
import { BrowserAnalyzer } from '../apps/render-worker/lib/analyzer.ts';
import { storyGates } from '../packages/story/src/gates.ts';

const arg = (n: string, d?: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const run = join(ROOT, arg('run', 'out/bench/run2-rules')!);
const scale = Number(arg('scale', '0.25'));
const parallel = Number(arg('parallel', '3'));
const outRoot = join(ROOT, arg('out', scale === 1 ? 'out/bench-renders/final' : 'out/bench-renders/diag')!);
const records = readdirSync(join(run, 'records')).sort().map((f) => JSON.parse(readFileSync(join(run, 'records', f), 'utf8')));
let chosen = records.filter((r) => r.record.status === 'accepted');
const ids = arg('ids');
if (ids) chosen = chosen.filter((r) => ids.split(',').includes(r.item.id));
if (arg('select') === 'first-per-engine') { const seen = new Set<string>(); chosen = chosen.filter((r) => (seen.has(r.item.engine) ? false : (seen.add(r.item.engine), true))); }
const resume = process.argv.includes('--resume');
const resultFile = (id: string) => join(outRoot, id, 'result.json');
let todo = chosen.filter((r) => !(resume && existsSync(resultFile(r.item.id))));
if (arg('limit')) todo = todo.slice(0, Number(arg('limit')));
mkdirSync(outRoot, { recursive: true });
const lib = loadLibrary();
// story gates with measured analysis for each episode (same engine, no pixels)
const an = new BrowserAnalyzer(lib);
const gatesFor: Record<string, any[]> = {};
for (const r of todo) { const a = await an.analyze(r.record.episode); gatesFor[r.item.id] = storyGates(r.record.episode, r.record.plan, r.record.events, a.analysis); }
await an.close();
const results: any[] = [];
const queue = [...todo];
async function worker(): Promise<void> {
  for (let r = queue.shift(); r; r = queue.shift()) {
    const epFile = join(run, 'episodes', `${r.item.id}.json`);
    const out = join(outRoot, r.item.id);
    const t0 = Date.now();
    const res = await renderEpisode({ episode: relative(ROOT, epFile), out: relative(ROOT, out), scale, extraGates: () => gatesFor[r.item.id] });
    const q = res.report;
    results.push({ id: r.item.id, engine: r.item.engine, kind: r.item.kind, repairs: r.record.repairs, substitutions: r.record.substitutions.length, ok: res.ok, wallSec: (Date.now() - t0) / 1000, gates: q ? `${q.summary.passed}/${q.summary.total}` : 'n/a', groups: q?.summary.groups, failed: q?.summary.failed ?? ['render failed'], mp4: res.mp4 ? relative(ROOT, res.mp4) : null });
    writeFileSync(resultFile(r.item.id), JSON.stringify(results[results.length - 1], null, 2));
    console.log(`${r.item.id} ${res.ok ? 'OK ' : 'FAIL'} ${q ? `${q.summary.passed}/${q.summary.total}` : ''} ${q?.summary.failed.join(',') ?? ''} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
}
const T0 = Date.now();
await Promise.all(Array.from({ length: parallel }, worker));
// the summary covers every chosen id rendered so far (this call and earlier resumed calls)
const all = chosen.filter((r) => existsSync(resultFile(r.item.id))).map((r) => JSON.parse(readFileSync(resultFile(r.item.id), 'utf8')));
results.splice(0, results.length, ...all);
results.sort((a, b) => (a.id < b.id ? -1 : 1));
const summary = { run: relative(ROOT, run), scale, profile: scale === 1 ? 'final' : 'diagnostic', selection: arg('select') ?? (ids ? 'ids' : 'all accepted'), chosen: chosen.map((r) => r.item.id), complete: all.length === chosen.length, rendered: results.length, allGatesPassed: results.filter((r) => r.failed.length === 0).length, wallSec: (Date.now() - T0) / 1000, parallel, results };
writeFileSync(join(outRoot, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ rendered: summary.rendered, allGatesPassed: summary.allGatesPassed, wallSec: summary.wallSec }));
void existsSync;
