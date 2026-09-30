// Full S7 narrated render: approved MP3 -> VO + explicit event SFX (NO MUSIC) -> fully composited H.264/AAC MP4.
// Usage:
//   node packages/captions/tools/render-full.ts --voice .scratch/voice/eleven-1.mp3 --ffmpeg /path/to/ffmpeg
// Output defaults to out/s7-full. The voice bytes must exactly match storyboard.audio.contentHash.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { launchBrowser } from '../../../apps/render-worker/lib/browser.ts';
import { aacRoundTrip } from '../../../apps/render-worker/lib/aac-check.ts';
import { verifyPlayback, mp4AudioAlignment } from '../../../apps/render-worker/lib/verify.ts';
import { loadLibrary, sha256 } from '../../../apps/render-worker/lib/library.ts';
import { startServer, ROOT } from '../../../apps/render-worker/lib/server.ts';
import { draftEpisodeFor, prepareIntegration } from '../../../apps/studio/narrated-draft.ts';
import { checkContainer } from '../../narrated/src/audio.ts';
import { compileNarratedTimeline } from '../../narrated/src/timeline.ts';
import { encodeAacLc } from '../../audio/src/aac/encoder.ts';
import { muxMp4 } from '../../mp4/src/mux.ts';
import { probeFile } from '../../../apps/render-worker/lib/probe-node.ts';
import { checkProductionProfile, PRODUCTION_SPEC } from '../../mp4/src/probe.ts';
import { mixPlanFromBeatSheet, mixVoiceSfx, encodeWavStereo } from '../../audio-mix/src/index.ts';
import { planBoldCaptions, phrasesFromBeats, checkBoldPlan } from '../src/bold.ts';
import { textGraphicsFromBeats } from '../src/graphics.ts';
import { vfxEventsFromBeats, VFX_DEFS } from '../../engine/src/vfx/index.ts';
import { TEXT_STYLE_DEFS } from '../src/styles.ts';
import { SFX_DEFS } from '../../audio-mix/src/sfx.ts';

const { values: arg } = parseArgs({ options: {
  voice: { type: 'string' }, ffmpeg: { type: 'string' }, out: { type: 'string', default: 'out/s7-full' },
  storyboard: { type: 'string', default: 'tests/fixtures/narrated/approved-narrated-v0.1.json' },
  beats: { type: 'string', default: 'packages/director/fixtures/free-coins-classroom.beats.json' },
  width: { type: 'string', default: '540' }, height: { type: 'string', default: '960' },
  bitrate: { type: 'string', default: '3000000' }, audioBitrate: { type: 'string', default: '160000' }, gpu: { type: 'boolean', default: false },
} });
if (!arg.voice) throw new Error('--voice is required; production render never substitutes synthetic speech');
if (!arg.ffmpeg) throw new Error('--ffmpeg is required for MP3 decode');
const voicePath = resolve(arg.voice), ffmpeg = resolve(arg.ffmpeg), sbPath = resolve(ROOT, arg.storyboard!), beatsPath = resolve(ROOT, arg.beats!);
const outDir = resolve(ROOT, arg.out!), W = Number(arg.width), H = Number(arg.height), fps = 30, bitrate = Number(arg.bitrate), audioBitrate = Number(arg.audioBitrate);
if (!outDir.startsWith(ROOT + '/')) throw new Error('--out must be inside the repository');
if (!existsSync(voicePath) || !existsSync(ffmpeg)) throw new Error('voice or ffmpeg file does not exist');
if (!(W > 0 && H > 0 && W % 2 === 0 && H % 2 === 0)) throw new Error('width/height must be positive even integers');
mkdirSync(outDir, { recursive: true });
const stage = (s: string) => console.log(`[${new Date().toISOString()}] ${s}`);
const hex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

stage('authenticate approved inputs');
const sbText = readFileSync(sbPath, 'utf8'), sb = JSON.parse(sbText), sbSha = sha256(sbText);
const voiceBytes = new Uint8Array(readFileSync(voicePath));
checkContainer(voiceBytes, 'mp3');
const voiceSha = hex(voiceBytes);
if (voiceSha !== sb.audio.contentHash) throw new Error(`voice hash ${voiceSha} does not match approved ${sb.audio.contentHash}`);
const sheet = JSON.parse(readFileSync(beatsPath, 'utf8'));

stage('decode approved MP3 to mono 48 kHz float PCM');
const raw = execFileSync(ffmpeg, ['-hide_banner', '-nostdin', '-protocol_whitelist', 'file', '-f', 'mp3', '-i', voicePath, '-map', '0:a:0', '-vn', '-sn', '-dn', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-acodec', 'pcm_f32le', 'pipe:1'], { encoding: 'buffer', maxBuffer: 48000 * 4 * 310, timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] }) as Buffer;
const voice = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length - (raw.length % 4)));
const decodedDuration = voice.length / 48000;
if (Math.abs(decodedDuration - sb.audio.durationSeconds) > 0.05) throw new Error(`decoded voice ${decodedDuration.toFixed(3)}s differs from approved ${sb.audio.durationSeconds}s`);

stage('run authoritative narrated integration and camera gates');
const lib = loadLibrary();
if (lib.errors.length) throw new Error(`asset library: ${lib.errors.join('; ')}`);
const pre = prepareIntegration(sb, sbSha, lib, (s, d, t) => { if (d === 0 || d === t || d % 300 === 0) console.log(`  ${s} ${d}/${t}`); });
if (pre.analysis.summary.blocking) throw new Error(`blocking integration gates: ${pre.analysis.summary.failed.join(', ')}`);
const tl = compileNarratedTimeline(sb, sbSha), ep = draftEpisodeFor(sb, tl, lib);
const N = Math.round(tl.videoDuration * fps), audioSamples = N * (48000 / fps), videoDuration = N / fps;
if (voice.length > audioSamples) throw new Error(`approved voice has ${voice.length} samples but ${N} frames hold ${audioSamples}; refusing to cut voice`);
const paddedVoice = new Float32Array(audioSamples); paddedVoice.set(voice);

stage('compile S7 captions, graphics, VFX, and event-audio plan');
const phrases = phrasesFromBeats(sheet.beats), captionPlan = planBoldCaptions(phrases), captionIssues = checkBoldPlan(phrases, captionPlan);
if (captionIssues.length) throw new Error(`caption plan: ${captionIssues.join('; ')}`);
const graphics = textGraphicsFromBeats(sheet.beats), vfx = vfxEventsFromBeats(sheet.beats), audioPlan = mixPlanFromBeatSheet(sheet);
for (const e of graphics) if (!TEXT_STYLE_DEFS[e.textStyleId]) throw new Error(`unimplemented text style ${e.textStyleId}`);
for (const e of vfx) if (!VFX_DEFS[e.vfxId]) throw new Error(`unimplemented VFX ${e.vfxId}`);
for (const e of audioPlan.cues) if (!SFX_DEFS[e.sfxId.split('@')[0]]) throw new Error(`unimplemented SFX ${e.sfxId}`);
const mixed = mixVoiceSfx({ left: paddedVoice }, audioPlan.cues, lib.audio, { targetLufs: -14, truePeakDbtp: -1, seed: sheet.seed });
const failedCues = mixed.report.cues.filter((c) => c.status !== 'mixed');
if (failedCues.length) throw new Error(`unmixed cues: ${failedCues.map((c) => `${c.sfxId}:${c.status}`).join(', ')}`);
if (mixed.report.music !== 'none' || mixed.report.truePeakDbtp > -1 || Math.abs(mixed.report.integratedLufs + 14) > 0.5) throw new Error('audio mix misses S7 policy');
writeFileSync(join(outDir, 'mix.wav'), encodeWavStereo(mixed.left, mixed.right, 48000, 24, sheet.seed));
writeFileSync(join(outDir, 'audio-report.json'), JSON.stringify({ source: { file: relative(ROOT, voicePath), sha256: voiceSha, decodedDuration }, plan: audioPlan, report: mixed.report }, null, 2) + '\n');

stage('build browser bundle and calculate face-safe placements');
execFileSync(join(ROOT, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.web.json'], { cwd: ROOT, stdio: 'inherit' });
const { server, url } = await startServer(0);
const browser = await launchBrowser({ gpu: arg.gpu });
const mp4Name = 'zapp-vs-kira-full-s7.mp4', mp4Path = join(outDir, mp4Name);
try {
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (e: Error) => { pageErrors.push(String(e)); console.error('[pageerror]', e); });
  await page.goto(`${url}/apps/studio/blank.html`);
  await page.addScriptTag({ type: 'module', url: '/dist/packages/captions/src/preview/stills-page.js' });
  await page.waitForFunction(() => (window as any).__s7?.ready);
  console.log(await page.evaluate(([e, l, s, i, w, h]: any) => (window as any).__s7.init(e, l, s, i, w, h), [pre.episode, lib, sb, pre.integrated, W, H]));
  const placements: Record<string, any> = await page.evaluate(([c, g]: any) => (window as any).__s7.place(c, g), [captionPlan.captions, graphics]);
  const conflicts = Object.entries(placements).filter(([, p]: any) => !p.clearOfFaces || p.faceOverlapPx !== 0);
  if (conflicts.length) throw new Error(`caption face conflicts: ${conflicts.map(([id]) => id).join(', ')}`);
  const placementSegments = Object.fromEntries(Object.entries(placements).map(([id, p]: any) => [id, p.segments]));
  writeFileSync(join(outDir, 'caption-placements.json'), JSON.stringify({ captions: captionPlan.captions.length, segments: Object.values(placements).flatMap((p: any) => p.segments).length, conflicts: [], placements }, null, 2) + '\n');

  stage(`encode ${N} fully composited frames (${W}x${H} @ ${fps}fps)`);
  await page.evaluate((cfg: any) => (window as any).__s7.initCapture(cfg), { fps, bitrate, hashEvery: fps, keyframeInterval: fps * 2, vfx, graphics, captions: captionPlan.captions, placements: placementSegments });
  const samples: Array<{ data: Uint8Array; duration: number; isKey: boolean }> = [], frameHashes: Array<[number, string]> = [];
  const BATCH = 15, t0 = Date.now(); let renderMs = 0;
  for (let a = 0; a < N; a += BATCH) {
    const b = Math.min(N, a + BATCH), r = await page.evaluate(([x, y, final]: [number, number, boolean]) => (window as any).__s7.encodeRange(x, y, final), [a, b, b === N]);
    const bytes = Buffer.from(r.b64, 'base64'); let off = 0;
    r.sizes.forEach((n: number, k: number) => { samples.push({ data: new Uint8Array(bytes.subarray(off, off + n)), duration: 1000, isKey: r.keys[k] }); off += n; });
    frameHashes.push(...r.hashes); renderMs += r.renderMs;
    if (b === N || b % 180 === 0) console.log(`  frames ${b}/${N}, ${((Date.now() - t0) / b).toFixed(1)} ms/frame`);
  }
  if (samples.length !== N || pageErrors.length) throw new Error(`capture failed: ${samples.length}/${N} samples; ${pageErrors.join('; ')}`);
  const meta = await page.evaluate(() => (window as any).__s7.meta());
  if (!meta.avcCb64) throw new Error('VideoEncoder did not return avcC');

  stage('encode AAC-LC and mux fast-start MP4');
  const aac = encodeAacLc([mixed.left, mixed.right], audioBitrate);
  const cs = meta.colorSpace ?? {}, P: Record<string, number> = { bt709: 1, smpte170m: 6, bt470bg: 5 }, TR: Record<string, number> = { bt709: 1, smpte170m: 6, iec61966_2_1: 13 }, MX: Record<string, number> = { bt709: 1, smpte170m: 6, bt470bg: 5, rgb: 0 };
  const mp4 = muxMp4({
    video: { width: W, height: H, timescale: fps * 1000, avcC: new Uint8Array(Buffer.from(meta.avcCb64, 'base64')), samples, color: { primaries: P[cs.primaries] ?? 1, transfer: TR[cs.transfer] ?? 1, matrix: MX[cs.matrix] ?? 1, fullRange: !!cs.fullRange } },
    audio: { codec: 'aac', sampleRate: 48000, channels: 2, asc: aac.asc, priming: aac.priming, inputSamples: aac.inputSamples, avgBitrate: audioBitrate, samples: aac.frames.map((data) => ({ data, duration: 1024 })) },
    compressorName: 'BlockSpark S7 H.264',
  });
  writeFileSync(mp4Path, mp4);
  const mp4Sha = hex(mp4), probe = probeFile(mp4Path), production = checkProductionProfile(probe, { ...PRODUCTION_SPEC, width: W, height: H, durationRange: [69, 69.2] });
  writeFileSync(join(outDir, 'probe.json'), JSON.stringify({ probe, production }, null, 2) + '\n');
  if (!production.ok) throw new Error(`production profile: ${production.errors.join('; ')}`);

  stage('verify independent playback and AAC/container alignment');
  const playback = await verifyPlayback(url, relative(ROOT, mp4Path), [0.5, 6.5, 11.2, 22.2, 32.4, 41, 57.2, 66.5], join(outDir, 'decoded'), 3);
  const verifyPage = await browser.newPage(); await verifyPage.goto(`${url}/apps/studio/blank.html`);
  const roundTrip = await aacRoundTrip(aac.frames, aac.asc, [mixed.left, mixed.right], aac.priming, verifyPage);
  const alignment = await mp4AudioAlignment(verifyPage, `${url}/${relative(ROOT, mp4Path)}`, mixed.left);
  await verifyPage.close();
  const mediaOk = playback.ok && playback.droppedFrames === 0 && roundTrip.snrDb.every((x: number) => x >= 15) && Math.abs(alignment.lagSamples) <= 48 && Math.abs(alignment.decodedSamples - mixed.left.length) <= 1024;
  if (!mediaOk) throw new Error('independent decode/playback/audio alignment verification failed');
  const manifest = {
    schema: 'blockspark.s7-full-render/1', createdAt: new Date().toISOString(), input: { storyboard: relative(ROOT, sbPath), storyboardSha256: sbSha, beatSheet: relative(ROOT, beatsPath), voice: relative(ROOT, voicePath), voiceSha256: voiceSha },
    output: { file: relative(ROOT, mp4Path), sha256: mp4Sha, bytes: mp4.length, width: W, height: H, fps, frames: N, durationSec: videoDuration, codec: 'H.264 High + AAC-LC', fastStart: true },
    s7: { captions: captionPlan.captions.length, placementSegments: Object.values(placements).flatMap((p: any) => p.segments).length, faceConflicts: 0, graphics: graphics.length, vfx: vfx.length, sfx: audioPlan.cues.length, music: 'none', ignoredMusic: audioPlan.ignoredMusic },
    audio: mixed.report, integration: pre.analysis.summary, encoding: { videoBitrate: bitrate, audioBitrate, renderMs, frameHashes, aac: aac.stats }, verification: { production, playback: { ...playback, frameFiles: playback.frameFiles.map((f) => relative(ROOT, f)) }, roundTrip, alignment, ok: mediaOk },
  };
  writeFileSync(join(outDir, 'render-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  stage(`DONE ${relative(ROOT, mp4Path)} ${(mp4.length / 1e6).toFixed(2)} MB sha256 ${mp4Sha}`);
} finally { await browser.close(); server.close(); }
