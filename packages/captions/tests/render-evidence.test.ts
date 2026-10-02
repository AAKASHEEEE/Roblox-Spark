import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProbeResult } from '../../mp4/src/probe.ts';
import { INPUT_MANIFEST_SCHEMA, RENDER_BYTE_LIMITS, assertRuntimePins, canonicalJson, hashFile, manifestDigest, parseInputManifest, parseJsonBytes, readAuthenticatedFile, readInputManifest, readTrustedRenderInputs, sha256Bytes } from '../tools/render-manifest.ts';
import { COMPETITOR_DECODED_FRAMES, COMPARISON_SHEET_RECEIPT_SCHEMA, codecPinIssues, createDecodedFrameReceipt, createSignedPostRenderAttestation, mediaFingerprint, mediaFingerprintDigest, parseComparisonSheetReceipt, parseDecodedFrameReceipt, parseEvidenceReport, postRenderAttestationDigest, representativeFramesDigest, validateDecodedFrameClaims, verifyComparisonSheetCommitment, verifyFilePin, verifyPostRenderAttestation, verifyRenderV2, verifyRepresentativeFrameClaims, type DecodedFrameClaim, type RenderEvidenceReport } from '../tools/verify-render-v2.ts';

const sha = 'a'.repeat(64), git = 'b'.repeat(40);
const manifest = {
  schema: 'blockspark.render-input-manifest/2',
  provenance: 'pre-render-authorized',
  job: { jobId: 'job-1', outputPath: 'evidence/video.mp4', visual: 'vignette', renderProfile: 'review-vertical-540p', evidenceProfile: 'competitor-v2', workerSafe: true },
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
  assert.throws(() => parseInputManifest({ ...manifest, job: { ...manifest.job, workerSafe: false } }), /workerSafe must be true/);
  assert.throws(() => parseInputManifest({ ...manifest, job: Object.fromEntries(Object.entries(manifest.job).filter(([key]) => key !== 'workerSafe')) }), /keys must be exactly/);
});

test('runtime byte mismatch and oversized executable fail before launch', () => {
  const parsed = parseInputManifest(manifest);
  let launched = false;
  assert.throws(() => {
    assertRuntimePins(parsed, { ...parsed.runtime, ffmpegSha256: 'c'.repeat(64) });
    launched = true;
  }, /runtime bytes/);
  assert.equal(launched, false);

  const dir = mkdtempSync(join(tmpdir(), 'captions-runtime-')), executable = join(dir, 'ffmpeg');
  try {
    writeFileSync(executable, 'pinned');
    assert.equal(hashFile(executable, 6, 'FFmpeg').bytes, 6);
    truncateSync(executable, 7);
    assert.throws(() => hashFile(executable, 6, 'FFmpeg'), /FFmpeg exceeds 6 byte limit/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('manifest and lock size caps reject bytes before JSON parsing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'captions-parser-caps-'));
  const manifestPath = join(dir, 'manifest.json'), lockPath = join(dir, 'package-lock.json');
  try {
    writeFileSync(manifestPath, '{}'); truncateSync(manifestPath, RENDER_BYTE_LIMITS.inputManifest + 1);
    assert.throws(() => readInputManifest(manifestPath), /input manifest exceeds .* byte limit/);
    writeFileSync(lockPath, '{}'); truncateSync(lockPath, RENDER_BYTE_LIMITS.packageLock + 1);
    let parses = 0;
    assert.throws(() => { const bytes = readAuthenticatedFile(lockPath, { sha256: sha }, RENDER_BYTE_LIMITS.packageLock, 'package lock'); parses++; parseJsonBytes(bytes, 'package lock'); }, /package lock exceeds .* byte limit/);
    assert.equal(parses, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
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
  assert.throws(() => parseEvidenceReport({ ...report, evidence: [decoded] }), /cannot claim decoded-frame provenance/);
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

    writeFileSync(beatSheetPath, beatSheetBytes);
    truncateSync(storyboardPath, RENDER_BYTE_LIMITS.storyboard + 1);
    assert.throws(authenticateThenParseAndLaunch, /storyboard exceeds .* byte limit/);
    assert.equal(jsonParses, 0); assert.equal(ffmpegCalls, 0);

    writeFileSync(storyboardPath, storyboardBytes);
    truncateSync(voicePath, RENDER_BYTE_LIMITS.voice + 1);
    assert.throws(authenticateThenParseAndLaunch, /voice exceeds .* byte limit/);
    assert.equal(jsonParses, 0); assert.equal(ffmpegCalls, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('replacement output and local reseal cannot reuse an independently signed worker attestation', () => {
  const parsedManifest = parseInputManifest(manifest);
  const outputSha256 = 'c'.repeat(64);
  const frames = COMPETITOR_DECODED_FRAMES.map(({ file, timestampSec }) => ({
    file: `evidence/${file}`, sha256: 'd'.repeat(64), bytes: 100, kind: 'decoded-frame-png' as const,
    timestampSec, outputSha256,
  }));
  const frameOnly = { schema: 'blockspark.render-evidence/3', inputManifest: { file: 'evidence/input.json', sha256: sha }, output: { file: 'evidence/video.mp4', sha256: outputSha256, bytes: 1000 }, media: { sha256: '1'.repeat(64) }, evidence: frames } as RenderEvidenceReport;
  const evidence = [
    ...frames,
    { file: 'evidence/comparison-sheet.jpg', sha256: 'e'.repeat(64), bytes: 100, kind: 'comparison-jpeg' as const, outputSha256, sourceFramesSha256: representativeFramesDigest(frameOnly) },
    { file: 'evidence/verification.json', sha256: 'f'.repeat(64), bytes: 100, kind: 'diagnostics' as const },
  ];
  const report: RenderEvidenceReport = { ...frameOnly, evidence };
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  const signed = createSignedPostRenderAttestation(parsedManifest, report, Buffer.from(privatePem), 'worker-key-1');
  const unkeyedDigest = postRenderAttestationDigest(parsedManifest, report);
  assert.equal(verifyPostRenderAttestation(parsedManifest, report, unkeyedDigest, undefined, undefined), false, 'an artifact-local digest never authenticates a worker');
  assert.equal(verifyPostRenderAttestation(parsedManifest, report, signed, Buffer.from(publicPem), 'worker-key-1'), true);
  assert.equal(verifyRepresentativeFrameClaims(report), true);
  assert.equal(verifyComparisonSheetCommitment(report), true);

  const replacementSha = '2'.repeat(64);
  const locallyResealed: RenderEvidenceReport = {
    ...report,
    output: { ...report.output, sha256: replacementSha },
    evidence: report.evidence.map((pin) => pin.kind === 'decoded-frame-png' ? { ...pin, outputSha256: replacementSha } : pin.kind === 'comparison-jpeg' ? { ...pin, outputSha256: replacementSha } : pin),
  };
  assert.throws(() => postRenderAttestationDigest(parsedManifest, locallyResealed), /comparison sheet not bound/);
  assert.equal(verifyPostRenderAttestation(parsedManifest, locallyResealed, signed, Buffer.from(publicPem), 'worker-key-1'), false);
  assert.equal(verifyPostRenderAttestation(parsedManifest, report, signed, Buffer.from(publicPem), 'wrong-key-id'), false);
  const wrongImage: RenderEvidenceReport = { ...report, evidence: report.evidence.map((pin, index) => index === 0 ? { ...pin, sha256: '9'.repeat(64) } : pin) };
  assert.equal(verifyPostRenderAttestation(parsedManifest, wrongImage, signed, Buffer.from(publicPem), 'worker-key-1'), false);
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
  const comparisonReceipt = {
    schema: COMPARISON_SHEET_RECEIPT_SCHEMA, outputSha256, frames: receipt.frames,
    comparison: { sha256: 'a'.repeat(64), bytes: 123 },
    runtime: { playwrightTreeSha256: 'b'.repeat(64), chromiumSha256: 'c'.repeat(64) },
  };
  assert.equal(parseComparisonSheetReceipt(comparisonReceipt).comparison.bytes, 123);
  assert.throws(() => parseComparisonSheetReceipt({ ...comparisonReceipt, frames: comparisonReceipt.frames.map((frame, index) => index === 0 ? { ...frame, timestampSec: frame.timestampSec + 0.01 } : frame) }), /exactly match.*seek times/);
  assert.throws(() => parseComparisonSheetReceipt({ ...comparisonReceipt, selfApproved: true }), /keys must be exactly/);
});

test('schema /3 strictly pins the Director sidecar while historical schema /2 remains unchanged', () => {
  assert.equal(INPUT_MANIFEST_SCHEMA, 'blockspark.render-input-manifest/3');
  const historical = parseInputManifest(manifest);
  assert.equal(historical.schema, 'blockspark.render-input-manifest/2');
  assert.equal(Object.hasOwn(historical.inputs, 'directorReport'), false);

  const semantic = {
    ...manifest,
    schema: 'blockspark.render-input-manifest/3',
    inputs: { ...manifest.inputs, directorReport: { path: 'inputs/director-report.json', sha256: sha } },
  };
  const parsed = parseInputManifest(semantic);
  assert.deepEqual(parsed.inputs.directorReport, { path: 'inputs/director-report.json', sha256: sha });
  assert.throws(() => parseInputManifest({ ...semantic, inputs: { ...semantic.inputs, directorReport: undefined } }), /manifest\.inputs\.directorReport must be an object/);
  assert.throws(() => parseInputManifest({ ...semantic, inputs: { ...semantic.inputs, directorReport: { ...semantic.inputs.directorReport, extra: true } } }), /keys must be exactly/);
  const handAuthored = parseInputManifest({ ...semantic, inputs: { ...semantic.inputs, directorReport: null } });
  assert.equal(handAuthored.inputs.directorReport, null);
});

test('trusted schema /3 authenticates the complete sidecar batch before parsing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'captions-semantic-sidecar-'));
  const storyboardPath = join(dir, 'storyboard.json'), beatSheetPath = join(dir, 'beats.json');
  const directorReportPath = join(dir, 'director-report.json'), voicePath = join(dir, 'voice.mp3');
  const bytes = {
    storyboard: Buffer.from('{"storyboard":true}'), beatSheet: Buffer.from('{"beats":[]}'),
    directorReport: Buffer.from('{"semanticRequirements":{}}'), voice: Buffer.from('voice'),
  };
  try {
    writeFileSync(storyboardPath, bytes.storyboard); writeFileSync(beatSheetPath, bytes.beatSheet);
    writeFileSync(directorReportPath, bytes.directorReport); writeFileSync(voicePath, bytes.voice);
    const trusted = parseInputManifest({
      ...manifest,
      schema: 'blockspark.render-input-manifest/3',
      inputs: {
        ...manifest.inputs,
        storyboard: { path: 'inputs/storyboard.json', sha256: sha256Bytes(bytes.storyboard) },
        beatSheet: { path: 'inputs/beats.json', sha256: sha256Bytes(bytes.beatSheet) },
        directorReport: { path: 'inputs/director-report.json', sha256: sha256Bytes(bytes.directorReport) },
        voice: { sha256: sha256Bytes(bytes.voice) },
      },
    });
    const paths = { storyboard: storyboardPath, beatSheet: beatSheetPath, directorReport: directorReportPath, voice: voicePath };
    assert.deepEqual(Array.from(readTrustedRenderInputs(trusted, paths).directorReport!), Array.from(bytes.directorReport));
    writeFileSync(directorReportPath, '{"tampered":true}');
    let parses = 0;
    assert.throws(() => { const authenticated = readTrustedRenderInputs(trusted, paths); parses++; parseJsonBytes(authenticated.directorReport!, 'Director report'); }, /Director report SHA-256.*does not match authorized/);
    assert.equal(parses, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
