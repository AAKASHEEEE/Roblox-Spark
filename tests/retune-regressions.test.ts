// Regression tests for every Run 3 failure mechanism (docs/story/bench/run3-failure-mechanisms.md).
// Each test uses FROZEN Run 3 records (never modified): it replays the first-pass episode Run 3 measured (attempt-0 plan +
// recorded staging through the unfitted compiler, which reproduces the frozen episodes byte-identically), shows the
// mechanism is present under corrected-head-v2 (and, where the mechanism is profile-coupled, absent when the same episode
// is declared legacy-head-v1), then shows the current generator's first pass for the same plan (profile-aware staging +
// fit pass) has NO blocking QA issue under either profile. QA = the analyzer's checks on every frame (headless-qa.ts).
// These are tuning data: passing here is not a benchmark result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lib, ROOT } from './helpers.ts';
import { headlessQa, type HeadlessQa } from '../apps/render-worker/lib/headless-qa.ts';
import { headlessEngine } from '../packages/engine/src/headless.ts';
import { buildRegistry } from '../packages/story/src/registry.ts';
import { stagePlan } from '../packages/story/src/stage.ts';
import { compileEpisode, type CompileOk, type FitKnobs } from '../packages/story/src/compile.ts';
import { fitCompile, HOP_LADDER, type FitReport } from '../packages/story/src/fit.ts';
import { measureClearance, PAD } from '../packages/story/src/envelope.ts';
import type { Episode } from '../packages/schema/src/episode.ts';

const reg = buildRegistry(lib);
const V2 = 'corrected-head-v2', L1 = 'legacy-head-v1';
const redeclare = (ep: Episode, mp: string): Episode => ({ ...ep, render: { ...ep.render, motionProfile: mp } } as Episode);
const record = (dir: string, id: string) => JSON.parse(readFileSync(join(ROOT, 'docs/story/bench', dir, 'records', `${id}.json`), 'utf8')).record;
const codes = (q: HeadlessQa) => new Set(q.blocking.map((b) => b.code));

interface Case { run3: { ep: Episode; v2: HeadlessQa; legacy: HeadlessQa; constraints: string[] }; now: Record<string, { ep: Episode; report: FitReport; qa: HeadlessQa }> }
const cache = new Map<string, Case>();
/** replay Run 3 attempt `n` of an idea (its recorded plan + staging, unfitted) and run the current generator on that plan */
function scan(dir: string, id: string, n = 0): Case {
  const key = `${dir}/${id}#${n}`;
  if (cache.has(key)) return cache.get(key)!;
  const rec = record(dir, id), a0 = rec.attempts[n];
  const first = compileEpisode(rec.request, rec.normalized, a0.plan, a0.staging, reg);
  assert.ok(first.ok, `${id}: Run 3 attempt ${n} must replay`);
  const ep = (first as CompileOk).episode;
  assert.equal(ep.render.motionProfile, V2, `${id}: Run 3 measured corrected-head-v2`);
  const sp = stagePlan(a0.plan, reg.environment);
  const now: Case['now'] = {};
  for (const mp of [V2, L1]) {
    const req = { ...rec.request, motionProfile: mp };
    const { compiled, report } = fitCompile((k?: FitKnobs) => compileEpisode(req, rec.normalized, a0.plan, sp.staging, reg, k), lib as never);
    assert.ok(compiled.ok && report, `${id}: current first pass compiles under ${mp}`);
    now[mp] = { ep: (compiled as CompileOk).episode, report: report!, qa: headlessQa((compiled as CompileOk).episode, lib) };
  }
  const c: Case = { run3: { ep, v2: headlessQa(ep, lib), legacy: headlessQa(redeclare(ep, L1), lib), constraints: (a0.constraints ?? []).map((x: { code: string }) => x.code) }, now };
  cache.set(key, c);
  return c;
}
/** the mechanism as Run 3 RECORDED it (attempt n) + reproduced + the current generator clear under both profiles.
 *  Only recorded constraints count: the every-frame QA also finds 1-2 frame issues Run 3's analyzer (every 3rd frame) missed. */
function mechanism(dir: string, id: string, code: string | string[], profileCoupled: boolean, n = 0): Case {
  const c = scan(dir, id, n);
  const want = Array.isArray(code) ? code : [code];
  assert.ok(want.some((x) => c.run3.constraints.includes(x)), `${id}: Run 3 attempt ${n} recorded ${want.join('/')} (got ${c.run3.constraints.join(',')})`);
  for (const x of want) assert.ok(codes(c.run3.v2).has(x), `${id}: ${x} reproduced under corrected-head-v2 (got ${[...codes(c.run3.v2)].join(',')})`);
  if (profileCoupled) for (const x of want) assert.ok(!codes(c.run3.legacy).has(x), `${id}: ${x} absent when the same episode is declared legacy-head-v1`);
  else for (const x of want) assert.ok(codes(c.run3.legacy).has(x), `${id}: ${x} also present under legacy-head-v1 (not profile-coupled, as catalogued)`);
  for (const mp of [V2, L1]) {
    const q = c.now[mp].qa;
    assert.deepEqual(q.blocking.map((b) => `${b.code} ${b.shot} ${b.first}`), [], `${id}: current first pass under ${mp} has no blocking QA issue`);
    assert.deepEqual(c.now[mp].report.residual, [], `${id}: no residual constraint under ${mp}`);
  }
  return c;
}

test('M1 hand penetration at the corrected run onset: reproduced, profile-coupled, removed by the envelope pre-align', { timeout: 120000 }, () => {
  for (const [dir, id] of [['run3-rules-posthoc', 'A04'], ['run3-holdout2', 'HB03']]) {
    const c = mechanism(dir, id, ['HAND_PENETRATION', 'HAND_SWEEP_PENETRATION'], true);
    // the remedy is derived from the sampled envelope of the DECLARED profile: the same plan is pre-aligned only under v2
    assert.ok(c.now[V2].report.knobs.preAlign.some((k) => /:run:/.test(k)), `${id}: v2 run onset pre-aligned`);
    assert.deepEqual(c.now[L1].report.knobs.preAlign, [], `${id}: legacy onset needs no pre-align`);
    // the collision sits in the onset window of a locomotion action (0.35 s before start .. first 1.0 s)
    const hit = c.run3.v2.issues.find((i) => i.code === 'HAND_SWEEP_PENETRATION')!;
    assert.ok(c.run3.ep.actions.some((a) => a.action === 'run' && hit.t >= a.start - 0.35 - 1e-9 && hit.t <= a.start + 1.0 + 1e-9), `${id}: swept hit ${hit.t} inside a run onset window`);
  }
});

test('M1 swept hand volume includes transition frames between video frames', { timeout: 60000 }, () => {
  const load = (f: string) => JSON.parse(readFileSync(join(ROOT, f), 'utf8')) as Episode;
  const perFrame = (ep: Episode) => { const e = headlessEngine(ep, lib, 270, 480); let n = 0; for (let i = 0; i < Math.round(ep.episode.duration * ep.episode.fps); i++) n += e.prod.handPenetrations(i / ep.episode.fps).length; return n; };
  // the unfitted generator fixture (b13ae71): clean on every video frame, but the hand passes through the coin between frames
  const old = load('tests/fixtures/episodes/gen-example-free-coins.json');
  assert.equal(perFrame(old), 0, 'no per-frame hand penetration');
  const sw = headlessEngine(old, lib, 270, 480).prod.sweptHandIssues({ substeps: 4 });
  assert.ok(sw.length >= 1, 'swept check finds the between-frame pass-through');
  assert.ok(sw.some((s) => Math.abs(s.t * old.episode.fps - Math.round(s.t * old.episode.fps)) > 1e-6), `a hit on a transition sample (not a video frame): ${sw.map((s) => s.t).join(',')}`);
  // the same idea through the re-tuned generator: clean per frame, between frames and under the padded envelope
  const tuned = load('tests/fixtures/episodes/gen-example-free-coins.tuned.json');
  assert.equal(tuned.render.motionProfile, V2);
  assert.equal(perFrame(tuned), 0);
  assert.deepEqual(headlessEngine(tuned, lib, 270, 480).prod.sweptHandIssues({ substeps: 4 }).map((s) => s.message), []);
  assert.deepEqual(measureClearance(headlessEngine(tuned, lib, 270, 480)).filter((i) => i.enforced).map((i) => i.message), []);
});

test('M2 face leaves a tight reaction shot under the corrected gaze: sampled over the complete shot, refitted', { timeout: 120000 }, () => {
  const c = mechanism('run3-rules-posthoc', 'C05', 'FACE_OUT_OF_FRAME', true);
  // the face was framed at the shot's first frame (where the camera is solved) and left later: start-of-shot framing misses it
  const b = c.run3.v2.blocking.find((x) => x.code === 'FACE_OUT_OF_FRAME')!;
  const sh = c.run3.ep.shots.find((s) => s.id === b.shot)!;
  const firstBad = Math.min(...c.run3.v2.issues.filter((i) => i.code === 'FACE_OUT_OF_FRAME' && i.shot === b.shot).map((i) => i.t));
  assert.ok(firstBad > sh.start + 0.2, `${b.shot}: first out-of-frame frame ${firstBad} is well after the shot start ${sh.start}`);
  // the fit pass changed that shot's camera from sampled face bounds
  const ep = c.now[V2].ep, fitted = c.now[V2].report.framing.find((f) => f.shot === ep.shots.find((s) => Math.abs(s.start - sh.start) < 0.5 && s.preset === sh.preset)?.id);
  assert.ok(fitted, 'the same reaction shot exists in the fitted episode');
  assert.ok(c.now[V2].report.framing.every((f) => f.qaOk), 'every fitted shot is QA-acceptable over all its frames');
});

test('M3 face turned away over part of a shot: refitted', { timeout: 120000 }, () => {
  mechanism('run3-holdout2', 'HB12', 'FACE_TURNED_AWAY', false);
});

test('M4 actor overlap in the noob-vs-smart staging: path-aware waiting mark + sampled actor spacing', { timeout: 120000 }, () => {
  for (const [dir, id] of [['run3-holdout2', 'HB10'], ['run3-rules-posthoc', 'D02']]) {
    const c = mechanism(dir, id, 'ACTOR_OVERLAP', false);
    const rec = record(dir, id), plan = rec.attempts[0].plan;
    const env = reg.environment, xz = (m: string) => [env.marks[m].pos[0], env.marks[m].pos[2]];
    const dist = (a: number[], b: number[], p: number[]) => { const dx = b[0] - a[0], dz = b[1] - a[1], u = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / (dx * dx + dz * dz))); return Math.hypot(a[0] + dx * u - p[0], a[1] + dz * u - p[1]); };
    const P = plan.roles.protagonist, F = plan.roles.foil;
    const run3 = rec.attempts[0].staging, nowSt = stagePlan(plan, env).staging;
    const walk = (st: typeof nowSt) => st.moves.find((m) => m.actor === P && m.slot === 'premise')!;
    assert.ok(dist(xz(walk(run3).from), xz(walk(run3).to), xz(run3.start[F])) < 0.45, `${id}: Run 3 walk-in passed the waiting ${F} closer than the QA limit`);
    assert.ok(dist(xz(walk(nowSt).from), xz(walk(nowSt).to), xz(nowSt.start[F])) >= PAD.actorMin, `${id}: current staging keeps ${PAD.actorMin} m`);
    for (const mp of [V2, L1]) assert.deepEqual(measureClearance(headlessEngine(c.now[mp].ep, lib, 270, 480)).filter((i) => i.code === 'ACTOR_CLEARANCE').map((i) => i.message), [], `${id} ${mp}: sampled actor spacing`);
  }
});

test('M5 head/body inside the leaping prop: held reaction + arc from the sampled body envelope, inside the room', { timeout: 180000 }, () => {
  mechanism('run3-holdout-posthoc', 'H05', 'BODY_PROP_INTERSECTION', false);
  mechanism('run3-holdout2', 'HB12', 'BODY_PROP_INTERSECTION', false, 1); // recorded in HB12's first repair attempt
  // A12: the Run 3 failure that the first re-tune could not remove (arc ladder top 3.4 m still 0.4 cm into the head):
  const c = mechanism('run3-rules-posthoc', 'A12', 'BODY_PROP_INTERSECTION', false);
  for (const mp of [V2, L1]) {
    const k = c.now[mp].report.knobs;
    assert.ok((k.holdReaction ?? []).length > 0, `${mp}: the victim holds its recoil through the takeoff`);
    assert.ok((k.hopHeight ?? 1.5) <= 2.3 + 1e-9, `${mp}: arc ${k.hopHeight} stays low`);
    assert.deepEqual(measureClearance(headlessEngine(c.now[mp].ep, lib, 270, 480)).filter((i) => i.enforced).map((i) => i.message), []);
  }
  // an arc that leaves the room is itself a clearance violation (the old ladder top went through the ceiling line)
  const rec = record('run3-rules-posthoc', 'A12'), plan = rec.attempts[0].plan, sp = stagePlan(plan, reg.environment);
  const high = compileEpisode(rec.request, rec.normalized, plan, sp.staging, reg, { preAlign: [], shots: {}, hopHeight: HOP_LADDER[HOP_LADDER.length - 1] });
  assert.ok(high.ok);
  const oob = measureClearance(headlessEngine((high as CompileOk).episode, lib, 270, 480)).filter((i) => i.code === 'PROP_BOUNDS');
  assert.ok(oob.length > 0 && oob.every((i) => i.enforced), 'a 3.4 m arc leaves the room and is enforced');
});

test('M6 hero prop occluded (frames and press contacts): refitted', { timeout: 120000 }, () => {
  mechanism('run3-holdout2', 'HB12', 'PROP_OCCLUDED', false);
});

test('M7 subject centre outside the action-safe area: refitted', { timeout: 120000 }, () => {
  mechanism('run3-holdout-posthoc', 'H05', 'SUBJECT_OUTSIDE_ACTION_SAFE', false);
});

test('fit pass is deterministic and replays from its knobs under both profiles', { timeout: 120000 }, () => {
  const rec = record('run3-rules-posthoc', 'C05'), plan = rec.attempts[0].plan, sp = stagePlan(plan, reg.environment);
  for (const mp of [V2, L1]) {
    const req = { ...rec.request, motionProfile: mp };
    const compile = (k?: FitKnobs) => compileEpisode(req, rec.normalized, plan, sp.staging, reg, k);
    const a = fitCompile(compile, lib as never), b = fitCompile(compile, lib as never);
    assert.ok(a.compiled.ok && b.compiled.ok);
    assert.equal(JSON.stringify((a.compiled as CompileOk).episode), JSON.stringify((b.compiled as CompileOk).episode), `${mp}: two fits identical`);
    assert.deepEqual(a.report!.knobs, b.report!.knobs);
    const replay = compile(JSON.parse(JSON.stringify(a.report!.knobs)));
    assert.ok(replay.ok);
    assert.equal(JSON.stringify((replay as CompileOk).episode), JSON.stringify((a.compiled as CompileOk).episode), `${mp}: compile(knobs) replays the fitted episode`);
  }
});
