// dev: recompile a frozen record's attempt-N plan and report per-shot QA issues at EVERY frame under both profiles
// node scripts/dev/headless-shots.ts <record.json> [attempt=0]
import { readFileSync } from 'node:fs';
import { loadLibrary } from '../../apps/render-worker/lib/library.ts';
import { headlessEngine } from '../../apps/render-worker/lib/headless.ts';
import { buildRegistry } from '../../packages/story/src/registry.ts';
import { stagePlan } from '../../packages/story/src/stage.ts';
import { compileEpisode } from '../../packages/story/src/compile.ts';
const [file, n = '0'] = process.argv.slice(2);
const rec = JSON.parse(readFileSync(file, 'utf8')).record;
const lib = loadLibrary(); const reg = buildRegistry(lib);
const plan = rec.attempts[Number(n)].plan;
const c = compileEpisode(rec.request, rec.normalized, plan, stagePlan(plan, reg.environment).staging, reg);
if (!c.ok) { console.log('compile failed', JSON.stringify(c.errors)); process.exit(1); }
for (const mp of ['legacy-head-v1', 'corrected-head-v2']) {
  const ep = { ...c.episode, render: { ...c.episode.render, motionProfile: mp } };
  const e = headlessEngine(ep as any, lib, 270, 480);
  const by: Record<string, Record<string, number>> = {};
  const N = Math.round(ep.episode.duration * 30);
  for (let i = 0; i < N; i++) { const t = i / 30; const f = e.prod.evaluate(t); for (const x of [...e.prod.validateFrame(e.renderer, f), ...e.prod.handPenetrations(t), ...e.prod.bodyIssues(t)]) { if (x.code === 'CAMERA_ADJUSTED') continue; const k = `${x.code}${x.subject ? ':' + x.subject : ''}`; (by[f.shot.id] ??= {})[k] = (by[f.shot.id]?.[k] ?? 0) + 1; } }
  console.log(`== ${mp}`); for (const s of ep.shots) if (by[s.id]) console.log(`  ${s.id} ${s.preset.padEnd(18)} [${s.subjects.join(',')}] ${s.start}-${s.end}: ${JSON.stringify(by[s.id])}`);
}
