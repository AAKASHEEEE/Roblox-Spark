// dev (tuning data only; NOT a result): run the fit pass on attempt-0 plans of frozen records under both profiles and
// tabulate what remains. node scripts/dev/fit-survey.ts <records dir> [max]
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadLibrary } from '../../apps/render-worker/lib/library.ts';
import { buildRegistry } from '../../packages/story/src/registry.ts';
import { stagePlan } from '../../packages/story/src/stage.ts';
import { compileEpisode } from '../../packages/story/src/compile.ts';
import { fitCompile } from '../../packages/story/src/fit.ts';
const [dir, max = '99'] = process.argv.slice(2);
const lib = loadLibrary(); const reg = buildRegistry(lib);
const agg: Record<string, Record<string, number>> = {};
let n = 0, ms = 0;
for (const f of readdirSync(dir).sort().slice(0, Number(max))) {
  const rec = JSON.parse(readFileSync(join(dir, f), 'utf8')).record;
  const plan = rec.attempts?.[0]?.plan; if (!plan || !rec.normalized) continue;
  const st = stagePlan(plan, reg.environment); if (st.errors.length) continue;
  n++;
  const row: string[] = [f.replace('.json', '').padEnd(5)];
  for (const mp of ['legacy-head-v1', 'corrected-head-v2']) {
    const req = { ...rec.request, motionProfile: mp };
    const r = fitCompile((k) => compileEpisode(req, rec.normalized, plan, st.staging, reg, k), lib);
    if (!r.report) { row.push(`${mp}: compile failed`); continue; }
    ms += r.report.ms;
    const res = r.report.residual.map((c) => `${c.code}${c.message.includes('onset') ? ':onset' : c.message.includes('arrival') ? ':arrival' : c.message.match(/\.(\w+)@/)?.[1] ? ':' + c.message.match(/\.(\w+)@/)![1] : ''}`);
    for (const k of res) (agg[mp] ??= {})[k] = ((agg[mp] ??= {})[k] ?? 0) + 1;
    row.push(`${mp === 'legacy-head-v1' ? 'L ' : 'V2'} knobs pre=${r.report.knobs.preAlign.length} hop=${r.report.knobs.hopHeight ?? 1.5} hold=${(r.report.knobs.holdReaction ?? []).join("+") || "-"} shots=${Object.keys(r.report.knobs.shots).length} residual=[${res.join(',')}]`);
  }
  console.log(row.join(' | '));
}
console.log('\nresidual constraint kinds (episodes):'); for (const [k, v] of Object.entries(agg)) console.log(k, JSON.stringify(Object.entries(v).sort((a, b) => b[1] - a[1])));
console.log(`${n} plans, mean fit time ${(ms / Math.max(1, 2 * n) / 1000).toFixed(2)} s`);
