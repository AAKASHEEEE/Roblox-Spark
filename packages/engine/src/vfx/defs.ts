// VFX library (S7): one VfxDef per LIBRARY.vfx ID (packages/library/src/ids.ts), available and planned.
// Every effect is a closed-form function of (lt, d, seed, params): no state, no wall clock, random-access safe, so any
// frame can be rendered in any order and golden hashes stay stable.
//   - available IDs wrap the legacy engine implementation (../vfx.ts) unchanged, so existing renders keep their pixels
//   - planned IDs (sparkle, smoke_puff, fire, explosion, zoom_punch, emote_*) are implemented here
import type { VfxDef, VfxFrameContribution } from '../../../library/src/types.ts';
import type { EpisodeVfx } from '../../../schema/src/episode.ts';
import type { Particle } from '../gl/renderer.ts';
import type { RGB } from '../gl/scene.ts';
import { clamp, noise1, rng, smooth, type Vec3 } from '../math.ts';
import { evalVfx } from '../vfx.ts';
import type { EmoteSymbol } from './emote-icons.ts';

/** Emote entry with optional screen-plane offset (head-local metres: +x = camera right, +y = up), roll and opacity. */
export interface EmoteContribution { target: string; symbol: EmoteSymbol | string; scale: number; offset?: [number, number]; rot?: number; alpha?: number }
/**
 * Superset of the S0 contract's VfxFrameContribution. `zoom` is a camera zoom factor (1 = none; apply as fovY / zoom),
 * needed by zoom_punch; the contract has no field for it yet (reported to S0).
 */
export interface VfxContribution extends VfxFrameContribution { emotes?: EmoteContribution[]; zoom?: number }
export type VfxParams = Record<string, number | string | boolean>;
export interface VfxEvalCtx { lt: number; d: number; u: number; at?: Vec3; seed: number; params: VfxParams }
export interface S7VfxDef extends VfxDef {
  /** seconds the effect may keep drawing after `d` (particle tails, fade-outs) */
  tail: number;
  /** world effects that cannot draw without a resolved anchor */
  needsTarget: boolean;
  eval: (ctx: VfxEvalCtx) => VfxContribution;
}

const num = (p: VfxParams, k: string, d: number): number => { const v = p[k]; const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN; return Number.isFinite(n) ? n : d; };
const lerpC = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const ramp = (stops: RGB[], t: number): RGB => { const x = clamp(t, 0, 1) * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x)); return lerpC(stops[i], stops[i + 1], x - i); };
/** pop-in with overshoot over `a` s, shrink-out over the last `o` s */
function popScale(lt: number, d: number, a = 0.18, o = 0.15, over = 1.28): number {
  if (lt < 0 || lt > d) return 0;
  const inS = lt < a ? (lt < a * 0.6 ? over * Math.sin((lt / (a * 0.6)) * Math.PI * 0.5) : over + (1 - over) * smooth((lt - a * 0.6) / (a * 0.4))) : 1;
  const outS = lt > d - o ? Math.max(0, (d - lt) / o) : 1;
  return inS * outS;
}

// ---------------------------------------------------------------- available: legacy wrappers
const LEGACY_TAIL: Record<string, number> = { sparkle_burst: 0.6, shadow_looming: 0.3 };
function legacy(id: EpisodeVfx['type'], duration: number, space: 'world' | 'screen', needsTarget: boolean): S7VfxDef {
  return {
    id, version: '1.0.0', kind: 'vfx', duration, space, tail: LEGACY_TAIL[id] ?? 0, needsTarget,
    eval: (c) => {
      const params: Record<string, number> = {};
      for (const [k, v] of Object.entries(c.params)) if (typeof v === 'number') params[k] = v;
      const ev = { type: id, at: 0, duration: c.d, target: 'at', params } as EpisodeVfx;
      if (id === 'emote') (ev as { params: Record<string, unknown> }).params = { ...params, symbol: String(c.params.symbol ?? '!') };
      // legacy seeds per event as hashSeed(`${type}:${idx}`) ^ seed; the runtime already mixes the event index into c.seed
      const f = evalVfx([ev], c.lt, () => c.at, c.seed);
      const out: VfxContribution = {};
      if (f.particles.length) out.particles = f.particles;
      if (f.post.flash || f.post.darken || f.post.vignette !== 0.32) out.post = f.post;
      if (f.shake) out.shake = f.shake;
      if (f.emotes.length) out.emotes = f.emotes;
      if (f.lights.length) out.lights = f.lights;
      return out;
    },
  };
}

// ---------------------------------------------------------------- planned: particles
const GOLD: RGB[] = [[1, 0.8, 0.15], [1, 0.95, 0.6], [1, 1, 1], [1, 0.9, 0.35]];

const sparkle: S7VfxDef = {
  id: 'sparkle', version: '1.0.0', kind: 'vfx', duration: 1.2, space: 'world', tail: 0, needsTarget: true,
  // v2 of sparkle_burst: stars twinkle on an orbiting shell around the target instead of a single burst
  eval: ({ lt, d, at, seed, params }) => {
    if (!at || lt > d) return {};
    const n = num(params, 'count', 18), R = num(params, 'radius', 0.32), size = num(params, 'size', 0.05);
    const r = rng(seed), parts: Particle[] = [];
    for (let i = 0; i < n; i++) {
      const th = r() * Math.PI * 2, el = (r() - 0.35) * 1.2, delay = r() * d * 0.45, life = d * (0.3 + r() * 0.35), rr = R * (0.7 + r() * 0.5);
      const k = (lt - delay) / life;
      if (k < 0 || k > 1) continue;
      const a = th + lt * 0.9;
      const tw = Math.sin(Math.PI * k);
      parts.push({ pos: [at[0] + Math.cos(a) * Math.cos(el) * rr, at[1] + Math.sin(el) * rr + 0.18 * lt, at[2] + Math.sin(a) * Math.cos(el) * rr], size: size * (0.6 + r() * 0.8) * tw * (1 + 0.25 * Math.sin(lt * 24 + i)), color: GOLD[i % GOLD.length], alpha: tw, shape: 1, rot: a * 0.5 });
    }
    return { particles: parts, lights: [{ target: '', intensity: 0.5 * (1 - lt / d), color: [1, 0.85, 0.4] }] };
  },
};

const smokePuff: S7VfxDef = {
  id: 'smoke_puff', version: '1.0.0', kind: 'vfx', duration: 0.9, space: 'world', tail: 0, needsTarget: true,
  // "poof": a white core flash, then grey puffs billow outwards and up and thin out
  eval: ({ lt, d, at, seed, params }) => {
    if (!at || lt > d) return {};
    const u = lt / d, n = num(params, 'count', 18), R = num(params, 'radius', 0.55), s0 = num(params, 'size', 0.2);
    const r = rng(seed), parts: Particle[] = [];
    if (lt < 0.1) parts.push({ pos: [at[0], at[1] + 0.05, at[2]], size: s0 * (1.5 + lt * 12), color: [1, 1, 1], alpha: 0.9 * (1 - lt / 0.1), shape: 0 });
    for (let i = 0; i < n; i++) {
      const th = (i / n) * Math.PI * 2 + r() * 0.5, up = r() * 0.8, rr = R * (0.55 + r() * 0.6) * (1 - (1 - u) ** 3);
      const dir: Vec3 = [Math.cos(th) * (1 - up * 0.5), up, Math.sin(th) * (1 - up * 0.5)];
      parts.push({ pos: [at[0] + dir[0] * rr, at[1] + 0.05 + dir[1] * rr + 0.3 * u * u, at[2] + dir[2] * rr * 0.8], size: s0 * (0.55 + 1.5 * u) * (0.7 + r() * 0.6), color: lerpC([0.9, 0.9, 0.92], [0.62, 0.62, 0.67], u), alpha: 0.85 * (1 - u) ** 1.3, shape: 0 });
    }
    return { particles: parts };
  },
};

const FLAME: RGB[] = [[1, 0.97, 0.75], [1, 0.78, 0.2], [1, 0.42, 0.06], [0.75, 0.12, 0.04]];
const fire: S7VfxDef = {
  id: 'fire', version: '1.0.0', kind: 'vfx', duration: 2.5, space: 'world', tail: 0.35, needsTarget: true,
  // looping flame column: every particle cycles base -> tip with its own rate and phase; fades in/out at the ends
  eval: ({ lt, d, at, seed, params }) => {
    if (!at) return {};
    const env = Math.min(1, lt / 0.25) * (lt > d ? Math.max(0, 1 - (lt - d) / 0.35) : 1);
    if (env <= 0) return {};
    const S = num(params, 'size', 1), H = num(params, 'height', 0.55) * S, W = num(params, 'width', 0.22) * S, n = num(params, 'count', 40);
    const r = rng(seed), parts: Particle[] = [];
    for (let i = 0; i < n; i++) {
      const rate = 1.4 + r() * 1.1, ph0 = r(), ox = (r() - 0.5) * W, oz = (r() - 0.5) * W * 0.6, wob = r() * 6;
      const ph = (lt * rate + ph0) % 1;
      const narrow = 1 - ph * 0.8;
      parts.push({ pos: [at[0] + ox * narrow + 0.03 * S * Math.sin(lt * 9 + wob), at[1] + ph * H, at[2] + oz * narrow], size: 0.09 * S * (1 - ph) ** 0.6 * (0.7 + 0.5 * r()), color: ramp(FLAME, ph), alpha: 0.9 * env * (1 - ph) ** 1.1, shape: 0 });
    }
    for (let i = 0; i < 10; i++) { // smoke above the tips
      const ph = (lt * 0.6 + r()) % 1;
      parts.push({ pos: [at[0] + (r() - 0.5) * W * 0.6 + 0.06 * Math.sin(lt * 2 + i), at[1] + H * (0.8 + ph * 0.9), at[2]], size: 0.12 * S * (0.6 + ph), color: [0.22, 0.2, 0.2], alpha: 0.35 * env * Math.sin(Math.PI * ph), shape: 0 });
    }
    for (let i = 0; i < 6; i++) { // embers
      const ph = (lt * (0.8 + r() * 0.6) + r()) % 1;
      parts.push({ pos: [at[0] + (r() - 0.5) * W + 0.08 * Math.sin(lt * 5 + i * 2), at[1] + ph * H * 1.8, at[2] + (r() - 0.5) * W * 0.4], size: 0.018 * S, color: [1, 0.7, 0.25], alpha: env * (1 - ph), shape: 1, rot: lt * 4 + i });
    }
    const flick = 0.75 + 0.25 * noise1(lt * 11, seed);
    return { particles: parts, lights: [{ target: '', intensity: 1.1 * env * flick, color: [1, 0.55, 0.2] }] };
  },
};

const explosion: S7VfxDef = {
  id: 'explosion', version: '1.0.0', kind: 'vfx', duration: 1.4, space: 'world', tail: 0, needsTarget: true,
  // cartoon blast: white flash + shake, expanding fireball, ballistic debris, shock ring, rising smoke
  eval: ({ lt, d, at, seed, params }) => {
    if (lt > d) return {};
    const S = num(params, 'size', 1);
    const out: VfxContribution = { post: { flash: lt < 0.25 ? 0.85 * (1 - lt / 0.25) ** 2 : 0 }, shake: lt < 0.6 ? 0.1 * S * (1 - lt / 0.6) ** 2 : 0 };
    if (!at) return out;
    const r = rng(seed), parts: Particle[] = [];
    const fbU = Math.min(1, lt / 0.7);
    if (fbU < 1) for (let i = 0; i < 30; i++) {
      const th = r() * Math.PI * 2, el = r() * Math.PI * 0.5, sp = (0.5 + r() * 0.6) * S;
      const rr = sp * (1 - Math.exp(-lt * 9));
      parts.push({ pos: [at[0] + Math.cos(th) * Math.cos(el) * rr, at[1] + 0.15 * S + Math.sin(el) * rr * 0.9, at[2] + Math.sin(th) * Math.cos(el) * rr], size: 0.2 * S * (0.6 + r() * 0.6) * (1 - 0.4 * fbU), color: ramp([[1, 1, 0.9], [1, 0.85, 0.3], [1, 0.45, 0.08], [0.55, 0.12, 0.05]], fbU + r() * 0.15), alpha: (1 - fbU) ** 0.8, shape: 0 });
    }
    for (let i = 0; i < 16; i++) {
      const vx = (r() - 0.5) * 4 * S, vy = (1.5 + r() * 2.5) * S, vz = (r() - 0.5) * 2 * S;
      const y = at[1] + vy * lt - 4.9 * lt * lt;
      if (y < 0.01) continue;
      parts.push({ pos: [at[0] + vx * lt, y, at[2] + vz * lt], size: 0.035 * S, color: i % 2 ? [0.3, 0.25, 0.2] : [0.5, 0.45, 0.4], alpha: 1 - lt / d, shape: 2, rot: lt * 10 + i });
    }
    if (lt < 0.5) parts.push({ pos: [at[0], at[1] + 0.1, at[2]], size: S * (0.3 + 2.4 * lt), color: [1, 0.95, 0.8], alpha: 0.8 * (1 - lt / 0.5), shape: 3 });
    for (let i = 0; i < 14; i++) {
      const k = (lt - 0.2 - r() * 0.2) / (d - 0.4);
      const ox = (r() - 0.5) * 0.9 * S, oz = (r() - 0.5) * 0.5 * S;
      if (k < 0 || k > 1) continue;
      parts.push({ pos: [at[0] + ox * (0.6 + k), at[1] + 0.3 * S + k * 0.9 * S, at[2] + oz], size: 0.22 * S * (0.7 + k), color: [0.3, 0.29, 0.3], alpha: 0.6 * Math.sin(Math.PI * k), shape: 0 });
    }
    out.particles = parts;
    out.lights = [{ target: '', intensity: 2.2 * Math.max(0, 1 - lt / 0.6), color: [1, 0.6, 0.25] }];
    return out;
  },
};

// ---------------------------------------------------------------- planned: screen
const zoomPunch: S7VfxDef = {
  id: 'zoom_punch', version: '1.0.0', kind: 'vfx', duration: 0.45, space: 'screen', tail: 0, needsTarget: false,
  // snap zoom in over 70 ms, ease back to 1 by the end; a touch of shake and vignette sells the hit
  eval: ({ lt, d, params }) => {
    if (lt > d) return {};
    const A = num(params, 'strength', 0.16), a = Math.min(0.07, d * 0.3);
    const k = lt < a ? Math.sin((lt / a) * Math.PI * 0.5) : 1 - smooth((lt - a) / (d - a));
    return { zoom: 1 + A * k, shake: 0.015 * k, post: { vignette: 0.32 + 0.18 * k } };
  },
};

// ---------------------------------------------------------------- planned: emotes
const emote = (id: string, duration: number, fn: (lt: number, d: number, seed: number, at?: Vec3) => VfxContribution): S7VfxDef =>
  ({ id, version: '1.0.0', kind: 'vfx', duration, space: 'world', tail: 0, needsTarget: true, eval: ({ lt, d, seed, at }) => (lt > d ? {} : fn(lt, d, seed, at)) });

const EMOTES: S7VfxDef[] = [
  emote('emote_exclaim', 1.1, (lt, d) => {
    const s = popScale(lt, d, 0.16, 0.14, 1.35), jolt = lt < 0.3 ? Math.sin((lt / 0.3) * Math.PI) * 0.06 : 0;
    return { emotes: [{ target: '', symbol: 'exclaim', scale: s, offset: [0.1, 0.3 + jolt], rot: 0.14 * Math.sin(lt * 40) * Math.exp(-lt * 7) }] };
  }),
  emote('emote_question', 1.3, (lt, d) => ({ emotes: [{ target: '', symbol: 'question', scale: popScale(lt, d, 0.2, 0.15, 1.2), offset: [0.1, 0.3 + 0.02 * Math.sin(lt * 5)], rot: 0.2 * Math.sin(lt * 5.5) }] })),
  emote('emote_sweat', 1.4, (lt, d) => {
    const u = lt / d, slide = 0.14 * u * u;
    return { emotes: [{ target: '', symbol: 'sweat', scale: 0.95 * popScale(lt, d, 0.14, 0.01, 1.15), offset: [0.18, 0.12 - slide], alpha: lt > d - 0.3 ? Math.max(0, (d - lt) / 0.3) : 1 }] };
  }),
  emote('emote_anger', 1.3, (lt, d) => {
    const throb = 1 + 0.18 * Math.max(0, Math.sin(lt * Math.PI * 2 * 3));
    return { emotes: [{ target: '', symbol: 'anger', scale: 0.62 * popScale(lt, d, 0.16, 0.14, 1.25) * throb, offset: [0.2, 0.22] }] };
  }),
  emote('emote_hearts', 1.8, (lt, d) => {
    const out: EmoteContribution[] = [];
    for (let k = 0; k < 3; k++) {
      const t0 = k * 0.28, life = d - t0, l = lt - t0;
      if (l < 0 || l > life) continue;
      const u = l / life;
      out.push({ target: '', symbol: 'hearts', scale: (0.42 - 0.07 * k) * popScale(l, life, 0.18, 0.3, 1.2), offset: [(k - 1) * 0.16 + 0.05 * Math.sin(l * 4 + k * 2), 0.22 + 0.34 * u], alpha: 1 - u * u });
    }
    return { emotes: out };
  }),
  emote('emote_tears', 1.8, (lt, d, seed, at) => {
    const out: VfxContribution = { emotes: [{ target: '', symbol: 'tears', scale: 0.9 * popScale(lt, d, 0.2, 0.25, 1.1), offset: [0, 0.04 + 0.01 * Math.sin(lt * 9)] }] };
    if (at) {
      // falling drops from both eyes (at = the target's face point)
      const r = rng(seed), parts: Particle[] = [];
      for (let i = 0; i < 12; i++) {
        const side = i % 2 ? 1 : -1, ph = (lt * 1.6 + r()) % 1, vx = side * (0.1 + r() * 0.08);
        parts.push({ pos: [at[0] + side * 0.1 + vx * ph, at[1] - 0.02 + 0.08 * ph - 0.6 * ph * ph, at[2] + 0.02], size: 0.022, color: [0.45, 0.78, 1], alpha: 0.9 * (1 - ph) * Math.min(1, lt / 0.2) * Math.min(1, (d - lt) / 0.2), shape: 0 });
      }
      out.particles = parts;
    }
    return out;
  }),
];

export const VFX_DEFS: Readonly<Record<string, S7VfxDef>> = Object.freeze(Object.fromEntries([
  legacy('sparkle_burst', 0.9, 'world', true), legacy('dust_puff', 0.8, 'world', true), legacy('impact_ring', 0.35, 'world', true),
  legacy('confetti', 1.6, 'world', true), legacy('emote', 0.8, 'world', false), legacy('screen_flash', 0.25, 'screen', false),
  legacy('screen_shake', 0.5, 'screen', false), legacy('glow_pulse', 1.5, 'world', false), legacy('shadow_looming', 1.2, 'screen', false),
  legacy('speed_lines', 0.6, 'world', true),
  sparkle, smokePuff, fire, explosion, zoomPunch, ...EMOTES,
].map((d) => [d.id, d])));
export const VFX_IDS: readonly string[] = Object.freeze(Object.keys(VFX_DEFS));
/** IDs implemented here that the library still lists as planned (for the S0 status-flip report) */
export const S7_NEW_VFX_IDS: readonly string[] = Object.freeze(['sparkle', 'smoke_puff', 'fire', 'explosion', 'zoom_punch', 'emote_exclaim', 'emote_question', 'emote_sweat', 'emote_anger', 'emote_hearts', 'emote_tears']);
