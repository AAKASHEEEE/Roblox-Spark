// Story stages A-C: normalisation, stage schemas (malformed output, JSON Schema export), asset/action compatibility,
// unsafe / protected ideas. Offline: rules provider, no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { toJsonSchema } from '../packages/schema/src/v.ts';
import { normalizedIdeaSchema, beatPlanSchema, StoryRequestSchema } from '../packages/story/src/schemas.ts';
import { buildRegistry } from '../packages/story/src/registry.ts';
import { RulesProvider } from '../packages/story/src/providers/rules.ts';
import { checkCompatibility } from '../packages/story/src/compat.ts';
import { generateEpisode } from '../packages/story/src/pipeline.ts';
import { lib } from './helpers.ts';

const reg = buildRegistry(lib);
const EXAMPLE = 'Zapp presses a free-coins button, celebrates, and the coin becomes too large.';
const req = (idea: string, seed = 17) => ({ idea, durationTarget: 17, comedyEngine: null, seed });
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const gen = (idea: string, seed = 17) => generateEpisode(req(idea, seed), { provider: new RulesProvider(), registry: reg, lib, analyzer: null, sha256 });
async function stageA(idea: string) { return new RulesProvider().normalizeIdea({ request: StoryRequestSchema.parse(req(idea)).ok ? req(idea) as never : never(), registry: reg, constraints: [] }); }
function never(): never { throw new Error('bad request'); }

test('Stage A normalises the brief example into a schema-valid, safe idea', async () => {
  const raw = await stageA(EXAMPLE);
  const r = normalizedIdeaSchema(reg.ids).parse(raw);
  assert.ok(r.ok, JSON.stringify(!r.ok && r.issues.slice(0, 3)));
  const n = r.ok ? r.value : never();
  assert.equal(n.rejection, null);
  assert.equal(n.safety.classification, 'safe');
  assert.equal(n.engine, 'ordinary_object_extreme');
});

test('request schema: duration target limited to 14-22 s, seed must be an integer', () => {
  assert.equal(StoryRequestSchema.parse({ ...req(EXAMPLE), durationTarget: 30 }).ok, false);
  assert.equal(StoryRequestSchema.parse({ ...req(EXAMPLE), seed: 1.5 }).ok, false);
  assert.equal(StoryRequestSchema.parse({ ...req(EXAMPLE), extra: 1 }).ok, false);
});

test('stage schemas reject malformed model output (prose, extra keys, invented enums, missing fields)', async () => {
  const good = await stageA(EXAMPLE) as any;
  const S = normalizedIdeaSchema(reg.ids);
  assert.equal(S.parse('Sure! Here is your story...').ok, false);
  assert.equal(S.parse({ ...good, script: 'rm -rf /' }).ok, false);
  assert.equal(S.parse({ ...good, engine: 'musical_number' }).ok, false);
  const missing = { ...good }; delete missing.safety; assert.equal(S.parse(missing).ok, false);
  const plan = await new RulesProvider().planBeats({ request: req(EXAMPLE) as never, idea: good, template: (await import('../packages/story/src/templates.ts')).TEMPLATES[good.engine as 'ordinary_object_extreme'], registry: reg, constraints: [] }) as any;
  const P = beatPlanSchema(reg.ids);
  assert.ok(P.parse(plan).ok);
  const bad = JSON.parse(JSON.stringify(plan)); bad.beats[1].action = 'dance';
  assert.equal(P.parse(bad).ok, false);
  const bad2 = JSON.parse(JSON.stringify(plan)); bad2.beats[0].propEffect = { prop: 'pizza', effect: 'grow', magnitude: 'huge' };
  assert.equal(P.parse(bad2).ok, false);
});

test('JSON Schema export for structured output: strict objects, enums from the live registry', () => {
  const js = toJsonSchema(beatPlanSchema(reg.ids), true) as any;
  assert.equal(js.type, 'object');
  assert.equal(js.additionalProperties, false);
  assert.ok(Array.isArray(js.required) && js.required.includes('beats'));
  const text = JSON.stringify(js);
  for (const a of reg.ids.actions) assert.ok(text.includes(`"${a}"`), a);
  const ni = toJsonSchema(normalizedIdeaSchema(reg.ids), true) as any;
  assert.equal(ni.additionalProperties, false);
});

test('unknown assets / actions are rejected precisely (never silently fabricated)', async () => {
  const idea = normalizedIdeaSchema(reg.ids).parse(await stageA(EXAMPLE));
  const n = idea.ok ? idea.value : never();
  const plan = await new RulesProvider().planBeats({ request: req(EXAMPLE) as never, idea: n, template: (await import('../packages/story/src/templates.ts')).TEMPLATES[n.engine], registry: reg, constraints: [] }) as any;
  const p = JSON.parse(JSON.stringify(plan));
  const b = p.beats.find((x: any) => x.slot === 'notice') ?? p.beats[1];
  b.action = 'hover';
  const c = checkCompatibility(n, p, reg);
  assert.ok(c.constraints.some((x) => x.beatId === b.id && x.field === 'action' && /SLOT_ACTION|ACTION_UNAVAILABLE/.test(x.code)), JSON.stringify(c.constraints));
  // ideas needing unbuilt things are either substituted WITH a declaration or rejected with a reason
  for (const text of ['Zapp orders a pizza and it becomes too large.', 'A dragon presses the button in the classroom.', 'Zapp presses a button on the school bus.']) {
    const r = await gen(text);
    if (r.status === 'accepted') {
      assert.ok(r.substitutions.length > 0, `${text}: accepted with no declared substitution`);
      const ep = r.episode!;
      assert.deepEqual([...new Set(ep.cast.map((c) => c.id))].sort(), ['kira', 'zapp'].filter((x) => ep.cast.some((c) => c.id === x)).sort());
      assert.ok(ep.props.every((p) => ['student_desk', 'suspicious_button', 'spark_coin'].includes(p.id)), text);
      assert.equal(ep.environment.id, 'classroom');
    } else {
      assert.equal(r.status, 'rejected', `${text}: ${r.failure}`);
      assert.ok(r.rejection?.reason.length, text);
    }
  }
});

test('unsafe and protected-IP ideas are rejected with a category; style-only brand mentions are transformed and declared', async () => {
  for (const [text, cat] of [['Zapp stabs Kira with a knife to get the coin.', 'unsafe'], ['Kira gives away free Robux with the button.', 'unsafe'], ['Mario presses the free coins button.', 'protected_ip'], ['SpongeBob steals the giant coin.', 'protected_ip']] as const) {
    const r = await gen(text);
    assert.equal(r.status, 'rejected', text);
    assert.equal(r.rejection?.category, cat, `${text}: ${r.rejection?.category}`);
    assert.equal(r.episode, null);
  }
  const t = await gen('Zapp presses a Minecraft-style button and the coin grows huge.');
  if (t.status === 'accepted') assert.ok(t.substitutions.some((s) => s.kind === 'brand'), 'style reference removed without declaration');
  else assert.equal(t.rejection?.category, 'protected_ip');
});
