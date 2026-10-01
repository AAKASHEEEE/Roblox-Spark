import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { loadLibrary } from '../../../apps/render-worker/lib/library.ts';
import { checkProductionProfile, probeBuiltin, type ProbeResult, type ProductionSpec } from '../../mp4/src/probe.ts';
import { ensureHeadlessCanvas } from '../../vignette/src/headless.ts';
import { runVignette } from '../../vignette/src/pipeline.ts';
import { assertCompositionTimeline } from '../src/preview/composition.ts';
import { COMPETITOR_EVIDENCE_FILES, RENDER_PROFILES } from './render-config.ts';
import { EVIDENCE_REPORT_SCHEMA, canonicalJson, hashFile, manifestDigest, packageVersion, readInputManifest, safeManifestPath, sha256Bytes, solvedCompositionsDigest, type RenderInputManifest } from './render-manifest.ts';
import { isPathInside, policyRealpath } from './render-paths.ts';

const SHA256 = /^[a-f0-9]{64}$/;

export interface EvidenceFilePin { file: string; sha256: string; bytes: number; kind: 'frame-png' | 'comparison-jpeg' | 'diagnostics' }
export interface RenderEvidenceReport {
  schema: typeof EVIDENCE_REPORT_SCHEMA;
  inputManifest: { file: string; sha256: string };
  output: { file: string; sha256: string; bytes: number };
  media: { sha256: string };
  evidence: EvidenceFilePin[];
}
export interface MediaFingerprint {
  container: 'mp4';
  fastStart: boolean;
  durationSec: number;
  video: { codec: string; profile: string; width: number; height: number; pixelFormat: string; frameRate: string; frames: number; durationSec: number };
  audio: { codec: string; profile: string; sampleRate: number; channels: number; durationSec: number };
}
export interface V2VerificationResult {
  /** Byte/media/input integrity checks passed. This is not the same as trusted provenance. */
  ok: boolean;
  trusted: boolean;
  complete: boolean;
  provenance?: RenderInputManifest['provenance'];
  sourceExactRecompute: boolean;
  authorizationVerified: boolean;
  issues: string[];
  warnings: string[];
  manifestSha256?: string;
  outputSha256?: string;
  mediaSha256?: string;
  voiceBytesVerified: boolean;
  evidenceVerified: number;
  media?: MediaFingerprint;
}

function record(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const r = value as Record<string, unknown>, actual = Object.keys(r).sort(), expected = [...keys].sort();
  if (actual.join('\0') !== expected.join('\0')) throw new Error(`${label} keys must be exactly ${expected.join(', ')}`);
  return r;
}
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${label} must be a non-empty string`);
  return value;
}
function digest(value: unknown, label: string): string {
  const d = text(value, label);
  if (!SHA256.test(d)) throw new Error(`${label} must be a lowercase SHA-256`);
  return d;
}
function count(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label} must be a non-negative integer`);
  return Number(value);
}

export function parseEvidenceReport(value: unknown): RenderEvidenceReport {
  const root = record(value, 'evidence report', ['schema', 'inputManifest', 'output', 'media', 'evidence']);
  if (root.schema !== EVIDENCE_REPORT_SCHEMA) throw new Error(`unsupported evidence report schema '${String(root.schema)}'`);
  const manifest = record(root.inputManifest, 'evidence report.inputManifest', ['file', 'sha256']);
  const output = record(root.output, 'evidence report.output', ['file', 'sha256', 'bytes']);
  const media = record(root.media, 'evidence report.media', ['sha256']);
  if (!Array.isArray(root.evidence)) throw new Error('evidence report.evidence must be an array');
  const evidence = root.evidence.map((entry, index) => {
    const pin = record(entry, `evidence report.evidence[${index}]`, ['file', 'sha256', 'bytes', 'kind']);
    if (pin.kind !== 'frame-png' && pin.kind !== 'comparison-jpeg' && pin.kind !== 'diagnostics') throw new Error(`evidence report.evidence[${index}].kind is invalid`);
    return { file: safeManifestPath(pin.file, `evidence report.evidence[${index}].file`), sha256: digest(pin.sha256, `evidence report.evidence[${index}].sha256`), bytes: count(pin.bytes, `evidence report.evidence[${index}].bytes`), kind: pin.kind } as EvidenceFilePin;
  });
  return {
    schema: EVIDENCE_REPORT_SCHEMA,
    inputManifest: { file: safeManifestPath(manifest.file, 'evidence report.inputManifest.file'), sha256: digest(manifest.sha256, 'evidence report.inputManifest.sha256') },
    output: { file: safeManifestPath(output.file, 'evidence report.output.file'), sha256: digest(output.sha256, 'evidence report.output.sha256'), bytes: count(output.bytes, 'evidence report.output.bytes') },
    media: { sha256: digest(media.sha256, 'evidence report.media.sha256') }, evidence,
  };
}

export function mediaFingerprint(probe: ProbeResult): MediaFingerprint {
  const video = probe.streams.find((s) => s.codec_type === 'video');
  const audio = probe.streams.find((s) => s.codec_type === 'audio');
  if (!video || !audio) throw new Error('media must have one video and one audio stream');
  return {
    container: 'mp4', fastStart: probe.format.faststart, durationSec: Number(probe.format.duration),
    video: {
      codec: video.codec_name, profile: video.profile ?? '', width: video.width ?? 0, height: video.height ?? 0,
      pixelFormat: video.pix_fmt ?? '', frameRate: video.r_frame_rate ?? '', frames: Number(video.nb_frames ?? 0), durationSec: Number(video.duration),
    },
    audio: {
      codec: audio.codec_name, profile: audio.profile ?? '', sampleRate: Number(audio.sample_rate ?? 0),
      channels: audio.channels ?? 0, durationSec: Number(audio.duration),
    },
  };
}
export const mediaFingerprintDigest = (fingerprint: MediaFingerprint): string => sha256Bytes(canonicalJson(fingerprint));

export function codecPinIssues(probe: ProbeResult, codec: RenderInputManifest['tools']['rendererCodec']): string[] {
  const video = probe.streams.filter((stream) => stream.codec_type === 'video');
  const levels: Record<RenderInputManifest['tools']['rendererCodec'], number> = { 'avc1.64001f': 31, 'avc1.640028': 40 };
  const expectedLevel = levels[codec];
  if (!expectedLevel) return [`unsupported renderer codec pin ${codec}`];
  if (video.length !== 1) return [`codec pin requires exactly one video stream, got ${video.length}`];
  const stream = video[0], issues: string[] = [];
  if (stream.codec_name !== 'h264') issues.push(`codec pin requires h264, got ${stream.codec_name}`);
  if (stream.profile !== 'High') issues.push(`codec pin requires H.264 High profile, got ${stream.profile ?? 'missing'}`);
  if (stream.level !== expectedLevel) issues.push(`codec pin requires H.264 level ${(expectedLevel / 10).toFixed(1)}, got ${stream.level ?? 'missing'}`);
  return issues;
}

export function verifyFilePin(path: string, expected: { sha256: string; bytes?: number }): string[] {
  if (!existsSync(path)) return [`missing file: ${path}`];
  const actual = hashFile(path), issues: string[] = [];
  if (expected.bytes !== undefined && actual.bytes !== expected.bytes) issues.push(`${path}: byte count ${actual.bytes} != ${expected.bytes}`);
  if (actual.sha256 !== expected.sha256) issues.push(`${path}: SHA-256 ${actual.sha256} != ${expected.sha256}`);
  return issues;
}

function resolvePinned(root: string, relativePath: string, label: string): string {
  safeManifestPath(relativePath, label);
  const path = policyRealpath(resolve(root, relativePath));
  if (!isPathInside(root, path)) throw new Error(`${label} escapes the repository`);
  return path;
}

function profileSpec(manifest: RenderInputManifest): ProductionSpec {
  const p = RENDER_PROFILES[manifest.job.renderProfile];
  return {
    width: p.width, height: p.height, fps: `${p.fps}/1`, videoCodec: 'h264', pixFmt: 'yuv420p',
    audioCodec: 'aac', audioProfile: 'LC', sampleRate: 48_000, channels: 2,
    maxAvDriftSec: 1 / p.fps, durationRange: manifest.job.evidenceProfile === 'competitor-v2' ? [69, 69.2] : [...p.durationRange],
  };
}

function verifyGitPins(root: string, manifest: RenderInputManifest): { issues: string[]; sourceExact: boolean } {
  const issues: string[] = [];
  let sourceExact = false;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (manifest.source.repository !== 'AAKASHEEEE/Roblox-Spark') issues.push(`unexpected source repository ${manifest.source.repository}`);
  try {
    const tree = git('rev-parse', `${manifest.source.commitSha}^{tree}`);
    if (tree !== manifest.source.treeSha) issues.push(`source tree ${tree} != manifest ${manifest.source.treeSha}`);
    const base = git('rev-parse', manifest.source.baseSha);
    if (base !== manifest.source.baseSha) issues.push(`base SHA resolves to ${base}`);
    try { git('merge-base', '--is-ancestor', manifest.source.baseSha, manifest.source.commitSha); }
    catch { issues.push('manifest source commit is not descended from its base SHA'); }
    sourceExact = git('rev-parse', 'HEAD') === manifest.source.commitSha && git('status', '--porcelain') === '';
  } catch (error) { issues.push(`cannot verify pinned git objects: ${error instanceof Error ? error.message : String(error)}`); }
  return { issues, sourceExact };
}

function verifyPinnedBlob(root: string, manifest: RenderInputManifest, path: string, expectedSha256: string): string[] {
  try {
    const bytes = execFileSync('git', ['show', `${manifest.source.commitSha}:${path}`], { cwd: root, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }) as Buffer;
    const actual = sha256Bytes(bytes);
    return actual === expectedSha256 ? [] : [`pinned source blob ${path} has SHA-256 ${actual}, expected ${expectedSha256}`];
  } catch (error) { return [`cannot read pinned source blob ${path}: ${error instanceof Error ? error.message : String(error)}`]; }
}

export interface BuildEvidenceReportOptions {
  root: string;
  inputManifestPath: string;
  outputPath: string;
  evidenceDir: string;
}

/** Seal already-produced artifacts. This performs no render and never copies media. */
export function buildEvidenceReport(options: BuildEvidenceReportOptions): RenderEvidenceReport {
  const root = policyRealpath(options.root), manifestPath = policyRealpath(options.inputManifestPath);
  const outputPath = policyRealpath(options.outputPath), evidenceDir = policyRealpath(options.evidenceDir);
  for (const [label, path] of [['input manifest', manifestPath], ['output', outputPath], ['evidence directory', evidenceDir]] as const) {
    if (!isPathInside(root, path)) throw new Error(`${label} escapes the repository`);
  }
  const manifest = readInputManifest(manifestPath);
  if (manifest.job.visual !== 'vignette' || manifest.job.evidenceProfile !== 'competitor-v2') throw new Error('only competitor-v2 Vignette artifacts can use this evidence schema');
  if (relative(root, outputPath).split('\\').join('/') !== manifest.job.outputPath) throw new Error('output path does not match the authorized manifest job');
  const output = hashFile(outputPath), bytes = new Uint8Array(readFileSync(outputPath));
  const probe = probeBuiltin(bytes), mediaProblems = [
    ...checkProductionProfile(probe, profileSpec(manifest)).errors,
    ...codecPinIssues(probe, manifest.tools.rendererCodec),
  ];
  if (mediaProblems.length) throw new Error(`output does not match pinned media profile: ${mediaProblems.join('; ')}`);
  const names = [...COMPETITOR_EVIDENCE_FILES, 'verification.json'];
  const evidence: EvidenceFilePin[] = names.map((name) => {
    const path = join(evidenceDir, name), pin = hashFile(path);
    return { file: relative(root, path), ...pin, kind: name.endsWith('.png') ? 'frame-png' : name.endsWith('.jpg') ? 'comparison-jpeg' : 'diagnostics' } as EvidenceFilePin;
  });
  return {
    schema: EVIDENCE_REPORT_SCHEMA,
    inputManifest: { file: relative(root, manifestPath), sha256: manifestDigest(manifest) },
    output: { file: relative(root, outputPath), ...output },
    media: { sha256: mediaFingerprintDigest(mediaFingerprint(probe)) },
    evidence,
  };
}

export interface VerifyV2Options {
  root: string;
  reportPath: string;
  voicePath?: string;
  /** Scheduler-owned expected digest; required before provenance can be called trusted. */
  authorizedManifestSha256?: string;
  /** Tests may inject an independent parser; production uses the deterministic built-in MP4 parser. */
  probeMedia?: (bytes: Uint8Array) => ProbeResult;
  /** Tests of hash/path behavior may disable the expensive deterministic camera solve. */
  recomputeCompositions?: boolean;
}

/**
 * Independent verifier: verification.json is never consulted for truth. Every declared byte hash, media property,
 * tracked input, composition solve, and evidence image is recomputed from the artifact and pinned source inputs.
 */
export function verifyRenderV2(options: VerifyV2Options): V2VerificationResult {
  const root = policyRealpath(options.root), reportPath = policyRealpath(options.reportPath), issues: string[] = [], warnings: string[] = [];
  let voiceBytesVerified = false, evidenceVerified = 0, sourceExactRecompute = false, authorizationVerified = false, runtimePinsComplete = false;
  let report: RenderEvidenceReport;
  try {
    if (!isPathInside(root, reportPath)) throw new Error('evidence report escapes the repository');
    report = parseEvidenceReport(JSON.parse(readFileSync(reportPath, 'utf8')));
  } catch (error) {
    return { ok: false, trusted: false, complete: false, sourceExactRecompute, authorizationVerified, issues: [`cannot read evidence report: ${error instanceof Error ? error.message : String(error)}`], warnings, voiceBytesVerified, evidenceVerified };
  }

  let manifest: RenderInputManifest;
  let manifestSha256: string | undefined;
  try {
    const manifestPath = resolvePinned(root, report.inputManifest.file, 'input manifest path');
    manifest = readInputManifest(manifestPath);
    manifestSha256 = manifestDigest(manifest);
    if (manifestSha256 !== report.inputManifest.sha256) issues.push(`input manifest SHA-256 ${manifestSha256} != report ${report.inputManifest.sha256}`);
  } catch (error) {
    return { ok: false, trusted: false, complete: false, sourceExactRecompute, authorizationVerified, issues: [`cannot verify input manifest: ${error instanceof Error ? error.message : String(error)}`], warnings, voiceBytesVerified, evidenceVerified };
  }

  authorizationVerified = options.authorizedManifestSha256 === manifestSha256;
  if (options.authorizedManifestSha256 && !authorizationVerified) issues.push('scheduler-authorized manifest digest does not match the evidence manifest');
  if (!options.authorizedManifestSha256) warnings.push('no scheduler-owned manifest digest supplied; authorization is not verified');
  if (manifest.provenance === 'retroactive-integrity-seal') warnings.push('artifact was retroactively sealed; integrity can be checked but pre-render authorization is not claimed');
  if (manifest.job.visual !== 'vignette' || manifest.job.evidenceProfile !== 'competitor-v2') issues.push('v2 evidence requires vignette + competitor-v2 manifest job');
  if (report.output.file !== manifest.job.outputPath) issues.push(`evidence output ${report.output.file} does not match manifest job output ${manifest.job.outputPath}`);
  const gitPins = verifyGitPins(root, manifest);
  issues.push(...gitPins.issues); sourceExactRecompute = gitPins.sourceExact;
  if (!sourceExactRecompute) warnings.push('composition recomputation uses a checkout other than the clean pinned source; pinned blobs are checked separately');

  const pinnedInputs: Array<[string, { path: string; sha256: string }]> = [
    ['storyboard', manifest.inputs.storyboard], ['beat sheet', manifest.inputs.beatSheet],
    ['asset lock', manifest.inputs.assetLock], ['package lock', manifest.inputs.packageLock],
  ];
  for (const [label, pin] of pinnedInputs) {
    try {
      issues.push(...verifyFilePin(resolvePinned(root, pin.path, `${label} path`), pin).map((x) => `${label}: ${x}`));
      issues.push(...verifyPinnedBlob(root, manifest, pin.path, pin.sha256).map((x) => `${label}: ${x}`));
    }
    catch (error) { issues.push(`${label}: ${error instanceof Error ? error.message : String(error)}`); }
  }

  let storyboard: any;
  try {
    storyboard = JSON.parse(readFileSync(resolvePinned(root, manifest.inputs.storyboard.path, 'storyboard path'), 'utf8'));
    if (storyboard?.audio?.contentHash !== manifest.inputs.voice.sha256) issues.push('storyboard audio hash does not match the manifest voice hash');
  } catch (error) { issues.push(`cannot inspect storyboard voice pin: ${error instanceof Error ? error.message : String(error)}`); }
  if (options.voicePath) {
    try {
      const actual = hashFile(options.voicePath).sha256;
      voiceBytesVerified = true;
      if (actual !== manifest.inputs.voice.sha256) issues.push(`voice SHA-256 ${actual} != manifest ${manifest.inputs.voice.sha256}`);
    } catch (error) { issues.push(`cannot verify voice bytes: ${error instanceof Error ? error.message : String(error)}`); }
  } else warnings.push('approved voice bytes were not supplied; only the storyboard/manifest voice-hash chain was checked');

  try {
    const packageLock = JSON.parse(readFileSync(resolvePinned(root, manifest.inputs.packageLock.path, 'package lock path'), 'utf8'));
    if (packageVersion(packageLock, 'typescript') !== manifest.tools.typescript) issues.push('TypeScript tool pin differs from package-lock');
    if (packageVersion(packageLock, 'playwright-core') !== manifest.tools.playwrightCore) issues.push('Playwright tool pin differs from package-lock');
    if (packageVersion(packageLock, 'ffmpeg-static') !== manifest.tools.ffmpegStatic) issues.push('FFmpeg tool pin differs from package-lock');
    if (packageVersion(packageLock, 'ffprobe-static') !== manifest.tools.ffprobeStatic) issues.push('FFprobe tool pin differs from package-lock');
  } catch (error) { issues.push(`cannot verify exact tool pins: ${error instanceof Error ? error.message : String(error)}`); }
  const expectedEntry = manifest.job.visual === 'vignette'
    ? 'dist/packages/captions/src/preview/vignette-full-page.js'
    : 'dist/packages/captions/src/preview/stills-page.js';
  if (manifest.runtime.visualEntry !== expectedEntry) issues.push(`runtime entry ${manifest.runtime.visualEntry} does not match ${manifest.job.visual}`);
  runtimePinsComplete = [manifest.runtime.bundleTreeSha256, manifest.runtime.ffmpegSha256, manifest.runtime.ffprobeSha256, manifest.runtime.playwrightTreeSha256, manifest.runtime.chromiumSha256].every((x) => x !== null);
  if (manifest.provenance === 'pre-render-authorized' && !runtimePinsComplete) issues.push('pre-render-authorized manifest is missing content hashes for runtime bytes');
  if (!runtimePinsComplete) warnings.push('historical manifest does not contain emitted bundle/executable byte hashes');

  if (options.recomputeCompositions !== false) {
    try {
      ensureHeadlessCanvas();
      const sheet = JSON.parse(readFileSync(resolvePinned(root, manifest.inputs.beatSheet.path, 'beat sheet path'), 'utf8'));
      const library = loadLibrary({ root });
      if (library.errors.length) issues.push(`asset library does not match lock: ${library.errors.join('; ')}`);
      else {
        const run = runVignette(sheet, library, { phrases: storyboard?.script?.phrases });
        assertCompositionTimeline(run.compositions);
        const actual = solvedCompositionsDigest(run.compositions);
        if (run.compositions.length !== manifest.inputs.solvedCompositions.count) issues.push(`solved composition count ${run.compositions.length} != ${manifest.inputs.solvedCompositions.count}`);
        if (actual !== manifest.inputs.solvedCompositions.sha256) issues.push(`solved compositions SHA-256 ${actual} != ${manifest.inputs.solvedCompositions.sha256}`);
      }
    } catch (error) { issues.push(`cannot recompute solved compositions: ${error instanceof Error ? error.message : String(error)}`); }
  }

  let outputSha256: string | undefined, mediaSha256: string | undefined, media: MediaFingerprint | undefined;
  try {
    const outputPath = resolvePinned(root, report.output.file, 'output path');
    const outputPinIssues = verifyFilePin(outputPath, report.output);
    issues.push(...outputPinIssues.map((x) => `output: ${x}`));
    if (manifest.provenance === 'retroactive-integrity-seal') issues.push(...verifyPinnedBlob(root, manifest, report.output.file, report.output.sha256).map((x) => `output: ${x}`));
    if (existsSync(outputPath)) {
      const bytes = new Uint8Array(readFileSync(outputPath));
      outputSha256 = sha256Bytes(bytes);
      const probe = (options.probeMedia ?? probeBuiltin)(bytes);
      const production = checkProductionProfile(probe, profileSpec(manifest));
      if (!production.ok) issues.push(...production.errors.map((x) => `media: ${x}`));
      issues.push(...codecPinIssues(probe, manifest.tools.rendererCodec).map((x) => `media: ${x}`));
      media = mediaFingerprint(probe); mediaSha256 = mediaFingerprintDigest(media);
      if (mediaSha256 !== report.media.sha256) issues.push(`media fingerprint SHA-256 ${mediaSha256} != report ${report.media.sha256}`);
    }
  } catch (error) { issues.push(`cannot independently verify output media: ${error instanceof Error ? error.message : String(error)}`); }

  const reportDir = dirname(reportPath);
  const requiredEvidence = new Set<string>([...COMPETITOR_EVIDENCE_FILES, 'verification.json']);
  const seen = new Set<string>();
  for (const pin of report.evidence) {
    try {
      const path = resolvePinned(root, pin.file, 'evidence path');
      if (!isPathInside(reportDir, path)) throw new Error('evidence file is outside the evidence report directory');
      const name = pin.file.split('/').at(-1)!;
      if (!requiredEvidence.has(name)) throw new Error(`unexpected evidence file ${name}`);
      if (seen.has(name)) throw new Error(`duplicate evidence file ${name}`);
      seen.add(name);
      const pinIssues = verifyFilePin(path, pin);
      issues.push(...pinIssues.map((x) => `evidence: ${x}`));
      if (manifest.provenance === 'retroactive-integrity-seal') issues.push(...verifyPinnedBlob(root, manifest, pin.file, pin.sha256).map((x) => `evidence: ${x}`));
      if (!pinIssues.length) {
        const bytes = readFileSync(path);
        if (pin.kind === 'frame-png' && !bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) issues.push(`${name}: expected PNG bytes`);
        if (pin.kind === 'comparison-jpeg' && !(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9)) issues.push(`${name}: expected JPEG bytes`);
        evidenceVerified++;
      }
    } catch (error) { issues.push(`evidence: ${error instanceof Error ? error.message : String(error)}`); }
  }
  for (const name of requiredEvidence) if (!seen.has(name)) issues.push(`evidence report is missing ${name}`);

  const ok = issues.length === 0;
  const complete = ok && manifest.provenance === 'pre-render-authorized' && authorizationVerified && voiceBytesVerified && sourceExactRecompute && runtimePinsComplete;
  return { ok, trusted: complete, complete, provenance: manifest.provenance, sourceExactRecompute, authorizationVerified, issues, warnings, manifestSha256, outputSha256, mediaSha256, voiceBytesVerified, evidenceVerified, media };
}
