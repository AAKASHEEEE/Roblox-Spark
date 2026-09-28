// BlockSpark Studio — supervised workflow UI (vanilla TS, no framework). State and guards: workflow.ts.
// API glue: apps/studio/server.ts. The creator types an idea; every storyboard comes from the existing pipeline and every
// render uses the approved, content-addressed episode. No JSON, timeline, camera or animation editing.
import { canApprove, canGenerate, canRender, initialState, newSeed, reduce, STAGES, type Action, type ApprovalView, type GenerationView, type JobView, type StudioState } from './workflow.ts';

interface Options { product: string; label: string; placeholder: string; reminder: string; engines: Array<{ id: string; title: string }>; duration: { min: number; max: number; default: number }; motionProfile: string }
const KEY = 'blockspark.studio.v1';
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const esc = (x: unknown): string => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const fmt = (x: unknown) => Number(x).toFixed(2);
async function call<T>(path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const r = await fetch(path, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, data: (await r.json().catch(() => ({}))) as T };
}

let opt: Options;
let s: StudioState = initialState(newSeed());
let poll: number | undefined;

function dispatch(a: Action): void { s = reduce(s, a); persist(); view(); }
function persist(): void {
  localStorage.setItem(KEY, JSON.stringify({ form: s.form, generationId: s.generation?.generationId ?? null, approvalId: s.approval?.approvalId ?? null, jobId: s.job?.id ?? null }));
}
const field = <T extends HTMLElement>(id: string) => $<T>(id);
function fillForm(): void {
  field<HTMLTextAreaElement>('idea').value = s.form.idea; field<HTMLSelectElement>('engine').value = s.form.engine;
  field<HTMLInputElement>('duration').value = String(s.form.duration); field<HTMLInputElement>('seed').value = String(s.form.seed);
}
function bindForm(): void {
  const idea = field<HTMLTextAreaElement>('idea'), engine = field<HTMLSelectElement>('engine'), dur = field<HTMLInputElement>('duration'), seed = field<HTMLInputElement>('seed');
  idea.placeholder = opt.placeholder;
  engine.innerHTML = `<option value="">Auto — detect from the idea</option>${opt.engines.map((e) => `<option value="${esc(e.id)}">${esc(e.title)}</option>`).join('')}`;
  dur.min = String(opt.duration.min); dur.max = String(opt.duration.max);
  const sync = () => dispatch({ type: 'form', patch: { idea: idea.value, engine: engine.value, duration: Number(dur.value), seed: Number(seed.value) } });
  for (const el of [idea, engine, dur, seed]) el.addEventListener('input', sync);
  $('newSeed').onclick = () => { seed.value = String(newSeed()); sync(); };
  $('generate').onclick = () => void generate();
}

async function generate(seed?: number): Promise<void> {
  if (seed !== undefined) { s = reduce(s, { type: 'form', patch: { seed } }); fillForm(); }
  if (!canGenerate(s)) { view(); return; }
  dispatch({ type: 'generating' });
  const f = s.form;
  const r = await call<GenerationView & { error?: string }>('/api/story/generate', { idea: f.idea, comedyEngine: f.engine || null, durationTarget: f.duration, seed: f.seed });
  if (r.status !== 200) { dispatch({ type: 'error', message: r.data.error ?? `storyboard generation failed (HTTP ${r.status})` }); return; }
  dispatch({ type: 'generated', generation: r.data });
}
async function approve(): Promise<void> {
  if (!canApprove(s)) return;
  const r = await call<ApprovalView & { error?: string }>('/api/story/approve', { generationId: s.generation!.generationId });
  if (r.status !== 200) { dispatch({ type: 'error', message: r.data.error ?? `approval failed (HTTP ${r.status})` }); return; }
  dispatch({ type: 'approved', approval: r.data });
}
async function startRender(): Promise<void> {
  if (!canRender(s)) return;
  const quality = document.querySelector<HTMLSelectElement>('#quality')?.value ?? 'final';
  const r = await call<JobView & { error?: string }>('/api/story/render', { approvalId: s.approval!.approvalId, quality });
  if (r.status !== 202) { dispatch({ type: 'error', message: r.data.error ?? `render could not start (HTTP ${r.status})` }); return; }
  dispatch({ type: 'job', job: r.data });
  watch();
}
function watch(): void {
  window.clearTimeout(poll);
  if (!s.job || (s.job.state !== 'queued' && s.job.state !== 'running')) return;
  poll = window.setTimeout(async () => {
    const r = await call<JobView>(`/api/jobs/${s.job!.id}`);
    if (r.status === 200) dispatch({ type: 'job', job: r.data });
    watch();
  }, 1000);
}

function facts(rows: Array<[string, unknown]>): string {
  return `<div class="facts">${rows.map(([k, v]) => `<div><b>${esc(k)}</b>${esc(v)}</div>`).join('')}</div>`;
}
function storyboardHtml(g: GenerationView): string {
  const sm = g.summary, busy = s.busy ? 'disabled' : '';
  const rows: Array<[string, unknown]> = sm
    ? [['Title', sm.title], ['Story engine', sm.engineTitle], ['Duration', `${sm.duration} s · ${sm.resolution} @ ${sm.fps} fps`], ['Environment', sm.environment], ['Characters', (sm.characters as string[]).join(', ')], ['Causal prop', `${sm.causalProp} (escalates: ${sm.escalationProp})`], ['Safety status', `${g.safety.status}`], ['Availability status', g.availability.status], ['Motion profile', sm.motionProfile], ['Seed', sm.seed], ['Episode ID', sm.episodeId], ['Story gates', g.storyGates ? `${g.storyGates.passed}/${g.storyGates.total}` : '—']]
    : [['Idea', g.request.idea], ['Seed', g.request.seed], ['Duration', `${g.request.durationTarget} s`], ['Safety status', g.safety.status], ['Availability status', g.availability.status]];
  const rej = g.status !== 'accepted' && g.rejection ? `<div class="panel bad"><h2>${esc(g.rejection.title)}</h2><p>${esc(g.rejection.reason)}</p>${g.rejection.detail && g.rejection.detail !== g.rejection.reason ? `<p class="dim">Technical reason: ${esc(g.rejection.detail)}</p>` : ''}${g.rejection.also.length ? `<p class="dim">Other reasons found: ${g.rejection.also.map((x) => esc(`${x.category}: ${x.reason}`)).join(' · ')}</p>` : ''}<p class="dim">Safety and availability rules are never weakened to make an idea pass. Approval and rendering stay disabled.</p><div class="actions"><button data-act="back" class="ghost" ${busy}>Change idea</button><button data-act="newseed" class="ghost" ${busy}>Try another seed</button></div></div>` : '';
  const cards = g.cards.map((c) => {
    const snd = c.sound as string[], fx = c.vfx as string[];
    const cue = [...(snd.length ? [`sfx: ${snd.join(', ')}`] : []), ...(fx.length ? [`vfx: ${fx.join(', ')}`] : []), ...(c.emote ? [`emote: ${c.emote}`] : [])];
    return `<div class="card"><div class="t">${fmt(c.start)}–${fmt(c.end)} s <span>${esc(c.beatId)} · ${esc(c.slot)}</span></div><div class="who">${esc(c.character)}</div><div><b>${esc(c.action)}</b>${c.target ? ` -> ${esc(c.target)}` : ''}${c.propEffect ? ` · prop: ${esc(c.propEffect)}` : ''}</div>${c.expression ? `<div>face: ${esc(c.expression)}</div>` : ''}${c.reactor ? `<div>reaction: ${esc(c.reactor)}</div>` : ''}<div>camera: ${esc((c.camera as string[]).join(', ') || '—')}</div><div class="purpose">${esc(c.purpose)} — ${esc(c.visible)}</div>${cue.length ? `<div class="cue">${esc(cue.join(' · '))}</div>` : ''}</div>`;
  }).join('');
  const warn = g.warnings.length ? `<details><summary class="warn">Warnings (${g.warnings.length}) — non-blocking</summary><ul>${g.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></details>` : '';
  const subs = g.status === 'accepted' && g.availability.substitutions.length ? `<p class="dim">Declared substitutions: ${esc(g.availability.substitutions.join(' · '))}</p>` : '';
  return `<h2>${g.status === 'accepted' ? esc(sm?.title) : 'Storyboard not available'}</h2>${sm ? `<p class="dim">${esc(sm.logline)}</p>` : ''}${rej}${facts(rows)}${subs}${warn}
    ${cards ? `<h3>Beats</h3><div class="cards">${cards}</div>` : ''}
    ${g.status === 'accepted' ? `<details id="devjson"><summary class="dim">Developer: generated episode JSON (read-only)</summary><pre id="json">loading…</pre></details>` : ''}
    <div class="actions"><button data-act="back" class="ghost" ${busy}>Back to idea</button><button data-act="regen" class="ghost" ${busy}>Regenerate with same settings</button><button data-act="newseed" class="ghost" ${busy}>Generate with new seed</button>
    <button data-act="approve" class="primary" ${canApprove(s) && !s.busy ? '' : 'disabled'}>Approve storyboard</button>${s.busy ? '<span class="dim">Generating…</span>' : ''}</div>`;
}
function approvedHtml(): string {
  const a = s.approval!;
  return `<div class="panel good"><h2>Approved</h2><p>This exact episode is frozen for rendering. Changing the idea, seed or settings does not change it.</p></div>
    ${facts([['Episode ID', a.episodeId], ['Title', a.title], ['Seed', a.seed], ['Duration', `${a.duration} s`], ['Motion profile', a.motionProfile], ['Approval', a.approvalId], ['Content SHA-256', `${a.sha256.slice(0, 16)}…`], ['Approved at', a.approvedAt]])}
    ${a.intact ? '' : '<div class="panel bad">The approved file on disk no longer matches its hash. Rendering is disabled.</div>'}
    <div class="actions"><label>Quality<select id="quality"><option value="final">Final 1080×1920 MP4</option><option value="preview">Quick preview 540×960</option></select></label>
      <button data-act="render" class="primary" ${canRender(s) ? '' : 'disabled'}>Render Video</button>
      <a class="btn" href="/api/story/approved/${esc(a.approvalId)}/episode.json" download>Download Episode JSON</a></div>
    <p><button data-act="discard" class="ghost">Back to storyboard generation (discard this approval)</button></p>`;
}
function renderHtml(): string {
  const j = s.job!, a = s.approval!, o = j.outputs;
  const idx = STAGES.indexOf(j.stage as (typeof STAGES)[number]);
  const stages = STAGES.map((st, i) => `<li class="${i < idx || j.state === 'done' ? 'done' : i === idx ? 'on' : ''}">${st}</li>`).join('') + (j.state === 'failed' ? '<li class="bad">Failed</li>' : '');
  const active = j.state === 'queued' || j.state === 'running';
  const bar = !active ? '' : j.phase === 'render' && j.total > 1 ? `<p><progress max="${j.total}" value="${j.done}"></progress> ${j.done}/${j.total} frames — ${esc(j.detail)}</p>` : `<p><progress></progress> ${esc(j.detail)} <span class="dim">(this step reports no frame count)</span></p>`;
  const json = o.episodeJson ?? `/api/story/approved/${a.approvalId}/episode.json`;
  let body = '';
  if (j.state === 'failed') body = `<div class="panel bad"><h2>Render failed</h2><p>${esc(j.error)}</p><p class="dim">The approved episode is unchanged. No automatic retries.</p><div class="actions"><button data-act="render" class="primary" ${canRender(s) ? '' : 'disabled'}>Retry render</button>${o.quality ? `<a class="btn" href="${esc(o.quality)}" target="_blank">Quality report</a>` : ''}${o.mp4 ? `<a class="btn" href="${esc(o.mp4)}" download>Diagnostic MP4</a>` : ''}<button data-act="discard" class="ghost">Back to storyboard generation</button></div></div>`;
  if (j.state === 'done' && o.mp4) {
    const m = j.media ?? {}, q = j.quality;
    body = `<div class="result"><video controls playsinline src="${esc(o.mp4)}"></video><div><h2>Complete</h2><table>
      <tr><td>Duration</td><td>${esc(m.duration)} s</td></tr><tr><td>Resolution</td><td>${esc(m.resolution)}</td></tr><tr><td>Frame rate</td><td>${esc(m.fps)} fps</td></tr>
      <tr><td>Video</td><td>${esc(m.video)}</td></tr><tr><td>Audio</td><td>${esc(m.audio)}</td></tr><tr><td>Container</td><td>${esc(m.container)}${m.production ? ` · ${esc(m.production)}` : ''}</td></tr>
      <tr><td>Quality gates</td><td>${q ? `${q.passed}/${q.total} passed${q.failed.length ? ` (failed: ${esc(q.failed.join(', '))})` : ''}` : '—'}</td></tr>
      <tr><td>File</td><td class="dim">${esc(o.mp4.slice(1))}</td></tr></table>
      <div class="actions"><a class="btn primary" href="${esc(o.mp4)}" download>Download MP4</a><a class="btn" href="${esc(json)}" download>Download Episode JSON</a><button data-act="another" class="ghost">Create another episode</button></div>
      <p class="remind">${esc(opt.reminder)}</p>${o.quality ? `<p><a href="${esc(o.quality)}" target="_blank" style="color:var(--cyan)">Quality report</a></p>` : ''}</div></div>`;
  }
  return `<h2>Render — ${esc(a.title)}</h2><p class="dim">${esc(a.episodeId)} · seed ${esc(a.seed)} · ${esc(j.id)}</p><ol class="stages">${stages}</ol>${bar}${body}`;
}
function view(): void {
  for (const id of ['create', 'storyboard', 'approved', 'render'] as const) $(id).hidden = s.screen !== id;
  document.querySelectorAll<HTMLElement>('#steps span').forEach((el) => el.classList.toggle('on', el.dataset.s === s.screen));
  const e = $('error'); e.hidden = !s.error; e.textContent = s.error ?? '';
  $<HTMLButtonElement>('generate').disabled = !canGenerate(s);
  $('genStatus').textContent = s.busy ? 'Generating… (story pipeline, safety and availability checks, compiler, shot checks)' : s.approval ? 'An approved episode exists: return to it or discard the approval before generating.' : '';
  if (s.screen === 'storyboard' && s.generation) $('storyboard').innerHTML = storyboardHtml(s.generation);
  if (s.screen === 'approved') $('approved').innerHTML = approvedHtml();
  if (s.screen === 'render') $('render').innerHTML = renderHtml();
}

document.addEventListener('click', (ev) => {
  const act = (ev.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
  if (!act) return;
  if (act === 'back') dispatch({ type: 'back-to-idea' });
  else if (act === 'regen') {
    const r = s.generation?.request;
    if (r) { s = reduce(s, { type: 'form', patch: { idea: r.idea, engine: r.comedyEngine ?? '', duration: r.durationTarget, seed: r.seed } }); fillForm(); }
    void generate();
  } else if (act === 'newseed') void generate(newSeed());
  else if (act === 'approve') void approve();
  else if (act === 'render') void startRender();
  else if (act === 'discard') { if (confirm('Discard this approval and return to storyboard generation? The approved file stays on disk, but this session will stop using it.')) dispatch({ type: 'discard-approval' }); }
  else if (act === 'another') { dispatch({ type: 'reset', seed: newSeed() }); fillForm(); }
});
document.addEventListener('toggle', async (ev) => {
  const d = ev.target as HTMLDetailsElement;
  if (d.id !== 'devjson' || !d.open || !s.generation) return;
  const r = await call<unknown>(`/api/story/generations/${s.generation.generationId}/episode.json`);
  const pre = document.getElementById('json');
  if (pre) pre.textContent = JSON.stringify(r.data, null, 2);
}, true);

async function init(): Promise<void> {
  opt = (await call<Options>('/api/story/options')).data;
  document.title = opt.product; $('product').textContent = opt.product; $('label').textContent = opt.label;
  s = reduce(initialState(newSeed(), { durationMin: opt.duration.min, durationMax: opt.duration.max }), { type: 'form', patch: { duration: opt.duration.default } });
  bindForm();
  // refresh-safe: restore the form and re-fetch the storyboard, approval and render job from the server
  const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { form?: StudioState['form']; generationId?: string; approvalId?: string; jobId?: string } | null;
  if (saved?.form) s = reduce(s, { type: 'form', patch: saved.form });
  const get = async <T>(p: string | undefined): Promise<T | null> => { if (!p) return null; const r = await call<T>(p); return r.status === 200 ? r.data : null; };
  const [generation, approval, job] = await Promise.all([
    get<GenerationView>(saved?.generationId ? `/api/story/generations/${saved.generationId}` : undefined),
    get<ApprovalView>(saved?.approvalId ? `/api/story/approved/${saved.approvalId}` : undefined),
    get<JobView>(saved?.jobId ? `/api/jobs/${saved.jobId}` : undefined),
  ]);
  s = reduce(s, { type: 'restore', generation, approval, job });
  fillForm(); persist(); view(); watch();
}
void init();
