// Vignette staging pipeline (S6), end to end without pixels: beat sheet -> validation -> staging (world plan under the
// action contracts) -> multi-set scene -> per-beat camera recipes on camera safety -> script coverage -> analysis report.
// Browser-safe; node callers install the headless canvas first (headless.ts).
import { validateBeatSheet, type BeatSheet, type BeatSheetResult } from '../../director/src/beat-sheet.ts';
import type { ScreenDirectionState } from '../../engine/src/camera-safety.ts';
import type { ManifestLibrary } from '../../engine/src/build-dispatch.ts';
import { CAMERA_RECIPES, PLANNED_RECIPES } from './camera-recipes.ts';
import { beatSamples, sampleBeat, solveBeatCamera, type ShotChoice } from './camera.ts';
import { coverageCheck, type CoverageReport } from './coverage.ts';
import { VignetteScene } from './scene.ts';
import { stageBeatSheet, type StagePlan } from './stage.ts';

export const REPORT_SCHEMA = 'blockspark.vignette-analysis/1';

export interface VignetteOptions {
  /** narration phrases the sheet must cover one-to-one (validateBeatSheet) */
  phrases?: Array<{ id: string; start: number; end: number; text: string }>;
  /** implied-seated actors must be framed waist-up (camera safety WAIST_UP_REQUIRED). Default false: a planned `sit`
   *  is rendered as a labelled placeholder (standing pose + "ACTION SIT" label), not hidden by framing */
  waistUp?: boolean;
  onProgress?: (stage: string, done: number, total: number) => void;
}
export interface VignetteRun { validation: BeatSheetResult; stage: StagePlan; scene: VignetteScene; shots: Record<string, ShotChoice>; coverage: CoverageReport; report: VignetteReport }

export interface VignetteReport {
  schema: typeof REPORT_SCHEMA; sheetId: string; title: string; beats: number; duration: number;
  summary: { blocking: boolean; reasons: string[]; coveragePct: number; coverageThreshold: number; camerasAccepted: number; camerasFallback: number; camerasBlocked: number; stagingErrors: number; stagingWarnings: number; placeholders: number };
  validation: { ok: boolean; issues: BeatSheetResult['issues']; planned: Array<{ kind: string; id: string; uses: number }> };
  sets: Array<{ id: string; resolution: string; key: string; origin: number[]; marks: number; doors: string[]; dressing: string[]; notes: string[] }>;
  resolution: StagePlan['resolution'];
  sources: VignetteScene['sources'];
  staging: {
    contracts: StagePlan['contracts']; bridges: StagePlan['world']['bridges']; worldEvents: number; issues: StagePlan['issues'];
    beats: Array<{ beat: string; set: string; lighting: string; cast: Array<{ id: string; placement: string; action: string; played: string; contract: string; face: string; from: number[]; to: number[]; move: [number, number] | null; enterAt: number | null; exitAt: number | null; labels: string[] }>; props: Array<{ id: string; placement: string; state: string; pos: number[] }> }>;
  };
  cameras: { recipes: { planned: string[]; implemented: string[] }; beats: ShotChoice[] };
  coverage: CoverageReport;
}

const bare = (r: string) => r.split('@')[0];
const r3 = (v: readonly number[]) => v.map((x) => Math.round(x * 1000) / 1000);

export function runVignette(input: unknown, lib: ManifestLibrary, opts: VignetteOptions = {}): VignetteRun {
  const validation = validateBeatSheet(input, { ...(opts.phrases ? { phrases: opts.phrases } : {}) });
  if (!validation.value || validation.unknown.length || !validation.ok) {
    if (!validation.value) throw new Error(`beat sheet invalid: ${validation.issues.slice(0, 5).map((i) => `${i.path} ${i.message}`).join('; ')}`);
  }
  const sheet = validation.value as BeatSheet;
  opts.onProgress?.('stage', 0, 1);
  const stage = stageBeatSheet(sheet, lib);
  const scene = new VignetteScene(stage, lib);
  const shots: Record<string, ShotChoice> = {};
  let sd: ScreenDirectionState | undefined, prevSet: string | null = null;
  stage.beats.forEach((b, i) => {
    opts.onProgress?.('cameras', i, stage.beats.length);
    if (b.setId !== prevSet) sd = prevSet === null ? {} : { previousWasNeutral: true };
    const samples = sampleBeat(scene, b, beatSamples(b));
    const r = solveBeatCamera({ scene, beat: b, samples, screenDirection: sd, waistUp: opts.waistUp ?? false });
    shots[b.phraseId] = r.shot; sd = r.next; prevSet = b.setId;
  });
  opts.onProgress?.('coverage', 0, 1);
  const coverage = coverageCheck(scene, stage, shots);
  const report = buildReport(sheet, validation, stage, scene, shots, coverage);
  return { validation, stage, scene, shots, coverage, report };
}

function buildReport(sheet: BeatSheet, validation: BeatSheetResult, stage: StagePlan, scene: VignetteScene, shots: Record<string, ShotChoice>, coverage: CoverageReport): VignetteReport {
  const cams = Object.values(shots);
  const errs = stage.issues.filter((i) => i.severity === 'error'), warns = stage.issues.filter((i) => i.severity === 'warning');
  const reasons: string[] = [];
  if (!validation.ok) reasons.push(`beat sheet validation: ${validation.issues.length} issue(s)`);
  if (errs.length) reasons.push(`staging: ${errs.length} contract error(s) (${[...new Set(errs.map((e) => e.code))].join(', ')})`);
  const blocked = cams.filter((c) => c.source === 'blocked_best_effort');
  if (blocked.length) reasons.push(`camera safety blocked ${blocked.length} beat(s): ${blocked.map((c) => c.beat).join(', ')}`);
  if (coverage.blocking) reasons.push(`script coverage ${(coverage.pct * 100).toFixed(1)}% < ${(coverage.threshold * 100).toFixed(0)}%`);
  const placeholders = stage.resolution.filter((r) => r.resolution === 'placeholder').length + stage.beats.reduce((a, b) => a + b.cast.filter((c) => c.labels.length).length, 0);
  return {
    schema: REPORT_SCHEMA, sheetId: sheet.id, title: sheet.title, beats: stage.beats.length, duration: stage.duration,
    summary: {
      blocking: reasons.length > 0, reasons, coveragePct: coverage.pct, coverageThreshold: coverage.threshold,
      camerasAccepted: cams.filter((c) => c.source === 'recipe').length, camerasFallback: cams.filter((c) => c.source === 'fallback').length, camerasBlocked: blocked.length,
      stagingErrors: errs.length, stagingWarnings: warns.length, placeholders,
    },
    validation: { ok: validation.ok, issues: validation.issues, planned: validation.planned.map((p) => ({ kind: p.kind, id: p.id, uses: p.paths.length })) },
    sets: stage.sets.map((s) => ({ id: s.id, resolution: s.resolution, key: s.key, origin: s.origin, marks: Object.keys(s.marks).length, doors: Object.keys(s.doors), dressing: s.dressing.map((d) => `${d.instance}=${d.propRef}`), notes: s.notes })),
    resolution: stage.resolution, sources: scene.sources,
    staging: {
      contracts: stage.contracts, bridges: stage.world.bridges, worldEvents: stage.world.events.length, issues: stage.issues,
      beats: stage.beats.map((b) => ({
        beat: b.phraseId, set: b.setId, lighting: b.lighting,
        cast: b.cast.map((c) => ({ id: c.id, placement: c.placement, action: c.actionId, played: c.play.pose, contract: c.play.contract, face: c.face.applied === c.face.requested ? c.face.applied : `${c.face.requested}->${c.face.applied}`, from: r3(c.from), to: r3(c.to), move: c.moveT0 !== null ? [Math.round(c.moveT0 * 1000) / 1000, Math.round(c.moveT1! * 1000) / 1000] : null, enterAt: c.enterAt, exitAt: c.exitAt, labels: c.labels })),
        props: b.props.map((id) => { const s = stage.props[id].spans.find((x) => x.beat === b.phraseId)!; return { id, placement: s.target, state: s.state, pos: r3(s.pos) }; }),
      })),
    },
    cameras: { recipes: { planned: PLANNED_RECIPES, implemented: Object.keys(CAMERA_RECIPES) }, beats: cams },
    coverage,
  };
}

/** human-readable analysis report */
export function reportMarkdown(r: VignetteReport, stills: Record<string, string> = {}): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const L: string[] = [];
  L.push(`# Vignette staging analysis: ${r.title}`, '');
  L.push(`Sheet \`${r.sheetId}\`: ${r.beats} beats, ${r.duration.toFixed(2)} s, ${r.sets.length} set(s).`, '');
  L.push(`**Verdict: ${r.summary.blocking ? 'BLOCKED' : 'PASS'}**${r.summary.reasons.length ? ` (${r.summary.reasons.join('; ')})` : ''}`, '');
  L.push('| Check | Result |', '|---|---|');
  L.push(`| Beat sheet validation | ${r.validation.ok ? 'ok' : `${r.validation.issues.length} issue(s)`}; ${r.validation.planned.length} planned IDs |`);
  L.push(`| Staging contracts | ${r.summary.stagingErrors} error(s), ${r.summary.stagingWarnings} warning(s); contracts: ${Object.entries(r.staging.contracts.used).map(([k, v]) => `${k} x${v}`).join(', ')} |`);
  L.push(`| Cameras | ${r.summary.camerasAccepted} recipe, ${r.summary.camerasFallback} safety fallback, ${r.summary.camerasBlocked} blocked |`);
  L.push(`| Script coverage | ${pct(r.coverage.pct)} (${r.coverage.covered}/${r.coverage.visual} visual items; threshold ${pct(r.coverage.threshold)}; ${r.coverage.audioOnly} audio-only cues not counted) |`);
  L.push(`| Placeholders | ${r.summary.placeholders} (grey labelled blocks / labelled fallbacks) |`, '');
  L.push('## Sets', '', '| Set | Built from | Origin | Marks | Doors | Notes |', '|---|---|---|---|---|---|');
  for (const s of r.sets) L.push(`| ${s.id} | ${s.resolution === 'available' ? s.key : 'grey placeholder room'} | [${s.origin.join(', ')}] | ${s.marks} | ${s.doors.join(', ') || '-'} | ${s.notes.join('; ') || '-'} |`);
  L.push('', '## Beats', '', '| Beat | Set | Recipe | Intent | Camera | Min score | Coverage | Missing | Still |', '|---|---|---|---|---|---|---|---|---|');
  for (const b of r.cameras.beats) {
    const cb = r.coverage.beats.find((x) => x.beat === b.beat)!;
    const set = r.staging.beats.find((x) => x.beat === b.beat)!.set;
    L.push(`| ${b.beat} | ${set} | ${b.recipeId} | ${b.intent} | ${b.source === 'recipe' ? `recipe \`${b.candidateId.split(':')[1]}\`` : b.source === 'fallback' ? `fallback ${b.fallback}` : `**BLOCKED** (${Object.entries(b.samples.flatMap((s) => s.reasons).reduce<Record<string, number>>((a, x) => { const k = x.split(':')[0]; a[k] = (a[k] ?? 0) + 1; return a; }, {})).slice(0, 3).map(([k]) => k).join(', ')})`} | ${b.minScore.toFixed(3)} | ${pct(cb.pct)} (${cb.covered}/${cb.visual}) | ${cb.missing.join(', ') || '-'} | ${stills[b.beat] ? `![${b.beat}](${stills[b.beat]})` : '-'} |`);
  }
  L.push('', '## Staging per beat', '');
  for (const b of r.staging.beats) {
    L.push(`**${b.beat}** (${b.set}, ${b.lighting})`, '');
    for (const c of b.cast) L.push(`- ${c.id} @ ${c.placement}: ${c.action}${c.played !== c.action ? ` (played as ${c.contract}/${c.played})` : ''}, face ${c.face}${c.move ? `, moves ${c.move[0]}-${c.move[1]} s` : ''}${c.enterAt !== null ? `, enters ${c.enterAt} s` : ''}${c.exitAt !== null ? `, exits ${c.exitAt} s` : ''}${c.labels.length ? ` — label: ${c.labels.join(' / ')}` : ''}`);
    for (const p of b.props) L.push(`- prop ${p.id} @ ${p.placement} (${p.state}) [${p.pos.join(', ')}]`);
    L.push('');
  }
  const iss = r.staging.issues.filter((i) => i.severity !== 'info');
  L.push('## Staging issues', '', iss.length ? '| Severity | Code | Beat | Message |\n|---|---|---|---|' : 'None.');
  for (const i of iss) L.push(`| ${i.severity} | ${i.code} | ${i.beat ?? '-'} | ${i.message.replace(/\|/g, '/')} |`);
  L.push('', '## Placeholders and fallbacks', '', '| Kind | ID | Status | Rendered as |', '|---|---|---|---|');
  for (const x of r.resolution.filter((x) => x.resolution !== 'available')) L.push(`| ${x.kind} | ${x.id} | ${x.status} | ${x.source}${x.note ? ` (${x.note})` : ''} |`);
  const info = r.staging.issues.filter((i) => i.severity === 'info' && /FALLBACK|PLACEHOLDER|LOOK_AT_CAMERA/.test(i.code));
  for (const i of info) L.push(`| ${i.code.toLowerCase()} | ${i.entity ?? '-'} | ${i.beat} | ${i.message.replace(/\|/g, '/')} |`);
  L.push('', '## Coverage misses', '', '| Beat | Item | Seen / samples | Note |', '|---|---|---|---|');
  for (const i of r.coverage.items.filter((x) => x.counted && !x.covered)) L.push(`| ${i.beat} | ${i.kind}: ${i.label} | ${i.seen}/${i.samples} | ${i.reason ?? ''} |`);
  L.push('');
  return L.join('\n');
}

export { bare };
