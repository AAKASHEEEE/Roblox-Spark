// Narrated Continuity Checkpoint 2: the engine-motion adapter drives real engine rigs and props from the authoritative
// WorldState of the approved v0.1 storyboard (committed fixture). Rigs are posed with forward kinematics only: a
// no-op 2D canvas stub satisfies face/texture construction; nothing is rendered, no browser, no FFmpeg.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

// ---------- headless canvas stub (texture construction only; no pixels are ever read) ----------
if (typeof (globalThis as any).OffscreenCanvas === 'undefined') {
  const ctx: any = new Proxy({}, { get: (_t, k) => (k === 'measureText' ? () => ({ width: 1 }) : k === 'createLinearGradient' || k === 'createRadialGradient' ? () => ({ addColorStop() {} }) : k === 'getImageData' ? () => ({ data: new Uint8ClampedArray(4) }) : () => undefined), set: () => true });
  (globalThis as any).OffscreenCanvas = class { width: number; height: number; constructor(w: number, h: number) { this.width = w; this.height = h; } getContext() { return ctx; } };
}

const { lib, ROOT } = await import('./helpers.ts');
const { buildWorldPlan, sampleWorld, traceWorld, worldAssets } = await import('../packages/narrated/src/world.ts');
const { compileNarratedTimeline } = await import('../packages/narrated/src/timeline.ts');
const { buildCharacter, buildProp } = await import('../packages/engine/src/build.ts');
const { Node } = await import('../packages/engine/src/gl/scene.ts');
const { NarratedEngineAdapter, NarratedAdapterError, SEATED_WARNING, PENETRATION_TOLERANCE_M } = await import('../apps/render-worker/narrated-world-adapter.ts');
type Diag = ReturnType<InstanceType<typeof NarratedEngineAdapter>['applySnapshot']>;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const SB = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/narrated/approved-narrated-v0.1.json'), 'utf8'));
const A = worldAssets(lib as never), M = A.marks;
const plan = buildWorldPlan(SB, A);
const shots = compileNarratedTimeline(SB, sha(JSON.stringify(SB))).shots;
const trace = traceWorld(plan, shots);
const L = lib as any;
const latest = (kind: 'characters' | 'props', id: string) => L[kind][Object.keys(L[kind]).filter((k) => k.startsWith(`${id}@`)).sort().pop()!];

function makeScene(opts: { omit?: string[] } = {}) {
  const root = new Node('scene'), rigs = new Map<string, any>(), props = new Map<string, { inst: any }>();
  for (const id of ['zapp', 'kira']) if (!opts.omit?.includes(id)) { const r = buildCharacter(latest('characters', id)); rigs.set(id, r); root.add(r.root); }
  for (const [id, m] of [['coin', 'spark_coin'], ['button', 'suspicious_button']]) if (!opts.omit?.includes(id)) { const p = buildProp(latest('props', m), id); props.set(id, { inst: p }); root.add(p.root); }
  return { root, rigs, props };
}
const d2 = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[2] - b[2]);
const d3 = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const ev = (type: string) => plan.events.filter((e) => e.type === type);
const contactT = ev('coin_patient_contact')[0].t;
const fall = plan.instances.find((x) => x.contract === 'fall_prone')!;
const growT0 = plan.coin.stand!.t0;

/** run the full frame trace through a fresh adapter; `shotEvent` may mutate the scene at shot boundaries (camera-like) */
function run(shotEvent?: (scene: ReturnType<typeof makeScene>, t: number) => void, frames = plan.frames) {
  const scene = makeScene(), ad = new NarratedEngineAdapter();
  ad.initialize(plan, scene);
  const starts = new Set(shots.map((s) => Math.round(s.start * plan.fps)));
  const out: Diag[] = [];
  let prev: any = null;
  for (let i = 0; i < frames; i++) {
    const w = sampleWorld(plan, i / plan.fps);
    if (shotEvent && starts.has(i)) shotEvent(scene, w.t);
    out.push(ad.applySnapshot(w, prev, scene));
    prev = w;
  }
  return { scene, ad, out };
}
const BASE = run();
const D = BASE.out;
const at = (t: number) => D[Math.round(t * plan.fps)];
const inWin = (t0: number, t1: number) => D.filter((d) => d.t >= t0 - 1e-9 && d.t <= t1 + 1e-9);
const summary = (() => {
  const walk = (id: string) => D.filter((d) => d.actors[id].posture === 'walking').map((d) => d.footSlipM[id]);
  return {
    zappDisp: d2(D[0].actors.zapp.appliedRoot, M.zapp_impact.pos), kiraSafe: d2(at(ev('reached_safe')[0].t + 0.05).actors.kira.appliedRoot, M.kira_safe.pos),
    slipZ: Math.max(...walk('zapp')), slipK: Math.max(...walk('kira')),
    slipMeanZ: walk('zapp').reduce((a, b) => a + b, 0) / walk('zapp').length, slipMeanK: walk('kira').reduce((a, b) => a + b, 0) / walk('kira').length,
    slipMaxAt: Object.fromEntries(['zapp', 'kira'].map((id) => { const x = D.filter((d) => d.actors[id].posture === 'walking').sort((a, b) => b.footSlipM[id] - a.footSlipM[id])[0]; return [id, x.t]; })),
    slipP95: Object.fromEntries(['zapp', 'kira'].map((id) => { const v = walk(id).sort((a, b) => a - b); return [id, v[Math.floor(v.length * 0.95)]]; })),
    minZappGap: Math.min(...D.filter((d) => d.penetration.checked).map((d) => d.penetration.zappMinGapM!)),
    baseDrift: Math.max(...D.filter((d) => d.t >= growT0 + 0.34 && d.t < ev('tip_start')[0].t - 1e-3).map((d) => d3(d.props.coin.lowestPoint!, plan.coin.base!))),
    onset: D.filter((d) => d.contacts.onsetThisFrame).map((d) => d.t), fallStart: D.filter((d) => d.contacts.fallStartedThisFrame).map((d) => d.t),
  };
})();

test('0. plan is ok and the approved fixture drives every engine entity', () => {
  assert.equal(plan.status, 'ok');
  assert.equal(D.length, 2075);
  for (const d of D) { assert.deepEqual(d.missing, []); assert.deepEqual(Object.keys(d.actors).sort(), ['kira', 'zapp']); assert.deepEqual(Object.keys(d.props).sort(), ['button', 'coin']); }
});

test('1. actor root transforms reproduce the WorldState trace (x/z, planned y, yaw, pitch, posture)', () => {
  for (const [i, d] of D.entries()) for (const id of ['zapp', 'kira']) {
    const a = d.actors[id], f = trace.frames[i].a[id];
    assert.ok(a.rootDeviationM <= 1e-6, `${id} deviates ${a.rootDeviationM} at ${d.t}`);
    assert.ok(Math.abs(a.appliedRoot[0] - f[0]) <= 1e-4 && Math.abs(a.appliedRoot[2] - f[2]) <= 1e-4);
    assert.ok(Math.abs(a.yawDeg - f[3]) <= 1e-4 && Math.abs(a.pitchDeg - f[8]) <= 1e-4);
    assert.equal(a.posture, f[4]); assert.equal(a.lookTarget, f[6]); assert.equal(a.expression, f[7]);
  }
});

test('2. prop transforms reproduce the WorldState trace (position, scale, rotation, phase, visibility)', () => {
  for (const [i, d] of D.entries()) {
    const c = d.props.coin, f = trace.frames[i].c;
    assert.equal(c.visible, f[6] === 1); assert.equal(c.phase, f[5]);
    assert.ok(d3(c.pos, f) <= 2e-4 && Math.abs(c.scale - f[3]) <= 1e-4 && Math.abs(c.rotDeg[0] - f[4]) <= 1e-4, `coin at ${d.t}`);
    assert.ok(d3(c.measuredPos, c.pos) <= 1e-4 * Math.max(1, c.scale), 'measured node position = planned');
    assert.ok(Math.abs(c.measuredScale - c.scale) <= 1e-4 * c.scale);
    const b = d.props.button, fb = trace.frames[i].b;
    assert.equal(b.capDepth, fb[1]); assert.equal(b.glow, fb[2]);
  }
});

test('3. shot boundaries (camera-like scene mutations) never change transforms, contacts or the final state', () => {
  const vandal = (scene: ReturnType<typeof makeScene>) => {
    for (const r of scene.rigs.values()) { r.root.pos = [9, 9, 9]; r.root.rot = [0, 1, 0, 0]; for (const j of Object.values(r.joints) as any[]) j.rot = [1, 0, 0, 0]; }
    for (const p of scene.props.values()) { p.inst.root.pos = [-9, 3, 9]; p.inst.root.scl = [1, 0.1, 1]; p.inst.root.visible = true; }
  };
  const shotRun = run(vandal);
  const strip = (d: Diag) => JSON.stringify({ ...d, transformResetByShot: null, maxUnplannedDeltaM: null, maxTransformDeltaM: null });
  for (let i = 0; i < D.length; i++) assert.equal(strip(shotRun.out[i]), strip(D[i]), `frame ${i}`);
  // the adapter detects that something else moved the scene on exactly the shot-boundary frames
  const starts = new Set(shots.map((s) => Math.round(s.start * plan.fps)));
  for (let i = 0; i < D.length; i++) { assert.equal(D[i].transformResetByShot, false); if (starts.has(i) && i > 0) assert.equal(shotRun.out[i].transformResetByShot, true, `frame ${i}`); }
  const onsets = (r: Diag[]) => r.filter((d) => d.contacts.onsetThisFrame).map((d) => d.t);
  assert.deepEqual(onsets(shotRun.out), onsets(D));
  // random access (a camera probing arbitrary times) cannot change what a frame looks like
  const scene = makeScene(), ad = new NarratedEngineAdapter();
  ad.initialize(plan, scene);
  for (const t of [66, 3, 55.95, 12.2, 47]) ad.applySnapshot(sampleWorld(plan, t), null, scene);
  for (const i of [0, 300, 1500, 1678, 1690, 2074]) assert.equal(JSON.stringify(ad.applySnapshot(sampleWorld(plan, i / plan.fps), i ? sampleWorld(plan, (i - 1) / plan.fps) : null, scene).actors), JSON.stringify(D[i].actors), `random access frame ${i}`);
});

test('4-5. Zapp walking translates the root with an alternating, distance-driven gait (not jump-in-place)', () => {
  const seg = plan.actors.zapp.segs.find((s) => s.kind === 'path')!, p = seg.path!;
  const W = inWin(p.tw0 + 0.02, p.tw1 - 0.02);
  assert.ok(d2(W[0].actors.zapp.appliedRoot, W[W.length - 1].actors.zapp.appliedRoot) > 2.0, 'root displacement');
  assert.ok(Math.max(...W.map((d) => d.actors.zapp.appliedRoot[1])) < 0.05, 'feet stay on the floor (no hop)');
  for (let i = 1; i < W.length; i++) assert.ok(W[i].actors.zapp.gaitDistanceM! >= W[i - 1].actors.zapp.gaitDistanceM!, 'gait phase follows travelled distance');
  const stances = W.map((d) => d.actors.zapp.stance).filter(Boolean);
  const changes = stances.filter((s, i) => i > 0 && s !== stances[i - 1]).length;
  assert.ok(changes >= 8, `feet alternate (${changes} stance changes over ${p.len.toFixed(2)} m)`);
  assert.ok(new Set(stances).size === 2);
  for (const d of W) assert.equal(d.actors.zapp.posture, 'walking');
  // foot slip diagnostics are exposed and bounded on straight stretches
  assert.ok(summary.slipZ < 0.06 && summary.slipK < 0.06, `slip zapp ${summary.slipZ} kira ${summary.slipK}`);
});

test('6. jump shows the planned vertical displacement and lands back on the planned root path', () => {
  const j = plan.actors.zapp.segs.find((s) => s.kind === 'jump')!;
  const W = inWin(j.t0, j.t1);
  const lift = W.map((d) => d.actors.zapp.appliedRoot[1] - d.actors.zapp.groundOffsetM);
  assert.ok(Math.max(...lift) >= 0.45, `peak ${Math.max(...lift)}`);
  for (const d of W) assert.ok(d2(d.actors.zapp.appliedRoot, j.p0) <= 1e-6, 'no horizontal drift');
  for (let i = 1; i < W.length; i++) assert.ok(d3(W[i].actors.zapp.appliedRoot, W[i - 1].actors.zapp.appliedRoot) <= 0.12, 'no teleport at takeoff / landing');
  assert.ok(Math.abs(at(j.t1 + 0.1).actors.zapp.appliedRoot[1] - at(j.t1 + 0.1).actors.zapp.groundOffsetM) < 1e-9);
});

test('7-8. Kira reaches kira_safe and returns to kira_desk; Zapp reaches zapp_impact', () => {
  assert.ok(summary.kiraSafe <= 0.02);
  assert.ok(d2(at(contactT).actors.kira.appliedRoot, M.kira_safe.pos) <= 0.02);
  assert.ok(d2(D[D.length - 1].actors.kira.appliedRoot, M.kira_desk.pos) <= 0.02);
  assert.ok(d2(at(ev('tip_start')[0].t).actors.zapp.appliedRoot, M.zapp_impact.pos) <= 0.02);
  assert.ok(d2(D[0].actors.zapp.appliedRoot, M.zapp_desk.pos) < 1e-6 && d2(D[0].actors.kira.appliedRoot, M.kira_desk.pos) < 1e-6);
  const press = ev('press_contact')[0];
  assert.ok(d2(at(press.t).actors.zapp.appliedRoot, A.button.pressSurface) <= 0.55);
});

test('9-11. coin: hidden before spawn, base fixed while growing, readable thickness, continuous rotation', () => {
  for (const d of D.filter((d) => d.t < ev('coin_spawn')[0].t - 1e-6)) assert.equal(d.props.coin.visible, false);
  assert.ok(d2(at(ev('coin_land')[0].t + 0.05).props.coin.lowestPoint!, M.coin_spawn.pos) <= 0.01);
  let drift = 0;
  for (const d of inWin(growT0 + 0.34, ev('tip_start')[0].t - 1e-3)) drift = Math.max(drift, d3(d.props.coin.lowestPoint!, plan.coin.base!));
  assert.ok(drift <= 0.01, `base drift ${drift}`);
  for (const d of D.filter((d) => d.props.coin.visible)) { const c = d.props.coin; assert.ok(Math.abs(c.thicknessM! / c.radiusM! - A.coin.thickness / A.coin.radius) < 1e-4, 'uniform: never a flat slab'); }
  assert.ok(Math.abs(D[D.length - 1].props.coin.thicknessM! - A.coin.thickness * 16.7) < 1e-3 && D[D.length - 1].props.coin.thicknessM! >= 0.4, 'readable thickness at rest');
  const tipW = inWin(ev('tip_start')[0].t, plan.coin.tip!.t1 + 0.1);
  for (let i = 1; i < tipW.length; i++) { const s = tipW[i].props.coin.rotDeg[0] - tipW[i - 1].props.coin.rotDeg[0]; assert.ok(s >= -1e-9 && s <= 12, `rotation step ${s}`); }
  const rest = D[D.length - 1].props.coin, tip = plan.coin.tip!;
  assert.ok(Math.abs(rest.rotDeg[0] - (810 + tip.thetaR)) < 1e-4 && rest.phase === 'resting');
});

test('12-13. exactly one coin/Zapp contact and the fall starts on that frame', () => {
  const on = D.filter((d) => d.contacts.onsetThisFrame);
  assert.equal(on.length, 1);
  assert.ok(Math.abs(on[0].t - contactT) <= 1 / plan.fps);
  const fs = D.filter((d) => d.contacts.fallStartedThisFrame);
  assert.equal(fs.length, 1); assert.equal(fs[0].t, on[0].t);
  assert.ok(Math.abs(fall.t0 - contactT) < 1e-3);
  for (const d of D.filter((d) => d.t < contactT - 1e-9)) assert.notEqual(d.actors.zapp.posture, 'falling');
  const tr = D.flatMap((d) => d.poseTransitions).filter((p) => p.actor === 'zapp' && p.to === 'fall_prone');
  assert.equal(tr.length, 1); assert.equal(tr[0].from, 'confident_arms_crossed');
  for (const d of D) assert.ok(!d.blocking.some((b) => b.code === 'FALL_NOT_AT_CONTACT'));
});

test('14-15. Zapp ends prone, stays prone to the end, and the button reset does not stand him up', () => {
  const reset = ev('button_reset')[0].t;
  for (const d of D.filter((d) => d.t >= fall.t1 + 1e-9)) { assert.equal(d.actors.zapp.posture, 'prone'); assert.equal(d.actors.zapp.pitchDeg, 90); assert.match(d.actors.zapp.poseSource, /^prone/); }
  for (const d of D.filter((d) => d.t >= reset)) assert.equal(d.actors.zapp.posture, 'prone');
  const rig = BASE.scene.rigs.get('zapp');
  assert.ok(rig.headTop.worldPos()[1] < 0.8, `head top ${rig.headTop.worldPos()[1]} m: lying down`);
});

test('16-17. no Zapp/coin penetration above tolerance, head outside the coin; Kira outside the hazard', () => {
  const pen = D.filter((d) => d.penetration.checked);
  assert.ok(pen.length > 0);
  for (const d of pen) { assert.ok(d.penetration.zappMaxDepthM <= PENETRATION_TOLERANCE_M, `depth ${d.penetration.zappMaxDepthM} at ${d.t}`); assert.equal(d.penetration.headInsideCoin, false); assert.equal(d.penetration.blocking, false); assert.ok(d.penetration.kiraMinGapM! > 0.3, `kira gap ${d.penetration.kiraMinGapM}`); }
  for (const d of D) assert.deepEqual(d.blocking, []);
  const final = D[D.length - 1];
  assert.ok(final.penetration.zappMinGapM! >= -PENETRATION_TOLERANCE_M && final.penetration.zappMinGapM! <= 0.1, `coin rests on zapp (gap ${final.penetration.zappMinGapM})`);
});

test('18. same input gives byte-identical adapter diagnostics', () => {
  const again = run(undefined);
  assert.equal(sha(JSON.stringify(again.out)), sha(JSON.stringify(D)));
});

test('19. implied_seated keeps kira_desk, requires waist-up framing and emits the authored-animation warning', () => {
  const seated = D.filter((d) => d.actors.kira.posture === 'implied_seated');
  assert.ok(seated.length > 100);
  for (const d of seated) { assert.equal(d.actors.kira.framing.waist_up_required, true); assert.ok(d2(d.actors.kira.appliedRoot, M.kira_desk.pos) <= 0.02); assert.equal(d.actors.kira.poseSource, 'implied_seated_fallback'); assert.ok(d.warnings.some((w) => w.code === SEATED_WARNING && w.entity === 'kira')); }
  for (const d of D.filter((d) => d.actors.kira.posture !== 'implied_seated')) assert.equal(d.actors.kira.framing.waist_up_required, false);
});

test('20. missing engine entities fail explicitly (or are reported as blocking when allowed)', () => {
  for (const omit of ['zapp', 'coin']) {
    const scene = makeScene({ omit: [omit] });
    assert.throws(() => new NarratedEngineAdapter().initialize(plan, scene), (e: unknown) => e instanceof NarratedAdapterError && e.code === 'MISSING_ENGINE_ENTITY' && e.message.includes(omit));
    const ad = new NarratedEngineAdapter({ allowMissing: true });
    ad.initialize(plan, scene);
    const d = ad.applySnapshot(sampleWorld(plan, 50), null, scene);
    assert.ok(d.missing.some((m) => m.endsWith(`:${omit}`)));
    assert.ok(d.blocking.some((b) => b.code === 'MISSING_ENGINE_ENTITY'));
  }
  const bad = structuredClone(SB); bad.script.phrases[10].text = 'Zapp tries to look confident in front of the coin.';
  assert.throws(() => new NarratedEngineAdapter().initialize(buildWorldPlan(bad, A), makeScene()), /WORLD_PLAN_UNAVAILABLE/);
  assert.throws(() => new NarratedEngineAdapter().applySnapshot(sampleWorld(plan, 1), null, makeScene()), /ADAPTER_NOT_INITIALIZED/);
});

test('21. pose transitions blend (no 0.12-0.15 s snaps) and all required procedural poses are exercised', () => {
  const tr = D.flatMap((d) => d.poseTransitions);
  for (const p of tr) if (p.to !== 'jump' && p.to !== 'prone') assert.ok(p.blendSec >= 0.1, `${p.actor} ${p.from}->${p.to} ${p.blendSec}`);
  const src = new Set(D.flatMap((d) => Object.values(d.actors).map((a) => a.poseSource)));
  for (const s of ['rest', 'walk', 'jump', 'fall_prone', 'prone', 'implied_seated_fallback', 'turn_toward', 'press_button', 'warning_head_shake', 'celebrate', 'confident_arms_crossed']) assert.ok(src.has(s), s);
  // per-frame pose continuity through every transition: the posed head never jumps more than 0.2 m per frame
  // (during the fall the head may move as fast as the PLANNED body pitch carries it: pitch step x 2 m lever + 0.06 m)
  let worst = 0;
  for (let i = 1; i < D.length; i++) for (const id of ['zapp', 'kira']) {
    const a = D[i].actors[id], s = d3(a.headTop, D[i - 1].actors[id].headTop);
    const allowed = a.posture === 'falling' ? (Math.abs(a.pitchDeg - D[i - 1].actors[id].pitchDeg) * Math.PI / 180) * 2 + 0.06 : 0.2;
    assert.ok(s <= allowed, `${id} head step ${s} m > ${allowed} at ${a.t ?? D[i].t} (${a.poseSource})`);
    if (a.posture !== 'falling') worst = Math.max(worst, s);
  }
  console.log(JSON.stringify({ worstHeadStep: worst, summary, contactT, fall: [fall.t0, fall.t1], finalGap: D[D.length - 1].penetration, transitions: tr.length, warnings: D[D.length - 1].warnings.map((w) => w.code) }));
});

// ---------- head / look-target smoothing (follow-up: deterministic, rate-limited head filter) ----------
const localStep = (a: { headLocal: number[][] }, b: { headLocal: number[][] }) => Math.max(...a.headLocal.map((p, k) => d3(p, b.headLocal[k])));
const angStep = (a: { headQuatLocal: number[] }, b: { headQuatLocal: number[] }) => { const q = a.headQuatLocal, r = b.headQuatLocal; return (2 * Math.acos(Math.min(1, Math.abs(q[0] * r[0] + q[1] * r[1] + q[2] * r[2] + q[3] * r[3]))) * 180) / Math.PI; };
const series = (id: string, t0: number, t1: number) => { const out: Array<{ t: number; step: number; ang: number; q: number[] }> = []; for (let i = 1; i < D.length; i++) { const t = i / plan.fps; if (t >= t0 - 1e-9 && t <= t1 + 1e-9) out.push({ t, step: localStep(D[i].actors[id], D[i - 1].actors[id]), ang: angStep(D[i].actors[id], D[i - 1].actors[id]), q: D[i].actors[id].headQuatLocal }); } return out; };
const qAngle = (q: number[], r: number[]) => (2 * Math.acos(Math.min(1, Math.abs(q[0] * r[0] + q[1] * r[1] + q[2] * r[2] + q[3] * r[3]))) * 180) / Math.PI;
const HEAD_MAX_M = 0.08;
const lookEvent = (id: string, v: string, near: number) => plan.actors[id].looks.filter((l) => l.v === v).sort((a, b) => Math.abs(a.t - near) - Math.abs(b.t - near))[0].t;

test('22. look-target change around 21.2 s: responds on the next frame, eases, never snaps, settles', () => {
  const te = lookEvent('zapp', 'button', 21.2);
  assert.ok(Math.abs(te - 21.01) < 1e-6);
  const S = series('zapp', te, te + 2.0), first = S[0];
  assert.ok(first.ang > 0.5, `responds immediately (${first.ang} deg on the first frame)`);
  for (const s of S) assert.ok(s.step <= HEAD_MAX_M && s.ang <= 6, `${s.t}: ${s.step} m, ${s.ang} deg`);
  const final = S[S.length - 1].q, total = qAngle(D[Math.round((te - 1 / plan.fps) * plan.fps)].actors.zapp.headQuatLocal, final);
  assert.ok(total > 60, `a large gaze change (${total} deg)`);
  const settled = S.find((s) => qAngle(s.q, final) <= 2)!;
  assert.ok(settled && settled.t - te <= 1.5, `settles within 1.5 s (${settled?.t - te})`);
  const half = S.find((s) => qAngle(s.q, final) <= total / 2)!;
  assert.ok(half.t - te <= 0.7, `half-way by ${half.t - te} s`);
});

test('23. shock reaction around 40.4 s: starts on the event frame, lands within ~0.3 s, no head snap', () => {
  const te = lookEvent('zapp', 'coin', 40.4);
  assert.ok(Math.abs(te - 40.29) < 1e-6);
  const S = series('zapp', te, te + 1.2);
  assert.ok(S[0].ang > 0.5, `responds immediately (${S[0].ang} deg)`);
  for (const s of S) assert.ok(s.step <= HEAD_MAX_M, `${s.t}: ${s.step} m`);
  const before = D[Math.floor(te * plan.fps)].actors.zapp.headQuatLocal, final = S[S.length - 1].q, total = qAngle(before, final);
  const reached = (f: number) => S.find((s) => qAngle(before, s.q) >= f * total)!.t - te;
  assert.ok(reached(0.3) <= 0.3, `30 % of the reaction by ${reached(0.3)} s`);
  assert.ok(reached(0.9) <= 1.0, `90 % by ${reached(0.9)} s`);
  // the recoil body pose is not delayed by the head filter: the spine reacts on the event frames
  assert.equal(D[Math.round((te + 0.1) * plan.fps)].actors.zapp.poseSource, 'shock_recoil');
});

test('24. local head displacement (root frame) <= 0.08 m per frame everywhere; walking root travel is not counted', () => {
  const all: number[] = [], ang: number[] = [];
  for (let i = 1; i < D.length; i++) for (const id of ['zapp', 'kira']) { all.push(localStep(D[i].actors[id], D[i - 1].actors[id])); ang.push(angStep(D[i].actors[id], D[i - 1].actors[id])); }
  const sorted = [...all].sort((a, b) => a - b), max = sorted[sorted.length - 1], p95 = sorted[Math.floor(sorted.length * 0.95)];
  assert.ok(max <= HEAD_MAX_M, `max ${max} m`);
  assert.ok(p95 <= 0.04, `p95 ${p95} m`);
  assert.ok(Math.max(...ang) <= 12, `max angular change ${Math.max(...ang)} deg/frame`);
  // walking: the root travels ~3.7 cm per frame while the head barely moves in the root frame
  const w = D.filter((d, i) => i > 0 && d.actors.kira.posture === 'walking' && D[i - 1].actors.kira.posture === 'walking');
  const wi = w.map((d) => D.indexOf(d));
  assert.ok(Math.max(...wi.map((i) => d2(D[i].actors.kira.appliedRoot, D[i - 1].actors.kira.appliedRoot))) > 0.03);
  assert.ok(Math.max(...wi.map((i) => localStep(D[i].actors.kira, D[i - 1].actors.kira))) < 0.05);
  console.log(JSON.stringify({ headLocalMaxM: max, headLocalP95M: p95, maxAngDegPerFrame: Math.max(...ang) }));
});

test('25. direct-time sampling equals sequential playback (no mutable history)', () => {
  const frames = [630, 636, 1209, 1212, 1215, 1678, 1679, 1685, 1690, 1695, 2074, 0, 44, 780, 1500];
  for (const order of [frames, [...frames].reverse()]) {
    const scene = makeScene(), ad = new NarratedEngineAdapter();
    ad.initialize(plan, scene);
    for (const i of order) {
      const d = ad.applySnapshot(sampleWorld(plan, i / plan.fps), null, scene);
      assert.equal(JSON.stringify(d.actors), JSON.stringify(D[i].actors), `frame ${i}`);
      assert.equal(JSON.stringify(d.props), JSON.stringify(D[i].props), `frame ${i}`);
    }
  }
  // reset() + replay gives the same result as a fresh adapter
  BASE.ad.reset(); BASE.ad.initialize(plan, BASE.scene);
  assert.equal(JSON.stringify(BASE.ad.applySnapshot(sampleWorld(plan, 1212 / plan.fps), null, BASE.scene).actors), JSON.stringify(D[1212].actors));
});

test('26. contact and fall timing are unchanged by the head filter', () => {
  assert.deepEqual(D.filter((d) => d.contacts.onsetThisFrame).map((d) => d.t), [1678 / plan.fps]);
  assert.deepEqual(D.filter((d) => d.contacts.fallStartedThisFrame).map((d) => d.t), [1678 / plan.fps]);
  assert.equal(D[1677].actors.zapp.posture, 'standing'); assert.equal(D[1678].actors.zapp.posture, 'falling');
  assert.ok(Math.abs(contactT - 55.918) < 1e-9 && Math.abs(fall.t0 - 55.918) < 1e-3 && Math.abs(fall.t1 - 56.518) < 1e-3);
  for (const d of D.filter((d) => d.t >= fall.t1 + 1e-9)) assert.equal(d.actors.zapp.posture, 'prone');
  for (const d of D) assert.deepEqual(d.blocking, []);
});

test('27. root and prop transforms are unchanged (golden hashes from the PR #7 baseline, commit ecb9d59)', () => {
  const h = (x: unknown) => sha(JSON.stringify(x)).slice(0, 16);
  const planned = D.map((d) => Object.fromEntries(Object.entries(d.actors).map(([k, a]) => [k, [a.plannedRoot, a.yawDeg, a.pitchDeg, a.posture, a.rootDeviationM]])));
  assert.equal(h(planned), '247c20d71b23fa27', 'planned roots, yaw, pitch, posture and root deviation');
  assert.equal(h(D.map((d) => d.props)), 'e0b908e63bc2a159', 'every prop transform');
  for (const d of D) for (const a of Object.values(d.actors)) assert.ok(a.rootDeviationM <= 1e-6);
});
