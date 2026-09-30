// Bulk generator core — mocks only: no renderer, browser, FFmpeg or MP4 is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { getEventListeners } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BulkError, BulkRunner, BulkStore, JobQueue, JOB_STATES, TRANSITIONS, assertPortable, buildManifest, canTransition, deriveSeed,
  duplicateWithNewSeed, isBulkError, parseBatchRequest, serializeManifest, sha256Hex, writeManifest,
  type EpisodePipeline, type RenderResult, type ResolvedBatch, type ApprovalResult, type Timers,
} from '../packages/bulk/src/index.ts';
import { NodeBulkFs } from '../packages/bulk/node/node-fs.ts';

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const clock = () => new FakeTime();
const made: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'bulk-test-')); made.push(d); return d; };

const H = (s: string) => sha256Hex(s);
const kira = () => ({ characterId: 'kira', version: '1.1.0', contentHash: H('kira@1.1.0') });
const zapp = () => ({ characterId: 'zapp', version: '1.0.0', contentHash: H('zapp@1.0.0') });
const classroom = () => ({ environmentId: 'classroom', version: '1.1.0', contentHash: H('classroom@1.1.0') });
function episode(id: string, extra: Record<string, unknown> = {}) {
  return { episodeId: id, prompt: `What if ${id} happened?`, characterRefs: [kira(), zapp()], environmentRef: classroom(), ...extra };
}

/** Deterministic fake time: one clock for the store and the runner's timers; no real sleeps anywhere. */
class FakeTime implements Timers {
  t = T0;
  now = () => this.t;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void; every: number | null }>();
  created = 0; cleared = 0;
  get active() { return this.timers.size; }
  setInterval(fn: () => void, ms: number) { this.created++; const id = ++this.seq; this.timers.set(id, { at: this.t + ms, fn, every: ms }); return id; }
  setTimeout(fn: () => void, ms: number) { this.created++; const id = ++this.seq; this.timers.set(id, { at: this.t + ms, fn, every: null }); return id; }
  clearInterval(h: unknown) { if (this.timers.delete(h as number)) this.cleared++; }
  clearTimeout(h: unknown) { if (this.timers.delete(h as number)) this.cleared++; }
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void; every: number | null }] | null = null;
      for (const e of this.timers) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      const [id, tm] = next;
      this.t = tm.at;
      if (tm.every === null) { this.timers.delete(id); this.cleared++; } else tm.at += tm.every;
      tm.fn();
    }
    this.t = end;
  }
}
/** yield to the event loop (setImmediate, not a timed sleep) so pending promise chains settle */
const flush = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const until = async (cond: () => boolean, what: string) => { for (let i = 0; i < 200; i++) { if (cond()) return; await flush(1); } assert.fail(`timed out waiting for ${what}`); };
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
const okRender = (dir: string, target = 'draft'): RenderResult => ({ ok: true, rendererVersion: 'mock-renderer@1', artifacts: { mp4: `${dir}/${target}.mp4` } });
function request(n = 3, extra: Record<string, unknown> = {}, eps?: unknown[]): any {
  return {
    schemaVersion: '1.0', batchId: 'batch-a', title: 'Batch title', mode: 'narrated_story', concurrency: 1,
    defaults: { storyPattern: 'comparison', captionPreset: 'shorts-default', draftQuality: '540x960', finalQuality: '1080x1920' },
    episodes: eps ?? Array.from({ length: n }, (_, i) => episode(`ep-${String(i + 1).padStart(2, '0')}`)),
    ...extra,
  };
}
function parse(raw: unknown, limits = {}): ResolvedBatch {
  const r = parseBatchRequest(raw, limits);
  assert.ok(r.ok, JSON.stringify(!r.ok && r.issues));
  return r.batch;
}
const issuesOf = (raw: unknown, limits = {}) => { const r = parseBatchRequest(raw, limits); assert.ok(!r.ok, 'expected rejection'); return r.issues.map((i) => `${i.path} ${i.message}`).join('\n'); };

function setup(raw: unknown = request(), dir = tmp(), c: FakeTime = clock(), leaseMs = 60_000) {
  const store = new BulkStore(new NodeBulkFs(dir), { clock: c });
  const batch = parse(raw);
  store.createBatch(batch);
  return { dir, c, store, batch, queue: new JobQueue(store, { leaseMs }) };
}

interface MockOpts {
  render?: (ep: string, attempt: number, target: string, signal: AbortSignal) => RenderResult | 'hang' | Promise<RenderResult> | undefined;
  approve?: (ep: string) => ApprovalResult | undefined;
  delayMs?: number;
  onRender?: (ep: string) => void;
}
function mockPipeline(o: MockOpts = {}) {
  const calls: string[] = [];
  let active = 0, maxActive = 0;
  const wait = (n: number) => flush(n); // event-loop yields, not timed sleeps
  const p: EpisodePipeline = {
    async validate(ep) { calls.push(`validate:${ep.episodeId}`); return { ok: true }; },
    async generateStoryboard(ep) { calls.push(`storyboard:${ep.episodeId}`); return { ok: true, projectHash: sha256Hex(`${ep.inputHash}:project`), projectRef: { id: ep.episodeId } }; },
    async approve(proj) { calls.push(`approve:${proj.request.episodeId}`); return o.approve?.(proj.request.episodeId) ?? { status: 'approved', approvedHash: sha256Hex(`${proj.projectHash}:ok`), approval: { by: 'mock' } }; },
    renderDraft: (a, ctx) => render(a.request.episodeId, a.outputDir, a.request.seed, ctx.attempt, 'draft', ctx.signal),
    renderFinal: (a, ctx) => render(a.request.episodeId, a.outputDir, a.request.seed, ctx.attempt, 'final', ctx.signal),
  };
  async function render(ep: string, dir: string, seed: number, attempt: number, target: string, signal: AbortSignal): Promise<RenderResult> {
    calls.push(`render-${target}:${ep}:${attempt}`);
    active++; maxActive = Math.max(maxActive, active);
    try {
      o.onRender?.(ep);
      const forced = o.render?.(ep, attempt, target, signal);
      if (forced instanceof Promise) return await forced;
      if (forced === 'hang') await new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true }));
      await wait(o.delayMs ?? 1);
      if (forced) return forced as RenderResult;
      return { ok: true, rendererVersion: 'mock-renderer@1', artifacts: { mp4: `${dir}/${target}.mp4`, mp4Sha256: sha256Hex(`${ep}:${seed}:${target}`), episodeJson: `${dir}/episode.json`, timeline: `${dir}/timeline.json`, qualityReport: `${dir}/quality-report.json` } };
    } finally { active--; }
  }
  return { p, calls, get maxActive() { return maxActive; } };
}
/** run a promise to completion while advancing fake time in fixed steps (deterministic; no timed sleeps) */
async function drive<T>(p: Promise<T>, time: FakeTime, step = 50): Promise<T> {
  let done = false;
  p.then(() => { done = true; }, () => { done = true; });
  while (!done) { await flush(5); if (!done) time.advance(step); }
  return p;
}
const states = (q: JobQueue) => Object.fromEntries(q.list('batch-a').map((j) => [j.episodeId, j.state]));

// ── schema ──────────────────────────────────────────────────────────────────────────────────────────────────────────
test('schema: valid batch resolves with defaults; unknown keys and unknown modes are rejected', () => {
  const b = parse(request(2, {}, [episode('a'), episode('b', { storyPattern: 'hypothetical', output: 'both', tags: ['kids'], metadata: { series: 's1' } })]));
  assert.equal(b.episodes[0].storyPattern, 'comparison');
  assert.equal(b.episodes[0].captionPreset, 'shorts-default');
  assert.equal(b.episodes[0].output, 'draft');
  assert.equal(b.episodes[1].output, 'both');
  assert.equal(b.episodes[0].outputDir, 'batch-a/a');
  assert.equal(b.maxAttempts, 2);
  assert.match(b.inputHash, /^[0-9a-f]{64}$/);
  assert.match(issuesOf(request(1, { extra: 1 })), /\$\.extra unknown key/);
  assert.match(issuesOf(request(1, {}, [episode('a', { hairColor: 'red' })])), /episodes\[0\]\.hairColor unknown key/);
  assert.match(issuesOf(request(1, { defaults: { ...request().defaults, bogus: true } })), /defaults\.bogus unknown key/);
  assert.match(issuesOf(request(1, { mode: 'live_action' })), /\$\.mode/);
  assert.match(issuesOf(request(1, { schemaVersion: '2.0' })), /schemaVersion/);
});

test('schema: prototype-pollution keys are rejected anywhere', () => {
  const raw = JSON.parse(`{"__proto__":{"polluted":true},"episodes":[{"metadata":{"constructor":"x"}}]}`);
  const text = issuesOf({ ...request(1), ...raw });
  const nested = JSON.parse(JSON.stringify(request(1)).replace('"prompt"', '"__proto__":{"a":1},"prompt"'));
  assert.match(issuesOf(nested), /episodes\[0\]\.__proto__ forbidden key/);
  assert.match(issuesOf(JSON.parse(`{"__proto__":{"x":1}}`)), /\$\.__proto__ forbidden key/);
  assert.match(text, /\$\.__proto__ forbidden key/);
  assert.match(text, /\$\.episodes\[0\]\.metadata\.constructor forbidden key/);
  assert.equal(({} as any).polluted, undefined);
});

test('schema: duplicate IDs, duplicate seeds, batch limit and invalid concurrency are rejected', () => {
  assert.match(issuesOf(request(0, {}, [episode('a'), episode('a')])), /duplicate episode ID "a"/);
  assert.match(issuesOf(request(0, {}, [episode('a', { seed: 7 }), episode('b', { seed: 7 })])), /seed 7 duplicates episode "a"/);
  parse(request(0, {}, [episode('a', { seed: 7 }), episode('b', { seed: 7 })]), { requireUniqueSeeds: false });
  assert.match(issuesOf(request(21)), /21 episodes; limit is 20/);
  assert.match(issuesOf(request(3), { maxEpisodes: 2 }), /limit is 2/);
  parse(request(20));
  assert.match(issuesOf(request(3, { concurrency: 0 })), /concurrency/);
  assert.match(issuesOf(request(3, { concurrency: 1.5 })), /integer/);
  assert.match(issuesOf(request(3, { concurrency: 5 })), /exceeds limit 4/);
  assert.match(issuesOf(request(2, { concurrency: 3 })), /exceeds episode count 2/);
  assert.match(issuesOf(request(0, {}, [])), /at least 1/);
});

test('schema: unsafe paths and output paths outside the configured root are rejected', () => {
  for (const bad of ['../escape', '/etc/passwd', 'C:\\x', 'a/../../b', 'a//b', './a', 'file:///x', 'a\u0000b', '~/x']) {
    assert.match(issuesOf(request(0, {}, [episode('a', { outputDir: bad })])), /outputDir unsafe path/, bad);
    assert.match(issuesOf(request(0, {}, [episode('a', { voiceOver: { ref: bad, contentHash: H('vo') } })])), /voiceOver\.ref unsafe path/, bad);
  }
  assert.match(issuesOf(request(0, {}, [episode('a', { outputDir: 'elsewhere/a' })]), { outputRoot: 'bulk' }), /outside the configured root "bulk"/);
  assert.equal(parse(request(1), { outputRoot: 'bulk' }).episodes[0].outputDir, 'bulk/batch-a/ep-01');
  assert.match(issuesOf(request(0, {}, [episode('a', { outputDir: 'x/a' }), episode('b', { outputDir: 'x/a/b' })])), /overlaps episode "a"/);
});

// ── seeds ───────────────────────────────────────────────────────────────────────────────────────────────────────────
test('seeds: deterministic, order-independent, append-stable; hash matches node:crypto', () => {
  for (const s of ['', 'abc', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'ünïcødé 🎬'.repeat(9)]) assert.equal(sha256Hex(s), createHash('sha256').update(s).digest('hex'));
  const seeds = (b: ResolvedBatch) => Object.fromEntries(b.episodes.map((e) => [e.episodeId, e.seed]));
  const a = seeds(parse(request(4)));
  assert.deepEqual(seeds(parse(request(4))), a);
  const reordered = request(4); reordered.episodes.reverse();
  assert.deepEqual(seeds(parse(reordered)), a);
  const appended = request(4); appended.episodes.push(episode('ep-99'));
  const s5 = seeds(parse(appended));
  for (const k of Object.keys(a)) assert.equal(s5[k], a[k]);
  assert.equal(s5['ep-01'], deriveSeed('batch-a', 'ep-01', 0));
  assert.notEqual(seeds(parse(request(4, { batchSeed: 1 })))['ep-01'], a['ep-01']);
  assert.notEqual(seeds(parse(request(4, { batchId: 'batch-b' })))['ep-01'], a['ep-01']);
  const explicit = parse(request(0, {}, [episode('a', { seed: 42 })]));
  assert.equal(explicit.episodes[0].seed, 42);
  assert.equal(explicit.episodes[0].seedDerived, false);
});

test('seeds: "duplicate with new seed" yields a deterministic new variant and leaves the original alone', () => {
  const req = request(2);
  const v1 = duplicateWithNewSeed(req, 'ep-01', 1);
  assert.deepEqual(duplicateWithNewSeed(req, 'ep-01', 1), v1);
  const v2 = duplicateWithNewSeed(req, 'ep-01', 2);
  const b = parse({ ...req, episodes: [...req.episodes, v1, v2] });
  const byId = Object.fromEntries(b.episodes.map((e) => [e.episodeId, e]));
  assert.equal(byId['ep-01'].seed, parse(req).episodes[0].seed);
  assert.equal(byId['ep-01-v1'].seed, deriveSeed('batch-a', 'ep-01', 0, 1));
  assert.equal(new Set([byId['ep-01'].seed, byId['ep-01-v1'].seed, byId['ep-01-v2'].seed]).size, 3);
  assert.equal(byId['ep-01-v1'].prompt, byId['ep-01'].prompt);
  assert.match(issuesOf({ ...req, episodes: [...req.episodes, { ...v1, variantOf: 'nope' }] }), /unknown episode "nope"/);
});

// ── state machine ───────────────────────────────────────────────────────────────────────────────────────────────────
test('states: the happy path and retry/recovery edges are legal; everything unlisted is illegal', () => {
  const happy = ['pending', 'validating', 'storyboard', 'awaiting_approval', 'approved', 'queued', 'leased', 'rendering', 'validating_output', 'completed'] as const;
  for (let i = 1; i < happy.length; i++) assert.ok(canTransition(happy[i - 1], happy[i]), `${happy[i - 1]}→${happy[i]}`);
  for (const [f, t] of [['failed', 'retry_pending'], ['retry_pending', 'queued'], ['retry_pending', 'pending'], ['rendering', 'queued'], ['storyboard', 'pending'], ['queued', 'cancelled']] as const) assert.ok(canTransition(f, t));
  for (const [f, t] of [['pending', 'completed'], ['queued', 'rendering'], ['completed', 'failed'], ['cancelled', 'pending'], ['failed', 'queued'], ['awaiting_approval', 'queued'], ['pending', 'pending']] as const) assert.ok(!canTransition(f, t), `${f}→${t}`);
  assert.equal(TRANSITIONS.completed.length + TRANSITIONS.cancelled.length, 0);
  assert.equal(Object.keys(TRANSITIONS).length, JOB_STATES.length);
});

test('states: illegal transitions fail through the queue and leave the store untouched', () => {
  const { queue, store } = setup();
  const before = store.readState('batch-a').revision;
  assert.throws(() => queue.enqueue('batch-a', 'batch-a--ep-01'), (e) => isBulkError(e, 'ILLEGAL_TRANSITION'));
  assert.throws(() => queue.retry('batch-a', 'batch-a--ep-01'), (e) => isBulkError(e, 'RETRY_NOT_ALLOWED'));
  assert.equal(store.readState('batch-a').revision, before);
  const c = queue.claimPrep('batch-a', 'w1')!;
  assert.throws(() => queue.advance(c.lease, 'completed'), (e) => isBulkError(e, 'ILLEGAL_TRANSITION'));
  assert.equal(queue.get('batch-a', c.job.jobId).state, 'validating');
});

// ── persistence ─────────────────────────────────────────────────────────────────────────────────────────────────────
test('persistence: content-hashed atomic envelopes; orphan temp files are ignored and swept', () => {
  const { dir, store, queue } = setup();
  const bdir = join(dir, 'batches', 'batch-a');
  assert.deepEqual(readdirSync(bdir).sort(), ['batch.json', 'state.json']);
  const env = JSON.parse(readFileSync(join(bdir, 'state.json'), 'utf8'));
  assert.equal(env.format, 'spark-bulk');
  assert.match(env.contentHash, /^[0-9a-f]{64}$/);
  // simulate a crash mid-write: a torn temp file next to the intact target
  writeFileSync(join(bdir, 'state.json.tmp-999-1'), '{"format":"spark-bu');
  assert.equal(store.readState('batch-a').jobs.length, 3);
  queue.claimPrep('batch-a', 'w1');
  assert.deepEqual(store.recover('batch-a'), ['state.json.tmp-999-1']);
  assert.deepEqual(readdirSync(bdir).sort(), ['batch.json', 'state.json']);
  assert.deepEqual(store.listBatches(), ['batch-a']);
  assert.throws(() => store.createBatch(parse(request())), (e) => isBulkError(e, 'ALREADY_EXISTS'));
  const reopened = new BulkStore(new NodeBulkFs(dir));
  assert.equal(reopened.readState('batch-a').jobs[0].state, 'validating');
  assert.equal(reopened.loadBatch('batch-a').batch.inputHash, parse(request()).inputHash);
});

test('persistence: tampered or truncated store files are detected as STORE_CORRUPT', () => {
  const { dir, store } = setup();
  const p = join(dir, 'batches', 'batch-a', 'state.json');
  const good = readFileSync(p, 'utf8');
  writeFileSync(p, good.replace('"seed": ', '"seed": 1'));
  assert.throws(() => store.readState('batch-a'), (e) => isBulkError(e, 'STORE_CORRUPT') && /hash mismatch/.test((e as Error).message));
  writeFileSync(p, good.slice(0, good.length / 2));
  assert.throws(() => store.readState('batch-a'), (e) => isBulkError(e, 'STORE_CORRUPT'));
  assert.throws(() => new JobQueue(store).leaseNext('batch-a', 'w1'), (e) => isBulkError(e, 'STORE_CORRUPT'));
  writeFileSync(p, good);
  assert.equal(store.readState('batch-a').jobs.length, 3);
});

// ── leasing ─────────────────────────────────────────────────────────────────────────────────────────────────────────
function queueAll(queue: JobQueue) {
  for (;;) {
    const c = queue.claimPrep('batch-a', 'prep');
    if (!c) break;
    queue.advance(c.lease, 'storyboard'); queue.advance(c.lease, 'awaiting_approval', { projectHash: 'a'.repeat(64) });
    queue.advance(c.lease, 'approved', { approvedHash: 'b'.repeat(64) }); queue.enqueue('batch-a', c.job.jobId);
  }
}

test('leasing: two workers (separate store instances) never own the same job; stale tokens are refused', () => {
  const { dir, c, queue } = setup(request(2));
  queueAll(queue);
  const other = new JobQueue(new BulkStore(new NodeBulkFs(dir), { clock: c }));
  const a = queue.leaseNext('batch-a', 'w1')!, b = other.leaseNext('batch-a', 'w2')!;
  assert.notEqual(a.job.jobId, b.job.jobId);
  assert.equal(queue.leaseNext('batch-a', 'w3'), null);
  assert.throws(() => other.advance({ ...a.lease, token: b.lease.token }, 'rendering'), (e) => isBulkError(e, 'LEASE_LOST'));
  c.t += 30_000;
  const renewed = queue.renewLease(a.lease);
  assert.equal(renewed.expiresAt, new Date(c.t + 60_000).toISOString());
  queue.advance(a.lease, 'rendering');
  assert.equal(queue.get('batch-a', a.job.jobId).lease?.workerId, 'w1');
});

test('leasing: an expired lease is recovered to queued with the same seed; the old holder loses it', () => {
  const { c, queue } = setup(request(1), tmp(), clock(), 1_000);
  queueAll(queue);
  const a = queue.leaseNext('batch-a', 'w1')!;
  queue.advance(a.lease, 'rendering');
  c.t += 1_001;
  assert.equal(queue.leaseNext('batch-a', 'w2'), null);
  assert.throws(() => queue.renewLease(a.lease), (e) => isBulkError(e, 'LEASE_LOST'));
  const moved = queue.recoverExpiredLeases('batch-a');
  assert.deepEqual(moved.map((j) => j.state), ['queued']);
  const b = queue.leaseNext('batch-a', 'w2')!;
  assert.equal(b.job.seed, a.job.seed);
  assert.equal(b.job.attempt, 1);
  assert.notEqual(b.lease.token, a.lease.token);
  assert.throws(() => queue.complete(a.lease), (e) => isBulkError(e, 'LEASE_LOST'));
});

test('leasing: a live cross-process store lock blocks, a stale one (crashed process) is broken', () => {
  const { dir, c, store } = setup(request(1));
  const lock = join(dir, 'batches', 'batch-a', 'state.lock');
  writeFileSync(lock, JSON.stringify({ owner: 'other-proc', expiresAt: c.t + 10_000 }));
  const impatient = new BulkStore(new NodeBulkFs(dir), { clock: c, lockWaitMs: 20 });
  assert.throws(() => new JobQueue(impatient).claimPrep('batch-a', 'w1'), (e) => isBulkError(e, 'STORE_LOCKED'));
  c.t += 10_001;
  assert.ok(new JobQueue(store).claimPrep('batch-a', 'w1'));
  assert.ok(!readdirSync(join(dir, 'batches', 'batch-a')).includes('state.lock'));
});

// ── runner ──────────────────────────────────────────────────────────────────────────────────────────────────────────
test('runner: injected mock pipeline completes multiple episodes under the concurrency limit', async () => {
  const eps = Array.from({ length: 6 }, (_, i) => episode(`ep-${i + 1}`, i === 0 ? { output: 'both' } : {}));
  const { queue } = setup(request(0, { concurrency: 2 }, eps));
  const m = mockPipeline({ delayMs: 10 });
  const events: string[] = [];
  const summary = await new BulkRunner(queue, m.p).run('batch-a', { onEvent: (e) => events.push(e.type) });
  assert.deepEqual({ completed: summary.completed, failed: summary.failed, open: summary.open }, { completed: 6, failed: 0, open: 0 });
  assert.equal(m.maxActive, 2);
  const j1 = queue.get('batch-a', 'batch-a--ep-1');
  assert.deepEqual(Object.keys(j1.outputs).sort(), ['draft', 'final']);
  assert.equal(j1.outputs.final!.mp4, 'batch-a/ep-1/final.mp4');
  assert.deepEqual(j1.history.map((h) => h.state), ['pending', 'validating', 'storyboard', 'awaiting_approval', 'approved', 'queued', 'leased', 'rendering', 'validating_output', 'completed']);
  assert.ok(events.includes('done') && events.includes('state'));
  const wide = setup(request(0, { concurrency: 4 }, eps));
  const m4 = mockPipeline({ delayMs: 10 });
  await new BulkRunner(wide.queue, m4.p).run('batch-a', { concurrency: 3 });
  assert.equal(m4.maxActive, 3);
});

test('runner: continue-on-error (default) finishes the others; permanent failures are not retried', async () => {
  const { queue } = setup(request(4));
  const m = mockPipeline({ render: (ep) => (ep === 'ep-02' ? { ok: false, code: 'BAD_SCENE', message: 'unrenderable', retryable: false } : undefined) });
  const s = await new BulkRunner(queue, m.p).run('batch-a');
  assert.deepEqual([s.completed, s.failed], [3, 1]);
  const j = queue.get('batch-a', 'batch-a--ep-02');
  assert.deepEqual([j.state, j.error?.code, j.retryable, j.attempt], ['failed', 'BAD_SCENE', false, 1]);
  assert.equal(m.calls.filter((c) => c.startsWith('render-draft:ep-02')).length, 1);
  assert.throws(() => queue.retry('batch-a', j.jobId), (e) => isBulkError(e, 'RETRY_NOT_ALLOWED'));
});

test('runner: stopOnFirstError stops claiming new work and leaves untouched jobs resumable', async () => {
  const { queue } = setup(request(4, { policy: { stopOnFirstError: true } }));
  const m = mockPipeline({ render: (ep) => (ep === 'ep-01' ? { ok: false, message: 'boom', retryable: false } : undefined) });
  const s = await new BulkRunner(queue, m.p).run('batch-a');
  assert.equal(s.stoppedEarly, true);
  assert.deepEqual(states(queue), { 'ep-01': 'failed', 'ep-02': 'pending', 'ep-03': 'pending', 'ep-04': 'pending' });
  const again = await new BulkRunner(queue, mockPipeline().p).run('batch-a', { stopOnFirstError: false });
  assert.deepEqual([again.completed, again.failed], [3, 1]);
});

test('runner: retryable failures (incl. timeouts) retry with the same seed and stop at max attempts', async () => {
  const { queue, c } = setup(request(3));
  const m = mockPipeline({
    render: (ep, attempt) => ep === 'ep-01' && attempt === 1 ? { ok: false, code: 'GPU_BUSY', message: 'transient', retryable: true }
      : ep === 'ep-02' && attempt === 1 ? 'hang'
      : ep === 'ep-03' ? { ok: false, code: 'FLAKY', message: 'always', retryable: true } : undefined,
  });
  const retries: string[] = [];
  const s = await drive(new BulkRunner(queue, m.p).run('batch-a', { timers: c, defaultTimeoutMs: 100, onEvent: (e) => { if (e.type === 'retry') retries.push(`${e.jobId}:${e.code}`); } }), c);
  assert.equal(c.active, 0, 'no timers left behind');
  assert.deepEqual([s.completed, s.failed], [2, 1]);
  const [j1, j2, j3] = queue.list('batch-a');
  assert.deepEqual([j1.state, j1.attempt, j1.errors[0].code], ['completed', 2, 'GPU_BUSY']);
  assert.deepEqual([j2.state, j2.attempt, j2.errors[0].code], ['completed', 2, 'TIMEOUT']);
  assert.deepEqual([j3.state, j3.attempt, j3.retryable], ['failed', 2, false]);
  assert.equal(m.calls.filter((c) => c.startsWith('render-draft:ep-03')).length, 2, 'no infinite retries');
  assert.equal(m.calls.filter((c) => c.startsWith('validate:ep-01')).length, 1, 'render retry reuses the approval');
  assert.equal(j1.seed, parse(request(3)).episodes[0].seed);
  assert.equal(retries.length, 3);
  assert.throws(() => queue.retry('batch-a', j3.jobId), (e) => isBulkError(e, 'RETRY_NOT_ALLOWED'));
});

test('runner: cancellation aborts in-flight work and cancels open jobs; a cancelled job cannot be resumed', async () => {
  const { queue } = setup(request(3, { concurrency: 2 }));
  const ac = new AbortController();
  const m = mockPipeline({ render: () => 'hang', onRender: () => setImmediate(() => ac.abort()) });
  const s = await new BulkRunner(queue, m.p).run('batch-a', { signal: ac.signal });
  assert.equal(s.aborted, true);
  assert.equal(s.cancelled, 3);
  assert.ok(queue.list('batch-a').every((j) => j.state === 'cancelled' && j.lease === null));
  assert.throws(() => queue.retry('batch-a', 'batch-a--ep-01'), (e) => isBulkError(e, 'RETRY_NOT_ALLOWED'));
  const again = await new BulkRunner(queue, mockPipeline().p).run('batch-a');
  assert.equal(again.completed, 0);
  // single-job cancel while leased: the holder loses its lease
  const one = setup(request(1));
  queueAll(one.queue);
  const l = one.queue.leaseNext('batch-a', 'w1')!;
  one.queue.cancel('batch-a', l.job.jobId);
  assert.throws(() => one.queue.advance(l.lease, 'rendering'), (e) => isBulkError(e, 'LEASE_LOST'));
});

test('runner: restart/resume after pending approval and a crashed worker', async () => {
  const dir = tmp(), c = clock();
  const { queue } = setup(request(3), dir, c, 5_000);
  let approveEp03 = false;
  const approve = (ep: string): ApprovalResult | undefined => (ep === 'ep-03' && !approveEp03 ? { status: 'pending' } : undefined);
  // first process: ep-01 is leased then the worker "crashes" (never reports back)
  const first = await new BulkRunner(queue, mockPipeline({ approve }).p).run('batch-a');
  assert.deepEqual(states(queue), { 'ep-01': 'completed', 'ep-02': 'completed', 'ep-03': 'awaiting_approval' });
  const crashed = setup(request(2, { batchId: 'batch-a' }), tmp(), c, 5_000);
  queueAll(crashed.queue);
  crashed.queue.leaseNext('batch-a', 'dead-worker');
  c.t += 6_000;
  // second process: fresh store instances over the same directories
  approveEp03 = true;
  const s1 = await new BulkRunner(new JobQueue(new BulkStore(new NodeBulkFs(dir), { clock: c })), mockPipeline({ approve }).p).run('batch-a');
  assert.equal(first.awaitingApproval, 1);
  assert.deepEqual([s1.completed, s1.awaitingApproval], [3, 0]);
  const s2 = await new BulkRunner(new JobQueue(new BulkStore(new NodeBulkFs(crashed.dir), { clock: c })), mockPipeline().p).run('batch-a');
  assert.deepEqual([s2.completed, s2.open], [2, 0]);
  const recovered = new JobQueue(new BulkStore(new NodeBulkFs(crashed.dir))).get('batch-a', 'batch-a--ep-01');
  assert.ok(recovered.history.some((h) => h.note?.startsWith('lease expired (dead-worker)')));
  assert.equal(recovered.attempt, 1);
});

test('manifest: deterministic, portable, with hashes, artifacts, failures and counts', async () => {
  const run = async () => {
    const { store, queue } = setup(request(3));
    const m = mockPipeline({ render: (ep) => (ep === 'ep-03' ? { ok: false, code: 'BAD', message: 'nope', retryable: false } : undefined) });
    await new BulkRunner(queue, m.p).run('batch-a');
    return writeManifest(store, 'batch-a');
  };
  const a = await run(), b = await run();
  assert.equal(serializeManifest(a), serializeManifest(b));
  assert.deepEqual(a.counts, { total: 3, completed: 2, failed: 1, cancelled: 0, awaitingApproval: 0, open: 0 });
  assert.deepEqual(a.failures.map((f) => [f.episodeId, f.code]), [['ep-03', 'BAD']]);
  assert.deepEqual(a.rendererVersions, ['mock-renderer@1']);
  assert.equal(a.batchInputHash, parse(request(3)).inputHash);
  const j = a.jobs[0];
  assert.match(j.approvedHash!, /^[0-9a-f]{64}$/);
  assert.equal(j.artifacts.draft!.mp4Sha256, sha256Hex(`ep-01:${j.seed}:draft`));
  assert.deepEqual([j.artifacts.draft!.timeline, j.artifacts.draft!.qualityReport], ['batch-a/ep-01/timeline.json', 'batch-a/ep-01/quality-report.json']);
  assert.equal(a.startedAt, new Date(T0).toISOString());
  assert.ok(!serializeManifest(a).includes(tmpdir()), 'no machine-specific paths');
  // renderer returning an absolute path is refused before it can reach a manifest
  const bad = setup(request(1));
  await new BulkRunner(bad.queue, mockPipeline({ render: () => ({ ok: true, rendererVersion: 'x', artifacts: { mp4: '/abs/out.mp4' } }) }).p).run('batch-a');
  assert.equal(bad.queue.list('batch-a')[0].error?.code, 'OUTPUT_INVALID');
  assert.throws(() => assertPortable({ p: '/home/me/x.mp4' }), (e) => isBulkError(e, 'UNSAFE_PATH'));
  assert.equal(buildManifest(bad.batch, bad.queue.list('batch-a')).counts.failed, 1);
});

process.on('exit', () => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

// ── exact resource pins ─────────────────────────────────────────────────────────────────────────────────────────────
test('pins: exact character/environment pins are accepted and set-like arrays are canonical', () => {
  const b = parse(request(0, {}, [episode('a', { characterRefs: [zapp(), kira()], tags: ['z', 'a', 'z'] }), episode('b')]));
  assert.deepEqual(b.episodes[0].characterRefs, [kira(), zapp()], 'sorted by characterId');
  assert.deepEqual(b.episodes[0].environmentRef, classroom());
  assert.deepEqual(b.episodes[0].tags, ['a', 'z']);
  const other = parse(request(0, {}, [episode('b'), episode('a', { characterRefs: [kira(), zapp()], tags: ['a', 'z'] })]));
  assert.equal(other.inputHash, b.inputHash, 'episode order and set order do not change the batch input hash');
  assert.equal(other.episodes[1].inputHash, b.episodes[0].inputHash);
  assert.notEqual(parse(request(0, {}, [episode('a', { characterRefs: [{ ...kira(), version: '1.0.0' }] }), episode('b')])).inputHash, b.inputHash);
});

test('pins: missing or ranged versions, malformed hashes and unhashed voice-over files are rejected', () => {
  const noVersion = { characterId: 'kira', contentHash: H('k') };
  const noHash = { characterId: 'kira', version: '1.0.0' };
  assert.match(issuesOf(request(0, {}, [episode('a', { characterRefs: [noVersion] })])), /characterRefs\[0\]\.version required/);
  assert.match(issuesOf(request(0, {}, [episode('a', { characterRefs: [noHash] })])), /characterRefs\[0\]\.contentHash required/);
  assert.match(issuesOf(request(0, {}, [episode('a', { environmentRef: { environmentId: 'classroom', version: '1.1.0' } })])), /environmentRef\.contentHash required/);
  for (const v of ['latest', '^1.0.0', '~1.0.0', '1.x', '1.0', '1', '>=1.0.0', '1.0.0-beta', '01.0.0', 'v1.0.0', '*']) {
    assert.match(issuesOf(request(0, {}, [episode('a', { characterRefs: [{ ...kira(), version: v }] })])), /characterRefs\[0\]\.version does not match/, v);
    assert.match(issuesOf(request(0, {}, [episode('a', { environmentRef: { ...classroom(), version: v } })])), /environmentRef\.version does not match/, v);
  }
  for (const h of [H('x').toUpperCase(), H('x').slice(1), `${H('x')}0`, 'g'.repeat(64), '']) {
    assert.match(issuesOf(request(0, {}, [episode('a', { characterRefs: [{ ...kira(), contentHash: h }] })])), /contentHash does not match/, h);
  }
  assert.match(issuesOf(request(0, {}, [episode('a', { characterRefs: [kira(), kira()] })])), /duplicate character "kira"/);
  assert.match(issuesOf(request(0, {}, [episode('a', { voiceOver: { ref: 'vo/a.wav' } })])), /voiceOver\.contentHash required/);
  assert.match(issuesOf(request(0, {}, [{ ...episode('a'), characterIds: ['kira'] }])), /characterIds unknown key/);
});

test('pins: exact refs and voice-over hash are frozen in the job input and appear in the manifest', async () => {
  const vo = { ref: 'vo/ep-01.wav', format: 'wav', contentHash: H('voice') };
  const { store, queue, c } = setup(request(0, {}, [episode('ep-01', { voiceOver: vo, characterRefs: [zapp(), kira()] }), episode('ep-02')]));
  const j = queue.get('batch-a', 'batch-a--ep-01');
  assert.deepEqual(j.input, { characterRefs: [kira(), zapp()], environmentRef: classroom(), voiceOver: vo });
  const frozen = JSON.stringify(j.input);
  let first = true;
  const m = mockPipeline({ render: (ep) => (ep === 'ep-01' && first ? ((first = false), { ok: false, message: 'transient', retryable: true }) : undefined) });
  await drive(new BulkRunner(queue, m.p).run('batch-a', { timers: c }), c);
  const after = queue.get('batch-a', 'batch-a--ep-01');
  assert.equal(after.attempt, 2);
  assert.equal(JSON.stringify(after.input), frozen, 'retry keeps the immutable input');
  const man = writeManifest(store, 'batch-a');
  assert.deepEqual(man.jobs[0].input, { characterRefs: [kira(), zapp()], environmentRef: classroom(), voiceOver: vo });
  assert.deepEqual(man.resources, { characters: [kira(), zapp()], environments: [classroom()] });
  assert.ok(serializeManifest(man).includes(H('voice')));
});

// ── leases, heartbeat, timeout ──────────────────────────────────────────────────────────────────────────────────────
test('lease: a long-running healthy job keeps renewing and can never be double-claimed', async () => {
  const { dir, queue, c } = setup(request(1), tmp(), clock(), 1_000);
  const other = new JobQueue(new BulkStore(new NodeBulkFs(dir), { clock: c }), { leaseMs: 1_000 });
  const d = deferred<RenderResult>();
  let renders = 0;
  const run = new BulkRunner(queue, mockPipeline({ render: () => { renders++; return d.promise; } }).p).run('batch-a', { timers: c, heartbeatMs: 250 });
  await until(() => renders === 1, 'render start');
  const leaseStart = queue.get('batch-a', 'batch-a--ep-01').lease!;
  for (let i = 0; i < 50; i++) {
    c.advance(100); // 5 s total = 5 lease lengths
    assert.equal(other.leaseNext('batch-a', 'intruder'), null);
    assert.equal(other.claimPrep('batch-a', 'intruder'), null);
    assert.deepEqual(other.recoverExpiredLeases('batch-a'), []);
  }
  const lease = queue.get('batch-a', 'batch-a--ep-01').lease!;
  assert.equal(lease.token, leaseStart.token, 'renewal keeps the token');
  assert.ok(Date.parse(lease.expiresAt) > c.t, 'lease still live');
  d.resolve(okRender('batch-a/ep-01'));
  const s = await drive(run, c);
  assert.equal(s.completed, 1);
  assert.equal(renders, 1);
  assert.equal(c.active, 0);
  await assert.rejects(new BulkRunner(queue, mockPipeline().p).run('batch-a', { heartbeatMs: 1_000 }), /heartbeatMs 1000 must be > 0 and < leaseMs 1000/);
});

test('lease: wrong, expired or superseded tokens cannot renew (and never revive a lease)', () => {
  const { queue, c } = setup(request(1), tmp(), clock(), 1_000);
  queueAll(queue);
  const a = queue.leaseNext('batch-a', 'w1')!;
  assert.throws(() => queue.renewLease({ ...a.lease, token: 'w1:0:forged' }), (e) => isBulkError(e, 'LEASE_LOST'));
  assert.throws(() => queue.renewLease({ ...a.lease, jobId: 'batch-a--nope' }), (e) => isBulkError(e, 'NOT_FOUND'));
  c.t += 1_000; // exactly at expiry → expired
  assert.throws(() => queue.renewLease(a.lease), (e) => isBulkError(e, 'LEASE_LOST'));
  queue.recoverExpiredLeases('batch-a');
  const b = queue.leaseNext('batch-a', 'w2')!;
  const before = queue.get('batch-a', b.job.jobId).lease;
  assert.throws(() => queue.renewLease(a.lease), (e) => isBulkError(e, 'LEASE_LOST'));
  assert.deepEqual(queue.get('batch-a', b.job.jobId).lease, before, 'w2 lease untouched');
  assert.equal(queue.renewLease(b.lease).workerId, 'w2');
});

test('lease: lease loss aborts the stage and its late result cannot complete the job', async () => {
  const { dir, queue, c } = setup(request(1), tmp(), clock(), 1_000);
  const other = new JobQueue(new BulkStore(new NodeBulkFs(dir), { clock: c }), { leaseMs: 1_000 });
  const d = deferred<RenderResult>();
  let signal: AbortSignal | null = null;
  const events: string[] = [];
  const run = new BulkRunner(queue, mockPipeline({ render: (_e, _a, _t, sig) => { signal = sig; return d.promise; } }).p)
    .run('batch-a', { timers: c, heartbeatMs: 250, onEvent: (e) => events.push(e.type) });
  await until(() => signal !== null, 'render start');
  c.t += 1_500; // the worker stalls past expiry without beating (timers not fired)
  other.recoverExpiredLeases('batch-a');
  const stolen = other.leaseNext('batch-a', 'w-other')!;
  c.advance(250); // next heartbeat → LEASE_LOST → abort
  assert.equal(signal!.aborted, true);
  d.resolve(okRender('batch-a/ep-01')); // late success
  await drive(run, c);
  const j = queue.get('batch-a', 'batch-a--ep-01');
  assert.deepEqual([j.state, j.lease?.token, j.outputs], ['leased', stolen.lease.token, {}]);
  assert.ok(events.includes('lease_lost'));
  assert.ok(!events.includes('cancelled') && !events.includes('fatal'), 'genuine loss is classified as lease loss only');
  assert.equal(c.active, 0);
});

test('timeout: aborts the stage, commits TIMEOUT, and a late result cannot change the terminal state', async () => {
  const { queue, c } = setup(request(1, { policy: { maxAttempts: 1 } }));
  const d = deferred<RenderResult>();
  let signal: AbortSignal | null = null;
  const run = new BulkRunner(queue, mockPipeline({ render: (_e, _a, _t, sig) => { signal = sig; return d.promise; } }).p)
    .run('batch-a', { timers: c, defaultTimeoutMs: 5_000, heartbeatMs: 1_000 });
  await until(() => signal !== null, 'render start');
  c.advance(4_999);
  assert.equal(signal!.aborted, false);
  c.advance(1);
  const s = await drive(run, c);
  assert.equal(signal!.aborted, true);
  const failed = queue.get('batch-a', 'batch-a--ep-01');
  assert.deepEqual([failed.state, failed.error?.code, failed.retryable, s.failed], ['failed', 'TIMEOUT', false, 1]);
  d.resolve(okRender('batch-a/ep-01'));
  await flush();
  assert.deepEqual(queue.get('batch-a', 'batch-a--ep-01'), failed, 'late result changed nothing');
  assert.equal(c.active, 0);
});

test('heartbeat: timers are released on success, failure, cancellation and lease-loss exits', async () => {
  const scenarios: [string, MockOpts, (ac: AbortController) => void][] = [
    ['success', {}, () => {}],
    ['permanent failure', { render: () => ({ ok: false, message: 'x', retryable: false }) }, () => {}],
    ['thrown error', { render: () => Promise.reject(new Error('boom')) }, () => {}],
    ['cancellation', { render: () => 'hang' }, (ac) => ac.abort()],
  ];
  for (const [name, o, act] of scenarios) {
    const { queue, c } = setup(request(2, { concurrency: 2 }));
    const ac = new AbortController();
    const m = mockPipeline({ ...o, onRender: () => setImmediate(() => act(ac)) });
    await drive(new BulkRunner(queue, m.p).run('batch-a', { timers: c, signal: ac.signal, heartbeatMs: 1_000 }), c);
    assert.equal(c.active, 0, `${name}: active timers`);
    assert.equal(c.created, c.cleared, `${name}: every timer cleared`);
    assert.ok(c.created >= 2, `${name}: heartbeats were started`);
  }
});

test('stopOnFirstError: no new claims after the first failure; the in-flight claim finishes and commits', async () => {
  const { queue, c } = setup(request(4, { concurrency: 2, policy: { stopOnFirstError: true } }));
  const d1 = deferred<RenderResult>(), d2 = deferred<RenderResult>();
  const started = new Set<string>();
  const run = new BulkRunner(queue, mockPipeline({ render: (ep) => { started.add(ep); return ep === 'ep-01' ? d1.promise : d2.promise; } }).p)
    .run('batch-a', { timers: c, heartbeatMs: 1_000 });
  await until(() => started.size === 2, 'two renders in flight');
  d1.resolve({ ok: false, code: 'GPU_BUSY', message: 'transient', retryable: true });
  await flush();
  assert.equal(queue.get('batch-a', 'batch-a--ep-02').state, 'rendering', 'in-flight job is not aborted');
  d2.resolve(okRender('batch-a/ep-02'));
  const s = await drive(run, c);
  assert.deepEqual(states(queue), { 'ep-01': 'failed', 'ep-02': 'completed', 'ep-03': 'pending', 'ep-04': 'pending' });
  const f = queue.get('batch-a', 'batch-a--ep-01');
  assert.deepEqual([f.attempt, f.retryable, s.stoppedEarly], [1, true, true], 'no auto-retry; retryable flag kept for resume');
  assert.deepEqual([...started].sort(), ['ep-01', 'ep-02']);
  assert.equal(c.active, 0);
});

// ── abort-cause classification + heartbeat error handling ───────────────────────────────────────────────────────────
/** One job rendering under fake time; `render` resolves only when the test says so. */
async function startRendering(opts: { lockWaitMs?: number } = {}) {
  const dir = tmp(), c = clock();
  setup(request(1), dir, c, 1_000);
  const store = new BulkStore(new NodeBulkFs(dir), { clock: c, lockWaitMs: opts.lockWaitMs });
  const queue = new JobQueue(store, { leaseMs: 1_000 });
  const d = deferred<RenderResult>();
  const ac = new AbortController();
  const events: { type: string; code?: string }[] = [];
  let signal: AbortSignal | null = null;
  const pipeline = mockPipeline({ render: (_e, _a, _t, sig) => { signal = sig; return d.promise; } }).p;
  const run = new BulkRunner(queue, pipeline).run('batch-a', { timers: c, heartbeatMs: 250, signal: ac.signal, onEvent: (e) => events.push(e as { type: string }) });
  run.catch(() => { /* asserted by the caller */ });
  await until(() => signal !== null, 'render start');
  const types = () => events.map((e) => e.type);
  return { dir, c, store, queue, d, ac, run, events, types, signal: () => signal!, statePath: join(dir, 'batches', 'batch-a', 'state.json') };
}
function assertClean(h: { c: FakeTime; ac: AbortController; signal: () => AbortSignal }) {
  assert.equal(h.c.active, 0, 'no live timers');
  assert.equal(h.c.created, h.c.cleared, 'every timer cleared');
  assert.equal(getEventListeners(h.ac.signal, 'abort').length, 0, 'run signal listener removed');
  assert.equal(getEventListeners(h.signal(), 'abort').length, 0, 'job signal listeners removed');
}

test('abort cause: external cancellation is reported as cancelled, never lease_lost, with one terminal transition', async () => {
  const h = await startRendering();
  h.ac.abort();
  const s = await drive(h.run, h.c);
  assert.equal(h.signal().aborted, true);
  assert.deepEqual((h.signal().reason as { kind: string }).kind, 'cancelled');
  assert.ok(h.types().includes('cancelled'));
  assert.ok(!h.types().includes('lease_lost') && !h.types().includes('failed'));
  h.d.resolve(okRender('batch-a/ep-01')); // late result
  await flush();
  const j = h.queue.get('batch-a', 'batch-a--ep-01');
  assert.deepEqual([j.state, j.outputs, s.cancelled], ['cancelled', {}, 1]);
  assert.equal(j.history.filter((x) => x.state === 'cancelled').length, 1, 'no duplicate terminal transition');
  assertClean(h);
});

test('heartbeat: one transient STORE_LOCKED is retried and the next renewal recovers the lease', async () => {
  const h = await startRendering({ lockWaitMs: 0 });
  const lock = join(h.dir, 'batches', 'batch-a', 'state.lock');
  writeFileSync(lock, JSON.stringify({ owner: 'other-proc', expiresAt: h.c.t + 60_000 }));
  h.c.advance(250); // renewal hits the live foreign lock
  rmSync(lock);
  assert.deepEqual(h.events.filter((e) => e.type === 'heartbeat_retry').map((e) => e.code), ['STORE_LOCKED']);
  assert.equal(h.signal().aborted, false, 'transient error does not abort');
  h.c.advance(250); // next beat renews
  assert.equal(h.queue.get('batch-a', 'batch-a--ep-01').lease!.expiresAt, new Date(h.c.t + 1_000).toISOString());
  h.d.resolve(okRender('batch-a/ep-01'));
  const s = await drive(h.run, h.c);
  assert.equal(s.completed, 1);
  assertClean(h);
});

test('heartbeat: STORE_CORRUPT aborts, surfaces from run(), and the late result never commits', async () => {
  const h = await startRendering();
  const good = readFileSync(h.statePath, 'utf8');
  writeFileSync(h.statePath, good.replace('"attempt": 1', '"attempt": 9')); // tampered → hash mismatch
  h.c.advance(250);
  assert.equal(h.signal().aborted, true);
  assert.equal((h.signal().reason as { kind: string }).kind, 'heartbeat_fatal');
  h.d.resolve(okRender('batch-a/ep-01'));
  await assert.rejects(drive(h.run, h.c), (e) => isBulkError(e, 'STORE_CORRUPT'));
  assert.ok(h.types().includes('fatal') && !h.types().includes('lease_lost') && !h.types().includes('cancelled'));
  writeFileSync(h.statePath, good); // operator restores the store: nothing was committed after the abort
  const j = h.queue.get('batch-a', 'batch-a--ep-01');
  assert.deepEqual([j.state, j.outputs], ['rendering', {}]);
  assertClean(h);
});

test('heartbeat: an unexpected renewal error aborts and surfaces instead of being swallowed', async () => {
  const h = await startRendering();
  const boom = new Error('EIO: unexpected renewal failure');
  h.queue.renewLease = () => { throw boom; };
  h.c.advance(250);
  assert.equal((h.signal().reason as { kind: string }).kind, 'heartbeat_fatal');
  h.d.resolve(okRender('batch-a/ep-01'));
  await assert.rejects(drive(h.run, h.c), (e) => e === boom);
  assert.deepEqual(h.events.filter((e) => e.type === 'fatal').map((e) => e.code), ['UNEXPECTED']);
  const j = h.queue.get('batch-a', 'batch-a--ep-01');
  assert.deepEqual([j.state, j.outputs], ['rendering', {}], 'late result not committed; lease left to expire for recovery');
  assert.ok(!h.events.some((e) => e.type === 'state' && (e as { state?: string }).state === 'completed'), 'never reported as completed');
  assertClean(h);
  // the job is recoverable: after the lease expires a fresh run completes it
  h.c.t += 2_000;
  const again = await drive(new BulkRunner(new JobQueue(h.store, { leaseMs: 1_000 }), mockPipeline().p).run('batch-a', { timers: h.c, heartbeatMs: 250 }), h.c);
  assert.equal(again.completed, 1);
});
