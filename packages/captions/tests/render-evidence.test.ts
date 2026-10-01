import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProbeResult } from '../../mp4/src/probe.ts';
import { RENDER_BYTE_LIMITS, assertRuntimePins, canonicalJson, manifestDigest, parseInputManifest, parseJsonBytes, readTrustedRenderInputs, sha256Bytes } from '../tools/render-manifest.ts';
import { COMPETITOR_DECODED_FRAMES, codecPinIssues, createDecodedFrameReceipt, mediaFingerprint, mediaFingerprintDigest, parseDecodedFrameReceipt, parseEvidenceReport, postRenderAttestationDigest, validateDecodedFrameClaims, verifyFilePin, verifyPostRenderAttestation, verifyRenderV2, verifyRepresentativeFrameClaims, type DecodedFrameClaim, type RenderEvidenceReport } from '../tools/verify-render-v2.ts';

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
  const decoded = { file: 'evidence/frame-teacher-exit.png', sha256: sha, bytes: 1, kind: 'decoded-frame-png', timestampSec: 3, outputSha256: sha };
  assert.equal(parseEvidenceReport({ ...report, schema: 'blockspark.render-evidence/3', evidence: [decoded] }).evidence[0].kind, 'decoded-frame-png');
  assert.throws(() => parseEvidenceReport({ ...report, evidence: [decoded] }), /cannot claim decoded frames/);
  assert.throws(() => parseEvidenceReport({ ...report, schema: 'blockspark.render-evidence/3', evidence: [{ ...decoded, timestampSec: '3' }] }), /timestampSec is invalid/);
});


test('trusted input batch rejects tampering and oversize bytes before JSON or FFmpeg can run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'captions-trusted-inputs-'));
  const storyboardPath = join(dir, 'storyboard.json'), beatSheetPath = join(dir, 'beats.json'), voicePath = join(dir, 'voice.mp3');
  const storyboardBytes = Buffer.from('{"audio":{"contentHash":"placeholder"}}');
  const beatSheetBytes = Buffer.from('{"beats":[]}');
  const voiceBytes = Buffer.from('approved voice bytes');
  try {
    writeFileSync(storyboardPath, storyboardBytes); writeFileSync(beatSheetPath, beatSheetBytes); writeFileSync(voicePath, voiceBytes);
    const trusted = parseInputManifest({
      ...manifest,
      inputs: {
        ...manifest.inputs,
        storyboard: { ...manifest.inputs.storyboard, sha256: sha256Bytes(storyboardBytes) },
        beatSheet: { ...manifest.inputs.beatSheet, sha256: sha256Bytes(beatSheetBytes) },
        voice: { sha256: sha256Bytes(voiceBytes) },
      },
    });
    let jsonParses = 0, ffmpegCalls = 0;
    const authenticateThenParseAndLaunch = () => {
      const bytes = readTrustedRenderInputs(trusted, { storyboard: storyboardPath, beatSheet: beatSheetPath, voice: voicePath });
      jsonParses++; parseJsonBytes(bytes.storyboard, 'storyboard');
      jsonParses++; parseJsonBytes(bytes.beatSheet, 'BeatSheet');
      ffmpegCalls++;
    };

    writeFileSync(voicePath, 'replacement voice bytes');
    assert.throws(authenticateThenParseAndLaunch, /voice SHA-256.*does not match authorized/);
    assert.equal(jsonParses, 0); assert.equal(ffmpegCalls, 0);

    writeFileSync(voicePath, voiceBytes);
    truncateSync(beatSheetPath, RENDER_BYTE_LIMITS.beatSheet + 1);
    assert.throws(authenticateThenParseAndLaunch, /BeatSheet exceeds .* byte limit/);
    assert.equal(jsonParses, 0); assert.equal(ffmpegCalls, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('replacement output and local reseal cannot reuse an independent post-render attestation', () => {
  const parsedManifest = parseInputManifest(manifest);
  const outputSha256 = 'c'.repeat(64);
  const evidence = [
    ...COMPETITOR_DECODED_FRAMES.map(({ file, timestampSec }) => ({
      file: `evidence/${file}`, sha256: 'd'.repeat(64), bytes: 100, kind: 'decoded-frame-png' as const,
      timestampSec, outputSha256,
    })),
    { file: 'evidence/comparison-sheet.jpg', sha256: 'e'.repeat(64), bytes: 100, kind: 'comparison-jpeg' as const },
    { file: 'evidence/verification.json', sha256: 'f'.repeat(64), bytes: 100, kind: 'diagnostics' as const },
  ];
  const report: RenderEvidenceReport = {
    schema: 'blockspark.render-evidence/3', inputManifest: { file: 'evidence/input.json', sha256: sha },
    output: { file: 'evidence/video.mp4', sha256: outputSha256, bytes: 1000 }, media: { sha256: '1'.repeat(64) }, evidence,
  };
  const independentDigest = postRenderAttestationDigest(parsedManifest, report);
  assert.equal(verifyPostRenderAttestation(parsedManifest, report), false, 'local sealing alone is never an attestation');
  assert.equal(verifyPostRenderAttestation(parsedManifest, report, independentDigest), true);
  assert.equal(verifyRepresentativeFrameClaims(report), true);

  const replacementSha = '2'.repeat(64);
  const locallyResealed: RenderEvidenceReport = {
    ...report,
    output: { ...report.output, sha256: replacementSha },
    evidence: report.evidence.map((pin) => pin.kind === 'decoded-frame-png' ? { ...pin, outputSha256: replacementSha } : pin),
  };
  assert.notEqual(postRenderAttestationDigest(parsedManifest, locallyResealed), independentDigest);
  assert.equal(verifyPostRenderAttestation(parsedManifest, locallyResealed, independentDigest), false);
});

test('decoded-frame claims must bind every committed frame seek to the sealed output', () => {
  const outputSha256 = '3'.repeat(64);
  const report: RenderEvidenceReport = {
    schema: 'blockspark.render-evidence/3', inputManifest: { file: 'evidence/input.json', sha256: sha },
    output: { file: 'evidence/video.mp4', sha256: outputSha256, bytes: 1 }, media: { sha256: sha },
    evidence: COMPETITOR_DECODED_FRAMES.map(({ file, timestampSec }) => ({ file: `evidence/${file}`, sha256: sha, bytes: 1, kind: 'decoded-frame-png', timestampSec, outputSha256 })),
  };
  assert.equal(verifyRepresentativeFrameClaims(report), true);
  const wrongSeek: RenderEvidenceReport = { ...report, evidence: report.evidence.map((pin, index) => index === 0 && pin.kind === 'decoded-frame-png' ? { ...pin, timestampSec: pin.timestampSec + 0.1 } : pin) };
  assert.equal(verifyRepresentativeFrameClaims(wrongSeek), false);
  const historical: RenderEvidenceReport = { ...report, evidence: report.evidence.map(({ file, sha256, bytes }) => ({ file, sha256, bytes, kind: 'frame-png' })) };
  assert.equal(verifyRepresentativeFrameClaims(historical), false);
});


test('replacement output is hash-rejected before the media parser and can never return trusted', () => {
  const root = mkdtempSync(join(tmpdir(), 'captions-replacement-output-'));
  try {
    for (const directory of ['inputs', 'assets', 'evidence']) mkdirSync(join(root, directory), { recursive: true });
    const storyboardBytes = Buffer.from('{"audio":{"contentHash":"' + sha + '"},"script":{"phrases":[]}}');
    const beatSheetBytes = Buffer.from('{"beats":[]}');
    const assetLockBytes = Buffer.from('{}');
    const packageLockBytes = Buffer.from('{"packages":{}}');
    writeFileSync(join(root, 'inputs/storyboard.json'), storyboardBytes);
    writeFileSync(join(root, 'inputs/beats.json'), beatSheetBytes);
    writeFileSync(join(root, 'assets/asset-lock.json'), assetLockBytes);
    writeFileSync(join(root, 'package-lock.json'), packageLockBytes);
    const parsedManifest = parseInputManifest({
      ...manifest,
      source: { ...manifest.source, repository: 'AAKASHEEEE/Roblox-Spark' },
      inputs: {
        ...manifest.inputs,
        storyboard: { path: 'inputs/storyboard.json', sha256: sha256Bytes(storyboardBytes) },
        beatSheet: { path: 'inputs/beats.json', sha256: sha256Bytes(beatSheetBytes) },
        assetLock: { path: 'assets/asset-lock.json', sha256: sha256Bytes(assetLockBytes) },
        packageLock: { path: 'package-lock.json', sha256: sha256Bytes(packageLockBytes) },
      },
    });
    const originalOutput = Buffer.from('original output bytes');
    const report: RenderEvidenceReport = {
      schema: 'blockspark.render-evidence/2',
      inputManifest: { file: 'evidence/input.json', sha256: manifestDigest(parsedManifest) },
      output: { file: 'evidence/video.mp4', sha256: sha256Bytes(originalOutput), bytes: originalOutput.length },
      media: { sha256: sha }, evidence: [],
    };
    writeFileSync(join(root, 'evidence/input.json'), JSON.stringify(parsedManifest));
    writeFileSync(join(root, 'evidence/render-evidence.json'), JSON.stringify(report));
    writeFileSync(join(root, 'evidence/video.mp4'), 'replaced output bytes');
    let parserCalls = 0;
    const result = verifyRenderV2({
      root, reportPath: join(root, 'evidence/render-evidence.json'), recomputeCompositions: false,
      authorizedManifestSha256: manifestDigest(parsedManifest),
      postRenderAttestationSha256: postRenderAttestationDigest(parsedManifest, report),
      probeMedia: () => { parserCalls++; throw new Error('must not parse replacement bytes'); },
    });
    assert.equal(parserCalls, 0);
    assert.equal(result.trusted, false);
    assert.match(result.issues.join('; '), /output SHA-256.*does not match authorized/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('decoded-frame receipt preserves decode-time output binding across delayed sealing', () => {
  const outputSha256 = '4'.repeat(64);
  const claims: DecodedFrameClaim[] = COMPETITOR_DECODED_FRAMES.map(({ file, timestampSec }, index) => ({
    file, timestampSec, sha256: String((index % 6) + 4).repeat(64), bytes: 100 + index, outputSha256,
  }));
  const receipt = createDecodedFrameReceipt(outputSha256, claims);
  const parsed = parseDecodedFrameReceipt(JSON.parse(JSON.stringify(receipt)));
  assert.equal(parsed.outputSha256, outputSha256);
  assert.equal(validateDecodedFrameClaims(outputSha256, parsed.frames.map((frame) => ({ ...frame, outputSha256 }))).size, 7);
  assert.throws(() => validateDecodedFrameClaims('b'.repeat(64), claims), /decoded from a different output/);
  assert.throws(() => parseDecodedFrameReceipt({ ...receipt, localTrusted: true }), /keys must be exactly/);
});