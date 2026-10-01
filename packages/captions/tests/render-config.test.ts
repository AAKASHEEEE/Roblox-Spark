import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRenderSelection } from '../tools/render-config.ts';

test('generic visual mode is independent from fixture evidence policy', () => {
  const generic = resolveRenderSelection({ visual: 'vignette', profile: 'production-vertical-1080p', evidenceProfile: 'none' });
  assert.equal(generic.visual, 'vignette');
  assert.equal(generic.profile.width, 1080);
  assert.equal(generic.evidenceProfile, 'none');

  const fixture = resolveRenderSelection({ visual: 'vignette', profile: 'review-vertical-540p', evidenceProfile: 'competitor-v2' });
  assert.equal(fixture.evidenceProfile, 'competitor-v2');
});

test('fixture evidence cannot silently select a visual or final profile', () => {
  assert.throws(() => resolveRenderSelection({ visual: 'narrated', evidenceProfile: 'competitor-v2' }), /requires --visual vignette/);
  assert.throws(() => resolveRenderSelection({ visual: 'vignette', profile: 'production-vertical-1080p', evidenceProfile: 'competitor-v2' }), /review-vertical-540p/);
});

test('profile dimensions, fps, and bitrates cannot be redefined by flags', () => {
  assert.throws(() => resolveRenderSelection({ profile: 'review-vertical-540p', width: '1080' }), /conflicts with immutable profile/);
  assert.throws(() => resolveRenderSelection({ profile: 'review-vertical-540p', fps: '60' }), /conflicts with immutable profile/);
  assert.throws(() => resolveRenderSelection({ profile: 'review-vertical-540p', bitrate: '1' }), /conflicts with immutable profile/);
});
