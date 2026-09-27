import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EpisodeSchema } from '../packages/schema/src/episode.ts';
import { sample } from './helpers.ts';

test('sample episode satisfies the strict schema', () => {
  const r = EpisodeSchema.parse(sample());
  assert.ok(r.ok, JSON.stringify(!r.ok && r.issues));
});
test('unknown keys are rejected (no appearance/code smuggling)', () => {
  const e = sample(); e.cast[0].hairColor = '#00ff00';
  const r = EpisodeSchema.parse(e);
  assert.ok(!r.ok && r.issues.some((i) => i.path === '$.cast[0].hairColor'));
});
test('code-like payloads cannot enter as actions', () => {
  const e = sample(); e.actions.push({ actor: 'zapp', action: 'eval', start: 1, duration: 1, params: { js: 'process.exit()' } });
  assert.ok(!EpisodeSchema.parse(e).ok);
});
test('duration and resolution are constrained', () => {
  const e = sample(); e.episode.duration = 40; e.episode.resolution = [1920, 1080];
  const r = EpisodeSchema.parse(e);
  assert.ok(!r.ok && r.issues.length >= 3);
});
