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
import { CAPTION_PRESETS, STORY_PATTERNS } from '../../packages/narrated/src/schema.ts';

export const NARRATED_UI_TEXT = {
  renderNotice: 'Narrated rendering will be added after audio alignment and storyboard timing are validated.',
  reupload: 'Re-upload the same voice-over file to continue.',
};
const REJECT_TITLE: Record<string, string> = {
  invalid_input: 'Invalid input', unsafe: 'Blocked: unsafe content', protected_ip: 'Blocked: protected IP',
  unavailable: 'Not available: a character or asset is not in the library', story_incompatible: 'Script not compatible with the narrated storyboard',
  timeline_incompatible: 'Timeline not compatible with the voice-over',
};
const PATTERN_TITLE: Record<string, string> = { comparison: 'Comparison', hypothetical: 'Hypothetical ("imagine if…")', escalating_consequence: 'Escalating consequence', narrated_comedy: 'Narrated comedy' };
const HASH = /^[0-9a-f]{64}$/;

export function ffmpegPath(): string | null {
  const env = process.env.FFMPEG_PATH;
  const cand = env && isAbsolute(env) && existsSync(env) ? env : 'ffmpeg';
  try { execFileSync(cand, ['-hide_banner', '-version'], { stdio: 'ignore', timeout: 5000 }); return cand; } catch { return null; }
}

/** decode + validate an uploaded file already stored at `file` (our own content-addressed path) */
export async function decodeAudioFile(file: string, format: AudioFormat, ffmpeg: string | null): Promise<DecodedAudio> {
  const bytes = new Uint8Array(readFileSync(file));
  checkContainer(bytes, format);
  let a: DecodedAudio;
  if (format === 'wav') a = decodeWav(bytes);
  else {
    if (!ffmpeg) throw new AudioRejection('DECODER_UNAVAILABLE', `${format.toUpperCase()} needs FFmpeg on PATH (or FFMPEG_PATH); upload a WAV file instead`);
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

export interface NarratedApiDeps { registry: Registry; stateDir: string; uploadDir: string; ffmpeg?: string | null }
export function createNarratedApi(deps: NarratedApiDeps): ApiHandler {
  const reg = deps.registry, ffmpeg = deps.ffmpeg === undefined ? ffmpegPath() : deps.ffmpeg;
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
  const readGen = (gid: string) => /^n-[0-9a-f]{16}$/.test(gid) && existsSync(join(deps.stateDir, 'narrated', `${gid}.json`)) ? JSON.parse(readFileSync(join(deps.stateDir, 'narrated', `${gid}.json`), 'utf8')) as { request: unknown; result: NarratedResult } : null;

  return async (req, res, u) => {
    const p = u.pathname;
    if (p === '/api/narrated/options') {
      sendJson(res, 200, {
        characters: reg.ids.characters.map((id) => ({ id, name: reg.characters[id].displayName })), patterns: STORY_PATTERNS.map((id) => ({ id, title: PATTERN_TITLE[id] })),
        captionPresets: CAPTION_PRESETS.map((id) => ({ id, title: 'Shorts default (lower-middle, 2 lines)' })), formats: ffmpeg ? ['wav', 'mp3', 'm4a'] : ['wav'],
        maxUploadMB: MAX_UPLOAD_BYTES / 1024 / 1024, ...NARRATED_UI_TEXT,
      });
      return true;
    }
    if (p === '/api/narrated/upload' && req.method === 'POST') {
      let filename: string, format: AudioFormat;
      try { ({ filename, format } = checkFilename(decodeURIComponent(String(req.headers['x-filename'] ?? '')))); } catch (e) { req.resume(); sendJson(res, 400, { error: e instanceof AudioRejection ? e.message : 'invalid filename', code: (e as AudioRejection).code ?? 'BAD_FILENAME' }); return true; }
      const buf = await readCapped(req, MAX_UPLOAD_BYTES);
      if (!buf) { req.resume(); sendJson(res, 413, { error: `the upload exceeds ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`, code: 'TOO_LARGE' }); return true; }
      const h = sha256(buf), file = join(deps.uploadDir, `${h}.${format}`);
      try {
        checkContainer(new Uint8Array(buf), format);
        if (!existsSync(file)) writeFileSync(file, buf, { flag: 'wx' });
        const a = await decodeAudioFile(file, format, ffmpeg);
        const meta: AudioMeta = { originalFilename: filename, format, codec: a.codec, durationSeconds: a.durationSeconds, sampleRate: a.sampleRate, channels: a.channels, contentHash: h };
        writeFileSync(metaFile(h), JSON.stringify(meta));
        sendJson(res, 200, { ...meta, bytes: buf.length });
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
    return false;
  };
}
