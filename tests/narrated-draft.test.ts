// Narrated Story Phase 2A: approval gate, mode-specific durations, the deterministic draft timeline and the draft-render
// API contract. In-memory tone/silence WAV fixture (~66 s); the renderer is MOCKED: no browser, no MP4 in unit tests.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { lib, sample, ROOT } from './helpers.ts';
import { startServer } from '../apps/render-worker/lib/server.ts';
import { createStudioApi } from '../apps/studio/server.ts';
import { buildRegistry } from '../packages/story/src/registry.ts';
import { EpisodeSchema, NarratedEpisodeSchema } from '../packages/schema/src/episode.ts';
import { validateEpisode } from '../packages/pipeline/src/validate.ts';
import { decodeWav, encodeWav16 } from '../packages/narrated/src/audio.ts';
import { SilenceGuidedAligner } from '../packages/narrated/src/align.ts';
import { generateNarratedStoryboard, type AudioMeta } from '../packages/narrated/src/pipeline.ts';
import { compileNarratedTimeline, draftEpisode, MAX_DRAFT_SHOT_SEC } from '../packages/narrated/src/timeline.ts';
import type { NarratedStoryboard } from '../packages/narrated/src/schema.ts';

const reg = buildRegistry(lib as never);
const sha = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
const LINES = [
  'This is the difference between Zapp and Kira when the teacher leaves the classroom.',
  'The second the door closes, Zapp thinks the entire classroom belongs to him.',
  'He jumps up, celebrates, and starts acting like he just escaped school forever.',
  'Kira stays at her desk because she knows the teacher could return at any moment.',
  'Then Zapp notices a suspicious free-coins button sitting on the front desk.',
  'Kira tells him not to touch it, which obviously makes him want to press it even more.',
  'He slams the button, and one shiny coin appears.',
  'Zapp celebrates so loudly that he completely forgets why the classroom is empty.',
  'Then the button flashes again, and the coin begins growing.',
  'It gets taller than the desk, wider than Zapp, and almost fills the entire room.',
  'Zapp tries to look confident, but Kira has already moved safely out of the way.',
  'The giant coin tips forward and flattens Zapp against the classroom floor.',
  'At that exact moment, the teacher returns and sees Kira sitting perfectly still.',
  'And the free-coins button quietly resets for its next victim.',
];
function wavFor(lines: string[], secPerWord = 0.33) {
  const sr = 16000, b = lines.map((l) => l.split(' ').length * secPerWord), total = 0.5 + b.reduce((a, x) => a + x + 0.45, 0) + 0.3;
  const pcm = new Float32Array(Math.round(total * sr));
  let t = 0.5;
  for (const d of b) { for (let i = Math.round(t * sr); i < Math.round((t + d) * sr); i++) pcm[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / sr); t += d + 0.45; }
  return encodeWav16(pcm, sr);
}
const WAV = wavFor(LINES), DEC = decodeWav(WAV);
const META: AudioMeta = { originalFilename: 'voice-over.wav', format: 'wav', codec: DEC.codec, durationSeconds: DEC.durationSeconds, sampleRate: DEC.sampleRate, channels: DEC.channels, contentHash: sha(WAV) };
const REQUEST = { title: 'Zapp vs Kira When the Teacher Leaves', script: LINES.join('\n\n'), audioHash: META.contentHash, characters: ['zapp', 'kira'], storyPattern: 'comparison', seed: 17, captionPreset: 'shorts_default' };
let SB: NarratedStoryboard;
const ASSETS = () => ({ characters: Object.fromEntries(Object.entries(reg.characters).map(([k, c]) => [k, c.version])), environment: { id: reg.environment.id, version: reg.environment.version }, props: { button: reg.props.button.version, coin: reg.props.coin.version, desk: reg.props.desk.version }, motionProfile: 'corrected-head-v2', rendererVersion: '1.0.0' });

const STATE = `out/test-narrated-draft-${process.pid}`, UP = join(ROOT, '.scratch', `test-narrated-draft-${process.pid}`);
let base = '', close = () => {};
const drafts: string[] = [];
async function mockDraft(i: { jobDir: string; storyboard: NarratedStoryboard; storyboardSha256: string; onStage: (s: string, d?: number, t?: number) => void }) {
  drafts.push(i.storyboard.id);
  i.onStage('compiling'); i.onStage('rendering', 10, 20);
  const tl = compileNarratedTimeline(i.storyboard, i.storyboardSha256);
  writeFileSync(join(i.jobDir, 'draft-540x960.mp4'), Buffer.from('mock mp4'));
  writeFileSync(join(i.jobDir, 'approved-narrated.json'), JSON.stringify(i.storyboard));
  writeFileSync(join(i.jobDir, 'render-timeline.json'), JSON.stringify(tl));
  const rel = (f: string) => `/${join(STATE, i.jobDir.split(STATE)[1], f).replace(/\\/g, '/')}`;
  return { ok: true, outputs: { mp4: rel('draft-540x960.mp4'), approvedJson: rel('approved-narrated.json'), timelineJson: rel('render-timeline.json') }, quality: { passed: 18, total: 18, failed: [] } };
}
const post = async (p: string, body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) => { const r = await fetch(base + p, { method: 'POST', headers, body: body instanceof Uint8Array ? body : JSON.stringify(body) }); return { status: r.status, data: await r.json() as any }; };

before(async () => {
  const r = await generateNarratedStoryboard(REQUEST, { meta: META, decoded: DEC, path: null }, { registry: reg, aligner: new SilenceGuidedAligner(), sha256: (s: string) => sha(s) });
  assert.equal(r.status, 'accepted', JSON.stringify(r.rejection));
  SB = r.storyboard!;
  const s = await startServer(0, createStudioApi({ lib: lib as never, analyzer: null, render: (async () => { throw new Error('no Visual Comedy render in these tests'); }) as never, stateDir: STATE, uploadDir: UP, renderDraft: mockDraft as never }));
  base = s.url; close = () => s.server.close();
});
after(() => { close(); rmSync(join(ROOT, STATE), { recursive: true, force: true }); rmSync(UP, { recursive: true, force: true }); });

test('1. Visual Comedy keeps its 14-22 s duration limit', () => {
  const ep = sample();
  assert.ok(EpisodeSchema.parse(ep).ok);
  for (const d of [13, 23, 40, 69.146]) assert.equal(EpisodeSchema.parse({ ...ep, episode: { ...ep.episode, duration: d } }).ok, false, `${d} s`);
  assert.equal(validateEpisode({ ...ep, episode: { ...ep.episode, duration: 40 } }, lib as never).ok, false);
});

test('2. narrated drafts accept 35-75 s (mode-specific) and the compiled 66 s draft validates', () => {
  assert.ok(SB.audio.durationSeconds >= 35 && SB.audio.durationSeconds <= 75, `${SB.audio.durationSeconds} s`);
  const ep = draftEpisode(SB, compileNarratedTimeline(SB, sha(JSON.stringify(SB))), ASSETS()) as any;
  const v = validateEpisode(ep, lib as never, { repair: false, profile: 'narrated-draft' });
  assert.ok(v.ok, JSON.stringify(v.findings.filter((f) => f.severity === 'error').slice(0, 5)));
  for (const d of [34, 76]) assert.equal(NarratedEpisodeSchema.parse({ ...ep, episode: { ...ep.episode, duration: d } }).ok, false, `${d} s`);
});

test('3. draft rendering is blocked without an approval', async () => {
  assert.equal((await post('/api/narrated/render', {})).status, 400);
  assert.equal((await post('/api/narrated/render', { approvalId: 'na-0000000000000000' })).status, 404);
  assert.equal(drafts.length, 0);
});

test('4. a replaced or changed voice-over invalidates the approval', async () => {
  const up = await post('/api/narrated/upload', WAV, { 'x-filename': 'voice-over.wav' });
  assert.equal(up.status, 200);
  const g = await post('/api/narrated/generate', REQUEST);
  assert.equal(g.data.status, 'accepted');
  const a = await post('/api/narrated/approve', { generationId: g.data.generationId });
  assert.equal(a.status, 200, JSON.stringify(a.data));
  assert.equal(a.data.audioHash, META.contentHash);
  assert.equal(a.data.captionChunks, SB.script.phrases.reduce((n, p) => n + p.caption.chunks.length, 0));
  assert.equal((await post('/api/narrated/render', { approvalId: a.data.approvalId, audioHash: 'f'.repeat(64) })).status, 409, 'different audio hash');
  const stored = join(UP, readdirSync(UP).find((f) => f.endsWith('.wav'))!);
  writeFileSync(stored, wavFor(LINES.slice(0, 13)));
  assert.equal((await post('/api/narrated/render', { approvalId: a.data.approvalId })).status, 409, 'tampered stored audio');
  writeFileSync(stored, WAV);
});

test('5. the timeline contains every caption chunk, in order', () => {
  const tl = compileNarratedTimeline(SB, 'x'.repeat(64));
  assert.deepEqual(tl.captions.map((c) => c.chunkId), SB.script.phrases.flatMap((p) => p.caption.chunks.map((c) => c.id)));
  assert.equal(tl.duration, SB.audio.durationSeconds);
  assert.ok(tl.videoDuration >= tl.duration && tl.videoDuration - tl.duration < 1 / 30 + 1e-9);
});

test('6. no visual shot exceeds 3 s and every caption chunk starts a new shot', () => {
  const tl = compileNarratedTimeline(SB, 'x'.repeat(64));
  assert.equal(tl.shots[0].start, 0);
  assert.equal(tl.shots.at(-1)!.end, tl.videoDuration);
  tl.shots.forEach((s, k) => { assert.ok(s.end - s.start <= Math.min(3, MAX_DRAFT_SHOT_SEC) + 1e-9, `${s.id} ${s.end - s.start}`); if (k) assert.equal(s.start, tl.shots[k - 1].end); });
  for (const [k, c] of tl.captions.entries()) assert.ok(tl.shots.some((s) => (k === 0 ? s.start === 0 : s.start === c.start)), c.chunkId);
  assert.ok(tl.shots.length >= tl.captions.length);
});

test('7. burned captions keep the exact chunk timing and text', () => {
  const tl = compileNarratedTimeline(SB, 'x'.repeat(64));
  const planned = SB.script.phrases.flatMap((p) => p.caption.chunks);
  tl.captions.forEach((c, k) => { assert.equal(c.start, planned[k].start); assert.equal(c.end, planned[k].end); assert.deepEqual(c.lines, planned[k].lines); if (k) assert.ok(c.start >= tl.captions[k - 1].end); });
  assert.ok(tl.captions.every((c) => c.lines.length <= 2 && c.lines.every((l) => l.length <= 32 && !/[\[\]⚠]/.test(l))));
});

test('8. the off-screen teacher is never instantiated', () => {
  const tl = compileNarratedTimeline(SB, 'x'.repeat(64)), ep = draftEpisode(SB, tl, ASSETS()) as any;
  assert.deepEqual(ep.cast.map((c: any) => c.id), ['zapp', 'kira']);
  assert.doesNotMatch(JSON.stringify([ep.cast, ep.shots, ep.actions, ep.props]), /teacher/);
  assert.ok(tl.offscreenCues.some((c) => c.mention === 'teacher'));
  assert.ok(tl.warnings.some((w) => w.code === 'UNAVAILABLE_CHARACTER_OFFSCREEN'));
});

test('9. the same approved input compiles to byte-identical timeline JSON', () => {
  const a = JSON.stringify(compileNarratedTimeline(SB, 'y'.repeat(64))), b = JSON.stringify(compileNarratedTimeline(structuredClone(SB), 'y'.repeat(64)));
  assert.equal(a, b);
  assert.equal(JSON.stringify(draftEpisode(SB, JSON.parse(a), ASSETS())), JSON.stringify(draftEpisode(SB, JSON.parse(b), ASSETS())));
});

test('10. a (mock) successful draft render exposes the draft MP4, approved JSON and timeline JSON', async () => {
  const g = await post('/api/narrated/generate', REQUEST);
  const a = await post('/api/narrated/approve', { generationId: g.data.generationId });
  const r = await post('/api/narrated/render', { approvalId: a.data.approvalId, audioHash: META.contentHash });
  assert.equal(r.status, 202, JSON.stringify(r.data));
  let job = r.data;
  for (let i = 0; i < 50 && job.state !== 'done' && job.state !== 'failed'; i++) { await new Promise((x) => setTimeout(x, 50)); job = await (await fetch(`${base}/api/narrated/jobs/${job.id}`)).json(); }
  assert.equal(job.state, 'done', job.error);
  for (const k of ['mp4', 'approvedJson', 'timelineJson', 'approvedJsonApi']) { assert.ok(job.outputs[k], k); assert.equal((await fetch(base + job.outputs[k])).status, 200, k); }
  const approved = await (await fetch(base + job.outputs.approvedJsonApi)).json();
  assert.equal(approved.id, SB.id);
  assert.ok(existsSync(join(ROOT, job.outputs.mp4.slice(1))));
});
