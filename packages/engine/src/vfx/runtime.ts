// VFX runtime (S7): evaluates beat-sheet `vfx` events against VFX_DEFS and merges them into one frame contribution.
// Pure and random-access: the result depends only on (events, t, resolve, seed).
import type { CameraState, Particle, PostFx } from '../gl/renderer.ts';
import type { RGB } from '../gl/scene.ts';
import { clamp, hashSeed, type Vec3 } from '../math.ts';
import { VFX_DEFS, type EmoteContribution, type VfxParams } from './defs.ts';

/** a beat-sheet `vfx` event (packages/director/src/beat-sheet.ts) plus optional params */
export interface VfxEvent { vfxId: string; at: number; duration?: number; target?: string; params?: VfxParams }
export interface MergedVfxFrame {
  particles: Particle[];
  post: PostFx;
  shake: number;
  /** multiply into the camera: fovY / zoom (1 = no zoom) */
  zoom: number;
  emotes: EmoteContribution[];
  lights: Array<{ target: string; intensity: number; color: RGB }>;
  /** events that were active but could not draw (unknown ID, or a world effect whose target did not resolve) */
  skipped: Array<{ index: number; vfxId: string; reason: 'unknown_id' | 'unresolved_target' }>;
}
export const BASE_VIGNETTE = 0.32;

/**
 * Evaluate every event at time t. `resolve(target, t)` returns the target's world anchor (the engine's
 * Production.point: characters resolve to their face point, props to their anchor).
 */
export function evalVfxEvents(events: readonly VfxEvent[], t: number, resolve: (id: string, t: number) => Vec3 | undefined, seed: number): MergedVfxFrame {
  const out: MergedVfxFrame = { particles: [], post: { vignette: BASE_VIGNETTE, flash: 0, darken: 0 }, shake: 0, zoom: 1, emotes: [], lights: [], skipped: [] };
  events.forEach((e, index) => {
    const def = VFX_DEFS[e.vfxId];
    const lt = t - e.at;
    if (lt < 0) return;
    if (!def) { out.skipped.push({ index, vfxId: e.vfxId, reason: 'unknown_id' }); return; }
    const d = Math.max(0.01, e.duration ?? def.duration);
    if (lt > d + def.tail) return;
    // anchor sampled at the event time (bursts stay where they started); speed_lines follows its target
    const at = e.target ? resolve(e.target, e.vfxId === 'speed_lines' ? t : e.at) : undefined;
    if (def.needsTarget && !at) { out.skipped.push({ index, vfxId: e.vfxId, reason: 'unresolved_target' }); return; }
    const c = def['eval']({ lt, d, u: clamp(lt / d, 0, 1), at, seed: (hashSeed(`${e.vfxId}:${index}`) ^ seed) >>> 0, params: e.params ?? {} });
    if (c.particles) for (const p of c.particles) out.particles.push(p);
    if (c.post) {
      if (c.post.flash !== undefined) out.post.flash = Math.max(out.post.flash, c.post.flash);
      if (c.post.darken !== undefined) out.post.darken = Math.max(out.post.darken ?? 0, c.post.darken);
      if (c.post.vignette !== undefined) out.post.vignette = Math.max(out.post.vignette, c.post.vignette);
      if (c.post.tint) { const a = out.post.tint ?? [1, 1, 1]; out.post.tint = [a[0] * c.post.tint[0], a[1] * c.post.tint[1], a[2] * c.post.tint[2]]; }
    }
    if (c.shake) out.shake = Math.max(out.shake, c.shake);
    if (c.zoom) out.zoom *= c.zoom;
    const target = e.target ?? '';
    if (c.emotes) for (const m of c.emotes) if (m.scale > 0.01) out.emotes.push({ ...m, target });
    if (c.lights) for (const l of c.lights) out.lights.push({ ...l, target });
  });
  return out;
}

/** apply a merged zoom factor to a camera (narrower FOV = punch in) */
export const applyZoom = (cam: CameraState, zoom: number): CameraState => (zoom === 1 ? cam : { ...cam, fovY: 2 * Math.atan(Math.tan(cam.fovY / 2) / Math.max(0.2, zoom)) });

/** beat-sheet beats -> flat VFX event list (vfx events only; text graphics and SFX are handled by captions / audio-mix) */
export function vfxEventsFromBeats(beats: ReadonlyArray<{ events: ReadonlyArray<{ type: string; at: number } & Record<string, unknown>> }>): VfxEvent[] {
  const out: VfxEvent[] = [];
  for (const b of beats) for (const e of b.events) if (e.type === 'vfx') out.push({ vfxId: String(e.vfxId), at: e.at, duration: e.duration as number | undefined, target: e.target as string | undefined });
  return out;
}
