// dev (tuning data only; NOT a result): for every frozen Run 3 record that failed or needed a repair, compare
//   (a) the first-pass episode Run 3 measured (attempt-0 plan + recorded staging through the unfitted compiler, which
//       replays the frozen episodes byte-identically) under corrected-head-v2 and re-declared as legacy-head-v1;
//   (b) the current generator's first pass for the same plan (fresh staging + fit pass) under each profile.
// Headless QA on every frame + swept hands; "blocking" = what the pipeline's acceptance rule would reject.
// node scripts/dev/mechanism-scan.ts [ids,comma,separated] [--all]
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadLibrary } from '../../apps/render-worker/lib/library.ts';
import { headlessQa } from '../../apps/render-worker/lib/headless-qa.ts';
import { buildRegistry } from '../../packages/story/src/registry.ts';
import { stagePlan } from '../../packages/story/src/stage.ts';
import { compileEpisode, type FitKnobs } from '../../packages/story/src/compile.ts';
import { fitCompile } from '../../packages/story/src/fit.ts';

const lib = loadLibrary(); const reg = buildRegistry(lib);
const only = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2].split(',') : null;
const all = process.argv.includes('--all');
const dirs = ['run3-holdout2', 'run3-holdout-posthoc', 'run3-rules-posthoc'];
const fmt = (q: ReturnType<typeof headlessQa>) => [...new Set(q.blocking.map((b) => b.code))].map((c) => `${c}:${q.blocking.filter((b) => b.code === c).reduce((s, b) => s + b.frames, 0)}`).join(' ') || '-';
for (const d of dirs) {
  const base = join('docs/story/bench', d, 'records');
  for (const f of readdirSync(base).sort()) {
    const { item, record: rec } = JSON.parse(readFileSync(join(base, f), 'utf8'));
    if (only && !only.includes(item.id)) continue;
    const a0 = rec.attempts[0];
    if (!a0?.compiled) continue;
    if (!all && !only && rec.status === 'accepted' && rec.repairs === 0) continue;
    const line: string[] = [`${item.id.padEnd(5)} ${rec.status.padEnd(8)} r${rec.repairs}`];
    const frozen = compileEpisode(rec.request, rec.normalized, a0.plan, a0.staging, reg);
    if (!frozen.ok) { console.log(line[0], 'frozen attempt 0 does not compile'); continue; }
    for (const mp of ['corrected-head-v2', 'legacy-head-v1']) line.push(`run3/${mp.slice(0, 6)}: ${fmt(headlessQa({ ...frozen.episode, render: { ...frozen.episode.render, motionProfile: mp } } as never, lib))}`);
    const sp = stagePlan(a0.plan, reg.environment);
    for (const mp of ['corrected-head-v2', 'legacy-head-v1']) {
      const req = { ...rec.request, motionProfile: mp };
      const { compiled, report } = fitCompile((k?: FitKnobs) => compileEpisode(req, rec.normalized, a0.plan, sp.staging, reg, k), lib as never);
      if (!compiled.ok) { line.push(`now/${mp.slice(0, 6)}: COMPILE ${compiled.errors.map((e) => e.code).join(',')}`); continue; }
      line.push(`now/${mp.slice(0, 6)}: ${fmt(headlessQa(compiled.episode, lib))}${report?.residual.length ? ' residual=' + report.residual.map((r) => r.code).join(',') : ''} [${(report?.decisions ?? []).map((x) => x.split(' ')[0]).join(',')}]`);
    }
    console.log(line.join(' | '));
  }
}
