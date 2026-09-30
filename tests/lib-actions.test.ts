// S5 action library: acting curves, pose curves of every library action, door curves, prop attachment and flight,
// talking (phrase timing + VO envelope), face track (expression per beat + blinking), and LibraryTrack integration.
// Node only: rigs are posed with forward kinematics; a no-op canvas stub satisfies face-texture construction.
import { test } from 'node:test';
import assert from 'node:assert/strict';

if (typeof (globalThis as any).OffscreenCanvas === 'undefined') {
  const ctx: any = new Proxy({}, { get: (_t, k) => (k === 'measureText' ? () => ({ width: 1 }) : k === 'createLinearGradient' || k === 'createRadialGradient' ? () => ({ addColorStop() {} }) : k === 'getImageData' ? () => ({ data: new Uint8ClampedArray(4) }) : () => undefined), set: () => true });
  (globalThis as any).OffscreenCanvas = class { width: number; height: number; constructor(w: number, h: number) { this.width = w; this.height = h; } getContext() { return ctx; } };
}

const { lib } = await import('./helpers.ts');
const { ACTING, acting, hop, landingSquash, overshootOut, settle, squashStretch, seedPhase } = await import('../packages/engine/src/animation/comedy.ts');
const { LIB_ACTIONS, NEW_ACTION_IDS, UNRESERVED_ACTION_IDS, libActionDef } = await import('../packages/engine/src/animation/lib/registry.ts');
const { openDoorCurve, slamDoorCurve, SLAM_IMPACT, OPEN_CONTACT } = await import('../packages/engine/src/animation/lib/door-actions.ts');
const { ANCHOR_ROLES, resolveAnchor } = await import('../packages/engine/src/animation/lib/anchors.ts');
const { attachToHand, flightAt, throwVelocity } = await import('../packages/engine/src/animation/lib/attach.ts');
const { PhraseMouth, EnvelopeMouth, layoutSyllables, wordSyllables, envelopeFromPcm, MOUTH_SHAPES } = await import('../packages/engine/src/animation/talking.ts');
const { FaceTrack, placeholderFaceState, resolveExpression, applyFace, setFaceRenderer, BLINK_SEC } = await import('../packages/engine/src/animation/face-track.ts');
const { ACTION_DEFS } = await import('../packages/engine/src/animation/actions.ts');
const { LibraryTrack } = await import('../packages/engine/src/animation/lib/track.ts');
const { buildCharacter, buildProp, JOINTS } = await import('../packages/engine/src/build.ts');
const { LIBRARY } = await import('../packages/library/src/ids.ts');
const { qRotate } = await import('../packages/engine/src/math.ts');

const L = lib as any;
const zapp = () => buildCharacter(L.characters['zapp@1.0.0']);
const BODY = { legLen: 0.8, torsoH: 0.6, headH: 0.52, headD: 0.5, upperArm: 0.32, lowerArm: 0.3, shoulderX: 0.35, shoulderY: 0.515 };
const ctxAt = (def: any, lt: number, extra: Record<string, unknown> = {}) => {
  const d = def.defaultDuration;
  return { lt, d, u: lt / d, t: 3 + lt, seed: 1234, target: [0.3, 0.9, 0.6] as [number, number, number], params: {}, root: { pos: [0, 0, 0] as [number, number, number], yaw: 0 }, body: BODY, loco: { dist: 0, speed: 0, run: false, legLen: 0.8, total: 0 }, ...extra };
};

// ---------------------------------------------------------------- acting curves

test('acting curve: 0 -> anticipation dip -> overshoot peak -> settles on exactly 1, continuous', () => {
  for (const shape of Object.values(ACTING)) {
    assert.equal(acting(0, shape), 0);
    assert.ok(Math.abs(acting(1, shape) - 1) < 1e-12);
    assert.ok(Math.abs(acting(shape.antAt, shape) + shape.anticipation) < 1e-9, 'wind-up reaches -anticipation at antAt');
    assert.ok(Math.abs(acting(shape.strikeAt, shape) - (1 + shape.overshoot)) < 1e-9, 'strike peaks at 1 + overshoot');
    let min = Infinity, max = -Infinity, step = 0, prev = 0;
    for (let i = 0; i <= 2000; i++) { const v = acting(i / 2000, shape); min = Math.min(min, v); max = Math.max(max, v); if (i) step = Math.max(step, Math.abs(v - prev)); prev = v; }
    assert.ok(min < 0 && max > 1, 'has anticipation and overshoot');
    assert.ok(step < 0.01, `continuous (max step ${step})`);
  }
  assert.equal(acting(-1), 0); assert.ok(Math.abs(acting(2) - 1) < 1e-12);
});

test('overshootOut / settle / squashStretch / landingSquash shapes', () => {
  assert.ok(Math.abs(overshootOut(0)) < 1e-12 && Math.abs(overshootOut(1) - 1) < 1e-12);
  assert.ok(Math.max(...Array.from({ length: 101 }, (_, i) => overshootOut(i / 100, 0.15))) > 1.02, 'overshoots');
  assert.ok(Math.abs(overshootOut(0.5, 0) - (1 - 0.5 ** 3)) < 1e-12, 'amount 0 = ease-out cubic');
  assert.equal(settle(1, 0.3), 0); assert.equal(settle(0, 0.3), 0.3);
  for (const s of [0.5, 0.8, 1, 1.2, 2]) { const v = squashStretch(s); assert.ok(Math.abs(v[0] * v[1] * v[2] - 1) < 1e-9, 'volume preserved'); assert.equal(v[1], s); }
  assert.equal(landingSquash(0), 1); assert.equal(landingSquash(1), 1);
  assert.ok(Math.abs(landingSquash(0.22, 0.2) - 0.8) < 1e-9, 'squash bottom at 22 %');
  assert.ok(landingSquash(0.55, 0.2) > 1, 'rebound stretch');
});

test('hop: grounded crouch (squash), parabolic flight (stretch), squashed landing; continuous', () => {
  const o = { takeoff: 0.25, land: 0.75, height: 0.4, squash: 0.2, stretch: 0.1 };
  assert.equal(hop(0.1, o).lift, 0); assert.equal(hop(0.9, o).lift, 0);
  assert.ok(Math.abs(hop(0.5, o).lift - 0.4) < 1e-9, 'apex height at mid-flight');
  assert.ok(hop(0.24, o).scale[1] < 0.9, 'anticipation squash');
  assert.ok(hop(0.35, o).scale[1] > 1.04, 'takeoff stretch');
  assert.ok(Math.min(...Array.from({ length: 50 }, (_, i) => hop(0.75 + (0.25 * i) / 50, o).scale[1])) < 0.9, 'landing squash');
  let prev = hop(0, o), worst = 0;
  for (let i = 1; i <= 4000; i++) {
    const h = hop(i / 4000, o);
    worst = Math.max(worst, Math.abs(h.lift - prev.lift), Math.abs(h.scale[1] - prev.scale[1]), Math.abs(h.crouch - prev.crouch));
    prev = h;
  }
  assert.ok(worst < 0.01, `hop is continuous (max step ${worst})`);
});

test('seedPhase is deterministic and spreads over [0, 1)', () => {
  assert.equal(seedPhase(42, 3), seedPhase(42, 3));
  const xs = Array.from({ length: 200 }, (_, k) => seedPhase(7, k));
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  assert.ok(Math.min(...xs) < 0.1 && Math.max(...xs) > 0.9);
});

// ---------------------------------------------------------------- registry

test('registry: every planned + available library action is implemented; only the door transits are unreserved', () => {
  const lib = LIBRARY.actions.map((e) => e.id);
  for (const id of lib) assert.ok(LIB_ACTIONS[id], `${id} missing from LIB_ACTIONS`);
  const extra = Object.keys(LIB_ACTIONS).filter((id) => !lib.includes(id)).sort();
  assert.deepEqual(extra, [...UNRESERVED_ACTION_IDS].sort());
  const planned = LIBRARY.actions.filter((e) => e.status === 'planned').map((e) => e.id);
  assert.equal(planned.length, 21);
  for (const id of planned) assert.ok(NEW_ACTION_IDS.includes(id), `${id} is new`);
  for (const [id, d] of Object.entries(LIB_ACTIONS)) {
    assert.equal(d.id, id); assert.equal(d.kind, 'action'); assert.match(d.version, /^\d+\.\d+\.\d+$/);
    assert.ok(d.defaultDuration > 0 && d.blendIn >= 0, id);
    if (d.contactU !== undefined) assert.ok(d.contactU >= 0 && d.contactU <= 1, id);
    if (d.travelWindow) assert.ok(d.locomotion && d.travelWindow[0] < d.travelWindow[1], id);
    if (d.targetRole) assert.ok(ANCHOR_ROLES[d.targetRole], id);
  }
});

test('registry: engine actions keep their engine poses (only the listed upgrades differ); ACTION_DEFS itself is untouched', () => {
  const upgraded = new Set(['jump', 'victory_pose']);
  for (const id of Object.keys(ACTION_DEFS)) {
    const d = LIB_ACTIONS[id], e = (ACTION_DEFS as any)[id];
    assert.equal(d.holds, e.holds, id); assert.equal(d.blendIn, e.blendIn, id);
    if (id === 'throw' || id === 'drink') assert.notEqual(d.pose, e.pose, `${id}: anchor-aware library version`);
    else if (upgraded.has(id)) assert.equal(d.pose(ctxAt(d, 0.3)).joints.knee_l![0], e.pose(ctxAt(d, 0.3)).joints.knee_l![0], `${id}: same joints, adds scale`);
    else assert.equal(d.pose, e.pose, id);
  }
  for (const id of NEW_ACTION_IDS) assert.equal(libActionDef(id), LIB_ACTIONS[id]);
  assert.equal(libActionDef('no_such_action'), undefined);
  assert.equal((ACTION_DEFS as any).sit, undefined, 'the engine enum is unchanged');
});

// ---------------------------------------------------------------- pose curves of every library action

const NEW_AND_UPGRADED = [...NEW_ACTION_IDS, 'throw', 'drink', 'jump', 'victory_pose', 'pick_up', 'hold', 'put_down'];

test('pose curves: finite, known joints, IK weights and scale in range, deterministic in any sampling order', () => {
  for (const id of NEW_AND_UPGRADED) {
    const def = LIB_ACTIONS[id], d = def.defaultDuration;
    const ts = Array.from({ length: 121 }, (_, i) => (i / 120) * d);
    const fwd = ts.map((lt) => JSON.stringify(def.pose(ctxAt(def, lt))));
    const rev = [...ts].reverse().map((lt) => JSON.stringify(def.pose(ctxAt(def, lt)))).reverse();
    assert.deepEqual(fwd, rev, `${id}: order-independent`);
    for (const lt of ts) {
      const p = def.pose(ctxAt(def, lt));
      for (const [j, e] of Object.entries(p.joints)) { assert.ok((JOINTS as readonly string[]).includes(j), `${id}: unknown joint ${j}`); assert.ok(e!.every(Number.isFinite), `${id}: ${j} not finite at ${lt}`); }
      for (const r of p.ik ?? []) { assert.ok(r.weight >= -1e-9 && r.weight <= 1 + 1e-9, `${id}: ik weight ${r.weight}`); assert.ok(r.target.every(Number.isFinite)); }
      if (p.scale) { assert.ok(p.scale.every((s) => s > 0.15 && s < 2), `${id}: scale ${p.scale}`); }
      assert.ok(p.lift === undefined || (p.lift >= -1e-9 && p.lift < 1), `${id}: lift ${p.lift}`);
      const pc = def.props?.(ctxAt(def, lt)); if (pc) assert.ok(pc.attach >= 0 && pc.attach <= 1 && ANCHOR_ROLES[pc.grip], `${id}: prop cue`);
      const fc = def.face?.(ctxAt(def, lt)); if (fc?.mouth) { assert.ok(fc.mouth.open >= 0 && fc.mouth.open <= 1, `${id}: mouth open`); assert.ok((MOUTH_SHAPES as readonly string[]).includes(fc.mouth.shape)); }
      const dr = def.door?.(ctxAt(def, lt)); if (dr !== undefined) assert.ok(dr >= 0 && dr < 1.25, `${id}: door ${dr}`);
    }
  }
});

test('pose curves: continuous at 60 fps (comic snaps allowed, no pops) for every new / upgraded action', () => {
  // limits per 60 fps frame: 45 deg for joints (the fastest strikes are 2-3 frame smears), 0.13 for scale, 6 cm for lift
  // (a 0.4 m hop leaves the floor at ~3 m/s = 5 cm per frame: ballistic, not a pop)
  for (const id of NEW_AND_UPGRADED) {
    const def = LIB_ACTIONS[id], d = def.defaultDuration, N = Math.round(d * 60);
    let prev = def.pose(ctxAt(def, 0));
    for (let i = 1; i <= N; i++) {
      const lt = (i / N) * d, p = def.pose(ctxAt(def, lt));
      for (const [j, e] of Object.entries(p.joints)) {
        const q = (prev.joints as any)[j]; if (!q) continue;
        const m = Math.max(...e!.map((x, k) => Math.abs(x - q[k])));
        assert.ok(m <= 45, `${id}.${j}: ${m.toFixed(1)} deg in one frame at ${lt.toFixed(3)} s`);
      }
      if (p.scale && prev.scale) assert.ok(Math.abs(p.scale[1] - prev.scale[1]) <= 0.13, `${id}: scale pop at ${lt.toFixed(3)}`);
      if (id !== 'jump') assert.ok(Math.abs((p.lift ?? 0) - (prev.lift ?? 0)) <= 0.06, `${id}: lift pop at ${lt.toFixed(3)}`);
      prev = p;
    }
  }
});

test('pose curves: holding actions end on a stable pose (the pose they hold equals the pose at the end)', () => {
  for (const id of NEW_ACTION_IDS.filter((x) => LIB_ACTIONS[x].holds)) {
    const def = LIB_ACTIONS[id], d = def.defaultDuration;
    const a = def.pose(ctxAt(def, d)), b = def.pose(ctxAt(def, d - 1 / 60));
    for (const [j, e] of Object.entries(a.joints)) { const q = (b.joints as any)[j] ?? [0, 0, 0]; assert.ok(Math.max(...e!.map((x, k) => Math.abs(x - q[k]))) < 6, `${id}.${j} settles`); }
  }
});

test('acting: anticipation before the strike, overshoot after it (grab, push, slam_door, throw)', () => {
  const at = (id: string, u: number) => LIB_ACTIONS[id].pose(ctxAt(LIB_ACTIONS[id], u * LIB_ACTIONS[id].defaultDuration));
  // grab: the hand cocks back before the snatch, the reach is fully on the target at contact, the lean overshoots
  assert.ok((at('grab', 0.14).joints.shoulder_r![0]) > (at('grab', 0).joints.shoulder_r![0]), 'grab winds the hand back');
  assert.ok(Math.abs(at('grab', LIB_ACTIONS.grab.contactU!).ik![0].weight - 1) < 1e-9, 'grab reaches the target at contact');
  // push: leans back, then forward past the shove pose
  assert.ok(at('push', 0.2).joints.spine![0] < 0 && Math.max(...[0.35, 0.4, 0.45, 0.5].map((u) => at('push', u).joints.spine![0])) > 24);
  // throw: arm far back over the head in the wind-up, the prop is released exactly at contactU
  assert.ok(at('throw', 0.38).joints.shoulder_r![0] < -150);
  const th = LIB_ACTIONS.throw, rel = th.contactU!;
  assert.equal(th.props!(ctxAt(th, (rel - 0.01) * th.defaultDuration))!.attach, 1);
  assert.equal(th.props!(ctxAt(th, (rel + 0.01) * th.defaultDuration))!.attach, 0);
  // slam: body squashes on the impact
  assert.ok(Math.min(...[0.5, 0.52, 0.54, 0.56].map((u) => at('slam_door', u).scale![1])) < 0.95);
});

test('specific poses: sit ends seated, celebrate leaves the floor and squashes on landing, flattened is a pancake', () => {
  const sit = LIB_ACTIONS.sit, s = sit.pose(ctxAt(sit, sit.defaultDuration));
  assert.ok(Math.abs(s.joints.hip_l![0] + 90) < 3 && Math.abs(s.joints.knee_l![0] - 90) < 3);
  const cel = LIB_ACTIONS.celebrate, ps = Array.from({ length: 200 }, (_, i) => cel.pose(ctxAt(cel, (i / 199) * cel.defaultDuration)));
  const peak = Math.max(...ps.map((p) => p.lift ?? 0));
  assert.ok(peak > 0.3 && peak < 0.45, `celebrate apex ${peak}`);
  const landI = ps.findIndex((p, i) => i > 50 && (p.lift ?? 0) === 0);
  assert.ok(Math.min(...ps.slice(landI, landI + 40).map((p) => p.scale![1])) < 0.9, 'landing squash');
  const fl = LIB_ACTIONS.flattened, f = fl.pose(ctxAt(fl, 1));
  assert.ok(f.scale![2] < 0.4 && f.scale![0] > 1.2 && f.pitch === -90 && f.ground === 'all');
  const sl = LIB_ACTIONS.sleep;
  assert.ok(sl.face!(ctxAt(sl, 1.5))!.eyesClosed! > 0.5, 'eyes shut while asleep');
  assert.equal(sl.pose(ctxAt(sl, 2, { params: { lying: true } })).pitch, -90);
});

test('door curves: open overshoots and settles open; slam accelerates shut and rattles without passing the frame', () => {
  assert.equal(openDoorCurve(0), 0); assert.equal(openDoorCurve(OPEN_CONTACT), 0);
  assert.ok(Math.abs(openDoorCurve(1) - 1) < 1e-9);
  const op = Array.from({ length: 501 }, (_, i) => openDoorCurve(i / 500));
  assert.ok(Math.max(...op) > 1.03 && Math.max(...op) < 1.2, 'comic overshoot past open');
  assert.equal(slamDoorCurve(0), 1); assert.ok(Math.abs(slamDoorCurve(SLAM_IMPACT)) < 1e-9); assert.ok(Math.abs(slamDoorCurve(1)) < 1e-9);
  const sl = Array.from({ length: 501 }, (_, i) => slamDoorCurve(i / 500));
  assert.ok(sl.every((x) => x >= 0), 'never swings past the frame');
  assert.ok(Math.max(...sl.filter((_, i) => i / 500 > SLAM_IMPACT + 0.02)) > 0.02, 'rattles after the impact');
  // the hand is on the handle when the door moves
  const od = LIB_ACTIONS.open_door, sd = LIB_ACTIONS.slam_door;
  assert.ok(od.pose(ctxAt(od, (OPEN_CONTACT + 0.05) * od.defaultDuration)).ik![0].weight > 0.99);
  assert.ok(sd.pose(ctxAt(sd, SLAM_IMPACT * sd.defaultDuration)).ik![0].weight > 0.99);
});

// ---------------------------------------------------------------- anchors, attachment, flight

test('anchors: roles resolve on the existing props; unknown roles yield undefined', () => {
  const coin = L.props['spark_coin@1.0.0'], desk = L.props['student_desk@1.0.0'], button = L.props['suspicious_button@1.0.0'];
  assert.equal(resolveAnchor(coin, 'grip'), 'rim');
  assert.equal(resolveAnchor(desk, 'keyboard'), 'top_center');
  assert.equal(resolveAnchor(button, 'contact'), 'front_face');
  assert.equal(resolveAnchor(coin, 'door_hinge'), undefined);
  assert.equal(resolveAnchor({ anchors: {}, effectAnchors: {}, grips: { handle: [0, 1, 0] } } as any, 'door_handle'), 'handle');
});

test('attachToHand puts the grip anchor exactly on the hand', () => {
  const rig = zapp();
  rig.joints.shoulder_r.rot = [Math.sin(-0.6), 0, 0, Math.cos(-0.6)] as any;
  rig.root.pos = [0.4, 0, -0.3]; rig.root.updateWorld();
  const coin = buildProp(L.props['spark_coin@1.0.0'], 'coin');
  const a = L.props['spark_coin@1.0.0'].grips.rim as [number, number, number];
  for (const s of [1, 2.5]) {
    const p = attachToHand(rig, 'r', a, s);
    const w = qRotate(p.rot, [a[0] * s, a[1] * s, a[2] * s]);
    const h = rig.hand_r.worldPos();
    assert.ok(Math.hypot(p.pos[0] + w[0] - h[0], p.pos[1] + w[1] - h[1], p.pos[2] + w[2] - h[2]) < 1e-6);
  }
  assert.ok(coin.anchors.rim);
});

test('throw flight: hits the aimed point at the flight time, bounces lower each time, comes to rest; deterministic', () => {
  const from: [number, number, number] = [0, 1.3, 0], to: [number, number, number] = [2, 0.3, 1];
  const v = throwVelocity(from, to, 0.6);
  const at = flightAt(from, v, 0.6, { floorY: 0 });
  assert.ok(Math.hypot(at.pos[0] - 2, at.pos[1] - 0.3, at.pos[2] - 1) < 1e-9 && at.airborne);
  const end = flightAt(from, v, 6, { floorY: 0 });
  assert.ok(end.impacts.length >= 2 && !end.airborne && end.resting && end.pos[1] === 0);
  const heights = [0.9, 1.1, 1.3, 1.5, 1.7, 1.9].map((t) => flightAt(from, v, t, { floorY: 0 }).pos[1]);
  assert.ok(heights.every((y) => y >= -1e-9), 'never below the floor');
  assert.deepEqual(flightAt(from, v, 1.234), flightAt(from, v, 1.234));
});

// ---------------------------------------------------------------- talking

test('talking: syllables from text fill the span in order; vowels pick the shape', () => {
  assert.deepEqual(wordSyllables('coins'), ['round']);
  assert.equal(wordSyllables('button').length, 2);
  assert.equal(wordSyllables('free').length, 1);
  assert.equal(wordSyllables('make').length, 1);
  const span = { speaker: 'zapp', start: 1, end: 3, text: 'Zapp sees a button, and presses it!' };
  const syl = layoutSyllables(span);
  assert.ok(syl.length >= 8);
  assert.ok(syl[0].start === 1 && Math.abs(syl[syl.length - 1].end - 3) < 1e-9);
  for (let i = 1; i < syl.length; i++) assert.ok(syl[i].start >= syl[i - 1].end - 1e-9, 'ordered, non-overlapping');
  // fast text never flaps faster than MIN_SYLLABLE_SEC
  const fast = layoutSyllables({ speaker: 'z', start: 0, end: 0.5, text: 'unbelievably incomprehensible abracadabra' });
  assert.ok(fast.every((s) => s.end - s.start >= 0.08));
});

test('talking: phrase mouth is closed outside speech and for other speakers, flaps inside, deterministic', () => {
  const spans = [{ speaker: 'zapp', start: 1, end: 2.5, text: 'Oh no, not the button again' }, { speaker: 'kira', start: 3, end: 4, text: 'Told you so' }];
  const zm = new PhraseMouth(spans, 'zapp');
  assert.deepEqual(zm.at(0.5), { shape: 'closed', open: 0 });
  assert.deepEqual(zm.at(3.5), { shape: 'closed', open: 0 }, 'kira speaking: zapp mouth shut');
  const opens = Array.from({ length: 150 }, (_, i) => zm.at(1 + i / 100));
  assert.ok(Math.max(...opens.map((m) => m.open)) > 0.7, 'opens wide on stressed syllables');
  assert.ok(opens.filter((m) => m.shape === 'closed').length > 5, 'closes between syllables');
  assert.ok(opens.some((m) => m.shape === 'round'), '"oh no" rounds the lips');
  assert.deepEqual(new PhraseMouth(spans, 'zapp').at(1.37), zm.at(1.37));
});

test('talking: envelope mouth follows loudness, ignores audio outside the speaker spans, pure function of t', () => {
  const rate = 16000, pcm = new Float32Array(rate * 3);
  for (let i = 0; i < pcm.length; i++) { const t = i / rate; const on = (t > 0.5 && t < 0.8) || (t > 1.2 && t < 1.5) || (t > 2.2 && t < 2.6); pcm[i] = on ? 0.5 * Math.sin(2 * Math.PI * 220 * t) : 0; }
  const env = envelopeFromPcm(pcm, rate, 100);
  const m = new EnvelopeMouth(env, [{ speaker: 'zapp', start: 0.4, end: 1.6, text: 'go go' }], 'zapp');
  assert.ok(m.at(0.65).open > 0.8, 'open while loud');
  assert.ok(m.at(1.0).open < 0.05, 'closed in the gap');
  assert.equal(m.at(2.4).open, 0, 'loud audio outside the span (another voice) does not move this mouth');
  assert.equal(m.at(0.65).shape, 'round', 'vowel from the phrase text');
  const seq = [0.3, 0.6, 1.3, 0.9].map((t) => m.at(t)), rnd = [0.9, 1.3, 0.6, 0.3].map((t) => m.at(t)).reverse();
  assert.deepEqual(seq, rnd);
});

// ---------------------------------------------------------------- face track

test('face track: expression per beat (resolved per character), forced blink hides each change, deterministic blinks', () => {
  const allowed = L.characters['zapp@1.0.0'].allowedExpressions;
  const beats = [{ start: 0, end: 2, expressionId: 'neutral' }, { start: 2, end: 4, expressionId: 'shocked' }, { start: 4, end: 6, expressionId: 'happy' }];
  const ft = new FaceTrack({ seed: 99, allowed, beats, duration: 6 });
  assert.equal(ft.expressionAt(1), 'neutral');
  assert.equal(ft.expressionAt(3), 'shock', 'library "shocked" -> zapp face state "shock"');
  assert.equal(resolveExpression('happy', allowed), 'neutral');
  assert.ok(Math.abs(ft.blinkAt(2) - 1) < 1e-9, 'eyes fully shut at the change');
  assert.ok(ft.blinkTimes().length >= 3);
  for (let t = 0; t < 6; t += 0.01) { const b = ft.blinkAt(t); assert.ok(b >= 0 && b <= 1); }
  const again = new FaceTrack({ seed: 99, allowed, beats, duration: 6 });
  assert.deepEqual(again.blinkTimes(), ft.blinkTimes());
  // blinks keep happening through a long beat
  const long = new FaceTrack({ seed: 5, allowed, beats: [{ start: 0, end: 20, expressionId: 'neutral' }], duration: 20 });
  assert.ok(long.blinkTimes().filter((t) => t < 20).length >= 4);
  for (let i = 1; i < long.blinkTimes().length; i++) assert.ok(long.blinkTimes()[i] - long.blinkTimes()[i - 1] >= BLINK_SEC);
});

test('face track: action cues override mouth / eyes; the talking mouth drives the placeholder mouth state', () => {
  const m = L.characters['zapp@1.0.0'], allowed = m.allowedExpressions;
  const mouth = new PhraseMouth([{ speaker: 'zapp', start: 0, end: 2, text: 'aaah' }], 'zapp');
  const ft = new FaceTrack({ seed: 1, allowed, beats: [{ start: 0, end: 2, expressionId: 'neutral' }], duration: 2, mouth });
  const t = mouth.syllables()[0].start + 0.35 * (mouth.syllables()[0].end - mouth.syllables()[0].start);
  const f = ft.at(t);
  assert.ok(f.mouth.open > 0.7);
  assert.equal(placeholderFaceState(m.face.states, allowed, f.expression, f.mouth), 'shock', 'open mouth -> a face state with an open mouth');
  assert.equal(placeholderFaceState(m.face.states, allowed, 'neutral', { shape: 'closed', open: 0 }), 'neutral');
  assert.equal(ft.at(t, { eyesClosed: 1, mouth: { shape: 'closed', open: 0 } }).blink, 1);
  // S3 hook replaces the placeholder
  const rig = zapp();
  let got: any = null;
  setFaceRenderer((_r, fr) => { got = fr; });
  try { applyFace(rig, f); } finally { setFaceRenderer(null); }
  assert.deepEqual(got, f);
  assert.equal(applyFace(rig, f), 'shock');
});

// ---------------------------------------------------------------- LibraryTrack integration

function track(action: string, to?: string, extra: Record<string, unknown> = {}) {
  const rig = zapp();
  const marks: Record<string, [number, number, number]> = { start: [0, 0, 0], mark: [0, 0, 2.4], door: [0, 0, 3] };
  const res = { point: (id: string) => marks[id] ?? [0.3, 0.9, 0.6], markFacing: () => 0 };
  const d = LIB_ACTIONS[action].defaultDuration;
  const tr = new LibraryTrack('zapp', rig, [{ actor: 'zapp', action, start: 0.5, duration: d, ...(to ? { to } : {}), ...extra }], [0, 0, 0], 0, res as any, 7);
  return { rig, tr, d };
}

test('LibraryTrack plays library actions: sneak / enter_door / exit_door arrive on their marks, peek stays in place', () => {
  for (const [a, to, z] of [['sneak', 'mark', 2.4], ['enter_door', 'mark', 2.4], ['exit_door', 'door', 3]] as const) {
    const { rig, tr, d } = track(a, to);
    tr.apply(0.5 + d + 0.5);
    const p = rig.root.worldPos();
    assert.ok(Math.abs(p[0]) < 1e-6 && Math.abs(p[2] - z) < 1e-6, `${a} arrives`);
  }
  const { tr, d } = track('enter_door', 'mark');
  assert.equal(tr.rootAt(0.5 + d * 0.2).pos[2], 0, 'no travel during the doorway peek');
  assert.ok(tr.rootAt(0.5 + d * 0.6).pos[2] > 0.5);
  const ex = track('exit_door', 'door');
  assert.ok(Math.abs(ex.tr.rootAt(0.5 + ex.d * 0.85).pos[2] - 3) < 1e-9, 'stopped at the threshold for the glance back');
});

test('LibraryTrack: planted feet do not slide during sneak / door transits (< 1 cm per frame)', () => {
  for (const [a, to] of [['sneak', 'mark'], ['enter_door', 'mark'], ['exit_door', 'door']] as const) {
    const { rig, tr, d } = track(a, to);
    let prev: any = null, prevStance: any, worst = 0;
    for (let i = 0; i <= Math.round((d + 1) * 60); i++) {
      const dg = tr.apply(i / 60);
      const s = (dg.stance === 'l' ? rig.sole_l : rig.sole_r).worldPos();
      if (dg.stance && dg.stance === prevStance && prev) worst = Math.max(worst, Math.hypot(s[0] - prev[0], s[2] - prev[2]));
      prev = s; prevStance = dg.stance;
    }
    assert.ok(worst < 0.01, `${a}: slip ${(worst * 100).toFixed(2)} cm/frame`);
  }
});

test('LibraryTrack: squash & stretch reaches the root scale, is reset afterwards, and the body stays grounded', () => {
  const { rig, tr, d } = track('celebrate');
  let minY = Infinity, maxY = 0;
  for (let i = 0; i <= Math.round(d * 60); i++) { tr.apply(0.5 + i / 60); minY = Math.min(minY, rig.root.scl[1]); maxY = Math.max(maxY, rig.root.scl[1]); }
  assert.ok(minY < 0.9 && maxY > 1.05, `scale range ${minY}..${maxY}`);
  tr.apply(0.5 + d + 1);
  assert.deepEqual(rig.root.scl, [1, 1, 1]);
  const s = track('sit');
  s.tr.apply(0.5 + s.d + 0.5);
  const toe = Math.min(...s.rig.probes.filter((p) => p.name.startsWith('probe:toe') || p.name.startsWith('probe:heel')).map((p) => p.worldPos()[1]));
  assert.ok(Math.abs(toe) < 1e-6, 'seated feet on the floor');
});

test('LibraryTrack is a pure function of t (random access == sequential)', () => {
  const times = Array.from({ length: 40 }, (_, i) => 0.5 + i * 0.061);
  const snap = (rig: any) => JSON.stringify([rig.root.pos, rig.root.scl, ...JOINTS.map((j: string) => rig.joints[j].rot)]);
  for (const a of ['dance', 'type_laptop', 'slam_door', 'cry']) {
    const A = track(a), B = track(a);
    const seq = times.map((t) => { A.tr.apply(t); return snap(A.rig); });
    const rnd = [...times].reverse().map((t) => { B.tr.apply(t); return snap(B.rig); }).reverse();
    assert.deepEqual(seq, rnd, a);
  }
});

test('LibraryTrack: layers (head_shake) add on top of the body action; unknown actions are rejected', () => {
  const rig = zapp();
  const res = { point: () => [0.3, 0.9, 0.6] as [number, number, number], markFacing: () => 0 };
  const tr = new LibraryTrack('zapp', rig, [{ action: 'shrug', start: 0, duration: 1 }, { action: 'head_shake', start: 0, duration: 1 }], [0, 0, 0], 0, res as any, 7);
  assert.equal(tr.layers.length, 1); assert.equal(tr.segs.length, 1);
  assert.throws(() => new LibraryTrack('zapp', rig, [{ action: 'moonwalk', start: 0, duration: 1 }], [0, 0, 0], 0, res as any, 7), /not in the library/);
});
