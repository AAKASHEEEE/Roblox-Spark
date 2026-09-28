// dev (tuning data only): run the fit pass on a frozen record's attempt-N plan and report what it did
// node scripts/dev/fit-try.ts <record.json> [attempt=0] [profile]
import { readFileSync } from 'node:fs';
import { loadLibrary } from '../../apps/render-worker/lib/library.ts';
import { buildRegistry } from '../../packages/story/src/registry.ts';
import { stagePlan } from '../../packages/story/src/stage.ts';
import { compileEpisode } from '../../packages/story/src/compile.ts';
import { fitCompile } from '../../packages/story/src/fit.ts';
const [file, n = '0', profile] = process.argv.slice(2);
const rec = JSON.parse(readFileSync(file, 'utf8')).record;
const lib = loadLibrary(); const reg = buildRegistry(lib);
const plan = rec.attempts[Number(n)].plan;
const req = { ...rec.request, ...(profile ? { motionProfile: profile } : {}) };
const st = stagePlan(plan, reg.environment).staging;
const r = fitCompile((k) => compileEpisode(req, rec.normalized, plan, st, reg, k), lib);
const rep = r.report!;
console.log(JSON.stringify({ profile: rep.profile, ms: rep.ms, iterations: rep.iterations, knobs: rep.knobs, clearance: rep.clearance, residual: rep.residual.map((c) => `${c.code} ${c.beatId} ${c.field}: ${c.message.slice(0, 140)}`), decisions: rep.decisions.map((d) => d.slice(0, 160)), warnings: rep.warnings.map((w) => w.slice(0, 160)), framing: rep.framing.filter((f) => f.fitted || !f.ok) }, null, 1));
