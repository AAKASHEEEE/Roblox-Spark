// Narrated Story, Phase 1: offline phrase alignment, captions and the constrained narrated storyboard. Tiny generated
// tone/silence WAV fixtures (in memory, never committed); no speech model, no browser, no rendering.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { lib, ROOT } from './helpers.ts';
import { startServer } from '../apps/render-worker/lib/server.ts';
import { createStudioApi } from '../apps/studio/server.ts';
import { ffmpegStatus } from '../apps/studio/narrated-api.ts';
import { buildRegistry } from '../packages/story/src/registry.ts';
import { decodeWav, encodeWav16 } from '../packages/narrated/src/audio.ts';
import { SilenceGuidedAligner, alignPhrases } from '../packages/narrated/src/align.ts';
import { generateNarratedStoryboard, parseScript, perCharacterVocab, vocabIds, type AudioMeta } from '../packages/narrated/src/pipeline.ts';
import { validateNarratedStoryboard } from '../packages/narrated/src/schema.ts';

const reg = buildRegistry(lib as never);
const sha = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
const SCRIPT = `Imagine if you actually lived inside a block game.
At first, everything would feel perfect.
You would never need to go to school.
You could drive anywhere without consequences.

But eventually, you would start missing your real family.
And the worst part? You could never go home.`;
const LINES = parseScript(SCRIPT).map((l) => l.text);

/** tone bursts (one per entry, seconds) separated by `gap` s of silence; noise = constant low hum (no true silence) */
function fixture(bursts: number[], gap = 0.45, o: { lead?: number; hum?: number } = {}) {
  const sr = 16000, lead = o.lead ?? 0.5, total = lead + bursts.reduce((a, b) => a + b + gap, 0) + 0.3;
  const pcm = new Float32Array(Math.round(total * sr));
  let t = lead;
  for (const d of bursts) { for (let i = Math.round(t * sr); i < Math.round((t + d) * sr); i++) pcm[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / sr); t += d + gap; }
  if (o.hum) for (let i = 0; i < pcm.length; i++) pcm[i] = o.hum * Math.sin((2 * Math.PI * 110 * i) / sr) + pcm[i] * 0.02;
  const wav = encodeWav16(pcm, sr), decoded = decodeWav(wav);
  const meta: AudioMeta = { originalFilename: 'voice-over.wav', format: 'wav', codec: decoded.codec, durationSeconds: decoded.durationSeconds, sampleRate: decoded.sampleRate, channels: decoded.channels, contentHash: sha(wav) };
  return { wav, decoded, meta, audio: { meta, decoded, path: null } };
}
const matched = () => fixture(LINES.map((l) => l.split(' ').length * 0.32));
const request = (meta: AudioMeta, patch: Record<string, unknown> = {}) => ({ title: 'Living in a block game', script: SCRIPT, audioHash: meta.contentHash, characters: ['zapp', 'kira'], storyPattern: 'hypothetical', seed: 17, captionPreset: 'shorts_default', ...patch });
const deps = { registry: reg, aligner: new SilenceGuidedAligner(), sha256: (s: string) => sha(s) };
const assertTimeline = (ph: Array<{ start: number; end: number }>, D: number) => ph.forEach((p, i) => {
  assert.ok(p.start >= 0 && p.end > p.start && p.end <= D + 1e-9, `phrase ${i} [${p.start}, ${p.end}] inside 0..${D}`);
  if (i) assert.ok(p.start >= ph[i - 1].end - 1e-9, `phrase ${i} does not overlap phrase ${i - 1}`);
});

test('1. valid script + voice-over produce ordered, silence-guided phrase timings with captions', async () => {
  const f = matched();
  const r = await generateNarratedStoryboard(request(f.meta), f.audio, deps);
  assert.equal(r.status, 'accepted', JSON.stringify(r.rejection));
  const sb = r.storyboard!, ph = sb.script.phrases;
  assert.deepEqual(ph.map((p) => p.text), LINES);
  assert.equal(sb.alignment.level, 'high');
  assert.equal(sb.alignment.speechRegions, LINES.length);
  for (const p of ph) {
    assert.equal(p.alignmentMethod, 'silence-guided');
    assert.ok(p.alignmentConfidence >= 0.8);
    assert.ok(p.caption.lines.length >= 1 && p.caption.lines.length <= 2 && p.caption.lines.every((l) => l.length <= 32));
    assert.equal(p.caption.lines.join(' '), p.text, 'captions preserve the phrase text and punctuation');
  }
  // bursts start at 0.5 s and every 0.45 s pause is a boundary: starts match the generated fixture within one frame
  let t = 0.5;
  LINES.forEach((l, i) => { assert.ok(Math.abs(ph[i].start - t) <= 0.021, `p${i + 1} starts near ${t}`); t += l.split(' ').length * 0.32 + 0.45; });
  assert.equal(sb.timeline.length, ph.length);
  assert.ok(ph.some((p) => p.substitutions.some((s) => s.requested === 'driving')), 'unbuilt "drive" is a declared substitution');
});

test('2. same script, audio, configuration and seed give byte-identical storyboard JSON', async () => {
  const a = await generateNarratedStoryboard(request(matched().meta), matched().audio, deps);
  const b = await generateNarratedStoryboard(request(matched().meta), matched().audio, deps);
  assert.equal(JSON.stringify(a.storyboard), JSON.stringify(b.storyboard));
  const c = await generateNarratedStoryboard(request(matched().meta, { seed: 18 }), matched().audio, deps);
  assert.notEqual(c.storyboard!.id, a.storyboard!.id, 'the seed is part of the storyboard identity');
  assert.deepEqual(c.storyboard!.script.phrases.map((p) => [p.start, p.end]), a.storyboard!.script.phrases.map((p) => [p.start, p.end]), 'alignment is seed-independent');
});

test('3. phrase timings never overlap (1:1, merged, split and no-pause cases)', () => {
  const cases = [
    fixture([2, 1.5, 2, 1.6, 2.4, 2.2]),                       // one region per phrase
    fixture([1, 0.9, 1.5, 0.3, 0.9, 2, 0.8, 1.2, 1, 1.4], 0.3), // more regions than phrases (merges)
    fixture([4.5, 5.5], 0.5),                                   // fewer regions than phrases (splits)
    fixture([12], 0.2, { hum: 0.2 }),                           // no usable pauses
  ];
  for (const f of cases) assertTimeline(alignPhrases(f.decoded, LINES).phrases, f.meta.durationSeconds);
});

test('4. phrase ranges stay inside the audio duration, even when speech runs to the last sample', () => {
  for (const f of [fixture([3, 3, 3, 3, 3, 3.2], 0.3, { lead: 0 }), fixture([2, 2, 2, 2, 2, 2], 0.2, { lead: 0.02 }), fixture([1.2, 1.2], 0.3)]) {
    // remove the trailing silence so speech reaches the end of the file
    const cut = { ...f.decoded, pcm: f.decoded.pcm.subarray(0, f.decoded.pcm.length - 0.3 * 16000), durationSeconds: Math.round(((f.decoded.pcm.length - 0.3 * 16000) / 16000) * 1000) / 1000 };
    const al = alignPhrases(cut, LINES);
    assertTimeline(al.phrases, cut.durationSeconds);
    assert.equal(al.phrases.length, LINES.length);
  }
});

test('5. alignment without detectable pauses is reported as low confidence with visible warnings', async () => {
  const f = fixture([14], 0.2, { hum: 0.25 });
  const r = await generateNarratedStoryboard(request(f.meta), f.audio, deps);
  assert.equal(r.status, 'accepted');
  const sb = r.storyboard!;
  assert.equal(sb.alignment.level, 'low');
  assert.equal(sb.validation.status, 'warning');
  assert.ok(sb.validation.warnings.some((w) => w.code === 'ALIGNMENT_LOW_CONFIDENCE'));
  assert.ok(sb.script.phrases.every((p) => p.alignmentMethod === 'word-proportional' && p.alignmentConfidence < 0.5 && p.warnings.some((w) => w.code === 'ALIGNMENT_ESTIMATED')));
});

test('6. unsafe scripts are rejected first, using the existing precedence (unsafe > protected IP > unavailable)', async () => {
  const f = matched();
  const r = await generateNarratedStoryboard(request(f.meta, { script: 'You join a Roblox server.\nThen you kill someone with a gun.', characters: ['bob'] }), f.audio, deps);
  assert.equal(r.status, 'rejected');
  assert.equal(r.rejection!.category, 'unsafe');
  assert.deepEqual(r.rejection!.also.map((x) => x.category), ['protected_ip', 'unavailable']);
  const ip = await generateNarratedStoryboard(request(f.meta, { script: 'Imagine a Minecraft-style world.\nIt would be perfect.' }), f.audio, deps);
  assert.equal(ip.rejection!.category, 'protected_ip', 'captions print the script, so style-qualified brands are blocked too');
  const bad = await generateNarratedStoryboard({ ...request(f.meta), extra: '<script>alert(1)</script>' }, f.audio, deps);
  assert.equal(bad.rejection!.category, 'invalid_input');
  const proto = await generateNarratedStoryboard(JSON.parse(`{"__proto__":{"polluted":true},${JSON.stringify(request(f.meta)).slice(1)}`), f.audio, deps);
  assert.equal(proto.rejection!.category, 'invalid_input');
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('7. unknown characters, actions, expressions, cameras and environments cannot enter a storyboard', async () => {
  const f = matched();
  const r = await generateNarratedStoryboard(request(f.meta), f.audio, deps);
  const sb = r.storyboard!, ids = vocabIds(reg), per = perCharacterVocab(reg);
  assert.ok(validateNarratedStoryboard(sb, ids, per).ok);
  for (const p of sb.script.phrases) {
    assert.ok(reg.ids.actions.includes(p.semanticAction) && per[p.actor].actions.includes(p.semanticAction));
    assert.ok(per[p.actor].expressions.includes(p.expression));
    assert.equal(p.environment, reg.environment.id);
  }
  const mutate = (fn: (x: any) => void) => { const x = structuredClone(sb) as any; fn(x); return validateNarratedStoryboard(x, ids, per).ok; };
  assert.equal(mutate((x) => { x.script.phrases[0].actor = 'bob'; }), false, 'unknown character');
  assert.equal(mutate((x) => { x.script.phrases[0].semanticAction = 'hover'; x.timeline[0].semanticAction = 'hover'; }), false, 'unavailable action (needs a floating rig)');
  assert.equal(mutate((x) => { x.script.phrases[0].semanticAction = 'drive_car'; }), false, 'unknown action');
  assert.equal(mutate((x) => { x.script.phrases[0].environment = 'beach'; }), false, 'unknown environment');
  assert.equal(mutate((x) => { x.script.phrases[0].cameraPreset = 'drone_orbit'; }), false, 'unknown camera');
  assert.equal(mutate((x) => { x.script.phrases[0].expression = 'smug'; }), false, 'zapp has no smug face');
  assert.equal(mutate((x) => { x.script.phrases[1].start = x.script.phrases[0].start; }), false, 'overlap');
  assert.equal(mutate((x) => { x.script.phrases.at(-1).end = x.audio.durationSeconds + 1; }), false, 'outside the audio');
  assert.equal(mutate((x) => { x.script.phrases[0].caption.lines = ['']; }), false, 'empty caption');
  assert.equal(mutate((x) => { x.unknownKey = 1; }), false, 'unknown key');
  const u = await generateNarratedStoryboard(request(f.meta, { characters: ['zapp', 'bzztt'] }), f.audio, deps);
  assert.equal(u.rejection!.category, 'unavailable');
});

test('8. Studio: Visual Comedy is unchanged and Narrated Story validates uploads server-side', { timeout: 120000 }, async () => {
  const STATE = `out/test-narrated-${process.pid}`, UP = join(ROOT, '.scratch', `test-narrated-${process.pid}`);
  const s = await startServer(0, createStudioApi({ lib: lib as never, analyzer: null, render: (async () => { throw new Error('no render in tests'); }) as never, stateDir: STATE, uploadDir: UP }));
  const base = s.url;
  try {
    const opts = await (await fetch(`${base}/api/story/options`)).json();
    assert.deepEqual(opts.engines.map((e: { id: string }) => e.id), ['ordinary_object_extreme', 'visible_secret_chase', 'apparent_win_instant_loss', 'noob_vs_smart']);
    const vc = await (await fetch(`${base}/api/story/generate`, { method: 'POST', body: JSON.stringify({ idea: 'Zapp presses a free-coins button, celebrates, and the coin becomes too large.', comedyEngine: null, durationTarget: 17, seed: 17 }) })).json();
    assert.equal(vc.status, 'accepted', 'Visual Comedy still generates an approvable storyboard');
    const up = (name: string, body: Uint8Array) => fetch(`${base}/api/narrated/upload`, { method: 'POST', headers: { 'x-filename': encodeURIComponent(name) }, body });
    const f = matched();
    assert.equal((await up('../../etc/passwd.wav', f.wav)).status, 400);
    assert.equal((await up('voice.exe', f.wav)).status, 400);
    assert.equal((await up('fake.wav', new TextEncoder().encode('MZ\x90\x00 not really audio at all'))).status, 422);
    assert.equal((await up('empty.wav', new Uint8Array(0))).status, 422);
    const ok = await up('voice-over.wav', f.wav);
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).contentHash, f.meta.contentHash);
    const g = await (await fetch(`${base}/api/narrated/generate`, { method: 'POST', body: JSON.stringify(request(f.meta)) })).json();
    assert.equal(g.status, 'accepted');
    const dl = await fetch(`${base}/api/narrated/generations/${g.generationId}/storyboard.json`);
    assert.match(dl.headers.get('content-disposition') ?? '', /attachment; filename="nr-[0-9a-f]{12}\.json"/);
    assert.equal(JSON.stringify(await dl.json()), JSON.stringify(g.storyboard));
    assert.equal((await fetch(`${base}/api/narrated/audio/${'0'.repeat(64)}`)).status, 404, 'unknown audio must be re-uploaded');
    // FFmpeg is resolved explicitly (FFMPEG_PATH or PATH, never installed); without it MP3/M4A get a setup error
    const nopt = await (await fetch(`${base}/api/narrated/options`)).json();
    assert.equal(ffmpegStatus({ FFMPEG_PATH: 'relative/ffmpeg' }).available, false);
    assert.match(String(ffmpegStatus({ FFMPEG_PATH: '/nonexistent/bin/ffmpeg' }).problem), /absolute path to an existing file/);
    const mp3 = await up('voice-over.mp3', new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 0xff, 0xfb, 0x90, 0x64, 0, 0]));
    assert.equal(mp3.status, 422);
    if (!nopt.ffmpeg.available) {
      assert.deepEqual(nopt.formats, ['wav']);
      const e = await mp3.json();
      assert.equal(e.code, 'DECODER_UNAVAILABLE');
      assert.match(e.error, /FFMPEG_PATH/);
    }
  } finally { s.server.close(); rmSync(join(ROOT, STATE), { recursive: true, force: true }); rmSync(UP, { recursive: true, force: true }); }
});
