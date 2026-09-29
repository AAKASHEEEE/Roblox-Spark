// Node-side probing: real ffprobe when installed (FFPROBE_PATH or PATH), built-in parser otherwise.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { inspectMp4 } from '../../../packages/mp4/src/inspect.ts';
import { probeBuiltin, type ProbeResult } from '../../../packages/mp4/src/probe.ts';

export function ffprobeAvailable(): boolean {
  try { execFileSync(process.env.FFPROBE_PATH ?? 'ffprobe', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

/** Run real ffprobe if present. Returns null when ffprobe is not installed. */
export function probeWithFfprobe(file: string): ProbeResult | null {
  const bin = process.env.FFPROBE_PATH ?? 'ffprobe';
  let out: string;
  try { out = execFileSync(bin, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { encoding: 'utf8' }); }
  catch (e: any) { if (e.code === 'ENOENT') return null; throw e; }
  return fromFfprobeJson(JSON.parse(out), new Uint8Array(readFileSync(file)));
}

/** Map ffprobe's JSON (-show_format -show_streams) to our ProbeResult (fast-start comes from the box order). */
export function fromFfprobeJson(j: any, bytes: Uint8Array): ProbeResult {
  return {
    tool: 'ffprobe',
    format: { format_name: j.format.format_name, duration: j.format.duration, size: j.format.size, faststart: inspectMp4(bytes).fastStart, major_brand: j.format.tags?.major_brand },
    streams: j.streams.map((s: any) => ({ index: s.index, codec_type: s.codec_type, codec_name: s.codec_name, profile: s.profile, width: s.width, height: s.height, pix_fmt: s.pix_fmt, r_frame_rate: s.r_frame_rate, avg_frame_rate: s.avg_frame_rate, sample_rate: s.sample_rate, channels: s.channels, duration: s.duration, nb_frames: s.nb_frames, level: s.level })),
    notes: [],
  };
}

export function probeFile(file: string): ProbeResult {
  return probeWithFfprobe(file) ?? probeBuiltin(new Uint8Array(readFileSync(file)));
}
