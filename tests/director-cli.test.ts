import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { directScript } from '../packages/director/src/pipeline.ts';
import { DIRECTOR_ALGORITHM_VERSION, normalizeDirectorRequest } from '../packages/director/src/offline.ts';
import { NodeDirectorCache, type DirectorCacheDescriptor } from '../packages/director/node/cache.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baseArgs = (out: string, report: string) => ['scripts/director.ts', '--script', '-', '--duration', '3', '--seed', '2', '--out', out, '--report', report];

test('CLI keyless auto ignores inert paid model settings and falls back offline', () => {
  const temp = mkdtempSync(join(tmpdir(), 'spark-director-cli-auto-'));
  try {
    const out = join(temp, 'beats.json'), report = join(temp, 'report.json');
    const run = spawnSync(process.execPath, [...baseArgs(out, report), '--provider', 'auto', '--no-cache'], {
      cwd: ROOT, input: 'Zapp runs in class.\n', encoding: 'utf8',
      env: { ...process.env, OPENROUTER_API_KEY: '', OPENROUTER_MODELS: 'paid/model' },
    });
    assert.equal(run.status, 0, run.stderr);
    const parsed = JSON.parse(readFileSync(report, 'utf8'));
    assert.equal(parsed.provider.used, 'offline');
    assert.equal(parsed.provider.fallback.code, 'openrouter_key_missing');
    assert.equal(parsed.editPlan.policy.minimumSegmentSeconds, 0.6);
    assert.equal(parsed.cache.keyMetadata.editPlan.version, parsed.editPlan.policy.version);
    assert.equal(parsed.cache.keyMetadata.coverage.version, parsed.editPlan.coverage.version);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('CLI rejects a whitespace credential before an explicit-mode cache lookup', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'spark-director-cli-key-'));
  try {
    const script = 'Zapp runs in class.';
    const request = normalizeDirectorRequest({ script, duration: 3, seed: 2 });
    const descriptor: DirectorCacheDescriptor = {
      algorithmVersion: DIRECTOR_ALGORITHM_VERSION, request, provider: 'openrouter', models: ['openrouter/free'], timeoutMs: 12_000, openRouterConfigured: false,
    };
    const cacheRoot = join(temp, 'cache');
    new NodeDirectorCache(cacheRoot).put(descriptor, await directScript({ script, duration: 3, seed: 2 }, { provider: 'offline' }));
    const out = join(temp, 'beats.json'), report = join(temp, 'report.json');
    const run = spawnSync(process.execPath, [...baseArgs(out, report), '--provider', 'openrouter', '--cache-dir', cacheRoot], {
      cwd: ROOT, input: `${script}\n`, encoding: 'utf8',
      env: { ...process.env, OPENROUTER_API_KEY: '   ', OPENROUTER_MODELS: 'openrouter/free' },
    });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /OPENROUTER_API_KEY is not set/);
    assert.equal(existsSync(out), false);
    assert.equal(existsSync(report), false);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
