import test from 'node:test';
import assert from 'node:assert/strict';
import { assertCompositionTimeline, compositionAt, compositionTimelineIssues, type TimedComposition } from '../src/preview/composition.ts';

const shot = (id: string) => ({ id });
const timeline: TimedComposition<ReturnType<typeof shot>>[] = [
  { beat: 'a', index: 0, start: 1, end: 2, shot: shot('a0') },
  { beat: 'a', index: 1, start: 2, end: 3, shot: shot('a1') },
  { beat: 'b', index: 0, start: 4, end: 5, shot: shot('b0') },
];

test('composition lookup uses exact half-open intervals at hard cuts', () => {
  assertCompositionTimeline(timeline);
  assert.equal(compositionAt(timeline, 1)?.shot.id, 'a0');
  assert.equal(compositionAt(timeline, 1.999999)?.shot.id, 'a0');
  assert.equal(compositionAt(timeline, 2)?.shot.id, 'a1');
  assert.equal(compositionAt(timeline, 3), undefined);
});

test('composition lookup never leaks the nearest shot into gaps or outside the timeline', () => {
  assert.equal(compositionAt(timeline, 0.999), undefined);
  assert.equal(compositionAt(timeline, 3.5), undefined);
  assert.equal(compositionAt(timeline, 5), undefined);
  assert.equal(compositionAt(timeline, 500), undefined);
});

test('composition lookup requires the active beat when supplied', () => {
  assert.equal(compositionAt(timeline, 2.5, 'a')?.shot.id, 'a1');
  assert.equal(compositionAt(timeline, 2.5, 'b'), undefined);
});

test('composition timeline rejects overlaps, reverse order, and invalid windows', () => {
  const overlap = [timeline[0], { ...timeline[1], start: 1.5 }];
  assert.match(compositionTimelineIssues(overlap).join('; '), /overlaps/);
  assert.throws(() => assertCompositionTimeline([...timeline].reverse()), /not sorted|overlaps/);
  assert.throws(() => assertCompositionTimeline([{ ...timeline[0], end: 1 }]), /start < end/);
});
