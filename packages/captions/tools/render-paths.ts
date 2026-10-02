import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export function isPathInside(root: string, candidate: string, allowRoot = false): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return (allowRoot || rel !== '') && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Resolve symlinks in the existing prefix, including for an output path that has not been created yet. */
export function policyRealpath(candidate: string): string {
  let cursor = resolve(candidate);
  const suffix: string[] = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error(`cannot resolve path policy for ${candidate}`);
    suffix.unshift(cursor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    cursor = parent;
  }
  return resolve(realpathSync(cursor), ...suffix);
}

export function requireContainedPath(label: string, candidate: string, roots: readonly string[], allowRoot = false): string {
  const real = policyRealpath(candidate);
  if (!roots.some((root) => isPathInside(policyRealpath(root), real, allowRoot))) {
    throw new Error(`${label} is outside its allowed root${roots.length === 1 ? '' : 's'}`);
  }
  return real;
}

export function requireInputFile(label: string, candidate: string): string {
  const real = policyRealpath(candidate);
  if (!existsSync(real) || !statSync(real).isFile()) throw new Error(`${label} does not exist or is not a regular file`);
  return real;
}

export function requireExecutable(label: string, candidate: string): string {
  const real = requireInputFile(label, candidate);
  if ((statSync(real).mode & 0o111) === 0) throw new Error(`${label} is not executable`);
  return real;
}

export interface RenderPathSet {
  root: string;
  storyboard: string;
  beats: string;
  directorReport?: string;
  voice: string;
  ffmpeg: string;
  output: string;
  inputManifest?: string;
  ffprobe?: string;
  chromium?: string;
  playwrightCore?: string;
}

/**
 * Apply repository containment for every render and the narrower upload/job/tool allowlists used by render workers.
 * This function performs no writes and rejects symlink escapes.
 */
export function validateRenderPaths(paths: RenderPathSet, workerSafe: boolean): RenderPathSet {
  const root = policyRealpath(paths.root);
  const storyboard = requireInputFile('storyboard', paths.storyboard);
  const beats = requireInputFile('beat sheet', paths.beats);
  const directorReport = paths.directorReport ? requireInputFile('Director report', paths.directorReport) : undefined;
  const voice = requireInputFile('voice', paths.voice);
  const ffmpeg = requireExecutable('ffmpeg', paths.ffmpeg);
  const output = policyRealpath(paths.output);
  const v1Golden = resolve(root, 'packages/captions/full-render');

  requireContainedPath('storyboard', storyboard, [root]);
  requireContainedPath('beat sheet', beats, [root]);
  if (directorReport) requireContainedPath('Director report', directorReport, [root]);
  requireContainedPath('output', output, [root]);
  if (isPathInside(v1Golden, output, true)) throw new Error('refusing to write into the v1 golden subtree packages/captions/full-render/');

  let inputManifest: string | undefined;
  if (paths.inputManifest) {
    inputManifest = requireInputFile('input manifest', paths.inputManifest);
    requireContainedPath('input manifest', inputManifest, [root]);
  }

  let ffprobe: string | undefined;
  if (paths.ffprobe) ffprobe = requireExecutable('ffprobe', paths.ffprobe);
  let chromium: string | undefined;
  if (paths.chromium) chromium = requireExecutable('chromium', paths.chromium);
  let playwrightCore: string | undefined;
  if (paths.playwrightCore) {
    playwrightCore = policyRealpath(paths.playwrightCore);
    if (!existsSync(playwrightCore)) throw new Error('playwright-core path does not exist');
  }

  if (workerSafe) {
    requireContainedPath('storyboard', storyboard, [resolve(root, 'tests/fixtures/narrated'), resolve(root, 'out/render-inputs')]);
    requireContainedPath('beat sheet', beats, [resolve(root, 'packages/director/fixtures'), resolve(root, 'out/render-inputs')]);
    if (directorReport) requireContainedPath('Director report', directorReport, [resolve(root, 'packages/director/fixtures'), resolve(root, 'out/render-inputs')]);
    requireContainedPath('voice', voice, [resolve(root, 'out/render-inputs'), resolve(root, '.scratch/voice')]);
    requireContainedPath('output', output, [resolve(root, 'out/render-jobs')]);
    requireContainedPath('ffmpeg', ffmpeg, [resolve(root, 'node_modules/ffmpeg-static')]);
    if (!inputManifest) throw new Error('--worker-safe requires --inputManifest');
    requireContainedPath('input manifest', inputManifest, [resolve(root, 'out/render-authorizations')]);
    if (ffprobe) requireContainedPath('ffprobe', ffprobe, [resolve(root, 'node_modules/ffprobe-static')]);
    if (playwrightCore) requireContainedPath('playwright-core', playwrightCore, [resolve(root, 'node_modules')]);
    if (chromium) requireContainedPath('chromium', chromium, [resolve(root, 'node_modules'), '/opt/playwright', resolve(process.env.HOME ?? root, '.cache/ms-playwright')]);
  }

  return { ...paths, root, storyboard, beats, ...(directorReport ? { directorReport } : {}), voice, ffmpeg, output, ...(inputManifest ? { inputManifest } : {}), ...(ffprobe ? { ffprobe } : {}), ...(chromium ? { chromium } : {}), ...(playwrightCore ? { playwrightCore } : {}) };
}
