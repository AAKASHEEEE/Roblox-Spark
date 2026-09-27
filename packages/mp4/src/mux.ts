// Dependency-free ISO-BMFF (MP4) muxer for H.264 (avc1/avcC) video + Opus (dOps) audio.
// Writes a "fast-start" file (moov before mdat) with fully deterministic output (zeroed timestamps).

export interface VideoSample { data: Uint8Array; duration: number; isKey: boolean }
export interface AudioSample { data: Uint8Array; duration: number }

export interface ColorInfo { primaries: number; transfer: number; matrix: number; fullRange: boolean }

export interface MuxInput {
  video: {
    width: number;
    height: number;
    timescale: number;
    /** avcC (AVCDecoderConfigurationRecord) from VideoEncoder metadata.decoderConfig.description */
    avcC: Uint8Array;
    samples: VideoSample[];
    color?: ColorInfo;
  };
  audio?: {
    sampleRate: number; // Opus is always 48000 in MP4
    channels: number;
    preSkip: number;
    inputSampleRate: number;
    samples: AudioSample[];
  };
}

const enc = new TextEncoder();

class W {
  parts: Uint8Array[] = [];
  size = 0;
  bytes(b: Uint8Array): this { this.parts.push(b); this.size += b.length; return this; }
  u8(v: number): this { return this.bytes(new Uint8Array([v & 255])); }
  u16(v: number): this { return this.bytes(new Uint8Array([(v >> 8) & 255, v & 255])); }
  u32(v: number): this { return this.bytes(new Uint8Array([(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255])); }
  i16(v: number): this { return this.u16(v < 0 ? v + 65536 : v); }
  str(s: string): this { return this.bytes(enc.encode(s)); }
  zeros(n: number): this { return this.bytes(new Uint8Array(n)); }
  out(): Uint8Array {
    const o = new Uint8Array(this.size);
    let off = 0;
    for (const p of this.parts) { o.set(p, off); off += p.length; }
    return o;
  }
}

function box(type: string, ...children: Uint8Array[]): Uint8Array {
  const w = new W();
  const size = 8 + children.reduce((a, c) => a + c.length, 0);
  w.u32(size).str(type);
  for (const c of children) w.bytes(c);
  return w.out();
}
function fullBox(type: string, version: number, flags: number, ...children: Uint8Array[]): Uint8Array {
  const h = new W().u8(version).u8(flags >> 16).u8(flags >> 8).u8(flags).out();
  return box(type, h, ...children);
}
const MATRIX = (() => {
  const w = new W();
  [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000].forEach((v) => w.u32(v));
  return w.out();
})();

function stts(samples: Array<{ duration: number }>): Uint8Array {
  const runs: Array<[number, number]> = [];
  for (const s of samples) {
    const last = runs[runs.length - 1];
    if (last && last[1] === s.duration) last[0]++;
    else runs.push([1, s.duration]);
  }
  const w = new W().u32(runs.length);
  for (const [c, d] of runs) w.u32(c).u32(d);
  return fullBox('stts', 0, 0, w.out());
}
function stsz(samples: Array<{ data: Uint8Array }>): Uint8Array {
  const w = new W().u32(0).u32(samples.length);
  for (const s of samples) w.u32(s.data.length);
  return fullBox('stsz', 0, 0, w.out());
}
function stco(offsets: number[]): Uint8Array {
  const w = new W().u32(offsets.length);
  for (const o of offsets) w.u32(o);
  return fullBox('stco', 0, 0, w.out());
}
const stsc1 = (): Uint8Array => fullBox('stsc', 0, 0, new W().u32(1).u32(1).u32(1).u32(1).out());
const dinf = (): Uint8Array => box('dinf', fullBox('dref', 0, 0, new W().u32(1).out(), fullBox('url ', 0, 1)));
function hdlr(type: string, name: string): Uint8Array {
  return fullBox('hdlr', 0, 0, new W().u32(0).str(type).zeros(12).str(name).u8(0).out());
}
function mdhd(timescale: number, duration: number): Uint8Array {
  return fullBox('mdhd', 0, 0, new W().u32(0).u32(0).u32(timescale).u32(duration).u16(0x55c4).u16(0).out());
}
function tkhd(id: number, duration: number, width: number, height: number, audio: boolean): Uint8Array {
  const w = new W().u32(0).u32(0).u32(id).u32(0).u32(duration).zeros(8).u16(0).u16(audio ? 1 : 0).u16(audio ? 0x0100 : 0).u16(0)
    .bytes(MATRIX).u32(width * 65536).u32(height * 65536);
  return fullBox('tkhd', 0, 3, w.out());
}

function avc1(v: MuxInput['video']): Uint8Array {
  const w = new W().zeros(6).u16(1).zeros(16).u16(v.width).u16(v.height).u32(0x00480000).u32(0x00480000).u32(0).u16(1);
  const name = 'RBLX SPARK H.264';
  w.u8(name.length).str(name).zeros(31 - name.length).u16(0x0018).i16(-1);
  const kids: Uint8Array[] = [box('avcC', v.avcC)];
  if (v.color) {
    const c = v.color;
    kids.push(box('colr', new W().str('nclx').u16(c.primaries).u16(c.transfer).u16(c.matrix).u8(c.fullRange ? 0x80 : 0).out()));
  }
  kids.push(box('pasp', new W().u32(1).u32(1).out()));
  return box('avc1', w.out(), ...kids);
}
function opusEntry(a: NonNullable<MuxInput['audio']>): Uint8Array {
  const w = new W().zeros(6).u16(1).zeros(8).u16(a.channels).u16(16).u16(0).u16(0).u32(a.sampleRate * 65536);
  const dOps = box('dOps', new W().u8(0).u8(a.channels).u16(a.preSkip).u32(a.inputSampleRate).i16(0).u8(0).out());
  return box('Opus', w.out(), dOps);
}

export function muxMp4(input: MuxInput): Uint8Array {
  const v = input.video, a = input.audio;
  const MOVIE_TS = 1000;
  const vDur = v.samples.reduce((s, x) => s + x.duration, 0);
  const aDur = a ? a.samples.reduce((s, x) => s + x.duration, 0) : 0;
  const vMovieDur = Math.round((vDur / v.timescale) * MOVIE_TS);
  const aMovieDur = a ? Math.round(((aDur - a.preSkip) / a.sampleRate) * MOVIE_TS) : 0;

  const build = (mdatStart: number): Uint8Array => {
    // interleave-free layout: all video samples, then all audio samples
    let off = mdatStart;
    const vOff = v.samples.map((s) => { const o = off; off += s.data.length; return o; });
    const aOff = a ? a.samples.map((s) => { const o = off; off += s.data.length; return o; }) : [];
    const keyIdx: number[] = [];
    v.samples.forEach((s, i) => { if (s.isKey) keyIdx.push(i + 1); });
    const stss = fullBox('stss', 0, 0, (() => { const w = new W().u32(keyIdx.length); keyIdx.forEach((k) => w.u32(k)); return w.out(); })());
    const vTrak = box('trak',
      tkhd(1, vMovieDur, v.width, v.height, false),
      box('mdia', mdhd(v.timescale, vDur), hdlr('vide', 'SparkVideo'),
        box('minf', fullBox('vmhd', 0, 1, new W().zeros(8).out()), dinf(),
          box('stbl', fullBox('stsd', 0, 0, new W().u32(1).out(), avc1(v)), stts(v.samples), stss, stsc1(), stsz(v.samples), stco(vOff)))));
    const traks = [vTrak];
    if (a) {
      const elst = box('edts', fullBox('elst', 0, 0, new W().u32(1).u32(aMovieDur).u32(a.preSkip).u16(1).u16(0).out()));
      traks.push(box('trak',
        tkhd(2, aMovieDur, 0, 0, true), elst,
        box('mdia', mdhd(a.sampleRate, aDur), hdlr('soun', 'SparkAudio'),
          box('minf', fullBox('smhd', 0, 0, new W().u32(0).out()), dinf(),
            box('stbl', fullBox('stsd', 0, 0, new W().u32(1).out(), opusEntry(a)), stts(a.samples), stsc1(), stsz(a.samples), stco(aOff))))));
    }
    const mvhd = fullBox('mvhd', 0, 0, new W().u32(0).u32(0).u32(MOVIE_TS).u32(Math.max(vMovieDur, aMovieDur))
      .u32(0x00010000).u16(0x0100).zeros(10).bytes(MATRIX).zeros(24).u32(a ? 3 : 2).out());
    return box('moov', mvhd, ...traks);
  };

  const ftyp = box('ftyp', new W().str('isom').u32(0x200).str('isom').str('iso2').str('avc1').str('mp41').out());
  const payload = v.samples.reduce((s, x) => s + x.data.length, 0) + (a ? a.samples.reduce((s, x) => s + x.data.length, 0) : 0);
  const moovSize = build(0).length; // offsets don't change moov size (stco is fixed width)
  const mdatStart = ftyp.length + moovSize + 8;
  const moov = build(mdatStart);
  const out = new Uint8Array(ftyp.length + moov.length + 8 + payload);
  out.set(ftyp, 0); out.set(moov, ftyp.length);
  let o = ftyp.length + moov.length;
  const dv = new DataView(out.buffer);
  dv.setUint32(o, 8 + payload); out.set(enc.encode('mdat'), o + 4); o += 8;
  for (const s of v.samples) { out.set(s.data, o); o += s.data.length; }
  if (a) for (const s of a.samples) { out.set(s.data, o); o += s.data.length; }
  return out;
}
