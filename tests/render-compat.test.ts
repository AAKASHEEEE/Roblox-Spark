// Rendering compatibility contract (node-only): explicit declarations, no inference, explicit failures, safe upgrades.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, readdirSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { EpisodeSchema } from '../packages/schema/src/episode.ts';
import { validateEpisode } from '../packages/pipeline/src/validate.ts';
import {
  checkRenderDeclaration, resolveRenderCompat, RenderCompatError, upgradeEpisode, pinEpisode, canonicalJson, semanticContent,
  MOTION_PROFILES, DEFAULT_MOTION_PROFILE, CURRENT_RENDERER_VERSION,
} from '../packages/schema/src/render-compat.ts';
import { upgradeFile } from '../scripts/episode-version.ts';
import { canonical } from '../apps/render-worker/lib/library.ts';
import { lib, sample, ROOT } from './helpers.ts';

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const codes = (e: unknown) => validateEpisode(e, lib, { repair: false }).findings.filter((f) => f.severity === 'error').map((f) => f.code);

function fixtureFiles(): string[] {
  const out: string[] = [];
  const walk = (d: string) => { if (!existsSync(d)) return; for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (f.endsWith('.json')) out.push(p); } };
  walk(join(ROOT, 'episodes')); walk(join(ROOT, 'tests', 'fixtures', 'episodes'));
  return out;
}

test('every committed episode fixture declares a supported renderer version and motion profile', () => {
  const files = fixtureFiles();
  assert.ok(files.length >= 1);
  for (const f of files) {
    const c = checkRenderDeclaration(JSON.parse(readFileSync(f, 'utf8')));
    assert.ok(c.ok, `${relative(ROOT, f)}: ${!c.ok && c.message}`);
  }
});

test('pre-existing fixtures are pinned to legacy-head-v1 with their content unchanged', () => {
  const ep = sample();
  assert.deepEqual(ep.render, { rendererVersion: '1.0.0', motionProfile: 'legacy-head-v1' });
  // the baseline (commit 1dc7a26) hashed the canonical schema-1.0 episode: pinning added the declaration and nothing else
  const base = JSON.parse(readFileSync(join(ROOT, 'docs/poc/frame-hashes-baseline.json'), 'utf8'));
  const { render: _r, ...content } = ep; void _r;
  assert.equal(sha(canonical({ ...content, schemaVersion: '1.0' })), base.episodeSha256);
});

test('missing declarations fail explicitly with their own codes (no fallback profile)', () => {
  const noBlock = sample(); delete noBlock.render;
  assert.deepEqual(codes(noBlock), ['RENDER_VERSION_MISSING']);
  const noRenderer = sample(); delete noRenderer.render.rendererVersion;
  assert.deepEqual(codes(noRenderer), ['RENDERER_VERSION_MISSING']);
  const noProfile = sample(); delete noProfile.render.motionProfile;
  assert.deepEqual(codes(noProfile), ['MOTION_PROFILE_MISSING']);
  const old = sample(); old.schemaVersion = '1.0'; delete old.render;
  assert.deepEqual(codes(old), ['UNSUPPORTED_SCHEMA_VERSION']);
  for (const e of [noBlock, noRenderer, noProfile, old]) {
    assert.equal(validateEpisode(e, lib).ok, false);
    assert.throws(() => resolveRenderCompat(e), (x: unknown) => x instanceof RenderCompatError);
  }
});

test('unsupported versions fail explicitly (schema, validator and engine resolver)', () => {
  const badRenderer = sample(); badRenderer.render.rendererVersion = '9.9.9';
  const badProfile = sample(); badProfile.render.motionProfile = 'corrected-head-v3';
  assert.deepEqual(codes(badRenderer), ['UNSUPPORTED_RENDERER_VERSION']);
  assert.deepEqual(codes(badProfile), ['UNSUPPORTED_MOTION_PROFILE']);
  assert.equal(EpisodeSchema.parse(badRenderer).ok, false);
  assert.equal(EpisodeSchema.parse(badProfile).ok, false);
  assert.throws(() => resolveRenderCompat(badRenderer), /UNSUPPORTED_RENDERER_VERSION/);
  assert.throws(() => resolveRenderCompat(badProfile), /UNSUPPORTED_MOTION_PROFILE/);
});

test('behaviour comes only from the declared profile, never from ids or file names', () => {
  const a = sample();
  const b = sample(); b.episode.id = 'totally-different-id'; b.episode.title = 'Renamed';
  assert.deepEqual(resolveRenderCompat(a).behaviour, MOTION_PROFILES['legacy-head-v1'].behaviour);
  assert.deepEqual(resolveRenderCompat(b).behaviour, MOTION_PROFILES['legacy-head-v1'].behaviour);
  const c = sample(); c.render.motionProfile = 'corrected-head-v2'; // same id + file content otherwise
  assert.deepEqual(resolveRenderCompat(c).behaviour, MOTION_PROFILES['corrected-head-v2'].behaviour);
  // static guard: engine/pipeline/schema sources never special-case fixture ids, file names or dates
  const src: string[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (f.endsWith('.ts')) src.push(readFileSync(p, 'utf8')); } };
  for (const d of ['packages/engine/src', 'packages/pipeline/src', 'packages/schema/src']) walk(join(ROOT, d));
  for (const s of src) assert.ok(!s.includes('free-coins-loop-001'), 'fixture id referenced in engine/pipeline/schema source');
  const compatSrc = readFileSync(join(ROOT, 'packages/schema/src/render-compat.ts'), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/Date|\.id\b|filename|basename|statSync/.test(compatSrc), 'profile resolution must not look at dates, ids or files');
});

test('upgrade copies to corrected-head-v2 without altering the original', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bs-upgrade-'));
  const src = join(dir, 'legacy.json'), out = join(dir, 'legacy.v2.json');
  writeFileSync(src, JSON.stringify(sample(), null, 2) + '\n');
  const before = readFileSync(src);
  const r = upgradeFile(src, 'corrected-head-v2', out);
  assert.equal(sha(readFileSync(src)), sha(before), 'source bytes unchanged');
  const up = JSON.parse(readFileSync(out, 'utf8'));
  assert.deepEqual(up.render, { rendererVersion: CURRENT_RENDERER_VERSION, motionProfile: 'corrected-head-v2', upgradedFrom: { rendererVersion: '1.0.0', motionProfile: 'legacy-head-v1', sourceSha256: sha(before) } });
  assert.equal(sha(canonicalJson(semanticContent(up))), sha(canonicalJson(semanticContent(sample()))), 'semantic content identical');
  assert.equal(r.semanticSha256, sha(canonicalJson(semanticContent(up))));
  assert.ok(validateEpisode(up, lib).ok);
  assert.throws(() => upgradeFile(src, 'corrected-head-v2', src), /never modified/);
  assert.throws(() => upgradeFile(src, 'corrected-head-v2', out), /exists/);
  const undeclared = sample(); delete undeclared.render; undeclared.schemaVersion = '1.0';
  assert.throws(() => upgradeEpisode(undeclared, 'corrected-head-v2', { sourceSha256: 'a'.repeat(64) }), /UNSUPPORTED_SCHEMA_VERSION/);
  assert.throws(() => upgradeEpisode(up, 'corrected-head-v2', { sourceSha256: 'a'.repeat(64) }), /nothing to upgrade/);
});

test('pin needs an explicit renderer + profile and refuses already-declared episodes', () => {
  const legacy = sample(); delete legacy.render; legacy.schemaVersion = '1.0';
  assert.throws(() => pinEpisode(legacy, { rendererVersion: '1.0.0', motionProfile: 'nope' }), /UNSUPPORTED_MOTION_PROFILE/);
  assert.throws(() => pinEpisode(sample(), { rendererVersion: '1.0.0', motionProfile: 'legacy-head-v1' }), /already declares/);
  const p = pinEpisode(legacy, { rendererVersion: '1.0.0', motionProfile: 'legacy-head-v1' });
  assert.equal(p.schemaVersion, '1.1');
  assert.ok(checkRenderDeclaration(p).ok);
});

test('the default for newly generated episodes is corrected-head-v2', async () => {
  assert.equal(DEFAULT_MOTION_PROFILE, 'corrected-head-v2');
  assert.equal(MOTION_PROFILES['legacy-head-v1'].status, 'legacy');
  assert.equal(MOTION_PROFILES['corrected-head-v2'].status, 'current');
  const { generateEpisode } = await import('../packages/story/src/pipeline.ts');
  const { RulesProvider } = await import('../packages/story/src/providers/rules.ts');
  const { buildRegistry } = await import('../packages/story/src/registry.ts');
  const r = await generateEpisode({ idea: 'Zapp presses a free-coins button, celebrates, and the coin becomes too large.', durationTarget: 17, comedyEngine: null, seed: 17 }, { provider: new RulesProvider(), registry: buildRegistry(lib), lib, analyzer: null, sha256: (s: string) => sha(s) });
  assert.equal(r.status, 'accepted', JSON.stringify(r.rejection ?? r.attempts.at(-1)?.constraints ?? null));
  assert.deepEqual(r.episode!.render, { rendererVersion: CURRENT_RENDERER_VERSION, motionProfile: 'corrected-head-v2' });
  // an explicit request for another profile is honoured and declared, never guessed later
  const l = await generateEpisode({ idea: 'Zapp presses a free-coins button, celebrates, and the coin becomes too large.', durationTarget: 17, comedyEngine: null, seed: 17, motionProfile: 'legacy-head-v1' }, { provider: new RulesProvider(), registry: buildRegistry(lib), lib, analyzer: null, sha256: (s: string) => sha(s) });
  assert.equal(l.episode!.render.motionProfile, 'legacy-head-v1');
});
