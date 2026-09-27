// E2E smoke: the action reels cover every implemented action except hover, validate under the action-reel profile,
// and load + render in the headless engine under the default motion profile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REELS } from '../../scripts/action-reel.ts';
import { ACTIONS } from '../../packages/schema/src/episode.ts';
import { validateEpisode } from '../../packages/pipeline/src/validate.ts';
import { openRenderPage, hashEpisodeFrames } from '../../scripts/golden.ts';
import { lib } from '../helpers.ts';

test('reels exercise all implemented actions (hover excluded: no floating rig)', () => {
  const covered = new Set(REELS.flatMap((r) => r.segs.map((s) => s.action)));
  assert.deepEqual(ACTIONS.filter((a) => !covered.has(a)), ['hover']);
});

test('reels validate under action-reel and render deterministically', { timeout: 300000 }, async () => {
  const { reelEpisodeFor } = await import('../../scripts/action-reel.ts');
  const { page, close } = await openRenderPage();
  try {
    for (const r of REELS) {
      const ep = reelEpisodeFor(r);
      const v = validateEpisode(ep, lib, { repair: false, profile: 'action-reel' });
      assert.ok(v.ok, `${r.name}: ${JSON.stringify(v.findings.filter((f) => f.severity === 'error').slice(0, 3))}`);
      assert.equal(validateEpisode(ep, lib, { repair: false }).ok, false, `${r.name} must NOT pass story-episode validation`);
      const a = await hashEpisodeFrames(page, ep, lib, [0, 45, 90], [270, 480]);
      const b = await hashEpisodeFrames(page, ep, lib, [90, 45, 0], [270, 480]);
      assert.deepEqual(new Map(a), new Map(b), r.name);
    }
  } finally { await close(); }
});
