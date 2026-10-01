import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const adapter = readFileSync(resolve(root, 'packages/captions/src/preview/vignette-full-page.ts'), 'utf8');
const session = readFileSync(resolve(root, 'packages/captions/src/preview/vignette-render-session.ts'), 'utf8');
const renderFull = readFileSync(resolve(root, 'packages/captions/tools/render-full.ts'), 'utf8');

test('S7 vignette adapter consumes the neutral shared render session', () => {
  assert.match(adapter, /new VignetteRenderSession/);
  assert.doesNotMatch(adapter, /import .*\b(?:stageBeatSheet|registerRuntimeLibrary|poseAt)\b/);
  assert.doesNotMatch(adapter, /new VignetteScene\(/);
  assert.match(session, /validateBeatSheet\(|stageBeatSheet\(|poseAt\(/);
});

test('graphic anchors are explicit-time and placement uses the final VFX frame camera', () => {
  assert.doesNotMatch(adapter, /currentT/);
  assert.match(adapter, /frameAt\(t, vfx\)/);
  assert.match(adapter, /anchorTime/);
  assert.match(adapter, /project\(anchorFrame\.camera/);
  assert.match(session, /applyZoom\(applyShake/);
});

test('trusted runtime bytes are authorized before any selected media executable runs', () => {
  const authorize = renderFull.indexOf('assertRuntimePins(trustedManifest, authorizedRuntime)');
  const ffmpegLaunch = renderFull.indexOf("const raw = execFileSync(ffmpeg");
  const chromiumLaunch = renderFull.indexOf("const chromiumBanner = execFileSync(checkedPaths.chromium");
  assert.ok(authorize >= 0 && authorize < ffmpegLaunch, 'FFmpeg must not run before runtime byte authorization');
  assert.ok(authorize < chromiumLaunch, 'Chromium must not run before runtime byte authorization');
});