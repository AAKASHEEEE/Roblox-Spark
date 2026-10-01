// Vignette staging pipeline (S6), end to end without pixels: beat sheet -> validation -> staging (world plan under the
// action contracts) -> multi-set scene -> per-beat camera recipes on camera safety -> script coverage -> analysis report.
// Browser-safe; node callers install the headless canvas first (headless.ts).
import { validateBeatSheet, type BeatSheet, type BeatSheetResult } from '../../director/src/beat-sheet.ts';
import type { ScreenDirectionState } from '../../engine/src/camera-safety.ts';
import type { ManifestLibrary } from '../../engine/src/build-dispatch.ts';
import type { Library } from '../../library/src/ids.ts';
import { CAMERA_RECIPES, PLANNED_RECIPES } from './camera-recipes.ts';
import { beatSamples, compositionAt, heldCompositionAt, sampleBeat, solveBeatCamera, type CameraComposition, type HeldCameraComposition, type ShotChoice } from './camera.ts';
import { coverageCheck, type CoverageReport } from './coverage.ts';
import { VignetteScene } from './scene.ts';
import { registerRuntimeLibrary } from './runtime-library.ts';
import { stageBeatSheet, type StagePlan, type StagedBeat } from './stage.ts';

export const REPORT_SCHEMA = 'blockspark.vignette-analysis/1';

export interface VignetteOptions {
  /** narration phrases the sheet must cover one-to-one (validateBeatSheet) */
  phrases?: Array<{ id: string; start: number; end: number; text: string }>;
  /** Optional semantic library override; validation and staging use the same availability catalog. */
  library?: Library;
  /** implied-seated actors must be framed waist-up (camera safety WAIST_UP_REQUIRED). Default false: a planned `sit`
   *  is rendered as a labelled placeholder (standing pose + "ACTION SIT" label), not hidden by framing */
  waistUp?: boolean;
  onProgress?: (stage: string, done: number, total: number) => void;
}
/** one composition of a beat: a time window and its solved shot. A beat with no sub-shots has exactly one. */
export type Composition = CameraComposition;
export interface VignetteRun {
  validation: BeatSheetResult; stage: StagePlan; scene: VignetteScene; shots: Record<string, ShotChoice>;
  /** every composition of every beat in play order (beat.camera first, then camera.subShots). One caption band per entry. */
  compositions: Composition[];
  /** Canonical bounded lookup; returns undefined in inter-beat gaps and outside the timeline. */
  compositionAt(t: number): Composition | undefined;
  /** Render lookup: first/previous/final composition deterministically owns leading pad, gaps, and output tail. */
  renderCompositionAt(t: number): HeldCameraComposition | undefined;
  coverage: CoverageReport; report: VignetteReport;
}

export interface VignetteReport {
  schema: typeof REPORT_SCHEMA; sheetId: string; title: string; beats: number; compositions: number; duration: number;
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

export class VignetteValidationError extends Error {
  readonly validation: BeatSheetResult;
  constructor(message: string, validation: BeatSheetResult) { super(message); this.name = 'VignetteValidationError'; this.validation = validation; }
}

function cameraRecipeUses(sheet: BeatSheet): Array<{ beat: string; index: number; id: string; path: string }> {
  return sheet.beats.flatMap((b, bi) => [b.camera, ...(b.camera.subShots ?? [])].map((c, index) => ({
    beat: b.phraseId, index, id: c.recipeId,
    path: index === 0 ? `$.beats[${bi}].camera.recipeId` : `$.beats[${bi}].camera.subShots[${index - 1}].recipeId`,
  })));
}

export function runVignette(input: unknown, lib: ManifestLibrary, opts: VignetteOptions = {}): VignetteRun {
  const validation = validateBeatSheet(input, {
    ...(opts.library ? { library: opts.library } : {}),
    ...(opts.phrases ? { phrases: opts.phrases } : {}),
  });
  const unavailable = validation.planned.filter((p) => p.kind === 'cameraRecipes');
  if (!validation.value || !validation.ok || validation.unknown.length || unavailable.length) {
    const details = [
      ...validation.issues.slice(0, 8).map((i) => `${i.path} ${i.message}`),
      ...unavailable.map((p) => `${p.paths[0]} camera recipe "${p.id}" is planned, not available`),
    ];
    throw new VignetteValidationError(`beat sheet rejected before staging: ${details.join('; ') || 'invalid input'}`, validation);
  }
  const sheet = validation.value;
  const unresolved = cameraRecipeUses(sheet).filter((u) => !CAMERA_RECIPES[u.id] || CAMERA_RECIPES[u.id].planned);
  if (unresolved.length) {
    throw new VignetteValidationError(`beat sheet rejected before staging: ${unresolved.map((u) => `${u.path} camera recipe "${u.id}" has no available runtime implementation`).join('; ')}`, validation);
  }
  // Activate the exact locked S3 character recipes and S4 prop rigs only after semantic/camera preflight succeeds.
  registerRuntimeLibrary(lib);
  opts.onProgress?.('stage', 0, 1);
  let stage: StagePlan;
  try {
    stage = stageBeatSheet(sheet, lib, opts.library ? { library: opts.library } : {});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`vignette staging failed closed: ${message}`);
  }
  const scene = new VignetteScene(stage, lib);
  const shots: Record<string, ShotChoice> = {};
  const compositions: Composition[] = [];
  let sd: ScreenDirectionState | undefined, prevSet: string | null = null, prevPrimary: string | null = null, prevCameraTargets: string[] = [];
  stage.beats.forEach((b, i) => {
    opts.onProgress?.('cameras', i, stage.beats.length);
    const currentCameraTargets = [b.camera.subject, ...(b.camera.secondary ? [b.camera.secondary] : [])];
    if (b.setId !== prevSet) sd = prevSet === null ? {} : { previousWasNeutral: true };
    else if (prevPrimary && !b.cast.some((c) => c.id === prevPrimary) && !b.props.includes(prevPrimary)) {
      // The previous primary has left the scene, so this beat establishes a new action axis. Carrying the old side
      // across unrelated actor pairs produces a false 180-degree reversal (teacher exit -> Zapp/Kira scene).
      sd = { previousWasNeutral: true };
    } else if ((prevCameraTargets.length > 1 || currentCameraTargets.length > 1) && prevCameraTargets.filter((id) => currentCameraTargets.includes(id)).length < 2) {
      // A two-entity action axis only survives an edit when both authored endpoints survive. A single-to-pair or changed
      // secondary establishes a new axis; retaining a side label from the old pair would manufacture a false reversal.
      sd = { previousWasNeutral: true };
    } else if (prevPrimary && prevPrimary !== b.camera.subject && prevPrimary !== b.camera.secondary && b.cast.some((c) => c.id === b.camera.subject && c.placementKind === 'enter')) {
      // This beat's hero enters the scene (a new action axis): the carried side belongs to the previous hero, so
      // resetting avoids a false 180-degree reversal when the entering hero appears on the opposite side.
      sd = { previousWasNeutral: true };
    }
    // Compositions of the beat: the beat's own camera, then each camera.subShots entry, split at the sub-shot cut
    // times. Each composition is solved as its own shot on camera safety over just its window (a hard cut between
    // them); screen direction still carries continuously so no cut breaks the 180-degree line.
    const cuts = [b.start, ...(b.camera.subShots?.map((s) => s.from) ?? []), b.end];
    const cams = [b.camera, ...(b.camera.subShots ?? [])];
    // Screen direction threads every chronological composition and the FINAL composition is authoritative at the
    // next beat boundary. Carrying composition zero would skip the real final edit and permit an unmotivated reversal.
    let intraSd = sd, prevCompSubject: string | null = prevPrimary;
    cams.forEach((cam, ci) => {
      const cStart = cuts[ci], cEnd = cuts[ci + 1];
      // A sub-shot cut that changes the action axis (the previous composition's subject is neither this composition's
      // subject nor secondary) resets screen direction, exactly as a beat cut does: carrying the old side across an
      // unrelated pair produces a false 180-degree reversal (e.g. the teacher-exit wide -> a Zapp/Kira two-shot).
      if (ci > 0 && prevCompSubject && prevCompSubject !== cam.subject && prevCompSubject !== cam.secondary) intraSd = { previousWasNeutral: true };
      const wb: StagedBeat = { ...b, start: cStart, end: cEnd, camera: { recipeId: cam.recipeId, subject: cam.subject, ...(cam.secondary !== undefined ? { secondary: cam.secondary } : {}) }, keyTimes: b.keyTimes.filter((t) => t >= cStart - 1e-6 && t <= cEnd + 1e-6) };
      const samples = sampleBeat(scene, wb, beatSamples(wb));
      const r = solveBeatCamera({ scene, beat: wb, samples, screenDirection: intraSd, waistUp: opts.waistUp ?? false });
      if (!r.shot.recipeKnown) throw new Error(`camera recipe resolution failed closed for ${b.phraseId}[${ci}]: ${cam.recipeId}`);
      intraSd = r.next; prevCompSubject = cam.subject;
      if (ci === 0) shots[b.phraseId] = r.shot;
      compositions.push({ beat: b.phraseId, index: ci, start: cStart, end: cEnd, subject: cam.subject, ...(cam.secondary !== undefined ? { secondary: cam.secondary } : {}), shot: r.shot });
    });
    sd = intraSd; prevSet = b.setId;
    const finalCamera = cams[cams.length - 1];
    prevPrimary = finalCamera?.subject ?? null;
    prevCameraTargets = finalCamera ? [finalCamera.subject, ...(finalCamera.secondary ? [finalCamera.secondary] : [])] : [];
  });
  opts.onProgress?.('coverage', 0, 1);
  const coverage = coverageCheck(scene, stage, compositions);
  const report = buildReport(sheet, validation, stage, scene, compositions, coverage);
  return {
    validation, stage, scene, shots, compositions,
    compositionAt: (t) => compositionAt(compositions, t),
    renderCompositionAt: (t) => heldCompositionAt(compositions, t),
    coverage, report,
  };
}

export interface CompositionCameraSummary {
  accepted: number; fallback: number; blocked: number;
  blockedCompositions: Array<{ beat: string; index: number; shot: ShotChoice }>;
}

/** Camera report accounting is composition-based; every intra-beat cut participates in blocking and fallback totals. */
export function summarizeCompositionCameras(compositions: readonly Composition[]): CompositionCameraSummary {
  const isBlocked = (c: Composition) => !c.shot.recipeKnown || !c.shot.accepted || c.shot.source === 'blocked_best_effort';
  const blockedCompositions = compositions.filter(isBlocked).map((c) => ({ beat: c.beat, index: c.index, shot: c.shot }));
  return {
    accepted: compositions.filter((c) => !isBlocked(c) && c.shot.source === 'recipe').length,
    fallback: compositions.filter((c) => !isBlocked(c) && c.shot.source === 'fallback').length,
    blocked: blockedCompositions.length,
    blockedCompositions,
  };
}

function buildReport(sheet: BeatSheet, validation: BeatSheetResult, stage: StagePlan, scene: VignetteScene, compositions: readonly Composition[], coverage: CoverageReport): VignetteReport {
  const cams = compositions.map((c) => c.shot);
  const cameraSummary = summarizeCompositionCameras(compositions);
  const errs = stage.issues.filter((i) => i.severity === 'error'), warns = stage.issues.filter((i) => i.severity === 'warning');
  const reasons: string[] = [];
  if (!validation.ok) reasons.push(`beat sheet validation: ${validation.issues.length} issue(s)`);
  if (errs.length) reasons.push(`staging: ${errs.length} contract error(s) (${[...new Set(errs.map((e) => e.code))].join(', ')})`);
  if (cameraSummary.blocked) reasons.push(`camera safety blocked ${cameraSummary.blocked} composition(s): ${cameraSummary.blockedCompositions.map((c) => `${c.beat}[${c.index}]`).join(', ')}`);
  if (coverage.blocking) reasons.push(`script coverage ${(coverage.pct * 100).toFixed(1)}% < ${(coverage.threshold * 100).toFixed(0)}%`);
  const placeholders = stage.resolution.filter((r) => r.resolution === 'placeholder').length + stage.beats.reduce((a, b) => a + b.cast.filter((c) => c.labels.length).length, 0);
  return {
    schema: REPORT_SCHEMA, sheetId: sheet.id, title: sheet.title, beats: stage.beats.length, compositions: compositions.length, duration: stage.duration,
    summary: {
      blocking: reasons.length > 0, reasons, coveragePct: coverage.pct, coverageThreshold: coverage.threshold,
      camerasAccepted: cameraSummary.accepted, camerasFallback: cameraSummary.fallback, camerasBlocked: cameraSummary.blocked,
      stagingErrors: errs.length, stagingWarnings: warns.length, placeholders,
    },
    validation: { ok: validation.ok, issues: validation.issues, planned: validation.planned.map((p) => ({ kind: p.kind, id: p.id, uses: p.paths.length })) },
    sets: stage.sets.map((s) => ({ id: s.id, resolution: s.resolution, key: s.key, origin: s.origin, marks: Object.keys(s.marks).length, doors: Object.keys(s.doors), dressing: s.dressing.map((d) => `${d.instance}=${d.propRef}`), notes: s.notes })),
    resolution: stage.resolution, sources: scene.sources,
    staging: {
      contracts: stage.contracts, bridges: stage.world.bridges, worldEvents: stage.world.events.length, issues: stage.issues,
      beats: stage.beats.map((b) => ({
        beat: b.phraseId, set: b.setId, lighting: b.lighting,
        cast: b.cast.map((c) => ({ id: c.id, placement: c.placement, action: c.actionId, played: c.play.runtime === 'fallback' ? c.play.pose : c.actionId, contract: c.play.contract, face: c.face.applied === c.face.requested ? c.face.applied : `${c.face.requested}->${c.face.applied}`, from: r3(c.from), to: r3(c.to), move: c.moveT0 !== null ? [Math.round(c.moveT0 * 1000) / 1000, Math.round(c.moveT1! * 1000) / 1000] : null, enterAt: c.enterAt, exitAt: c.exitAt, labels: c.labels })),
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
  L.push(`Sheet \`${r.sheetId}\`: ${r.beats} beats, ${r.compositions} camera compositions, ${r.duration.toFixed(2)} s, ${r.sets.length} set(s).`, '');
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

export { bare, compositionAt };
