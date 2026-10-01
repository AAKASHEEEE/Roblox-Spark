// Full S7 render: approved MP3 -> VO + explicit event SFX (NO MUSIC) -> fully composited H.264/AAC MP4.
//
// Independent switches:
//   --visual vignette|narrated selects the generic scene renderer.
//   --profile review-vertical-540p|production-vertical-1080p selects immutable media settings.
//   --evidenceProfile none|competitor-v2 selects fixture-specific evidence gates/output identity.
// competitor-v2 additionally requires --inputManifest. The manifest is authenticated before output creation and pins
// source/tree/base, every input, deterministic solved compositions, asset/package locks, and exact tool versions.
// --workerSafe requires --prebuilt and restricts every input/output/executable to a symlink-aware allowlist.
//
// See packages/captions/RENDER_EVIDENCE.md for reproducible commands. The voice bytes must exactly match
// storyboard.audio.contentHash; approved narration is never cut, stretched, or sped up.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { findChromium, launchBrowser } from '../../../apps/render-worker/lib/browser.ts';
import { aacRoundTrip } from '../../../apps/render-worker/lib/aac-check.ts';
import { mp4AudioAlignment } from '../../../apps/render-worker/lib/verify.ts';
import { loadLibrary } from '../../../apps/render-worker/lib/library.ts';
import { startServer } from '../../../apps/render-worker/lib/server.ts';
import { draftEpisodeFor, prepareIntegration } from '../../../apps/studio/narrated-draft.ts';
import { checkContainer } from '../../narrated/src/audio.ts';
import { compileNarratedTimeline } from '../../narrated/src/timeline.ts';
import { encodeAacLc } from '../../audio/src/aac/encoder.ts';
import { muxMp4 } from '../../mp4/src/mux.ts';
import { fromFfprobeJson, probeFile } from '../../../apps/render-worker/lib/probe-node.ts';
import { checkProductionProfile, PRODUCTION_SPEC } from '../../mp4/src/probe.ts';
import { mixPlanFromBeatSheet, mixVoiceSfx, encodeWavStereo } from '../../audio-mix/src/index.ts';
import { planBoldCaptions, phrasesFromBeats, checkBoldPlan } from '../src/bold.ts';
import { textGraphicsFromBeats } from '../src/graphics.ts';
import { vfxEventsFromBeats, VFX_DEFS } from '../../engine/src/vfx/index.ts';
import { TEXT_STYLE_DEFS } from '../src/styles.ts';
import { SFX_DEFS } from '../../audio-mix/src/sfx.ts';
// vignette pipeline (node-side solve; browser rendering delegates to the neutral VignetteRenderSession)
import { ensureHeadlessCanvas } from '../../vignette/src/headless.ts';
import { runVignette, type Composition, type VignetteRun } from '../../vignette/src/pipeline.ts';
import { auditFinalCameraSafety, heldSceneTime, poseAt } from '../../vignette/src/camera.ts';
import { applyShake } from '../../engine/src/camera.ts';
import { evalVfxEvents, applyZoom, type VfxEvent } from '../../engine/src/vfx/index.ts';
import type { CameraState } from '../../engine/src/gl/renderer.ts';
import { assertCompositionTimeline } from '../src/preview/composition.ts';
import { COMPETITOR_EVIDENCE_FILES, resolveRenderSelection } from './render-config.ts';
import { validateRenderPaths } from './render-paths.ts';
import { assertManifestActuals, assertRuntimePins, gitSource, hashDirectoryTree, hashFile, manifestDigest, packageVersion, parseJsonBytes, readAuthenticatedFile, readBoundedFile, readInputManifest, readTrustedRenderInputs, RENDER_BYTE_LIMITS, sha256Bytes, solvedCompositionsDigest, type RenderInputManifest, type RuntimePins, type ToolPins } from './render-manifest.ts';
import { buildEvidenceReport, codecPinIssues, COMPARISON_SHEET_RECEIPT_FILE, COMPETITOR_DECODED_FRAMES, createDecodedFrameReceipt, DECODED_FRAME_RECEIPT_FILE, type DecodedFrameClaim } from './verify-render-v2.ts';

const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const requireFromHere = createRequire(import.meta.url);

function assertPinnedRuntimeFile(path: string, expected: string | null, label: string): void {
  if (!expected) throw new Error(`trusted render is missing the ${label} runtime pin`);
  const actual = hashFile(path).sha256;
  if (actual !== expected) throw new Error(`${label} bytes changed after authorization`);
}

async function launchAuthenticatedBrowser(manifest: RenderInputManifest, playwrightCore: string, chromium: string, gpu: boolean): Promise<any> {
  if (!manifest.runtime.playwrightTreeSha256) throw new Error('trusted render is missing the Playwright runtime pin');
  if (hashDirectoryTree(playwrightCore) !== manifest.runtime.playwrightTreeSha256) throw new Error('Playwright bytes changed after authorization');
  const playwright = requireFromHere(playwrightCore);
  if (!playwright?.chromium?.launch) throw new Error('authorized Playwright runtime does not expose chromium.launch');
  assertPinnedRuntimeFile(chromium, manifest.runtime.chromiumSha256, 'Chromium');
  const args = gpu
    ? ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=vulkan', '--enable-features=Vulkan']
    : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
  args.push('--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--force-color-profile=srgb', '--js-flags=--max-old-space-size=4096');
  return playwright.chromium.launch({ executablePath: chromium, headless: true, args });
}

/** Decode with the already authenticated browser so playback cannot silently select a fallback runtime. */
async function verifyPlaybackWithBrowser(browser: any, baseUrl: string, relPath: string, times: number[], outDir: string, playSeconds = 2): Promise<any> {
  mkdirSync(outDir, { recursive: true });
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/apps/studio/blank.html`);
    const res = await page.evaluate(async ([src, seekTimes, seconds]: [string, number[], number]) => {
      const errors: string[] = [];
      const video = document.createElement('video');
      video.muted = true; video.preload = 'auto'; video.src = src; video.crossOrigin = 'anonymous';
      document.body.appendChild(video);
      await new Promise<void>((ok) => { video.onloadeddata = () => ok(); video.onerror = () => { errors.push(`media error ${video.error?.code ?? '?'} ${video.error?.message ?? ''}`); ok(); }; });
      const frames: string[] = [];
      if (!errors.length) {
        const canvas = document.createElement('canvas'); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
        const context = canvas.getContext('2d')!;
        for (const time of seekTimes) {
          await new Promise<void>((ok) => { video.onseeked = () => ok(); video.currentTime = time; });
          context.drawImage(video, 0, 0); frames.push(canvas.toDataURL('image/png'));
        }
        video.currentTime = 0; await new Promise((done) => setTimeout(done, 100));
        const before = video.getVideoPlaybackQuality();
        await video.play().catch((error) => errors.push(`play: ${error}`));
        const started = performance.now(); await new Promise((done) => setTimeout(done, seconds * 1000)); video.pause();
        const after = video.getVideoPlaybackQuality(), anyVideo = video as any;
        return { ok: true, videoWidth: video.videoWidth, videoHeight: video.videoHeight, duration: video.duration, audioDecodedBytes: anyVideo.webkitAudioDecodedByteCount ?? -1, videoDecodedBytes: anyVideo.webkitVideoDecodedByteCount ?? -1, framesDecodedDuringPlay: after.totalVideoFrames - before.totalVideoFrames, droppedFrames: after.droppedVideoFrames, playedSeconds: video.currentTime, playWallSeconds: (performance.now() - started) / 1000, errors, frames };
      }
      return { ok: false, videoWidth: 0, videoHeight: 0, duration: 0, audioDecodedBytes: 0, videoDecodedBytes: 0, framesDecodedDuringPlay: 0, droppedFrames: 0, playedSeconds: 0, errors, frames };
    }, [`${baseUrl}/${relPath}`, times, playSeconds]);
    const frameFiles: string[] = [];
    res.frames.forEach((dataUrl: string, index: number) => {
      const file = join(outDir, `decoded_t${times[index].toFixed(2)}.png`);
      writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64')); frameFiles.push(file);
    });
    delete res.frames;
    return { ...res, ok: res.ok && res.errors.length === 0, frameFiles };
  } finally { await page.close().catch(() => undefined); }
}

const { values: arg } = parseArgs({ options: {
  voice: { type: 'string' }, ffmpeg: { type: 'string' }, out: { type: 'string' },
  visual: { type: 'string', default: 'vignette' }, profile: { type: 'string', default: 'review-vertical-540p' },
  evidenceProfile: { type: 'string', default: 'none' }, inputManifest: { type: 'string' }, authorizedManifestSha256: { type: 'string' }, jobId: { type: 'string' },
  storyboard: { type: 'string', default: 'tests/fixtures/narrated/approved-narrated-v0.1.json' },
  beats: { type: 'string', default: 'packages/director/fixtures/free-coins-classroom.beats.json' },
  width: { type: 'string' }, height: { type: 'string' }, fps: { type: 'string' },
  bitrate: { type: 'string' }, audioBitrate: { type: 'string' }, gpu: { type: 'boolean', default: false },
  workerSafe: { type: 'boolean', default: false }, prebuilt: { type: 'boolean', default: false },
} });
const selection = resolveRenderSelection({
  visual: arg.visual, profile: arg.profile, evidenceProfile: arg.evidenceProfile,
  width: arg.width, height: arg.height, fps: arg.fps, bitrate: arg.bitrate, audioBitrate: arg.audioBitrate,
});
const { visual, profile, evidenceProfile } = selection;
if (!arg.voice) throw new Error('--voice is required; production render never substitutes synthetic speech');
if (!arg.ffmpeg) throw new Error('--ffmpeg is required for MP3 decode');
if (evidenceProfile === 'competitor-v2' && !arg.workerSafe) throw new Error('--evidenceProfile competitor-v2 requires --workerSafe; trusted evidence must use a new isolated job output');
if (arg.workerSafe && !arg.prebuilt) throw new Error('--worker-safe requires --prebuilt so concurrent workers never compile into shared dist/');
if (evidenceProfile === 'competitor-v2' && !arg.prebuilt) throw new Error('--evidenceProfile competitor-v2 requires a prebuilt, content-addressed bundle');
if ((arg.workerSafe || evidenceProfile === 'competitor-v2') && (!arg.inputManifest || !arg.authorizedManifestSha256 || !arg.jobId)) throw new Error('trusted rendering requires --inputManifest, --jobId, and a scheduler-supplied --authorizedManifestSha256');
const fromRoot = (path: string): string => isAbsolute(path) ? resolve(path) : resolve(ROOT, path);
const defaultOut = evidenceProfile === 'competitor-v2' ? 'packages/captions/full-render-v2' : 'out/s7-full';
const chromiumCandidate = findChromium();
const ffprobeCandidate = process.env.FFPROBE_PATH ? fromRoot(process.env.FFPROBE_PATH) : undefined;
const playwrightCandidate = process.env.PLAYWRIGHT_CORE_PATH ? fromRoot(process.env.PLAYWRIGHT_CORE_PATH) : existsSync(resolve(ROOT, 'node_modules/playwright-core')) ? resolve(ROOT, 'node_modules/playwright-core') : undefined;
const checkedPaths = validateRenderPaths({
  root: ROOT,
  voice: fromRoot(arg.voice), ffmpeg: fromRoot(arg.ffmpeg),
  storyboard: fromRoot(arg.storyboard!), beats: fromRoot(arg.beats!), output: fromRoot(arg.out ?? defaultOut),
  ...(arg.inputManifest ? { inputManifest: fromRoot(arg.inputManifest) } : {}),
  ...(ffprobeCandidate ? { ffprobe: ffprobeCandidate } : {}),
  ...(chromiumCandidate ? { chromium: chromiumCandidate } : {}),
  ...(playwrightCandidate ? { playwrightCore: playwrightCandidate } : {}),
}, !!arg.workerSafe);
if (arg.workerSafe && !checkedPaths.ffprobe) throw new Error('--worker-safe requires FFPROBE_PATH inside node_modules/ffprobe-static');
const voicePath = checkedPaths.voice, ffmpeg = checkedPaths.ffmpeg, sbPath = checkedPaths.storyboard, beatsPath = checkedPaths.beats;
const outDir = checkedPaths.output, W = profile.width, H = profile.height, fps = profile.fps;
const bitrate = profile.videoBitrate, audioBitrate = profile.audioBitrate;
if (arg.workerSafe && existsSync(outDir)) throw new Error('--worker-safe output directory must not already exist');
const trustedManifest: RenderInputManifest | null = checkedPaths.inputManifest ? readInputManifest(checkedPaths.inputManifest) : null;
const trustedManifestSha = trustedManifest ? manifestDigest(trustedManifest) : null;
const stage = (s: string) => console.log(`[${new Date().toISOString()}] ${s}`);
const hex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const mp4Name = evidenceProfile === 'competitor-v2' ? 'zapp-vs-kira-competitor-performance-v2.mp4' : visual === 'vignette' ? 's7-vignette.mp4' : 'zapp-vs-kira-full-s7.mp4';
const browserEntry = visual === 'vignette' ? 'dist/packages/captions/src/preview/vignette-full-page.js' : 'dist/packages/captions/src/preview/stills-page.js';
let authorizedRuntime: RuntimePins | null = null;
if (trustedManifest) {
  if (trustedManifest.provenance !== 'pre-render-authorized') throw new Error('retroactive integrity manifests cannot authorize a render');
  if (arg.authorizedManifestSha256 !== trustedManifestSha) throw new Error('input manifest does not match the scheduler-authorized digest');
  if (!checkedPaths.ffprobe || !checkedPaths.playwrightCore || !checkedPaths.chromium) throw new Error('trusted render requires explicit FFprobe, Playwright, and Chromium runtimes');
  if (!existsSync(resolve(ROOT, browserEntry))) throw new Error(`trusted prebuilt entry is missing: ${browserEntry}`);
  // Compare bytes before invoking FFmpeg, FFprobe, Chromium, or Playwright. Path allowlisting alone is not execution
  // authorization because an ignored executable inside an allowed directory can still be replaced.
  authorizedRuntime = {
    visualEntry: browserEntry,
    bundleTreeSha256: hashDirectoryTree(resolve(ROOT, 'dist')),
    ffmpegSha256: hashFile(ffmpeg).sha256,
    ffprobeSha256: hashFile(checkedPaths.ffprobe).sha256,
    playwrightTreeSha256: hashDirectoryTree(checkedPaths.playwrightCore),
    chromiumSha256: hashFile(checkedPaths.chromium).sha256,
  };
  assertRuntimePins(trustedManifest, authorizedRuntime);
}

stage(`authenticate approved inputs (visual=${visual}, profile=${profile.id}, evidence=${evidenceProfile})`);
if (trustedManifest) {
  const storyboardPath = relative(ROOT, sbPath).split('\\').join('/');
  const beatSheetPath = relative(ROOT, beatsPath).split('\\').join('/');
  if (storyboardPath !== trustedManifest.inputs.storyboard.path) throw new Error(`storyboard path ${storyboardPath} does not match scheduler manifest`);
  if (beatSheetPath !== trustedManifest.inputs.beatSheet.path) throw new Error(`BeatSheet path ${beatSheetPath} does not match scheduler manifest`);
}
// Authenticate the entire parser/native-input set as raw bytes before parsing even the first JSON document.
const inputBytes = trustedManifest
  ? readTrustedRenderInputs(trustedManifest, { storyboard: sbPath, beatSheet: beatsPath, voice: voicePath })
  : {
      storyboard: readBoundedFile(sbPath, RENDER_BYTE_LIMITS.storyboard, 'storyboard'),
      beatSheet: readBoundedFile(beatsPath, RENDER_BYTE_LIMITS.beatSheet, 'BeatSheet'),
      voice: readBoundedFile(voicePath, RENDER_BYTE_LIMITS.voice, 'voice'),
    };
const packageLockPath = resolve(ROOT, 'package-lock.json'), assetLockPath = resolve(ROOT, 'assets/asset-lock.json');
const trustedLockBytes = trustedManifest ? {
  packageLock: readAuthenticatedFile(packageLockPath, trustedManifest.inputs.packageLock, RENDER_BYTE_LIMITS.packageLock, 'package lock'),
  assetLock: readAuthenticatedFile(assetLockPath, trustedManifest.inputs.assetLock, RENDER_BYTE_LIMITS.assetLock, 'asset lock'),
} : null;
const sbSha = sha256Bytes(inputBytes.storyboard), beatsSha = sha256Bytes(inputBytes.beatSheet), voiceSha = sha256Bytes(inputBytes.voice);
const sb: any = parseJsonBytes(inputBytes.storyboard, 'storyboard');
const sheet: any = parseJsonBytes(inputBytes.beatSheet, 'BeatSheet');
const voiceBytes = inputBytes.voice;
checkContainer(voiceBytes, 'mp3');
if (voiceSha !== sb.audio.contentHash) throw new Error(`voice hash ${voiceSha} does not match approved ${sb.audio.contentHash}`);

stage('decode approved MP3 to mono 48 kHz float PCM (never cut/stretch/speed the approved VO)');
if (trustedManifest) assertPinnedRuntimeFile(ffmpeg, trustedManifest.runtime.ffmpegSha256, 'FFmpeg');
const ffmpegInputArgs = trustedManifest
  ? ['-hide_banner', '-nostdin', '-protocol_whitelist', 'pipe', '-f', 'mp3', '-i', 'pipe:0']
  : ['-hide_banner', '-nostdin', '-protocol_whitelist', 'file', '-f', 'mp3', '-i', voicePath];
const raw = execFileSync(ffmpeg, [...ffmpegInputArgs, '-map', '0:a:0', '-vn', '-sn', '-dn', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-acodec', 'pcm_f32le', 'pipe:1'], {
  ...(trustedManifest ? { input: Buffer.from(voiceBytes) } : {}), encoding: 'buffer', maxBuffer: 48000 * 4 * 310,
  timeout: 120000, stdio: [trustedManifest ? 'pipe' : 'ignore', 'pipe', 'pipe'],
}) as Buffer;
const voice = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length - (raw.length % 4)));
const decodedDuration = voice.length / 48000;
if (Math.abs(decodedDuration - sb.audio.durationSeconds) > 0.05) throw new Error(`decoded voice ${decodedDuration.toFixed(3)}s differs from approved ${sb.audio.durationSeconds}s`);

const lib = loadLibrary(trustedLockBytes ? { lockBytes: trustedLockBytes.assetLock } : {});
if (lib.errors.length) throw new Error(`asset library: ${lib.errors.join('; ')}`);

// ---------------------------------------------------------------- visual planning (mode-specific)
// N frames + audio padding are shared: both modes hold the whole approved VO with no cut.
let N: number, videoDuration: number;
// vignette-mode artefacts filled by the block below
let run: VignetteRun | null = null;
let compositions: Composition[] = [];

if (visual === 'narrated') {
  stage('run authoritative narrated integration and camera gates (legacy stills-page path)');
  const pre = prepareIntegration(sb, sbSha, lib, (s, d, t) => { if (d === 0 || d === t || d % 300 === 0) console.log(`  ${s} ${d}/${t}`); });
  if (pre.analysis.summary.blocking) throw new Error(`blocking integration gates: ${pre.analysis.summary.failed.join(', ')}`);
  const tl = compileNarratedTimeline(sb, sbSha), ep = draftEpisodeFor(sb, tl, lib);
  N = Math.round(tl.videoDuration * fps); videoDuration = N / fps;
  (globalThis as any).__legacy = { pre, ep };
} else {
  stage('solve the integrated Vignette scene cameras (runVignette) and enforce the staging/camera gates');
  ensureHeadlessCanvas();
  run = runVignette(sheet, lib, { phrases: sb.script.phrases });
  compositions = run.compositions;
  assertCompositionTimeline(compositions);
  const rep = run.report;
  // block on any pipeline failure
  if (rep.summary.blocking) throw new Error(`runVignette BLOCKED: ${rep.summary.reasons.join('; ')}`);
  if (!run.validation.ok || run.validation.unknown.length) throw new Error(`beat sheet validation failed: ${run.validation.unknown.map((u) => u.id).join(', ') || run.validation.issues.length + ' issue(s)'}`);
  const stagingErrors = run.stage.issues.filter((i) => i.severity === 'error');
  if (stagingErrors.length) throw new Error(`staging errors: ${stagingErrors.map((i) => `${i.code}@${i.beat}`).join(', ')}`);
  const blockedCams = Object.values(run.shots).filter((s) => s.source === 'blocked_best_effort');
  const blockedComps = compositions.filter((c) => c.shot.source === 'blocked_best_effort');
  if (blockedCams.length || blockedComps.length) throw new Error(`camera safety blocked: ${[...blockedCams, ...blockedComps.map((c) => c.shot)].map((s) => s.beat).join(', ')}`);
  if (run.coverage.blocking) throw new Error(`script coverage blocking at ${(run.coverage.pct * 100).toFixed(1)}%`);
  // reject unknown/unresolved characters/props/sets used in the production render (no 'placeholder' among them). VFX/
  // text/SFX resolutions may be 'placeholder' at the vignette staging layer (they are rendered by the S7 overlay
  // layers, guarded below by VFX_DEFS/TEXT_STYLE_DEFS/SFX_DEFS), so only assert the physical asset kinds here.
  const badAssets = run.stage.resolution.filter((r) => (r.kind === 'characters' || r.kind === 'props' || r.kind === 'sets') && r.resolution !== 'available');
  if (badAssets.length) throw new Error(`unresolved / placeholder assets in production render: ${badAssets.map((r) => `${r.kind}:${r.id}=${r.resolution}`).join(', ')}`);
  // The generic vignette renderer has no fixture identity. Exact teacher/door/classroom pins belong only to the
  // competitor-v2 evidence profile.
  if (evidenceProfile === 'competitor-v2') {
    const need: Array<[string, string]> = [['character:teacher', 'teacher@1.0.0'], ['prop:door', 'door@1.1.0'], ['set:classroom', 'classroom@1.2.0']];
    for (const [k, key] of need) { const s = rep.sources[k]; if (!s || s.key !== key || s.source === 'placeholder') throw new Error(`expected ${k} built from ${key} (got ${s ? `${s.key}/${s.source}` : 'nothing'})`); }
  }
  const tl = compileNarratedTimeline(sb, sbSha);
  N = Math.round(tl.videoDuration * fps); videoDuration = N / fps;
  console.log(`  runVignette PASS: ${rep.beats} beats, ${compositions.length} composition(s), coverage ${(run.coverage.pct * 100).toFixed(1)}%, cameras ${rep.summary.camerasAccepted} recipe / ${rep.summary.camerasFallback} fallback / 0 blocked`);
}

if (trustedManifest) {
  stage('verify trusted pre-render manifest against source, inputs, solve, asset lock, and exact tools');
  const assetLockBytes = trustedLockBytes!.assetLock, packageLockBytes = trustedLockBytes!.packageLock;
  const packageLock = parseJsonBytes(packageLockBytes, 'package lock');
  if (!checkedPaths.chromium) throw new Error('trusted render requires an explicitly discovered Chromium executable');
  assertPinnedRuntimeFile(checkedPaths.chromium, trustedManifest.runtime.chromiumSha256, 'Chromium');
  const chromiumBanner = execFileSync(checkedPaths.chromium, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim();
  const chromiumVersion = /\d+\.\d+\.\d+\.\d+/.exec(chromiumBanner)?.[0];
  if (!chromiumVersion) throw new Error(`could not identify Chromium version from '${chromiumBanner}'`);
  const tools: ToolPins = {
    node: process.version,
    typescript: packageVersion(packageLock, 'typescript'), playwrightCore: packageVersion(packageLock, 'playwright-core'),
    chromium: chromiumVersion, ffmpegStatic: packageVersion(packageLock, 'ffmpeg-static'), ffprobeStatic: packageVersion(packageLock, 'ffprobe-static'),
    rendererCodec: profile.codec,
  };
  assertManifestActuals(trustedManifest, {
    job: { jobId: arg.jobId!, outputPath: relative(ROOT, join(outDir, mp4Name)).split('\\').join('/'), visual, renderProfile: profile.id, evidenceProfile, workerSafe: true },
    source: gitSource(ROOT, trustedManifest.source.baseSha),
    inputs: {
      storyboard: { path: relative(ROOT, sbPath), sha256: sbSha },
      beatSheet: { path: relative(ROOT, beatsPath), sha256: beatsSha },
      voice: { sha256: voiceSha },
      solvedCompositions: { sha256: solvedCompositionsDigest(compositions), count: compositions.length },
      assetLock: { path: relative(ROOT, assetLockPath), sha256: sha256Bytes(assetLockBytes) },
      packageLock: { path: relative(ROOT, packageLockPath), sha256: sha256Bytes(packageLockBytes) },
    },
    tools,
    runtime: authorizedRuntime!,
  });
}
if (arg.workerSafe) {
  mkdirSync(dirname(outDir), { recursive: true });
  mkdirSync(outDir); // non-recursive final create is the cross-worker collision guard
} else mkdirSync(outDir, { recursive: true });
if (evidenceProfile === 'competitor-v2') {
  rmSync(join(outDir, 'render-evidence.json'), { force: true });
  rmSync(join(outDir, DECODED_FRAME_RECEIPT_FILE), { force: true });
}

const audioSamples = N * (48000 / fps);
if (voice.length > audioSamples) throw new Error(`approved voice has ${voice.length} samples but ${N} frames hold ${audioSamples}; refusing to cut voice`);
const paddedVoice = new Float32Array(audioSamples); paddedVoice.set(voice);

stage('compile S7 captions, graphics, VFX, and event-audio plan (VO + event SFX only, no music)');
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
if (audioPlan.ignoredMusic.some((m: any) => m.reason !== 'music_added_in_editing')) throw new Error('beat-sheet music was not ignored as music_added_in_editing');
if (evidenceProfile === 'competitor-v2' && audioPlan.cues.length !== 19) throw new Error(`competitor-v2 expects 19 event SFX cues, got ${audioPlan.cues.length}`);
const suv = (mixed.report as any).sfxUnderVoice;
if (!((suv.minSpeechMarginDb ?? Infinity) >= suv.requiredSpeechMarginDb - 0.5) || suv.requiredSpeechMarginDb < 6) throw new Error(`SFX not >=6 dB under active voice: minMargin ${suv.minSpeechMarginDb} required ${suv.requiredSpeechMarginDb}`);
writeFileSync(join(outDir, 'mix.wav'), encodeWavStereo(mixed.left, mixed.right, 48000, 24, sheet.seed));
writeFileSync(join(outDir, 'audio-report.json'), JSON.stringify({ source: { file: relative(ROOT, voicePath), sha256: voiceSha, decodedDuration }, plan: audioPlan, report: mixed.report }, null, 2) + '\n');

// ---------------------------------------------------------------- node-side camera fusion (mirrors VignetteRenderSession)
function metricCam(t: number): CameraState {
  if (!run) throw new Error('camera metrics require a vignette run');
  const held = run.renderCompositionAt(t);
  if (!held) throw new Error(`camera metric frame has no solved owner at ${t}`);
  const sceneTime = heldSceneTime(held, t, run.stage.duration, run.stage.fps);
  const posed = run.scene.pose(sceneTime);
  const beat = posed.beat;
  const composition = held.composition;
  const cameraTime = Math.max(composition.start, Math.min(composition.end, sceneTime));
  const p = poseAt(composition.shot, composition.start, cameraTime);
  const sceneEffects = run.scene.vfx(posed);
  let cam: CameraState = applyShake({ pos: p.pos, target: p.target, fovY: (p.fovDeg * Math.PI) / 180, ...(p.roll ? { roll: p.roll } : {}) }, sceneEffects.shake, t, run.stage.seed);
  // Anchored S7 effects use the exact same held scene pose and beat as the final rendered camera.
  const vf = evalVfxEvents(vfx as VfxEvent[], t, (id) => run!.scene.entityPoint(id, beat), run.stage.seed);
  cam = applyZoom(applyShake(cam, vf.shake, t, run.stage.seed), vf.zoom);
  return cam;
}

// ---------------------------------------------------------------- launch browser + use an isolated/prebuilt bundle policy
if (arg.prebuilt) {
  stage('use prebuilt browser bundle');
  if (!existsSync(resolve(ROOT, browserEntry))) throw new Error(`--prebuilt bundle entry is missing: ${browserEntry}`);
} else {
  stage('build browser bundle');
  execFileSync(join(ROOT, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.web.json'], { cwd: ROOT, stdio: 'inherit' });
}
const { server, url } = await startServer(0);
const browser = trustedManifest
  ? await launchAuthenticatedBrowser(trustedManifest, checkedPaths.playwrightCore!, checkedPaths.chromium!, !!arg.gpu)
  : await launchBrowser({ gpu: arg.gpu });
const mp4Path = join(outDir, mp4Name);
const gates: Record<string, unknown> = {};
try {
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (e: Error) => { pageErrors.push(String(e)); console.error('[pageerror]', e); });
  await page.goto(`${url}/apps/studio/blank.html`);

  let placements: Record<string, any>;
  let placementSegments: Record<string, any>;

  if (visual === 'narrated') {
    // ---- legacy stills-page (window.__s7) path (unchanged behaviour) ----
    const { pre, ep } = (globalThis as any).__legacy;
    await page.addScriptTag({ type: 'module', url: '/dist/packages/captions/src/preview/stills-page.js' });
    await page.waitForFunction(() => (window as any).__s7?.ready);
    console.log(await page.evaluate(([e, l, s, i, w, h]: any) => (window as any).__s7.init(e, l, s, i, w, h), [pre.episode, lib, sb, pre.integrated, W, H]));
    placements = await page.evaluate(([c, g]: any) => (window as any).__s7.place(c, g), [captionPlan.captions, graphics]);
  } else {
    // ---- vignette adapter (window.__s7v) path ----
    stage('load the vignette S7 adapter and initialise the in-page scene with the solved compositions');
    await page.addScriptTag({ type: 'module', url: '/dist/packages/captions/src/preview/vignette-full-page.js' });
    await page.waitForFunction(() => (window as any).__s7v?.ready);
    const compsLite = compositions.map((c) => ({ beat: c.beat, index: c.index, start: c.start, end: c.end, shot: c.shot }));
    console.log(await page.evaluate(([sh, l, s, w, h, cs]: any) => (window as any).__s7v.init(s, l, sh, w, h, cs), [run!.shots, lib, sheet, W, H, compsLite]));
    placements = await page.evaluate(([c, g, effects, placementFps]: any) => (window as any).__s7v.place(c, g, effects, placementFps), [captionPlan.captions, graphics, vfx, fps]);
  }

  // ---- caption face-safety: zero conflicts against ALL projected faces (incl. teacher), every segment ----
  const conflicts = Object.entries(placements).filter(([, p]: any) => !p.clearOfFaces || p.faceOverlapPx !== 0);
  if (conflicts.length) throw new Error(`caption face conflicts: ${conflicts.map(([id]) => id).join(', ')}`);
  placementSegments = Object.fromEntries(Object.entries(placements).map(([id, p]: any) => [id, p.segments]));
  writeFileSync(join(outDir, 'caption-placements.json'), JSON.stringify({ captions: captionPlan.captions.length, segments: Object.values(placements).flatMap((p: any) => p.segments).length, conflicts: [], placements }, null, 2) + '\n');
  gates.captionFaceSafety = { conflicts: 0, captions: captionPlan.captions.length, segments: Object.values(placements).flatMap((p: any) => p.segments).length };

  // ============================================================ fixture-specific acceptance gates
  if (evidenceProfile === 'competitor-v2') {
    stage('dense final-camera safety audit: evaluate every output frame after scene and S7 zoom/shake effects');
    const denseCamera = auditFinalCameraSafety(run!.scene, compositions, { fps, frameCount: N, supplementalVfx: vfx as VfxEvent[] });
    if (!denseCamera.accepted) {
      const failed = denseCamera.samples.filter((sample) => !sample.accepted).slice(0, 8);
      throw new Error(`final-camera safety blocked ${denseCamera.frames - denseCamera.acceptedFrames}/${denseCamera.frames} frame(s): ${failed.map((sample) => `${sample.beat}[${sample.composition}]@${sample.t.toFixed(3)} ${sample.reasons.join(',')}`).join('; ')}`);
    }
    gates.finalCameraSafety = {
      method: 'posed-final-camera-after-scene-and-s7-effects', fps: denseCamera.fps, frames: denseCamera.frames,
      acceptedFrames: denseCamera.acceptedFrames, minScore: denseCamera.minScore, compositions: denseCamera.compositions,
    };

    stage('teacher visibility gate: meaningful projected area at exit(p01) + return(p13) + present(p14), from teacher@1.0.0');
    const tExit = [2.4, 3.0, 3.8], tReturn = [60.3, 60.8, 61.5, 62.5], tPresent = [65.5, 66.5, 67.5, 68.5];
    const tv = await page.evaluate((times: number[]) => (window as any).__s7v.teacherVisibility(times), [...tExit, ...tReturn, ...tPresent]);
    if (tv.sourceKey !== 'teacher@1.0.0' || tv.source === 'placeholder') throw new Error(`teacher not built from teacher@1.0.0 (got ${tv.sourceKey}/${tv.source})`);
    const AREA_MIN = 0.006; // meaningful projected screen-area fraction of the whole teacher rig (not merely rig-present)
    const meaningful = (t: number) => { const s = tv.samples.find((x: any) => Math.abs(x.t - t) < 1e-6); return !!s && s.present && s.areaFrac >= AREA_MIN; };
    const exitOk = tExit.some(meaningful), returnOk = tReturn.some(meaningful), presentOk = tPresent.filter(meaningful).length >= 2;
    if (!exitOk) throw new Error(`teacher not meaningfully visible during p01 exit samples: ${JSON.stringify(tv.samples.filter((s: any) => tExit.includes(s.t)))}`);
    if (!returnOk) throw new Error(`teacher not meaningfully visible during p13 return samples: ${JSON.stringify(tv.samples.filter((s: any) => tReturn.includes(s.t)))}`);
    if (!presentOk) throw new Error(`teacher not present across p14 (65.5-68.5s): ${JSON.stringify(tv.samples.filter((s: any) => tPresent.includes(s.t)))}`);
    gates.teacher = { sourceKey: tv.sourceKey, source: tv.source, areaThreshold: AREA_MIN, exitOk, returnOk, presentOk, samples: tv.samples };

    stage('door gate: real door@1.1.0 leaf/grip moves closed->open, doorway on camera in p01 and p13, usedRealDoorway');
    const tDoorClosed = 1.5, tDoorP01Open = 3.0, tDoorP13Open = 61.5;
    const ds = await page.evaluate((times: number[]) => (window as any).__s7v.doorState(times), [tDoorClosed, tDoorP01Open, tDoorP13Open]);
    if (!ds.usedRealDoorway) throw new Error('scene used a fallback doorway (doorFrame), not the real doorOpening');
    if (ds.sourceKey !== 'door@1.1.0') throw new Error(`door not built from door@1.1.0 (got ${ds.sourceKey})`);
    const closed = ds.samples.find((s: any) => Math.abs(s.t - tDoorClosed) < 1e-6);
    const p01open = ds.samples.find((s: any) => Math.abs(s.t - tDoorP01Open) < 1e-6);
    const p13open = ds.samples.find((s: any) => Math.abs(s.t - tDoorP13Open) < 1e-6);
    const gripMoved = (a: any, b: any) => a && b && a.grip && b.grip && Math.hypot(a.grip[0] - b.grip[0], a.grip[2] - b.grip[2]) > 0.05;
    const leafMovedP01 = gripMoved(closed, p01open) || (closed && p01open && Math.abs(p01open.openAmount - closed.openAmount) > 0.1);
    if (!leafMovedP01) throw new Error(`door leaf/grip did not visibly move between closed (${JSON.stringify(closed)}) and p01 open (${JSON.stringify(p01open)})`);
    const doorwayOnCameraP01 = !!p01open?.onCamera || !!closed?.onCamera;
    const doorwayOnCameraP13 = !!p13open?.onCamera;
    if (!doorwayOnCameraP01) throw new Error('doorway/door not on camera during any p01 door sample');
    if (!doorwayOnCameraP13) throw new Error('doorway/door not on camera during the p13 door sample');
    gates.door = { propId: ds.propId, sourceKey: ds.sourceKey, usedRealDoorway: ds.usedRealDoorway, leafMovedP01, doorwayOnCameraP01, doorwayOnCameraP13, samples: ds.samples };

    stage('performance-motion gates: prove full-body actions (not head-turns) via jointSample deltas');
    // Representative windows per FEAT-003. For each, sample joints at two times and require a meaningful world-space
    // delta of the named joints/root (metres), plus action-specific FaceTrack expression + deterministic blink and
    // mouthNarrationDriven === false. Thresholds are conservative (a head-turn alone moves the neck < ~0.03 m).
    const jointAt = async (actor: string, t: number) => page.evaluate(([a, tt]: [string, number]) => (window as any).__s7v.jointSample(a, tt), [actor, t]);
    const dist = (a: number[], b: number[]) => a && b ? Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) : 0;
    const motion: Record<string, any> = {};
    const requireMotion = (label: string, actor: string, t0: number, t1: number, joints: string[], min: number) => async () => {
      const j0 = await jointAt(actor, t0), j1 = await jointAt(actor, t1);
      if (!j0 || !j1 || !j0.present || !j1.present) throw new Error(`${label}: ${actor} not present at ${t0}/${t1}`);
      const deltas: Record<string, number> = {};
      let maxD = 0; for (const jn of joints) { const d = jn === 'root' ? dist(j0.root, j1.root) : dist(j0.joints[jn], j1.joints[jn]); deltas[jn] = +d.toFixed(4); maxD = Math.max(maxD, d); }
      // the narrator VO never drives the character mouth: the FaceTrack has no phrase/mouth driver (structural).
      if (j0.face.mouthNarrationDriven || j1.face.mouthNarrationDriven) throw new Error(`${label}: ${actor} mouth is narration-driven (VO must not flap character mouths)`);
      motion[label] = { actor, t0, t1, deltas, maxDelta: +maxD.toFixed(4), expression0: j0.face.expression, expression1: j1.face.expression, blink0: j0.face.blink, blink1: j1.face.blink, mouthOpen0: j0.face.mouthOpen, mouthOpen1: j1.face.mouthOpen, mouthNarrationDriven: false };
      if (maxD < min) throw new Error(`${label}: ${actor} body motion ${maxD.toFixed(3)}m < ${min}m (only head-turn?) deltas=${JSON.stringify(deltas)}`);
      if (!j0.face.expression || !j1.face.expression) throw new Error(`${label}: ${actor} has no FaceTrack expression`);
    };
    const checks = [
      requireMotion('p02_look_around', 'zapp', 4.8, 8.8, ['neck', 'spine', 'shoulder_l', 'shoulder_r'], 0.08),
      requireMotion('p03_celebrate', 'zapp', 10.0, 11.4, ['hand_l', 'hand_r', 'spine', 'root'], 0.2),
      requireMotion('p04_dance', 'zapp', 16.0, 19.5, ['hand_l', 'hand_r', 'knee_l', 'knee_r', 'spine'], 0.15),
      requireMotion('p06_zapp_walk_to_button', 'zapp', 26.2, 30.8, ['root', 'hip_l', 'hip_r'], 0.4),
      requireMotion('p06_kira_head_shake', 'kira', 26.2, 27.4, ['neck', 'head'], 0.03),
      requireMotion('p07_press_contact', 'zapp', 31.7, 32.6, ['hand_r', 'hand_l'], 0.12),
      requireMotion('p08_kira_facepalm', 'kira', 35.4, 37.0, ['hand_l', 'hand_r'], 0.1),
      requireMotion('p08_zapp_celebrate', 'zapp', 35.4, 37.0, ['hand_l', 'hand_r', 'spine'], 0.15),
      requireMotion('p10_kira_stand_up', 'kira', 44.4, 48.5, ['root', 'spine', 'neck'], 0.1),
      requireMotion('p11_kira_walk_to_safe', 'kira', 50.0, 54.4, ['root'], 0.4),
      requireMotion('p12_zapp_prone', 'zapp', 55.2, 58.5, ['spine', 'root', 'neck'], 0.15),
      requireMotion('p12_kira_recoil', 'kira', 55.2, 58.5, ['spine', 'neck', 'hand_l', 'hand_r'], 0.05),
      requireMotion('p13_teacher_through_doorway', 'teacher', 60.9, 64.0, ['root'], 0.3),
      // p14 is the teacher's look-toward-scene (actionId look_at): a deliberate head/neck re-orientation, not a walk,
      // so its threshold is a small head displacement (the other 13 gates prove full-body actions above).
      requireMotion('p14_teacher_look', 'teacher', 65.5, 68.8, ['neck', 'head', 'root'], 0.01),
    ];
    for (const c of checks) await c();
    // deterministic blinks: the FaceTrack is seeded, so the same actor at the same t yields the identical face frame
    // (expression + blink + mouth) on repeated samples — proving blinks are deterministic, not per-render random.
    const dj0 = await jointAt('zapp', 12.0), dj1 = await jointAt('zapp', 12.0);
    const blinksDeterministic = !!dj0 && !!dj1 && dj0.face.textureKey === dj1.face.textureKey && dj0.face.blink === dj1.face.blink;
    if (!blinksDeterministic) throw new Error('FaceTrack blinks are not deterministic (same t gave different face frames)');
    gates.performanceMotion = { blinksDeterministic, mouthNarrationDriven: false, actions: motion };

    stage('editing/camera redesign metrics over solved compositions and final per-frame cameras');
    // compositions/cuts, median composition duration, no repeated identical Zapp/Kira classroom singles, and the
    // fraction of output frames with camera translation and with visible zoom/lens activity.
    const compDurations = compositions.map((c) => c.end - c.start).sort((a, b) => a - b);
    const median = compDurations.length % 2 ? compDurations[(compDurations.length - 1) / 2] : (compDurations[compDurations.length / 2 - 1] + compDurations[compDurations.length / 2]) / 2;
    // repeated identical single: consecutive compositions with the same recipe + same single character subject
    const singleKey = (c: Composition) => { const cam = c.shot; const subjChar = cam.subjects.active; return cam.subjects.required.length <= 1 && (subjChar === 'zapp' || subjChar === 'kira') ? `${cam.recipeId}:${subjChar}:${cam.variant?.id ?? ''}` : null; };
    let repeatedIdenticalSingles = 0;
    for (let i = 1; i < compositions.length; i++) { const a = singleKey(compositions[i - 1]), b = singleKey(compositions[i]); if (a && b && a === b) repeatedIdenticalSingles++; }
    // per-frame translation + zoom activity
    let translationFrames = 0, zoomFrames = 0;
    let prev: CameraState | null = null, prevScale = 0;
    const camAt = (t: number) => metricCam(t);
    const refScale = (cam: CameraState) => { // projected screen scale proxy: 1/(fovY) * 1/distance-to-target
      const d = Math.hypot(cam.pos[0] - cam.target[0], cam.pos[1] - cam.target[1], cam.pos[2] - cam.target[2]) || 1e-3;
      return 1 / (Math.tan(cam.fovY / 2) * d);
    };
    for (let i = 0; i < N; i++) {
      const t = i / fps, cam = camAt(t), scale = refScale(cam);
      if (prev) {
        const moved = Math.hypot(cam.pos[0] - prev.pos[0], cam.pos[1] - prev.pos[1], cam.pos[2] - prev.pos[2]);
        if (moved > 1e-3) translationFrames++;
        const fovChanged = Math.abs(cam.fovY - prev.fovY) > 1e-4;
        const scaleChanged = Math.abs(scale - prevScale) / Math.max(prevScale, 1e-6) > 2e-3;
        if (fovChanged || scaleChanged) zoomFrames++;
      }
      prev = cam; prevScale = scale;
    }
    const denom = Math.max(1, N - 1);
    const metrics = {
      compositions: compositions.length,
      medianCompositionSec: +median.toFixed(3),
      repeatedIdenticalZappKiraSingles: repeatedIdenticalSingles,
      translationFrac: +(translationFrames / denom).toFixed(3),
      zoomFrac: +(zoomFrames / denom).toFixed(3),
    };
    console.log('  camera metrics:', JSON.stringify(metrics));
    const inRange = (x: number, lo: number, hi: number) => x >= lo && x <= hi;
    const metricProblems: string[] = [];
    if (!inRange(metrics.compositions, 35, 45)) metricProblems.push(`compositions ${metrics.compositions} not in [35,45]`);
    if (!inRange(metrics.medianCompositionSec, 1.2, 1.8)) metricProblems.push(`median ${metrics.medianCompositionSec}s not in [1.2,1.8]`);
    if (metrics.repeatedIdenticalZappKiraSingles !== 0) metricProblems.push(`${metrics.repeatedIdenticalZappKiraSingles} repeated identical Zapp/Kira singles`);
    if (!inRange(metrics.translationFrac, 0.35, 0.55)) metricProblems.push(`translation ${metrics.translationFrac} not in [0.35,0.55]`);
    if (!inRange(metrics.zoomFrac, 0.30, 0.50)) metricProblems.push(`zoom ${metrics.zoomFrac} not in [0.30,0.50]`);
    if (metricProblems.length) throw new Error(`camera redesign metrics out of range: ${metricProblems.join('; ')}`);
    gates.cameraMetrics = metrics;
  }

  stage(`encode ${N} fully composited frames (${W}x${H} @ ${fps}fps)`);
  const initCapture = visual === 'vignette' ? '__s7v' : '__s7';
  await page.evaluate(([g, cfg]: any) => (window as any)[g].initCapture(cfg), [initCapture, { fps, bitrate, codec: profile.codec, hashEvery: fps, keyframeInterval: fps * 2, vfx, graphics, captions: captionPlan.captions, placements: placementSegments }]);
  const samples: Array<{ data: Uint8Array; duration: number; isKey: boolean }> = [], frameHashes: Array<[number, string]> = [];
  const BATCH = 15, t0 = Date.now(); let renderMs = 0;
  for (let a = 0; a < N; a += BATCH) {
    const b = Math.min(N, a + BATCH), r = await page.evaluate(([g, x, y, final]: [string, number, number, boolean]) => (window as any)[g].encodeRange(x, y, final), [initCapture, a, b, b === N]);
    const bytes = Buffer.from(r.b64, 'base64'); let off = 0;
    r.sizes.forEach((n: number, k: number) => { samples.push({ data: new Uint8Array(bytes.subarray(off, off + n)), duration: 1000, isKey: r.keys[k] }); off += n; });
    frameHashes.push(...r.hashes); renderMs += r.renderMs;
    if (b === N || b % 180 === 0) console.log(`  frames ${b}/${N}, ${((Date.now() - t0) / b).toFixed(1)} ms/frame`);
  }
  if (samples.length !== N || pageErrors.length) throw new Error(`capture failed: ${samples.length}/${N} samples; ${pageErrors.join('; ')}`);
  const meta = await page.evaluate(([g]: any) => (window as any)[g].meta(), [initCapture]);
  if (!meta.avcCb64) throw new Error('VideoEncoder did not return avcC');

  // Representative evidence is intentionally not captured from the pre-mux renderer path. Trusted frame files are
  // copied from the independent decoded-MP4 playback below, after the final output bytes exist.

  stage('encode AAC-LC and mux fast-start MP4');
  const aac = encodeAacLc([mixed.left, mixed.right], audioBitrate);
  const cs = meta.colorSpace ?? {}, P: Record<string, number> = { bt709: 1, smpte170m: 6, bt470bg: 5 }, TR: Record<string, number> = { bt709: 1, smpte170m: 6, iec61966_2_1: 13 }, MX: Record<string, number> = { bt709: 1, smpte170m: 6, bt470bg: 5, rgb: 0 };
  const mp4 = muxMp4({
    video: { width: W, height: H, timescale: fps * 1000, avcC: new Uint8Array(Buffer.from(meta.avcCb64, 'base64')), samples, color: { primaries: P[cs.primaries] ?? 1, transfer: TR[cs.transfer] ?? 1, matrix: MX[cs.matrix] ?? 1, fullRange: !!cs.fullRange } },
    audio: { codec: 'aac', sampleRate: 48000, channels: 2, asc: aac.asc, priming: aac.priming, inputSamples: aac.inputSamples, avgBitrate: audioBitrate, samples: aac.frames.map((data) => ({ data, duration: 1024 })) },
    compressorName: 'BlockSpark S7 H.264',
  });
  writeFileSync(mp4Path, mp4);
  const expectedDuration: [number, number] = evidenceProfile === 'competitor-v2' ? [69, 69.2] : [Math.max(0, videoDuration - 0.05), videoDuration + 0.05];
  const mp4Sha = hex(mp4);
  let probe;
  if (trustedManifest) {
    const ffprobe = checkedPaths.ffprobe!;
    assertPinnedRuntimeFile(ffprobe, trustedManifest.runtime.ffprobeSha256, 'FFprobe');
    const ffprobeJson = execFileSync(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-i', 'pipe:0'], {
      input: Buffer.from(mp4), encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
    });
    probe = fromFfprobeJson(JSON.parse(ffprobeJson), mp4);
  } else probe = probeFile(mp4Path);
  const production = checkProductionProfile(probe, { ...PRODUCTION_SPEC, width: W, height: H, fps: `${fps}/1`, maxAvDriftSec: 1 / fps, durationRange: expectedDuration });
  writeFileSync(join(outDir, 'probe.json'), JSON.stringify({ probe, production }, null, 2) + '\n');
  const codecProblems = codecPinIssues(probe, profile.codec);
  if (!production.ok || codecProblems.length) throw new Error(`production profile: ${[...production.errors, ...codecProblems].join('; ')}`);
  gates.productionProfile = { ok: production.ok && codecProblems.length === 0, errors: [...production.errors, ...codecProblems] };

  stage('verify independent playback and AAC/container alignment');
  // Use a unique server-visible directory per job and remove it even when decode fails.
  const publicRoot = resolve(ROOT, 'out'); mkdirSync(publicRoot, { recursive: true });
  const publicDir = mkdtempSync(join(publicRoot, 'render-verify-'));
  const publicMp4 = join(publicDir, mp4Name);
  const seekTimes = evidenceProfile === 'competitor-v2'
    ? [0.5, ...COMPETITOR_DECODED_FRAMES.map((frame) => frame.timestampSec)]
    : [0.5, videoDuration * 0.25, videoDuration * 0.5, Math.max(0.5, videoDuration - 0.5)].filter((t, i, xs) => t < videoDuration && xs.indexOf(t) === i);
  const decodedFrameClaims: DecodedFrameClaim[] = [];
  let playback: any, roundTrip: any, alignment: any, verifyPage: any = null;
  try {
    writeFileSync(publicMp4, mp4);
    playback = await verifyPlaybackWithBrowser(browser, url, relative(ROOT, publicMp4), seekTimes, join(publicDir, 'decoded'), 3);
    if (evidenceProfile === 'competitor-v2') {
      if (playback.frameFiles.length !== seekTimes.length) throw new Error(`decoded representative frame count ${playback.frameFiles.length} != ${seekTimes.length}`);
      for (let index = 0; index < COMPETITOR_DECODED_FRAMES.length; index++) {
        // index zero is the general 0.5 s playback sample; the seven following files are the committed evidence.
        const claim = COMPETITOR_DECODED_FRAMES[index];
        const decodedBytes = readBoundedFile(playback.frameFiles[index + 1], RENDER_BYTE_LIMITS.evidenceImage, `decoded frame ${claim.file}`);
        writeFileSync(join(outDir, claim.file), decodedBytes);
        decodedFrameClaims.push({ ...claim, sha256: sha256Bytes(decodedBytes), bytes: decodedBytes.length, outputSha256: mp4Sha });
      }
    }
    verifyPage = await browser.newPage(); await verifyPage.goto(`${url}/apps/studio/blank.html`);
    roundTrip = await aacRoundTrip(aac.frames, aac.asc, [mixed.left, mixed.right], aac.priming, verifyPage);
    alignment = await mp4AudioAlignment(verifyPage, `${url}/${relative(ROOT, publicMp4)}`, mixed.left);
  } finally {
    if (verifyPage) await verifyPage.close().catch(() => undefined);
    rmSync(publicDir, { recursive: true, force: true });
  }
  const avDrift = Math.abs((alignment.decodedSamples / 48000) - videoDuration);
  const mediaOk = playback.ok && playback.droppedFrames === 0 && roundTrip.ok && roundTrip.snrDb.every((x: number) => x >= 15) && Math.abs(alignment.lagSamples) <= 48 && Math.abs(alignment.decodedSamples - mixed.left.length) <= 1024 && avDrift <= 1 / fps + 1e-6;
  if (!mediaOk) throw new Error(`independent decode/playback/audio alignment verification failed: dropped=${playback.droppedFrames} snr=${JSON.stringify(roundTrip.snrDb)} lag=${alignment.lagSamples} decErr=${alignment.decodedSamples - mixed.left.length} drift=${avDrift.toFixed(4)}`);
  if (evidenceProfile === 'competitor-v2') {
    const receipt = createDecodedFrameReceipt(mp4Sha, decodedFrameClaims);
    writeFileSync(join(outDir, DECODED_FRAME_RECEIPT_FILE), JSON.stringify(receipt, null, 2) + '\n');
  }
  gates.mediaVerification = { playback: { ok: playback.ok, droppedFrames: playback.droppedFrames, videoWidth: playback.videoWidth, videoHeight: playback.videoHeight, duration: playback.duration, seekTimes }, roundTrip, alignment, avDriftSec: +avDrift.toFixed(5) };

  // ---------------------------------------------------------------- write diagnostics; cryptographic evidence is a separate independently verified report
  if (evidenceProfile === 'competitor-v2') {
    const rep = run!.report;
    const diagnostics = {
      schema: 'blockspark.s7-render-diagnostics/2', createdAt: new Date().toISOString(), visual, renderProfile: profile.id, evidenceProfile,
      inputManifest: { file: relative(ROOT, checkedPaths.inputManifest!), sha256: trustedManifestSha },
      inputs: { storyboard: relative(ROOT, sbPath), storyboardSha256: sbSha, beatSheet: relative(ROOT, beatsPath), beatSheetSha256: beatsSha, voiceSha256: voiceSha, voiceMatchesApprovedStoryboard: true, decodedDurationSec: +decodedDuration.toFixed(3), solvedCompositionsSha256: solvedCompositionsDigest(compositions) },
      output: { file: relative(ROOT, mp4Path), sha256: mp4Sha, bytes: mp4.length, width: W, height: H, fps, frames: N, durationSec: +videoDuration.toFixed(4) },
      s7: { captions: captionPlan.captions.length, placementSegments: Object.values(placements).flatMap((p: any) => p.segments).length, faceConflicts: 0, graphics: graphics.length, vfx: vfx.length, sfx: audioPlan.cues.length, music: 'none', ignoredMusic: audioPlan.ignoredMusic },
      runVignette: { blocking: rep.summary.blocking, coveragePct: +(run!.coverage.pct * 100).toFixed(1), camerasAccepted: rep.summary.camerasAccepted, camerasFallback: rep.summary.camerasFallback, camerasBlocked: rep.summary.camerasBlocked, stagingErrors: rep.summary.stagingErrors, sources: { teacher: rep.sources['character:teacher'], door: rep.sources['prop:door'], classroom: rep.sources['set:classroom'] } },
      gates, audio: mixed.report, encoding: { videoBitrate: bitrate, audioBitrate, renderMs, aac: aac.stats }, frameHashes,
    };
    const diagnosticsPath = join(outDir, 'verification.json');
    writeFileSync(diagnosticsPath, JSON.stringify(diagnostics, null, 2) + '\n');

    // comparison-sheet.jpg is assembled after the MP4. Seal only when all evidence exists and the sheet is not stale;
    // otherwise the independent sealing/verifier step must run after the sheet is regenerated.
    const comparisonPath = join(outDir, 'comparison-sheet.jpg');
    const comparisonReceiptPath = join(outDir, COMPARISON_SHEET_RECEIPT_FILE);
    const evidenceReady = COMPETITOR_EVIDENCE_FILES.every((name) => existsSync(join(outDir, name)))
      && existsSync(comparisonReceiptPath) && statSync(comparisonPath).mtimeMs >= statSync(mp4Path).mtimeMs;
    if (evidenceReady) {
      const report = buildEvidenceReport({ root: ROOT, inputManifestPath: checkedPaths.inputManifest!, outputPath: mp4Path, evidenceDir: outDir, decodedFrames: decodedFrameClaims, comparisonSheetReceiptPath: comparisonReceiptPath });
      writeFileSync(join(outDir, 'render-evidence.json'), JSON.stringify(report, null, 2) + '\n');
    } else {
      console.warn('  render-evidence.json not sealed: regenerate comparison-sheet.jpg, then run packages/captions/tools/seal-render-evidence.ts');
    }
  } else {
    const generic = {
      schema: 'blockspark.s7-render/2', createdAt: new Date().toISOString(), visual, renderProfile: profile.id,
      input: { storyboard: relative(ROOT, sbPath), storyboardSha256: sbSha, beatSheet: relative(ROOT, beatsPath), beatSheetSha256: beatsSha, voiceSha256: voiceSha },
      output: { file: relative(ROOT, mp4Path), sha256: mp4Sha, bytes: mp4.length, width: W, height: H, fps, frames: N, durationSec: videoDuration },
      s7: { captions: captionPlan.captions.length, faceConflicts: 0, graphics: graphics.length, vfx: vfx.length, sfx: audioPlan.cues.length, music: 'none' },
      planning: visual === 'narrated' ? (globalThis as any).__legacy.pre.analysis.summary : run!.report.summary,
      encoding: { videoBitrate: bitrate, audioBitrate, renderMs, frameHashes, aac: aac.stats },
      verification: { production, playback: { ...playback, frameFiles: playback.frameFiles.map((f: string) => relative(ROOT, f)) }, roundTrip, alignment, ok: mediaOk },
    };
    writeFileSync(join(outDir, 'render-manifest.json'), JSON.stringify(generic, null, 2) + '\n');
  }
  stage(`DONE ${relative(ROOT, mp4Path)} ${(mp4.length / 1e6).toFixed(2)} MB sha256 ${mp4Sha}`);
} finally { await browser.close(); server.close(); }
