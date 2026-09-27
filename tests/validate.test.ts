import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEpisode } from '../packages/pipeline/src/validate.ts';
import { lib, sample } from './helpers.ts';

const errs = (e: any, repair = false) => validateEpisode(e, lib, { repair }).findings.filter((f) => f.severity === 'error').map((f) => f.code);

test('asset library loads and matches the hash lock', () => { assert.deepEqual(lib.errors, []); });
test('sample episode passes semantic validation with no errors or warnings', () => {
  const v = validateEpisode(sample(), lib, { repair: false });
  assert.ok(v.ok, JSON.stringify(v.findings));
  assert.deepEqual(v.findings.filter((f) => f.severity === 'warning'), []);
  assert.ok(v.metrics.maxStaleGap <= 1.5);
});
test('missing asset version is an error', () => { const e = sample(); e.cast[0].version = '9.9.9'; assert.ok(errs(e).includes('MISSING_ASSET')); });
test('press without a hand contact breaks causality', () => { const e = sample(); e.propEvents.find((p: any) => p.event === 'press').start = 6; assert.ok(errs(e).includes('CAUSALITY')); });
test('expression outside a character lock is rejected', () => { const e = sample(); e.expressions.push({ actor: 'kira', state: 'regret', at: 3 }); assert.ok(errs(e).includes('INVALID_EXPRESSION')); });
test('button may not be scaled (forbidden transformation)', () => { const e = sample(); e.propEvents.push({ prop: 'button', event: 'grow', start: 5, duration: 0.3, params: { scale: 2 } }); assert.ok(errs(e).includes('FORBIDDEN_TRANSFORM')); });
test('impossible walking speed is rejected', () => { const e = sample(); e.actions[0].duration = 0.3; assert.ok(errs(e).includes('IMPOSSIBLE_ACTION')); });
test('reversal must land in the final 3 seconds', () => { const e = sample(); const tip = e.propEvents.find((p: any) => p.event === 'tip_over'); tip.start = 10; assert.ok(errs(e).includes('REVERSAL_TOO_EARLY')); });
test('non-loop ending is rejected', () => { const e = sample(); e.shots[e.shots.length - 1].preset = 'wide_environment'; assert.ok(errs(e).includes('LOOP')); });
test('stale stretches are detected', () => {
  const e = sample();
  const keep = (t: number) => t < 5 || t > 8;
  e.actions = e.actions.filter((a: any) => keep(a.start)); e.propEvents = e.propEvents.filter((p: any) => keep(p.start));
  e.vfx = e.vfx.filter((v: any) => keep(v.at)); e.expressions = e.expressions.filter((x: any) => keep(x.at));
  e.shots = e.shots.map((s: any) => s); // shots still cut at 5.8/7.2 -> gap between cuts
  e.shots.find((s: any) => s.id === 's06').preset = 'two_shot';
  const s5 = e.shots.findIndex((s: any) => s.id === 's05'); e.shots[s5].end = 8.45; e.shots.splice(s5 + 1, 2);
  assert.ok(errs(e).includes('STALE_STRETCH'));
});
test('protected brand and unsafe terms are blocked', () => { const e = sample(); e.episode.title = 'Free Robux giveaway'; assert.ok(errs(e).includes('UNSAFE_OR_PROTECTED_TERM')); });
test('small timeline problems are auto-repaired, and reported', () => {
  const e = sample(); e.shots[1].start += 0.1; e.audio.cues.find((c: any) => c.sfx === 'sfx_click').at = 3.9;
  const v = validateEpisode(e, lib, { repair: true });
  assert.ok(v.ok, JSON.stringify(v.findings.filter((f) => f.severity === 'error')));
  assert.ok(v.repairs.some((r) => r.includes('snapped')) && v.repairs.some((r) => r.includes('sfx_click')));
});
test('without repair the same problems are explicit errors', () => {
  const e = sample(); e.audio.cues.find((c: any) => c.sfx === 'sfx_click').at = 3.9;
  assert.ok(errs(e).includes('AV_SYNC'));
});
