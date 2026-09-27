// Benchmark harness smoke: a 4-idea subset of the frozen set, static (no browser), writes records + metrics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT } from './helpers.ts';

test('bench-generate --static on a small set produces records, episodes and all metrics', { timeout: 120000 }, () => {
  const full = JSON.parse(readFileSync(join(ROOT, 'bench/ideas.json'), 'utf8'));
  const pick = [...full.ideas.filter((i: any) => i.expected !== 'reject').slice(0, 3), full.ideas.find((i: any) => i.expected === 'reject')];
  const dir = mkdtempSync(join(ROOT, 'out', 'bench-smoke-'));
  const setFile = join(dir, 'set.json');
  writeFileSync(setFile, JSON.stringify({ ...full, name: 'smoke', ideas: pick }));
  const env = { ...process.env }; delete env.NODE_OPTIONS;
  execFileSync(process.execPath, ['scripts/bench-generate.ts', '--set', relative(ROOT, setFile), '--provider', 'rules', '--out', relative(ROOT, join(dir, 'run')), '--static'], { cwd: ROOT, env, stdio: 'pipe' });
  const out = join(dir, 'run');
  assert.equal(readdirSync(join(out, 'records')).length, pick.length);
  const m = JSON.parse(readFileSync(join(out, 'metrics.json'), 'utf8'));
  for (const k of ['m01_schemaValidResponseRate', 'm04_firstPassValidatorAcceptance_compatible', 'm05_acceptanceAfterRepair_compatible', 'm07_rejectionCorrectness_mustReject', 'm16_deterministicRecompilation']) assert.ok(k in m, k);
  assert.equal(m.run.ideas, pick.length);
  assert.equal(m.m16_deterministicRecompilation, 100);
  assert.ok(existsSync(join(out, 'results.md')));
  rmSync(dir, { recursive: true, force: true });
});
