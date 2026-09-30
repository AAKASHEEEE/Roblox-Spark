// 10 s mix test (S7): voice-over + the beat sheet's SFX events for a window of the approved narrated script, NO music.
//   node packages/audio-mix/tools/mix-test.ts [--start 4.5] [--duration 10] [--vo voice.wav] [--out <file.wav>]
// Without --vo the aligned phrases are spoken by the stand-in synthesiser (tools/test-voice.ts). Writes a 48 kHz 24-bit
// stereo WAV and <file>.report.json, then re-reads the WAV and re-measures loudness / true peak from the file itself.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { ROOT } from '../../../apps/render-worker/lib/server.ts';
import { loadLibrary } from '../../../apps/render-worker/lib/library.ts';
import { integratedLoudness } from '../../audio/src/mix.ts';
import { truePeakDbtp, resampleTo48k } from '../../narrated/src/mixdown.ts';
import { mixVoiceSfx, mixPlanFromBeatSheet, encodeWavStereo, decodeWavStereo, SR } from '../src/index.ts';
import { synthVoice } from './test-voice.ts';

const { values: a } = parseArgs({ options: { start: { type: 'string', default: '4.5' }, duration: { type: 'string', default: '10' }, vo: { type: 'string' }, out: { type: 'string' }, beats: { type: 'string', default: 'packages/director/fixtures/free-coins-classroom.beats.json' }, narrated: { type: 'string', default: 'tests/fixtures/narrated/approved-narrated-v0.1.json' } } });
const start = Number(a.start), dur = Number(a.duration), end = start + dur;
const outFile = join(ROOT, a.out ?? 'packages/audio-mix/samples/mix-test-10s.wav');
const sheet = JSON.parse(readFileSync(join(ROOT, a.beats!), 'utf8'));
const sb = JSON.parse(readFileSync(join(ROOT, a.narrated!), 'utf8'));
const phrases = (sb.script.phrases as Array<{ id: string; start: number; end: number; text: string }>).filter((p) => p.end > start && p.start < end).map((p) => ({ id: p.id, text: p.text, start: p.start - start, end: p.end - start }));

let voice: Float32Array, voiceSource: string;
if (a.vo) {
  const w = decodeWavStereo(new Uint8Array(readFileSync(a.vo)));
  const mono = new Float32Array(w.left.length); for (let i = 0; i < mono.length; i++) mono[i] = (w.left[i] + w.right[i]) / 2;
  const full = resampleTo48k(mono, w.sampleRate);
  voice = new Float32Array(Math.round(dur * SR)); voice.set(full.subarray(Math.round(start * SR), Math.round(end * SR)));
  voiceSource = `file:${a.vo}`;
} else { voice = synthVoice(phrases, dur, sheet.seed); voiceSource = 'stand-in formant synthesiser (packages/audio-mix/tools/test-voice.ts) speaking the aligned phrases'; }

const lib = loadLibrary();
if (lib.errors.length) throw new Error(`asset library: ${lib.errors.join('; ')}`);
const plan = mixPlanFromBeatSheet(sheet, { start, end });
const t0 = performance.now();
const { left, right, report } = mixVoiceSfx({ left: voice }, plan.cues, lib.audio, { seed: sheet.seed });
const ms = Math.round(performance.now() - t0);
const wav = encodeWavStereo(left, right, SR, 24, sheet.seed);
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, wav);
// verify from the written file (24-bit, dithered): what an editor will import
const back = decodeWavStereo(new Uint8Array(readFileSync(outFile)));
const fileCheck = { sampleRate: back.sampleRate, bits: back.bits, durationSec: back.left.length / back.sampleRate, integratedLufs: +integratedLoudness(back.left, back.right).toFixed(2), truePeakDbtp: truePeakDbtp(back.left, back.right) };
const pass = { loudness: Math.abs(fileCheck.integratedLufs - -14) <= 0.5, truePeak: fileCheck.truePeakDbtp <= -1.0, duration: Math.abs(fileCheck.durationSec - dur) < 1e-6, noMusic: report.music === 'none', allCuesMixed: report.cues.every((c) => c.status === 'mixed'), sfxUnderVoice: (report.sfxUnderVoice.minSpeechMarginDb ?? Infinity) >= report.sfxUnderVoice.requiredSpeechMarginDb - 0.5 };
const full = { file: relative(ROOT, outFile), window: { start, end }, voiceSource, beatSheet: a.beats, narrated: a.narrated, phrases, sfxEvents: plan.cues, ignoredMusic: plan.ignoredMusic, mix: report, fileCheck, pass, mixMs: ms };
writeFileSync(outFile.replace(/\.wav$/, '.report.json'), JSON.stringify(full, null, 2) + '\n');
console.log(JSON.stringify({ file: full.file, fileCheck, pass, cues: report.cues.map((c) => `${c.at.toFixed(2)} ${c.sfxId} -> ${c.source} (${c.status})`), ignoredMusic: plan.ignoredMusic.map((m) => m.musicId), sfxUnderVoice: report.sfxUnderVoice, limiter: { maxReductionDb: report.limiterMaxReductionDb, ceilingDbtp: report.limiterCeilingDbtp }, mixMs: ms }, null, 2));
if (!Object.values(pass).every(Boolean)) process.exit(1);
