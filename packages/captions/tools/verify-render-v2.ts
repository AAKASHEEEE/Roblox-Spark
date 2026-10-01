import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { loadLibrary } from '../../../apps/render-worker/lib/library.ts';
import { checkProductionProfile, probeBuiltin, type ProbeResult, type ProductionSpec } from '../../mp4/src/probe.ts';
import { ensureHeadlessCanvas } from '../../vignette/src/headless.ts';
import { runVignette } from '../../vignette/src/pipeline.ts';
import { assertCompositionTimeline } from '../src/preview/composition.ts';
import { COMPETITOR_EVIDENCE_FILES, RENDER_PROFILES } from './render-config.ts';
import { EVIDENCE_REPORT_SCHEMA, LEGACY_EVIDENCE_REPORT_SCHEMA, RENDER_BYTE_LIMITS, canonicalJson, manifestDigest, packageVersion, parseJsonBytes, readAuthenticatedFile, readBoundedFile, readInputManifest, safeManifestPath, sha256Bytes, solvedCompositionsDigest, type RenderInputManifest } from './render-manifest.ts';
import { isPathInside, policyRealpath } from './render-paths.ts';

const SHA256 = /^[a-f0-9]{64}$/;
export const POST_RENDER_ATTESTATION_SCHEMA = 'blockspark.render-post-attestation/1' as const;
export const DECODED_FRAME_RECEIPT_SCHEMA = 'blockspark.render-decoded-frame-receipt/1' as const;
export const DECODED_FRAME_RECEIPT_FILE = 'render-decoded-frames.json' as const;

/** Exact seeks used for future decoded-output evidence. Historical renderer snapshots intentionally do not claim this. */
export const COMPETITOR_DECODED_FRAMES = [
  { file: 'frame-teacher-exit.png', timestampSec: 3.0 },
  { file: 'frame-zapp-celebrate.png', timestampSec: 11.0 },
  { file: 'frame-button-press.png', timestampSec: 32.2 },
  { file: 'frame-coin-growth.png', timestampSec: 45.0 },
  { file: 'frame-impact.png', timestampSec: 57.0 },
  { file: 'frame-teacher-return.png', timestampSec: 61.0 },
  { file: 'frame-final-payoff.png', timestampSec: 67.0 },
] as const;

export interface DecodedFrameClaim { file: string; timestampSec: number; sha256: string; bytes: number; outputSha256: string }
export interface DecodedFrameReceipt {
  schema: typeof DECODED_FRAME_RECEIPT_SCHEMA;
  outputSha256: string;
  frames: Array<Omit<DecodedFrameClaim, 'outputSha256'>>;
}

interface BaseEvidenceFilePin { file: string; sha256: string; bytes: number }
export interface LegacyFrameEvidencePin extends BaseEvidenceFilePin { kind: 'frame-png' }
export interface DecodedFrameEvidencePin extends BaseEvidenceFilePin { kind: 'decoded-frame-png'; timestampSec: number; outputSha256: string }
export interface OtherEvidenceFilePin extends BaseEvidenceFilePin { kind: 'comparison-jpeg' | 'diagnostics' }
export type EvidenceFilePin = LegacyFrameEvidencePin | DecodedFrameEvidencePin | OtherEvidenceFilePin;
export interface RenderEvidenceReport {
  schema: typeof EVIDENCE_REPORT_SCHEMA | typeof LEGACY_EVIDENCE_REPORT_SCHEMA;
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
  postRenderAttestationVerified: boolean;
  representativeFramesVerified: boolean;
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
  if (root.schema !== EVIDENCE_REPORT_SCHEMA && root.schema !== LEGACY_EVIDENCE_REPORT_SCHEMA) throw new Error(`unsupported evidence report schema '${String(root.schema)}'`);
  const schema = root.schema as RenderEvidenceReport['schema'];
  const manifest = record(root.inputManifest, 'evidence report.inputManifest', ['file', 'sha256']);
  const output = record(root.output, 'evidence report.output', ['file', 'sha256', 'bytes']);
  const media = record(root.media, 'evidence report.media', ['sha256']);
  if (!Array.isArray(root.evidence)) throw new Error('evidence report.evidence must be an array');
  const evidence = root.evidence.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`evidence report.evidence[${index}] must be an object`);
    const kind = (entry as Record<string, unknown>).kind;
    const decoded = kind === 'decoded-frame-png';
    if (decoded && schema === LEGACY_EVIDENCE_REPORT_SCHEMA) throw new Error(`evidence report schema ${LEGACY_EVIDENCE_REPORT_SCHEMA} cannot claim decoded frames`);
    const pin = record(entry, `evidence report.evidence[${index}]`, decoded
      ? ['file', 'sha256', 'bytes', 'kind', 'timestampSec', 'outputSha256']
      : ['file', 'sha256', 'bytes', 'kind']);
    if (kind !== 'frame-png' && kind !== 'decoded-frame-png' && kind !== 'comparison-jpeg' && kind !== 'diagnostics') throw new Error(`evidence report.evidence[${index}].kind is invalid`);
    const base = {
      file: safeManifestPath(pin.file, `evidence report.evidence[${index}].file`),
      sha256: digest(pin.sha256, `evidence report.evidence[${index}].sha256`),
      bytes: count(pin.bytes, `evidence report.evidence[${index}].bytes`),
    };
    if (decoded) {
      if (typeof pin.timestampSec !== 'number' || !Number.isFinite(pin.timestampSec) || pin.timestampSec < 0 || pin.timestampSec > 300) throw new Error(`evidence report.evidence[${index}].timestampSec is invalid`);
      return { ...base, kind, timestampSec: pin.timestampSec, outputSha256: digest(pin.outputSha256, `evidence report.evidence[${index}].outputSha256`) } as DecodedFrameEvidencePin;
    }
    return { ...base, kind } as LegacyFrameEvidencePin | OtherEvidenceFilePin;
  });
  return {
    schema,
    inputManifest: { file: safeManifestPath(manifest.file, 'evidence report.inputManifest.file'), sha256: digest(manifest.sha256, 'evidence report.inputManifest.sha256') },
    output: { file: safeManifestPath(output.file, 'evidence report.output.file'), sha256: digest(output.sha256, 'evidence report.output.sha256'), bytes: count(output.bytes, 'evidence report.output.bytes') },
    media: { sha256: digest(media.sha256, 'evidence report.media.sha256') }, evidence,
  };
}

export function validateDecodedFrameClaims(outputSha256: string, claims: readonly DecodedFrameClaim[]): Map<string, DecodedFrameClaim> {
  if (!SHA256.test(outputSha256)) throw new Error('decoded frame receipt outputSha256 must be a lowercase SHA-256');
  const byName = new Map<string, DecodedFrameClaim>();
  for (const claim of claims) {
    if (byName.has(claim.file)) throw new Error(`duplicate decoded frame claim ${claim.file}`);
    if (!SHA256.test(claim.sha256)) throw new Error(`decoded frame ${claim.file} has an invalid SHA-256`);
    if (!Number.isSafeInteger(claim.bytes) || claim.bytes < 0 || claim.bytes > RENDER_BYTE_LIMITS.evidenceImage) throw new Error(`decoded frame ${claim.file} has an invalid byte count`);
    if (claim.outputSha256 !== outputSha256) throw new Error(`decoded frame ${claim.file} was decoded from a different output`);
    byName.set(claim.file, claim);
  }
  if (byName.size !== COMPETITOR_DECODED_FRAMES.length || !COMPETITOR_DECODED_FRAMES.every(({ file, timestampSec }) => byName.get(file)?.timestampSec === timestampSec)) {
    throw new Error('decoded frame claims must exactly match the competitor evidence names and seek times');
  }
  return byName;
}

export function createDecodedFrameReceipt(outputSha256: string, claims: readonly DecodedFrameClaim[]): DecodedFrameReceipt {
  validateDecodedFrameClaims(outputSha256, claims);
  return {
    schema: DECODED_FRAME_RECEIPT_SCHEMA,
    outputSha256,
    frames: claims.map(({ file, timestampSec, sha256, bytes }) => ({ file, timestampSec, sha256, bytes })),
  };
}

export function parseDecodedFrameReceipt(value: unknown): DecodedFrameReceipt {
  const root = record(value, 'decoded frame receipt', ['schema', 'outputSha256', 'frames']);
  if (root.schema !== DECODED_FRAME_RECEIPT_SCHEMA) throw new Error(`unsupported decoded frame receipt schema '${String(root.schema)}'`);
  const outputSha256 = digest(root.outputSha256, 'decoded frame receipt.outputSha256');
  if (!Array.isArray(root.frames)) throw new Error('decoded frame receipt.frames must be an array');
  const frames = root.frames.map((entry, index) => {
    const frame = record(entry, `decoded frame receipt.frames[${index}]`, ['file', 'timestampSec', 'sha256', 'bytes']);
    const file = text(frame.file, `decoded frame receipt.frames[${index}].file`);
    if (file.includes('/') || file.includes('\\')) throw new Error(`decoded frame receipt.frames[${index}].file must be a basename`);
    if (typeof frame.timestampSec !== 'number' || !Number.isFinite(frame.timestampSec)) throw new Error(`decoded frame receipt.frames[${index}].timestampSec is invalid`);
    return { file, timestampSec: frame.timestampSec, sha256: digest(frame.sha256, `decoded frame receipt.frames[${index}].sha256`), bytes: count(frame.bytes, `decoded frame receipt.frames[${index}].bytes`) };
  });
  validateDecodedFrameClaims(outputSha256, frames.map((frame) => ({ ...frame, outputSha256 })));
  return { schema: DECODED_FRAME_RECEIPT_SCHEMA, outputSha256, frames };
}

export function readDecodedFrameReceipt(path: string): DecodedFrameReceipt {
  const bytes = readBoundedFile(path, RENDER_BYTE_LIMITS.evidenceReport, 'decoded frame receipt');
  return parseDecodedFrameReceipt(parseJsonBytes(bytes, 'decoded frame receipt'));
}

export interface PostRenderAttestationPayload {
  schema: typeof POST_RENDER_ATTESTATION_SCHEMA;
  evidenceReportSchema: RenderEvidenceReport['schema'];
  jobSha256: string;
  inputManifestSha256: string;
  outputSha256: string;
  mediaSha256: string;
  evidenceSha256: string;
}

function sortedEvidencePins(report: RenderEvidenceReport): EvidenceFilePin[] {
  return [...report.evidence].sort((a, b) => a.file.localeCompare(b.file));
}

/** Canonical post-render claim retained by the scheduler/worker control plane, never inside the resealable report. */
export function postRenderAttestationPayload(manifest: RenderInputManifest, report: RenderEvidenceReport): PostRenderAttestationPayload {
  return {
    schema: POST_RENDER_ATTESTATION_SCHEMA,
    evidenceReportSchema: report.schema,
    jobSha256: sha256Bytes(canonicalJson(manifest.job)),
    inputManifestSha256: report.inputManifest.sha256,
    outputSha256: report.output.sha256,
    mediaSha256: report.media.sha256,
    evidenceSha256: sha256Bytes(canonicalJson(sortedEvidencePins(report))),
  };
}

export function postRenderAttestationDigest(manifest: RenderInputManifest, report: RenderEvidenceReport): string {
  return sha256Bytes(canonicalJson(postRenderAttestationPayload(manifest, report)));
}

export function verifyPostRenderAttestation(manifest: RenderInputManifest, report: RenderEvidenceReport, suppliedDigest?: string): boolean {
  return !!suppliedDigest && SHA256.test(suppliedDigest) && suppliedDigest === postRenderAttestationDigest(manifest, report);
}

/** A decoded-frame claim is valid only for the fixed seek and the exact output sealed by this report. */
export function verifyRepresentativeFrameClaims(report: RenderEvidenceReport): boolean {
  const claims = new Map(report.evidence.filter((pin): pin is DecodedFrameEvidencePin => pin.kind === 'decoded-frame-png').map((pin) => [pin.file.split('/').at(-1)!, pin]));
  return claims.size === COMPETITOR_DECODED_FRAMES.length && COMPETITOR_DECODED_FRAMES.every(({ file, timestampSec }) => {
    const claim = claims.get(file);
    return !!claim && claim.timestampSec === timestampSec && claim.outputSha256 === report.output.sha256;
  });
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

export function verifyFilePin(path: string, expected: { sha256: string; bytes?: number }, maxBytes = RENDER_BYTE_LIMITS.output): string[] {
  if (!existsSync(path)) return [`missing file: ${path}`];
  try {
    const bytes = readBoundedFile(path, maxBytes, path), issues: string[] = [];
    if (expected.bytes !== undefined && bytes.length !== expected.bytes) issues.push(`${path}: byte count ${bytes.length} != ${expected.bytes}`);
    const actual = sha256Bytes(bytes);
    if (actual !== expected.sha256) issues.push(`${path}: SHA-256 ${actual} != ${expected.sha256}`);
    return issues;
  } catch (error) { return [`${path}: ${error instanceof Error ? error.message : String(error)}`]; }
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

function readPinnedBlob(root: string, manifest: RenderInputManifest, path: string, expectedSha256: string, maxBytes = 64 * 1024 * 1024): Uint8Array {
  const bytes = execFileSync('git', ['show', `${manifest.source.commitSha}:${path}`], { cwd: root, maxBuffer: maxBytes + 1, stdio: ['ignore', 'pipe', 'pipe'] }) as Buffer;
  if (bytes.length > maxBytes) throw new Error(`pinned source blob ${path} exceeds ${maxBytes} byte limit (${bytes.length})`);
  const actual = sha256Bytes(bytes);
  if (actual !== expectedSha256) throw new Error(`pinned source blob ${path} has SHA-256 ${actual}, expected ${expectedSha256}`);
  return new Uint8Array(bytes);
}

function verifyPinnedBlob(root: string, manifest: RenderInputManifest, path: string, expectedSha256: string): string[] {
  try { readPinnedBlob(root, manifest, path, expectedSha256); return []; }
  catch (error) { return [error instanceof Error ? error.message : String(error)]; }
}

export interface BuildEvidenceReportOptions {
  root: string;
  inputManifestPath: string;
  outputPath: string;
  evidenceDir: string;
  /** In-process worker claims, already bound to the decode-time output hash. */
  decodedFrames?: readonly DecodedFrameClaim[];
  /** Delayed finalization consumes the worker receipt after comparison-sheet generation. */
  decodedFrameReceiptPath?: string;
}

/** Seal already-produced artifacts. This performs no render and never copies media or creates an attestation. */
export function buildEvidenceReport(options: BuildEvidenceReportOptions): RenderEvidenceReport {
  const root = policyRealpath(options.root), manifestPath = policyRealpath(options.inputManifestPath);
  const outputPath = policyRealpath(options.outputPath), evidenceDir = policyRealpath(options.evidenceDir);
  for (const [label, path] of [['input manifest', manifestPath], ['output', outputPath], ['evidence directory', evidenceDir]] as const) {
    if (!isPathInside(root, path)) throw new Error(`${label} escapes the repository`);
  }
  const manifest = readInputManifest(manifestPath);
  if (manifest.job.visual !== 'vignette' || manifest.job.evidenceProfile !== 'competitor-v2') throw new Error('only competitor-v2 Vignette artifacts can use this evidence schema');
  const repoRelative = (path: string): string => relative(root, path).split('\\').join('/');
  if (repoRelative(outputPath) !== manifest.job.outputPath) throw new Error('output path does not match the authorized manifest job');
  const outputBytes = readBoundedFile(outputPath, RENDER_BYTE_LIMITS.output, 'render output');
  const output = { sha256: sha256Bytes(outputBytes), bytes: outputBytes.length };
  const probe = probeBuiltin(outputBytes), mediaProblems = [
    ...checkProductionProfile(probe, profileSpec(manifest)).errors,
    ...codecPinIssues(probe, manifest.tools.rendererCodec),
  ];
  if (mediaProblems.length) throw new Error(`output does not match pinned media profile: ${mediaProblems.join('; ')}`);

  if (options.decodedFrames && options.decodedFrameReceiptPath) throw new Error('supply decoded frames or a decoded-frame receipt, not both');
  let decodedClaims: readonly DecodedFrameClaim[] | undefined = options.decodedFrames;
  if (options.decodedFrameReceiptPath) {
    const receiptPath = policyRealpath(options.decodedFrameReceiptPath);
    if (!isPathInside(evidenceDir, receiptPath)) throw new Error('decoded frame receipt is outside the evidence directory');
    const receipt = readDecodedFrameReceipt(receiptPath);
    decodedClaims = receipt.frames.map((frame) => ({ ...frame, outputSha256: receipt.outputSha256 }));
  }
  const decoded = decodedClaims ? validateDecodedFrameClaims(output.sha256, decodedClaims) : new Map<string, DecodedFrameClaim>();
  const names = [...COMPETITOR_EVIDENCE_FILES, 'verification.json'];
  const evidence: EvidenceFilePin[] = names.map((name) => {
    const path = join(evidenceDir, name);
    const bytes = readBoundedFile(path, name === 'verification.json' ? RENDER_BYTE_LIMITS.diagnostics : RENDER_BYTE_LIMITS.evidenceImage, `evidence ${name}`);
    const base = { file: repoRelative(path), sha256: sha256Bytes(bytes), bytes: bytes.length };
    const decodedClaim = decoded.get(name);
    if (name.endsWith('.png') && decodedClaim) {
      if (base.sha256 !== decodedClaim.sha256 || base.bytes !== decodedClaim.bytes) throw new Error(`committed evidence ${name} does not match the decoded frame bytes`);
      return { ...base, kind: 'decoded-frame-png', timestampSec: decodedClaim.timestampSec, outputSha256: output.sha256 };
    }
    return { ...base, kind: name.endsWith('.png') ? 'frame-png' : name.endsWith('.jpg') ? 'comparison-jpeg' : 'diagnostics' } as EvidenceFilePin;
  });
  return {
    schema: EVIDENCE_REPORT_SCHEMA,
    inputManifest: { file: repoRelative(manifestPath), sha256: manifestDigest(manifest) },
    output: { file: repoRelative(outputPath), ...output },
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
  /**
   * Worker/scheduler digest delivered through an authenticated control-plane channel outside the job request and
   * writable artifact directory. Callers must never populate this from an uploaded/local report.
   */
  postRenderAttestationSha256?: string;
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
  let postRenderAttestationVerified = false, representativeFramesVerified = false;
  let report: RenderEvidenceReport;
  try {
    if (!isPathInside(root, reportPath)) throw new Error('evidence report escapes the repository');
    const reportBytes = readBoundedFile(reportPath, RENDER_BYTE_LIMITS.evidenceReport, 'evidence report');
    report = parseEvidenceReport(parseJsonBytes(reportBytes, 'evidence report'));
  } catch (error) {
    return { ok: false, trusted: false, complete: false, sourceExactRecompute, authorizationVerified, postRenderAttestationVerified, representativeFramesVerified, issues: [`cannot read evidence report: ${error instanceof Error ? error.message : String(error)}`], warnings, voiceBytesVerified, evidenceVerified };
  }

  let manifest: RenderInputManifest;
  let manifestSha256: string | undefined;
  try {
    const manifestPath = resolvePinned(root, report.inputManifest.file, 'input manifest path');
    manifest = readInputManifest(manifestPath);
    manifestSha256 = manifestDigest(manifest);
    if (manifestSha256 !== report.inputManifest.sha256) issues.push(`input manifest SHA-256 ${manifestSha256} != report ${report.inputManifest.sha256}`);
  } catch (error) {
    return { ok: false, trusted: false, complete: false, sourceExactRecompute, authorizationVerified, postRenderAttestationVerified, representativeFramesVerified, issues: [`cannot verify input manifest: ${error instanceof Error ? error.message : String(error)}`], warnings, voiceBytesVerified, evidenceVerified };
  }

  authorizationVerified = options.authorizedManifestSha256 === manifestSha256;
  if (options.authorizedManifestSha256 && !authorizationVerified) issues.push('scheduler-authorized manifest digest does not match the evidence manifest');
  if (!options.authorizedManifestSha256) warnings.push('no scheduler-owned manifest digest supplied; authorization is not verified');
  postRenderAttestationVerified = verifyPostRenderAttestation(manifest, report, options.postRenderAttestationSha256);
  if (options.postRenderAttestationSha256 && !postRenderAttestationVerified) issues.push('worker/scheduler post-render attestation digest does not match the sealed job, manifest, output, media, and evidence hashes');
  if (!options.postRenderAttestationSha256) warnings.push('no independently supplied post-render attestation digest; local resealing can prove integrity but never trust');
  const frameClaimsStructurallyValid = verifyRepresentativeFrameClaims(report);
  if (!frameClaimsStructurallyValid) warnings.push('representative images are not claimed as decoded frames bound to this output; historical renderer snapshots remain integrity-only');
  if (manifest.provenance === 'retroactive-integrity-seal') warnings.push('artifact was retroactively sealed; integrity can be checked but pre-render authorization is not claimed');
  if (manifest.job.visual !== 'vignette' || manifest.job.evidenceProfile !== 'competitor-v2') issues.push('v2 evidence requires vignette + competitor-v2 manifest job');
  if (report.output.file !== manifest.job.outputPath) issues.push(`evidence output ${report.output.file} does not match manifest job output ${manifest.job.outputPath}`);
  const gitPins = verifyGitPins(root, manifest);
  issues.push(...gitPins.issues); sourceExactRecompute = gitPins.sourceExact;
  if (!sourceExactRecompute) warnings.push('composition recomputation uses a checkout other than the clean pinned source; pinned blobs are checked separately');

  const pinnedInputs = [
    ['storyboard', 'storyboard', manifest.inputs.storyboard, RENDER_BYTE_LIMITS.storyboard],
    ['beatSheet', 'beat sheet', manifest.inputs.beatSheet, RENDER_BYTE_LIMITS.beatSheet],
    ['assetLock', 'asset lock', manifest.inputs.assetLock, RENDER_BYTE_LIMITS.assetLock],
    ['packageLock', 'package lock', manifest.inputs.packageLock, RENDER_BYTE_LIMITS.packageLock],
  ] as const;
  const authenticatedInputs: Partial<Record<(typeof pinnedInputs)[number][0], Uint8Array>> = {};
  for (const [key, label, pin, maxBytes] of pinnedInputs) {
    let pinnedBytes: Uint8Array | undefined;
    try { pinnedBytes = readPinnedBlob(root, manifest, pin.path, pin.sha256, maxBytes); }
    catch (error) { issues.push(`${label}: ${error instanceof Error ? error.message : String(error)}`); }
    try {
      const path = resolvePinned(root, pin.path, `${label} path`);
      const localBytes = readAuthenticatedFile(path, pin, maxBytes, label);
      authenticatedInputs[key] = manifest.provenance === 'retroactive-integrity-seal' ? pinnedBytes : localBytes;
    } catch (error) {
      const message = `${label}: ${error instanceof Error ? error.message : String(error)}`;
      if (manifest.provenance === 'retroactive-integrity-seal' && pinnedBytes) {
        authenticatedInputs[key] = pinnedBytes;
        warnings.push(`${message}; using the authenticated blob from the pinned historical commit`);
      } else issues.push(message);
    }
  }

  let storyboard: any;
  try {
    if (!authenticatedInputs.storyboard) throw new Error('storyboard bytes did not authenticate');
    storyboard = parseJsonBytes(authenticatedInputs.storyboard, 'storyboard');
    if (storyboard?.audio?.contentHash !== manifest.inputs.voice.sha256) issues.push('storyboard audio hash does not match the manifest voice hash');
  } catch (error) { issues.push(`cannot inspect storyboard voice pin: ${error instanceof Error ? error.message : String(error)}`); }
  if (options.voicePath) {
    try {
      readAuthenticatedFile(options.voicePath, manifest.inputs.voice, RENDER_BYTE_LIMITS.voice, 'voice');
      voiceBytesVerified = true;
    } catch (error) { issues.push(`cannot verify voice bytes: ${error instanceof Error ? error.message : String(error)}`); }
  } else warnings.push('approved voice bytes were not supplied; only the storyboard/manifest voice-hash chain was checked');

  try {
    if (!authenticatedInputs.packageLock) throw new Error('package-lock bytes did not authenticate');
    const packageLock = parseJsonBytes(authenticatedInputs.packageLock, 'package lock');
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

  if (options.recomputeCompositions !== false && !(manifest.provenance === 'retroactive-integrity-seal' && !sourceExactRecompute)) {
    try {
      ensureHeadlessCanvas();
      if (!authenticatedInputs.beatSheet) throw new Error('BeatSheet bytes did not authenticate');
      const sheet: any = parseJsonBytes(authenticatedInputs.beatSheet, 'BeatSheet');
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
  } else if (options.recomputeCompositions !== false) {
    warnings.push('historical composition solve was not rerun with a newer checkout; its pinned manifest digest remains integrity-only');
  }

  let outputSha256: string | undefined, mediaSha256: string | undefined, media: MediaFingerprint | undefined;
  try {
    const outputPath = resolvePinned(root, report.output.file, 'output path');
    const bytes = readAuthenticatedFile(outputPath, report.output, RENDER_BYTE_LIMITS.output, 'output');
    outputSha256 = sha256Bytes(bytes);
    if (manifest.provenance === 'retroactive-integrity-seal') issues.push(...verifyPinnedBlob(root, manifest, report.output.file, report.output.sha256).map((x) => `output: ${x}`));
    const probe = (options.probeMedia ?? probeBuiltin)(bytes);
    const production = checkProductionProfile(probe, profileSpec(manifest));
    if (!production.ok) issues.push(...production.errors.map((x) => `media: ${x}`));
    issues.push(...codecPinIssues(probe, manifest.tools.rendererCodec).map((x) => `media: ${x}`));
    media = mediaFingerprint(probe); mediaSha256 = mediaFingerprintDigest(media);
    if (mediaSha256 !== report.media.sha256) issues.push(`media fingerprint SHA-256 ${mediaSha256} != report ${report.media.sha256}`);
  } catch (error) { issues.push(`cannot independently verify output media: ${error instanceof Error ? error.message : String(error)}`); }

  const reportDir = dirname(reportPath);
  const requiredEvidence = new Set<string>([...COMPETITOR_EVIDENCE_FILES, 'verification.json']);
  const seen = new Set<string>(), verifiedDecodedFrames = new Set<string>();
  const pngMagic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (const pin of report.evidence) {
    try {
      const path = resolvePinned(root, pin.file, 'evidence path');
      if (!isPathInside(reportDir, path)) throw new Error('evidence file is outside the evidence report directory');
      const name = pin.file.split('/').at(-1)!;
      if (!requiredEvidence.has(name)) throw new Error(`unexpected evidence file ${name}`);
      if (seen.has(name)) throw new Error(`duplicate evidence file ${name}`);
      seen.add(name);
      const maxBytes = pin.kind === 'diagnostics' ? RENDER_BYTE_LIMITS.diagnostics : RENDER_BYTE_LIMITS.evidenceImage;
      const bytes = readAuthenticatedFile(path, pin, maxBytes, `evidence ${name}`);
      if (manifest.provenance === 'retroactive-integrity-seal') issues.push(...verifyPinnedBlob(root, manifest, pin.file, pin.sha256).map((x) => `evidence: ${x}`));
      if ((pin.kind === 'frame-png' || pin.kind === 'decoded-frame-png') && !pngMagic.every((byte, index) => bytes[index] === byte)) throw new Error(`${name}: expected PNG bytes`);
      if (pin.kind === 'comparison-jpeg' && !(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9)) throw new Error(`${name}: expected JPEG bytes`);
      if (pin.kind === 'decoded-frame-png') verifiedDecodedFrames.add(name);
      evidenceVerified++;
    } catch (error) { issues.push(`evidence: ${error instanceof Error ? error.message : String(error)}`); }
  }
  for (const name of requiredEvidence) if (!seen.has(name)) issues.push(`evidence report is missing ${name}`);
  representativeFramesVerified = frameClaimsStructurallyValid
    && COMPETITOR_DECODED_FRAMES.every(({ file }) => verifiedDecodedFrames.has(file));

  const ok = issues.length === 0;
  const complete = ok && manifest.provenance === 'pre-render-authorized' && authorizationVerified && postRenderAttestationVerified
    && representativeFramesVerified && voiceBytesVerified && sourceExactRecompute && runtimePinsComplete;
  return { ok, trusted: complete, complete, provenance: manifest.provenance, sourceExactRecompute, authorizationVerified, postRenderAttestationVerified, representativeFramesVerified, issues, warnings, manifestSha256, outputSha256, mediaSha256, voiceBytesVerified, evidenceVerified, media };
}
