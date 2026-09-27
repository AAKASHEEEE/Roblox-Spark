// Deterministic VFX: every particle is a closed-form function of (t - t0, seeded params). Random access safe.
import type { EpisodeVfx } from '../../schema/src/episode.ts';
import type { Particle, PostFx } from './gl/renderer.ts';
import { hashSeed, noise1, rng, type Vec3 } from './math.ts';
import type { RGB } from './gl/scene.ts';

export interface VfxFrame { particles: Particle[]; post: PostFx; shake: number; emotes: Array<{ target: string; symbol: string; scale: number }>; lights: Array<{ target: string; intensity: number; color: RGB }> }

const GOLD: RGB[] = [[1, 0.78, 0.1], [1, 0.95, 0.55], [1, 1, 1]];
const CONFETTI: RGB[] = [[0.1, 0.8, 0.9], [1, 0.8, 0.1], [0.95, 0.2, 0.5], [0.3, 0.9, 0.4], [0.3, 0.45, 1]];

export function evalVfx(events: EpisodeVfx[], t: number, resolve: (id: string, t: number) => Vec3 | undefined, seed: number): VfxFrame {
  const out: VfxFrame = { particles: [], post: { vignette: 0.32, flash: 0, darken: 0 }, shake: 0, emotes: [], lights: [] };
  events.forEach((e, idx) => {
    const lt = t - e.at;
    const P = e.params ?? {};
    if (lt < 0) return;
    const life = Math.max(e.duration, 0.01);
    const s = hashSeed(`${e.type}:${idx}`) ^ seed;
    switch (e.type) {
      case 'sparkle_burst': {
        if (lt > life + 0.6) return;
        const c = e.target ? resolve(e.target, e.at) : undefined; if (!c) return;
        const n = Number(P.count ?? 26), speed = Number(P.speed ?? 1.4), size = Number(P.size ?? 0.035);
        const r = rng(s);
        for (let i = 0; i < n; i++) {
          const th = r() * Math.PI * 2, ph = r() * Math.PI * 0.5, v = speed * (0.5 + r() * 0.7), pl = life * (0.6 + r() * 0.6);
          if (lt > pl) continue;
          const dir: Vec3 = [Math.cos(th) * Math.cos(ph), Math.sin(ph) + 0.4, Math.sin(th) * Math.cos(ph)];
          const k = lt * (1 - lt / (2.2 * pl));
          out.particles.push({ pos: [c[0] + dir[0] * v * k, c[1] + dir[1] * v * k - 1.2 * lt * lt, c[2] + dir[2] * v * k], size: size * (1 - lt / pl) * (0.7 + r() * 0.8) * (1 + 0.3 * Math.sin(lt * 30 + i)), color: GOLD[i % 3], alpha: 1 - (lt / pl) ** 2, shape: 1, rot: r() * 3 });
        }
        break;
      }
      case 'dust_puff': {
        if (lt > life) return;
        const c = e.target ? resolve(e.target, e.at) : undefined; if (!c) return;
        const n = Number(P.count ?? 22), rad = Number(P.radius ?? 0.8), size = Number(P.size ?? 0.18);
        const r = rng(s);
        const u = lt / life;
        for (let i = 0; i < n; i++) {
          const th = (i / n) * Math.PI * 2 + r() * 0.3, spread = rad * (0.6 + r() * 0.5) * (1 - (1 - u) ** 3);
          out.particles.push({ pos: [c[0] + Math.cos(th) * spread, c[1] + 0.05 + u * 0.25 * r() + r() * 0.1, c[2] + Math.sin(th) * spread * 0.7], size: size * (0.6 + u * 1.4) * (0.7 + r() * 0.6), color: [0.82, 0.76, 0.66], alpha: 0.75 * (1 - u) ** 1.5, shape: 0 });
        }
        break;
      }
      case 'impact_ring': {
        if (lt > life) return;
        const c = e.target ? resolve(e.target, e.at) : undefined; if (!c) return;
        const u = lt / life;
        out.particles.push({ pos: c, size: Number(P.size ?? 0.6) * (0.3 + u * 1.4), color: [1, 1, 1], alpha: (1 - u) * 0.9, shape: 3 });
        break;
      }
      case 'confetti': {
        if (lt > life) return;
        const c = e.target ? resolve(e.target, e.at) : undefined; if (!c) return;
        const n = Number(P.count ?? 40); const r = rng(s);
        for (let i = 0; i < n; i++) {
          const vx = (r() - 0.5) * 2.4, vy = 2 + r() * 2, vz = (r() - 0.5) * 1.2;
          const tt = Math.min(lt, life);
          const y = c[1] + vy * tt - 3 * tt * tt;
          out.particles.push({ pos: [c[0] + vx * tt + 0.1 * Math.sin(tt * 9 + i), Math.max(0.02, y), c[2] + vz * tt], size: 0.03, color: CONFETTI[i % CONFETTI.length], alpha: 1 - (lt / life) ** 4, shape: 2, rot: tt * 8 + i });
        }
        break;
      }
      case 'emote': {
        if (lt > life) return;
        const u = lt / life;
        const pop = lt < 0.18 ? 1.25 * Math.sin((lt / 0.18) * Math.PI * 0.5) : lt > life - 0.15 ? Math.max(0, (life - lt) / 0.15) : 1 + 0.06 * Math.sin(lt * 12);
        out.emotes.push({ target: e.target ?? '', symbol: String(P.symbol ?? '!'), scale: pop * (u >= 0 ? 1 : 0) });
        break;
      }
      case 'screen_flash': {
        if (lt > life) return;
        out.post.flash = Math.max(out.post.flash, Number(P.strength ?? 0.6) * (1 - lt / life) ** 2);
        break;
      }
      case 'screen_shake': {
        if (lt > life) return;
        out.shake = Math.max(out.shake, Number(P.strength ?? 0.05) * (1 - lt / life) ** 2);
        break;
      }
      case 'glow_pulse': {
        if (lt > life) return;
        const hz = Number(P.hz ?? 3);
        out.lights.push({ target: e.target ?? '', intensity: Number(P.intensity ?? 1.2) * (0.5 + 0.5 * Math.cos(lt * Math.PI * 2 * hz)), color: [1, 0.25, 0.2] });
        break;
      }
      case 'shadow_looming': {
        const u = Math.min(1, lt / Math.max(0.01, Number(P.rampIn ?? life)));
        const fade = lt > life ? Math.max(0, 1 - (lt - life) / Number(P.fadeOut ?? 0.3)) : 1;
        out.post.darken = Math.max(out.post.darken ?? 0, Number(P.strength ?? 0.35) * u * fade);
        out.post.vignette = Math.max(out.post.vignette, 0.32 + 0.35 * u * fade);
        break;
      }
      case 'speed_lines': {
        if (lt > life) return;
        const c = e.target ? resolve(e.target, t) : undefined; if (!c) return;
        const r = rng(s);
        for (let i = 0; i < 14; i++) {
          const ph = (lt * 3 + r()) % 1;
          out.particles.push({ pos: [c[0] + (r() - 0.5) * 0.6, c[1] + 0.2 + r() * 1.2, c[2] - 0.4 - ph * 1.2], size: 0.03, color: [1, 1, 1], alpha: 0.7 * (1 - ph), shape: 0 });
        }
        break;
      }
    }
  });
  void noise1;
  return out;
}
