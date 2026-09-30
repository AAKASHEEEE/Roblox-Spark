// Narrated Checkpoint 1: write the deterministic world-state trace + summary for an approved narrated storyboard.
//   node scripts/narrated-state-trace.ts [--storyboard tests/fixtures/narrated/approved-narrated-v0.1.json]
//        [--out out/narrated-continuity-checkpoint1] [--debug]   (--debug adds the full WorldState of every frame)
// No engine, browser, FFmpeg or rendering: pure simulation of packages/narrated/src/world.ts.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT } from '../apps/render-worker/lib/server.ts';
import { loadLibrary } from '../apps/render-worker/lib/library.ts';
import { buildWorldPlan, sampleWorld, summarizeWorld, traceWorld, worldAssets } from '../packages/narrated/src/world.ts';
import { compileNarratedTimeline } from '../packages/narrated/src/timeline.ts';

const arg = (n: string, d?: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] ?? 'true' : d; };
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const sbPath = resolve(ROOT, arg('storyboard', 'tests/fixtures/narrated/approved-narrated-v0.1.json')!);
const out = resolve(ROOT, arg('out', 'out/narrated-continuity-checkpoint1')!);
const text = readFileSync(sbPath, 'utf8'), sb = JSON.parse(text);
const plan = buildWorldPlan(sb, worldAssets(loadLibrary() as never));
const shots = compileNarratedTimeline(sb, sha(text)).shots.map((s) => ({ id: s.id, start: s.start, end: s.end }));
const trace = traceWorld(plan, shots);
const summary = { ...summarizeWorld(plan, trace, sha), storyboardSha256: sha(text), shots: shots.length };
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'state-trace.json'), JSON.stringify(trace));
writeFileSync(join(out, 'state-summary.json'), JSON.stringify(summary, null, 2));
if (process.argv.includes('--debug')) writeFileSync(join(out, 'state-trace-debug.json'), JSON.stringify(Array.from({ length: plan.frames }, (_, i) => sampleWorld(plan, i / plan.fps))));
console.log(`${plan.status}: ${plan.frames} frames, ${plan.errors.length} errors, ${plan.bridges.length} bridges, trace ${summary.traceSha256.slice(0, 16)}… -> ${out}`);
process.exit(plan.status === 'ok' ? 0 : 1);
