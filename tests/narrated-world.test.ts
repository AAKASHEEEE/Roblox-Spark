// Narrated Checkpoint 1: authoritative world state, action contracts and the deterministic state trace, on the exact
// approved v0.1 storyboard (committed fixture: 69.146 s voice-over, 14 phrases, seed 17). Numeric tolerances only;
// no engine, browser, FFmpeg or rendering.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { lib, ROOT } from './helpers.ts';
import { buildWorldPlan, sampleWorld, traceWorld, summarizeWorld, worldAssets, coinBodyGap, MARK_IDS, MARK_LAYOUT } from '../packages/narrated/src/world.ts';
import { CONTRACTS, CONTRACT_IDS } from '../packages/narrated/src/contracts.ts';
import { compileNarratedTimeline } from '../packages/narrated/src/timeline.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const SB = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/narrated/approved-narrated-v0.1.json'), 'utf8'));
const A = worldAssets(lib as never), M = A.marks;
const plan = buildWorldPlan(SB, A);
const shots = compileNarratedTimeline(SB, sha(JSON.stringify(SB))).shots;
const trace = traceWorld(plan, shots);
const summary = summarizeWorld(plan, trace, sha);
const F = trace.frames;
const d2 = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[2] - b[2]);
const ev = (type: string) => plan.events.filter((e) => e.type === type);
const tipStart = ev('tip_start')[0].t, contact = ev('coin_patient_contact')[0].t;

test('0. plan, marks and contracts are complete and versioned', () => {
  assert.equal(plan.status, 'ok', JSON.stringify(plan.errors));
  assert.equal(plan.frames, 2075); assert.equal(plan.duration, 69.167); assert.equal(plan.seed, 17); assert.equal(SB.script.phrases.length, 14);
  assert.deepEqual(Object.keys(M).sort(), [...MARK_IDS].sort());
  const env = (lib as any).environments[MARK_LAYOUT.environment];
  for (const id of MARK_LAYOUT.existing) { assert.deepEqual(M[id].pos, env.marks[id].pos); assert.equal(M[id].facingDeg, env.marks[id].facingDeg); }
  assert.equal(M.classroom_door.offscreenOnly, true);
  for (const id of CONTRACT_IDS) { const c = CONTRACTS[id]; assert.equal(c.id, id); assert.ok(c.version && c.preconditions && c.end && c.validation.length && c.engine.length, id); }
  assert.equal(shots.length, 39);
});

test('1-3. Kira starts at kira_desk, moves continuously >= 1.4 m, and ends the safe move at kira_safe', () => {
  assert.ok(d2(F[0].a.kira, M.kira_desk.pos) < 1e-9);
  const ms = plan.instances.find((x) => x.contract === 'move_safely' && x.actor === 'kira')!;
  const w0 = sampleWorld(plan, ms.t0).actors.kira, w1 = sampleWorld(plan, ms.t1).actors.kira;
  assert.ok(d2(w0.pos, M.kira_desk.pos) < 1e-6);
  assert.ok(d2(w0.pos, w1.pos) >= 1.4, `${d2(w0.pos, w1.pos)} m`);
  assert.ok(d2(w1.pos, M.kira_safe.pos) <= 0.02);
  const seg = F.filter((f) => f.t >= ms.t0 && f.t <= ms.t1);
  for (let i = 1; i < seg.length; i++) assert.ok(d2(seg[i].a.kira, seg[i - 1].a.kira) <= 1.1 / 30 + 5e-4, 'continuous, <= walk speed (trace is rounded to 0.1 mm)');
  assert.ok(d2(sampleWorld(plan, contact).actors.kira.pos, M.kira_safe.pos) <= 0.02, 'at kira_safe when the coin lands');
});

test('4-5. Zapp reaches zapp_impact before the tip and reaches the button through a continuous bridge', () => {
  assert.ok(ev('reached_mark').some((e) => e.source === 'zapp' && e.target === 'zapp_impact' && e.t < tipStart));
  assert.ok(d2(sampleWorld(plan, tipStart).actors.zapp.pos, M.zapp_impact.pos) <= 0.02);
  const br = plan.bridges.find((b) => b.actor === 'zapp' && /press_button/.test(b.reason))!;
  assert.ok(br, 'press bridge recorded');
  const press = ev('press_contact')[0];
  assert.ok(press.t > br.t1 - 1e-9);
  const zw = sampleWorld(plan, press.t).actors.zapp;
  assert.ok(d2(zw.pos, A.button.pressSurface) <= 0.55 + 1e-9, 'within reach');
  assert.ok(Math.abs((((Math.atan2(A.button.pressSurface[0] - zw.pos[0], A.button.pressSurface[2] - zw.pos[2]) * 180) / Math.PI - zw.yawDeg + 540) % 360) - 180) <= 25, 'facing the button');
  const seg = F.filter((f) => f.t >= br.t0 - 0.05 && f.t <= press.t);
  for (let i = 1; i < seg.length; i++) { assert.ok(d2(seg[i].a.zapp, seg[i - 1].a.zapp) <= 1.1 / 30 + 5e-4); assert.ok(Math.abs(seg[i].a.zapp[3] - seg[i - 1].a.zapp[3]) <= 10.5, 'yaw <= 315 deg/s'); }
});

test('6-8. the coin appears at coin_spawn, grows about a fixed base (drift <= 0.01 m) and scales continuously', () => {
  const land = ev('coin_land')[0];
  assert.ok(d2(land.pos!, M.coin_spawn.pos) <= 0.01);
  assert.ok(d2(sampleWorld(plan, land.t + 0.05).props.coin.pos, M.coin_spawn.pos) <= 0.01);
  assert.ok(summary.coin.baseDriftDuringGrowthM <= 0.01, `${summary.coin.baseDriftDuringGrowthM}`);
  const s = F.map((f) => f.c[3]);
  for (let i = 1; i < s.length; i++) { assert.ok(s[i] >= s[i - 1] - 1e-9, 'never shrinks'); assert.ok(s[i] - s[i - 1] <= 0.6, `scale step ${s[i] - s[i - 1]} at frame ${i}`); }
  assert.equal(s[s.length - 1], 16.7);
});

test('9-12. the tip rotates continuously; exactly one contact, after the tip starts; the fall starts at contact', () => {
  const tipF = F.filter((f) => f.t >= tipStart && f.t <= plan.coin.tip!.t1 + 0.05);
  for (let i = 1; i < tipF.length; i++) { const d = tipF[i].c[4] - tipF[i - 1].c[4]; assert.ok(d >= -1e-9 && d <= 12, `rotation step ${d}`); }
  assert.equal(ev('coin_patient_contact').length, 1);
  assert.equal(summary.contact.frameTransitions, 1);
  assert.ok(contact > tipStart);
  const fall = plan.instances.find((x) => x.contract === 'fall_prone')!;
  assert.ok(Math.abs(fall.t0 - contact) < 1e-3);
  for (const f of F.filter((f) => f.t < contact)) assert.notEqual(f.a.zapp[4], 'falling');
});

test('13-15. Zapp falls continuously into prone, stays prone to the end, and the reset does not stand him up', () => {
  const fall = plan.instances.find((x) => x.contract === 'fall_prone')!;
  const ff = F.filter((f) => f.t >= fall.t0 - 0.05 && f.t <= fall.t1 + 0.05);
  for (let i = 1; i < ff.length; i++) assert.ok(Math.abs(ff[i].a.zapp[8] - ff[i - 1].a.zapp[8]) <= 8, 'pitch <= 8 deg/frame');
  for (const f of F.filter((f) => f.t >= fall.t1 + 1e-9)) { assert.equal(f.a.zapp[4], 'prone'); assert.equal(f.a.zapp[8], 90); }
  const reset = ev('button_reset')[0];
  assert.ok(reset.t > fall.t1);
  for (const f of F.filter((f) => f.t >= reset.t)) assert.equal(f.a.zapp[4], 'prone');
  assert.equal(summary.zapp.finalPosture, 'prone');
});

test('16-17. Kira is outside the hazard at contact; the coin keeps its thickness; Zapp never enters the coin and stays uncovered', () => {
  const tip = plan.coin.tip!, R = A.coin.radius * tip.scale, th = (A.coin.thickness / 2) * tip.scale, b = plan.coin.base!;
  const k = sampleWorld(plan, contact).actors.kira.pos;
  const inHaz = k[0] > b[0] - R - 0.5 && k[0] < b[0] + R + 0.5 && k[2] > b[2] - th - 0.5 && k[2] < tip.pivot[2] + 2 * R + 0.5;
  assert.equal(inHaz, false);
  for (const f of F) { const c = sampleWorld(plan, f.t).props.coin; assert.ok(Math.abs(c.thickness / c.scale - A.coin.thickness) < 1e-9 && Math.abs(c.radius / c.scale - A.coin.radius) < 1e-9); }
  const fp = plan.actors.zapp.segs.find((s) => s.kind === 'fall')!.fall!;
  for (let i = 0; i < tip.coupled.length; i++) { const gap = coinBodyGap(fp.feet, fp.samples[i][1], tip.pivot, tip.coupled[i][1], R, th, A.body.height, A.body.radius); assert.ok(gap >= -1e-6, `penetration ${gap} at ${tip.coupled[i][0]}`); }
  // head at rest is beyond the coin's rim (not covered by the solid)
  const head = [fp.feet[0], A.body.radius, fp.feet[2] + A.body.height - 2 * A.body.radius];
  const along = (head[2] - tip.pivot[2]) * Math.sin((tip.thetaR * Math.PI) / 180) + head[1] * Math.cos((tip.thetaR * Math.PI) / 180);
  assert.ok(along > 2 * R, `head ${along} m along the face > rim ${2 * R} m`);
});

test('18-20. shot boundaries never alter transforms; no unexplained actor or prop teleport', () => {
  const bare = traceWorld(plan, []);
  assert.equal(JSON.stringify(bare.frames), JSON.stringify(trace.frames), 'identical with and without shot annotations');
  for (const s of trace.shots) { const w = sampleWorld(plan, s.start), v = sampleWorld(plan, Math.max(0, s.start - 1 / 30)); for (const id of ['zapp', 'kira']) assert.ok(d2(w.actors[id].pos, v.actors[id].pos) <= 1.1 / 30 + 1e-6, `${id} at ${s.id}`); }
  for (const [k, v] of Object.entries(summary.maxUnexplainedDisplacementPerFrameM)) assert.ok(v <= 1e-9, `${k} unexplained ${v}`);
  for (let i = 1; i < F.length; i++) { for (const id of ['zapp', 'kira']) assert.ok(Math.hypot(F[i].a[id][0] - F[i - 1].a[id][0], F[i].a[id][1] - F[i - 1].a[id][1], F[i].a[id][2] - F[i - 1].a[id][2]) <= 0.08); assert.ok(Math.hypot(F[i].c[0] - F[i - 1].c[0], F[i].c[1] - F[i - 1].c[1], F[i].c[2] - F[i - 1].c[2]) <= 0.3); }
});

test('21. same input and seed give a byte-identical summary and trace hash', () => {
  const p2 = buildWorldPlan(structuredClone(SB), worldAssets(lib as never)), t2 = traceWorld(p2, shots), s2 = summarizeWorld(p2, t2, sha);
  assert.equal(JSON.stringify(s2), JSON.stringify(summary));
  assert.equal(s2.traceSha256, summary.traceSha256);
});

test('22-23. failed preconditions are explicit errors (never silent); bridges are recorded', () => {
  assert.deepEqual(plan.bridges.map((b) => `${b.actor}:${b.forContract.startsWith('c') ? 'press_button' : b.forContract}`), ['zapp:press_button', 'zapp:tip_coin_onto', 'kira:remain_still']);
  const noSafe = structuredClone(SB);
  noSafe.script.phrases[10].text = 'Zapp tries to look confident in front of the coin.';
  const bad = buildWorldPlan(noSafe, A);
  assert.equal(bad.status, 'unavailable');
  const e = bad.errors.find((x) => x.code === 'TIP_PRECONDITION_FAILED')!;
  assert.match(e.message, /kira_at_kira_safe/);
  assert.equal(bad.events.filter((x) => x.type === 'coin_patient_contact').length, 0, 'the tip is not silently executed');
  assert.ok(traceWorld(bad).frames.every((f) => f.a.zapp[4] !== 'prone'));
  const getUp = structuredClone(SB);
  getUp.script.phrases[13].semanticAction = 'jump';
  const g = buildWorldPlan(getUp, A);
  assert.ok(g.errors.some((x) => x.code === 'GET_UP_UNAVAILABLE'));
  assert.equal(traceWorld(g).frames.at(-1)!.a.zapp[4], 'prone');
});

test('24-25. the teacher is never an actor; implied_seated carries the authored-animation warning', () => {
  assert.deepEqual(Object.keys(plan.actors).sort(), ['kira', 'zapp']);
  assert.ok(plan.offscreen.teacher.cues.length >= 3);
  for (const t of [0.5, 16, 60, 69]) { const w = sampleWorld(plan, t); assert.deepEqual(Object.keys(w.actors).sort(), ['kira', 'zapp']); assert.equal(w.offscreen.teacher.instantiated, false); }
  assert.ok(plan.warnings.some((w) => w.code === 'AUTHORED_SEATED_ANIMATION_UNAVAILABLE'));
  const rs = plan.instances.find((x) => x.contract === 'remain_still' && x.params.posture === 'implied_seated')!;
  assert.equal(rs.actor, 'kira'); assert.equal(rs.params.warning, 'AUTHORED_SEATED_ANIMATION_UNAVAILABLE'); assert.match(String(rs.params.framing), /waist_up/);
  const k = sampleWorld(plan, rs.t0 + 0.1).actors.kira;
  assert.equal(k.posture, 'implied_seated'); assert.ok(d2(k.pos, M.kira_desk.pos) <= 0.02);
});
