import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateRenderPaths } from '../tools/render-paths.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'captions-paths-'));
  const make = (relative: string, executable = false) => {
    const path = join(root, relative); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, 'x');
    if (executable) chmodSync(path, 0o755);
    return path;
  };
  const paths = {
    root,
    storyboard: make('tests/fixtures/narrated/storyboard.json'),
    beats: make('packages/director/fixtures/beats.json'),
    voice: make('out/render-inputs/voice.mp3'),
    ffmpeg: make('node_modules/ffmpeg-static/ffmpeg', true),
    ffprobe: make('node_modules/ffprobe-static/ffprobe', true),
    inputManifest: make('out/render-authorizations/manifest.json'),
    output: join(root, 'out/render-jobs/job-1'),
  };
  return { root, paths, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('worker-safe paths accept only contained input, output, and executable roots', () => {
  const x = fixture();
  try {
    const checked = validateRenderPaths(x.paths, true);
    assert.equal(checked.output, x.paths.output);
    assert.equal(checked.ffmpeg, x.paths.ffmpeg);
  } finally { x.cleanup(); }
});

test('worker-safe paths reject executable substitution and output traversal', () => {
  const x = fixture();
  try {
    const rogue = join(x.root, 'out/render-inputs/ffmpeg'); writeFileSync(rogue, 'x'); chmodSync(rogue, 0o755);
    assert.throws(() => validateRenderPaths({ ...x.paths, ffmpeg: rogue }, true), /ffmpeg is outside/);
    assert.throws(() => validateRenderPaths({ ...x.paths, output: join(x.root, 'packages/captions/generated') }, true), /output is outside/);
  } finally { x.cleanup(); }
});

test('path policy rejects symlink escapes and every descendant of the v1 golden', () => {
  const x = fixture(), outside = mkdtempSync(join(tmpdir(), 'captions-outside-'));
  try {
    mkdirSync(join(x.root, 'out/render-jobs'), { recursive: true });
    symlinkSync(outside, join(x.root, 'out/render-jobs/escape'));
    assert.throws(() => validateRenderPaths({ ...x.paths, output: join(x.root, 'out/render-jobs/escape/job') }, true), /output is outside/);
    assert.throws(() => validateRenderPaths({ ...x.paths, output: join(x.root, 'packages/captions/full-render/nested') }, false), /v1 golden subtree/);
  } finally { x.cleanup(); rmSync(outside, { recursive: true, force: true }); }
});

test('worker-safe Director sidecars are restricted with the same symlink-aware policy as BeatSheets', () => {
  const x = fixture(), outside = mkdtempSync(join(tmpdir(), 'captions-sidecar-outside-'));
  try {
    const allowed = join(x.root, 'out/render-inputs/director-report.json');
    writeFileSync(allowed, '{}');
    assert.equal(validateRenderPaths({ ...x.paths, directorReport: allowed }, true).directorReport, allowed);

    const rogue = join(x.root, 'director-report.json'); writeFileSync(rogue, '{}');
    assert.throws(() => validateRenderPaths({ ...x.paths, directorReport: rogue }, true), /Director report is outside/);

    writeFileSync(join(outside, 'report.json'), '{}');
    symlinkSync(outside, join(x.root, 'out/render-inputs/sidecar-link'));
    assert.throws(() => validateRenderPaths({ ...x.paths, directorReport: join(x.root, 'out/render-inputs/sidecar-link/report.json') }, true), /Director report is outside/);
  } finally { x.cleanup(); rmSync(outside, { recursive: true, force: true }); }
});
