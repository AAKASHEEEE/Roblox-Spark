// Quality gates evaluated after the analysis + render passes. Each gate states its evidence and whether it is
// a direct measurement or a proxy (some creative criteria cannot be measured automatically).
import type { Episode } from '../../schema/src/episode.ts';
import type { ValidationResult, Lib, ValidationProfile } from './validate.ts';
import { findBannedTerms, longShots, MAX_SHOT_SEC } from './validate.ts';
import { CHANNEL_DURATION_SEC } from '../../config/src/product.ts';

/** status 'n/a' = the gate does not apply under the validation profile (never counted as passed or failed) */
export interface Gate { id: string; name: string; pass: boolean; status?: 'pass' | 'fail' | 'n/a'; kind: 'measured' | 'proxy' | 'static'; detail: string; group?: string }
export interface QualityReport { summary: { total: number; passed: number; failed: string[]; notApplicable: string[]; validationProfile: ValidationProfile; durationTargetSec: [number, number]; groups: Record<string, { passed: number; total: number }> }; profile: string; gates: Gate[]; frameIssues: Record<string, number>; issuesByShot: Record<string, Record<string, number>>; motion: Record<string, unknown>; notes: string[] }

/** gates that judge the STORY (duration target, premise, pacing, causality, reversal, loop, comprehension) */
export const STORY_ONLY_GATES: ReadonlySet<string> = new Set(['G03', 'G07', 'G08', 'G10', 'G11', 'G12', 'G13', 'G14', 'G15', 'G23']);
/** G13 = no shot longer than the shared MAX_SHOT_SEC (same rule as the validator's SHOT_TOO_LONG) */
export const g13Pass = (ep: { shots: ReadonlyArray<{ start: number; end: number }> }): boolean => longShots(ep).length === 0;

export interface QualityInput {
  ep: Episode; validation: ValidationResult; analysis: Array<{ t: number; shot: string; issues: Array<{ code: string; message: string }>; handErrors: Record<string, number> }>;
  contactChecks: Array<{ t: number; handErrors: Record<string, number> }>; probes: any[]; contacts: Array<{ actor: string; action: string; t: number }>;
  impacts: Array<{ prop: string; t: number; kind: string; strength: number }>; inspect: any; playback: any; loopDiff: number[]; audio: any; lib: Lib & { hashes?: Record<string, string> }; timing: any; fps: number;
  /** 'final' (1080x1920) or 'diagnostic' (low-resolution QA render) */
  profile?: string; resolution?: [number, number];
  production?: { ok: boolean; tool: string; errors: string[]; checks: Array<{ name: string; ok: boolean; got: string; want: string }> } | null;
  aacCheck?: { roundTrip: { snrDb: number[]; bestLag: number }; containerAlignment: { lagSamples: number; lagMs: number; decodedSamples: number; snrDb: number; error?: string } } | null;
  extraGates?: Gate[];
  /** continuous-time swept-hand issues (Production.sweptHandIssues); absent = gate M01 not evaluated */
  sweep?: Array<{ t: number; message: string; code: string }>;
  /** default story-episode; action-reel marks STORY_ONLY_GATES and story-group extra gates as not applicable */
  validationProfile?: ValidationProfile;
  /**
   * Explicitly declared NARROWER duration target for this test case (e.g. [14, 18] for the original PoC brief). Absent =>
   * the channel production boundary CHANNEL_DURATION_SEC. Must lie inside the channel boundary.
   */
  durationTargetSec?: [number, number];
}

const HARD = new Set(['SUBJECT_OUT_OF_FRAME', 'SUBJECT_BEHIND_CAMERA', 'FACE_OUT_OF_FRAME', 'FACE_OCCLUDED', 'HAND_PENETRATION', 'CAMERA_IN_PROP']);

export function buildQualityReport(q: QualityInput): QualityReport {
  const { ep, validation: v, fps } = q;
  const D = ep.episode.duration, N = Math.round(D * fps);
  const gates: Gate[] = [];
  const g = (id: string, name: string, pass: boolean, kind: Gate['kind'], detail: string) => gates.push({ id, name, pass, kind, detail });
  const has = (code: string) => v.findings.some((f) => f.code === code && f.severity !== 'info');
  const vt = q.inspect?.tracks?.find((t: any) => t.handler === 'vide');
  const at = q.inspect?.tracks?.find((t: any) => t.handler === 'soun');

  const audioDur = at ? at.editDurationSec ?? (at.duration - (at.editMediaTime ?? 0)) / at.timescale : 0;
  g('G01', 'Playable MP4 produced automatically (no screen recording)', !!q.playback?.ok, 'measured', q.playback ? `Chromium decoded ${q.playback.framesDecodedDuringPlay} frames in ${q.playback.playedSeconds.toFixed(2)}s real-time playback, ${q.playback.droppedFrames} dropped; errors: ${q.playback.errors.join('; ') || 'none'}` : 'verification skipped');
  const prof = q.profile ?? 'final';
  const [ew, eh] = prof === 'final' ? [1080, 1920] : (q.resolution ?? [1080, 1920]);
  g('G02', prof === 'final' ? 'Resolution 1080x1920' : `Resolution (diagnostic profile ${ew}x${eh})`, vt?.width === ew && vt?.height === eh && q.playback?.videoWidth === ew, 'measured', `container ${vt?.width}x${vt?.height}, decoded ${q.playback?.videoWidth}x${q.playback?.videoHeight}${prof === 'final' ? '' : ' — DIAGNOSTIC render, not a production output'}`);
  const [cMin, cMax] = CHANNEL_DURATION_SEC;
  const declared = q.durationTargetSec;
  if (declared && (declared[0] < cMin || declared[1] > cMax || declared[0] > declared[1])) throw new Error(`durationTargetSec ${declared.join('-')} must be a range inside the channel boundary ${cMin}-${cMax} s`);
  const [dMin, dMax] = declared ?? [cMin, cMax];
  g('G03', declared ? `Duration within the declared test target ${dMin}-${dMax} s` : `Duration within the channel production boundary ${cMin}-${cMax} s`, vt && vt.durationSec >= dMin && vt.durationSec <= dMax, 'measured', `video ${vt?.durationSec.toFixed(3)}s, audio presented ${audioDur.toFixed(3)}s (edit list skips ${at?.editMediaTime ?? 0} ${at?.codec === 'mp4a' ? 'AAC priming' : 'Opus pre-skip'} samples)${declared ? ` — narrower target explicitly declared by this test case (channel boundary ${cMin}-${cMax} s)` : ''}`);
  const durs = new Set(vt?.sampleDurations ?? []);
  g('G04', 'Stable frame rate', vt?.sampleCount === N && durs.size === 1, 'measured', `${vt?.sampleCount} samples (expected ${N}), unique sample durations ${[...durs].join(',')} @ timescale ${vt?.timescale} => ${vt ? (vt.timescale / ([...durs][0] as number)).toFixed(3) : '?'} fps constant`);
  const audioDurErr = at && vt ? Math.abs(audioDur - vt.durationSec) : 99;
  g('G05', 'Audio present, decodable, length matches video', !!at && (q.playback?.audioDecodedBytes ?? 0) > 0 && audioDurErr < 0.05, 'measured', `codec ${at?.codec}, ${at?.channels}ch ${at?.sampleRate} Hz; decoded ${q.playback?.audioDecodedBytes} bytes; |audio-video| = ${(audioDurErr * 1000).toFixed(1)} ms`);
  g('G06', 'Audio synchronised to visual events (<= 1 frame)', !has('AV_SYNC'), 'measured', `synced cues are pinned to computed contact/impact times; repairs: ${v.repairs.filter((r) => r.includes('cue')).join('; ') || 'none needed'}`);

  const hero = ep.props.find((p) => p.hero)!.instance;
  const openIssues = q.analysis.filter((a) => a.t < 1).flatMap((a) => a.issues).filter((i) => HARD.has(i.code));
  g('G07', 'Premise (hero prop) visible within 1 s', ep.shots[0].subjects.includes(hero) && !has('PREMISE_NOT_VISIBLE') && openIssues.length === 0, 'measured', `opening shot ${ep.shots[0].id} ${ep.shots[0].preset} on "${hero}" from t=0; hard framing issues in first second: ${openIssues.length}`);
  const prot = ep.cast.find((c) => c.role === 'protagonist')!.id;
  const protShots = ep.shots.filter((s) => s.subjects.includes(prot));
  const protFace = q.analysis.flatMap((a) => a.issues).filter((i: any) => i.subject === prot && (i.code.startsWith('FACE') || HARD.has(i.code)));
  g('G08', 'Protagonist and hero prop identifiable', protShots.length >= 3 && protFace.length === 0, 'measured', `${prot} is a framed subject in ${protShots.length} shots; face/framing issues on ${prot}: ${protFace.length}`);

  // teleport detection from per-frame probes
  const tele: string[] = [];
  for (let i = 1; i < q.probes.length; i++) {
    const a = q.probes[i - 1], b = q.probes[i];
    for (const id of Object.keys(b.actors)) { const d = Math.hypot(b.actors[id].root[0] - a.actors[id].root[0], b.actors[id].root[2] - a.actors[id].root[2]) * fps; if (d > 7) tele.push(`${id}@${b.t.toFixed(2)} ${d.toFixed(1)} m/s`); }
    for (const id of Object.keys(b.props)) { if (!a.props[id].visible || !b.props[id].visible) continue; const pa = a.props[id].pos, pb = b.props[id].pos; const d = Math.hypot(pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]) * fps; if (d > 14) tele.push(`${id}@${b.t.toFixed(2)} ${d.toFixed(1)} m/s`); }
  }
  g('G09', 'No unexplained teleportation (actors/props)', tele.length === 0, 'measured', tele.length ? tele.slice(0, 6).join('; ') : `checked ${q.probes.length} consecutive frames: max plausible speed thresholds 7 m/s (actors) / 14 m/s (props)`);
  const handErr = q.contactChecks.map((c, k) => ({ c: q.contacts[k], e: c.handErrors[q.contacts[k].actor] }));
  const worst = Math.max(0, ...handErr.map((h) => h.e ?? 1));
  g('G10', 'Cause -> effect: contact happens and triggers the event', !has('CAUSALITY') && worst < 0.05, 'measured', handErr.map((h) => `${h.c.actor}.${h.c.action}@${h.c.t.toFixed(3)}s hand-to-target ${h.e === undefined ? 'n/a' : (h.e * 100).toFixed(1) + ' cm'}`).join('; ') + '; press/spawn causality validated');
  g('G11', 'Facial change at every information-change beat', !has('NO_FACIAL_REACTION'), 'static', v.findings.filter((f) => f.code === 'NO_FACIAL_REACTION').map((f) => f.message).join('; ') || 'every non-hook/loop information beat contains an expression change or emote');
  g('G12', 'Meaningful visual change every <= 1.5 s', v.metrics.maxStaleGap <= 1.5, 'static', `longest interval without a new cut/action/expression/prop/VFX event: ${v.metrics.maxStaleGap}s`);
  g('G13', `No shot > ${MAX_SHOT_SEC} s without a cut`, g13Pass(ep), 'static', `shot lengths: ${ep.shots.map((s) => (s.end - s.start).toFixed(2)).join(', ')}`);
  const biggest = [...q.impacts].sort((a, b) => b.strength - a.strength)[0];
  g('G14', 'Largest physical reversal in the final 3 s', !!biggest && biggest.t >= D - 3, 'measured', biggest ? `largest impact ${biggest.prop}:${biggest.kind} strength ${biggest.strength.toFixed(1)} at ${biggest.t.toFixed(2)}s (window starts ${D - 3}s)` : 'no impacts');
  const ld = q.loopDiff[0] ?? 1, ctrl = q.loopDiff[1] ?? 0;
  g('G15', 'Ending loops into the opening', ld < 0.06 && ep.shots[ep.shots.length - 1].preset === 'final_loop', 'measured', `decoded last-vs-first frame mean abs diff ${(ld * 100).toFixed(2)}% (a mid-episode control frame differs by ${(ctrl * 100).toFixed(2)}%)`);
  const lockedCast = ep.cast.every((c) => q.lib.hashes?.[`characters/${c.id}@${c.version}`]);
  g('G16', 'Character identity locked (versioned manifests + hash lock)', lockedCast, 'static', ep.cast.map((c) => `${c.id}@${c.version} sha256 ${(q.lib.hashes?.[`characters/${c.id}@${c.version}`] ?? 'MISSING').slice(0, 12)}`).join('; ') + '; episodes cannot contain appearance fields (strict schema)');
  g('G17', 'All assets licensed/owned with metadata', !has('UNLICENSED_ASSET') && !has('MISSING_ASSET'), 'static', 'every environment/character/prop/audio manifest carries license.source/author/license; all are original-procedural');
  const banned = findBannedTerms([ep.episode.title, ep.episode.logline, ...ep.beats.map((b) => b.summary)]);
  g('G18', 'No protected branding or third-party IP', banned.length === 0 && !ep.safety.usesThirdPartyBrands, 'static', banned.length ? `found: ${banned.join(', ')}` : 'banned-term scan clean; no external meshes/textures/sounds are loaded by the engine at all');
  g('G19', 'Family-safe (no gore/sexual/weapons/real-money giveaways)', ep.safety.familySafe && !ep.safety.realMoneyOrGiveawayClaims && banned.length === 0, 'static', ep.safety.notes);
  const all = q.analysis.flatMap((a) => a.issues);
  const counts: Record<string, number> = {};
  for (const i of all) counts[i.code] = (counts[i.code] ?? 0) + 1;
  const hard = all.filter((i) => HARD.has(i.code)).length;
  const soft = all.filter((i) => ['SUBJECT_OUTSIDE_ACTION_SAFE', 'FACE_TURNED_AWAY'].includes(i.code)).length;
  g('G20', 'Shot validation (screen-space bounds, face visibility, hand-vs-geometry penetration)', hard === 0 && soft <= q.analysis.length * 0.1, 'measured', `${q.analysis.length} sampled frames: hard issues ${hard}, soft issues ${soft}; ${JSON.stringify(counts)}`);
  // foot slip: planted foot horizontal speed while the actor is locomoting
  const slips: number[] = [];
  let airborneStance = 0, touchdownMax = 0, touchdownN = 0;
  for (let i = 2; i < q.probes.length; i++) for (const id of Object.keys(q.probes[i].actors)) {
    const z = q.probes[i - 2].actors[id], a = q.probes[i - 1].actors[id], b = q.probes[i].actors[id];
    // planted = the locomotion model's stance foot, held for >= 2 consecutive frames, measured in WORLD space.
    // The first frame after a stance switch is the touchdown (foot still arriving) and is reported separately.
    if (!a.stance || a.stance !== b.stance) continue;
    const s = b.stance === 'l' ? 'soleL' : 'soleR';
    const moving = Math.hypot(b.root[0] - a.root[0], b.root[2] - a.root[2]) * fps > 0.3;
    if (!moving) continue;
    if (b[s][1] >= 0.02) { airborneStance++; continue; }
    if (a[s][1] >= 0.02) continue;
    const v = Math.hypot(b[s][0] - a[s][0], b[s][2] - a[s][2]) * fps;
    if (z.stance !== a.stance) { touchdownN++; touchdownMax = Math.max(touchdownMax, v); continue; }
    slips.push(v);
  }
  slips.sort((a, b) => a - b);
  const p95 = slips.length ? slips[Math.floor(slips.length * 0.95)] : 0, med = slips.length ? slips[Math.floor(slips.length / 2)] : 0;
  g('G21', 'Planted feet do not slide during locomotion', med < 0.05 && p95 < 0.5, 'measured', `${slips.length} planted-foot samples while moving: median ${med.toFixed(3)} m/s, p95 ${p95.toFixed(3)} m/s vs root speed 1.2-2.7 m/s. Excluded: ${touchdownN} touchdown frames (max ${touchdownMax.toFixed(2)} m/s) and ${airborneStance} run flight-phase frames`);
  g('G22', 'Loudness normalised, no clipping', Math.abs(q.audio.integratedLufs - ep.audio.loudnessLufs) <= 1 && q.audio.truePeakDbfsApprox <= -1, 'measured', `integrated ${q.audio.integratedLufs} LUFS (target ${ep.audio.loudnessLufs}), approx true peak ${q.audio.truePeakDbfsApprox} dBFS, limiter max GR ${q.audio.limiterReductionDbMax} dB`);
  g('G23', 'Story readable while muted', v.ok && !has('STALE_STRETCH') && !has('CAUSALITY') && ep.beats.every((b) => ep.shots.some((s) => s.start < b.end && s.end > b.start)), 'proxy', 'PROXY ONLY: every beat has a shot, causal chain is on screen, emotes/expressions carry the reactions and no dialogue is needed. A human viewing test is still required to confirm comprehension.');

  const issuesByShot: Record<string, Record<string, number>> = {};
  for (const a of q.analysis) for (const i of a.issues) { const m = (issuesByShot[a.shot] ??= {}); const k = i.code + ((i as any).subject ? ':' + (i as any).subject : ''); m[k] = (m[k] ?? 0) + 1; }
  for (const x of gates) x.group ??= 'core';
  // production export gates (not part of the original 23)
  if (q.production) {
    gates.push({ id: 'P01', name: `Production export profile via ${q.production.tool} (H.264 yuv420p, CFR 30, AAC-LC 48 kHz stereo, fast-start${prof === 'final' ? ', 1080x1920' : ''})`, pass: q.production.ok, kind: 'measured', group: 'production', detail: q.production.checks.map((c) => `${c.ok ? 'ok' : 'FAIL'} ${c.name}=${c.got}`).join('; ') });
  }
  if (q.aacCheck) {
    const rt = q.aacCheck.roundTrip, al = q.aacCheck.containerAlignment;
    const ok = !al.error && Math.min(...rt.snrDb) >= 15 && Math.abs(al.lagSamples) <= 48 && Math.abs(al.decodedSamples - Math.round(q.ep.episode.duration * 48000)) <= 1024;
    gates.push({ id: 'P02', name: 'AAC decodes in an independent decoder and is sample-aligned with the source mix', pass: ok, kind: 'measured', group: 'production', detail: al.error ? `decode error: ${al.error}` : `Chromium AAC decoder SNR ${rt.snrDb.join('/')} dB vs source mix; MP4 decode (edit list applied) offset ${al.lagSamples} samples (${al.lagMs.toFixed(2)} ms), ${al.decodedSamples} samples decoded` });
  }
  // motion gates (not part of the original 23): continuous-time checks between video frames
  if (q.sweep) gates.push({ id: 'M01', name: 'Swept hand volume clear during locomotion onsets/arrivals (4 substeps per frame, 1 cm tolerance)', pass: q.sweep.length === 0, kind: 'measured', group: 'motion', detail: q.sweep.length ? q.sweep.slice(0, 4).map((i) => `${i.message} @${i.t.toFixed(3)}s`).join('; ') : 'no hand point entered a prop or collider by more than 1 cm between or on video frames' });
  for (const x of q.extraGates ?? []) gates.push({ ...x, group: x.group ?? 'story' });
  const vp: ValidationProfile = q.validationProfile ?? 'story-episode';
  for (const x of gates) {
    const na = vp === 'action-reel' && (STORY_ONLY_GATES.has(x.id) || x.group === 'story');
    if (na) { x.status = 'n/a'; x.pass = false; x.detail = `not applicable under validation profile action-reel (story-only gate). Measured anyway: ${x.detail}`; }
    else x.status = x.pass ? 'pass' : 'fail';
  }
  const applicable = gates.filter((x) => x.status !== 'n/a');
  const failed = applicable.filter((x) => !x.pass).map((x) => x.id);
  const groups: Record<string, { passed: number; total: number }> = {};
  for (const x of applicable) { const gg = (groups[x.group!] ??= { passed: 0, total: 0 }); gg.total++; if (x.pass) gg.passed++; }
  return {
    profile: prof,
    summary: { total: applicable.length, passed: applicable.length - failed.length, failed, notApplicable: gates.filter((x) => x.status === 'n/a').map((x) => x.id), validationProfile: vp, durationTargetSec: [dMin, dMax], groups },
    gates, frameIssues: counts, issuesByShot, motion: { footSlipMedian: med, footSlipP95: p95, samples: slips.length, teleports: tele },
    notes: [
      'Gates marked "proxy" approximate creative judgement and need human review.',
      'Frame issues are sampled every 3rd frame from the deterministic timeline before pixels are rendered.',
    ],
  };
}

export function qualityMarkdown(q: QualityReport, ep: Episode, log: any): string {
  const L: string[] = [];
  L.push(`# Quality report — ${ep.episode.title} (\`${ep.episode.id}\`)`, '');
  L.push(`**${q.summary.passed}/${q.summary.total} applicable gates passed** (${Object.entries(q.summary.groups).map(([k, v]) => `${k} ${v.passed}/${v.total}`).join(', ')}). ${q.summary.failed.length ? 'Failed: ' + q.summary.failed.join(', ') : 'No failures.'}`, '');
  L.push(`Validation profile: \`${q.summary.validationProfile}\`${q.summary.notApplicable.length ? ` — not applicable: ${q.summary.notApplicable.join(', ')}` : ''}. Duration target: ${q.summary.durationTargetSec.join('-')} s.`, '');
  if (q.profile !== 'final') L.push(`> **Diagnostic profile** (${log.resolution.join('x')}): low-resolution QA render — not a production output.`, '');
  L.push(`- Output: \`${log.mp4}\` — ${(log.bytes / 1e6).toFixed(2)} MB, sha256 \`${log.mp4Sha256}\``);
  L.push(`- ${log.resolution.join('x')} @ ${log.fps} fps, ${log.frames} frames; render ${log.timing.msPerFrame} ms/frame (${log.timing.realtimeFactor}x real-time), total ${log.timing.totalSec.toFixed(1)} s`);
  L.push(`- Renderer: ${log.host.glRenderer}; host ${log.host.cpus}x ${log.host.cpuModel}; GPU: ${log.host.gpu ? 'yes' : 'no (SwiftShader CPU)'}; audio codec: ${log.audioCodec ?? 'opus'}`, '');
  L.push('| Gate | Group | Result | Kind | Evidence |', '|---|---|---|---|---|');
  for (const g of q.gates) L.push(`| ${g.id} ${g.name} | ${g.group} | ${g.status === 'n/a' ? 'n/a' : g.pass ? 'PASS' : '**FAIL**'} | ${g.kind} | ${g.detail.replace(/\|/g, '/')} |`);
  L.push('', '## Notes', ...q.notes.map((n) => `- ${n}`), '');
  return L.join('\n');
}
