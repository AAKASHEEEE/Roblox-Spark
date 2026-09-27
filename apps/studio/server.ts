// RBLX SPARK Studio — local single-user control plane. One command: `npm start` -> http://localhost:5173
// API: episodes, library, validation, render jobs (in-process queue, one job at a time).
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { startServer, sendJson, readBody, ROOT } from '../render-worker/lib/server.ts';
import { loadLibrary } from '../render-worker/lib/library.ts';
import { renderEpisode, ensureWebBuild } from '../render-worker/render.ts';
import { validateEpisode } from '../../packages/pipeline/src/validate.ts';

interface Job { id: string; episode: string; scale: number; state: 'queued' | 'running' | 'done' | 'failed'; phase: string; done: number; total: number; startedAt?: number; finishedAt?: number; outDir?: string; outputs?: Record<string, string>; error?: string; gates?: string }
const jobs: Job[] = [];
let running = false;

async function pump(): Promise<void> {
  if (running) return;
  const job = jobs.find((j) => j.state === 'queued');
  if (!job) return;
  running = true; job.state = 'running'; job.startedAt = Date.now();
  try {
    const epFile = `episodes/${job.episode}.json`;
    const out = join('out', job.scale === 1 ? job.episode : `${job.episode}-preview`);
    const r = await renderEpisode({ episode: epFile, out, scale: job.scale, onProgress: (p) => { job.phase = p.phase; job.done = p.done; job.total = p.total; } });
    job.outDir = relative(ROOT, r.outDir);
    const id = job.episode;
    const o: Record<string, string> = {};
    for (const [k, f] of [['mp4', `${id}.mp4`], ['thumbnail', 'thumbnail.png'], ['episode', 'episode.json'], ['quality', 'quality-report.md'], ['contactSheet', 'contact-sheet.png'], ['renderLog', 'render-log.json'], ['validation', 'validation.json']]) if (existsSync(join(r.outDir, f))) o[k] = `/${job.outDir}/${f}`;
    job.outputs = o;
    job.gates = r.report ? `${r.report.summary.passed}/${r.report.summary.total}` : undefined;
    job.state = r.mp4 ? 'done' : 'failed';
    if (!r.mp4) job.error = 'validation failed — see validation.json';
  } catch (e) { job.state = 'failed'; job.error = String(e); }
  job.finishedAt = Date.now(); running = false;
  void pump();
}

const listEpisodes = () => readdirSync(join(ROOT, 'episodes')).filter((f) => f.endsWith('.json')).map((f) => {
  const e = JSON.parse(readFileSync(join(ROOT, 'episodes', f), 'utf8'));
  return { id: f.replace(/\.json$/, ''), title: e.episode?.title, duration: e.episode?.duration };
});

ensureWebBuild(console.log);
const port = Number(process.env.PORT ?? 5173);
const { url } = await startServer(port, async (req, res, u) => {
  const p = u.pathname;
  if (p === '/api/episodes' && req.method === 'GET') { sendJson(res, 200, listEpisodes()); return true; }
  const m = p.match(/^\/api\/episodes\/([a-z0-9_-]+)$/);
  if (m && req.method === 'GET') { const f = join(ROOT, 'episodes', `${m[1]}.json`); if (!existsSync(f)) { sendJson(res, 404, { error: 'not found' }); return true; } sendJson(res, 200, JSON.parse(readFileSync(f, 'utf8'))); return true; }
  if (m && req.method === 'PUT') {
    // Save/duplicate: only data that passes validation is written. Never executes content.
    const body = JSON.parse(await readBody(req));
    const v = validateEpisode(body, loadLibrary(), { repair: false });
    if (!v.ok) { sendJson(res, 422, v); return true; }
    writeFileSync(join(ROOT, 'episodes', `${m[1]}.json`), JSON.stringify(body, null, 2));
    sendJson(res, 200, { saved: m[1] }); return true;
  }
  if (p === '/api/library') { const l = loadLibrary(); sendJson(res, 200, l); return true; }
  if (p === '/api/validate' && req.method === 'POST') { sendJson(res, 200, validateEpisode(JSON.parse(await readBody(req)), loadLibrary(), { repair: true })); return true; }
  if (p === '/api/render' && req.method === 'POST') {
    const { episode, scale } = JSON.parse(await readBody(req));
    if (!/^[a-z0-9_-]+$/.test(episode) || !existsSync(join(ROOT, 'episodes', `${episode}.json`))) { sendJson(res, 400, { error: 'unknown episode' }); return true; }
    const job: Job = { id: `job${jobs.length + 1}`, episode, scale: scale === 0.5 ? 0.5 : 1, state: 'queued', phase: 'queued', done: 0, total: 1 };
    jobs.push(job); void pump();
    sendJson(res, 202, job); return true;
  }
  if (p === '/api/jobs') { sendJson(res, 200, jobs); return true; }
  const j = p.match(/^\/api\/jobs\/(job\d+)$/);
  if (j) { const job = jobs.find((x) => x.id === j[1]); sendJson(res, job ? 200 : 404, job ?? { error: 'not found' }); return true; }
  if (p === '/api/health') { sendJson(res, 200, { ok: true, jobs: jobs.length, running }); return true; }
  return false;
});
console.log(`RBLX SPARK Studio running at ${url}`);
