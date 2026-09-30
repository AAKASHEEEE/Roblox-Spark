// SFX library (S7): one SfxDef per LIBRARY.sfx ID, available and planned.
// Sources are `id@x.y.z` refs. They resolve first to a locked audio manifest (assets/audio, rendered by
// packages/audio PATCHES) and then to an S7 recipe below (rendered by ./patches.ts). whoosh and boing wrap the existing
// assets as the library entries allow. Music is NOT an SFX: music refs are never resolvable here.
import type { SfxDef } from '../../library/src/types.ts';
import { PATCHES } from '../../audio/src/synth.ts';
import { S7_PATCHES } from './patches.ts';

export interface AudioRecipe { id: string; version: string; category: 'sfx'; synth: string; params: Record<string, number> }
/** audio manifests as loaded by apps/render-worker/lib/library.ts (keyed `id@version`) */
export type AudioAssets = Readonly<Record<string, { id: string; category: string; synth: string; params: Record<string, number> }>>;

const rec = (id: string, params: Record<string, number> = {}): [string, AudioRecipe] => [`${id}@1.0.0`, { id, version: '1.0.0', category: 'sfx', synth: id, params }];
/** S7 procedural recipes for planned SFX (not asset files; reported to S0 as the `source` for the status flip) */
export const S7_RECIPES: Readonly<Record<string, AudioRecipe>> = Object.freeze(Object.fromEntries([
  rec('door_open', { seed: 31 }), rec('door_slam', { seed: 32 }), rec('footsteps', { seed: 33, steps: 4, gap: 0.3 }), rec('pop', { seed: 34 }),
  rec('gasp', { seed: 35 }), rec('crowd_laugh', { seed: 36, voices: 12 }), rec('bell', { seed: 37 }), rec('phone_ring', {}), rec('notification', {}),
]));

const def = (id: string, sources: string[], gainDb: number, pitchJitter?: number): SfxDef => ({ id, version: '1.0.0', kind: 'sfx', sources, gainDb, ...(pitchJitter ? { pitchJitter } : {}) });
const asset = (id: string, gainDb: number, jitter?: number) => def(id, [`${id}@1.0.0`], gainDb, jitter);
/**
 * gainDb is relative to the SFX reference level (every cue is first loudness-matched, see mix.ts), so it only
 * expresses "a bit louder / softer than a normal cue". Big impacts are allowed a little more, ticks and steps less.
 */
export const SFX_DEFS: Readonly<Record<string, SfxDef>> = Object.freeze(Object.fromEntries([
  asset('sfx_beep', -2), asset('sfx_blip_dots', -3), asset('sfx_blip_question', -2), asset('sfx_boing', 0, 0.5), asset('sfx_click', -1, 0.5),
  asset('sfx_coin_ding', -1), asset('sfx_coin_pop', 0, 0.5), asset('sfx_coin_spin', -3), asset('sfx_creak', -2), asset('sfx_deflate_slide', 0),
  asset('sfx_ding_reset', -1), asset('sfx_footstep', -5, 1), asset('sfx_rumble', 0), asset('sfx_scrape', -2), asset('sfx_sparkle', -2),
  asset('sfx_tada', 0), asset('sfx_thud_big', 2), asset('sfx_thud_small', 0, 0.5), asset('sfx_whoosh', -1, 1),
  def('door_open', ['door_open@1.0.0'], -1), def('door_slam', ['door_slam@1.0.0'], 1), def('footsteps', ['footsteps@1.0.0'], -4, 0.5),
  def('whoosh', ['sfx_whoosh@1.0.0'], -1, 1), def('boing', ['sfx_boing@1.0.0'], 0, 0.5), def('pop', ['pop@1.0.0', 'sfx_coin_pop@1.0.0'], -1, 1),
  def('gasp', ['gasp@1.0.0'], -1), def('crowd_laugh', ['crowd_laugh@1.0.0'], 0), def('bell', ['bell@1.0.0'], -1),
  def('phone_ring', ['phone_ring@1.0.0'], -2), def('notification', ['notification@1.0.0'], -2),
].map((d) => [d.id, d])));
export const SFX_IDS: readonly string[] = Object.freeze(Object.keys(SFX_DEFS));
export const S7_NEW_SFX_IDS: readonly string[] = Object.freeze(['door_open', 'door_slam', 'footsteps', 'whoosh', 'boing', 'pop', 'gasp', 'crowd_laugh', 'bell', 'phone_ring', 'notification']);

function hash(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function resample(x: Float32Array, rate: number): Float32Array {
  if (Math.abs(rate - 1) < 1e-6) return x;
  const n = Math.floor(x.length / rate), o = new Float32Array(n);
  for (let i = 0; i < n; i++) { const p = i * rate, k = Math.floor(p), f = p - k; o[i] = (x[k] ?? 0) * (1 - f) + (x[k + 1] ?? 0) * f; }
  return o;
}

export interface RenderedCue { pcm: Float32Array; source: string; pitch: number }
/**
 * Render one cue: a bare ID or an explicit `id@x.y.z` ref. Picks a source deterministically from (seed, index) and
 * applies the def's pitch jitter. Returns null for unknown IDs, music refs, or unresolvable sources.
 */
export function renderSfx(ref: string, assets: AudioAssets, seed: number, index: number): RenderedCue | null {
  const [id, ver] = ref.split('@');
  const d = SFX_DEFS[id];
  if (!d) return null;
  const h = hash(`${id}:${index}:${seed}`);
  const source = ver ? `${id}@${ver}` : d.sources[h % d.sources.length];
  const a = assets[source], r = S7_RECIPES[source];
  let pcm: Float32Array | null = null;
  if (a && a.category === 'sfx' && PATCHES[a.synth]) pcm = PATCHES[a.synth](a.params);
  else if (r && S7_PATCHES[r.synth]) pcm = S7_PATCHES[r.synth](r.params);
  if (!pcm) return null;
  const j = d.pitchJitter ?? 0, semis = j ? (((h >>> 8) % 1000) / 999 * 2 - 1) * j : 0, pitch = Math.pow(2, semis / 12);
  return { pcm: resample(pcm, pitch), source, pitch: Math.round(pitch * 1e4) / 1e4 };
}
