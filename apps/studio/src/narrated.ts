// Narrated Story mode (Phase 1): INPUT -> ALIGNMENT REVIEW -> STORYBOARD. Storyboard JSON download only; no rendering.
// Visual Comedy (app.ts) is untouched: this module only toggles which mode container is visible.
// Raw audio is never kept in localStorage: only form fields, audio metadata/hash and the generation id.
type NScreen = 'input' | 'alignment' | 'storyboard' | 'approved' | 'render';
interface AudioMeta { originalFilename: string; format: string; codec: string; durationSeconds: number; sampleRate: number; channels: number; contentHash: string }
interface Form { title: string; script: string; characters: string[]; storyPattern: string; seed: number; captionPreset: string }
interface Options { draftLabel: string; characters: Array<{ id: string; name: string }>; patterns: Array<{ id: string; title: string }>; captionPresets: Array<{ id: string; title: string }>; formats: string[]; ffmpeg: { available: boolean; source: string; version: string | null; problem: string | null }; ffmpegSetup: string; maxUploadMB: number; renderNotice: string; reupload: string }
interface Gen { generationId: string; status: 'accepted' | 'rejected'; rejection: { category: string; title: string; reason: string; also: Array<{ category: string; reason: string }> } | null; storyboard: any; speechRegions: Array<{ start: number; end: number }>; renderNotice: string; audioAvailable: boolean }

const KEY = 'blockspark.narrated.v1';
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const esc = (x: unknown): string => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const f2 = (x: number) => Number(x).toFixed(2);
const newSeed = () => { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] % 2147483647; };

let opt: Options;
let mode: 'visual' | 'narrated' = 'visual';
let nscreen: NScreen = 'input';
let form: Form = { title: '', script: '', characters: [], storyPattern: 'hypothetical', seed: newSeed(), captionPreset: 'shorts_default' };
let audio: AudioMeta | null = null;
/** set when a restored session's audio is no longer on the server: only the same content hash may be re-uploaded */
let expectedHash: string | null = null;
let gen: Gen | null = null, busy = false, msg = '';
/** frozen server-side approval (never mutated by input edits) and the current draft job */
let approval: any = null, job: any = null, poll: number | undefined;
const DRAFT_STAGES: Array<[string, string]> = [['queued', 'Queued'], ['preparing', 'Preparing'], ['compiling', 'Compiling timeline'], ['encoding', 'Encoding captions/audio'], ['rendering', 'Rendering'], ['validating', 'Validating'], ['complete', 'Complete']];

function persist(): void { localStorage.setItem(KEY, JSON.stringify({ mode, form, audio, generationId: gen?.generationId ?? null, approvalId: approval?.approvalId ?? null, jobId: job?.id ?? null, screen: nscreen })); }
function setMode(m: 'visual' | 'narrated'): void {
  mode = m;
  $('mode-visual').hidden = m !== 'visual'; $('steps').hidden = m !== 'visual'; $('mode-narrated').hidden = m !== 'narrated';
  document.querySelectorAll<HTMLButtonElement>('#modes button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
  persist();
}
const canGenerate = () => !busy && !!audio && !expectedHash && form.title.trim().length > 0 && form.script.trim().length > 0 && form.characters.length > 0 && Number.isInteger(form.seed) && form.seed >= 0;

function inputHtml(): string {
  const a = audio;
  const audioInfo = expectedHash ? `<div class="panel bad">${esc(opt.reupload)} <span class="dim">(expected SHA-256 ${esc(expectedHash.slice(0, 12))}…${audio ? `, ${esc(audio.originalFilename)}` : ''})</span> <button data-nact="forget-audio" class="ghost">Use a different voice-over instead</button></div>`
    : a ? `<p class="dim">Voice-over: <b>${esc(a.originalFilename)}</b> · ${f2(a.durationSeconds)} s · ${esc(a.sampleRate)} Hz · ${esc(a.channels)} ch · ${esc(a.codec)} · SHA-256 ${esc(a.contentHash.slice(0, 12))}…</p>` : '<p class="dim">No voice-over uploaded yet.</p>';
  return `<p class="label">Narrated Story — Phase 1: timed storyboard and captions only (no video rendering yet).</p>
    <label>Episode title<input id="n-title" maxlength="80" value="${esc(form.title)}"></label>
    <label style="margin-top:12px">Script — one narration/caption phrase per line; blank lines separate sections<textarea id="n-script" rows="9" maxlength="6000" placeholder="Imagine if you actually lived inside a block game.&#10;At first, everything would feel perfect.">${esc(form.script)}</textarea></label>
    <div class="row">
      <label>Voice-over (${esc(opt.formats.map((x) => x.toUpperCase()).join(', '))}, max ${esc(opt.maxUploadMB)} MB)<input id="n-file" type="file" accept=".wav,.mp3,.m4a"></label>
      <span id="n-upload" class="dim">${esc(msg)}</span>
    </div>${opt.ffmpeg.available ? '' : `<p class="warn" style="font-size:12.5px">WAV only on this server: ${esc(opt.ffmpeg.problem ?? 'FFmpeg unavailable')}. ${esc(opt.ffmpegSetup)}</p>`}${audioInfo}
    <div class="row">
      <fieldset style="border:1px solid var(--line);border-radius:8px"><legend class="dim">Characters (registered only)</legend>${opt.characters.map((c) => `<label style="flex-direction:row;align-items:center"><input type="checkbox" name="n-char" value="${esc(c.id)}" ${form.characters.includes(c.id) ? 'checked' : ''}> ${esc(c.name)}</label>`).join('')}</fieldset>
      <label>Story pattern<select id="n-pattern">${opt.patterns.map((p) => `<option value="${esc(p.id)}" ${p.id === form.storyPattern ? 'selected' : ''}>${esc(p.title)}</option>`).join('')}</select></label>
      <label>Caption style<select id="n-preset">${opt.captionPresets.map((p) => `<option value="${esc(p.id)}">${esc(p.title)}</option>`).join('')}</select></label>
      <label>Seed<input id="n-seed" type="number" min="0" step="1" style="width:150px" value="${esc(form.seed)}"></label>
      <button data-nact="seed" class="ghost" type="button">New seed</button>
    </div>
    <div class="actions"><button data-nact="generate" class="primary" ${canGenerate() ? '' : 'disabled'}>Generate Narrated Storyboard</button>${busy ? '<span class="dim">Aligning and planning…</span>' : ''}</div>`;
}
function rejectionHtml(g: Gen): string {
  const r = g.rejection!;
  return `<div class="panel bad"><h2>${esc(r.title)}</h2><p>${esc(r.reason)}</p>${r.also.length ? `<p class="dim">Other reasons found: ${r.also.map((x) => esc(`${x.category}: ${x.reason}`)).join(' · ')}</p>` : ''}<div class="actions"><button data-nact="back" class="ghost">Back to input</button></div></div>`;
}
function timelineHtml(sb: any, regions: Array<{ start: number; end: number }>): string {
  const D = sb.audio.durationSeconds, pct = (t: number) => `${((100 * t) / D).toFixed(3)}%`;
  const col = (c: number) => (c >= 0.8 ? 'var(--good)' : c >= 0.55 ? 'var(--yellow)' : 'var(--bad)');
  return `<div style="position:relative;height:30px;background:#0b0d12;border-radius:6px;margin:8px 0 2px">${sb.script.phrases.map((p: any) => `<div title="${esc(`${p.id} ${f2(p.start)}–${f2(p.end)} s`)}" style="position:absolute;top:3px;bottom:3px;left:${pct(p.start)};width:${pct(p.end - p.start)};background:${col(p.alignmentConfidence)};opacity:.8;border-radius:3px;font-size:10px;color:#111;overflow:hidden">${esc(p.id)}</div>`).join('')}</div>
    <div style="position:relative;height:8px;background:#0b0d12;border-radius:4px">${regions.map((r) => `<div style="position:absolute;top:0;bottom:0;left:${pct(r.start)};width:${pct(r.end - r.start)};background:var(--cyan)"></div>`).join('')}</div>
    <p class="dim" style="font-size:12px">Top: phrase ranges (green high, yellow medium, red low confidence). Bottom: detected speech regions. 0–${f2(D)} s.</p>`;
}
const warnList = (ws: Array<{ code: string; message: string }>) => ws.length ? `<div class="warn" style="font-size:12.5px">${ws.map((w) => `⚠ ${esc(w.code)}: ${esc(w.message)}`).join('<br>')}</div>` : '<div class="dim" style="font-size:12.5px">No warnings</div>';
const hl = (line: string, words: string[]) => esc(line).replace(new RegExp(`\\b(${words.map((w) => w.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean).join('|') || '(?!)'})\\b`, 'gu'), '<span style="color:var(--yellow)">$1</span>');
/** the phrase's caption chunks, in playback order, each with its own time range and reading speed */
const captionHtml = (p: any) => p.caption.chunks.map((c: any) => `<div style="margin:6px 0"><div class="dim" style="font-size:11.5px">${esc(c.id)} · ${f2(c.start)}–${f2(c.end)} s · ${esc(c.wordsPerSecond)} w/s</div><div style="background:#000;border-radius:6px;padding:6px 8px;text-align:center;font-weight:800">${c.lines.map((l: string) => hl(l, c.emphasisWords)).join('<br>')}</div></div>`).join('')
function alignmentHtml(g: Gen): string {
  if (g.status !== 'accepted') return rejectionHtml(g);
  const sb = g.storyboard, al = sb.alignment, a = sb.audio;
  const lvl = al.level === 'high' ? 'good' : 'bad';
  return `<h2>Alignment review — ${esc(sb.title)}</h2>
    <div class="facts">${[['Uploaded file', a.originalFilename], ['Audio duration', `${f2(a.durationSeconds)} s`], ['Sample rate', `${a.sampleRate} Hz`], ['Channels', a.channels], ['Codec', a.codec], ['Content hash', `${a.contentHash.slice(0, 12)}…`], ['Script phrases', al.phraseCount], ['Detected speech regions', al.speechRegions], ['Project alignment confidence', `${al.level.toUpperCase()} (${al.confidence})`], ['Estimated phrases', al.estimatedPhrases], ['Method', al.method]].map(([k, v]) => `<div><b>${esc(k)}</b>${esc(v)}</div>`).join('')}</div>
    <div class="panel ${lvl}"><b>${esc(al.level.toUpperCase())} confidence.</b> ${esc(al.note)}. Timing is phrase-level only (no word-level timing).</div>
    ${sb.validation.warnings.length ? warnList(sb.validation.warnings) : ''}
    ${timelineHtml(sb, g.speechRegions)}
    <div class="cards">${sb.script.phrases.map((p: any) => `<div class="card"><div class="t">${f2(p.start)}–${f2(p.end)} s <span>${esc(p.id)} · ${esc(p.alignmentMethod)}</span></div>${captionHtml(p)}<div>confidence <b>${esc(p.alignmentConfidence)}</b> · ${esc(p.caption.wordsPerSecond)} words/s · ${esc(p.caption.chunks.length)} caption chunk(s)</div><div class="dim">emphasis: ${esc(p.caption.chunks.flatMap((c: any) => c.emphasisWords).join(', ') || '—')}</div>${warnList(p.warnings.filter((w: any) => /ALIGN|READING|CAPTION/.test(w.code)))}</div>`).join('')}</div>
    <div class="actions"><button data-nact="back" class="ghost">Back to input</button><button data-nact="to-storyboard" class="primary">Continue to storyboard</button></div>`;
}
function storyboardHtml(g: Gen): string {
  if (g.status !== 'accepted') return rejectionHtml(g);
  const sb = g.storyboard;
  return `<h2>Narrated storyboard — ${esc(sb.title)}</h2><p class="dim">${esc(sb.id)} · pattern ${esc(sb.storyPattern)} · seed ${esc(sb.seed)} · ${esc(sb.script.phrases.length)} beats · ${f2(sb.audio.durationSeconds)} s · validation ${esc(sb.validation.status)}</p>
    <div class="cards">${sb.script.phrases.map((p: any, i: number) => `<div class="card"><div class="t">${f2(p.start)}–${f2(p.end)} s <span>${esc(sb.timeline[i].beatId)} · ${esc(p.storyPurpose)}</span></div>
      <div style="font-style:italic">“${esc(p.text)}”</div>
      <div class="who">${esc(p.actor)} <span class="dim">(${esc(p.actorRole)})</span>${p.supportingCharacter ? ` <span class="dim">+ ${esc(p.supportingCharacter)} (${esc(p.supportingExpression)})</span>` : ''}</div>
      <div>action: <b>${esc(p.semanticAction)}</b>${p.target ? ` -> ${esc(p.target)}` : ''} · face: ${esc(p.expression)}</div>
      <div>environment: ${esc(p.environment)} · camera: ${esc(p.cameraPreset)}</div>${p.cause ? `<div>cause: ${esc(p.cause)}</div>` : ''}${p.propEvents.length ? `<div class="cue">prop events: ${p.propEvents.map((e: any) => esc(`${e.prop} ${e.event}`)).join(' · ')}</div>` : ''}${p.offscreenCharacters.length ? `<div class="warn">off-screen (not drawn): ${esc(p.offscreenCharacters.join(', '))}</div>` : ''}
      <div class="purpose">${esc(p.visualIntent)}</div>${captionHtml(p)}
      <div class="dim">confidence ${esc(p.alignmentConfidence)} (${esc(p.alignmentMethod)})</div>
      ${p.substitutions.length ? `<div class="cue">substituted: ${p.substitutions.map((s: any) => esc(`${s.requested} -> ${s.used}`)).join(' · ')}</div>` : ''}${warnList(p.warnings)}</div>`).join('')}</div>
    <p class="remind">${esc(g.renderNotice)}</p>
    <div class="actions"><button data-nact="back" class="ghost">Back to input</button><button data-nact="to-alignment" class="ghost">Alignment review</button><button data-nact="regen" class="ghost" ${busy || !g.audioAvailable ? 'disabled' : ''}>Regenerate with same seed</button><button data-nact="newseed" class="ghost" ${busy || !g.audioAvailable ? 'disabled' : ''}>Generate with new seed</button>
      <a class="btn" href="/api/narrated/generations/${esc(g.generationId)}/storyboard.json" download>Download Narrated Storyboard JSON</a>
      <button data-nact="approve" class="primary" ${busy || !g.audioAvailable || sb.audio.durationSeconds < 35 || sb.audio.durationSeconds > 75 ? 'disabled' : ''}>Approve storyboard</button></div>
    ${sb.audio.durationSeconds < 35 || sb.audio.durationSeconds > 75 ? `<p class="warn">Draft rendering needs a 35–75 s voice-over (this one is ${f2(sb.audio.durationSeconds)} s).</p>` : ''}<div></div>
    ${g.audioAvailable ? '' : `<p class="warn">${esc(opt.reupload)}</p>`}`;
}
function approvedHtml(): string {
  const a = approval;
  const rows: Array<[string, unknown]> = [['Episode ID', a.storyboardId], ['Audio hash', `${a.audioHash.slice(0, 16)}…`], ['Phrase count', a.phraseCount], ['Caption chunks', a.captionChunks], ['Duration', `${f2(a.durationSeconds)} s`], ['Seed', a.seed], ['Schema version', a.schemaVersion], ['Motion profile', a.motionProfile], ['Approval hash', `${a.storyboardSha256.slice(0, 16)}…`], ['Approval', a.approvalId], ['Approved at', a.approvedAt]];
  return `<div class="panel good"><h2>Approved</h2><p>This exact storyboard, voice-over hash, timing, caption chunks, actors/actions, cameras and seed are frozen. Editing the input does not change it; a different voice-over needs a new approval.</p></div>
    <div class="facts">${rows.map(([k, v]) => `<div><b>${esc(k)}</b>${esc(v)}</div>`).join('')}</div>
    ${a.warnings?.length ? `<p class="warn">${a.warnings.map(esc).join('<br>')}</p>` : ''}${a.intact ? '' : '<div class="panel bad">The approved file no longer matches its hash. Rendering is disabled.</div>'}${a.audioAvailable ? '' : `<div class="panel bad">${esc(opt.reupload)}</div>`}
    <div class="actions"><button data-nact="draft" class="primary" ${a.intact && a.audioAvailable && (!job || job.state === 'done' || job.state === 'failed') ? '' : 'disabled'}>Render Draft Preview (540×960)</button>
      <a class="btn" href="/api/narrated/approved/${esc(a.approvalId)}/storyboard.json" download>Download Approved Narrated JSON</a>
      <button data-nact="discard" class="ghost">Back to storyboard (discard this approval)</button></div>`;
}
function renderHtml(): string {
  const j = job, o = j.outputs ?? {}, idx = DRAFT_STAGES.findIndex(([k]) => k === j.stage);
  const stages = DRAFT_STAGES.map(([k, l], i) => `<li class="${j.state === 'done' || i < idx ? 'done' : i === idx ? 'on' : ''}">${esc(l)}</li>`).join('') + (j.state === 'failed' ? '<li class="bad">Failed</li>' : '');
  const active = j.state === 'queued' || j.state === 'running';
  const bar = !active ? '' : j.stage === 'rendering' && j.total > 1 ? `<p><progress max="${j.total}" value="${j.done}"></progress> ${j.done}/${j.total} frames</p>` : `<p><progress></progress> <span class="dim">this step reports no exact progress</span></p>`;
  let body = '';
  if (j.state === 'failed') body = `<div class="panel bad"><h2>Draft render failed</h2><p>${esc(j.error)}</p><p class="dim">The approval is unchanged. No automatic retries.</p><div class="actions"><button data-nact="draft" class="primary">Retry draft render</button>${o.quality ? `<a class="btn" href="${esc(o.quality)}" target="_blank">Quality report</a>` : ''}</div></div>`;
  if (j.state === 'done') body = `<div class="result"><video controls playsinline src="${esc(o.mp4)}"></video><div><h2>Complete</h2><p class="remind">${esc(opt.draftLabel)}</p>
      <p>Quality gates: <b>${j.quality ? `${j.quality.passed}/${j.quality.total} passed` : '—'}</b>${j.quality?.failed?.length ? ` (failed: ${esc(j.quality.failed.join(', '))})` : ''}</p><div id="n-gates" class="dim">loading validation results…</div>
      <div class="actions"><a class="btn primary" href="${esc(o.mp4)}" download>Download Draft MP4</a><a class="btn" href="${esc(o.approvedJsonApi ?? o.approvedJson)}" download>Download Approved Narrated JSON</a><a class="btn" href="${esc(o.timelineJson)}" download>Download Render Timeline JSON</a>${o.manifest ? `<a class="btn" href="${esc(o.manifest)}" download>Render manifest</a>` : ''}</div></div></div>`;
  return `<h2>Draft render — ${esc(approval?.title ?? '')}</h2><p class="dim">${esc(j.id)} · ${esc(j.approvalId)} · ${esc(opt.draftLabel)}</p><ol class="stages">${stages}</ol>${bar}${body}`;
}
async function loadGates(): Promise<void> {
  const el = document.getElementById('n-gates');
  if (!el || !job?.outputs?.quality) return;
  const q = await (await fetch(job.outputs.quality, { cache: 'no-store' })).json().catch(() => null);
  if (q?.gates) el.innerHTML = `<table>${q.gates.map((g: any) => `<tr><td>${esc(g.id)} ${g.pass ? 'PASS' : '<b class="warn">FAIL</b>'}</td><td>${esc(g.name)}</td><td class="dim">${esc(g.detail)}</td></tr>`).join('')}</table>`;
}
function watchJob(): void {
  window.clearTimeout(poll);
  if (!job || (job.state !== 'queued' && job.state !== 'running')) { if (job?.state === 'done') void loadGates(); return; }
  poll = window.setTimeout(async () => { const r = await fetch(`/api/narrated/jobs/${job.id}`, { cache: 'no-store' }); if (r.status === 200) { job = await r.json(); view(); } watchJob(); }, 1000);
}
async function approve(): Promise<void> {
  if (!gen) return;
  const r = await fetch('/api/narrated/approve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ generationId: gen.generationId }) });
  const d = await r.json().catch(() => ({}));
  if (r.status !== 200) { alert(d.error ?? `approval failed (HTTP ${r.status})`); return; }
  approval = d; job = null; nscreen = 'approved'; view();
}
async function startDraft(): Promise<void> {
  if (!approval) return;
  const r = await fetch('/api/narrated/render', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approvalId: approval.approvalId, audioHash: audio?.contentHash }) });
  const d = await r.json().catch(() => ({}));
  if (r.status !== 202) { alert(d.error ?? `draft render could not start (HTTP ${r.status})`); return; }
  job = d; nscreen = 'render'; view(); watchJob();
}

function view(): void {
  for (const id of ['input', 'alignment', 'storyboard', 'approved', 'render'] as const) $(`n-${id}`).hidden = nscreen !== id;
  document.querySelectorAll<HTMLElement>('#n-steps span').forEach((el) => el.classList.toggle('on', el.dataset.s === nscreen));
  if (nscreen === 'input') { $('n-input').innerHTML = inputHtml(); bind(); }
  if (nscreen === 'alignment' && gen) $('n-alignment').innerHTML = alignmentHtml(gen);
  if (nscreen === 'storyboard' && gen) $('n-storyboard').innerHTML = storyboardHtml(gen);
  if (nscreen === 'approved' && approval) $('n-approved').innerHTML = approvedHtml();
  if (nscreen === 'render' && job) $('n-render').innerHTML = renderHtml();
  persist();
}
function bind(): void {
  const sync = () => {
    form = { ...form, title: $<HTMLInputElement>('n-title').value, script: $<HTMLTextAreaElement>('n-script').value, storyPattern: $<HTMLSelectElement>('n-pattern').value, captionPreset: $<HTMLSelectElement>('n-preset').value, seed: Number($<HTMLInputElement>('n-seed').value), characters: Array.from(document.querySelectorAll<HTMLInputElement>('input[name="n-char"]:checked')).map((x) => x.value).slice(0, 2) };
    $<HTMLButtonElement>('n-input').querySelector<HTMLButtonElement>('[data-nact="generate"]')!.disabled = !canGenerate();
    persist();
  };
  for (const id of ['n-title', 'n-script', 'n-pattern', 'n-preset', 'n-seed']) $(id).addEventListener('input', sync);
  document.querySelectorAll<HTMLInputElement>('input[name="n-char"]').forEach((x) => x.addEventListener('change', sync));
  $<HTMLInputElement>('n-file').addEventListener('change', (e) => void upload((e.target as HTMLInputElement).files?.[0]));
}
async function upload(file: File | undefined): Promise<void> {
  if (!file) return;
  const ext = file.name.toLowerCase().split('.').pop() ?? '';
  if ((ext === 'mp3' || ext === 'm4a') && !opt.ffmpeg.available) { msg = `FFmpeg setup required: ${opt.ffmpeg.problem ?? 'FFmpeg unavailable'}. ${opt.ffmpegSetup}`; view(); return; }
  if (!opt.formats.includes(ext)) { msg = `Unsupported file type .${ext} (allowed: ${opt.formats.join(', ')})`; view(); return; }
  if (file.size > opt.maxUploadMB * 1024 * 1024) { msg = `File is larger than ${opt.maxUploadMB} MB`; view(); return; }
  msg = 'Uploading and validating…'; $('n-upload').textContent = msg;
  const r = await fetch('/api/narrated/upload', { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(file.name) }, body: file });
  const d = await r.json().catch(() => ({}));
  if (r.status !== 200) { msg = `Rejected: ${d.error ?? `HTTP ${r.status}`}`; view(); return; }
  if (expectedHash && d.contentHash !== expectedHash) { msg = `This is a different file (SHA-256 ${String(d.contentHash).slice(0, 12)}… ≠ ${expectedHash.slice(0, 12)}…). Upload the same voice-over, or choose "Use a different voice-over instead".`; view(); return; }
  if (expectedHash && gen) gen = { ...gen, audioAvailable: true };
  if (approval && approval.audioHash !== d.contentHash) { approval = null; job = null; } // a replaced voice-over invalidates the approval
  expectedHash = null; audio = d; msg = d.displayNameSanitized ? `Voice-over validated (display name sanitized to "${d.originalFilename}").` : 'Voice-over validated.'; view();
}
async function generate(seed?: number): Promise<void> {
  if (seed !== undefined) form = { ...form, seed };
  if (!canGenerate()) { view(); return; }
  busy = true; view();
  const r = await fetch('/api/narrated/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: form.title, script: form.script, audioHash: audio!.contentHash, characters: form.characters, storyPattern: form.storyPattern, seed: form.seed, captionPreset: form.captionPreset }) });
  const d = await r.json().catch(() => ({}));
  busy = false;
  if (r.status !== 200) { msg = d.error ?? `generation failed (HTTP ${r.status})`; nscreen = 'input'; view(); return; }
  gen = d; nscreen = nscreen === 'storyboard' && d.status === 'accepted' ? 'storyboard' : 'alignment'; view();
}
document.addEventListener('click', (ev) => {
  const el = (ev.target as HTMLElement).closest<HTMLElement>('[data-nact],[data-mode]');
  if (!el) return;
  if (el.dataset.mode) { setMode(el.dataset.mode as 'visual' | 'narrated'); if (el.dataset.mode === 'narrated') view(); return; }
  const a = el.dataset.nact;
  if (a === 'seed') { form = { ...form, seed: newSeed() }; view(); }
  else if (a === 'generate') void generate();
  else if (a === 'back') { nscreen = 'input'; view(); }
  else if (a === 'to-storyboard') { nscreen = 'storyboard'; view(); }
  else if (a === 'to-alignment') { nscreen = 'alignment'; view(); }
  else if (a === 'regen') { if (gen?.storyboard) form = { ...form, seed: gen.storyboard.seed }; void generate(); }
  else if (a === 'newseed') void generate(newSeed());
  else if (a === 'forget-audio') { expectedHash = null; audio = null; approval = null; job = null; msg = ''; view(); }
  else if (a === 'approve') void approve();
  else if (a === 'draft') void startDraft();
  else if (a === 'discard') { if (confirm('Discard this approval and return to the storyboard? The approved files stay on disk.')) { approval = null; job = null; nscreen = 'storyboard'; view(); } }
});

async function init(): Promise<void> {
  opt = await (await fetch('/api/narrated/options', { cache: 'no-store' })).json();
  $('n-notice').textContent = opt.renderNotice;
  const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { mode?: 'visual' | 'narrated'; form?: Form; audio?: AudioMeta | null; generationId?: string | null; screen?: NScreen } | null;
  if (saved?.form) form = { ...form, ...saved.form, characters: (saved.form.characters ?? []).filter((c) => opt.characters.some((x) => x.id === c)) };
  if (!form.characters.length && opt.characters[0]) form.characters = opt.characters.slice(0, 2).map((c) => c.id);
  if (saved?.audio?.contentHash && /^[0-9a-f]{64}$/.test(saved.audio.contentHash)) {
    audio = saved.audio;
    const r = await fetch(`/api/narrated/audio/${saved.audio.contentHash}`, { cache: 'no-store' });
    if (r.status !== 200) expectedHash = saved.audio.contentHash; // metadata kept, audio must be re-uploaded and hash-verified
  }
  if (saved?.generationId && /^n-[0-9a-f]{16}$/.test(saved.generationId)) {
    const r = await fetch(`/api/narrated/generations/${saved.generationId}`, { cache: 'no-store' });
    if (r.status === 200) { gen = await r.json(); nscreen = saved.screen && saved.screen !== 'input' ? saved.screen : 'input'; }
  }
  const sv = saved as { approvalId?: string; jobId?: string } | null;
  if (sv?.approvalId && /^na-[0-9a-f]{16}$/.test(sv.approvalId)) { const r = await fetch(`/api/narrated/approved/${sv.approvalId}`, { cache: 'no-store' }); if (r.status === 200) { approval = await r.json(); if (nscreen !== 'render') nscreen = 'approved'; } }
  if (approval && sv?.jobId && /^nj\d+$/.test(sv.jobId)) { const r = await fetch(`/api/narrated/jobs/${sv.jobId}`, { cache: 'no-store' }); if (r.status === 200) { const j = await r.json(); if (j.approvalId === approval.approvalId) { job = j; nscreen = 'render'; } } }
  if ((nscreen === 'approved' || nscreen === 'render') && !approval) nscreen = gen ? 'storyboard' : 'input';
  if (nscreen === 'render' && !job) nscreen = 'approved';
  setMode(saved?.mode === 'narrated' ? 'narrated' : 'visual');
  watchJob();
  view();
}
void init();
export {};
