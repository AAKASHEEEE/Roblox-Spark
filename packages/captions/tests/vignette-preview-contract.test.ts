import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const adapter = readFileSync(resolve(root, 'packages/captions/src/preview/vignette-full-page.ts'), 'utf8');
const session = readFileSync(resolve(root, 'packages/captions/src/preview/vignette-render-session.ts'), 'utf8');
const renderFull = readFileSync(resolve(root, 'packages/captions/tools/render-full.ts'), 'utf8');
const sealEvidence = readFileSync(resolve(root, 'packages/captions/tools/seal-render-evidence.ts'), 'utf8');
const webEntry = readFileSync(resolve(root, 'packages/vignette/src/web-entry.ts'), 'utf8');

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

test('review stills and S7 video share the same exact-time Vignette render session', () => {
  assert.match(webEntry, /new VignetteRenderSession/);
  assert.doesNotMatch(webEntry, /new VignetteScene|stageBeatSheet\(|poseAt\(|registerRuntimeLibrary\(/);
  assert.match(webEntry, /session\.frame\(t\)/);
  assert.match(webEntry, /session\.render\(frame\)/);
});


test('trusted raw inputs are batch-authenticated before parsing or native decode', () => {
  const authenticate = renderFull.indexOf('readTrustedRenderInputs(trustedManifest');
  const authenticateLocks = renderFull.indexOf('const trustedLockBytes = trustedManifest');
  const storyboardParse = renderFull.indexOf("parseJsonBytes(inputBytes.storyboard, 'storyboard')");
  const containerParse = renderFull.indexOf("checkContainer(voiceBytes, 'mp3')");
  const ffmpegLaunch = renderFull.indexOf('const raw = execFileSync(ffmpeg');
  assert.ok(authenticate >= 0 && authenticate < storyboardParse, 'scheduler pins must authenticate inputs before storyboard JSON parsing');
  assert.ok(authenticateLocks >= 0 && authenticateLocks < storyboardParse, 'scheduler pins must authenticate asset/package locks before any JSON parsing');
  assert.ok(authenticateLocks < containerParse && authenticateLocks < ffmpegLaunch, 'locks must authenticate before native parsers and FFmpeg');
  assert.ok(authenticate < containerParse, 'scheduler pins must authenticate voice before container parsing');
  assert.ok(authenticate < ffmpegLaunch, 'scheduler pins must authenticate all inputs before FFmpeg');
  assert.match(renderFull, /input: Buffer\.from\(voiceBytes\)/, 'trusted FFmpeg must consume the authenticated bytes, not reopen the upload path');
});

test('trusted media tools use exact authenticated paths and evidence comes from decoded output', () => {
  assert.match(renderFull, /requireFromHere\(playwrightCore\)/);
  assert.match(renderFull, /executablePath: chromium/);
  assert.match(renderFull, /execFileSync\(ffprobe/);
  assert.doesNotMatch(renderFull, /__s7v\.framePng/);
  const muxed = renderFull.indexOf('writeFileSync(mp4Path, mp4)');
  const committedDecodedFrame = renderFull.indexOf('writeFileSync(join(outDir, claim.file), decodedBytes)');
  const receipt = renderFull.indexOf('createDecodedFrameReceipt(mp4Sha, decodedFrameClaims)');
  assert.ok(muxed >= 0 && muxed < committedDecodedFrame, 'representative evidence must be copied from post-mux decoded frames');
  assert.ok(committedDecodedFrame < receipt, 'decode-time output and frame hashes must be persisted after committed frame bytes');
  assert.match(sealEvidence, /decodedFrameReceiptPath: receiptPath/, 'delayed sealing must consume the worker-owned decoded-frame receipt');
});