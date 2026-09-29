// Fresh-process recompilation of every accepted plan in a benchmark run; prints {ideaId: sha256} as JSON.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadLibrary, sha256 } from '../apps/render-worker/lib/library.ts';
import { buildRegistry } from '../packages/story/src/registry.ts';
import { stagePlan } from '../packages/story/src/stage.ts';
import { compileEpisode, type FitKnobs } from '../packages/story/src/compile.ts';
import { fitCompile } from '../packages/story/src/fit.ts';

const dir = process.argv[2];
const lib = loadLibrary(); const reg = buildRegistry(lib);
const out: Record<string, string | null> = {};
for (const f of readdirSync(join(dir, 'records')).sort()) {
  const { item, record } = JSON.parse(readFileSync(join(dir, 'records', f), 'utf8'));
  if (record.status !== 'accepted') continue;
  const sp = stagePlan(record.plan, reg.environment);
  // records made with the fit pass replay it from scratch (deterministic); older records compile unfitted
  const compile = (k?: FitKnobs) => compileEpisode(record.request, record.normalized, record.plan, sp.staging, reg, k);
  const c = record.fitKnobs ? fitCompile(compile, lib as never).compiled : compile();
  out[item.id] = c.ok ? sha256(JSON.stringify(c.episode)) : null;
}
process.stdout.write(JSON.stringify(out));
