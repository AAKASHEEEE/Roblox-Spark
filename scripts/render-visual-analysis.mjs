#!/usr/bin/env node
// Render visual analysis (FEAT-004).
// Measures the OWN-render MP4s (v1 S7 golden and v2 competitor-performance) on the
// SAME decoded-frame axes as scripts/competitor-visual-analysis.mjs so the redesigned
// output can be compared apples-to-apples against the competitor references:
// hard-cut count via ffmpeg scene detection, shot-length distribution, and dense
// camera-translation / zoom-activity frame rates from mean-abs luma deltas.
//
// This is a decoded-output measurement (every sampled frame is pulled through ffmpeg);
// it complements the deterministic camera-solver metrics already recorded in each
// verification.json (compositions / medianCompositionSec / translationFrac / zoomFrac).
//
// Usage: node scripts/render-visual-analysis.mjs
// Env:   FFMPEG_PATH, FFPROBE_PATH (fall back to ffmpeg-static / ffprobe-static)

import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const FFMPEG = process.env.FFMPEG_PATH || require('ffmpeg-static');
const FFPROBE = process.env.FFPROBE_PATH || require('ffprobe-static').path;

const ROOT = resolve(process.cwd());
const OUT = join(ROOT, '.scratch', 'visual-analysis', 'render-summary.json');

// Same sensitivity constants as the competitor analysis for a fair comparison.
const SCENE_THRESHOLD = 0.30;
const TRANSLATE_THRESHOLD = 0.012;
const ZOOM_THRESHOLD = 0.020;

const RENDERS = [
  { name: 'v1-s7', file: 'packages/captions/full-render/zapp-vs-kira-full-s7.mp4' },
  { name: 'v2-competitor-performance', file: 'packages/captions/full-render-v2/zapp-vs-kira-competitor-performance-v2.mp4' },
];

function capture(bin, args) {
  const r = spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 1 << 28 });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
}

function ffprobeJson(file) {
  const out = execFileSync(FFPROBE, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,avg_frame_rate,r_frame_rate,nb_frames',
    '-show_entries', 'format=duration', '-of', 'json', file,
  ], { encoding: 'utf8' });
  return JSON.parse(out);
}

function parseFps(str) {
  if (!str || str === '0/0') return 0;
  const [n, d] = str.split('/').map(Number);
  return d ? n / d : n;
}

function detectCuts(file) {
  const res = capture(FFMPEG, [
    '-hide_banner', '-i', file,
    '-filter:v', `select='gt(scene,${SCENE_THRESHOLD})',showinfo`,
    '-f', 'null', '-',
  ]);
  const times = [];
  const re = /pts_time:([0-9.]+)/g;
  let m;
  while ((m = re.exec(res.stderr)) !== null) times.push(parseFloat(m[1]));
  return times;
}

function frameDeltaSignal(file, sampleFps) {
  const res = capture(FFMPEG, [
    '-hide_banner', '-i', file,
    '-filter:v', `fps=${sampleFps},scale=64:36,tblend=all_mode=difference,signalstats,metadata=print`,
    '-f', 'null', '-',
  ]);
  const deltas = [];
  const re = /lavfi\.signalstats\.YAVG=([0-9.]+)/g;
  let m;
  while ((m = re.exec(res.stderr)) !== null) deltas.push(parseFloat(m[1]) / 255);
  return deltas;
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }

function analyze(r) {
  const file = join(ROOT, r.file);
  const probe = ffprobeJson(file);
  const stream = probe.streams[0];
  const duration = parseFloat(probe.format.duration);
  const fps = parseFps(stream.avg_frame_rate) || parseFps(stream.r_frame_rate);
  const cutTimes = detectCuts(file);
  const shotCount = cutTimes.length + 1;
  const bounds = [0, ...cutTimes, duration];
  const shotLengths = [];
  for (let i = 0; i < bounds.length - 1; i++) shotLengths.push(bounds[i + 1] - bounds[i]);
  const shotsUnder2s = shotLengths.filter((l) => l < 2.0).length;
  const sampleFps = Math.min(fps || 30, 30);
  const deltas = frameDeltaSignal(file, sampleFps);
  const translateFrames = deltas.filter((d) => d > TRANSLATE_THRESHOLD).length;
  const zoomFrames = deltas.filter((d) => d > ZOOM_THRESHOLD).length;
  return {
    name: r.name,
    file: r.file,
    durationSec: Number(duration.toFixed(3)),
    resolution: `${stream.width}x${stream.height}`,
    fps: Number((fps || 0).toFixed(3)),
    cutCount: cutTimes.length,
    shotCount,
    avgShotLengthSec: Number(mean(shotLengths).toFixed(3)),
    medianShotLengthSec: Number(median(shotLengths).toFixed(3)),
    shotsUnder2s,
    shotsUnder2sPct: Number(((shotsUnder2s / shotCount) * 100).toFixed(1)),
    motionSampleFps: Number(sampleFps.toFixed(3)),
    motionSampleFrames: deltas.length,
    cameraTranslationFrameRate: Number((translateFrames / (deltas.length || 1)).toFixed(4)),
    zoomActivityFrameRate: Number((zoomFrames / (deltas.length || 1)).toFixed(4)),
    cutTimesSec: cutTimes.map((t) => Number(t.toFixed(3))),
  };
}

function main() {
  const results = RENDERS.map((r) => {
    process.stderr.write(`[render-visual] analyzing ${r.name}...\n`);
    return analyze(r);
  });
  const summary = {
    generatedAt: new Date().toISOString(),
    sceneThreshold: SCENE_THRESHOLD,
    translateThreshold: TRANSLATE_THRESHOLD,
    zoomThreshold: ZOOM_THRESHOLD,
    ffmpeg: FFMPEG,
    ffprobe: FFPROBE,
    renders: results,
  };
  writeFileSync(OUT, JSON.stringify(summary, null, 2));
  process.stderr.write(`[render-visual] wrote ${OUT}\n`);
  for (const r of results) {
    process.stderr.write(
      `[render-visual] ${r.name}: ${r.durationSec}s ${r.resolution}@${r.fps} cuts=${r.cutCount} shots=${r.shotCount} avg=${r.avgShotLengthSec}s median=${r.medianShotLengthSec}s translate=${r.cameraTranslationFrameRate} zoom=${r.zoomActivityFrameRate}\n`
    );
  }
}

main();
