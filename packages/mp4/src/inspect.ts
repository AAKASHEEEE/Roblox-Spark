// Minimal MP4 inspector (ffprobe substitute for this offline sandbox and for automated tests).
export interface BoxInfo { type: string; start: number; size: number; children?: BoxInfo[] }
export interface TrackInfo {
  handler: string;
  codec: string;
  timescale: number;
  duration: number;
  durationSec: number;
  sampleCount: number;
  sampleDurations: number[];
  keyframes?: number[];
  width?: number;
  height?: number;
  channels?: number;
  sampleRate?: number;
  editMediaTime?: number;
  /** presented duration from the edit list (seconds) */
  editDurationSec?: number;
}
export interface Mp4Info { brands: string; durationSec: number; tracks: TrackInfo[]; boxes: BoxInfo[]; fastStart: boolean }

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf']);
const dec = new TextDecoder();

function parse(buf: Uint8Array, start: number, end: number): BoxInfo[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out: BoxInfo[] = [];
  let o = start;
  while (o + 8 <= end) {
    let size = dv.getUint32(o);
    const type = dec.decode(buf.subarray(o + 4, o + 8));
    if (size === 1) size = Number(dv.getBigUint64(o + 8));
    if (size === 0) size = end - o;
    if (size < 8 || o + size > end) throw new Error(`corrupt box ${type} at ${o} size ${size}`);
    const b: BoxInfo = { type, start: o, size };
    if (CONTAINERS.has(type)) b.children = parse(buf, o + 8, o + size);
    out.push(b);
    o += size;
  }
  return out;
}
const find = (bs: BoxInfo[] | undefined, t: string): BoxInfo | undefined => bs?.find((b) => b.type === t);

export function inspectMp4(buf: Uint8Array): Mp4Info {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const boxes = parse(buf, 0, buf.length);
  const ftyp = find(boxes, 'ftyp');
  const brands = ftyp ? dec.decode(buf.subarray(ftyp.start + 8, ftyp.start + ftyp.size)).replace(/[^\x20-\x7e]/g, '.') : '';
  const moov = find(boxes, 'moov');
  if (!moov) throw new Error('no moov');
  const mvhd = find(moov.children, 'mvhd')!;
  const mts = dv.getUint32(mvhd.start + 20), mdur = dv.getUint32(mvhd.start + 24);
  const tracks: TrackInfo[] = [];
  for (const trak of moov.children!.filter((b) => b.type === 'trak')) {
    const mdia = find(trak.children, 'mdia')!;
    const mdhd = find(mdia.children, 'mdhd')!;
    const hdlr = find(mdia.children, 'hdlr')!;
    const stbl = find(find(mdia.children, 'minf')!.children, 'stbl')!;
    const stsd = find(stbl.children, 'stsd')!;
    const entry = stsd.start + 16;
    const codec = dec.decode(buf.subarray(entry + 4, entry + 8));
    const t: TrackInfo = {
      handler: dec.decode(buf.subarray(hdlr.start + 16, hdlr.start + 20)),
      codec,
      timescale: dv.getUint32(mdhd.start + 20),
      duration: dv.getUint32(mdhd.start + 24),
      durationSec: 0, sampleCount: 0, sampleDurations: [],
    };
    t.durationSec = t.duration / t.timescale;
    const sttsB = find(stbl.children, 'stts')!;
    const n = dv.getUint32(sttsB.start + 12);
    for (let i = 0; i < n; i++) {
      const c = dv.getUint32(sttsB.start + 16 + i * 8), d = dv.getUint32(sttsB.start + 20 + i * 8);
      for (let k = 0; k < c; k++) t.sampleDurations.push(d);
    }
    const stszB = find(stbl.children, 'stsz')!;
    t.sampleCount = dv.getUint32(stszB.start + 16);
    if (t.handler === 'vide') {
      t.width = dv.getUint16(entry + 32); t.height = dv.getUint16(entry + 34);
      const stss = find(stbl.children, 'stss');
      if (stss) { t.keyframes = []; const k = dv.getUint32(stss.start + 12); for (let i = 0; i < k; i++) t.keyframes.push(dv.getUint32(stss.start + 16 + i * 4)); }
    } else if (t.handler === 'soun') {
      t.channels = dv.getUint16(entry + 24); t.sampleRate = dv.getUint32(entry + 32) / 65536;
    }
    const edts = find(trak.children, 'edts');
    if (edts) { const elst = find(edts.children, 'elst'); if (elst) { t.editMediaTime = dv.getInt32(elst.start + 20); t.editDurationSec = dv.getUint32(elst.start + 16) / mts; } }
    tracks.push(t);
  }
  const mdat = find(boxes, 'mdat');
  return { brands, durationSec: mdur / mts, tracks, boxes, fastStart: !!mdat && moov.start < mdat.start };
}
