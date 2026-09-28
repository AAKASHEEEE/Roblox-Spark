// Story-generation benchmark: runs every idea of a frozen dataset through the full pipeline (with the browser
// analyzer), stores complete per-idea records and computes the acceptance metrics.
//   node scripts/bench-generate.ts [--set bench/ideas.json] [--provider rules|faulty:0.5|openai|anthropic] [--out out/bench/rules] [--static]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadLibrary, sha256 } from '../apps/render-worker/lib/library.ts';
import { ROOT } from '../apps/render-worker/lib/server.ts';
import { BrowserAnalyzer } from '../apps/render-worker/lib/analyzer.ts';
import { buildRegistry } from '../packages/story/src/registry.ts';
import { createProvider } from '../packages/story/src/providers/index.ts';
import { generateEpisode, type GenerationRecord } from '../packages/story/src/pipeline.ts';
import { stagePlan } from '../packages/story/src/stage.ts';
import { compileEpisode, type FitKnobs } from '../packages/story/src/compile.ts';
import { fitCompile } from '../packages/story/src/fit.ts';
import { promptSizes } from '../packages/story/src/providers/llm.ts';
import { TEMPLATES } from '../packages/story/src/templates.ts';
import { FaultyProvider } from '../packages/story/src/providers/mock.ts';

const arg = (n: string, d?: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] ?? 'true' : d; };
const setFile = arg('set', 'bench/ideas.json')!;
const providerName = arg('provider', process.env.BLOCKSPARK_LLM_PROVIDER ?? 'rules')!;
const out = join(ROOT, arg('out', `out/bench/${providerName.replace(/[^a-z0-9]+/gi, '_')}`)!);
const staticOnly = process.argv.includes('--static');
/** explicit motion profile for every request of this run (absent = the default for new episodes) */
const motionProfile = arg('motion-profile');
const reportOnly = process.argv.includes('--report-only');
mkdirSync(join(out, 'records'), { recursive: true }); mkdirSync(join(out, 'episodes'), { recursive: true });
const set = JSON.parse(readFileSync(join(ROOT, setFile), 'utf8'));
const lib = loadLibrary();
if (lib.errors.length) throw new Error(lib.errors.join('\n'));
const reg = buildRegistry(lib);

type Row = { item: any; rec: GenerationRecord };
const rows: Row[] = [];
if (!reportOnly) {
  const provider = createProvider(process.env, providerName);
  const analyzer = staticOnly ? null : new BrowserAnalyzer(lib);
  const t0 = Date.now();
  for (const item of set.ideas) {
    const rec = await generateEpisode(motionProfile ? { ...item.request, motionProfile } : item.request, { provider, registry: reg, lib, analyzer, sha256, maxRepairs: 3 });
    const slim = { ...rec, lastCompiled: rec.status === 'accepted' ? null : rec.lastCompiled };
    writeFileSync(join(out, 'records', `${item.id}.json`), JSON.stringify({ item, record: slim }, null, 1));
    if (rec.episode) writeFileSync(join(out, 'episodes', `${item.id}.json`), JSON.stringify(rec.episode, null, 2));
    rows.push({ item, rec });
    console.log(`${item.id.padEnd(4)} ${rec.status.padEnd(8)} repairs=${rec.repairs} ${(rec.rejection?.category ?? '').padEnd(12)} ${String(rec.latencyMs).padStart(6)}ms  ${(rec.rejection?.reason ?? rec.failure ?? rec.episode?.episode.id ?? '').slice(0, 110)}`);
  }
  await analyzer?.close();
  if (provider instanceof FaultyProvider) writeFileSync(join(out, 'injected-faults.json'), JSON.stringify(provider.injected, null, 1));
  console.log(`generation wall time ${((Date.now() - t0) / 1000).toFixed(1)}s`);
} else for (const item of set.ideas) rows.push({ item, rec: JSON.parse(readFileSync(join(out, 'records', `${item.id}.json`), 'utf8')).record });

// ---------- determinism: recompile accepted plans (same process x2 + a fresh process) ----------
const recompile = (rec: GenerationRecord): string | null => {
  if (!rec.plan || !rec.normalized) return null;
  const sp = stagePlan(rec.plan, reg.environment);
  // replay: the fit pass from scratch when the record was fitted (tests the fit's determinism too), else unfitted compile
  const compile = (k?: FitKnobs) => compileEpisode(rec.request, rec.normalized!, rec.plan!, sp.staging, reg, k);
  const c = rec.fitKnobs ? fitCompile(compile, lib as never).compiled : compile();
  return c.ok ? sha256(JSON.stringify(c.episode)) : null;
};
const accepted = rows.filter((r) => r.rec.status === 'accepted');
const sameProc = accepted.map((r) => ({ id: r.item.id, a: recompile(r.rec), b: recompile(r.rec), want: r.rec.episodeSha256 }));
let fresh: Record<string, string | null> = {};
try { fresh = JSON.parse(execFileSync(process.execPath, [join(ROOT, 'scripts/bench-recompile.ts'), out], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } })); } catch (e) { console.error('fresh-process recompile failed', e); }
const detOk = sameProc.filter((x) => x.a && x.a === x.b && x.a === x.want && fresh[x.id] === x.want).length;

// ---------- metrics ----------
const isCompat = (r: Row) => r.item.expected === 'accept' || r.item.expected === 'accept_with_substitution';
const mustReject = (r: Row) => r.item.expected === 'reject';
const compat = rows.filter(isCompat), rej = rows.filter(mustReject), ipT = rows.filter((r) => r.item.expected === 'reject_or_transform');
const pct = (n: number, d: number) => (d ? +((100 * n) / d).toFixed(1) : 0);
const allEvents = rows.flatMap((r) => r.rec.schemaEvents);
const reachedC = rows.filter((r) => r.rec.attempts.length > 0);
const firstAtt = (r: Row) => r.rec.attempts[0];
const HARDCAM = ['SUBJECT_OUT_OF_FRAME', 'SUBJECT_BEHIND_CAMERA', 'FACE_OUT_OF_FRAME', 'FACE_OCCLUDED', 'CAMERA_IN_PROP', 'PROP_OCCLUDED'];
const COLL = ['HAND_PENETRATION', 'BODY_PROP_INTERSECTION', 'ACTOR_OVERLAP'];
const camOk = (a: any) => a?.analysis && HARDCAM.every((c) => !a.analysis.byCode[c]);
const collOk = (a: any) => a?.analysis && COLL.every((c) => !a.analysis.byCode[c]) && a.analysis.metrics.footSlipMedian <= 0.05 && a.analysis.metrics.footSlipP95 <= 0.5;
const gate = (r: Row, id: string) => r.rec.gates.find((g) => g.id === id)?.pass ?? false;
const finalAtt = (r: Row) => r.rec.attempts[r.rec.attempts.length - 1];
const ipHandled = ipT.filter((r) => r.rec.status === 'rejected' || (r.rec.status === 'accepted' && r.rec.substitutions.some((s) => s.kind === 'brand'))).length;
const unsafe = rej.filter((r) => r.item.expectedRejectCategory === 'unsafe'), ipRej = rej.filter((r) => r.item.expectedRejectCategory === 'protected_ip');
const tokensIn = rows.reduce((a, r) => a + r.rec.tokens.in, 0), tokensOut = rows.reduce((a, r) => a + r.rec.tokens.out, 0);
const sampleInput = { request: set.ideas[0].request, idea: accepted[0]?.rec.normalized ?? null, template: TEMPLATES.ordinary_object_extreme, registry: reg, constraints: [] } as any;
const est = accepted[0] ? promptSizes(sampleInput) : { normalize: 0, plan: 0 };
const metrics = {
  run: { provider: providerName, model: rows[0]?.rec.provider.model, dataset: setFile, ideas: rows.length, compatible: compat.length, mustReject: rej.length, ipTransformable: ipT.length, analyzer: !staticOnly, date: new Date().toISOString() },
  m01_schemaValidResponseRate: pct(allEvents.filter((e) => e.ok).length, allEvents.length),
  m01b_finalSchemaValidOrExplicitRejection: pct(rows.filter((r) => (r.rec.status === 'accepted' && r.rec.episode) || (r.rec.status === 'rejected' && r.rec.rejection)).length, rows.length),
  m02_assetCompatibleFirstPlanRate: pct(reachedC.filter((r) => !firstAtt(r).constraints.some((c) => c.source === 'compatibility')).length, reachedC.length),
  m03_firstPassCompilerSuccess_compatible: pct(compat.filter((r) => firstAtt(r)?.compiled).length, compat.length),
  m04_firstPassValidatorAcceptance_compatible: pct(compat.filter((r) => r.rec.status === 'accepted' && r.rec.repairs === 0).length, compat.length),
  m05_acceptanceAfterRepair_compatible: pct(compat.filter((r) => r.rec.status === 'accepted').length, compat.length),
  m06_avgRepairs_compatible: +(compat.reduce((a, r) => a + r.rec.repairs, 0) / Math.max(1, compat.length)).toFixed(2),
  m06b_avgRepairs_accepted: +(accepted.reduce((a, r) => a + r.rec.repairs, 0) / Math.max(1, accepted.length)).toFixed(2),
  m07_rejectionCorrectness_mustReject: pct(rej.filter((r) => r.rec.status === 'rejected').length, rej.length),
  m07b_rejectionCategoryMatch: pct(rej.filter((r) => r.rec.status === 'rejected' && (r.rec.rejection?.category === r.item.expectedRejectCategory)).length, rej.length),
  m07c_unsafeRejected: pct(unsafe.filter((r) => r.rec.status === 'rejected').length, unsafe.length),
  m07d_protectedIpRejectedOrTransformed: pct(ipRej.filter((r) => r.rec.status === 'rejected').length + ipHandled, ipRej.length + ipT.length),
  m07e_falseRejections_compatible: compat.filter((r) => r.rec.status === 'rejected').map((r) => `${r.item.id}: ${r.rec.rejection?.reason}`),
  m08_avgLatencyMs_all: Math.round(rows.reduce((a, r) => a + r.rec.latencyMs, 0) / rows.length),
  m08b_avgLatencyMs_accepted: Math.round(accepted.reduce((a, r) => a + r.rec.latencyMs, 0) / Math.max(1, accepted.length)),
  m09_cost: { modelTokensIn: tokensIn, modelTokensOut: tokensOut, modelCostUsd: providerName.startsWith('rules') || providerName.startsWith('faulty') ? 0 : null, computeCostUsdPerIdea_at_0_35_per_hour: +((rows.reduce((a, r) => a + r.rec.latencyMs, 0) / rows.length / 3.6e6) * 0.35).toFixed(6), estimatedLlmPromptTokensPerIdea: { normalize: est.normalize, plan: est.plan, note: 'estimated from the real prompts (chars/4); output ~1.5-4k tokens per plan; repairs add ~1 plan-sized prompt each' } },
  m10_causeResultCompleteness: pct(accepted.filter((r) => gate(r, 'S04')).length, accepted.length),
  m11_reversalPlacementCompliance: pct(accepted.filter((r) => gate(r, 'S06')).length, accepted.length),
  m12_loopCompliance: pct(accepted.filter((r) => gate(r, 'S07')).length, accepted.length),
  m13_mutedStoryHeuristicScore_mean: +(accepted.reduce((a, r) => a + (r.rec.mutedStoryScore ?? 0), 0) / Math.max(1, accepted.length)).toFixed(1),
  m14_cameraQualityPass_firstCompiled: pct(compat.filter((r) => camOk(firstAtt(r))).length, compat.filter((r) => firstAtt(r)?.analysis).length),
  m14b_cameraQualityPass_final: pct(compat.filter((r) => camOk(finalAtt(r))).length, compat.filter((r) => finalAtt(r)?.analysis).length),
  m15_collisionQualityPass_firstCompiled: pct(compat.filter((r) => collOk(firstAtt(r))).length, compat.filter((r) => firstAtt(r)?.analysis).length),
  m15b_collisionQualityPass_final: pct(compat.filter((r) => collOk(finalAtt(r))).length, compat.filter((r) => finalAtt(r)?.analysis).length),
  m16_deterministicRecompilation: pct(detOk, accepted.length),
  zeroArbitraryCodeExecution: 'by construction: provider output is parsed as data and schema-validated; no eval/Function/dynamic import/shell exists on the output path (tests/story.security.test.ts)',
  silentAssetInvention: rows.filter((r) => r.rec.episode && !r.rec.episode.cast.every((c) => reg.characters[c.id])).length,
  confusion: {
    compatible: { accepted: compat.filter((r) => r.rec.status === 'accepted').length, rejected: compat.filter((r) => r.rec.status === 'rejected').length, failed: compat.filter((r) => r.rec.status === 'failed').length },
    mustReject: { rejected: rej.filter((r) => r.rec.status === 'rejected').length, accepted: rej.filter((r) => r.rec.status === 'accepted').map((r) => r.item.id), failed: rej.filter((r) => r.rec.status === 'failed').map((r) => r.item.id) },
    ipTransform: ipT.map((r) => `${r.item.id}: ${r.rec.status}${r.rec.status === 'accepted' ? ' (brand removed)' : ''}`),
  },
  perEngine: Object.fromEntries(['ordinary_object_extreme', 'visible_secret_chase', 'apparent_win_instant_loss', 'noob_vs_smart'].map((e) => { const c = compat.filter((r) => r.item.engine === e); return [e, { compatible: c.length, firstPass: c.filter((r) => r.rec.status === 'accepted' && r.rec.repairs === 0).length, afterRepair: c.filter((r) => r.rec.status === 'accepted').length }]; })),
  substitutionsDeclared: rows.reduce((a, r) => a + r.rec.substitutions.length, 0),
  failures: rows.filter((r) => r.rec.status === 'failed').map((r) => ({ id: r.item.id, expected: r.item.expected, reason: r.rec.failure })),
  determinism: { sameProcessAndFresh: `${detOk}/${accepted.length}`, mismatches: sameProc.filter((x) => !(x.a && x.a === x.b && x.a === x.want && fresh[x.id] === x.want)).map((x) => x.id) },
};
writeFileSync(join(out, 'metrics.json'), JSON.stringify(metrics, null, 2));
const tbl = rows.map((r) => `| ${r.item.id} | ${r.item.kind} | ${r.item.expected} | **${r.rec.status}** | ${r.rec.repairs} | ${r.rec.substitutions.length} | ${(r.rec.rejection?.category ?? '')} | ${(r.rec.rejection?.reason ?? r.rec.failure ?? '').replace(/\|/g, '/').slice(0, 120)} |`).join('\n');
writeFileSync(join(out, 'results.md'), `# Benchmark results — provider \`${providerName}\`\n\nDataset \`${setFile}\` (${rows.length} ideas). Analyzer: ${staticOnly ? 'off (static only)' : 'on'}.\n\n\`\`\`json\n${JSON.stringify(metrics, null, 2)}\n\`\`\`\n\n| id | kind | expected | result | repairs | subs | reject category | reason |\n|---|---|---|---|---|---|---|---|\n${tbl}\n`);
console.log(JSON.stringify(Object.fromEntries(Object.entries(metrics).filter(([k]) => k.startsWith('m'))), null, 1));
