// Stage F (deterministic compiler): same input => byte-identical episode, in-process and in a fresh process;
// seeds are reproducible; the compiler (not a model) produces the timeline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { buildRegistry } from '../packages/story/src/registry.ts';
import { RulesProvider } from '../packages/story/src/providers/rules.ts';
import { generateEpisode } from '../packages/story/src/pipeline.ts';
import { compileEpisode } from '../packages/story/src/compile.ts';
import { stagePlan } from '../packages/story/src/stage.ts';
import { validateEpisode } from '../packages/pipeline/src/validate.ts';
import { lib, ROOT } from './helpers.ts';

const reg = buildRegistry(lib);
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const IDEAS = ['Zapp presses a free-coins button, celebrates, and the coin becomes too large.', 'Kira spots a secret coin and races Zapp to it, but it topples onto her.', 'Zapp wins a coin and loses it instantly when it grows too big.'];
const gen = (idea: string, seed: number) => generateEpisode({ idea, durationTarget: 17, comedyEngine: null, seed }, { provider: new RulesProvider(), registry: reg, lib, analyzer: null, sha256 });

test('same request => byte-identical episode (in-process, repeated)', async () => {
  for (const idea of IDEAS) {
    const a = await gen(idea, 42), b = await gen(idea, 42);
    assert.equal(a.status, b.status, idea);
    if (a.status !== 'accepted') continue;
    assert.equal(a.episodeSha256, b.episodeSha256, idea);
    assert.equal(JSON.stringify(a.episode), JSON.stringify(b.episode));
  }
});

test('compileEpisode is a pure function of (request, idea, plan, staging, registry)', async () => {
  const r = await gen(IDEAS[0], 7);
  assert.equal(r.status, 'accepted');
  const st = stagePlan(r.plan!, reg.environment).staging;
  const c1 = compileEpisode(r.request, r.normalized!, r.plan!, st, reg), c2 = compileEpisode(JSON.parse(JSON.stringify(r.request)), JSON.parse(JSON.stringify(r.normalized)), JSON.parse(JSON.stringify(r.plan)), JSON.parse(JSON.stringify(st)), reg);
  assert.ok(c1.ok && c2.ok);
  assert.equal(JSON.stringify(c1.ok && c1.episode), JSON.stringify(c2.ok && c2.episode));
  assert.equal(JSON.stringify(c1.ok && c1.episode), JSON.stringify(r.episode));
  assert.ok(validateEpisode(r.episode, lib).ok);
});

test('fresh-process recompilation yields the same bytes', async () => {
  const r = await gen(IDEAS[0], 7);
  const script = `
    import { loadLibrary } from './apps/render-worker/lib/library.ts';
    import { buildRegistry } from './packages/story/src/registry.ts';
    import { RulesProvider } from './packages/story/src/providers/rules.ts';
    import { generateEpisode } from './packages/story/src/pipeline.ts';
    import { createHash } from 'node:crypto';
    const lib = loadLibrary();
    const r = await generateEpisode(${JSON.stringify({ idea: IDEAS[0], durationTarget: 17, comedyEngine: null, seed: 7 })}, { provider: new RulesProvider(), registry: buildRegistry(lib), lib, analyzer: null, sha256: (s) => createHash('sha256').update(s).digest('hex') });
    console.log(r.episodeSha256);`;
  const env = { ...process.env }; delete env.NODE_OPTIONS;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT, env }).toString().trim().split('\n').at(-1);
  assert.equal(out, r.episodeSha256);
});

test('seeds are reproducible and distinct seeds give distinct episodes', async () => {
  const a = await gen(IDEAS[0], 1), b = await gen(IDEAS[0], 1), c = await gen(IDEAS[0], 2);
  assert.equal(a.episodeSha256, b.episodeSha256);
  assert.notEqual(a.episodeSha256, c.episodeSha256);
  assert.equal(c.episode!.episode.seed, 2);
  assert.notEqual(a.episode!.episode.id, c.episode!.episode.id);
});

test('the compiled timeline is produced by the compiler: every action/shot references registered data only', async () => {
  const r = await gen(IDEAS[0], 3);
  const ep = r.episode!;
  const actions = new Set(reg.ids.actions);
  for (const a of ep.actions) assert.ok(actions.has(a.action), `unavailable action ${a.action}`);
  for (const s of ep.shots) assert.ok(reg.cameras.includes(s.preset), s.preset);
  assert.deepEqual(ep.render, { rendererVersion: '1.0.0', motionProfile: 'corrected-head-v2' });
});
