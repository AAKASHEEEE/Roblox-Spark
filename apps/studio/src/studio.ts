// Studio UI: episode picker, storyboard/timeline, live WebGL preview with procedural audio, render queue.
import type { Episode } from '../../../packages/schema/src/episode.ts';
import { Renderer } from '../../../packages/engine/src/gl/renderer.ts';
import { Production, type Library } from '../../../packages/engine/src/production.ts';
import { mix } from '../../../packages/audio/src/mix.ts';
import type { AudioManifest } from '../../../packages/schema/src/assets.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const api = async (p: string, init?: RequestInit) => (await fetch(p, init)).json();
const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

let ep: Episode | null = null, lib: (Library & { audio: Record<string, AudioManifest>; errors: string[]; hashes: Record<string, string> }) | null = null;
let prod: Production | null = null, renderer: Renderer | null = null;
let t = 0, playing = false, last = 0;
let actx: AudioContext | null = null, abuf: AudioBuffer | null = null, asrc: AudioBufferSourceNode | null = null;

async function init(): Promise<void> {
  lib = await api('/api/library');
  const eps = await api('/api/episodes');
  $('episodes').innerHTML = eps.map((e: any) => `<option value="${esc(e.id)}">${esc(e.title)} (${e.duration}s)</option>`).join('');
  $('libErrors').textContent = lib!.errors.length ? `Asset lock problems: ${lib!.errors.join(' | ')}` : '';
  renderAssets();
  $('episodes').onchange = () => load(($('episodes') as HTMLSelectElement).value);
  $('play').onclick = toggle;
  ($('scrub') as HTMLInputElement).oninput = (e) => { seek(Number((e.target as HTMLInputElement).value)); };
  $('renderFinal').onclick = () => startRender(1);
  $('renderPreview').onclick = () => startRender(0.5);
  $('dup').onclick = duplicate;
  await load(eps[0].id);
  pollJobs();
  requestAnimationFrame(loop);
}

async function load(id: string): Promise<void> {
  ep = await api(`/api/episodes/${id}`);
  const v = await api('/api/validate', { method: 'POST', body: JSON.stringify(ep) });
  renderWarnings(v);
  if (v.ok) ep = v.episode;
  if (!renderer) renderer = new Renderer($('view') as HTMLCanvasElement, 540, 960);
  prod = new Production(ep!, lib!);
  ($('scrub') as HTMLInputElement).max = String(ep!.episode.duration);
  renderStoryboard();
  const m = mix({ duration: ep!.episode.duration, cues: ep!.audio.cues, music: ep!.audio.music, ambience: ep!.audio.ambience, loudnessLufs: ep!.audio.loudnessLufs, duckingDb: ep!.audio.duckingDb, loop: true }, Object.fromEntries(Object.values(lib!.audio).map((a) => [a.id, a])));
  actx ??= new AudioContext({ sampleRate: 48000 });
  abuf = actx.createBuffer(2, m.left.length, 48000);
  abuf.copyToChannel(m.left as Float32Array<ArrayBuffer>, 0); abuf.copyToChannel(m.right as Float32Array<ArrayBuffer>, 1);
  seek(0);
}

function renderWarnings(v: any): void {
  const items = v.findings.filter((f: any) => f.severity !== 'info');
  $('warnings').innerHTML = (v.ok ? '<div class="ok">Validation passed</div>' : '<div class="err">Validation FAILED — render disabled</div>')
    + items.map((f: any) => `<div class="${f.severity}">${esc(f.severity)} ${esc(f.code)}: ${esc(f.message)}</div>`).join('')
    + v.repairs.map((r: string) => `<div class="info">auto-repair: ${esc(r)}</div>`).join('');
  ($('renderFinal') as HTMLButtonElement).disabled = ($('renderPreview') as HTMLButtonElement).disabled = !v.ok;
}

function renderStoryboard(): void {
  const e = ep!;
  $('title').textContent = `${e.episode.title} — ${e.episode.logline}`;
  $('board').innerHTML = e.beats.map((b) => {
    const shots = e.shots.filter((s) => s.start < b.end && s.end > b.start);
    const acts = e.actions.filter((a) => a.start < b.end && a.start >= b.start);
    const ex = [...e.expressions.filter((x) => x.at >= b.start && x.at < b.end).map((x) => `${x.actor}:${x.state}`), ...acts.filter((a) => a.expression).map((a) => `${a.actor}:${a.expression}`)];
    const pe = e.propEvents.filter((p) => p.start >= b.start && p.start < b.end).map((p) => `${p.prop}.${p.event}`);
    return `<div class="beat" data-t="${b.start}"><div class="bh"><b>${esc(b.id)}</b> ${esc(b.intent)} <span>${b.start.toFixed(2)}–${b.end.toFixed(2)}s</span></div>
      <div>${esc(b.summary)}</div>
      <div class="tags">cam: ${shots.map((s) => esc(s.preset)).join(', ')}</div>
      <div class="tags">act: ${acts.map((a) => esc(`${a.actor}.${a.action}`)).join(', ') || '—'}</div>
      <div class="tags">face: ${ex.map(esc).join(', ') || '—'}</div>
      <div class="tags">prop: ${pe.map(esc).join(', ') || '—'}</div></div>`;
  }).join('');
  for (const el of Array.from(document.querySelectorAll('.beat'))) (el as HTMLElement).onclick = () => seek(Number((el as HTMLElement).dataset.t));
}

function renderAssets(): void {
  const rows = [...Object.values(lib!.characters).map((c) => ['character', c.id, c.version, c.license.source]), ...Object.values(lib!.props).map((p) => ['prop', p.id, p.version, p.license.source]), ...Object.values(lib!.environments).map((e) => ['environment', e.id, e.version, e.license.source]), ...Object.values(lib!.audio).map((a) => ['audio', a.id, a.version, a.license.source])];
  $('assets').innerHTML = '<tr><th>kind</th><th>id</th><th>ver</th><th>license</th><th>lock</th></tr>' + rows.map(([k, id, v, l]) => {
    const dir = k === 'character' ? 'characters' : k === 'prop' ? 'props' : k === 'environment' ? 'environments' : 'audio';
    return `<tr><td>${k}</td><td>${esc(id)}</td><td>${v}</td><td>${esc(l)}</td><td>${(lib!.hashes[`${dir}/${id}@${v}`] ?? '').slice(0, 10)}</td></tr>`;
  }).join('');
}

function seek(x: number): void {
  t = Math.max(0, Math.min(ep!.episode.duration - 1e-3, x));
  if (playing) { stopAudio(); startAudio(); }
  draw();
}
function draw(): void {
  if (!prod || !renderer) return;
  const f = prod.render(renderer, t);
  ($('scrub') as HTMLInputElement).value = String(t);
  $('time').textContent = `${t.toFixed(2)}s  ${f.shot.id} ${f.shot.preset} — ${f.shot.purpose}`;
}
function startAudio(): void { if (!actx || !abuf) return; asrc = actx.createBufferSource(); asrc.buffer = abuf; asrc.loop = true; asrc.connect(actx.destination); asrc.start(0, t); }
function stopAudio(): void { try { asrc?.stop(); } catch { /* not started */ } asrc = null; }
function toggle(): void { playing = !playing; $('play').textContent = playing ? 'Pause' : 'Play'; if (playing) { void actx?.resume(); startAudio(); last = performance.now(); } else stopAudio(); }
function loop(now: number): void {
  if (playing && ep) { t += (now - last) / 1000; if (t >= ep.episode.duration) t -= ep.episode.duration; draw(); }
  last = now;
  requestAnimationFrame(loop);
}

async function startRender(scale: number): Promise<void> {
  await api('/api/render', { method: 'POST', body: JSON.stringify({ episode: ($('episodes') as HTMLSelectElement).value, scale }) });
  pollJobs();
}
async function duplicate(): Promise<void> {
  const name = prompt('New episode id (lowercase, dashes):', `${ep!.episode.id}-copy`);
  if (!name) return;
  const copy = JSON.parse(JSON.stringify(ep)); copy.episode.id = name; copy.episode.seed = (copy.episode.seed + 1) % 2147483647;
  const r = await api(`/api/episodes/${name}`, { method: 'PUT', body: JSON.stringify(copy) });
  alert(r.saved ? `Saved episodes/${name}.json (new seed ${copy.episode.seed})` : `Rejected: ${JSON.stringify(r.findings?.filter((f: any) => f.severity === 'error'))}`);
  if (r.saved) location.reload();
}
async function pollJobs(): Promise<void> {
  const jobs = await api('/api/jobs');
  $('jobs').innerHTML = jobs.slice().reverse().map((j: any) => {
    const pct = j.total ? Math.round((100 * j.done) / j.total) : 0;
    const links = j.outputs ? Object.entries(j.outputs).map(([k, u]) => `<a href="${esc(u)}" download>${esc(k)}</a>`).join(' · ') : '';
    const video = j.outputs?.mp4 ? `<video src="${esc(j.outputs.mp4)}" controls loop muted playsinline></video>` : '';
    return `<div class="job"><b>${esc(j.id)}</b> ${esc(j.episode)} @${j.scale}x — ${esc(j.state)} ${j.state === 'running' ? `${esc(j.phase)} ${pct}%` : ''} ${j.gates ? `gates ${esc(j.gates)}` : ''} ${j.error ? `<span class="err">${esc(j.error)}</span>` : ''}<div>${links}</div>${video}</div>`;
  }).join('') || '<i>No renders yet.</i>';
  if (jobs.some((j: any) => j.state === 'running' || j.state === 'queued')) setTimeout(pollJobs, 1500);
}

void init();
