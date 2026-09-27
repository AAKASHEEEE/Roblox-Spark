// Hand-held object actions are unavailable to the generator until hand attachment exists (explicit, end to end).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ACTION_REQUIREMENTS, ENGINE_FEATURES, unmetRequirements } from '../packages/engine/src/animation/actions.ts';
import { buildRegistry, registrySummary } from '../packages/story/src/registry.ts';
import { beatPlanSchema } from '../packages/story/src/schemas.ts';
import { validateEpisode } from '../packages/pipeline/src/validate.ts';
import { generateEpisode } from '../packages/story/src/pipeline.ts';
import { RulesProvider } from '../packages/story/src/providers/rules.ts';
import { lib, sample } from './helpers.ts';

const HAND = ['pick_up', 'hold', 'put_down', 'throw', 'drink'] as const;

test('pick_up, hold, put_down, throw and drink require hand attachment, which does not exist yet', () => {
  assert.equal(ENGINE_FEATURES.handAttachment, false);
  for (const a of HAND) assert.deepEqual(unmetRequirements(a), ['handAttachment'], a);
  assert.deepEqual(unmetRequirements('press_button'), []);
});

test('registry: the five hand actions are explicitly unavailable, with a reason; everything else in slots stays available', () => {
  const reg = buildRegistry(lib);
  for (const a of HAND) {
    const c = reg.actions[a];
    assert.equal(c.implemented, true, `${a} pose exists`);
    assert.equal(c.storyUse, false, a);
    assert.equal(c.availability.status, 'unavailable', a);
    assert.ok(c.availability.status === 'unavailable' && c.availability.requires.includes('handAttachment'), a);
    assert.ok(!reg.ids.actions.includes(a), `${a} offered to the generator`);
  }
  for (const a of ['press_button', 'look_at', 'run', 'victory_pose', 'dive_prone']) assert.equal(reg.actions[a].availability.status, 'available', a);
  const summary = registrySummary(reg) as any;
  for (const a of HAND) assert.ok(summary.unavailableActions[a]?.includes('hand'), `${a} not listed as unavailable in the model prompt`);
  for (const ch of Object.values(summary.characters) as any[]) for (const a of HAND) assert.ok(!ch.actions.includes(a), `${a} offered in the prompt`);
});

test('the model-facing beat schema cannot express an unavailable action', () => {
  const reg = buildRegistry(lib);
  const json = JSON.stringify(beatPlanSchema(reg.ids).json(true));
  for (const a of HAND) assert.ok(!json.includes(`"${a}"`), `${a} appears in the structured-output schema`);
  assert.ok(json.includes('"press_button"'));
});

test('availability follows the engine feature: enabling hand attachment would make them available', () => {
  const reg = buildRegistry(lib, { ...ENGINE_FEATURES, handAttachment: true });
  for (const a of HAND) assert.equal(reg.actions[a].availability.status, 'available', a);
});

test('story validation rejects them; the action-reel profile allows them (poses exercised on purpose)', () => {
  const e = sample();
  e.actions.push({ actor: 'kira', action: 'pick_up', start: 15.0, duration: 1.0, target: 'coin' });
  const story = validateEpisode(e, lib, { repair: false });
  assert.ok(story.findings.some((f) => f.code === 'ACTION_UNAVAILABLE' && f.severity === 'error' && /hand/.test(f.message)));
  const reel = validateEpisode(e, lib, { repair: false, profile: 'action-reel' });
  assert.ok(reel.findings.some((f) => f.code === 'ACTION_UNAVAILABLE' && f.severity === 'info'));
  assert.ok(!reel.findings.some((f) => f.code === 'ACTION_UNAVAILABLE' && f.severity === 'error'));
  assert.ok(ACTION_REQUIREMENTS.pick_up);
});

test('ideas that ask for held objects never produce an episode that uses a hand action', async () => {
  const reg = buildRegistry(lib);
  const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
  for (const idea of ['Zapp picks up the giant coin and throws it at the button.', 'Kira grabs the coin, holds it up and puts it down on the desk.', 'Zapp drinks juice after pressing the button.']) {
    const r = await generateEpisode({ idea, durationTarget: 17, comedyEngine: null, seed: 5 }, { provider: new RulesProvider(), registry: reg, lib, analyzer: null, sha256 });
    const used = (r.episode ?? r.lastCompiled)?.actions.map((a) => a.action) ?? [];
    for (const a of HAND) assert.ok(!used.includes(a), `${idea}: ${a} used`);
    assert.ok(r.status === 'rejected' || r.substitutions.length > 0 || r.warnings.length > 0 || r.status === 'accepted', r.status);
  }
});
