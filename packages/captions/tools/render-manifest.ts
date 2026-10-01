import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, posix, relative } from 'node:path';
import type { TimedComposition } from '../src/preview/composition.ts';
import type { EvidenceProfileId, RenderProfileId, VisualMode } from './render-config.ts';

export const INPUT_MANIFEST_SCHEMA = 'blockspark.render-input-manifest/2' as const;
export const EVIDENCE_REPORT_SCHEMA = 'blockspark.render-evidence/2' as const;
const SHA256 = /^[a-f0-9]{64}$/;
const GIT_OBJECT = /^[a-f0-9]{40,64}$/;

export interface ToolPins {
  node: string;
  typescript: string;
  playwrightCore: string;
  chromium: string;
  ffmpegStatic: string;
  ffprobeStatic: string;
  rendererCodec: 'avc1.64001f' | 'avc1.640028';
}

export interface RuntimePins {
  visualEntry: string;
  bundleTreeSha256: string | null;
  ffmpegSha256: string | null;
  ffprobeSha256: string | null;
  playwrightTreeSha256: string | null;
  chromiumSha256: string | null;
}

export interface RenderInputManifest {
  schema: typeof INPUT_MANIFEST_SCHEMA;
  provenance: 'pre-render-authorized' | 'retroactive-integrity-seal';
  job: { jobId: string; outputPath: string; visual: VisualMode; renderProfile: RenderProfileId; evidenceProfile: EvidenceProfileId };
  source: { repository: string; commitSha: string; treeSha: string; baseSha: string };
  inputs: {
    storyboard: { path: string; sha256: string };
    beatSheet: { path: string; sha256: string };
    voice: { sha256: string };
    solvedCompositions: { sha256: string; count: number };
    assetLock: { path: string; sha256: string };
    packageLock: { path: string; sha256: string };
  };
  tools: ToolPins;
  runtime: RuntimePins;
}

export interface ManifestActuals {
  job: RenderInputManifest['job'];
  source: RenderInputManifest['source'];
  inputs: RenderInputManifest['inputs'];
  tools: ToolPins;
  runtime: RuntimePins;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical JSON cannot contain a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().filter((key) => object[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
  }
  throw new Error(`canonical JSON cannot contain ${typeof value}`);
}

export function sha256Bytes(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hashFile(path: string): { sha256: string; bytes: number } {
  const bytes = readFileSync(path);
  return { sha256: sha256Bytes(bytes), bytes: bytes.length };
}

/** Content-address an emitted/module directory, including relative names and every file byte. Symlinks are rejected. */
export function hashDirectoryTree(root: string): string {
  const files: Array<{ path: string; sha256: string; bytes: number }> = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name), stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`runtime tree contains symlink: ${relative(root, path)}`);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) files.push({ path: relative(root, path).split('\\').join('/'), ...hashFile(path) });
      else throw new Error(`runtime tree contains unsupported entry: ${relative(root, path)}`);
    }
  };
  if (!statSync(root).isDirectory()) throw new Error(`runtime tree is not a directory: ${root}`);
  walk(root);
  return sha256Bytes(canonicalJson(files));
}

export function solvedCompositionsDigest(compositions: readonly TimedComposition[]): string {
  return sha256Bytes(canonicalJson(compositions));
}

export function manifestDigest(manifest: RenderInputManifest): string {
  return sha256Bytes(canonicalJson(manifest));
}

function object(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const result = value as Record<string, unknown>;
  const actual = Object.keys(result).sort(), expected = [...keys].sort();
  if (actual.join('\0') !== expected.join('\0')) throw new Error(`${label} keys must be exactly ${expected.join(', ')}`);
  return result;
}
function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}
function digest(value: unknown, label: string): string {
  const result = string(value, label);
  if (!SHA256.test(result)) throw new Error(`${label} must be a lowercase SHA-256`);
  return result;
}
function nullableDigest(value: unknown, label: string): string | null {
  return value === null ? null : digest(value, label);
}
function gitObject(value: unknown, label: string): string {
  const result = string(value, label);
  if (!GIT_OBJECT.test(result)) throw new Error(`${label} must be a lowercase git object id`);
  return result;
}
function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label} must be a non-negative integer`);
  return Number(value);
}

/** Manifest-controlled paths are always repository-relative POSIX paths with no traversal or ambiguous separators. */
export function safeManifestPath(value: unknown, label: string): string {
  const path = string(value, label);
  if (path.includes('\\') || path.includes('\0') || isAbsolute(path) || posix.isAbsolute(path) || posix.normalize(path) !== path || path === '..' || path.startsWith('../')) {
    throw new Error(`${label} must be a normalized repository-relative path`);
  }
  return path;
}

export function parseInputManifest(value: unknown): RenderInputManifest {
  const root = object(value, 'manifest', ['schema', 'provenance', 'job', 'source', 'inputs', 'tools', 'runtime']);
  if (root.schema !== INPUT_MANIFEST_SCHEMA) throw new Error(`unsupported input manifest schema '${String(root.schema)}'`);
  if (root.provenance !== 'pre-render-authorized' && root.provenance !== 'retroactive-integrity-seal') throw new Error('manifest.provenance is invalid');
  const job = object(root.job, 'manifest.job', ['jobId', 'outputPath', 'visual', 'renderProfile', 'evidenceProfile']);
  if (job.visual !== 'vignette' && job.visual !== 'narrated') throw new Error('manifest.job.visual is invalid');
  if (job.renderProfile !== 'review-vertical-540p' && job.renderProfile !== 'production-vertical-1080p') throw new Error('manifest.job.renderProfile is invalid');
  if (job.evidenceProfile !== 'none' && job.evidenceProfile !== 'competitor-v2') throw new Error('manifest.job.evidenceProfile is invalid');
  const jobId = string(job.jobId, 'manifest.job.jobId');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(jobId)) throw new Error('manifest.job.jobId is invalid');
  const outputPath = safeManifestPath(job.outputPath, 'manifest.job.outputPath');

  const source = object(root.source, 'manifest.source', ['repository', 'commitSha', 'treeSha', 'baseSha']);
  const inputs = object(root.inputs, 'manifest.inputs', ['storyboard', 'beatSheet', 'voice', 'solvedCompositions', 'assetLock', 'packageLock']);
  const filePin = (key: 'storyboard' | 'beatSheet' | 'assetLock' | 'packageLock') => {
    const pin = object(inputs[key], `manifest.inputs.${key}`, ['path', 'sha256']);
    return { path: safeManifestPath(pin.path, `manifest.inputs.${key}.path`), sha256: digest(pin.sha256, `manifest.inputs.${key}.sha256`) };
  };
  const voice = object(inputs.voice, 'manifest.inputs.voice', ['sha256']);
  const solved = object(inputs.solvedCompositions, 'manifest.inputs.solvedCompositions', ['sha256', 'count']);
  const tools = object(root.tools, 'manifest.tools', ['node', 'typescript', 'playwrightCore', 'chromium', 'ffmpegStatic', 'ffprobeStatic', 'rendererCodec']);
  const runtime = object(root.runtime, 'manifest.runtime', ['visualEntry', 'bundleTreeSha256', 'ffmpegSha256', 'ffprobeSha256', 'playwrightTreeSha256', 'chromiumSha256']);
  if (tools.rendererCodec !== 'avc1.64001f' && tools.rendererCodec !== 'avc1.640028') throw new Error('manifest.tools.rendererCodec is invalid');

  return {
    schema: INPUT_MANIFEST_SCHEMA,
    provenance: root.provenance,
    job: { jobId, outputPath, visual: job.visual, renderProfile: job.renderProfile, evidenceProfile: job.evidenceProfile } as RenderInputManifest['job'],
    source: {
      repository: string(source.repository, 'manifest.source.repository'),
      commitSha: gitObject(source.commitSha, 'manifest.source.commitSha'),
      treeSha: gitObject(source.treeSha, 'manifest.source.treeSha'),
      baseSha: gitObject(source.baseSha, 'manifest.source.baseSha'),
    },
    inputs: {
      storyboard: filePin('storyboard'), beatSheet: filePin('beatSheet'),
      voice: { sha256: digest(voice.sha256, 'manifest.inputs.voice.sha256') },
      solvedCompositions: { sha256: digest(solved.sha256, 'manifest.inputs.solvedCompositions.sha256'), count: integer(solved.count, 'manifest.inputs.solvedCompositions.count') },
      assetLock: filePin('assetLock'), packageLock: filePin('packageLock'),
    },
    tools: {
      node: string(tools.node, 'manifest.tools.node'), typescript: string(tools.typescript, 'manifest.tools.typescript'),
      playwrightCore: string(tools.playwrightCore, 'manifest.tools.playwrightCore'), chromium: string(tools.chromium, 'manifest.tools.chromium'),
      ffmpegStatic: string(tools.ffmpegStatic, 'manifest.tools.ffmpegStatic'), ffprobeStatic: string(tools.ffprobeStatic, 'manifest.tools.ffprobeStatic'),
      rendererCodec: tools.rendererCodec,
    },
    runtime: {
      visualEntry: safeManifestPath(runtime.visualEntry, 'manifest.runtime.visualEntry'),
      bundleTreeSha256: nullableDigest(runtime.bundleTreeSha256, 'manifest.runtime.bundleTreeSha256'),
      ffmpegSha256: nullableDigest(runtime.ffmpegSha256, 'manifest.runtime.ffmpegSha256'),
      ffprobeSha256: nullableDigest(runtime.ffprobeSha256, 'manifest.runtime.ffprobeSha256'),
      playwrightTreeSha256: nullableDigest(runtime.playwrightTreeSha256, 'manifest.runtime.playwrightTreeSha256'),
      chromiumSha256: nullableDigest(runtime.chromiumSha256, 'manifest.runtime.chromiumSha256'),
    },
  };
}

export function readInputManifest(path: string): RenderInputManifest {
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { throw new Error(`cannot parse input manifest: ${error instanceof Error ? error.message : String(error)}`); }
  return parseInputManifest(value);
}

export function assertRuntimePins(manifest: RenderInputManifest, actual: RuntimePins): void {
  if (canonicalJson(manifest.runtime) !== canonicalJson(actual)) throw new Error('trusted input manifest runtime bytes do not match the selected executables/bundle');
}

export function assertManifestActuals(manifest: RenderInputManifest, actual: ManifestActuals): void {
  const differences: string[] = [];
  const compare = (expected: unknown, got: unknown, path: string): void => {
    if (expected && got && typeof expected === 'object' && typeof got === 'object' && !Array.isArray(expected) && !Array.isArray(got)) {
      for (const key of Object.keys(expected as Record<string, unknown>)) compare((expected as Record<string, unknown>)[key], (got as Record<string, unknown>)[key], `${path}.${key}`);
    } else if (canonicalJson(expected) !== canonicalJson(got)) differences.push(`${path}: manifest=${JSON.stringify(expected)} actual=${JSON.stringify(got)}`);
  };
  compare({ job: manifest.job, source: manifest.source, inputs: manifest.inputs, tools: manifest.tools, runtime: manifest.runtime }, actual, 'manifest');
  if (differences.length) throw new Error(`trusted input manifest mismatch: ${differences.join('; ')}`);
}

export function gitSource(root: string, baseRef: string): RenderInputManifest['source'] {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const commitSha = git('rev-parse', 'HEAD'), treeSha = git('rev-parse', 'HEAD^{tree}'), baseSha = git('rev-parse', baseRef);
  if (!GIT_OBJECT.test(commitSha) || !GIT_OBJECT.test(treeSha) || !GIT_OBJECT.test(baseSha)) throw new Error('git returned an invalid source identity');
  if (git('status', '--porcelain')) throw new Error('trusted render requires a clean source tree');
  try { git('merge-base', '--is-ancestor', baseSha, commitSha); }
  catch { throw new Error(`source commit ${commitSha} is not based on ${baseSha}`); }
  return { repository: 'AAKASHEEEE/Roblox-Spark', commitSha, treeSha, baseSha };
}

export function packageVersion(lock: unknown, name: string): string {
  const packages = (lock as { packages?: Record<string, { version?: unknown }> })?.packages;
  const version = packages?.[`node_modules/${name}`]?.version;
  if (typeof version !== 'string' || !version) throw new Error(`package-lock does not pin ${name}`);
  return version;
}
