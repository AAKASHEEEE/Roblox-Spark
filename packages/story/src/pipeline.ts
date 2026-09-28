// Stage G — orchestration: idea -> A normalize -> B beats -> C compatibility -> D staging -> E shots -> F compile ->
// validate (strict validator + story gates + optional browser analysis) -> structured repair (max 3) -> accept/reject.
// Every provider response is schema-validated; nothing from a provider is ever executed.
import { validateEpisode, type Lib } from '../../pipeline/src/validate.ts';
import type { Episode } from '../../schema/src/episode.ts';
import { checkCompatibility, ideaSafetyNet } from './compat.ts';
import { compileEpisode, type FitKnobs, type KeyEvent } from './compile.ts';
import { fitCompile } from './fit.ts';
import { storyGates, mutedStoryScore, type AnalysisLite, type StoryGate } from './gates.ts';
import type { StoryModelProvider, CallMeta } from './providers/types.ts';
import { ProviderError } from './providers/types.ts';
import type { Registry } from './registry.ts';
import { beatPlanSchema, normalizedIdeaSchema, RepairResponseSchema, StoryRequestSchema, type NormalizedIdea, type Patch, type RepairConstraint, type StoryRequest, type VisualBeatPlan, PATCH_FIELDS } from './schemas.ts';
import { stagePlan, type StagingPlan } from './stage.ts';
import { TEMPLATES } from './templates.ts';

export interface Analyzer {
  analyze(ep: Episode): Promise<{ analysis: AnalysisLite; issues: Array<{ t: number; shot: string; code: string; message: string; subject?: string }>; metrics: Record<string, number> }>;
}
export interface GenerateDeps {
  provider: StoryModelProvider; registry: Registry; lib: Lib & { hashes?: Record<string, string> }; analyzer?: Analyzer | null; maxRepairs?: number; sha256?: (s: string) => string;
  /** profile-aware fit pass (fit.ts, headless engine). Default on; false only for tests of the plan/repair protocol itself */
  fit?: boolean;
}
/** compact fit record kept per attempt (knobs replay the compile exactly) */
export interface FitSummary { knobs: FitKnobs; decisions: string[]; residual: string[]; warnings: number; clearance: { enforced: number; reported: number }; framingFitted: string[]; ms: number }

export interface Attempt {
  n: number;
  kind: 'initial' | 'repair';
  plan: VisualBeatPlan | null;
  staging?: StagingPlan;
  compiled: boolean;
  episodeSha256?: string;
  constraints: RepairConstraint[];
  validatorErrors: string[];
  validatorWarnings: string[];
  gates: StoryGate[];
  analysis?: { hardIssues: number; softIssues: number; frames: number; byCode: Record<string, number>; metrics: Record<string, number> };
  fit?: FitSummary | null;
  patchesApplied: Patch[];
  patchesRejected: Array<{ patch: unknown; reason: string }>;
  accepted: boolean;
  ms: number;
}
export interface GenerationRecord {
  request: StoryRequest;
  provider: { name: string; model: string };
  status: 'accepted' | 'rejected' | 'failed';
  rejection: { category: string; reason: string; also?: Array<{ category: string; reason: string }> } | null;
  failure: string | null;
  normalized: NormalizedIdea | null;
  plan: VisualBeatPlan | null;
  substitutions: NormalizedIdea['substitutions'];
  warnings: string[];
  schemaEvents: Array<{ stage: string; ok: boolean; issues: string[] }>;
  attempts: Attempt[];
  repairs: number;
  episode: Episode | null;
  /** last compiled (possibly rejected) episode, for diagnostics only — never rendered as a deliverable */
  lastCompiled: Episode | null;
  episodeSha256: string | null;
  /** fit knobs of the accepted episode (null = unfitted) */
  fitKnobs: FitKnobs | null;
  events: KeyEvent[];
  gates: StoryGate[];
  mutedStoryScore: number | null;
  calls: CallMeta[];
  latencyMs: number;
  tokens: { in: number; out: number };
}

const HARD = new Set(['SUBJECT_OUT_OF_FRAME', 'SUBJECT_BEHIND_CAMERA', 'FACE_OUT_OF_FRAME', 'FACE_OCCLUDED', 'HAND_PENETRATION', 'HAND_SWEEP_PENETRATION', 'CAMERA_IN_PROP', 'BODY_PROP_INTERSECTION', 'ACTOR_OVERLAP', 'PROP_OCCLUDED']);
const SOFT = new Set(['SUBJECT_OUTSIDE_ACTION_SAFE', 'FACE_TURNED_AWAY']);

/** apply only patches that address a listed constraint (beatId + field), everything else is rejected */
export function applyPatches(plan: VisualBeatPlan, patches: Patch[], cons: RepairConstraint[]): { plan: VisualBeatPlan; applied: Patch[]; rejected: Array<{ patch: unknown; reason: string }> } {
  const out: VisualBeatPlan = JSON.parse(JSON.stringify(plan));
  const allowed = new Set(cons.filter((c) => c.beatId && c.field).map((c) => `${c.beatId}:${c.field}`));
  const planFields = new Set(cons.filter((c) => c.field === 'stagingVariant').map(() => 'stagingVariant'));
  const applied: Patch[] = [], rejected: Array<{ patch: unknown; reason: string }> = [];
  for (const p of patches) {
    if (p.op === 'set_plan') { if (planFields.has(p.field) || cons.some((c) => c.code.startsWith('BODY') || c.code === 'PATH_BLOCKED' || c.code === 'ACTOR_OVERLAP' || c.code === 'FACE_OCCLUDED')) { out.stagingVariant = p.value; applied.push(p); } else rejected.push({ patch: p, reason: 'no staging constraint requested this change' }); continue; }
    if (p.op === 'set_role') { if (cons.some((c) => c.code === 'ROLE_VICTIM')) { out.roles.victim = p.value; applied.push(p); } else rejected.push({ patch: p, reason: 'no role constraint' }); continue; }
    if (p.op === 'remove_beat') { rejected.push({ patch: p, reason: 'beat removal is not permitted by the repair protocol' }); continue; }
    const key = `${p.beatId}:${p.field}`;
    if (!allowed.has(key)) { rejected.push({ patch: p, reason: `field ${key} not named by any constraint` }); continue; }
    if (!(PATCH_FIELDS as readonly string[]).includes(p.field)) { rejected.push({ patch: p, reason: 'field not patchable' }); continue; }
    const b = out.beats.find((x) => x.id === p.beatId);
    if (!b) { rejected.push({ patch: p, reason: 'unknown beat' }); continue; }
    (b as Record<string, unknown>)[p.field] = p.value;
    applied.push(p);
  }
  return { plan: out, applied, rejected };
}

function constraintsFromValidator(ep: Episode, plan: VisualBeatPlan, findings: Array<{ severity: string; code: string; message: string; path?: string }>): RepairConstraint[] {
  const beatAt = (t: number) => ep.beats.find((b) => t >= b.start && t < b.end)?.id ?? null;
  return findings.filter((f) => f.severity === 'error').map((f) => {
    const m = /(@|at |after t=)(\d+(\.\d+)?)/.exec(f.message);
    const beatId = m ? beatAt(Number(m[2])) : null;
    const field = f.code === 'STALE_STRETCH' || f.code === 'TIMELINE_OVERLAP' || f.code === 'IMPOSSIBLE_ACTION' || f.code === 'REVERSAL_TOO_EARLY' ? 'approxDuration' : f.code.startsWith('SHOT') ? 'shotHint' : null;
    void plan;
    return { code: f.code, message: f.message, beatId, field, source: 'validator' as const };
  });
}

function constraintsFromAnalysis(ep: Episode, plan: VisualBeatPlan, issues: Array<{ t: number; shot: string; code: string; message: string; subject?: string }>): RepairConstraint[] {
  const out: RepairConstraint[] = [];
  const shotBeat = (shotId: string) => { const s = ep.shots.find((x) => x.id === shotId); return s ? ep.beats.find((b) => s.start >= b.start - 1e-6 && s.start < b.end)?.id ?? null : null; };
  const byKey = new Map<string, { n: number; i: (typeof issues)[number] }>();
  for (const i of issues) {
    if (!HARD.has(i.code) && !SOFT.has(i.code)) continue;
    const k = `${i.code}:${i.shot}:${i.subject ?? ''}`;
    const e = byKey.get(k); if (e) e.n++; else byKey.set(k, { n: 1, i });
  }
  const shotsByFrames = new Map<string, number>();
  for (const s of ep.shots) shotsByFrames.set(s.id, Math.max(1, Math.round(((s.end - s.start) * 30) / 3)));
  for (const { n, i } of byKey.values()) {
    const frac = n / (shotsByFrames.get(i.shot) ?? 1);
    if (SOFT.has(i.code) && frac < 0.34) continue; // tolerate brief soft issues
    const beatId = shotBeat(i.shot);
    const staging = ['BODY_PROP_INTERSECTION', 'ACTOR_OVERLAP', 'HAND_PENETRATION', 'HAND_SWEEP_PENETRATION'].includes(i.code);
    const shotPreset = ep.shots.find((s) => s.id === i.shot)?.preset;
    out.push({ code: i.code, message: `${i.message} (${n} sampled frames in ${i.shot})`, beatId: staging ? plan.beats[0].id : beatId, field: staging ? 'stagingVariant' : 'shotHint', disallow: staging ? undefined : [shotPreset], source: 'analysis' });
  }
  return out;
}

export async function generateEpisode(requestIn: unknown, deps: GenerateDeps): Promise<GenerationRecord> {
  const T0 = performance.now();
  const { provider, registry: reg } = deps;
  const maxRepairs = deps.maxRepairs ?? 3;
  const rec: GenerationRecord = { request: requestIn as StoryRequest, provider: { name: provider.name, model: provider.model }, status: 'failed', rejection: null, failure: null, normalized: null, plan: null, substitutions: [], warnings: [], schemaEvents: [], attempts: [], repairs: 0, episode: null, lastCompiled: null, episodeSha256: null, fitKnobs: null, events: [], gates: [], mutedStoryScore: null, calls: [], latencyMs: 0, tokens: { in: 0, out: 0 } };
  const finish = () => { rec.latencyMs = Math.round(performance.now() - T0); for (const c of rec.calls) { rec.tokens.in += c.tokensIn; rec.tokens.out += c.tokensOut; } return rec; };
  const call = async <T>(stage: string, fn: () => Promise<unknown>, schema: { parse(v: unknown): { ok: true; value: T } | { ok: false; issues: Array<{ path: string; message: string }> } }): Promise<{ ok: true; value: T } | { ok: false; issues: string[] }> => {
    let raw: unknown;
    try { raw = await fn(); }
    catch (e) {
      const m = provider.lastCall(); if (m) rec.calls.push(m);
      const msg = e instanceof ProviderError ? `${e.kind}${e.status ? ' ' + e.status : ''}: ${e.message}` : String(e);
      rec.schemaEvents.push({ stage, ok: false, issues: [`provider error: ${msg}`] });
      throw new Error(`provider failure at ${stage}: ${msg}`);
    }
    const m = provider.lastCall(); if (m) rec.calls.push(m);
    const r = schema.parse(raw);
    rec.schemaEvents.push({ stage, ok: r.ok, issues: r.ok ? [] : r.issues.slice(0, 12).map((i) => `${i.path}: ${i.message}`) });
    return r.ok ? r : { ok: false, issues: r.issues.map((i) => `${i.path}: ${i.message}`) };
  };
  const reqR = StoryRequestSchema.parse(requestIn);
  if (!reqR.ok) { rec.status = 'rejected'; rec.rejection = { category: 'provider_failure', reason: `invalid request: ${reqR.issues.map((i) => i.message).join('; ')}` }; return finish(); }
  const request = reqR.value; rec.request = request;
  const ids = reg.ids;
  let budget = maxRepairs;
  try {
    // ---- Stage A ----
    let norm: NormalizedIdea | null = null, cons: RepairConstraint[] = [];
    for (;;) {
      const r = await call('normalize', () => provider.normalizeIdea({ request, registry: reg, constraints: cons }), normalizedIdeaSchema(ids));
      if (r.ok) { norm = r.value; break; }
      if (budget-- <= 0) { rec.status = 'failed'; rec.failure = `normalizer output never passed the schema: ${r.issues.slice(0, 3).join('; ')}`; return finish(); }
      rec.repairs++;
      cons = r.issues.slice(0, 12).map((m) => ({ code: 'SCHEMA', message: m, beatId: null, field: null, source: 'schema' as const }));
    }
    rec.normalized = norm; rec.substitutions = norm.substitutions;
    const net = ideaSafetyNet(request.idea, norm);
    rec.warnings.push(...net.warnings);
    const rej = net.rejection && ['unsafe', 'protected_ip'].includes(net.rejection.category) ? net.rejection : norm.rejection ?? net.rejection;
    if (rej) { rec.status = 'rejected'; rec.rejection = rej; return finish(); }
    if (norm.safety.classification === 'unsafe' || norm.safety.classification === 'protected_ip') { rec.status = 'rejected'; rec.rejection = { category: norm.safety.classification === 'unsafe' ? 'unsafe' : 'protected_ip', reason: norm.safety.notes }; return finish(); }
    const template = TEMPLATES[norm.engine];
    // ---- Stage B ----
    let plan: VisualBeatPlan | null = null;
    cons = [];
    for (;;) {
      const r = await call('plan', () => provider.planBeats({ request, idea: norm!, template, registry: reg, constraints: cons }), beatPlanSchema(ids));
      if (r.ok) { plan = r.value; break; }
      if (budget-- <= 0) { rec.status = 'failed'; rec.failure = `beat plan never passed the schema: ${r.issues.slice(0, 3).join('; ')}`; return finish(); }
      rec.repairs++;
      cons = r.issues.slice(0, 12).map((m) => ({ code: 'SCHEMA', message: m, beatId: null, field: null, source: 'schema' as const }));
    }
    // ---- C..G with repair loop ----
    for (let n = 0; ; n++) {
      const t0 = performance.now();
      const at: Attempt = { n, kind: n === 0 ? 'initial' : 'repair', plan, compiled: false, constraints: [], validatorErrors: [], validatorWarnings: [], gates: [], patchesApplied: [], patchesRejected: [], accepted: false, ms: 0 };
      rec.attempts.push(at);
      const compat = checkCompatibility(norm, plan!, reg);
      rec.warnings.push(...compat.warnings.filter((w) => !rec.warnings.includes(w)));
      if (compat.rejection) { rec.status = 'rejected'; rec.rejection = compat.rejection; at.ms = performance.now() - t0; return finish(); }
      let constraints = compat.constraints;
      let ep: Episode | null = null, events: KeyEvent[] = [];
      let fitResidual: RepairConstraint[] = [], fitKnobs: FitKnobs | null = null;
      if (!constraints.length) {
        const sp = stagePlan(plan!, reg.environment);
        at.staging = sp.staging;
        constraints = sp.errors;
        if (!constraints.length) {
          const compile = (k?: FitKnobs) => compileEpisode(request, norm!, plan!, sp.staging, reg, k);
          const fitted = deps.fit === false ? { compiled: compile(), report: null } : fitCompile(compile, deps.lib as never);
          const c = fitted.compiled;
          if (c.ok) {
            ep = c.episode; events = c.events; at.compiled = true; rec.warnings.push(...c.notes.filter((w) => !w.startsWith('fit:') && !rec.warnings.includes(w)));
            if (fitted.report) {
              const r = fitted.report;
              fitResidual = r.residual; fitKnobs = r.knobs;
              at.fit = { knobs: r.knobs, decisions: r.decisions, residual: r.residual.map((x) => `${x.code}: ${x.message}`), warnings: r.warnings.length, clearance: r.clearance, framingFitted: r.framing.filter((f) => f.fitted).map((f) => `${f.shot}:${f.preset}`), ms: r.ms };
            }
          } else constraints = c.errors;
        }
      }
      if (ep) {
        rec.lastCompiled = ep;
        const v = validateEpisode(ep, deps.lib, { repair: false });
        at.validatorErrors = v.findings.filter((f) => f.severity === 'error').map((f) => `${f.code}: ${f.message}`);
        at.validatorWarnings = v.findings.filter((f) => f.severity === 'warning').map((f) => `${f.code}: ${f.message}`);
        constraints = [...fitResidual, ...constraintsFromValidator(ep, plan!, v.findings)];
        let analysisLite: AnalysisLite | null = null;
        if (!constraints.length && deps.analyzer) {
          const an = await deps.analyzer.analyze(ep);
          analysisLite = an.analysis;
          const byCode: Record<string, number> = {};
          for (const i of an.issues) byCode[i.code] = (byCode[i.code] ?? 0) + 1;
          at.analysis = { hardIssues: an.issues.filter((i) => HARD.has(i.code)).length, softIssues: an.issues.filter((i) => SOFT.has(i.code)).length, frames: an.analysis.frames.length, byCode, metrics: an.metrics };
          constraints = constraintsFromAnalysis(ep, plan!, an.issues);
          if (an.metrics.footSlipMedian > 0.05 || an.metrics.footSlipP95 > 0.5) constraints.push({ code: 'FOOT_SLIP', message: `planted-foot slip median ${an.metrics.footSlipMedian.toFixed(3)} p95 ${an.metrics.footSlipP95.toFixed(3)} m/s`, beatId: plan!.beats[0].id, field: 'stagingVariant', source: 'analysis' });
          if (an.metrics.handContactErrorCm > 5) constraints.push({ code: 'CONTACT_MISS', message: `hand-to-button error ${an.metrics.handContactErrorCm.toFixed(1)} cm`, beatId: plan!.beats[0].id, field: 'stagingVariant', source: 'analysis' });
        }
        at.gates = storyGates(ep, plan!, events, analysisLite);
        for (const g of at.gates) if (!g.pass && g.beatId && g.field) constraints.push({ code: `STORY_${g.id}`, message: `${g.name}: ${g.detail}`, beatId: g.beatId, field: g.field, source: 'story_gate' });
        else if (!g.pass) constraints.push({ code: `STORY_${g.id}`, message: `${g.name}: ${g.detail}`, beatId: null, field: null, source: 'story_gate' });
        if (!constraints.length) {
          at.accepted = true; at.ms = performance.now() - t0;
          const json = JSON.stringify(ep);
          rec.status = 'accepted'; rec.episode = ep; rec.plan = plan; rec.events = events; rec.gates = at.gates; rec.fitKnobs = fitKnobs;
          rec.episodeSha256 = deps.sha256 ? deps.sha256(json) : null; at.episodeSha256 = rec.episodeSha256 ?? undefined;
          rec.mutedStoryScore = mutedStoryScore(at.gates, plan!);
          return finish();
        }
      }
      at.constraints = constraints; at.ms = performance.now() - t0;
      if (budget <= 0) { rec.status = 'failed'; rec.plan = plan; rec.failure = `not accepted after ${rec.repairs} repair(s): ${constraints.slice(0, 4).map((c) => `${c.code} ${c.message}`).join(' | ')}`; return finish(); }
      budget--; rec.repairs++;
      const rr = await call('repair', () => provider.repairPlan({ request, idea: norm!, plan: plan!, template, registry: reg, constraints, attempt: n + 1 }), RepairResponseSchema);
      if (!rr.ok) { at.patchesRejected.push({ patch: null, reason: `repair response invalid: ${rr.issues.slice(0, 3).join('; ')}` }); continue; }
      const ap = applyPatches(plan!, (rr.value as { patches: Patch[] }).patches, constraints);
      at.patchesApplied = ap.applied; at.patchesRejected = ap.rejected;
      const rp = beatPlanSchema(ids).parse(ap.plan);
      if (!rp.ok) { at.patchesRejected.push({ patch: null, reason: `patched plan violates schema: ${rp.issues.slice(0, 2).map((i) => i.message).join('; ')}` }); continue; }
      plan = rp.value;
    }
  } catch (e) {
    rec.status = 'failed'; rec.failure = String((e as Error).message ?? e);
    if (/provider failure/.test(rec.failure)) rec.rejection = { category: 'provider_failure', reason: rec.failure };
    return finish();
  }
}
