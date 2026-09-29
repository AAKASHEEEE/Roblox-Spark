// Narrated Story (Phase 1) API: voice-over upload + validation, narrated storyboard generation, download.
// Security: uploads are size-capped raw bodies; the client filename is display-only (never a path); files are stored
// content-addressed as <sha256>.<format> OUTSIDE the statically served tree; the bytes must match the declared
// container and the decoder must report an allowed codec; FFmpeg (MP3/M4A only) runs via execFile with an argument
// array, a forced demuxer and a file-only protocol whitelist, never through a shell. Every request is re-validated here.
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { sendJson, type ApiHandler } from '../render-worker/lib/server.ts';
import { sha256 } from '../render-worker/lib/library.ts';
import type { Registry } from '../../packages/story/src/registry.ts';
import { AudioRejection, MAX_UPLOAD_BYTES, checkContainer, checkDecoded, checkFilename, decodeWav, type AudioFormat, type DecodedAudio } from '../../packages/narrated/src/audio.ts';
import { SilenceGuidedAligner } from '../../packages/narrated/src/align.ts';
import { generateNarratedStoryboard, type AudioMeta, type NarratedResult } from '../../packages/narrated/src/pipeline.ts';
import { CAPTION_PRESETS, STORY_PATTERNS, NARRATED_SCHEMA_VERSION } from '../../packages/narrated/src/schema.ts';
import { DEFAULT_MOTION_PROFILE } from '../../packages/schema/src/render-compat.ts';
import { NARRATED_DRAFT_DURATION, type DraftRenderer } from './narrated-draft.ts';

export const NARRATED_UI_TEXT = {
  renderNotice: 'Approve the storyboard to render a low-resolution draft. Draft Preview — Not Final Quality (540x960); final-quality narrated rendering is not implemented yet.',
  draftLabel: 'Draft Preview — Not Final Quality',
  reupload: 'Re-upload the same voice-over file to continue.',
};
const REJECT_TITLE: Record<string, string> = {
  invalid_input: 'Invalid input', unsafe: 'Blocked: unsafe content', protected_ip: 'Blocked: protected IP',
  unavailable: 'Not available: a character or asset is not in the library', story_incompatible: 'Script not compatible with the narrated storyboard',
  timeline_incompatible: 'Timeline not compatible with the voice-over',
};
const PATTERN_TITLE: Record<string, string> = { comparison: 'Comparison', hypothetical: 'Hypothetical ("imagine if…")', escalating_consequence: 'Escalating consequence', narrated_comedy: 'Narrated comedy' };
const HASH = /^[0-9a-f]{64}$/;

/** shown whenever MP3/M4A cannot be decoded; the Studio never installs FFmpeg itself */
export const FFMPEG_SETUP = 'MP3 and M4A voice-overs need FFmpeg: install it so that `ffmpeg` is on PATH, or start the Studio with FFMPEG_PATH=/absolute/path/to/ffmpeg, then restart the Studio. WAV voice-overs work without FFmpeg.';
export interface FfmpegStatus { available: boolean; path: string | null; source: 'FFMPEG_PATH' | 'PATH'; version: string | null; problem: string | null }
/**
 * Explicit FFmpeg resolution (same convention as FFPROBE_PATH in apps/render-worker/lib/probe-node.ts):
 * FFMPEG_PATH, when set, must be an absolute path to a runnable FFmpeg (no silent fallback); otherwise `ffmpeg` on PATH.
 * The check runs `<bin> -version` via execFile (argument array, no shell) and requires an "ffmpeg version" banner.
 */
export function ffmpegStatus(env: Record<string, string | undefined> = process.env): FfmpegStatus {
  const set = env.FFMPEG_PATH, source = set ? 'FFMPEG_PATH' as const : 'PATH' as const;
  const no = (problem: string): FfmpegStatus => ({ available: false, path: null, source, version: null, problem });
  if (set && (!isAbsolute(set) || !existsSync(set))) return no(`FFMPEG_PATH is set to "${set}", which is not an absolute path to an existing file`);
  const bin = set ?? 'ffmpeg';
  try {
    const out = execFileSync(bin, ['-hide_banner', '-version'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    const version = /^ffmpeg version (\S+)/.exec(out)?.[1] ?? null;
    return version ? { available: true, path: bin, source, version, problem: null } : no(`${set ? 'FFMPEG_PATH' : '`ffmpeg` on PATH'} is not an FFmpeg executable`);
  } catch { return no(set ? `FFMPEG_PATH (${set}) could not be run` : 'FFmpeg was not found on PATH'); }
}

/** decode + validate an uploaded file already stored at `file` (our own content-addressed path) */
export async function decodeAudioFile(file: string, format: AudioFormat, ffmpeg: string | null): Promise<DecodedAudio> {
  const bytes = new Uint8Array(readFileSync(file));
  checkContainer(bytes, format);
  let a: DecodedAudio;
  if (format === 'wav') a = decodeWav(bytes);
  else {
    if (!ffmpeg) throw new AudioRejection('DECODER_UNAVAILABLE', `FFmpeg is not available on this Studio server, so ${format.toUpperCase()} cannot be decoded. ${FFMPEG_SETUP}`);
    const rate = 16000;
    const { stdout, stderr } = await new Promise<{ stdout: Buffer; stderr: string }>((ok, fail) => execFile(ffmpeg,
      ['-hide_banner', '-nostdin', '-protocol_whitelist', 'file', '-f', format === 'mp3' ? 'mp3' : 'mov', '-i', file, '-map', '0:a:0', '-vn', '-sn', '-dn', '-t', '310', '-ac', '1', '-ar', String(rate), '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1'],
      { encoding: 'buffer', maxBuffer: rate * 2 * 320, timeout: 60000, windowsHide: true },
      (err, out, errOut) => err ? fail(new AudioRejection('NOT_DECODABLE', `the file could not be decoded as ${format.toUpperCase()}`)) : ok({ stdout: out as Buffer, stderr: String(errOut) })));
    const m = /Stream #0:\d+[^:]*: Audio: ([a-z0-9_]+)[^,\n]*, (\d+) Hz, ([^,\n]+)/.exec(stderr);
    if (!m) throw new AudioRejection('NOT_DECODABLE', 'no audio stream found');
    const chText = m[3].trim(), channels = chText === 'mono' ? 1 : chText === 'stereo' ? 2 : /^(\d+)\.(\d+)/.test(chText) ? chText.split(/[.(]/).slice(0, 2).reduce((s, x) => s + Number(x || 0), 0) : Number(/^(\d+) channels/.exec(chText)?.[1] ?? 0);
    const n = Math.floor(stdout.length / 2), pcm = new Float32Array(n);
    for (let i = 0; i < n; i++) pcm[i] = stdout.readInt16LE(i * 2) / 32768;
    a = { format, codec: m[1], sampleRate: Number(m[2]), channels, durationSeconds: Math.round((n / rate) * 1000) / 1000, pcm, analysisRate: rate };
  }
  checkDecoded(a);
  return a;
}

async function readCapped(req: IncomingMessage, max: number): Promise<Buffer | null> {
  if (Number(req.headers['content-length'] ?? 0) > max) return null;
  const chunks: Buffer[] = []; let n = 0;
  for await (const c of req) { n += (c as Buffer).length; if (n > max) return null; chunks.push(c as Buffer); }
  return Buffer.concat(chunks);
}

export interface NarratedApiDeps { registry: Registry; stateDir: string; uploadDir: string; ffmpeg?: string | null; /** draft renderer (tests inject a mock); default = the real 540x960 draft render */ renderDraft?: DraftRenderer }
interface DraftJob { id: string; approvalId: string; state: 'queued' | 'running' | 'done' | 'failed'; stage: string; done: number; total: number; startedAt?: number; finishedAt?: number; outputs: Record<string, string>; error: string | null; quality: { passed: number; total: number; failed: string[] } | null }
export function createNarratedApi(deps: NarratedApiDeps): ApiHandler {
  const reg = deps.registry;
  const ff: FfmpegStatus = deps.ffmpeg === undefined ? ffmpegStatus() : { available: !!deps.ffmpeg, path: deps.ffmpeg, source: 'FFMPEG_PATH', version: null, problem: deps.ffmpeg ? null : 'FFmpeg disabled by configuration' };
  const ffmpeg = ff.path;
  mkdirSync(deps.uploadDir, { recursive: true }); mkdirSync(join(deps.stateDir, 'narrated'), { recursive: true });
  const metaFile = (h: string) => join(deps.uploadDir, `${h}.json`);
  let chain: Promise<unknown> = Promise.resolve();
  /** stored audio for a hash, re-verified against its content hash on every read */
  function storedAudio(h: string): { meta: AudioMeta; file: string } | null {
    if (!HASH.test(h) || !existsSync(metaFile(h))) return null;
    const meta = JSON.parse(readFileSync(metaFile(h), 'utf8')) as AudioMeta;
    const file = join(deps.uploadDir, `${h}.${meta.format}`);
    if (!existsSync(file) || sha256(readFileSync(file)) !== h) return null;
    return { meta, file };
  }
  const view = (gid: string, r: NarratedResult, request: unknown) => ({
    generationId: gid, status: r.status, request,
    rejection: r.rejection ? { category: r.rejection.category, title: REJECT_TITLE[r.rejection.category] ?? r.rejection.category, reason: r.rejection.reason, also: r.rejection.also } : null,
    storyboard: r.storyboard, speechRegions: r.alignment?.speechRegions ?? [], renderNotice: NARRATED_UI_TEXT.renderNotice,
  });
  // ---- approvals (content-addressed, written once) + draft jobs (one at a time; interrupted jobs need a manual retry) ----
  const AP = (...p: string[]) => join(deps.stateDir, 'narrated-approved', ...p);
  const jobsFile = join(deps.stateDir, 'narrated-jobs.json');
  const jobs: DraftJob[] = existsSync(jobsFile) ? JSON.parse(readFileSync(jobsFile, 'utf8')) : [];
  for (const j of jobs) if (j.state === 'queued' || j.state === 'running') { j.state = 'failed'; j.stage = 'failed'; j.error = 'interrupted: the Studio stopped during this draft render — press Retry'; }
  const saveJobs = () => { mkdirSync(deps.stateDir, { recursive: true }); writeFileSync(jobsFile, JSON.stringify(jobs, null, 1)); };
  let running = false;
  function readApproval(aid: string) {
    if (!/^na-[0-9a-f]{16}$/.test(aid) || !existsSync(AP(aid, 'approval.json'))) return null;
    const meta = JSON.parse(readFileSync(AP(aid, 'approval.json'), 'utf8'));
    const intact = existsSync(AP(aid, 'storyboard.json')) && sha256(readFileSync(AP(aid, 'storyboard.json'), 'utf8')) === meta.storyboardSha256;
    return { ...meta, intact, audioAvailable: !!storedAudio(meta.audioHash) };
  }
  async function pump(): Promise<void> {
    if (running) return;
    const job = jobs.find((j) => j.state === 'queued');
    if (!job) return;
    running = true; job.state = 'running'; job.stage = 'preparing'; job.startedAt = Date.now(); saveJobs();
    try {
      const ap = readApproval(job.approvalId);
      if (!ap?.intact) throw new Error('the approved storyboard on disk no longer matches its approval hash');
      const audio = storedAudio(ap.audioHash);
      if (!audio) throw new Error(`${NARRATED_UI_TEXT.reupload} (approved audio ${String(ap.audioHash).slice(0, 12)}… is not in the store or no longer matches its hash)`);
      const sbText = readFileSync(AP(job.approvalId, 'storyboard.json'), 'utf8');
      const jobDir = join(deps.stateDir, 'narrated-renders', job.approvalId, job.id);
      mkdirSync(jobDir, { recursive: true });
      let saved = 0;
      const render = deps.renderDraft ?? (await import('./narrated-draft.ts')).renderNarratedDraft;
      const r = await render({ storyboard: JSON.parse(sbText), storyboardSha256: ap.storyboardSha256, approvalId: job.approvalId, audioFile: audio.file, audioFormat: audio.meta.format, jobDir, ffmpeg,
        onStage: (stage, done = 0, total = 0) => { job.stage = stage; job.done = done; job.total = total; if (Date.now() - saved > 2000) { saved = Date.now(); saveJobs(); } } });
      job.outputs = { ...r.outputs, approvedJsonApi: `/api/narrated/approved/${job.approvalId}/storyboard.json` }; job.quality = r.quality ?? null;
      if (r.ok) { job.state = 'done'; job.stage = 'complete'; } else { job.state = 'failed'; job.stage = 'failed'; job.error = r.error ?? 'draft render failed'; }
    } catch (e) { job.state = 'failed'; job.stage = 'failed'; job.error = String((e as Error)?.message ?? e).slice(0, 400); }
    job.finishedAt = Date.now(); running = false; saveJobs();
    void pump();
  }
  const readGen = (gid: string) => /^n-[0-9a-f]{16}$/.test(gid) && existsSync(join(deps.stateDir, 'narrated', `${gid}.json`)) ? JSON.parse(readFileSync(join(deps.stateDir, 'narrated', `${gid}.json`), 'utf8')) as { request: unknown; result: NarratedResult } : null;

  return async (req, res, u) => {
    const p = u.pathname;
    if (p === '/api/narrated/options') {
      sendJson(res, 200, {
        characters: reg.ids.characters.map((id) => ({ id, name: reg.characters[id].displayName })), patterns: STORY_PATTERNS.map((id) => ({ id, title: PATTERN_TITLE[id] })),
        captionPresets: CAPTION_PRESETS.map((id) => ({ id, title: 'Shorts default (lower-middle, 2 lines)' })), formats: ffmpeg ? ['wav', 'mp3', 'm4a'] : ['wav'],
        ffmpeg: { available: ff.available, source: ff.source, version: ff.version, problem: ff.problem }, ffmpegSetup: FFMPEG_SETUP,
        maxUploadMB: MAX_UPLOAD_BYTES / 1024 / 1024, ...NARRATED_UI_TEXT,
      });
      return true;
    }
    if (p === '/api/narrated/upload' && req.method === 'POST') {
      let filename: string, format: AudioFormat, sanitized = false;
      try { ({ filename, format, sanitized } = checkFilename(decodeURIComponent(String(req.headers['x-filename'] ?? '')))); } catch (e) { req.resume(); sendJson(res, 400, { error: e instanceof AudioRejection ? e.message : 'invalid filename', code: (e as AudioRejection).code ?? 'BAD_FILENAME' }); return true; }
      const buf = await readCapped(req, MAX_UPLOAD_BYTES);
      if (!buf) { req.resume(); sendJson(res, 413, { error: `the upload exceeds ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`, code: 'TOO_LARGE' }); return true; }
      const h = sha256(buf), file = join(deps.uploadDir, `${h}.${format}`);
      try {
        checkContainer(new Uint8Array(buf), format);
        if (!existsSync(file)) writeFileSync(file, buf, { flag: 'wx' });
        const a = await decodeAudioFile(file, format, ffmpeg);
        const meta: AudioMeta = { originalFilename: filename, format, codec: a.codec, durationSeconds: a.durationSeconds, sampleRate: a.sampleRate, channels: a.channels, contentHash: h };
        writeFileSync(metaFile(h), JSON.stringify(meta));
        sendJson(res, 200, { ...meta, bytes: buf.length, displayNameSanitized: sanitized });
      } catch (e) {
        if (existsSync(file) && !existsSync(metaFile(h))) { try { unlinkSync(file); } catch { /* ignore */ } }
        sendJson(res, 422, { error: e instanceof AudioRejection ? e.message : 'the audio could not be validated', code: e instanceof AudioRejection ? e.code : 'NOT_DECODABLE' });
      }
      return true;
    }
    const au = p.match(/^\/api\/narrated\/audio\/([0-9a-f]{64})$/);
    if (au && req.method === 'GET') { const s = storedAudio(au[1]); sendJson(res, s ? 200 : 404, s ? s.meta : { error: NARRATED_UI_TEXT.reupload, reupload: true }); return true; }
    if (p === '/api/narrated/generate' && req.method === 'POST') {
      const raw = await readCapped(req, 64 * 1024);
      let b: any = null;
      try { b = raw ? JSON.parse(raw.toString('utf8')) : null; } catch { b = null; }
      if (!b || typeof b !== 'object' || Array.isArray(b)) { sendJson(res, 400, { error: 'request body must be a JSON object of at most 64 KB' }); return true; }
      const gid = `n-${sha256(JSON.stringify(b)).slice(0, 16)}`;
      const stored = typeof b.audioHash === 'string' ? storedAudio(b.audioHash) : null;
      const run = chain.then(async () => {
        const decoded = stored ? await decodeAudioFile(stored.file, stored.meta.format, ffmpeg) : null;
        return generateNarratedStoryboard(b, stored && decoded ? { meta: stored.meta, decoded, path: stored.file } : null, { registry: reg, aligner: new SilenceGuidedAligner(), sha256 });
      });
      chain = run.catch(() => undefined);
      let r: NarratedResult;
      try { r = await run; } catch (e) { sendJson(res, 422, { error: e instanceof AudioRejection ? e.message : 'the stored voice-over could not be decoded' }); return true; }
      writeFileSync(join(deps.stateDir, 'narrated', `${gid}.json`), JSON.stringify({ request: b, result: r, createdAt: new Date().toISOString() }));
      sendJson(res, 200, { ...view(gid, r, b), audioAvailable: !!stored }); return true;
    }
    const g = p.match(/^\/api\/narrated\/generations\/(n-[0-9a-f]{16})(\/storyboard\.json)?$/);
    if (g && req.method === 'GET') {
      const rec = readGen(g[1]);
      if (!rec) { sendJson(res, 404, { error: 'unknown narrated storyboard' }); return true; }
      if (!g[2]) { const hash = (rec.request as any)?.audioHash; sendJson(res, 200, { ...view(g[1], rec.result, rec.request), audioAvailable: typeof hash === 'string' && !!storedAudio(hash) }); return true; }
      if (!rec.result.storyboard) { sendJson(res, 409, { error: 'this request was rejected; there is no storyboard to download' }); return true; }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="${rec.result.storyboard.id}.json"`, 'cache-control': 'no-store' });
      res.end(JSON.stringify(rec.result.storyboard, null, 2)); return true;
    }
    if (p === '/api/narrated/approve' && req.method === 'POST') {
      const raw = await readCapped(req, 4096);
      let b: any = null; try { b = raw ? JSON.parse(raw.toString('utf8')) : null; } catch { b = null; }
      const rec = typeof b?.generationId === 'string' ? readGen(b.generationId) : null;
      if (!rec) { sendJson(res, 404, { error: 'unknown narrated storyboard' }); return true; }
      const sb = rec.result.storyboard;
      if (rec.result.status !== 'accepted' || !sb) { sendJson(res, 409, { error: 'only an accepted narrated storyboard can be approved' }); return true; }
      if (!storedAudio(sb.audio.contentHash)) { sendJson(res, 409, { error: `${NARRATED_UI_TEXT.reupload} The approval must reference a stored, hash-verified voice-over.` }); return true; }
      const D = sb.audio.durationSeconds;
      if (D < NARRATED_DRAFT_DURATION[0] || D > NARRATED_DRAFT_DURATION[1]) { sendJson(res, 409, { error: `narrated drafts need a ${NARRATED_DRAFT_DURATION[0]}-${NARRATED_DRAFT_DURATION[1]} s voice-over; this one is ${D} s` }); return true; }
      const text = JSON.stringify(sb), sha = sha256(text), aid = `na-${sha.slice(0, 16)}`;
      if (!existsSync(AP(aid, 'approval.json'))) {
        mkdirSync(AP(aid), { recursive: true });
        writeFileSync(AP(aid, 'storyboard.json'), text, { flag: 'wx' });
        const chunks = sb.script.phrases.reduce((n, x) => n + x.caption.chunks.length, 0);
        writeFileSync(AP(aid, 'approval.json'), JSON.stringify({ approvalId: aid, generationId: b.generationId, approvedAt: new Date().toISOString(), storyboardId: sb.id, title: sb.title, storyboardSha256: sha, audioHash: sb.audio.contentHash, audioFilename: sb.audio.originalFilename, phraseCount: sb.script.phrases.length, captionChunks: chunks, durationSeconds: D, seed: sb.seed, schemaVersion: sb.schemaVersion, motionProfile: DEFAULT_MOTION_PROFILE, warnings: D > 60 ? [`${D} s exceeds the preferred 35-60 s publishing range`] : [] }, null, 1), { flag: 'wx' });
      }
      sendJson(res, 200, readApproval(aid)); return true;
    }
    const ap = p.match(/^\/api\/narrated\/approved\/(na-[0-9a-f]{16})(\/storyboard\.json)?$/);
    if (ap && req.method === 'GET') {
      const a = readApproval(ap[1]);
      if (!a) { sendJson(res, 404, { error: 'unknown approval' }); return true; }
      if (!ap[2]) { sendJson(res, 200, a); return true; }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="${a.storyboardId}-approved.json"`, 'cache-control': 'no-store' });
      res.end(readFileSync(AP(ap[1], 'storyboard.json'))); return true;
    }
    if (p === '/api/narrated/render' && req.method === 'POST') {
      const raw = await readCapped(req, 4096);
      let b: any = null; try { b = raw ? JSON.parse(raw.toString('utf8')) : null; } catch { b = null; }
      if (typeof b?.approvalId !== 'string') { sendJson(res, 400, { error: 'draft rendering requires an approved narrated storyboard (approvalId)' }); return true; }
      const a = readApproval(b.approvalId);
      if (!a) { sendJson(res, 404, { error: 'unknown approval' }); return true; }
      if (!a.intact) { sendJson(res, 409, { error: 'the approved storyboard on disk no longer matches its approval hash' }); return true; }
      if (typeof b.audioHash === 'string' && b.audioHash !== a.audioHash) { sendJson(res, 409, { error: 'the voice-over was replaced: this approval belongs to a different audio file. Approve the storyboard again for the new voice-over.' }); return true; }
      if (!a.audioAvailable) { sendJson(res, 409, { error: `${NARRATED_UI_TEXT.reupload} (the approved voice-over is missing or no longer matches its hash)` }); return true; }
      if (jobs.some((j) => j.approvalId === a.approvalId && (j.state === 'queued' || j.state === 'running'))) { sendJson(res, 409, { error: 'a draft render of this approval is already in progress' }); return true; }
      const job: DraftJob = { id: `nj${jobs.length + 1}`, approvalId: a.approvalId, state: 'queued', stage: 'queued', done: 0, total: 0, outputs: {}, error: null, quality: null };
      jobs.push(job); saveJobs(); void pump();
      sendJson(res, 202, job); return true;
    }
    const nj = p.match(/^\/api\/narrated\/jobs\/(nj\d+)$/);
    if (nj && req.method === 'GET') { const j = jobs.find((x) => x.id === nj[1]); sendJson(res, j ? 200 : 404, j ?? { error: 'unknown draft job' }); return true; }
    return false;
  };
}
