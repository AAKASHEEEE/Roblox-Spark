// Narrated camera-repair diagnostics (analysis only: no pixels, no encode, no audio, no browser).
//   node scripts/narrated-camera-repair.ts --phase before|after [--shots s011,s012,...] [--out out/narrated-camera-repair]
// Writes blocked-shots-<phase>.json (one record per blocked source shot, with every planning sample, every candidate
// attempted and its exact rejection reasons). The `after` phase also writes analysis-report.json and camera-plan.json.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ROOT } from '../apps/render-worker/lib/server.ts';
import { loadLibrary, sha256 } from '../apps/render-worker/lib/library.ts';
import { draftEpisodeFor } from '../apps/studio/narrated-draft.ts';
import { integrateNarrated, type ShotTrace, type FrameGeo, type IntegratedTimeline } from '../apps/render-worker/narrated-integration.ts';
import { compileNarratedTimeline, DRAFT_EXPORT } from '../packages/narrated/src/timeline.ts';
import { buildWorldPlan, worldAssets } from '../packages/narrated/src/world.ts';
import { validateEpisode } from '../packages/pipeline/src/validate.ts';
import { headlessEngine } from '../packages/engine/src/headless.ts';

const arg = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const phase = arg('phase', 'before');
const out = resolve(ROOT, arg('out', 'out/narrated-camera-repair'));
const BLOCKED_BEFORE = ['s011', 's012', 's016a', 's021', 's024', 's025', 's027', 's035', 's039'];
const watch = arg('shots', BLOCKED_BEFORE.join(',')).split(',');
mkdirSync(out, { recursive: true });

const text = readFileSync(join(ROOT, 'tests/fixtures/narrated/approved-narrated-v0.1.json'), 'utf8'), sb = JSON.parse(text);
const lib = loadLibrary();
const T0 = Date.now();
const tl = compileNarratedTimeline(sb, sha256(text));
const v = validateEpisode(draftEpisodeFor(sb, tl, lib), lib as never, { repair: true, profile: 'narrated-draft' });
if (!v.ok || !v.episode) throw new Error('draft episode failed validation');
const plan = buildWorldPlan(sb, worldAssets(lib as never));
const { prod } = headlessEngine(v.episode, lib as never, DRAFT_EXPORT.width, DRAFT_EXPORT.height);
const trace: ShotTrace[] = [];
const r = integrateNarrated({ sb, tl, plan, prod, width: DRAFT_EXPORT.width, height: DRAFT_EXPORT.height, trace });
const T = r.timeline as IntegratedTimeline, A = r.analysis as any, geos = r.geos as FrameGeo[];
const fps = plan.fps, N = plan.frames;
const r3 = (x: number) => Math.round(x * 1e3) / 1e3, r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const phrases = new Map<string, any>(sb.script.phrases.map((p: any) => [p.id, p]));
const range = (s: number, e: number) => { const a = Math.round(s * fps), b = Math.max(a + 1, Math.min(N, Math.round(e * fps))); return [a, b] as const; };

function motion(s: number, e: number) {
  const [a, b] = range(s, e), g0 = geos[a], g1 = geos[b - 1];
  const actors: Record<string, { rootDisplacementM: number; maxRootStepM: number; yawChangeDeg: number; postures: string[] }> = {};
  for (const id of Object.keys(g0.actors)) {
    let step = 0; const post = new Set<string>();
    for (let k = a; k < b; k++) { post.add(geos[k].actors[id].posture); if (k > a) step = Math.max(step, Math.hypot(...[0, 1, 2].map((q) => geos[k].actors[id].root[q] - geos[k - 1].actors[id].root[q]) as [number, number, number])); }
    actors[id] = { rootDisplacementM: r4(Math.hypot(g1.actors[id].root[0] - g0.actors[id].root[0], g1.actors[id].root[2] - g0.actors[id].root[2])), maxRootStepM: r4(step), yawChangeDeg: r3(g1.actors[id].yawDeg - g0.actors[id].yawDeg), postures: [...post] };
  }
  const coinScales = geos.slice(a, b).map((g) => g.coinScale);
  const coin = { visible: geos.slice(a, b).some((g) => g.coinVisible), scaleMin: r4(Math.min(...coinScales)), scaleMax: r4(Math.max(...coinScales)) };
  const moves = Object.values(actors).some((x) => x.rootDisplacementM > 0.02 || x.maxRootStepM > 0.005) || coin.scaleMax - coin.scaleMin > 1e-3;
  return { moves, actors, coin };
}

function record(shotId: string) {
  const s = T.shots.find((x) => x.id === shotId), src = s ?? T.shots.find((x) => x.sourceShot === shotId.replace(/[ab]$/, ''));
  const covering = T.shots.filter((x) => x.sourceShot === (s?.sourceShot ?? shotId.replace(/[ab]$/, '')) || x.id === shotId || x.id.startsWith(`${shotId}.`) || x.id.startsWith(`${shotId.replace(/[ab]$/, '')}`));
  const base = s ?? src!;
  const p = phrases.get(base.phraseId);
  const trs = trace.filter((q) => q.shotId === shotId || q.shotId.startsWith(`${shotId}`) || (s ? false : q.shotId.startsWith(shotId.replace(/[ab]$/, ''))));
  const pl = T.captionPlacements.find((q) => q.chunkId === base.chunkId);
  const evs = plan.events.filter((e: any) => e.t >= base.start - 1e-9 && e.t < base.end - 1e-9).map((e: any) => ({ t: e.t, type: e.type, ...(e.entity ? { entity: e.entity } : {}) }));
  const cands = trs.flatMap((q) => q.candidates.map((c) => ({ trace: q.shotId, ...c })));
  const hist: Record<string, number> = {};
  for (const c of cands) for (const x of c.reasons) { const k = x.split(':')[0]; hist[k] = (hist[k] ?? 0) + 1; }
  const vals = (f: (c: typeof cands[number]) => number | null) => cands.map(f).filter((x): x is number => x !== null && Number.isFinite(x));
  const bestOf = (xs: number[], mx: boolean) => (xs.length ? (mx ? Math.max(...xs) : Math.min(...xs)) : null);
  const closest = [...cands].sort((a, b) => a.reasons.length - b.reasons.length || b.samplesPassed - a.samplesPassed || (a.id < b.id ? -1 : 1)).slice(0, 5);
  return {
    shotId, phraseId: base.phraseId, captionChunkId: base.chunkId, start: base.start, end: base.end,
    coveringShots: covering.map((x) => ({ id: x.id, start: x.start, end: x.end, coverage: x.coverage, intent: x.spec.intent, active: x.spec.active, camera: x.camera ? { kind: x.camera.kind, id: x.camera.id, motion: (x.camera as any).motion ?? 'static' } : null, blocked: x.blocked, droppedOptional: x.droppedOptional })),
    phraseText: p?.text, semanticAction: p?.semanticAction, actorRole: p?.actorRole,
    activeActor: base.spec.active, supportingActor: p?.supportingCharacter ?? null,
    requiredActors: base.spec.subjects.filter((q) => !base.spec.optional.includes(q)), optionalActors: base.spec.optional, heroProps: base.spec.heroProps,
    actionEvents: { phraseAction: p?.semanticAction, propEvents: p?.propEvents ?? [], worldEventsInShot: evs },
    requestedIntent: base.spec.intent, specReason: base.spec.reason,
    sampledFrames: trs.map((q) => ({ plannedShot: q.shotId, frames: q.sampleFrames })),
    candidatesAttempted: trs.reduce((a2, q) => a2 + q.candidatesAttempted, 0),
    candidatesAccepted: cands.filter((c) => c.accepted).length,
    rejectionReasonHistogram: Object.fromEntries(Object.entries(hist).sort((x, y) => y[1] - x[1])),
    metricsAcrossCandidates: {
      faceVisibilityMin: { best: bestOf(vals((c) => c.metrics.faceVisibilityMin), true), worst: bestOf(vals((c) => c.metrics.faceVisibilityMin), false) },
      headHeightPctMin: { best: bestOf(vals((c) => c.metrics.headHeightPctMin), true), worst: bestOf(vals((c) => c.metrics.headHeightPctMin), false) },
      heroPropVisibilityMin: { best: bestOf(vals((c) => c.metrics.heroPropVisibilityMin), true), worst: bestOf(vals((c) => c.metrics.heroPropVisibilityMin), false) },
      foregroundClutterMax: { best: bestOf(vals((c) => c.metrics.foregroundClutter), false), worst: bestOf(vals((c) => c.metrics.foregroundClutter), true) },
      lensClearanceM: { best: bestOf(vals((c) => c.metrics.lensClearanceM), true), worst: bestOf(vals((c) => c.metrics.lensClearanceM), false) },
      screenDirection: [...new Set(cands.map((c) => c.metrics.screenDirection.split(':')[0]))].sort(),
    },
    closestCandidates: closest,
    captionBand: pl ? { band: pl.band, centerY: pl.centerY, blocked: pl.blocked, violations: pl.violations, cameraRetries: pl.cameraRetries, note: covering.some((x) => !x.camera) ? 'no accepted camera for a shot of this chunk: no placement' : 'placed' } : null,
    motion: motion(base.start, base.end),
    candidates: cands.map((c) => ({ trace: c.trace, id: c.id, intent: c.intent, accepted: c.accepted, samplesPassed: c.samplesPassed, failedAtFrame: c.failedAtFrame, reasons: c.reasons, metrics: c.metrics })),
  };
}

const blockedNow = T.shots.filter((s) => !s.camera).map((s) => s.id);
const records = (phase === 'before' ? watch : [...new Set([...watch, ...blockedNow])]).map(record);
const doc = { schema: 'blockspark.narrated-camera-repair/1', phase, storyboardId: sb.id, frames: N, fps, blockedShots: blockedNow, gates: `${A.summary.passed}/${A.summary.total}`, failedGates: A.summary.failed, records };
writeFileSync(join(out, `blocked-shots-${phase}.json`), JSON.stringify(doc, null, 1));
if (phase === 'after') {
  writeFileSync(join(out, 'analysis-report.json'), JSON.stringify({ ...A, timingSec: (Date.now() - T0) / 1000 }, null, 2));
  writeFileSync(join(out, 'camera-plan.json'), JSON.stringify({ schema: T.schema, frames: T.frames, fps: T.fps, width: T.width, height: T.height, shots: T.shots, captions: T.captions, captionPlacements: T.captionPlacements, sequentialCoverage: T.sequentialCoverage, frameCoverage: A.frameCoverage ?? null }, null, 1));
}
console.log(`${phase}: ${A.summary.passed}/${A.summary.total} gates; blocked ${blockedNow.join(', ') || 'none'}; ${((Date.now() - T0) / 1000).toFixed(1)} s`);
for (const g of A.gates) if (!g.pass) console.log(`  ${g.id} ${g.name}: ${g.detail}`);
for (const x of records) console.log(`  ${x.shotId} ${x.phraseId} ${x.requestedIntent} active=${x.activeActor} req=${x.requiredActors} tried=${x.candidatesAttempted} ok=${x.candidatesAccepted} top=${Object.entries(x.rejectionReasonHistogram).slice(0, 4).map(([k, n]) => `${k}×${n}`).join(',')} moves=${x.motion.moves}`);
