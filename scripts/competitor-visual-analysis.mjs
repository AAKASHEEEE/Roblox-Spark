#!/usr/bin/env node
// Competitor visual analysis (FEAT-001).
// Decodes each competitor MP4 fully, detects shot boundaries via frame-difference
// (ffmpeg select=gt(scene,...)), measures camera translation / zoom activity from
// dense motion vectors, and writes .scratch/visual-analysis/{summary.json, <name>-shots.jpg}.
//
// Usage: node scripts/competitor-visual-analysis.mjs
// Env:   FFMPEG_PATH, FFPROBE_PATH (fall back to ffmpeg-static / ffprobe-static)

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const FFMPEG = process.env.FFMPEG_PATH || require('ffmpeg-static');
const FFPROBE = process.env.FFPROBE_PATH || require('ffprobe-static').path;

const ROOT = resolve(process.cwd());
const COMP_DIR = join(ROOT, '.scratch', 'competitors');
const OUT_DIR = join(ROOT, '.scratch', 'visual-analysis');

const VIDEOS = [
  { name: 'reported', file: 'reported.mp4' },
  { name: 'lived', file: 'lived.mp4' },
  { name: 'noob-vs-pro', file: 'noob-vs-pro.mp4' },
];

// Scene-change sensitivity threshold used to declare a hard cut.
const SCENE_THRESHOLD = 0.30;
// Motion thresholds: fraction of mean-abs frame delta that counts as activity.
const TRANSLATE_THRESHOLD = 0.012; // camera translation / movement per frame
const ZOOM_THRESHOLD = 0.020; // stronger global change => zoom / punch-in

function ffprobeJson(file) {
  const out = execFileSync(
    FFPROBE,
    [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,avg_frame_rate,r_frame_rate,nb_frames',
      '-show_entries', 'format=duration',
      '-of', 'json',
      file,
    ],
    { encoding: 'utf8' }
  );
  return JSON.parse(out);
}

function parseFps(str) {
  if (!str || str === '0/0') return 0;
  const [n, d] = str.split('/').map(Number);
  return d ? n / d : n;
}

// Detect hard cuts using ffmpeg's scene score. Emits a showinfo/metadata line per
// selected frame carrying its presentation timestamp.
function detectCuts(file) {
  const res = spawnCapture(FFMPEG, [
    '-hide_banner',
    '-i', file,
    '-filter:v', `select='gt(scene,${SCENE_THRESHOLD})',showinfo`,
    '-f', 'null', '-',
  ]);
  const stderr = res.stderr;
  const times = [];
  const re = /pts_time:([0-9.]+)/g;
  let m;
  while ((m = re.exec(stderr)) !== null) {
    times.push(parseFloat(m[1]));
  }
  return times;
}

function spawnCapture(bin, args) {
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 1 << 28 });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
}

// Per-frame global motion signal: extract the mean absolute luma delta between
// consecutive frames at a downsampled rate. This is a robust proxy for
// camera translation and zoom activity without depending on codec motion vectors.
function frameDeltaSignal(file, sampleFps) {
  const res = spawnCapture(FFMPEG, [
    '-hide_banner',
    '-i', file,
    '-filter:v', `fps=${sampleFps},scale=64:36,tblend=all_mode=difference,signalstats,metadata=print`,
    '-f', 'null', '-',
  ]);
  const deltas = [];
  const re = /lavfi\.signalstats\.YAVG=([0-9.]+)/g;
  let m;
  while ((m = re.exec(res.stderr)) !== null) {
    deltas.push(parseFloat(m[1]) / 255); // normalize 0..1
  }
  return deltas;
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

// Build a 5-column contact sheet of representative frames (one per detected shot,
// capped) so a human can eyeball cutting cadence.
function contactSheet(file, cutTimes, duration, outPath) {
  const tmp = mkdtempSync(join(tmpdir(), 'shots-'));
  try {
    // Sample one frame at the midpoint of each shot (bounded to <=40 tiles).
    const bounds = [0, ...cutTimes, duration];
    const mids = [];
    for (let i = 0; i < bounds.length - 1; i++) {
      mids.push((bounds[i] + bounds[i + 1]) / 2);
    }
    const step = Math.max(1, Math.ceil(mids.length / 40));
    const picked = mids.filter((_, i) => i % step === 0).slice(0, 40);
    let idx = 0;
    for (const t of picked) {
      spawnCapture(FFMPEG, [
        '-hide_banner', '-y',
        '-ss', String(t.toFixed(3)),
        '-i', file,
        '-frames:v', '1',
        '-vf', 'scale=160:-1',
        join(tmp, `f${String(idx).padStart(3, '0')}.jpg`),
      ]);
      idx++;
    }
    const files = readdirSync(tmp).filter((f) => f.endsWith('.jpg')).sort();
    if (!files.length) return 0;
    // Tile with ffmpeg
    spawnCapture(FFMPEG, [
      '-hide_banner', '-y',
      '-framerate', '1',
      '-pattern_type', 'glob',
      '-i', join(tmp, 'f*.jpg'),
      '-vf', 'tile=5x8:padding=4:color=black',
      '-frames:v', '1',
      outPath,
    ]);
    return files.length;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function analyzeOne(v) {
  const file = join(COMP_DIR, v.file);
  const probe = ffprobeJson(file);
  const stream = probe.streams[0];
  const duration = parseFloat(probe.format.duration);
  const fps = parseFps(stream.avg_frame_rate) || parseFps(stream.r_frame_rate);
  const resolution = `${stream.width}x${stream.height}`;

  const cutTimes = detectCuts(file);
  // shot count = cuts + 1 (first shot has no leading cut)
  const shotCount = cutTimes.length + 1;
  const bounds = [0, ...cutTimes, duration];
  const shotLengths = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    shotLengths.push(bounds[i + 1] - bounds[i]);
  }
  const shotsUnder2s = shotLengths.filter((l) => l < 2.0).length;

  const sampleFps = Math.min(fps || 30, 30);
  const deltas = frameDeltaSignal(file, sampleFps);
  const translateFrames = deltas.filter((d) => d > TRANSLATE_THRESHOLD).length;
  const zoomFrames = deltas.filter((d) => d > ZOOM_THRESHOLD).length;

  const sheetPath = join(OUT_DIR, `${v.name}-shots.jpg`);
  const tiles = contactSheet(file, cutTimes, duration, sheetPath);

  return {
    name: v.name,
    file: v.file,
    durationSec: Number(duration.toFixed(3)),
    resolution,
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
    contactSheetTiles: tiles,
    cutTimesSec: cutTimes.map((t) => Number(t.toFixed(3))),
  };
}

function main() {
  const results = VIDEOS.map((v) => {
    process.stderr.write(`[visual] analyzing ${v.name}...\n`);
    return analyzeOne(v);
  });
  const summary = {
    generatedAt: new Date().toISOString(),
    sceneThreshold: SCENE_THRESHOLD,
    translateThreshold: TRANSLATE_THRESHOLD,
    zoomThreshold: ZOOM_THRESHOLD,
    ffmpeg: FFMPEG,
    ffprobe: FFPROBE,
    videos: results,
  };
  writeFileSync(join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
  process.stderr.write(`[visual] wrote ${join(OUT_DIR, 'summary.json')}\n`);
  for (const r of results) {
    process.stderr.write(
      `[visual] ${r.name}: ${r.durationSec}s ${r.resolution}@${r.fps} cuts=${r.cutCount} shots=${r.shotCount} avg=${r.avgShotLengthSec}s median=${r.medianShotLengthSec}s\n`
    );
  }
}

main();
