// Security: model output is inert data. No dynamic code execution anywhere on the model-output path; code-like
// strings and prototype-pollution keys are rejected or treated as text; deterministic providers are deterministic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { buildRegistry } from '../packages/story/src/registry.ts';
import { RulesProvider } from '../packages/story/src/providers/rules.ts';
import { MockProvider } from '../packages/story/src/providers/mock.ts';
import { generateEpisode } from '../packages/story/src/pipeline.ts';
import { normalizedIdeaSchema } from '../packages/story/src/schemas.ts';
import { EpisodeSchema } from '../packages/schema/src/episode.ts';
import { lib, sample, ROOT } from './helpers.ts';

const reg = buildRegistry(lib);
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const REQ = { idea: 'Zapp presses a free-coins button, celebrates, and the coin becomes too large.', durationTarget: 17, comedyEngine: null, seed: 3 };

test('no eval / Function / vm / child_process / dynamic import on the model-output path', () => {
  const files: string[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (f.endsWith('.ts')) files.push(p); } };
  for (const d of ['packages/story/src', 'packages/pipeline/src', 'packages/schema/src', 'packages/engine/src', 'packages/audio/src', 'packages/mp4/src']) walk(join(ROOT, d));
  assert.ok(files.length > 20);
  const banned = [/\beval\s*\(/, /\bnew\s+Function\s*\(/, /\bFunction\s*\(\s*['"`]/, /from\s+['"]node:vm['"]/, /from\s+['"](node:)?child_process['"]/, /\bimport\s*\(\s*[^'"`]/, /\bsetTimeout\s*\(\s*['"`]/, /innerHTML\s*=/];
  for (const f of files) {
    const src = readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const re of banned) assert.ok(!re.test(src), `${f.replace(ROOT + '/', '')}: ${re}`);
  }
});

test('code-like strings in model output are inert text (never executed) and prototype keys are rejected', async () => {
  const good = await new RulesProvider().normalizeIdea({ request: REQ as never, registry: reg, constraints: [] }) as any;
  const polluted = JSON.parse(JSON.stringify(good)); polluted.__proto__ = { polluted: true }; polluted.constructor = { prototype: { polluted: true } };
  assert.equal(normalizedIdeaSchema(reg.ids).parse(JSON.parse(JSON.stringify(polluted))).ok, false, 'own constructor key must be rejected');
  const withKey = JSON.parse('{"__proto__": {"polluted": true}}');
  assert.equal(normalizedIdeaSchema(reg.ids).parse({ ...good, ...withKey }).ok, false, 'own __proto__ key must be an unknown-key error');
  for (const k of ['constructor', 'toString', 'hasOwnProperty']) assert.equal(normalizedIdeaSchema(reg.ids).parse({ ...good, [k]: 'x' }).ok, false, `${k} slipped through the strict check`);
  assert.equal(EpisodeSchema.parse({ ...sample(), constructor: { prototype: {} } }).ok, false);
  assert.equal(({} as any).polluted, undefined, 'Object.prototype polluted');
  const marker = join(ROOT, 'out', 'SHOULD_NOT_EXIST');
  const evil = { ...good, title: `process.exit(1); require('fs').writeFileSync('${marker}','x')`, logline: '${globalThis.process.exit(1)}' };
  const m = new MockProvider({ normalize: [evil] }); m.base = new RulesProvider();
  const r = await generateEpisode(REQ, { provider: m, registry: reg, lib, analyzer: null, sha256 });
  assert.ok(['accepted', 'rejected', 'failed'].includes(r.status));
  assert.ok(!existsSync(marker), 'model string was executed');
  // titles come from the plan, but whatever text survives is inert data inside strict schema fields
  if (r.episode) assert.ok(EpisodeSchema.parse(r.episode).ok);
});

test('episodes cannot carry code: unknown keys and non-enum actions are schema errors', () => {
  const e = sample(); e.onLoad = 'fetch("http://x")';
  assert.equal(EpisodeSchema.parse(e).ok, false);
  const e2 = sample(); e2.actions[0].action = 'require("child_process").exec';
  assert.equal(EpisodeSchema.parse(e2).ok, false);
  const e3 = sample(); e3.shots[0].params = { js: 'alert(1)', fn: { code: 1 } };
  assert.equal(EpisodeSchema.parse(e3).ok, false);
});

test('mock and rules providers are deterministic', async () => {
  const a = await new RulesProvider().normalizeIdea({ request: REQ as never, registry: reg, constraints: [] });
  const b = await new RulesProvider().normalizeIdea({ request: REQ as never, registry: reg, constraints: [] });
  assert.deepEqual(a, b);
  const script = { normalize: [a], repair: [{ patches: [], notes: 'x' }] };
  const r1 = await generateEpisode(REQ, { provider: Object.assign(new MockProvider(script), { base: new RulesProvider() }), registry: reg, lib, analyzer: null, sha256 });
  const r2 = await generateEpisode(REQ, { provider: Object.assign(new MockProvider(script), { base: new RulesProvider() }), registry: reg, lib, analyzer: null, sha256 });
  assert.equal(r1.episodeSha256, r2.episodeSha256);
});
