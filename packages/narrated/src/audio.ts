// Uploaded voice-over: pure (DOM/Node-free) container sniffing, filename policy and a native RIFF/WAVE decoder.
// Compressed formats (MP3/M4A) are decoded by FFmpeg in apps/studio/narrated-audio.ts; this module decides what is
// acceptable. Nothing here trusts the extension alone: the bytes must match the declared format.
import { AUDIO_FORMATS } from './schema.ts';

export type AudioFormat = (typeof AUDIO_FORMATS)[number];
export const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;
export const AUDIO_DURATION_LIMITS = { min: 1, max: 300, targetMin: 35, targetMax: 60 } as const;
/** codecs accepted per container (as reported by the decoder) */
export const ALLOWED_CODECS: Readonly<Record<AudioFormat, readonly string[]>> = { wav: ['pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_f32le'], mp3: ['mp3'], m4a: ['aac', 'alac'] };

export interface DecodedAudio { format: AudioFormat; codec: string; sampleRate: number; channels: number; durationSeconds: number; /** mono analysis signal */ pcm: Float32Array; analysisRate: number }
export class AudioRejection extends Error { code: string; constructor(code: string, message: string) { super(message); this.code = code; } }

/** safe display filename (never used as a path): basename only, conservative charset, allowed extension */
export function checkFilename(name: unknown): { filename: string; format: AudioFormat } {
  if (typeof name !== 'string' || !name.length || name.length > 120) throw new AudioRejection('BAD_FILENAME', 'filename missing or longer than 120 characters');
  if (/[\/\\]|\.\.|[\x00-\x1f\x7f]/.test(name) || name.startsWith('.')) throw new AudioRejection('BAD_FILENAME', 'filename must be a plain name (no path, "..", hidden or control characters)');
  if (!/^[A-Za-z0-9 _()+,\-.]+$/.test(name)) throw new AudioRejection('BAD_FILENAME', 'filename may only contain letters, digits, spaces and _ ( ) + , - .');
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (!(AUDIO_FORMATS as readonly string[]).includes(ext)) throw new AudioRejection('BAD_EXTENSION', `unsupported file type ".${ext}" (allowed: ${AUDIO_FORMATS.join(', ')})`);
  return { filename: name, format: ext as AudioFormat };
}

const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));
/** container sniffing by magic bytes; rejects executables/scripts/archives whatever their extension */
export function sniffFormat(b: Uint8Array): AudioFormat | null {
  if (b.length < 12) return null;
  const head = ascii(b, 0, 4);
  if (head.startsWith('MZ') || head === '\x7fELF' || head.startsWith('#!') || head === 'PK\x03\x04' || head === '%PDF' || head === '\xca\xfe\xba\xbe' || head === '\xcf\xfa\xed\xfe' || /^\s*</.test(ascii(b, 0, 12))) throw new AudioRejection('EXECUTABLE_CONTENT', 'the file is an executable, script, archive or document, not audio');
  if (head === 'RIFF' && ascii(b, 8, 4) === 'WAVE') return 'wav';
  if (ascii(b, 4, 4) === 'ftyp' && /^(M4A |M4B |mp42|mp41|isom|iso2|dash)$/.test(ascii(b, 8, 4))) return 'm4a';
  if (ascii(b, 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && (b[1] & 0x06) !== 0)) return 'mp3';
  return null;
}
export function checkContainer(b: Uint8Array, declared: AudioFormat): void {
  if (!b.length) throw new AudioRejection('EMPTY_FILE', 'the uploaded file is empty');
  if (b.length > MAX_UPLOAD_BYTES) throw new AudioRejection('TOO_LARGE', `the upload exceeds ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
  const actual = sniffFormat(b);
  if (!actual) throw new AudioRejection('UNKNOWN_FORMAT', 'the file content is not a recognised WAV, MP3 or M4A container');
  if (actual !== declared) throw new AudioRejection('FORMAT_MISMATCH', `the file is named .${declared} but its content is ${actual.toUpperCase()}`);
}
export function checkDecoded(a: DecodedAudio): void {
  if (!ALLOWED_CODECS[a.format].includes(a.codec)) throw new AudioRejection('UNSUPPORTED_CODEC', `codec "${a.codec}" is not allowed in a .${a.format} file (allowed: ${ALLOWED_CODECS[a.format].join(', ')})`);
  if (!(a.sampleRate >= 8000 && a.sampleRate <= 192000)) throw new AudioRejection('BAD_SAMPLE_RATE', `unsupported sample rate ${a.sampleRate} Hz`);
  if (!(a.channels >= 1 && a.channels <= 8)) throw new AudioRejection('BAD_CHANNELS', `unsupported channel count ${a.channels}`);
  if (!(a.durationSeconds >= AUDIO_DURATION_LIMITS.min && a.durationSeconds <= AUDIO_DURATION_LIMITS.max)) throw new AudioRejection('BAD_DURATION', `audio must be ${AUDIO_DURATION_LIMITS.min}-${AUDIO_DURATION_LIMITS.max} s (got ${a.durationSeconds.toFixed(2)} s)`);
  if (!a.pcm.length) throw new AudioRejection('NOT_DECODABLE', 'no audio samples decoded');
}

/** RIFF/WAVE: PCM 16/24/32-bit or IEEE float 32 (also WAVE_FORMAT_EXTENSIBLE with those subformats), downmixed to mono */
export function decodeWav(b: Uint8Array): DecodedAudio {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let off = 12, fmt: { tag: number; ch: number; sr: number; bits: number } | null = null, data: { at: number; len: number } | null = null;
  while (off + 8 <= b.length) {
    const id = ascii(b, off, 4), len = dv.getUint32(off + 4, true), body = off + 8;
    if (id === 'fmt ' && len >= 16 && body + 16 <= b.length) {
      let tag = dv.getUint16(body, true);
      if (tag === 0xfffe && len >= 40) tag = dv.getUint16(body + 24, true); // extensible: first two bytes of the subformat GUID
      fmt = { tag, ch: dv.getUint16(body + 2, true), sr: dv.getUint32(body + 4, true), bits: dv.getUint16(body + 14, true) };
    } else if (id === 'data') { data = { at: body, len: Math.min(len, b.length - body) }; break; }
    off = body + len + (len & 1);
  }
  if (!fmt || !data) throw new AudioRejection('NOT_DECODABLE', 'WAV file has no fmt or data chunk');
  const codec = fmt.tag === 1 && [16, 24, 32].includes(fmt.bits) ? `pcm_s${fmt.bits}le` : fmt.tag === 3 && fmt.bits === 32 ? 'pcm_f32le' : `wav_tag_${fmt.tag}_${fmt.bits}bit`;
  if (!ALLOWED_CODECS.wav.includes(codec)) throw new AudioRejection('UNSUPPORTED_CODEC', `WAV codec ${codec} is not supported (PCM 16/24/32-bit or float 32 only)`);
  if (!fmt.ch || fmt.ch > 8 || !fmt.sr) throw new AudioRejection('NOT_DECODABLE', 'WAV header has an invalid channel count or sample rate');
  const bps = fmt.bits / 8, frame = bps * fmt.ch, n = Math.floor(data.len / frame);
  const pcm = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < fmt.ch; c++) {
      const p = data.at + i * frame + c * bps;
      s += codec === 'pcm_s16le' ? dv.getInt16(p, true) / 32768 : codec === 'pcm_f32le' ? dv.getFloat32(p, true)
        : codec === 'pcm_s32le' ? dv.getInt32(p, true) / 2147483648 : ((dv.getUint8(p) | (dv.getUint8(p + 1) << 8) | (dv.getInt8(p + 2) << 16)) / 8388608);
    }
    pcm[i] = s / fmt.ch;
  }
  return { format: 'wav', codec, sampleRate: fmt.sr, channels: fmt.ch, durationSeconds: Math.round((n / fmt.sr) * 1000) / 1000, pcm, analysisRate: fmt.sr };
}

/** 16-bit PCM WAV writer (tests generate tiny tone/silence fixtures with it) */
export function encodeWav16(mono: Float32Array, sampleRate: number): Uint8Array {
  const out = new Uint8Array(44 + mono.length * 2), dv = new DataView(out.buffer);
  const w = (at: number, s: string) => { for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + mono.length * 2, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  w(36, 'data'); dv.setUint32(40, mono.length * 2, true);
  for (let i = 0; i < mono.length; i++) dv.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(mono[i] * 32767))), true);
  return out;
}
