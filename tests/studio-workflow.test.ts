// Supervised studio workflow (apps/studio/server.ts API + apps/studio/src/workflow.ts state). Real story pipeline
// (rules provider, static analysis), MOCKED renderer: no browser, no video.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { lib, ROOT } from './helpers.ts';
import { startServer } from '../apps/render-worker/lib/server.ts';
import { createStudioApi } from '../apps/studio/server.ts';
import { canApprove, canRender, initialState, reduce, type ApprovalView, type GenerationView, type JobView } from '../apps/studio/src/workflow.ts';

const STATE = `out/test-studio-${process.pid}`;
const IDEA = 'Zapp presses a free-coins button, celebrates, and the coin becomes too large.';
let base = '', close: () => void = () => {};
const rendered: string[] = [];
async function mockRender(o: { episode: string; out: string; scale?: number; onProgress?: (p: { phase: string; done: number; total: number }) => void }) {
  rendered.push(o.episode);
  const outDir = join(ROOT, o.out), ep = JSON.parse(readFileSync(join(ROOT, o.episode), 'utf8'));
  mkdirSync(outDir, { recursive: true });
  o.onProgress?.({ phase: 'render', done: 255, total: 510 });
  const mp4 = join(outDir, `${ep.episode.id}.mp4`);
  writeFileSync(mp4, Buffer.from('mock mp4 bytes'));
  writeFileSync(join(outDir, 'quality-report.md'), '# mock quality report\n');
  writeFileSync(join(outDir, 'probe.json'), JSON.stringify({ probe: { format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '17.000000', faststart: true }, streams: [{ codec_type: 'video', codec_name: 'h264', profile: 'High', width: 1080, height: 1920, r_frame_rate: '30/1' }, { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2 }] }, production: { ok: true } }));
  return { ok: true, outDir, mp4, report: { summary: { passed: 26, total: 26, failed: [] as string[] } } } as never;
}
const post = async <T>(p: string, body: unknown) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, data: (await r.json()) as T }; };
const get = async <T>(p: string) => { const r = await fetch(base + p); return { status: r.status, data: (await r.json()) as T }; };
const generate = (idea: string, seed: number) => post<GenerationView>('/api/story/generate', { idea, comedyEngine: null, durationTarget: 17, seed });

before(async () => {
  const api = createStudioApi({ lib: lib as never, analyzer: null, render: mockRender as never, stateDir: STATE });
  const s = await startServer(0, api); base = s.url; close = () => s.server.close();
});
after(() => { close(); rmSync(join(ROOT, STATE), { recursive: true, force: true }); });

test('1. a compatible idea reaches storyboard review with readable beat cards (same inputs + seed => same storyboard)', { timeout: 120000 }, async () => {
  const opts = await get<{ engines: Array<{ id: string; title: string }>; duration: { min: number; max: number; default: number }; product: string }>('/api/story/options');
  assert.deepEqual(opts.data.engines.map((e) => e.id), ['ordinary_object_extreme', 'visible_secret_chase', 'apparent_win_instant_loss', 'noob_vs_smart']);
  assert.deepEqual([opts.data.duration.min, opts.data.duration.max, opts.data.duration.default], [14, 22, 17]);
  assert.doesNotMatch(opts.data.product, /RBLX/);
  const a = await generate(IDEA, 17);
  assert.equal(a.status, 200);
  assert.equal(a.data.status, 'accepted', JSON.stringify(a.data.rejection));
  const sm = a.data.summary!;
  for (const k of ['title', 'engineTitle', 'duration', 'environment', 'characters', 'causalProp', 'motionProfile', 'seed']) assert.ok(sm[k] !== undefined && sm[k] !== '', k);
  assert.equal(sm.motionProfile, 'corrected-head-v2');
  assert.equal(sm.seed, 17);
  assert.match(a.data.safety.status, /^Passed/);
  assert.match(a.data.availability.status, /^Passed/);
  assert.ok(a.data.cards.length >= 8);
  assert.ok(a.data.cards.every((c) => typeof c.start === 'number' && c.character && c.action && (c.camera as string[]).length > 0 && c.purpose));
  const st = reduce(initialState(1), { type: 'generated', generation: a.data });
  assert.equal(st.screen, 'storyboard');
  assert.equal(canApprove(st), true);
  const b = await generate(IDEA, 17);
  assert.equal(b.data.generationId, a.data.generationId);
  assert.equal(b.data.episodeSha256, a.data.episodeSha256, 'deterministic storyboard');
});

test('2. an unsafe idea shows its rejection and cannot be approved', { timeout: 60000 }, async () => {
  const r = await generate('Kira waits behind the door with a cricket bat for Zapp.', 5);
  assert.equal(r.data.status, 'rejected');
  assert.equal(r.data.rejection?.category, 'unsafe');
  assert.ok(r.data.rejection!.title && r.data.rejection!.reason);
  assert.equal(r.data.safety.status, 'Blocked');
  assert.deepEqual(r.data.cards, []);
  assert.ok(r.data.blocking.length > 0);
  const st = reduce(initialState(1), { type: 'generated', generation: r.data });
  assert.equal(canApprove(st), false);
  assert.equal(reduce(st, { type: 'approved', approval: { generationId: r.data.generationId } as ApprovalView }).approval, null);
  const ap = await post<{ error: string }>('/api/story/approve', { generationId: r.data.generationId });
  assert.equal(ap.status, 409);
});

test('3. the approved episode stays immutable when form values change or another storyboard is generated', { timeout: 120000 }, async () => {
  const g = (await generate(IDEA, 17)).data;
  const ap = await post<ApprovalView>('/api/story/approve', { generationId: g.generationId });
  assert.equal(ap.status, 200);
  assert.equal(ap.data.seed, 17);
  assert.equal(ap.data.sha256, g.episodeSha256);
  let st = reduce(reduce(initialState(1), { type: 'generated', generation: g }), { type: 'approved', approval: ap.data });
  const frozen = structuredClone(st.approval);
  const other = (await generate(IDEA, 18)).data;
  st = reduce(st, { type: 'form', patch: { idea: 'something else', seed: 18, duration: 20 } });
  st = reduce(st, { type: 'generating' });
  st = reduce(st, { type: 'generated', generation: other });
  assert.deepEqual(st.approval, frozen);
  assert.ok(Object.isFrozen(st.approval));
  assert.equal(st.generation?.generationId, g.generationId, 'a new storyboard never replaces an approved one');
  const again = await get<ApprovalView>(`/api/story/approved/${ap.data.approvalId}`);
  assert.equal(again.data.sha256, g.episodeSha256);
  assert.equal(again.data.intact, true);
  const file = readFileSync(join(ROOT, STATE, 'approved', ap.data.approvalId, 'episode.json'), 'utf8');
  assert.equal(createHash('sha256').update(file).digest('hex'), g.episodeSha256);
  assert.equal((await post<ApprovalView>('/api/story/approve', { generationId: g.generationId })).data.approvalId, ap.data.approvalId, 'content-addressed');
});

test('4. rendering cannot start without an approval', { timeout: 60000 }, async () => {
  const g = (await generate(IDEA, 17)).data;
  assert.equal((await post('/api/story/render', {})).status, 400);
  assert.equal((await post('/api/story/render', { generationId: g.generationId })).status, 400);
  assert.equal((await post('/api/story/render', { approvalId: 'a-0000000000000000' })).status, 404);
  assert.equal((await post('/api/story/render', { episode: 'free text idea' })).status, 400);
  const st = reduce(initialState(1), { type: 'generated', generation: g });
  assert.equal(canRender(st), false);
  assert.equal(reduce(st, { type: 'job', job: { id: 'job1', approvalId: 'a-x' } as JobView }).job, null);
  assert.equal(rendered.length, 0, 'the renderer was never called');
});

test('5. a successful render exposes the MP4 and the approved episode JSON', { timeout: 60000 }, async () => {
  const g = (await generate(IDEA, 17)).data;
  const ap = (await post<ApprovalView>('/api/story/approve', { generationId: g.generationId })).data;
  const start = await post<JobView>('/api/story/render', { approvalId: ap.approvalId, quality: 'final' });
  assert.equal(start.status, 202);
  let job = start.data;
  for (let i = 0; i < 100 && (job.state === 'queued' || job.state === 'running'); i++) { await new Promise((r) => setTimeout(r, 50)); job = (await get<JobView>(`/api/jobs/${job.id}`)).data; }
  assert.equal(job.state, 'done', JSON.stringify(job));
  assert.equal(job.stage, 'Complete');
  assert.equal(rendered.at(-1), `${STATE}/approved/${ap.approvalId}/episode.json`, 'rendered the approved file only');
  assert.deepEqual([job.media?.resolution, job.media?.fps, job.media?.video, job.media?.audio], ['1080x1920', 30, 'H.264 High', 'AAC 48 kHz stereo']);
  assert.deepEqual(job.quality, { passed: 26, total: 26, failed: [] });
  const mp4 = await fetch(base + job.outputs.mp4);
  assert.equal(mp4.status, 200);
  assert.equal(mp4.headers.get('content-type'), 'video/mp4');
  const ej = await fetch(base + job.outputs.episodeJson);
  assert.equal(ej.status, 200);
  assert.match(ej.headers.get('content-disposition') ?? '', /^attachment; filename=".+\.json"$/);
  assert.equal(createHash('sha256').update(await ej.text()).digest('hex'), ap.sha256);
});
