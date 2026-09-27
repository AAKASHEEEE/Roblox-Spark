// Validation profiles + duration boundary: action reels are not judged by story-only gates; G03 checks the channel
// boundary (14-22 s) unless a test case explicitly declares a narrower target.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildQualityReport, STORY_ONLY_GATES, type QualityInput } from '../packages/pipeline/src/quality.ts';
import { validateEpisode, STORY_STRUCTURE_CODES } from '../packages/pipeline/src/validate.ts';
import { CHANNEL_DURATION_SEC } from '../packages/config/src/product.ts';
import { lib, sample } from './helpers.ts';

function input(durationSec: number, extra: Partial<QualityInput> = {}): QualityInput {
  const ep = sample();
  const v = validateEpisode(ep, lib, { repair: false });
  const N = Math.round(durationSec * 30);
  return {
    ep: v.episode!, validation: v, analysis: [], contactChecks: [], probes: [], contacts: [], impacts: [],
    inspect: { tracks: [{ handler: 'vide', width: 1080, height: 1920, durationSec, sampleCount: N, sampleDurations: [1000], timescale: 30000 }, { handler: 'soun', codec: 'mp4a', channels: 2, sampleRate: 48000, editDurationSec: durationSec }] },
    playback: { ok: true, videoWidth: 1080, videoHeight: 1920, framesDecodedDuringPlay: N, playedSeconds: durationSec, droppedFrames: 0, errors: [], audioDecodedBytes: 1000 },
    loopDiff: [0.01, 0.3], audio: { integratedLufs: -14, truePeakDbfsApprox: -2, limiterReductionDbMax: 0 }, lib, timing: {}, fps: 30, ...extra,
  };
}
const g03 = (q: ReturnType<typeof buildQualityReport>) => q.gates.find((g) => g.id === 'G03')!;

test('channel production boundary is 14-22 s', () => { assert.deepEqual([...CHANNEL_DURATION_SEC], [14, 22]); });

test('G03 uses the 14-22 s channel boundary by default', () => {
  for (const [d, pass] of [[13.9, false], [14, true], [18.5, true], [19.87, true], [22, true], [22.1, false]] as const) {
    const q = buildQualityReport(input(d));
    assert.equal(g03(q).pass, pass, `${d}s`);
    assert.match(g03(q).name, /channel production boundary 14-22/);
  }
});

test('G03 uses 14-18 s only when a test case explicitly declares it', () => {
  const q = buildQualityReport(input(18.5, { durationTargetSec: [14, 18] }));
  assert.equal(g03(q).pass, false);
  assert.match(g03(q).name, /declared test target 14-18/);
  assert.equal(buildQualityReport(input(17, { durationTargetSec: [14, 18] })).gates.find((g) => g.id === 'G03')!.pass, true);
  assert.throws(() => buildQualityReport(input(17, { durationTargetSec: [10, 18] })), /inside the channel boundary/);
});

test('action-reel profile: story-only gates are n/a (never counted as passed or failed)', () => {
  const extra = [{ id: 'S01', name: 'story gate', pass: false, kind: 'measured' as const, detail: 'x', group: 'story' }];
  const story = buildQualityReport(input(30 as number, { extraGates: extra }));
  assert.ok(story.summary.failed.includes('G03') && story.summary.failed.includes('S01'));
  const reel = buildQualityReport(input(30 as number, { extraGates: extra, validationProfile: 'action-reel' }));
  for (const id of [...STORY_ONLY_GATES, 'S01']) {
    const g = reel.gates.find((x) => x.id === id)!;
    assert.equal(g.status, 'n/a', id);
    assert.ok(!reel.summary.failed.includes(id), id);
    assert.ok(reel.summary.notApplicable.includes(id), id);
  }
  assert.equal(reel.summary.total, reel.gates.filter((g) => g.status !== 'n/a').length);
  assert.ok(reel.gates.some((g) => g.id === 'G21' && g.status === 'pass'), 'technical gates still apply');
});

test('action-reel profile downgrades only story-structure findings', () => {
  const e = sample();
  e.shots[e.shots.length - 1].preset = 'wide_environment'; // LOOP (story)
  e.actions[0].duration = 0.3; // IMPOSSIBLE_ACTION (technical)
  const story = validateEpisode(e, lib, { repair: false });
  const reel = validateEpisode(e, lib, { repair: false, profile: 'action-reel' });
  const errs = (v: typeof story) => v.findings.filter((f) => f.severity === 'error').map((f) => f.code);
  assert.ok(errs(story).includes('LOOP') && errs(story).includes('IMPOSSIBLE_ACTION'));
  assert.ok(!errs(reel).includes('LOOP') && errs(reel).includes('IMPOSSIBLE_ACTION'));
  assert.ok(reel.findings.some((f) => f.code === 'LOOP' && f.severity === 'info' && f.message.includes('not applicable')));
  assert.ok(STORY_STRUCTURE_CODES.has('LOOP') && !STORY_STRUCTURE_CODES.has('IMPOSSIBLE_ACTION'));
  assert.throws(() => validateEpisode(e, lib, { profile: 'nope' as never }), /unknown validation profile/);
});
