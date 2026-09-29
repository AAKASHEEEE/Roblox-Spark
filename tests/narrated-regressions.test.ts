// Regression tests for the first real Narrated Story validation (docs/narrated/PHASE1-RESULTS.md):
// A long sentences -> timed caption chunks, B display-filename sanitizing, C complete rejection messages,
// D1 character-aware actors, D2 off-screen unavailable characters, D3 verb-object actions.
// Tiny in-memory tone/silence WAV fixtures (one burst per line); no speech model, no browser, no rendering.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lib } from './helpers.ts';
import { buildRegistry } from '../packages/story/src/registry.ts';
import { AudioRejection, checkContainer, checkFilename, decodeWav, encodeWav16 } from '../packages/narrated/src/audio.ts';
import { SilenceGuidedAligner } from '../packages/narrated/src/align.ts';
import { planCaptionChunks } from '../packages/narrated/src/captions.ts';
import { generateNarratedStoryboard, perCharacterVocab, vocabIds, type AudioMeta } from '../packages/narrated/src/pipeline.ts';
import { validateNarratedStoryboard } from '../packages/narrated/src/schema.ts';

const reg = buildRegistry(lib as never);
const sha = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
const deps = { registry: reg, aligner: new SilenceGuidedAligner(), sha256: (s: string) => sha(s) };
const tokens = (s: string) => s.trim().split(/\s+/);
function audioFor(lines: string[], secPerWord = 0.3) {
  const sr = 16000, bursts = lines.map((l) => tokens(l).length * secPerWord), total = 0.5 + bursts.reduce((a, b) => a + b + 0.45, 0) + 0.3;
  const pcm = new Float32Array(Math.round(total * sr));
  let t = 0.5;
  for (const d of bursts) { for (let i = Math.round(t * sr); i < Math.round((t + d) * sr); i++) pcm[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / sr); t += d + 0.45; }
  const wav = encodeWav16(pcm, sr), decoded = decodeWav(wav);
  const meta: AudioMeta = { originalFilename: 'voice-over.wav', format: 'wav', codec: decoded.codec, durationSeconds: decoded.durationSeconds, sampleRate: decoded.sampleRate, channels: decoded.channels, contentHash: sha(wav) };
  return { meta, decoded, path: null };
}
/** comparison-pattern storyboard with a blank line between every script line (as in the real validation script) */
async function board(lines: string[], o: { pattern?: string; secPerWord?: number } = {}) {
  const audio = audioFor(lines, o.secPerWord);
  const script = lines.join('\n\n');
  return generateNarratedStoryboard({ title: 'Regression', script, audioHash: audio.meta.contentHash, characters: ['zapp', 'kira'], storyPattern: o.pattern ?? 'comparison', seed: 17, captionPreset: 'shorts_default' }, audio, deps);
}
const LONG = [
  'Kira tells him not to touch it, which obviously makes him want to press it even more.',
  'This is the difference between Zapp and Kira when the teacher leaves the classroom.',
  'And the free-coins button quietly resets for its next victim.',
  'Nobody in the entire school expected the vending machine to start singing loudly.',
  'Every single morning, Kira Stone arrives early and quietly reads beside the window.',
];

test('A1. 59-85 character sentences become deterministic, word-preserving caption chunks inside the phrase timing', () => {
  for (const text of LONG) {
    assert.ok(text.length >= 59 && text.length <= 86, `${text.length} chars`);
    const start = 3.2, end = 3.2 + tokens(text).length * 0.33;
    const c = planCaptionChunks('p07', text, start, end);
    assert.ok(c.chunks.length >= (text.length > 64 ? 2 : 1));
    for (const [i, ch] of c.chunks.entries()) {
      assert.equal(ch.id, `p07-c${String(i + 1).padStart(2, '0')}`);
      assert.ok(ch.lines.length >= 1 && ch.lines.length <= 2, 'at most two lines per chunk');
      for (const l of ch.lines) assert.ok(l.length >= 1 && l.length <= 32, `line "${l}" is ${l.length} chars`);
      assert.ok(ch.end > ch.start && ch.start >= start && ch.end <= end + 1e-9, 'chunk inside the phrase');
      if (i) assert.equal(ch.start, c.chunks[i - 1].end, 'contiguous chunks');
      assert.ok(ch.wordsPerSecond > 0);
    }
    assert.equal(c.chunks[0].start, start);
    assert.equal(c.chunks.at(-1)!.end, end);
    assert.deepEqual(c.chunks.flatMap((ch) => ch.lines.flatMap(tokens)), tokens(text), 'no word lost, duplicated or reordered');
    assert.deepEqual(planCaptionChunks('p07', text, start, end), c, 'same input, same chunks');
  }
  // names stay together on a line
  const named = planCaptionChunks('p01', LONG[4], 0, 5).chunks.flatMap((ch) => ch.lines);
  assert.ok(named.some((l) => l.includes('Kira Stone')), JSON.stringify(named));
});

test('A2. a script of long sentences is accepted (schema 1.1) and too little time only warns', async () => {
  const r = await board(LONG.slice(0, 3), { pattern: 'hypothetical' });
  assert.equal(r.status, 'accepted', JSON.stringify(r.rejection));
  const sb = r.storyboard!;
  assert.equal(sb.schemaVersion, '1.1');
  assert.equal(sb.script.phrases.length, 3, 'one phrase and one beat per script line');
  assert.equal(sb.timeline.length, 3);
  assert.ok(sb.script.phrases.some((p) => p.caption.chunks.length > 1));
  assert.ok(validateNarratedStoryboard(JSON.parse(JSON.stringify(sb)), vocabIds(reg), perCharacterVocab(reg)).ok);
  const fast = await board(LONG.slice(0, 2), { pattern: 'hypothetical', secPerWord: 0.12 });
  assert.equal(fast.status, 'accepted');
  assert.ok(fast.storyboard!.script.phrases.every((p) => p.warnings.some((w) => w.code === 'READING_SPEED_HIGH')));
});

test('B. display filenames are sanitized; paths, control characters and mismatched content are still rejected', () => {
  assert.deepEqual(checkFilename('e;leven 1.mp3'), { filename: 'e_leven 1.mp3', format: 'mp3', sanitized: true });
  const shell = checkFilename('vo;rm -rf $(id)|`x`&y>z.wav');
  assert.equal(shell.format, 'wav');
  assert.match(shell.filename, /\.wav$/);
  assert.doesNotMatch(shell.filename, /[;$|`&<>]/);
  assert.equal(checkFilename('Voice Over (final).M4A').filename, 'Voice Over (final).M4A');
  const code = (f: () => unknown) => { try { f(); return 'accepted'; } catch (e) { return (e as AudioRejection).code; } };
  for (const n of ['../vo.wav', '..\\vo.wav', 'a/../../b.mp3', 'dir/vo.wav', 'C:\\temp\\vo.wav', '..', '.hidden.wav']) assert.notEqual(code(() => checkFilename(n)), 'accepted', n);
  assert.equal(code(() => checkFilename('../../etc/passwd.wav')), 'PATH_TRAVERSAL');
  for (const n of ['vo\u0000.wav', 'vo\n.wav', 'vo\u001b[31m.wav', 'vo\u202egpj.wav']) assert.equal(code(() => checkFilename(n)), 'BAD_FILENAME', JSON.stringify(n));
  assert.equal(code(() => checkFilename('voice.exe')), 'BAD_EXTENSION');
  const wav = encodeWav16(new Float32Array(1600), 16000), mp3 = Uint8Array.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 0xff, 0xfb, 0x90, 0x64, 0, 0]);
  assert.equal(code(() => checkContainer(mp3, 'wav')), 'FORMAT_MISMATCH');
  assert.equal(code(() => checkContainer(wav, 'mp3')), 'FORMAT_MISMATCH');
});

test('C. rejection messages never hide later line numbers (lines 11-14)', async () => {
  const lines = Array.from({ length: 14 }, (_, i) => `Line ${i + 1} has Supercalifragilisticexpialidociousnessness words.`);
  const r = await board(lines);
  assert.equal(r.status, 'rejected');
  const reason = r.rejection!.reason;
  for (const n of [11, 12, 13, 14]) assert.ok(new RegExp(`\\b${n}\\b`).test(reason) || /and \d+ more/.test(reason), `line ${n} missing: ${reason}`);
});

test('D1. explicit subjects, pronouns and objects choose the actor; blank lines do not force alternation', async () => {
  const r = await board([
    'Here is how Zapp and Kira spend a rainy lunch break.',
    'The minute the bell rings, Zapp thinks the hallway belongs to him.',
    'He jumps onto a chair and cheers.',
    'Kira stays by the window because she knows better.',
    'Kira tells him not to touch the button.',
    'She laughs when he ignores her.',
    'The heavy coin flattens Zapp against the floor.',
  ]);
  assert.equal(r.status, 'accepted', JSON.stringify(r.rejection));
  const p = r.storyboard!.script.phrases;
  assert.deepEqual(p.map((x) => x.actor), ['zapp', 'zapp', 'zapp', 'kira', 'kira', 'kira', 'zapp']);
  assert.equal(p[1].actorRole, 'agent');
  assert.equal(p[2].actorRole, 'agent', 'pronoun "He" continues Zapp');
  assert.equal(p[4].supportingCharacter, 'zapp', '"tells him" keeps Zapp as supporting/target');
  assert.equal(p[6].actorRole, 'affected', 'the coin, not Zapp, causes the action');
  assert.equal(p[6].cause, 'spark_coin');
  assert.notEqual(p[6].semanticAction, 'press_button');
});

test('D2. unavailable characters stay off-screen with a warning, or block when they must act on screen', async () => {
  const ok = await board(['Zapp waits until the teacher leaves the room.', 'At that exact moment, the teacher returns and sees Kira reading quietly.']);
  assert.equal(ok.status, 'accepted', JSON.stringify(ok.rejection));
  for (const p of ok.storyboard!.script.phrases) {
    assert.ok(['zapp', 'kira'].includes(p.actor), 'no teacher is invented');
    assert.ok(p.warnings.some((w) => w.code === 'UNAVAILABLE_CHARACTER_OFFSCREEN' && /teacher/.test(w.message)));
    assert.deepEqual(p.offscreenCharacters, ['teacher']);
    assert.doesNotMatch(p.visualIntent, /teacher (is|appears) (visible|on screen)/i);
  }
  assert.equal(ok.storyboard!.script.phrases[1].actor, 'kira');
  const bad = await board(['Zapp sits at his desk.', 'The teacher dances on the desk and throws paper everywhere.']);
  assert.equal(bad.status, 'rejected');
  assert.equal(bad.rejection!.category, 'unavailable');
  assert.match(bad.rejection!.reason, /teacher/);
  assert.match(bad.rejection!.reason, /\b2\b/);
});

test('D3. verb-object intent, not the word "button", chooses actions and prop events', async () => {
  const r = await board([
    'Then Zapp notices a shiny button on the desk.',
    'Zapp presses the button.',
    'Kira slams the button.',
    'Zapp touches the button again.',
    'Then the button flashes twice.',
    'The coin begins growing.',
    'The giant coin flattens Zapp.',
    'The button quietly resets.',
  ]);
  assert.equal(r.status, 'accepted', JSON.stringify(r.rejection));
  const p = r.storyboard!.script.phrases, ev = (i: number) => p[i].propEvents.map((e) => `${e.prop}:${e.event}`);
  assert.equal(p[0].semanticAction, 'look_at');
  assert.equal(p[0].expression, 'curious');
  assert.deepEqual([p[1].semanticAction, p[2].semanticAction, p[3].semanticAction], ['press_button', 'press_button', 'press_button']);
  assert.notEqual(p[4].semanticAction, 'press_button');
  assert.ok(ev(4).includes('suspicious_button:flash'));
  assert.notEqual(p[5].semanticAction, 'press_button');
  assert.ok(ev(5).includes('spark_coin:grow'));
  assert.equal(p[6].actor, 'zapp');
  assert.equal(p[6].actorRole, 'affected');
  assert.equal(p[6].semanticAction, 'fall');
  assert.equal(p[6].cause, 'spark_coin');
  assert.notEqual(p[7].semanticAction, 'press_button');
  assert.ok(ev(7).includes('suspicious_button:reset'));
  for (const i of [4, 5, 7]) assert.equal(p[i].actorRole, 'reactor');
});
