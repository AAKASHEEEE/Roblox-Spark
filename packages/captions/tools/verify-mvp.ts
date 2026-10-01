// S7 MVP verification: contracts/registries, caption invariants, face-safe still evidence, audio output and no-music rule.
// Usage from repo root: node packages/captions/tools/verify-mvp.ts
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { verifyRenderV2 } from './verify-render-v2.ts';
const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const { values: args } = parseArgs({ options: { v2Voice: { type: 'string' }, authorizedManifestSha256: { type: 'string' }, skipV2: { type: 'boolean', default: false } } });
import { LIBRARY } from '../../library/src/ids.ts';
import { VFX_DEFS, S7_NEW_VFX_IDS } from '../../engine/src/vfx/index.ts';
import { SFX_DEFS, S7_NEW_SFX_IDS } from '../../audio-mix/src/sfx.ts';
import { decodeWavStereo } from '../../audio-mix/src/wav.ts';
import { integratedLoudness } from '../../audio/src/mix.ts';
import { truePeakDbtp } from '../../narrated/src/mixdown.ts';
import { TEXT_STYLE_DEFS, S7_NEW_TEXT_STYLE_IDS } from '../src/styles.ts';
import { checkBoldPlan, phrasesFromBeats, planBoldCaptions } from '../src/bold.ts';

const issues: string[] = [];
const ok = (test: unknown, message: string) => { if (!test) issues.push(message); };
const all = (xs: readonly string[], reg: Readonly<Record<string, unknown>>, kind: string) => xs.forEach((id) => ok(reg[id], `${kind}.${id}: no implementation`));

const plannedVfx = LIBRARY.vfx.filter((e) => e.owner === 'S7' && e.status === 'planned').map((e) => e.id);
const plannedText = LIBRARY.textStyles.filter((e) => e.owner === 'S7' && e.status === 'planned').map((e) => e.id);
const plannedSfx = LIBRARY.sfx.filter((e) => e.owner === 'S7' && e.status === 'planned').map((e) => e.id);
all(plannedVfx, VFX_DEFS, 'vfx'); all(plannedText, TEXT_STYLE_DEFS, 'textStyles'); all(plannedSfx, SFX_DEFS, 'sfx');
ok(plannedVfx.every((x) => S7_NEW_VFX_IDS.includes(x)), 'S7_NEW_VFX_IDS differs from planned library IDs');
ok(plannedText.every((x) => S7_NEW_TEXT_STYLE_IDS.includes(x)), 'S7_NEW_TEXT_STYLE_IDS differs from planned library IDs');
ok(plannedSfx.every((x) => S7_NEW_SFX_IDS.includes(x)), 'S7_NEW_SFX_IDS differs from planned library IDs');

const beatFile = join(ROOT, 'packages/director/fixtures/free-coins-classroom.beats.json');
const sheet = JSON.parse(readFileSync(beatFile, 'utf8'));
const phrases = phrasesFromBeats(sheet.beats), plan = planBoldCaptions(phrases);
for (const x of checkBoldPlan(phrases, plan)) issues.push(x);
ok(plan.captions.every((c) => c.words.length >= 1 && c.words.length <= 4), 'caption_bold: a caption is not 1-4 words');
ok(plan.captions.every((c) => c.highlight && ['yellow', 'red'].includes(c.highlightColor)), 'caption_bold: every caption needs one yellow/red keyword');

const stillIndex = join(ROOT, 'packages/captions/stills/stills-index.json');
ok(existsSync(stillIndex), 'stills-index.json missing: run render-stills.ts');
let stills: any = null;
if (existsSync(stillIndex)) {
  stills = JSON.parse(readFileSync(stillIndex, 'utf8'));
  ok(stills.summary.captions === plan.captions.length, `stills: expected ${plan.captions.length} captions, got ${stills.summary.captions}`);
  ok(stills.summary.clearOfFaces === plan.captions.length, `stills: ${stills.summary.faceConflicts?.length ?? '?'} face conflicts`);
  ok(stills.summary.faceConflicts?.length === 0, 'stills: faceConflicts is not empty');
  const files = new Set(stills.stills.map((s: any) => s.file));
  for (const f of ['sheet-caption_bold.jpg', 'sheet-caption_bold-face-boxes.jpg', 'sheet-graphics.jpg', 'sheet-vfx.jpg', 'emote-icons.png']) ok(existsSync(join(ROOT, 'packages/captions/stills', f)), `stills: ${f} missing`);
  for (const id of plannedVfx) ok([...files].some((f) => String(f).includes(id)), `stills: no visual evidence for ${id}`);
  for (const id of plannedText) ok([...files].some((f) => String(f).includes(id)) || id === 'caption_bold', `stills: no visual evidence for ${id}`);
}

const wavPath = join(ROOT, 'packages/audio-mix/samples/mix-test-10s.wav'), reportPath = join(ROOT, 'packages/audio-mix/samples/mix-test-10s.report.json'), independentPath = join(ROOT, 'packages/audio-mix/samples/mix-test-10s.independent-meter.json');
ok(existsSync(wavPath), '10 s mix WAV missing: run mix-test.ts');
ok(existsSync(reportPath), 'mix report missing: run mix-test.ts');
ok(existsSync(independentPath), 'independent meter evidence missing');
let mix: any = null;
let measuredAudio: { integratedLufs: number; truePeakDbtp: number } | null = null;
if (existsSync(wavPath)) {
  const wavBytes = new Uint8Array(readFileSync(wavPath));
  const w = decodeWavStereo(wavBytes);
  ok(w.sampleRate === 48000, `mix WAV: expected 48000 Hz, got ${w.sampleRate}`);
  ok(w.bits === 24, `mix WAV: expected 24-bit, got ${w.bits}`);
  ok(Math.abs(w.left.length / w.sampleRate - 10) < 1e-9, `mix WAV: expected 10 s, got ${w.left.length / w.sampleRate}`);
  ok(statSync(wavPath).size > 1_000_000, 'mix WAV is unexpectedly small');
  measuredAudio = { integratedLufs: +integratedLoudness(w.left, w.right).toFixed(2), truePeakDbtp: truePeakDbtp(w.left, w.right) };
  ok(Math.abs(measuredAudio.integratedLufs + 14) <= 0.5, `mix WAV measured ${measuredAudio.integratedLufs} LUFS`);
  ok(measuredAudio.truePeakDbtp <= -1, `mix WAV measured ${measuredAudio.truePeakDbtp} dBTP`);
  if (existsSync(independentPath)) {
    const independent = JSON.parse(readFileSync(independentPath, 'utf8'));
    const digest = createHash('sha256').update(wavBytes).digest('hex');
    ok(independent.sha256 === digest, 'independent meter evidence does not match the WAV');
    ok(Math.abs(independent.integratedLufs + 14) <= 0.5 && independent.truePeak8xDbtp <= -1, 'independent meter evidence is outside targets');
  }
}
if (existsSync(reportPath)) {
  mix = JSON.parse(readFileSync(reportPath, 'utf8'));
  ok(Math.abs(mix.fileCheck.integratedLufs + 14) <= 0.5, `mix: ${mix.fileCheck.integratedLufs} LUFS is outside -14 +/-0.5`);
  ok(mix.fileCheck.truePeakDbtp <= -1, `mix: true peak ${mix.fileCheck.truePeakDbtp} dBTP exceeds -1`);
  ok(mix.mix.music === 'none' && mix.pass.noMusic, 'mix: music is present');
  ok(mix.pass.allCuesMixed, 'mix: at least one event SFX was not mixed');
  ok(mix.pass.sfxUnderVoice, 'mix: SFX guard failed');
  ok(mix.ignoredMusic.every((m: any) => m.reason === 'music_added_in_editing'), 'mix: beat-sheet music was not explicitly ignored');
}

const showcasePath = join(ROOT, 'packages/captions/showcase/verification.json');
ok(existsSync(showcasePath), 'showcase verification missing');
let showcaseCount = 0;
if (existsSync(showcasePath)) {
  const showcase = JSON.parse(readFileSync(showcasePath, 'utf8'));
  showcaseCount = showcase.results.length;
  ok(showcaseCount === 3, `showcase: expected 3 MP4s, got ${showcaseCount}`);
  for (const r of showcase.results) {
    const p = join(ROOT, r.file);
    ok(existsSync(p), `showcase: ${r.file} missing`);
    if (!existsSync(p)) continue;
    const bytes = new Uint8Array(readFileSync(p)), digest = createHash('sha256').update(bytes).digest('hex');
    ok(bytes.length === r.bytes, `showcase: ${r.file} byte count changed`);
    ok(digest === r.sha256, `showcase: ${r.file} SHA-256 changed`);
    ok(r.fastStart && r.video.codec === 'h264' && r.audio.codec === 'aac' && r.playback.ok, `showcase: ${r.file} media verification failed`);
  }
}

const fullPath = join(ROOT, 'packages/captions/full-render/verification.json');
ok(existsSync(fullPath), 'full real-voice render verification missing');
let fullVideo: unknown = 'missing';
if (existsSync(fullPath)) {
  const full = JSON.parse(readFileSync(fullPath, 'utf8')), p = join(ROOT, full.output.file);
  ok(existsSync(p), `full render: ${full.output.file} missing`);
  if (existsSync(p)) {
    const bytes = new Uint8Array(readFileSync(p)), digest = createHash('sha256').update(bytes).digest('hex');
    ok(bytes.length === full.output.bytes, 'full render byte count changed');
    ok(digest === full.output.sha256, 'full render SHA-256 changed');
  }
  ok(full.input.voiceMatchesApprovedStoryboard && full.input.phraseTimingsMatched === '14/14', 'full render voice approval mismatch');
  ok(full.s7.faceConflicts === 0 && full.s7.music === 'none' && full.s7.sfx === 19, 'full render S7 policy failed');
  ok(Math.abs(full.audio.integratedLufs + 14) <= 0.5 && full.audio.truePeakDbtp <= -1, 'full render audio limits failed');
  ok(full.gates.allPassed && full.gates.narratedIntegration === '47/47' && full.gates.droppedFrames === 0, 'full render media gates failed');
  fullVideo = { durationSec: full.output.durationSec, resolution: `${full.output.width}x${full.output.height}`, fps: full.output.fps, faceConflicts: full.s7.faceConflicts, music: full.s7.music, gates: full.gates.narratedIntegration };
}

let v2: ReturnType<typeof verifyRenderV2> | 'skipped' = 'skipped';
if (!args.skipV2) {
  const reportPath = join(ROOT, 'packages/captions/full-render-v2/render-evidence.json');
  v2 = verifyRenderV2({ root: ROOT, reportPath, ...(args.v2Voice ? { voicePath: resolve(ROOT, args.v2Voice) } : {}), ...(args.authorizedManifestSha256 ? { authorizedManifestSha256: args.authorizedManifestSha256 } : {}) });
  for (const issue of v2.issues) issues.push(`full render v2: ${issue}`);
}

const verificationStatus = issues.length ? 'failed' : v2 !== 'skipped' && !v2.complete ? 'partial' : 'ok';
const summary = {
  status: verificationStatus,
  plannedImplemented: { vfx: plannedVfx.length, textStyles: plannedText.length, sfx: plannedSfx.length },
  captions: { phrases: phrases.length, captions: plan.captions.length, oneToFourWords: plan.captions.every((c) => c.words.length <= 4), faceSafe: stills ? `${stills.summary.clearOfFaces}/${stills.summary.captions}` : 'missing' },
  audio: mix && measuredAudio ? { durationSec: mix.fileCheck.durationSec, integratedLufs: measuredAudio.integratedLufs, truePeakDbtp: measuredAudio.truePeakDbtp, music: mix.mix.music, eventSfx: mix.mix.cues.length } : 'missing',
  showcaseMp4s: showcaseCount,
  fullVideo,
  fullVideoV2: v2 === 'skipped' ? 'skipped' : { integrityOk: v2.ok, trusted: v2.trusted, complete: v2.complete, provenance: v2.provenance, sourceExactRecompute: v2.sourceExactRecompute, authorizationVerified: v2.authorizationVerified, manifestSha256: v2.manifestSha256, outputSha256: v2.outputSha256, mediaSha256: v2.mediaSha256, evidenceVerified: v2.evidenceVerified, voiceBytesVerified: v2.voiceBytesVerified, warnings: v2.warnings, media: v2.media },
  issues,
};
console.log(JSON.stringify(summary, null, 2));
if (issues.length) process.exit(1);
