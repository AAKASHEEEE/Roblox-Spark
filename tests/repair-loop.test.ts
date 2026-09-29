// Stage G repair loop: at most 3 repairs, every attempt recorded, patches limited to named (beat, field) pairs,
// schema failures and provider failures terminate explicitly. Scripted providers only (deterministic).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildRegistry } from '../packages/story/src/registry.ts';
import { RulesProvider } from '../packages/story/src/providers/rules.ts';
import { MockProvider, FaultyProvider } from '../packages/story/src/providers/mock.ts';
import { generateEpisode, applyPatches } from '../packages/story/src/pipeline.ts';
import { lib } from './helpers.ts';

const reg = buildRegistry(lib);
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const REQ = { idea: 'Zapp presses a free-coins button, celebrates, and the coin becomes too large.', durationTarget: 17, comedyEngine: null, seed: 11 };
const run = (provider: any, maxRepairs = 3) => generateEpisode(REQ, { provider, registry: reg, lib, analyzer: null, sha256, maxRepairs });

async function rulesPlan(): Promise<any> {
  const base = new RulesProvider();
  const r = await run(base);
  assert.equal(r.status, 'accepted');
  return { idea: r.normalized, plan: JSON.parse(JSON.stringify(r.plan)) };
}

test('a fixable plan is repaired with a patch for exactly the named (beat, field) and accepted', async () => {
  const { plan } = await rulesPlan();
  const broken = JSON.parse(JSON.stringify(plan));
  const b = broken.beats.find((x: any) => x.slot === 'notice');
  const good = b.action; b.action = 'point' === good ? 'look_at' : 'shock_recoil'; // not allowed in this slot
  const m = new MockProvider({ plan: [broken], repair: [(() => ({ patches: [{ op: 'set', beatId: b.id, field: 'action', value: good }], notes: 'fix' })) as never] });
  m.base = new RulesProvider();
  const r = await run(m);
  assert.equal(r.status, 'accepted', r.failure ?? '');
  assert.equal(r.repairs, 1);
  assert.equal(r.attempts.length, 2);
  assert.ok(r.attempts[0].constraints.some((c) => c.beatId === b.id && c.field === 'action'));
  assert.deepEqual(r.attempts[1].patchesApplied.map((p: any) => [p.beatId, p.field]), []); // the applying attempt records on attempt 0
  assert.deepEqual(r.attempts[0].patchesApplied.map((p: any) => [p.beatId, p.field]), [[b.id, 'action']]);
});

test('an unfixable plan stops after exactly 3 repairs; every attempt is saved', async () => {
  const { plan } = await rulesPlan();
  const broken = JSON.parse(JSON.stringify(plan));
  const b = broken.beats.find((x: any) => x.slot === 'notice'); b.action = 'shock_recoil';
  const m = new MockProvider({ plan: [broken], repair: [{ patches: [], notes: 'no idea' }] });
  m.base = new RulesProvider();
  const r = await run(m);
  assert.equal(r.status, 'failed');
  assert.equal(r.repairs, 3);
  assert.equal(r.attempts.length, 4); // initial + 3 repairs
  assert.equal(m.calls.filter((c) => c === 'repair').length, 3);
  assert.match(r.failure!, /not accepted after 3 repair/);
  for (const a of r.attempts) assert.ok(a.constraints.length > 0);
});

test('the repair budget is a parameter (0 = no repair attempts)', async () => {
  const { plan } = await rulesPlan();
  const broken = JSON.parse(JSON.stringify(plan)); broken.beats.find((x: any) => x.slot === 'notice').action = 'shock_recoil';
  const m = new MockProvider({ plan: [broken] }); m.base = new RulesProvider();
  const r = await run(m, 0);
  assert.equal(r.status, 'failed'); assert.equal(r.repairs, 0); assert.equal(r.attempts.length, 1);
});

test('patches outside the named constraints, beat removal and unknown fields are rejected', async () => {
  const { plan } = await rulesPlan();
  const cons = [{ code: 'SLOT_ACTION', message: 'x', beatId: plan.beats[1].id, field: 'action', source: 'compat' as const }];
  const ap = applyPatches(plan, [
    { op: 'set', beatId: plan.beats[1].id, field: 'action', value: 'look_at' },
    { op: 'set', beatId: plan.beats[2].id, field: 'action', value: 'jump' },
    { op: 'remove_beat', beatId: plan.beats[3].id },
    { op: 'set_plan', field: 'stagingVariant', value: 'b' },
  ] as never, cons);
  assert.deepEqual(ap.applied.map((p: any) => p.beatId ?? p.field), [plan.beats[1].id]);
  assert.equal(ap.rejected.length, 3);
  assert.ok(ap.rejected.some((x) => /not permitted/.test(x.reason)));
  assert.equal(ap.plan.beats.length, plan.beats.length);
  assert.equal(plan.beats[1].action, plan.beats[1].action); // input not mutated
});

test('prose instead of JSON is caught by the schema; persistent prose fails after the budget', async () => {
  const m = new MockProvider({ plan: ['Sure! Zapp presses the button and a coin appears...'] }); m.base = new RulesProvider();
  const r = await run(m);
  assert.equal(r.status, 'failed');
  assert.match(r.failure!, /beat plan never passed the schema/);
  assert.equal(r.repairs, 3);
  assert.ok(r.schemaEvents.filter((e) => e.stage === 'plan' && !e.ok).length === 4);
});

test('provider failures terminate explicitly as provider_failure (no silent fallback to another provider)', async () => {
  const m = new MockProvider({ normalize: [{ __error: 'timeout' }] });
  const r = await run(m);
  assert.equal(r.status, 'failed');
  assert.equal(r.rejection?.category, 'provider_failure');
  assert.match(r.failure!, /timeout/);
  assert.equal(r.episode, null);
});

test('fault injection: the pipeline never accepts an episode that contains an injected fault', async () => {
  for (let seed = 0; seed < 6; seed++) {
    const f = new FaultyProvider(new RulesProvider(), 1, seed);
    const r = await generateEpisode({ ...REQ, seed: 100 + seed }, { provider: f, registry: reg, lib, analyzer: null, sha256 });
    if (r.status === 'accepted') for (const a of r.episode!.actions) assert.ok(reg.ids.actions.includes(a.action), `${a.action} (fault ${JSON.stringify(f.injected)})`);
    assert.ok(r.repairs <= 3);
  }
});
