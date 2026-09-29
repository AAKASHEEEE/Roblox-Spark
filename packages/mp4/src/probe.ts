// Production-output probing. Uses real ffprobe when available (FFPROBE_PATH or `ffprobe` on PATH, as in the Docker
// image); otherwise a built-in ISO-BMFF / avcC / esds parser producing the same ffprobe-JSON subset. The production
// profile check is identical for both, and FAILS on Opus audio (production requires AAC-LC).
import { inspectMp4 } from './inspect.ts';
import { parseAvcC } from './h264.ts';

export interface ProbeStream {
  index: number; codec_type: 'video' | 'audio' | 'other'; codec_name: string; profile?: string;
  width?: number; height?: number; pix_fmt?: string; r_frame_rate?: string; avg_frame_rate?: string;
  sample_rate?: string; channels?: number; duration?: string; nb_frames?: string; level?: number;
}
export interface ProbeResult { tool: 'ffprobe' | 'builtin'; format: { format_name: string; duration: string; size: string; faststart: boolean; major_brand?: string }; streams: ProbeStream[]; notes: string[] }

const dec = new TextDecoder();

function findBox(buf: Uint8Array, start: number, end: number, type: string): { start: number; size: number } | null {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let o = start; o + 8 <= end;) {
    const size = dv.getUint32(o); const t = dec.decode(buf.subarray(o + 4, o + 8));
    if (size < 8) return null;
    if (t === type) return { start: o, size };
    o += size;
  }
  return null;
}
function path(buf: Uint8Array, s: number, e: number, types: string[]): { start: number; size: number } | null {
  let cur = { start: s - 8, size: e - s + 8 };
  for (const t of types) { const b = findBox(buf, cur.start + 8, cur.start + cur.size, t); if (!b) return null; cur = b; }
  return cur;
}
/** parse an MPEG-4 descriptor at o: returns tag, payload start, payload length */
function descAt(buf: Uint8Array, o: number): { tag: number; p: number; len: number } {
  const tag = buf[o]; let len = 0, i = o + 1;
  for (let k = 0; k < 4; k++) { const b = buf[i++]; len = (len << 7) | (b & 0x7f); if (!(b & 0x80)) break; }
  return { tag, p: i, len };
}
const AOT: Record<number, string> = { 1: 'Main', 2: 'LC', 3: 'SSR', 4: 'LTP', 5: 'HE-AAC', 29: 'HE-AACv2' };
const SR = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

export function probeBuiltin(bytes: Uint8Array): ProbeResult {
  const info = inspectMp4(bytes);
  const notes = ['ffprobe not available: built-in ISO-BMFF/avcC/esds parser used'];
  const moov = info.boxes.find((b) => b.type === 'moov')!;
  const traks = moov.children!.filter((b) => b.type === 'trak');
  const streams: ProbeStream[] = [];
  info.tracks.forEach((t, i) => {
    const trak = traks[i];
    const stsd = path(bytes, trak.start + 8, trak.start + trak.size, ['mdia', 'minf', 'stbl', 'stsd'])!;
    const entry = stsd.start + 16; const entrySize = new DataView(bytes.buffer, bytes.byteOffset).getUint32(entry);
    if (t.handler === 'vide') {
      const s: ProbeStream = { index: i, codec_type: 'video', codec_name: t.codec === 'avc1' ? 'h264' : t.codec, width: t.width, height: t.height, nb_frames: String(t.sampleCount), duration: t.durationSec.toFixed(6) };
      const avcC = findBox(bytes, entry + 86, entry + entrySize, 'avcC');
      if (avcC) {
        const { sps } = parseAvcC(bytes.subarray(avcC.start + 8, avcC.start + avcC.size));
        s.profile = sps.profile; s.pix_fmt = sps.pixFmt; s.level = sps.levelIdc;
        if (sps.width !== t.width || sps.height !== t.height) notes.push(`SPS size ${sps.width}x${sps.height} differs from track header ${t.width}x${t.height}`);
      }
      const d = [...new Set(t.sampleDurations)];
      const fps = d.length === 1 ? `${t.timescale / gcd(t.timescale, d[0])}/${d[0] / gcd(t.timescale, d[0])}` : 'variable';
      s.r_frame_rate = fps; s.avg_frame_rate = d.length === 1 ? fps : `${t.sampleCount * t.timescale}/${t.duration}`;
      streams.push(s);
    } else if (t.handler === 'soun') {
      const s: ProbeStream = { index: i, codec_type: 'audio', codec_name: t.codec === 'mp4a' ? 'aac' : t.codec === 'Opus' ? 'opus' : t.codec, channels: t.channels, sample_rate: String(t.sampleRate), nb_frames: String(t.sampleCount), duration: (t.editDurationSec ?? (t.duration - (t.editMediaTime ?? 0)) / t.timescale).toFixed(6) };
      if (t.codec === 'mp4a') {
        const esds = findBox(bytes, entry + 36, entry + entrySize, 'esds');
        if (esds) {
          let d = descAt(bytes, esds.start + 12);
          if (d.tag === 3) { const flags = bytes[d.p + 2]; let p = d.p + 3 + (flags & 0x80 ? 2 : 0) + (flags & 0x40 ? 1 + bytes[d.p + 3] : 0) + (flags & 0x20 ? 2 : 0); d = descAt(bytes, p); }
          if (d.tag === 4) {
            const oti = bytes[d.p];
            const dsi = descAt(bytes, d.p + 13);
            if (oti === 0x40 && dsi.tag === 5) {
              const a = bytes[dsi.p], b = bytes[dsi.p + 1];
              const aot = a >> 3, sfi = ((a & 7) << 1) | (b >> 7), ch = (b >> 3) & 15;
              s.profile = AOT[aot] ?? `aot_${aot}`; s.sample_rate = String(SR[sfi] ?? 0); s.channels = ch;
            } else notes.push(`esds objectTypeIndication 0x${oti.toString(16)}`);
          }
        }
      }
      streams.push(s);
    }
  });
  return { tool: 'builtin', format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: info.durationSec.toFixed(6), size: String(bytes.length), faststart: info.fastStart, major_brand: info.brands.slice(0, 4) }, streams, notes };
}
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

export interface ProductionSpec { width: number; height: number; fps: string; videoCodec: string; pixFmt: string; audioCodec: string; audioProfile: string; sampleRate: number; channels: number; maxAvDriftSec: number; durationRange: [number, number] }
export const PRODUCTION_SPEC: ProductionSpec = { width: 1080, height: 1920, fps: '30/1', videoCodec: 'h264', pixFmt: 'yuv420p', audioCodec: 'aac', audioProfile: 'LC', sampleRate: 48000, channels: 2, maxAvDriftSec: 1 / 30, durationRange: [14, 22] };

export interface ProfileCheck { ok: boolean; tool: string; errors: string[]; checks: Array<{ name: string; ok: boolean; got: string; want: string }> }

export function checkProductionProfile(p: ProbeResult, spec: ProductionSpec = PRODUCTION_SPEC): ProfileCheck {
  const checks: ProfileCheck['checks'] = [];
  const c = (name: string, ok: boolean, got: unknown, want: unknown) => checks.push({ name, ok, got: String(got), want: String(want) });
  const v = p.streams.filter((s) => s.codec_type === 'video'), a = p.streams.filter((s) => s.codec_type === 'audio');
  c('container', p.format.format_name.includes('mp4'), p.format.format_name, 'mp4');
  c('fast-start (moov before mdat)', p.format.faststart, p.format.faststart, true);
  c('exactly one video stream', v.length === 1, v.length, 1);
  c('exactly one audio stream', a.length === 1, a.length, 1);
  const vs = v[0], as = a[0];
  if (vs) {
    c('video codec', vs.codec_name === spec.videoCodec, vs.codec_name, spec.videoCodec);
    c('pixel format', vs.pix_fmt === spec.pixFmt, vs.pix_fmt, spec.pixFmt);
    c('resolution', vs.width === spec.width && vs.height === spec.height, `${vs.width}x${vs.height}`, `${spec.width}x${spec.height}`);
    c('constant frame rate', vs.r_frame_rate === spec.fps && vs.avg_frame_rate === spec.fps, `${vs.r_frame_rate} (avg ${vs.avg_frame_rate})`, spec.fps);
    const d = Number(vs.duration);
    c('duration', d >= spec.durationRange[0] && d <= spec.durationRange[1], d.toFixed(3), `${spec.durationRange[0]}-${spec.durationRange[1]} s`);
  }
  if (as) {
    c('audio codec', as.codec_name === spec.audioCodec, as.codec_name, spec.audioCodec);
    c('audio profile', as.profile === spec.audioProfile, as.profile, spec.audioProfile);
    c('audio sample rate', Number(as.sample_rate) === spec.sampleRate, as.sample_rate, spec.sampleRate);
    c('audio channels', as.channels === spec.channels, as.channels, spec.channels);
  }
  if (vs && as) { const drift = Math.abs(Number(vs.duration) - Number(as.duration)); c('A/V duration match', drift <= spec.maxAvDriftSec, `${(drift * 1000).toFixed(1)} ms`, `<= ${(spec.maxAvDriftSec * 1000).toFixed(1)} ms`); }
  const errors = checks.filter((x) => !x.ok).map((x) => `${x.name}: got ${x.got}, want ${x.want}`);
  return { ok: errors.length === 0, tool: p.tool, errors, checks };
}
