// Quality gates evaluated after the analysis + render passes. Each gate states its evidence and whether it is
// a direct measurement or a proxy (some creative criteria cannot be measured automatically).
import type { Episode } from '../../schema/src/episode.ts';
import type { ValidationResult, Lib } from './validate.ts';
import { findBannedTerms } from './validate.ts';

export interface Gate { id: string; name: string; pass: boolean; kind: 'measured' | 'proxy' | 'static'; detail: string }
export interface QualityReport { summary: { total: number; passed: number; failed: string[] }; gates: Gate[]; frameIssues: Record<string, number>; issuesByShot: Record<string, Record<string, number>>; motion: Record<string, unknown>; notes: string[] }

export interface QualityInput {
  ep: Episode; validation: ValidationResult; analysis: Array<{ t: number; shot: string; issues: Array<{ code: string; message: string }>; handErrors: Record<string, number> }>;
  contactChecks: Array<{ t: number; handErrors: Record<string, number> }>; probes: any[]; contacts: Array<{ actor: string; action: string; t: number }>;
  impacts: Array<{ prop: string; t: number; kind: string; strength: number }>; inspect: any; playback: any; loopDiff: number[]; audio: any; lib: Lib & { hashes?: Record<string, string> }; timing: any; fps: number;
}

const HARD = new Set(['SUBJECT_OUT_OF_FRAME', 'SUBJECT_BEHIND_CAMERA', 'FACE_OUT_OF_FRAME', 'FACE_OCCLUDED']);

export function buildQualityReport(q: QualityInput): QualityReport {
  const { ep, validation: v, fps } = q;
  const D = ep.episode.duration, N = Math.round(D * fps);
  const gates: Gate[] = [];
  const g = (id: string, name: string, pass: boolean, kind: Gate['kind'], detail: string) => gates.push({ id, name, pass, kind, detail });
  const has = (code: string) => v.findings.some((f) => f.code === code && f.severity !== 'info');
  const vt = q.inspect?.tracks?.find((t: any) => t.handler === 'vide');
  const at = q.inspect?.tracks?.find((t: any) => t.handler === 'soun');

  g('G01', 'Playable MP4 produced automatically (no screen recording)', !!q.playback?.ok, 'measured', q.playback ? `Chromium decoded ${q.playback.framesDecodedDuringPlay} frames in ${q.playback.playedSeconds.toFixed(2)}s real-time playback, ${q.playback.droppedFrames} dropped; errors: ${q.playback.errors.join('; ') || 'none'}` : 'verification skipped');
  g('G02', 'Resolution 1080x1920', vt?.width === 1080 && vt?.height === 1920 && q.playback?.videoWidth === 1080, 'measured', `container ${vt?.width}x${vt?.height}, decoded ${q.playback?.videoWidth}x${q.playback?.videoHeight}`);
  g('G03', 'Duration 14-18 s', vt && vt.durationSec >= 14 && vt.durationSec <= 18, 'measured', `video ${vt?.durationSec.toFixed(3)}s, audio ${at?.durationSec?.toFixed(3)}s (incl. ${at?.editMediaTime ?? 0}-sample Opus pre-skip)`);
  const durs = new Set(vt?.sampleDurations ?? []);
  g('G04', 'Stable frame rate', vt?.sampleCount === N && durs.size === 1, 'measured', `${vt?.sampleCount} samples (expected ${N}), unique sample durations ${[...durs].join(',')} @ timescale ${vt?.timescale} => ${vt ? (vt.timescale / ([...durs][0] as number)).toFixed(3) : '?'} fps constant`);
  const audioDurErr = at && vt ? Math.abs((at.duration - (at.editMediaTime ?? 0)) / at.timescale - vt.durationSec) : 99;
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
  g('G13', 'No shot > 3 s without a cut', !has('SHOT_TOO_LONG'), 'static', `shot lengths: ${ep.shots.map((s) => (s.end - s.start).toFixed(2)).join(', ')}`);
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
  g('G20', 'Shot validation (projected screen-space bounds)', hard === 0 && soft <= q.analysis.length * 0.1, 'measured', `${q.analysis.length} sampled frames: hard issues ${hard}, soft issues ${soft}; ${JSON.stringify(counts)}`);
  // foot slip: planted foot horizontal speed while the actor is locomoting
  const slips: number[] = [];
  let airborneStance = 0;
  for (let i = 1; i < q.probes.length; i++) for (const id of Object.keys(q.probes[i].actors)) {
    const a = q.probes[i - 1].actors[id], b = q.probes[i].actors[id];
    // measure the foot the locomotion model has planted, in WORLD space, over consecutive frames of the same stance
    if (!a.stance || a.stance !== b.stance) continue;
    const s = b.stance === 'l' ? 'soleL' : 'soleR';
    const moving = Math.hypot(b.root[0] - a.root[0], b.root[2] - a.root[2]) * fps > 0.3;
    if (moving && b[s][1] < 0.02) slips.push(Math.hypot(b[s][0] - a[s][0], b[s][2] - a[s][2]) * fps);
    if (moving && b[s][1] >= 0.02) airborneStance++;
  }
  slips.sort((a, b) => a - b);
  const p95 = slips.length ? slips[Math.floor(slips.length * 0.95)] : 0, med = slips.length ? slips[Math.floor(slips.length / 2)] : 0;
  g('G21', 'Planted feet do not slide during locomotion', p95 < 0.3, 'measured', `${slips.length} planted-foot samples while moving: median ${med.toFixed(3)} m/s, p95 ${p95.toFixed(3)} m/s vs root speed 1.2-2.7 m/s; ${airborneStance} stance samples in run flight phase`);
  g('G22', 'Loudness normalised, no clipping', Math.abs(q.audio.integratedLufs - ep.audio.loudnessLufs) <= 1 && q.audio.truePeakDbfsApprox <= -1, 'measured', `integrated ${q.audio.integratedLufs} LUFS (target ${ep.audio.loudnessLufs}), approx true peak ${q.audio.truePeakDbfsApprox} dBFS, limiter max GR ${q.audio.limiterReductionDbMax} dB`);
  g('G23', 'Story readable while muted', v.ok && !has('STALE_STRETCH') && !has('CAUSALITY') && ep.beats.every((b) => ep.shots.some((s) => s.start < b.end && s.end > b.start)), 'proxy', 'PROXY ONLY: every beat has a shot, causal chain is on screen, emotes/expressions carry the reactions and no dialogue is needed. A human viewing test is still required to confirm comprehension.');

  const issuesByShot: Record<string, Record<string, number>> = {};
  for (const a of q.analysis) for (const i of a.issues) { const m = (issuesByShot[a.shot] ??= {}); const k = i.code + ((i as any).subject ? ':' + (i as any).subject : ''); m[k] = (m[k] ?? 0) + 1; }
  const failed = gates.filter((x) => !x.pass).map((x) => x.id);
  return {
    summary: { total: gates.length, passed: gates.length - failed.length, failed },
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
  L.push(`**${q.summary.passed}/${q.summary.total} gates passed.** ${q.summary.failed.length ? 'Failed: ' + q.summary.failed.join(', ') : 'No failures.'}`, '');
  L.push(`- Output: \`${log.mp4}\` — ${(log.bytes / 1e6).toFixed(2)} MB, sha256 \`${log.mp4Sha256}\``);
  L.push(`- ${log.resolution.join('x')} @ ${log.fps} fps, ${log.frames} frames; render ${log.timing.msPerFrame} ms/frame (${log.timing.realtimeFactor}x real-time), total ${log.timing.totalSec.toFixed(1)} s`);
  L.push(`- Renderer: ${log.host.glRenderer}; host ${log.host.cpus}x ${log.host.cpuModel}; GPU: ${log.host.gpu ? 'yes' : 'no (SwiftShader CPU)'}`, '');
  L.push('| Gate | Result | Kind | Evidence |', '|---|---|---|---|');
  for (const g of q.gates) L.push(`| ${g.id} ${g.name} | ${g.pass ? 'PASS' : '**FAIL**'} | ${g.kind} | ${g.detail.replace(/\|/g, '/')} |`);
  L.push('', '## Notes', ...q.notes.map((n) => `- ${n}`), '');
  return L.join('\n');
}
