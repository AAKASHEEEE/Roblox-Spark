// Narrated Story Phase 2A: APPROVED storyboard + retained voice-over -> deterministic 540x960 DRAFT MP4.
// The job works in its own directory: the approved voice-over is copied in and re-hashed, the timeline is compiled from
// the approved data only, the existing render worker renders it (validation profile narrated-draft) with the caption
// chunks burned in and the voice-over mix as the only audio, and the narrated quality gates decide success.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join, relative } from 'node:path';
import { ROOT } from '../render-worker/lib/server.ts';
import { sha256, loadLibrary } from '../render-worker/lib/library.ts';
import { renderEpisode } from '../render-worker/render.ts';
import { buildRegistry } from '../../packages/story/src/registry.ts';
import { DEFAULT_MOTION_PROFILE, CURRENT_RENDERER_VERSION } from '../../packages/schema/src/render-compat.ts';
import { decodeWav, type AudioFormat } from '../../packages/narrated/src/audio.ts';
import type { NarratedStoryboard } from '../../packages/narrated/src/schema.ts';
import { compileNarratedTimeline, draftEpisode, DRAFT_EXPORT, TIMELINE_SCHEMA, type NarratedTimeline } from '../../packages/narrated/src/timeline.ts';
import { mixVoiceOver, resampleTo48k } from '../../packages/narrated/src/mixdown.ts';
import { buildWorldPlan, worldAssets } from '../../packages/narrated/src/world.ts';
import { validateEpisode } from '../../packages/pipeline/src/validate.ts';
import { headlessEngine } from '../../packages/engine/src/headless.ts';
import { integrateNarrated } from '../render-worker/narrated-integration.ts';

export const NARRATED_DRAFT_DURATION: [number, number] = [35, 75];

/** the draft Episode for the approved storyboard (existing engine; validation profile narrated-draft) */
export function draftEpisodeFor(sb: NarratedStoryboard, tl: NarratedTimeline, lib: ReturnType<typeof loadLibrary>): Record<string, unknown> {
  const reg = buildRegistry(lib as never);
  return draftEpisode(sb, tl, { characters: Object.fromEntries(Object.entries(reg.characters).map(([k, c]) => [k, c.version])), environment: { id: reg.environment.id, version: reg.environment.version }, props: { button: reg.props.button.version, coin: reg.props.coin.version, desk: reg.props.desk.version }, motionProfile: DEFAULT_MOTION_PROFILE, rendererVersion: CURRENT_RENDERER_VERSION });
}

/**
 * Continuity Checkpoint 2 integration (analysis only, no pixels): approved storyboard -> timeline -> WorldPlan ->
 * adapter-posed engine scene -> safe cameras -> stable caption placements -> blocking gates. The render path consumes
 * `integrated` verbatim; it must not start when `analysis.summary.blocking` is true.
 */
export function prepareIntegration(sb: NarratedStoryboard, sbSha: string, lib: ReturnType<typeof loadLibrary>, onProgress?: (stage: string, done: number, total: number) => void) {
  const tl = compileNarratedTimeline(sb, sbSha);
  const raw = draftEpisodeFor(sb, tl, lib);
  const v = validateEpisode(raw, lib as never, { repair: true, profile: 'narrated-draft' });
  if (!v.ok || !v.episode) throw new Error(`draft episode failed validation: ${v.findings.filter((f) => f.severity === 'error').map((f) => f.code).join(', ')}`);
  const plan = buildWorldPlan(sb, worldAssets(lib as never));
  if (plan.status !== 'ok') throw new Error(`WORLD_PLAN_UNAVAILABLE: ${plan.errors.map((e) => `${e.code} ${e.message}`).join('; ')}`);
  const { prod } = headlessEngine(v.episode, lib as never, DRAFT_EXPORT.width, DRAFT_EXPORT.height);
  const r = integrateNarrated({ sb, tl, plan, prod, width: DRAFT_EXPORT.width, height: DRAFT_EXPORT.height, onProgress });
  return { tl, episode: v.episode, plan, integrated: r.timeline, analysis: r.analysis };
}
export interface DraftJobInput { storyboard: NarratedStoryboard; storyboardSha256: string; approvalId: string; audioFile: string; audioFormat: AudioFormat; jobDir: string; ffmpeg: string | null; onStage: (stage: string, done?: number, total?: number) => void }
export interface DraftJobResult { ok: boolean; outputs: Record<string, string>; error?: string; quality?: { passed: number; total: number; failed: string[] } | null; media?: Record<string, string | number> | null }
export type DraftRenderer = (i: DraftJobInput) => Promise<DraftJobResult>;

/** full-quality mono voice-over at 48 kHz (WAV natively; MP3/M4A via FFmpeg argument arrays, never a shell) */
async function decodeForRender(file: string, format: AudioFormat, ffmpeg: string | null): Promise<Float32Array> {
  if (format === 'wav') { const a = decodeWav(new Uint8Array(readFileSync(file))); return resampleTo48k(a.pcm, a.sampleRate); }
  if (!ffmpeg) throw new Error('FFmpeg is required to decode MP3/M4A voice-overs for rendering (FFMPEG_PATH or ffmpeg on PATH)');
  const out = await new Promise<Buffer>((ok, fail) => execFile(ffmpeg, ['-hide_banner', '-nostdin', '-protocol_whitelist', 'file', '-f', format === 'mp3' ? 'mp3' : 'mov', '-i', file, '-map', '0:a:0', '-vn', '-sn', '-dn', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-acodec', 'pcm_f32le', 'pipe:1'],
    { encoding: 'buffer', maxBuffer: 48000 * 4 * 320, timeout: 120000 }, (e, o) => (e ? fail(new Error('voice-over could not be decoded for rendering')) : ok(o as Buffer))));
  return new Float32Array(out.buffer.slice(out.byteOffset, out.byteOffset + (out.length - (out.length % 4))));
}

/** narrated draft gates (Visual Comedy gates do not apply); every failure is reported, none is silently passed */
export function narratedGates(sb: NarratedStoryboard, tl: NarratedTimeline, ep: any, audioReport: any, jobAudioHash: string, ctx: { analysis: any[]; probe: any; production: any; playback: any }): Array<{ id: string; name: string; pass: boolean; detail: string }> {
  const G: Array<{ id: string; name: string; pass: boolean; detail: string }> = [];
  const g = (id: string, name: string, pass: boolean, detail: string) => G.push({ id, name, pass, detail });
  const v = ctx.probe?.streams?.find((s: any) => s.codec_type === 'video'), a = ctx.probe?.streams?.find((s: any) => s.codec_type === 'audio');
  const vd = Number(v?.duration ?? ctx.probe?.format?.duration ?? 0), ad = Number(a?.duration ?? vd);
  g('N01', 'duration matches the voice-over', Math.abs(vd - tl.videoDuration) <= 1 / 30 + 1e-3 && vd + 1e-3 >= tl.duration && Math.abs(vd - ad) <= 1 / 30 + 0.025, `video ${vd.toFixed(3)} s, audio ${ad.toFixed(3)} s, voice-over ${tl.duration} s`);
  const st = sb.captionStyle, blockBottom = st.centerY + (2 * 1.22 * 0.036) / 2;
  g('N02', 'captions inside the lower-middle safe area', blockBottom <= 1 - st.bottomSafe + 1e-9 && tl.captions.every((c) => c.lines.length <= 2 && c.lines.every((l) => l.length <= st.maxCharsPerLine)), `block centre ${st.centerY}, bottom ${blockBottom.toFixed(3)} <= ${1 - st.bottomSafe}; <= 2 lines x ${st.maxCharsPerLine} chars`);
  const ordered = tl.captions.every((c, k) => c.end > c.start && (!k || c.start >= tl.captions[k - 1].end - 1e-9));
  g('N03', 'caption chunks in order, no overlap', ordered, `${tl.captions.length} chunks`);
  const planned = sb.script.phrases.flatMap((p) => p.caption.chunks);
  g('N04', 'captions exactly on their planned intervals and text', planned.length === tl.captions.length && planned.every((c, k) => c.start === tl.captions[k].start && c.end === tl.captions[k].end && c.lines.join('|') === tl.captions[k].lines.join('|')), `${planned.length} planned / ${tl.captions.length} burned`);
  const oof = (shot: string, subj: string) => { const fr = ctx.analysis.filter((x) => x.shot === shot); return fr.length ? fr.filter((x) => x.issues.some((i: any) => i.code === 'SUBJECT_OUT_OF_FRAME' && i.subject === subj)).length / fr.length : 0; };
  const unseen = sb.script.phrases.filter((p) => !tl.shots.filter((s) => s.phraseId === p.id).some((s) => oof(s.id, s.subjects[0]) <= 0.1));
  g('N05', 'actor or causal prop visible in every beat', unseen.length === 0, unseen.length ? `not visible: ${unseen.map((p) => p.id).join(', ')}` : `${sb.script.phrases.length}/${sb.script.phrases.length} beats`);
  g('N06', 'only registered assets and actions (narrated-draft validation)', !!ctx.production && ep.actions.every((x: any) => sb.characters.includes(x.actor)), `${ep.actions.length} actions, ${ep.propEvents.length} prop events, ${ep.cast.length} cast`);
  const off = [...new Set(sb.script.phrases.flatMap((p) => p.offscreenCharacters))];
  const mentions = JSON.stringify([ep.cast, ep.shots.map((s: any) => s.subjects), ep.actions.map((x: any) => [x.actor, x.target])]).toLowerCase();
  g('N07', 'no unavailable (off-screen) character instantiated', off.every((m) => !mentions.includes(m)) && ep.cast.every((c: any) => sb.characters.includes(c.id)), off.length ? `off-screen only: ${off.join(', ')} (${tl.offscreenCues.length} cues)` : 'none mentioned');
  const longest = Math.max(...ep.shots.map((s: any) => s.end - s.start));
  g('N08', 'no visual shot longer than 3 s', longest <= 3 + 1e-9, `${ep.shots.length} shots, longest ${longest.toFixed(2)} s`);
  const noChange = tl.captions.filter((c, k) => !tl.shots.some((s) => (k === 0 ? s.start <= c.start + 1e-9 : Math.abs(s.start - c.start) < 1e-6)));
  g('N09', 'a visual change at every caption chunk', noChange.length === 0, noChange.length ? `missing: ${noChange.map((c) => c.chunkId).join(', ')}` : `${tl.captions.length}/${tl.captions.length}`);
  g('N10', 'audio codec AAC-LC', a?.codec_name === 'aac', String(a?.codec_name));
  g('N11', 'video codec H.264', v?.codec_name === 'h264', String(v?.codec_name));
  g('N12', 'resolution 540x960', v?.width === DRAFT_EXPORT.width && v?.height === DRAFT_EXPORT.height, `${v?.width}x${v?.height}`);
  g('N13', 'constant 30 fps', v?.r_frame_rate === '30/1' && (v?.avg_frame_rate ?? '30/1') === '30/1', `${v?.r_frame_rate} (avg ${v?.avg_frame_rate})`);
  g('N14', 'audio 48 kHz', Number(a?.sample_rate) === 48000, `${a?.sample_rate} Hz, ${a?.channels} ch`);
  g('N15', 'loudness -16..-14 LUFS, true peak <= -1.5 dBTP', audioReport.integratedLufs >= -16 && audioReport.integratedLufs <= -14 && audioReport.truePeakDbtp <= -1.5, `${audioReport.integratedLufs} LUFS, ${audioReport.truePeakDbtp} dBTP (4x oversampled), SFX ducked ${tl.audio.duckingDb} dB`);
  g('N16', 'approved audio hash = render input', jobAudioHash === sb.audio.contentHash && tl.audioHash === sb.audio.contentHash, `${jobAudioHash.slice(0, 12)}…`);
  g('N17', 'timeline and manifest carry schema/version information', tl.schema === TIMELINE_SCHEMA && tl.storyboardSchemaVersion === sb.schemaVersion, `${tl.schema}, storyboard ${tl.storyboardSchemaVersion}, episode ${ep.schemaVersion}`);
  g('N18', 'independent decode of the MP4 (video + audio)', !!ctx.playback?.ok, ctx.playback ? `${ctx.playback.videoWidth}x${ctx.playback.videoHeight} ${ctx.playback.duration}s` : 'not run');
  return G;
}

export const renderNarratedDraft: DraftRenderer = async (i) => {
  const outputs: Record<string, string> = {}, url = (f: string) => `/${relative(ROOT, join(i.jobDir, f))}`;
  const input = join(i.jobDir, 'input');
  try {
    i.onStage('preparing');
    mkdirSync(input, { recursive: true });
    const copy = join(input, `voice-over.${i.audioFormat}`); // job-local copy, named by format only (never the display name)
    copyFileSync(i.audioFile, copy);
    const jobHash = sha256(readFileSync(copy));
    if (jobHash !== i.storyboard.audio.contentHash) throw new Error('the voice-over copied into the job does not match the approved content hash; refusing to render');
    const D = i.storyboard.audio.durationSeconds;
    if (D < NARRATED_DRAFT_DURATION[0] || D > NARRATED_DRAFT_DURATION[1]) throw new Error(`narrated drafts need a ${NARRATED_DRAFT_DURATION.join('-')} s voice-over (got ${D} s)`);
    const vo = await decodeForRender(copy, i.audioFormat, i.ffmpeg);
    i.onStage('compiling');
    const lib = loadLibrary();
    // Continuity Checkpoint 2: WorldState -> posed scene -> safe cameras -> stable captions -> blocking gates (no pixels)
    const pre = prepareIntegration(i.storyboard, i.storyboardSha256, lib, (st, d, t) => i.onStage('analyzing', d, t));
    const tl = pre.tl, ep = draftEpisodeFor(i.storyboard, tl, lib);
    writeFileSync(join(i.jobDir, 'approved-narrated.json'), JSON.stringify(i.storyboard, null, 2)); outputs.approvedJson = url('approved-narrated.json');
    writeFileSync(join(i.jobDir, 'render-timeline.json'), JSON.stringify({ timeline: tl, integrated: pre.integrated }, null, 2)); outputs.timelineJson = url('render-timeline.json');
    writeFileSync(join(i.jobDir, 'analysis-report.json'), JSON.stringify(pre.analysis, null, 2)); outputs.analysis = url('analysis-report.json');
    if (pre.analysis.summary.blocking) {
      // a render must not start while any blocking continuity / camera / caption / semantic gate fails
      rmSync(input, { recursive: true, force: true });
      return { ok: false, outputs, quality: { passed: pre.analysis.summary.passed, total: pre.analysis.summary.total, failed: pre.analysis.summary.failed }, error: `blocking analysis gates failed (render not started): ${pre.analysis.summary.failed.join(', ')}` };
    }
    writeFileSync(join(i.jobDir, 'draft-episode.json'), JSON.stringify(ep, null, 2));
    // voice-over first: padded (never cut) to whole frames; SFX low and ducked; loudness-normalised
    const N = Math.round(tl.videoDuration * 30), padded = new Float32Array(N * 1600);
    padded.set(vo.subarray(0, Math.min(vo.length, padded.length)));
    const audioAssets = Object.fromEntries(Object.values(lib.audio).map((x) => [x.id, x]));
    const mixed = mixVoiceOver(padded, tl.audio.sfx, audioAssets as never, { loudnessLufs: DRAFT_EXPORT.loudnessLufs, duckingDb: tl.audio.duckingDb });
    const stageOf: Record<string, string> = { validate: 'compiling', analyze: 'compiling', audio: 'encoding', render: 'rendering', verify: 'validating', done: 'validating' };
    const r = await renderEpisode({
      episode: relative(ROOT, join(i.jobDir, 'draft-episode.json')), episodeObject: ep, out: relative(ROOT, i.jobDir), scale: DRAFT_EXPORT.scale, profile: 'diagnostic', audioCodec: 'aac', validationProfile: 'narrated-draft',
      onProgress: (p) => i.onStage(stageOf[p.phase] ?? 'rendering', p.done, p.total),
      narrated: {
        left: mixed.left, right: mixed.right, audioReport: { ...mixed.report, truePeakDbfsApprox: mixed.report.truePeakDbtp }, captions: pre.integrated.captions, integrated: { storyboard: i.storyboard, timeline: pre.integrated }, captionStyle: { centerY: i.storyboard.captionStyle.centerY, bottomSafe: i.storyboard.captionStyle.bottomSafe },
        durationRange: [NARRATED_DRAFT_DURATION[0], NARRATED_DRAFT_DURATION[1] + 0.05],
        gates: (c) => [...narratedGates(i.storyboard, tl, c.ep, mixed.report, jobHash, c).filter((g) => g.id !== 'N05'), ...pre.analysis.gates.map((g) => ({ id: g.id, name: `[${g.group}] ${g.name}`, pass: g.pass, detail: g.detail }))],
      },
    });
    const q = r.report as { summary: { passed: number; total: number; failed: string[] } } | undefined;
    if (r.mp4 && existsSync(r.mp4)) { copyFileSync(r.mp4, join(i.jobDir, 'draft-540x960.mp4')); rmSync(r.mp4, { force: true }); outputs.mp4 = url('draft-540x960.mp4'); }
    const man = join(i.jobDir, 'render-manifest.json');
    if (existsSync(man)) {
      const m = JSON.parse(readFileSync(man, 'utf8'));
      writeFileSync(man, JSON.stringify({ ...m, mp4: relative(ROOT, join(i.jobDir, 'draft-540x960.mp4')), narrated: { label: DRAFT_EXPORT.label, timelineSchema: tl.schema, storyboardSchemaVersion: tl.storyboardSchemaVersion, storyboardId: tl.storyboardId, storyboardSha256: tl.storyboardSha256, approvalId: i.approvalId, audioContentHash: jobHash, seed: tl.seed, captionChunks: tl.captions.length, shots: tl.shots.length } }, null, 2));
      outputs.manifest = url('render-manifest.json');
    }
    for (const [k, f] of [['quality', 'quality-report.json'], ['contactSheet', 'contact-sheet.png'], ['validation', 'validation.json']]) if (existsSync(join(i.jobDir, f))) outputs[k] = url(f);
    rmSync(input, { recursive: true, force: true }); rmSync(join(i.jobDir, 'mix.wav'), { force: true }); rmSync(join(i.jobDir, 'decoded'), { recursive: true, force: true });
    return { ok: r.ok && !!outputs.mp4, outputs, quality: q ? { passed: q.summary.passed, total: q.summary.total, failed: q.summary.failed } : null, error: r.ok ? undefined : q ? `draft quality gates failed: ${q.summary.failed.join(', ') || 'playback'}` : 'the draft did not validate (see validation.json)' };
  } catch (e) {
    // partial temporary derivatives are removed; logs, validation and the approved source are kept
    for (const f of ['input', 'decoded', 'mix.wav', 'draft-540x960.mp4']) rmSync(join(i.jobDir, f), { recursive: true, force: true });
    return { ok: false, outputs, error: String((e as Error)?.message ?? e).slice(0, 400) };
  }
};
