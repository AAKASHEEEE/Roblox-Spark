// Analysis-only integrated pass (no pixels, no encode, no MP4): approved narrated storyboard -> WorldState -> posed
// engine scene -> camera safety -> caption placement -> blocking gates, over every frame.
//   node scripts/narrated-integration-analysis.ts [--storyboard tests/fixtures/narrated/approved-narrated-v0.1.json] [--out out/narrated-continuity-integration]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ROOT } from '../apps/render-worker/lib/server.ts';
import { loadLibrary, sha256 } from '../apps/render-worker/lib/library.ts';
import { prepareIntegration } from '../apps/studio/narrated-draft.ts';

const arg = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const sbPath = resolve(ROOT, arg('storyboard', 'tests/fixtures/narrated/approved-narrated-v0.1.json'));
const out = resolve(ROOT, arg('out', 'out/narrated-continuity-integration'));
mkdirSync(out, { recursive: true });
const text = readFileSync(sbPath, 'utf8'), sb = JSON.parse(text);
const T0 = Date.now();
const r = prepareIntegration(sb, sha256(text), loadLibrary(), (s, d, t) => { if (d === 0 || d % 5 === 0) process.stdout.write(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${s} ${d}/${t}\n`); });
writeFileSync(join(out, 'analysis-report.json'), JSON.stringify({ ...r.analysis, timingSec: (Date.now() - T0) / 1000 }, null, 2));
writeFileSync(join(out, 'render-timeline.json'), JSON.stringify({ timeline: r.tl, integrated: r.integrated }, null, 2));
const a = r.analysis;
console.log(`analysis ${a.frames} frames in ${((Date.now() - T0) / 1000).toFixed(1)} s: ${a.summary.passed}/${a.summary.total} gates pass${a.summary.failed.length ? ' — FAILED: ' + a.summary.failed.join(', ') : ''}`);
for (const g of a.gates) if (!g.pass) console.log(`  ${g.id} ${g.name}: ${g.detail}`);
process.exit(a.summary.blocking ? 2 : 0);
