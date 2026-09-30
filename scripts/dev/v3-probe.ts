// Dev probe (no pixels): evaluate one hand-built shot spec's candidates over every frame of a window and print the
// best candidates / rejection tallies.  node scripts/dev/v3-probe.ts <spec-json> <a> <b> [prevSide] [prevNeutral]
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from '../../apps/render-worker/lib/server.ts';
import { loadLibrary, sha256 } from '../../apps/render-worker/lib/library.ts';
import { compileNarratedTimeline, DRAFT_EXPORT } from '../../packages/narrated/src/timeline.ts';
import { buildWorldPlan, worldAssets } from '../../packages/narrated/src/world.ts';
import { validateEpisode } from '../../packages/pipeline/src/validate.ts';
import { headlessEngine } from '../../packages/engine/src/headless.ts';
import { NarratedScene, extractFrameGeo, cameraScene, candidatesFor, shotEnvelope, longLensInsertCandidates, type ShotSpec } from '../../apps/render-worker/narrated-integration.ts';
import { evaluateCameraCandidate, type CameraCandidate } from '../../packages/engine/src/camera-safety.ts';
import { draftEpisodeFor } from '../../apps/studio/narrated-draft.ts';

const text = readFileSync(resolve(ROOT, 'tests/fixtures/narrated/approved-narrated-v0.1.json'), 'utf8'), sb = JSON.parse(text), lib = loadLibrary();
const tl = compileNarratedTimeline(sb, sha256(text));
const v = validateEpisode(draftEpisodeFor(sb, tl, lib), lib as never, { repair: true, profile: 'narrated-draft' });
const plan = buildWorldPlan(sb, worldAssets(lib as never));
const { prod } = headlessEngine(v.episode!, lib as never, DRAFT_EXPORT.width, DRAFT_EXPORT.height);
const ns = new NarratedScene(prod, plan);
const geos = [];
let prev = null;
for (let i = 0; i < plan.frames; i++) { const { world, diag } = ns.pose(i / plan.fps, prev); geos.push(extractFrameGeo(ns, i, world, diag)); prev = world; }
const spec: ShotSpec = JSON.parse(process.argv[2]);
const a = Number(process.argv[3]), b = Number(process.argv[4]);
const sd = process.argv[5] ? { previousCameraSide: process.argv[5] === 'none' ? undefined : process.argv[5] as 'left' | 'right', previousWasNeutral: process.argv[6] === '1' } : undefined;
const W = DRAFT_EXPORT.width, H = DRAFT_EXPORT.height, mid = geos[Math.floor((a + b) / 2)];
console.log("button", JSON.stringify(mid.props.button), "zapp head", JSON.stringify(mid.actors.zapp.head), "kira head", JSON.stringify(mid.actors.kira?.head), "cs", JSON.stringify(prod.env.manifest.cameraSafe));
const env = shotEnvelope(geos, a, b, spec);
const eyeline = mid.actors[spec.active]?.lookTarget ? `eyeline:${spec.active}` : null;
const fromTl = (id: string): CameraCandidate[] => { const sh = JSON.parse(readFileSync(resolve(ROOT, 'out/v3-baseline/render-timeline.json'), 'utf8')).integrated.shots.find((x: { id: string }) => x.id === id); const c = sh.camera; return [{ id: `v2:${c.id}`, intent: c.intent, transform: { position: c.position }, target: c.target, fov: c.fovDeg, ...c.eval, ...(spec.excluded ? { excludedSubjectIds: spec.excluded } : {}), ...(spec.strictHeadEdge ? { partialHeadsBlocking: true } : {}) }]; };
const extra: CameraCandidate[] = process.argv[7]?.startsWith('tl:') ? fromTl(process.argv[7].slice(3)) : process.argv[7] === 'long' ? longLensInsertCandidates(cameraScene(mid, spec, W, H, sd), spec, 'probe') : [];
const cands = [...extra, ...candidatesFor(cameraScene(mid, spec, W, H, sd), spec, 'probe', env, eyeline)];
const tally: Record<string, number> = {}, passing: Array<{ id: string; min: number; side: string; sd: string }> = [];
const near: Array<{ id: string; fails: number; reasons: string[] }> = [];
for (const c of cands) {
  let ok = true, min = Infinity, fails = 0, side = '', sdr = '';
  const rs = new Set<string>();
  for (let k = a; k < b; k++) {
    const r = evaluateCameraCandidate(cameraScene(geos[k], spec, W, H, k === a ? sd : { ...sd, previousCameraSide: undefined }), c);
    if (k === a) { side = r.diagnostics.cameraSide; sdr = r.screenDirectionResult; }
    if (!r.accepted) { ok = false; fails++; for (const x of r.rejectionReasons) rs.add(x.split(':').slice(0, 2).join(':')); if (process.argv[8] !== 'all' && fails > 3) break; } else min = Math.min(min, r.score);
  }
  for (const x of rs) tally[x.split(':')[0]] = (tally[x.split(':')[0]] ?? 0) + 1;
  if (process.env.COV) { let mx = 0, hd = 0; for (let k = a; k < b; k++) { const r = evaluateCameraCandidate(cameraScene(geos[k], spec, W, H, sd), c); mx = Math.max(mx, r.diagnostics.entityCoverage.zapp ?? 0); if (r.diagnostics.partialHeads.length || (r.diagnostics.headScreenHeight.zapp ?? 0) > 0) hd++; } console.log("COV", c.id, "zapp max coverage", mx, "frames with zapp head projected", hd); }
  if (ok) passing.push({ id: c.id, min, side, sd: sdr }); else near.push({ id: c.id, fails, reasons: [...rs] });
}
console.log(`${cands.length} candidates, ${passing.length} pass every frame ${a}-${b}`);
console.log(passing.sort((x, y) => y.min - x.min).slice(0, 12).map((x) => `  ${x.id} score ${x.min.toFixed(3)} ${x.side} ${x.sd}`).join('\n'));
console.log(JSON.stringify(Object.entries(tally).sort((x, y) => y[1] - x[1]).slice(0, 14)));
if (process.argv[9]) for (const n of near.filter((x) => x.id.includes(process.argv[9]))) console.log(n.id, n.fails, n.reasons.join(' '));
