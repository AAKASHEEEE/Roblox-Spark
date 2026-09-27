// Prop state machine. Every prop event is a deterministic function of time; physics (coin spawn/bounce)
// is pre-simulated at a fixed 240 Hz step during compile and sampled during evaluation.
import type { EpisodePropEvent } from '../../schema/src/episode.ts';
import type { PropInstance } from './build.ts';
import { DEG, clamp, easeOutBack, easeInCubic, qEuler, qMul, type Quat, type Vec3, lerp } from './math.ts';

export interface PropState {
  pos: Vec3; // position of prop origin (world, or parent-local if attached)
  rotX: number; rotY: number; rotZ: number; // degrees; X = stand up (90 = upright), Y = spin/yaw, Z = wobble
  scale: number;
  visible: boolean;
  capDepth: number; // button press 0..1
  glow: number; // 0..1 emissive pulse
  upright: number; // 0..1 (for support height)
}

export interface ResolveFn { (id: string, t: number): Vec3 | undefined }

const PHYS_DT = 1 / 240;
const G = 9.81;

interface CompiledEvent { ev: EpisodePropEvent; base: PropState; physics?: Vec3[]; target?: Vec3; physicsSpin?: number[] }

export class PropTrack {
  events: CompiledEvent[] = [];
  initial: PropState;
  /** notable moments for audio/vfx sync and QA (e.g. landing impacts) */
  impacts: Array<{ t: number; kind: string; strength: number }> = [];

  readonly instance: string;
  readonly prop: PropInstance;
  private resolve: ResolveFn;
  constructor(instance: string, prop: PropInstance, initial: PropState, events: EpisodePropEvent[], resolve: ResolveFn) { this.instance = instance; this.prop = prop; this.resolve = resolve;
    this.initial = initial;
    const mine = events.filter((e) => e.prop === instance).sort((a, b) => a.start - b.start);
    for (const ev of mine) {
      const base = this.stateAt(ev.start);
      const ce: CompiledEvent = { ev, base };
      if (ev.to) ce.target = resolve(ev.to, ev.start);
      if (ev.event === 'spawn') this.simulateSpawn(ce);
      if (ev.event === 'tip_over') this.impacts.push({ t: ev.start + ev.duration, kind: 'tip_over', strength: base.scale });
      if (ev.event === 'hop_to') this.impacts.push({ t: ev.start + ev.duration, kind: 'land', strength: base.scale });
      this.events.push(ce);
    }
  }

  private halfHeight(s: PropState): number {
    const d = this.prop.manifest.dimensions;
    const flat = d[1] / 2, up = Math.max(d[0], d[2]) / 2;
    return lerp(flat, up, s.upright) * s.scale;
  }

  /** Deterministic ballistic pop + bounces (fixed-step semi-implicit Euler). */
  private simulateSpawn(ce: CompiledEvent): void {
    const from = ce.ev.params?.from ? this.resolve(String(ce.ev.params.from), ce.ev.start) : ce.base.pos;
    const to = ce.target ?? ce.base.pos;
    const flight = Number(ce.ev.params?.flight ?? 0.45);
    const rest = Number(ce.ev.params?.restitution ?? 0.42);
    const p: Vec3 = [...(from ?? to)] as Vec3;
    const floorY = to[1] + this.halfHeight(ce.base);
    const v: Vec3 = [(to[0] - p[0]) / flight, 0, (to[2] - p[2]) / flight];
    v[1] = (floorY - p[1] + 0.5 * G * flight * flight) / flight;
    const samples: Vec3[] = [], spin: number[] = [];
    let ang = 0, angV = 720 * (Number(ce.ev.params?.flips ?? 1) / flight);
    const steps = Math.ceil(ce.ev.duration / PHYS_DT) + 1;
    let landed = false;
    for (let i = 0; i < steps; i++) {
      samples.push([p[0], p[1], p[2]]); spin.push(ang);
      v[1] -= G * PHYS_DT;
      p[0] += v[0] * PHYS_DT; p[1] += v[1] * PHYS_DT; p[2] += v[2] * PHYS_DT;
      ang += angV * PHYS_DT;
      if (p[1] < floorY && v[1] < 0) {
        p[1] = floorY;
        if (!landed) { this.impacts.push({ t: ce.ev.start + i * PHYS_DT, kind: 'coin_land', strength: 1 }); landed = true; }
        else if (Math.abs(v[1]) > 0.4) this.impacts.push({ t: ce.ev.start + i * PHYS_DT, kind: 'coin_bounce', strength: Math.abs(v[1]) / 3 });
        v[1] = -v[1] * rest; v[0] *= 0.35; v[2] *= 0.35;
        if (Math.abs(v[1]) < 0.25) v[1] = 0;
        angV = 0; ang = Math.round(ang / 360) * 360; // lands flat face-up
      }
    }
    ce.physics = samples; ce.physicsSpin = spin;
  }

  stateAt(t: number): PropState {
    let s: PropState = { ...this.initial, pos: [...this.initial.pos] as Vec3 };
    for (const ce of this.events) {
      if (ce.ev.start > t) break;
      s = this.applyEvent(ce, s, Math.min(t - ce.ev.start, ce.ev.duration), t - ce.ev.start);
    }
    return s;
  }

  private applyEvent(ce: CompiledEvent, s: PropState, lt: number, rawLt: number): PropState {
    const { ev, base } = ce;
    const d = Math.max(ev.duration, 1e-4);
    const u = clamp(lt / d, 0, 1);
    const P = ev.params ?? {};
    const o: PropState = { ...s, pos: [...s.pos] as Vec3 };
    switch (ev.event) {
      case 'show': o.visible = true; break;
      case 'hide': o.visible = false; break;
      case 'spawn': {
        o.visible = true;
        const k = Math.min(ce.physics!.length - 1, Math.floor(lt / PHYS_DT));
        o.pos = [...ce.physics![k]] as Vec3;
        o.rotX = ce.physicsSpin![k];
        o.scale = base.scale * easeOutBack(Math.min(1, lt / 0.12), 2.5);
        break;
      }
      case 'press': o.capDepth = u < 0.25 ? u / 0.25 : 1; break;
      case 'reset': o.capDepth = 1 - easeOutBack(u, 3); break;
      case 'flash': {
        const hz = Number(P.hz ?? 3);
        o.glow = rawLt <= d ? 0.5 + 0.5 * Math.cos(2 * Math.PI * hz * lt) : Number(P.endGlow ?? 0);
        break;
      }
      case 'hop_to': {
        const to = ce.target ?? base.pos;
        const h = Number(P.height ?? 0.3);
        const hh = this.halfHeight(o);
        const y0 = base.pos[1], y1 = to[1] + hh;
        o.pos = [lerp(base.pos[0], to[0], u), lerp(y0, y1, u) + 4 * h * u * (1 - u), lerp(base.pos[2], to[2], u)];
        break;
      }
      case 'slide': {
        const to = ce.target ?? base.pos;
        const e = 1 - (1 - u) ** 3;
        o.pos = [lerp(base.pos[0], to[0], e), base.pos[1], lerp(base.pos[2], to[2], e)];
        o.rotY = base.rotY + Number(P.rotDeg ?? 0) * e;
        break;
      }
      case 'grow': {
        const target = Number(P.scale ?? base.scale * 2);
        const surfaceY = base.pos[1] - this.halfHeight(base);
        o.scale = lerp(base.scale, target, easeOutBack(u, Number(P.overshoot ?? 2.2)));
        o.pos = [base.pos[0], surfaceY + this.halfHeight(o), base.pos[2]];
        break;
      }
      case 'stand_up': {
        const surfaceY = base.pos[1] - this.halfHeight(base);
        o.upright = easeOutBack(u, 1.5);
        o.rotX = base.rotX + 90 * o.upright;
        o.rotY = lerp(base.rotY, Math.round(base.rotY / 360) * 360, clamp(u * 1.5, 0, 1)); // face the audience
        o.pos = [base.pos[0], surfaceY + this.halfHeight(o) + Math.sin(Math.PI * u) * 0.12 * base.scale, base.pos[2]];
        break;
      }
      case 'spin': o.rotY = base.rotY + Number(P.degPerSec ?? 360) * lt * (1 - 0.5 * u); break;
      case 'wobble': o.rotZ = Math.sin(lt * 2 * Math.PI * Number(P.hz ?? 3)) * Number(P.deg ?? 6) * (rawLt <= d ? 1 : 0); break;
      case 'tip_over': {
        // falls toward +z pivoting on its bottom edge; accelerating like a toppling body
        const R = this.halfHeight(base); // upright half-height = radius*scale
        const th = this.prop.manifest.dimensions[1] * base.scale / 2;
        const surfaceY = base.pos[1] - R;
        const endDeg = Number(P.endDeg ?? 90);
        const a = easeInCubic(u) * endDeg;
        const bounce = u >= 1 ? Math.max(0, Math.sin(Math.min(1, (rawLt - d) / 0.18) * Math.PI)) * 4 * Math.exp(-(rawLt - d) * 6) : 0;
        const ang = (a - bounce) * DEG;
        const pivot: Vec3 = [base.pos[0], surfaceY, base.pos[2] + th];
        o.pos = [pivot[0], pivot[1] + R * Math.cos(ang) + th * Math.sin(ang), pivot[2] + R * Math.sin(ang) - th * Math.cos(ang)];
        o.rotX = base.rotX + (a - bounce);
        o.upright = 1 - a / 90;
        if (u >= 1) o.upright = 1 - endDeg / 90;
        o.rotZ = 0;
        break;
      }
    }
    return o;
  }

  /** Apply state to nodes. */
  apply(t: number): PropState {
    const s = this.stateAt(t);
    const r = this.prop.root;
    r.visible = s.visible;
    r.pos = [...s.pos] as Vec3;
    const q: Quat = qMul(qEuler(0, s.rotY * DEG, 0), qMul(qEuler(s.rotX * DEG, 0, 0), qEuler(0, 0, s.rotZ * DEG)));
    r.rot = q;
    r.scl = [s.scale, s.scale, s.scale];
    const cap = this.prop.parts['cap'];
    if (cap) {
      const baseY = (this.prop.manifest.parts.find((p) => p.id === 'cap')!.pos[1]);
      cap.pos = [cap.pos[0], baseY - 0.028 * s.capDepth, cap.pos[2]];
      const g = s.glow;
      cap.material!.emissive = [0.9 * g + 0.08, 0.05 * g, 0.06 * g];
    }
    for (const lamp of ['lamp_l', 'lamp_r']) { const n = this.prop.parts[lamp]; if (n) n.material!.emissive = [0.05 * s.glow, 0.6 * s.glow + 0.05, 0.25 * s.glow]; }
    const disc = this.prop.parts['disc'];
    if (disc) disc.material!.emissive = [0.12 + 0.25 * s.glow, 0.08 + 0.16 * s.glow, 0.0];
    return s;
  }
}
