import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProbeResult } from '../../mp4/src/probe.ts';
import { assertRuntimePins, canonicalJson, parseInputManifest, sha256Bytes } from '../tools/render-manifest.ts';
import { codecPinIssues, mediaFingerprint, mediaFingerprintDigest, parseEvidenceReport, verifyFilePin } from '../tools/verify-render-v2.ts';

const sha = 'a'.repeat(64), git = 'b'.repeat(40);
const manifest = {
  schema: 'blockspark.render-input-manifest/2',
  provenance: 'pre-render-authorized',
  job: { jobId: 'job-1', outputPath: 'evidence/video.mp4', visual: 'vignette', renderProfile: 'review-vertical-540p', evidenceProfile: 'competitor-v2' },
  source: { repository: 'owner/repo', commitSha: git, treeSha: git, baseSha: git },
  inputs: {
    storyboard: { path: 'inputs/storyboard.json', sha256: sha }, beatSheet: { path: 'inputs/beats.json', sha256: sha },
    voice: { sha256: sha }, solvedCompositions: { sha256: sha, count: 2 },
    assetLock: { path: 'assets/asset-lock.json', sha256: sha }, packageLock: { path: 'package-lock.json', sha256: sha },
  },
  tools: { node: 'v22.23.3', typescript: '7.0.2', playwrightCore: '1.2.3', chromium: '123.0.0.0', ffmpegStatic: '5.3.0', ffprobeStatic: '3.1.0', rendererCodec: 'avc1.64001f' },
  runtime: { visualEntry: 'dist/packages/captions/src/preview/vignette-full-page.js', bundleTreeSha256: sha, ffmpegSha256: sha, ffprobeSha256: sha, playwrightTreeSha256: sha, chromiumSha256: sha },
};

test('trusted input manifest is strict and rejects traversal/unknown self-approval fields', () => {
  assert.equal(parseInputManifest(manifest).inputs.solvedCompositions.count, 2);
  assert.throws(() => parseInputManifest({ ...manifest, approval: { source: '.agents' } }), /keys must be exactly/);
  assert.throws(() => parseInputManifest({ ...manifest, inputs: { ...manifest.inputs, storyboard: { ...manifest.inputs.storyboard, path: '../secret' } } }), /normalized repository-relative path/);
});

test('runtime byte mismatch fails before a caller can launch an executable', () => {
  const parsed = parseInputManifest(manifest);
  let launched = false;
  assert.throws(() => {
    assertRuntimePins(parsed, { ...parsed.runtime, ffmpegSha256: 'c'.repeat(64) });
    launched = true;
  }, /runtime bytes/);
  assert.equal(launched, false);
});

test('canonical manifest hashing is independent of object key insertion order', () => {
  assert.equal(canonicalJson({ b: 2, a: 1 }), canonicalJson({ a: 1, b: 2 }));
  assert.equal(sha256Bytes(canonicalJson({ b: 2, a: 1 })), sha256Bytes(canonicalJson({ a: 1, b: 2 })));
});

test('independent file pinning rejects byte tampering instead of trusting report claims', () => {
  const dir = mkdtempSync(join(tmpdir(), 'captions-evidence-')), file = join(dir, 'frame.png');
  try {
    writeFileSync(file, 'original bytes');
    const pin = { sha256: sha256Bytes('original bytes'), bytes: 14 };
    assert.deepEqual(verifyFilePin(file, pin), []);
    writeFileSync(file, 'tampered bytes');
    assert.match(verifyFilePin(file, pin).join('; '), /byte count|SHA-256/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('media fingerprint is recomputed from parser output and changes on media tampering', () => {
  const probe: ProbeResult = {
    tool: 'builtin', format: { format_name: 'mp4', duration: '69.167', size: '1', faststart: true }, notes: [],
    streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264', profile: 'High', level: 31, width: 540, height: 960, pix_fmt: 'yuv420p', r_frame_rate: '30/1', avg_frame_rate: '30/1', nb_frames: '2075', duration: '69.166667' },
      { index: 1, codec_type: 'audio', codec_name: 'aac', profile: 'LC', sample_rate: '48000', channels: 2, duration: '69.167' },
    ],
  };
  const good = mediaFingerprintDigest(mediaFingerprint(probe));
  const changed = mediaFingerprintDigest(mediaFingerprint({ ...probe, format: { ...probe.format, faststart: false } }));
  assert.notEqual(good, changed);
  assert.deepEqual(codecPinIssues(probe, 'avc1.64001f'), []);
  const mainProfile: ProbeResult = { ...probe, streams: [{ ...probe.streams[0], profile: 'Main', level: 30 }, probe.streams[1]] };
  assert.match(codecPinIssues(mainProfile, 'avc1.64001f').join('; '), /High profile.*level 3\.1/);
});

test('evidence report parser rejects omitted, extra, and unsafe fields', () => {
  const report = { schema: 'blockspark.render-evidence/2', inputManifest: { file: 'evidence/input.json', sha256: sha }, output: { file: 'evidence/video.mp4', sha256: sha, bytes: 1 }, media: { sha256: sha }, evidence: [] };
  assert.equal(parseEvidenceReport(report).output.bytes, 1);
  assert.throws(() => parseEvidenceReport({ ...report, trusted: true }), /keys must be exactly/);
  assert.throws(() => parseEvidenceReport({ ...report, output: { ...report.output, file: '/tmp/video.mp4' } }), /normalized repository-relative path/);
});
