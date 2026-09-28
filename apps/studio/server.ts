// BlockSpark Studio — local single-user control plane (the former codename "RBLX SPARK" is deprecated).
// One command: `npm start` -> http://localhost:5173
//
// Supervised workflow API: IDEA -> STORYBOARD -> APPROVE -> RENDER -> DOWNLOAD. The creator never sends episode JSON:
//   free text -> existing story pipeline (rules provider, safety + availability validation, compiler, fit pass, analyzer)
//   -> validated episode -> approval (content-addressed, written once) -> existing render worker (validates again).
// State lives under out/studio/ (generations, approvals, render outputs, jobs) and survives a browser refresh and a server
// restart. The developer episode player (/apps/studio/player.html) keeps its original routes.
import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { startServer, sendJson, readBody, ROOT, type ApiHandler } from '../render-worker/lib/server.ts';
import { loadLibrary, sha256 } from '../render-worker/lib/library.ts';
import { renderEpisode, ensureWebBuild } from '../render-worker/render.ts';
import { BrowserAnalyzer } from '../render-worker/lib/analyzer.ts';
import { validateEpisode } from '../../packages/pipeline/src/validate.ts';
import { generateEpisode, type Analyzer, type GenerationRecord } from '../../packages/story/src/pipeline.ts';
import { RulesProvider } from '../../packages/story/src/providers/rules.ts';
import { buildRegistry } from '../../packages/story/src/registry.ts';
import { TEMPLATES } from '../../packages/story/src/templates.ts';
import { ENGINES } from '../../packages/story/src/schemas.ts';
import { analyzeIntent } from '../../packages/story/src/safety.ts';
import { scanIdea } from '../../packages/story/src/lexicon.ts';
import { CHANNEL_DURATION_SEC, PRODUCT } from '../../packages/config/src/product.ts';
import { DEFAULT_MOTION_PROFILE } from '../../packages/schema/src/render-compat.ts';

type Library = ReturnType<typeof loadLibrary>;
export interface StudioDeps {
  lib: Library;
  /** the pipeline's shot/collision analyzer (browser); null = static validation only (tests) */
  analyzer: Analyzer | null;
  /** the render worker (tests inject a mock) */
  render: typeof renderEpisode;
  /** state directory relative to ROOT; inside out/ so outputs are served statically */
  stateDir: string;
}
interface Job {
  id: string; source: 'episode' | 'approved'; episode: string; scale: number; state: 'queued' | 'running' | 'done' | 'failed'; phase: string; done: number; total: number;
  startedAt?: number; finishedAt?: number; outDir?: string; outputs?: Record<string, string>; error?: string; gates?: string;
  quality?: { passed: number; total: number; failed: string[] } | null; media?: Record<string, string | number> | null;
}

export const UI_TEXT = {
  label: 'Experimental constrained generator — review the storyboard before rendering.',
  placeholder: 'Zapp presses a free-coins button, celebrates, and the coin becomes too large.',
  reminder: 'Watch the final video once, including muted playback, before publishing.',
};
const REJECT_TITLE: Record<string, string> = {
  provider_failure: 'Invalid request', unsafe: 'Blocked: unsafe content', protected_ip: 'Blocked: protected IP',
  unavailable: 'Not available: an asset or action is not in the library', impossible: 'Not supported by the engine',
  requires_dialogue: 'Needs dialogue (not supported)', requires_text: 'Needs readable on-screen text (not supported)', duration: 'Duration not possible',
  story_incompatible: 'No valid storyboard for these settings',
};
/** render phases of apps/render-worker/render.ts -> user-facing stage (the order the worker actually runs them in) */
const STAGE: Record<string, [string, string]> = {
  queued: ['Queued', 'waiting for the render worker'], validate: ['Preparing', 'validating the approved episode'], analyze: ['Preparing', 'checking shots and collisions'],
  audio: ['Encoding', 'mixing audio and encoding AAC-LC'], render: ['Rendering', 'rendering frames and encoding H.264'],
  verify: ['Validating', 'decoding the MP4, checking playback and quality gates'], done: ['Complete', ''],
};
/** plain-language wording of the safety findings (presentation only; the policy decides, this only explains) */
const RULE_TEXT: Record<string, string> = {
  strike_person: 'hitting or striking a character', threat: 'threatening a character', armed_pursuit: 'chasing a character with a harm-capable object',
  armed_ambush: 'lying in wait or hiding with a harm-capable object', concealed_instrument: 'hiding a harm-capable object near a character',
  implied_strike: 'swinging a harm-capable object at someone', person_harm: 'pushing, tripping or trapping a character into danger',
  hazard_contact: 'a dangerous stunt children could copy', hazard_dare: 'daring someone to do a dangerous stunt',
};
const CAT_TEXT: Record<string, string> = {
  violence: 'violence', weapon: 'a weapon', sexual: 'sexual content', drugs_alcohol: 'drugs or alcohol', dangerous_imitation: 'a dangerous stunt children could copy',
  self_harm: 'self-harm', real_money_giveaway: 'real-money or giveaway promises', platform_currency: 'platform currency', cruelty: 'insults or bullying',
};
function plainReason(category: string, idea: string, fallback: string): string {
  if (category !== 'unsafe') return fallback;
  const rules = analyzeIntent(idea).map((f) => RULE_TEXT[f.rule]).filter(Boolean);
  const cats = scanIdea(idea).safety.filter((x) => !/^[a-z_]+: /.test(x.term)).map((x) => CAT_TEXT[x.category] ?? x.category);
  const parts = [...new Set([...rules, ...cats])];
  return parts.length ? `The idea describes ${parts.join('; ')}. Family-safe episodes cannot show this.` : fallback;
}
const short = (s: unknown, n = 260) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

export function createStudioApi(deps: StudioDeps): ApiHandler {
  const { lib } = deps;
  const reg = buildRegistry(lib as never);
  const S = (...p: string[]) => join(ROOT, deps.stateDir, ...p);
  for (const d of ['generations', 'approved', 'renders']) mkdirSync(S(d), { recursive: true });
  const jobsFile = S('jobs.json');
  const jobs: Job[] = existsSync(jobsFile) ? JSON.parse(readFileSync(jobsFile, 'utf8')) : [];
  for (const j of jobs) if (j.state === 'queued' || j.state === 'running') { j.state = 'failed'; j.phase = 'failed'; j.error = 'interrupted: the studio server stopped during this render — press Retry'; }
  const saveJobs = () => writeFileSync(jobsFile, JSON.stringify(jobs, null, 1));
  let running = false;
  let genChain: Promise<unknown> = Promise.resolve();
  const name = (kind: 'characters' | 'props' | 'environments', id: string, version?: string) => {
    const m = lib[kind] as unknown as Record<string, { displayName?: string }>;
    return m[`${id}@${version}`]?.displayName ?? Object.entries(m).find(([k]) => k.startsWith(`${id}@`))?.[1]?.displayName ?? id;
  };

  function storyboardView(gid: string, rec: GenerationRecord) {
    const ep = rec.episode as any, plan = rec.plan as any, norm = rec.normalized as any;
    const rej = rec.rejection as { category: string; reason: string; also?: Array<{ category: string; reason: string }> } | null;
    const category = rej?.category ?? (rec.status === 'failed' ? 'story_incompatible' : null);
    const technical = short(rej?.reason ?? rec.failure);
    const rejection = category ? { category, title: REJECT_TITLE[category] ?? category, reason: short(plainReason(category, String((rec.request as any)?.idea ?? ''), technical)), detail: technical, also: (rej?.also ?? []).map((x) => ({ category: x.category, reason: short(x.reason, 160) })) } : null;
    const cards = !ep ? [] : ep.beats.map((b: any) => {
      const pb = plan?.beats?.find((x: any) => x.id === b.id) ?? {};
      const inBeat = (t: number) => t >= b.start - 1e-6 && t < b.end - 1e-6;
      const actor = pb.actor && pb.actor !== 'none' ? name('characters', pb.actor) : null;
      const fx = pb.propEffect && pb.propEffect.effect !== 'none' ? `${pb.propEffect.prop} ${pb.propEffect.effect}${pb.propEffect.magnitude ? ` (${pb.propEffect.magnitude})` : ''}` : null;
      return {
        beatId: b.id, slot: pb.slot ?? b.intent, start: b.start, end: b.end,
        character: actor ?? (fx ? 'prop' : '—'), action: pb.action && pb.action !== 'none' ? pb.action : fx ?? '—', propEffect: actor ? fx : null,
        target: pb.target ?? null, expression: pb.expressionAfter ?? pb.expressionBefore ?? null,
        reactor: pb.reactor ? `${name('characters', pb.reactor.actor)}${pb.reactor.expression ? ` (${pb.reactor.expression})` : ''}` : null,
        camera: [...new Set(ep.shots.filter((sh: any) => sh.start < b.end - 1e-6 && sh.end > b.start + 1e-6).map((sh: any) => sh.preset))],
        purpose: pb.purpose ?? b.intent, visible: pb.visibleChange ?? b.summary, emote: pb.emote ?? null,
        sound: [...new Set(ep.audio.cues.filter((c: any) => inBeat(c.at)).map((c: any) => String(c.sfx).replace(/^sfx_/, '')))],
        vfx: [...new Set(ep.vfx.filter((v: any) => inBeat(v.at)).map((v: any) => v.type))],
      };
    });
    const hero = ep?.props.find((p: any) => p.hero), esc = ep?.props.find((p: any) => p.instance === 'coin');
    const subs = (rec.substitutions ?? []).map((x: any) => `${x.requested} -> ${x.used} (${x.kind})`);
    const alsoAvail = rejection?.also.find((x) => x.category === 'unavailable' || x.category === 'impossible');
    const safety = !rejection ? { status: norm?.safety?.classification === 'ip_transformed' ? 'Passed (brand reference removed)' : 'Passed', detail: short(norm?.safety?.notes, 160) }
      : rejection.category === 'unsafe' || rejection.category === 'protected_ip' ? { status: 'Blocked', detail: rejection.reason }
      : rejection.category === 'provider_failure' ? { status: 'Not checked (invalid request)', detail: '' } : { status: 'Passed (checked first)', detail: '' };
    const availability = !rejection || rejection.category === 'story_incompatible' ? { status: subs.length ? `Passed with ${subs.length} declared substitution(s)` : 'Passed: every element is registered', detail: '', substitutions: subs }
      : rejection.category === 'unavailable' || rejection.category === 'impossible' ? { status: 'Blocked', detail: rejection.reason, substitutions: subs }
      : alsoAvail ? { status: 'Also blocked', detail: alsoAvail.reason, substitutions: subs } : { status: 'Not evaluated (blocked earlier)', detail: '', substitutions: subs };
    const last = rec.attempts[rec.attempts.length - 1];
    return {
      generationId: gid, status: rec.status, request: rec.request, rejection,
      blocking: rec.status === 'accepted' ? [] : [rejection ? `${rejection.title}: ${rejection.reason}` : 'not accepted'],
      summary: !ep ? null : {
        episodeId: ep.episode.id, title: ep.episode.title, logline: ep.episode.logline, engine: plan?.engine ?? ep.episode.comedyEngine,
        engineTitle: (TEMPLATES as any)[plan?.engine ?? ep.episode.comedyEngine]?.title ?? '', duration: ep.episode.duration, fps: ep.episode.fps,
        resolution: `${ep.episode.resolution[0]}x${ep.episode.resolution[1]}`, environment: `${name('environments', ep.environment.id, ep.environment.version)} (${ep.environment.lighting})`,
        characters: ep.cast.map((c: any) => `${name('characters', c.id, c.version)} — ${c.role}`),
        causalProp: hero ? name('props', hero.id, hero.version) : '—', escalationProp: esc ? name('props', esc.id, esc.version) : '—',
        motionProfile: ep.render.motionProfile, rendererVersion: ep.render.rendererVersion, seed: rec.request.seed,
      },
      safety, availability, cards,
      warnings: [...new Set([...(rec.warnings ?? []), ...(last?.validatorWarnings ?? [])])].slice(0, 20).map((w) => short(w, 200)),
      storyGates: rec.gates?.length ? { passed: rec.gates.filter((g) => g.pass).length, total: rec.gates.length } : null,
      repairs: rec.repairs, latencyMs: rec.latencyMs, episodeSha256: rec.episodeSha256,
    };
  }
  const readGeneration = (gid: string): GenerationRecord | null => /^g-[0-9a-f]{16}$/.test(gid) && existsSync(S('generations', `${gid}.json`)) ? JSON.parse(readFileSync(S('generations', `${gid}.json`), 'utf8')).record : null;
  function readApproval(aid: string) {
    if (!/^a-[0-9a-f]{16}$/.test(aid) || !existsSync(S('approved', aid, 'approval.json'))) return null;
    const meta = JSON.parse(readFileSync(S('approved', aid, 'approval.json'), 'utf8'));
    const intact = existsSync(S('approved', aid, 'episode.json')) && sha256(readFileSync(S('approved', aid, 'episode.json'), 'utf8')) === meta.sha256;
    return { ...meta, intact } as { approvalId: string; generationId: string; episodeId: string; title: string; seed: number; duration: number; motionProfile: string; sha256: string; approvedAt: string; intact: boolean; request: unknown };
  }
  function mediaInfo(outDir: string): Record<string, string | number> | null {
    const f = join(outDir, 'probe.json');
    if (!existsSync(f)) return null;
    const p = JSON.parse(readFileSync(f, 'utf8')), fmt = p.probe?.format ?? {}, st: any[] = p.probe?.streams ?? [];
    const v = st.find((x) => x.codec_type === 'video'), a = st.find((x) => x.codec_type === 'audio');
    const [n, d] = String(v?.r_frame_rate ?? '0/1').split('/').map(Number);
    return {
      duration: +Number(fmt.duration ?? 0).toFixed(2), resolution: v ? `${v.width}x${v.height}` : '?', fps: d ? +(n / d).toFixed(3) : 0,
      video: v ? `${v.codec_name === 'h264' ? 'H.264' : v.codec_name}${v.profile ? ` ${v.profile}` : ''}` : 'none',
      audio: a ? `${a.codec_name === 'aac' ? 'AAC' : a.codec_name} ${Number(a.sample_rate) / 1000} kHz ${a.channels === 2 ? 'stereo' : `${a.channels} ch`}` : 'none',
      container: String(fmt.format_name ?? '').includes('mp4') ? `MP4${fmt.faststart ? ' (faststart)' : ''}` : String(fmt.format_name ?? '?'),
      ...(typeof p.production?.ok === 'boolean' ? { production: p.production.ok ? 'production profile PASS' : 'production profile FAIL' } : {}),
    };
  }
  function validationSummary(outDir: string): string {
    const f = join(outDir, 'validation.json');
    if (!existsSync(f)) return 'render failed before producing an MP4';
    const v = JSON.parse(readFileSync(f, 'utf8'));
    const errs = [...(v.libraryErrors ?? []), ...(v.findings ?? []).filter((x: any) => x.severity === 'error').map((x: any) => `${x.code}: ${x.message}`)];
    return short(`episode validation failed: ${errs.slice(0, 3).join('; ') || 'see validation.json'}`, 400);
  }
  const jobView = (j: Job) => {
    const [stage, detail] = j.state === 'failed' ? ['Failed', j.error ?? ''] : j.state === 'done' ? STAGE.done : STAGE[j.phase] ?? ['Preparing', j.phase];
    return { ...j, approvalId: j.source === 'approved' ? j.episode : null, stage, detail, error: j.error ?? null, outputs: j.outputs ?? {}, media: j.media ?? null, quality: j.quality ?? null };
  };

  async function pump(): Promise<void> {
    if (running) return;
    const job = jobs.find((j) => j.state === 'queued');
    if (!job) return;
    running = true; job.state = 'running'; job.startedAt = Date.now(); job.phase = 'validate'; saveJobs();
    try {
      let epFile: string, out: string, epId: string;
      if (job.source === 'approved') {
        const a = readApproval(job.episode);
        if (!a || !a.intact) throw new Error('the approved episode on disk no longer matches its approval hash; refusing to render');
        epFile = relative(ROOT, S('approved', job.episode, 'episode.json')); out = relative(ROOT, S('renders', job.episode, job.id)); epId = a.episodeId;
      } else { epFile = `episodes/${job.episode}.json`; out = join('out', job.scale === 1 ? job.episode : `${job.episode}-preview`); epId = job.episode; }
      let saved = 0;
      const r = await deps.render({ episode: epFile, out, scale: job.scale, onProgress: (p) => { job.phase = p.phase; job.done = p.done; job.total = p.total; if (Date.now() - saved > 2000) { saved = Date.now(); saveJobs(); } } });
      job.outDir = relative(ROOT, r.outDir);
      const o: Record<string, string> = {};
      for (const [k, f] of [['mp4', r.mp4 ? basename(r.mp4) : `${epId}.mp4`], ['thumbnail', 'thumbnail.png'], ['episode', 'episode.json'], ['quality', 'quality-report.md'], ['contactSheet', 'contact-sheet.png'], ['renderLog', 'render-log.json'], ['validation', 'validation.json']]) if (existsSync(join(r.outDir, f))) o[k] = `/${job.outDir}/${f}`;
      if (job.source === 'approved') o.episodeJson = `/api/story/approved/${job.episode}/episode.json`;
      job.outputs = o;
      const sum = r.report?.summary;
      job.gates = sum ? `${sum.passed}/${sum.total}` : undefined;
      job.quality = sum ? { passed: sum.passed, total: sum.total, failed: sum.failed } : null;
      job.media = mediaInfo(r.outDir);
      if (r.mp4 && r.ok) { job.state = 'done'; job.phase = 'done'; }
      else { job.state = 'failed'; job.error = r.mp4 ? `quality gates failed: ${sum?.failed.join(', ') || 'playback check'} (MP4 and quality report kept for inspection)` : validationSummary(r.outDir); }
    } catch (e) { job.state = 'failed'; job.error = short((e as Error)?.message ?? e, 400); }
    job.finishedAt = Date.now(); running = false; saveJobs();
    void pump();
  }
  const listEpisodes = () => readdirSync(join(ROOT, 'episodes')).filter((f) => f.endsWith('.json')).map((f) => {
    const e = JSON.parse(readFileSync(join(ROOT, 'episodes', f), 'utf8'));
    return { id: f.replace(/\.json$/, ''), title: e.episode?.title, duration: e.episode?.duration };
  });
  const body = async (req: Parameters<ApiHandler>[0]): Promise<any> => { try { return JSON.parse((await readBody(req)) || '{}'); } catch { return null; } };

  return async (req, res, u) => {
    const p = u.pathname;
    // ---------- supervised workflow ----------
    if (p === '/api/story/options') {
      sendJson(res, 200, { product: PRODUCT.name, deprecatedNames: PRODUCT.deprecatedNames, ...UI_TEXT, engines: ENGINES.map((e) => ({ id: e, title: TEMPLATES[e].title })), duration: { min: CHANNEL_DURATION_SEC[0], max: CHANNEL_DURATION_SEC[1], default: 17 }, motionProfile: DEFAULT_MOTION_PROFILE });
      return true;
    }
    if (p === '/api/story/generate' && req.method === 'POST') {
      const b = await body(req);
      if (!b) { sendJson(res, 400, { error: 'request body is not JSON' }); return true; }
      // only these four fields reach the pipeline, which validates them (StoryRequestSchema: idea 1-400 chars, 14-22 s,
      // a registered comedy engine or null = detect, integer seed); it never sees anything else from the client
      const request = { idea: typeof b.idea === 'string' ? b.idea : '', durationTarget: Number(b.durationTarget), comedyEngine: b.comedyEngine ? String(b.comedyEngine) : null, seed: Number(b.seed) };
      const gid = `g-${sha256(JSON.stringify(request)).slice(0, 16)}`;
      const run = genChain.then(() => generateEpisode(request, { provider: new RulesProvider(), registry: reg, lib: lib as never, analyzer: deps.analyzer, sha256, maxRepairs: 3 }));
      genChain = run.catch(() => undefined);
      const rec = await run;
      writeFileSync(S('generations', `${gid}.json`), JSON.stringify({ generationId: gid, createdAt: new Date().toISOString(), record: { ...rec, lastCompiled: null } }));
      sendJson(res, 200, storyboardView(gid, rec)); return true;
    }
    const g = p.match(/^\/api\/story\/generations\/(g-[0-9a-f]{16})(\/episode\.json)?$/);
    if (g && req.method === 'GET') {
      const rec = readGeneration(g[1]);
      if (!rec) { sendJson(res, 404, { error: 'unknown storyboard' }); return true; }
      sendJson(res, 200, g[2] ? rec.episode : storyboardView(g[1], rec)); return true;
    }
    if (p === '/api/story/approve' && req.method === 'POST') {
      const b = await body(req);
      const rec = typeof b?.generationId === 'string' ? readGeneration(b.generationId) : null;
      if (!rec) { sendJson(res, 404, { error: 'unknown storyboard' }); return true; }
      if (rec.status !== 'accepted' || !rec.episode || !rec.episodeSha256) { sendJson(res, 409, { error: 'this storyboard was not accepted by the pipeline and cannot be approved' }); return true; }
      const json = JSON.stringify(rec.episode);
      if (sha256(json) !== rec.episodeSha256) { sendJson(res, 409, { error: 'storyboard integrity check failed' }); return true; }
      const v = validateEpisode(rec.episode, lib as never, { repair: false });
      if (!v.ok) { sendJson(res, 409, { error: 'the episode no longer validates', findings: v.findings.filter((f) => f.severity === 'error').slice(0, 5) }); return true; }
      const aid = `a-${rec.episodeSha256.slice(0, 16)}`, dir = S('approved', aid);
      if (!existsSync(join(dir, 'approval.json'))) {
        // content-addressed and written once: the approved episode can never change under the same approval id
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'episode.json'), json, { flag: 'wx' });
        writeFileSync(join(dir, 'approval.json'), JSON.stringify({ approvalId: aid, generationId: b.generationId, approvedAt: new Date().toISOString(), request: rec.request, seed: rec.request.seed, episodeId: rec.episode.episode.id, title: rec.episode.episode.title, duration: rec.episode.episode.duration, motionProfile: rec.episode.render.motionProfile, sha256: rec.episodeSha256 }, null, 1), { flag: 'wx' });
      }
      sendJson(res, 200, readApproval(aid)); return true;
    }
    const a = p.match(/^\/api\/story\/approved\/(a-[0-9a-f]{16})(\/episode\.json)?$/);
    if (a && req.method === 'GET') {
      const ap = readApproval(a[1]);
      if (!ap) { sendJson(res, 404, { error: 'unknown approval' }); return true; }
      if (!a[2]) { sendJson(res, 200, ap); return true; }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="${ap.episodeId}.json"`, 'cache-control': 'no-store' });
      res.end(readFileSync(S('approved', a[1], 'episode.json'))); return true;
    }
    if (p === '/api/story/render' && req.method === 'POST') {
      const b = await body(req);
      if (typeof b?.approvalId !== 'string') { sendJson(res, 400, { error: 'rendering requires an approved storyboard (approvalId); free text and unapproved storyboards are never rendered' }); return true; }
      const ap = readApproval(b.approvalId);
      if (!ap) { sendJson(res, 404, { error: 'unknown approval' }); return true; }
      if (!ap.intact) { sendJson(res, 409, { error: 'the approved episode on disk no longer matches its approval hash' }); return true; }
      if (jobs.some((j) => j.source === 'approved' && j.episode === ap.approvalId && (j.state === 'queued' || j.state === 'running'))) { sendJson(res, 409, { error: 'a render of this approved episode is already in progress' }); return true; }
      const job: Job = { id: `job${jobs.length + 1}`, source: 'approved', episode: ap.approvalId, scale: b.quality === 'preview' ? 0.5 : 1, state: 'queued', phase: 'queued', done: 0, total: 1 };
      jobs.push(job); saveJobs(); void pump();
      sendJson(res, 202, jobView(job)); return true;
    }
    // ---------- developer episode player (unchanged behaviour) ----------
    if (p === '/api/episodes' && req.method === 'GET') { sendJson(res, 200, listEpisodes()); return true; }
    const m = p.match(/^\/api\/episodes\/([a-z0-9_-]+)$/);
    if (m && req.method === 'GET') { const f = join(ROOT, 'episodes', `${m[1]}.json`); if (!existsSync(f)) { sendJson(res, 404, { error: 'not found' }); return true; } sendJson(res, 200, JSON.parse(readFileSync(f, 'utf8'))); return true; }
    if (m && req.method === 'PUT') {
      // Save/duplicate: only data that passes validation is written. Never executes content.
      const b = await body(req);
      const v = validateEpisode(b, lib as never, { repair: false });
      if (!v.ok) { sendJson(res, 422, v); return true; }
      writeFileSync(join(ROOT, 'episodes', `${m[1]}.json`), JSON.stringify(b, null, 2));
      sendJson(res, 200, { saved: m[1] }); return true;
    }
    if (p === '/api/library') { sendJson(res, 200, lib); return true; }
    if (p === '/api/validate' && req.method === 'POST') { sendJson(res, 200, validateEpisode(await body(req), lib as never, { repair: true })); return true; }
    if (p === '/api/render' && req.method === 'POST') {
      const { episode, scale } = (await body(req)) ?? {};
      if (typeof episode !== 'string' || !/^[a-z0-9_-]+$/.test(episode) || !existsSync(join(ROOT, 'episodes', `${episode}.json`))) { sendJson(res, 400, { error: 'unknown episode' }); return true; }
      const job: Job = { id: `job${jobs.length + 1}`, source: 'episode', episode, scale: scale === 0.5 ? 0.5 : 1, state: 'queued', phase: 'queued', done: 0, total: 1 };
      jobs.push(job); saveJobs(); void pump();
      sendJson(res, 202, jobView(job)); return true;
    }
    if (p === '/api/jobs') { sendJson(res, 200, jobs.map(jobView)); return true; }
    const j = p.match(/^\/api\/jobs\/(job\d+)$/);
    if (j) { const job = jobs.find((x) => x.id === j[1]); sendJson(res, job ? 200 : 404, job ? jobView(job) : { error: 'not found' }); return true; }
    if (p === '/api/health') { sendJson(res, 200, { ok: true, jobs: jobs.length, running }); return true; }
    return false;
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ensureWebBuild(console.log);
  const lib = loadLibrary();
  const api = createStudioApi({ lib, analyzer: new BrowserAnalyzer(lib), render: renderEpisode, stateDir: 'out/studio' });
  const { url } = await startServer(Number(process.env.PORT ?? 5173), api);
  console.log(`${PRODUCT.name} running at ${url}`);
}
