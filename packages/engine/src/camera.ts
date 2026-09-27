// Semantic camera presets for 9:16. Cameras are solved from subject positions at shot start (locked-off),
// with small, deliberate push/drift — never free-floating. Audience-side (+z) only to preserve the stage line.
import type { EpisodeShot } from '../../schema/src/episode.ts';
import type { CameraState } from './gl/renderer.ts';
import { DEG, add, clamp, cross, len, lerp3, noise1, norm, scale, sub, type Vec3, smooth, hashSeed } from './math.ts';

export interface SubjectInfo { kind: 'actor' | 'prop'; center: Vec3; head?: Vec3; top: Vec3; bottom: Vec3; radius: number; facingYaw?: number; faceYaw?: number }
export interface CameraQuery { subject(id: string, t: number): SubjectInfo | undefined }
export interface CameraEnv { safeMin: Vec3; safeMax: Vec3; colliders: Array<{ id: string; min: Vec3; max: Vec3 }> }

export const ASPECT = 9 / 16;
const hfovOf = (vfov: number) => 2 * Math.atan(Math.tan(vfov / 2) * ASPECT);

/** distance so that a sphere of radius r fills `fill` of the frame WIDTH (the tight axis in portrait) */
const fitWidth = (r: number, vfov: number, fill: number) => r / (Math.tan(hfovOf(vfov) / 2) * fill);

export interface SolvedShot { cam: CameraState; adjustments: string[] }

function audienceDir(yawDeg: number | undefined, bias = 0.55): Vec3 {
  // blend the subject's facing with the audience direction so faces read while staying on the +z side
  const f: Vec3 = yawDeg === undefined ? [0, 0, 1] : [Math.sin(yawDeg * DEG), 0, Math.cos(yawDeg * DEG)];
  const d = norm(add(scale(f, 1 - bias), [0, 0, bias]));
  return d[2] < 0.25 ? norm([d[0], 0, 0.25]) : d;
}

export function solveShot(shot: EpisodeShot, t: number, q: CameraQuery, env: CameraEnv, firstShot?: EpisodeShot): SolvedShot {
  const P = shot.params ?? {};
  const t0 = shot.start;
  const follow = P.follow === true || shot.preset === 'chase_cam';
  const at = follow ? t : Number(P.solveAt ?? t0);
  const subs = shot.subjects.map((id) => q.subject(id, at)).filter(Boolean) as SubjectInfo[];
  if (!subs.length) throw new Error(`shot ${shot.id}: no resolvable subjects`);
  const s0 = subs[0];
  const vfov = Number(P.fov ?? 38) * DEG;
  let pos: Vec3, target: Vec3, fov = vfov, roll = Number(P.roll ?? 0) * DEG;
  const yawOff = Number(P.yaw ?? 0) * DEG;
  const rotY = (v: Vec3, a: number): Vec3 => [v[0] * Math.cos(a) + v[2] * Math.sin(a), v[1], -v[0] * Math.sin(a) + v[2] * Math.cos(a)];

  if (shot.preset === 'final_loop') {
    if (!firstShot) throw new Error('final_loop requires the opening shot');
    // Re-solve the OPENING composition (no push) around the same subjects, then ease INTO it so the
    // last frame equals the first frame's framing => seamless loop.
    const open = solveShot({ ...firstShot, start: shot.start, end: shot.end, params: { ...(firstShot.params ?? {}), push: 0 } }, shot.start, q, env);
    const u = clamp((t - shot.start) / Math.max(0.01, shot.end - shot.start), 0, 1);
    const back = Number(P.pullback ?? 0.1) * (1 - smooth(u));
    const c = open.cam;
    return { cam: { ...c, pos: add(c.pos, scale(sub(c.pos, c.target), back)) }, adjustments: open.adjustments };
  }
  switch (shot.preset) {
    case 'prop_ecu': {
      const r = s0.radius;
      const dist = fitWidth(r, vfov, Number(P.fill ?? 0.62));
      const dir = norm(rotY([0, Number(P.elev ?? 0.32), 1], yawOff));
      target = add(s0.center, [0, Number(P.lift ?? 0.2) * r, 0]);
      pos = add(target, scale(dir, dist));
      break;
    }
    case 'frontal_medium': {
      const head = s0.head ?? s0.top;
      const d = rotY(audienceDir(s0.faceYaw ?? s0.facingYaw, Number(P.bias ?? 0.45)), yawOff);
      const dist = Number(P.dist ?? 2.1);
      target = add(head, [0, -0.38, 0]);
      pos = add(add(head, scale(d, dist)), [0, -0.15, 0]);
      break;
    }
    case 'reaction_punch_in': {
      const head = s0.head ?? s0.top;
      const d = rotY(audienceDir(s0.faceYaw ?? s0.facingYaw, Number(P.bias ?? 0.35)), yawOff);
      const d0 = Number(P.fromDist ?? 1.7), d1 = Number(P.dist ?? 0.95);
      const k = smooth(clamp((t - t0) / Number(P.snap ?? 0.16), 0, 1));
      const dist = d0 + (d1 - d0) * k;
      target = add(head, [0, -0.1, 0]);
      pos = add(add(head, scale(d, dist)), [0, 0.02, 0]);
      break;
    }
    case 'two_shot': {
      const a = subs[0].head ?? subs[0].center, b = (subs[1] ?? subs[0]).head ?? (subs[1] ?? subs[0]).center;
      const mid = scale(add(a, b), 0.5);
      const ab = sub(b, a);
      let n = norm(cross([0, 1, 0], ab)); // perpendicular to the action line
      if (n[2] < 0) n = scale(n, -1); // stay on the audience side of the line
      n = rotY(n, yawOff);
      const w = len([ab[0], 0, ab[2]]) / 2 + 0.55;
      const dist = fitWidth(w, vfov, Number(P.fill ?? 0.92));
      target = add(mid, [0, -0.5, 0]);
      pos = add(add(mid, scale(n, dist)), [0, Number(P.height ?? -0.1), 0]);
      break;
    }
    case 'over_shoulder': {
      const from = subs[0], to = subs[1] ?? subs[0];
      const fh = from.head ?? from.top;
      const look = to.kind === 'prop' ? to.center : (to.head ?? to.center);
      const fwd = norm([look[0] - fh[0], 0, look[2] - fh[2]]);
      let side: Vec3 = norm(cross([0, 1, 0], fwd));
      if (side[2] < 0) side = scale(side, -1);
      pos = add(add(fh, scale(fwd, -Number(P.back ?? 0.75))), add(scale(side, Number(P.side ?? 0.42)), [0, Number(P.up ?? 0.12), 0]));
      target = add(look, [0, Number(P.targetLift ?? 0), 0]);
      break;
    }
    case 'low_angle_reveal': {
      const h = Math.max(0.2, s0.top[1] - s0.bottom[1]);
      const want = Math.max(h, 2 * s0.radius);
      const dir = rotY(norm([Number(P.side ?? 0.25), 0, 1]), yawOff);
      const dist = Math.max(Number(P.minDist ?? 1.2), fitWidth(want / 2, vfov, Number(P.fill ?? 0.75)) * 0.9);
      const base: Vec3 = [s0.center[0], 0, s0.center[2]];
      pos = add(add(base, scale(dir, dist)), [0, Number(P.height ?? 0.28), 0]);
      target = [s0.center[0], s0.bottom[1] + h * Number(P.aim ?? 0.62), s0.center[2]];
      break;
    }
    case 'top_down_insert': {
      const dist = fitWidth(Math.max(s0.radius, Number(P.minRadius ?? 0.25)), vfov, Number(P.fill ?? 0.55));
      target = s0.center;
      pos = add(s0.center, [0.02, dist, dist * 0.22]);
      break;
    }
    case 'wide_environment': {
      let min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
      for (const s of subs) for (const p of [s.top, s.bottom, add(s.center, [s.radius, 0, 0]), add(s.center, [-s.radius, 0, 0])]) {
        min = [Math.min(min[0], p[0]), Math.min(min[1], p[1]), Math.min(min[2], p[2])];
        max = [Math.max(max[0], p[0]), Math.max(max[1], p[1]), Math.max(max[2], p[2])];
      }
      const c = scale(add(min, max), 0.5);
      // platform UI occupies the right edge of 9:16 feeds: widen and shift so content centres in the action-safe area
      const halfW = ((max[0] - min[0]) / 2 + Number(P.margin ?? 0.5)) * 1.16;
      const halfH = (max[1] - min[1]) / 2 + 0.3;
      const dist = Math.max(fitWidth(halfW, vfov, 1), halfH / Math.tan(vfov / 2)) + (max[2] - min[2]) / 2;
      const dir = rotY(norm([Number(P.side ?? 0.12), Number(P.elev ?? 0.18), 1]), yawOff);
      target = [c[0] + halfW * 0.12, c[1] + Number(P.aimLift ?? 0), c[2]];
      pos = add(target, scale(dir, dist));
      break;
    }
    case 'chase_cam': {
      const head = s0.head ?? s0.top;
      const yaw = (s0.facingYaw ?? 0) * DEG;
      const back: Vec3 = [-Math.sin(yaw), 0, -Math.cos(yaw)];
      pos = add(add(head, scale(back, 1.8)), [0.4, 0.2, 0.6]);
      target = add(head, [0, -0.2, 0]);
      break;
    }
    default:
      throw new Error(`unknown preset ${shot.preset}`);
  }
  // controlled motion: push-in (dolly) + tiny deterministic drift
  const push = Number(P.push ?? 0.06);
  const u = clamp((t - t0) / Math.max(0.01, shot.end - t0), 0, 1);
  pos = lerp3(pos, target, push * smooth(u));
  const truck = Number(P.truck ?? 0);
  if (truck) { const right = norm(cross(sub(target, pos), [0, 1, 0])); pos = add(pos, scale(right, truck * (u - 0.5))); }
  const adj: string[] = [];
  const clamped = clampCamera(pos, target, env);
  if (clamped.note) adj.push(clamped.note);
  return { cam: { pos: clamped.pos, target, fovY: fov, roll }, adjustments: adj };
}

/** Keep the camera inside the camera-safe volume and outside solid geometry (pull toward target). */
export function clampCamera(pos: Vec3, target: Vec3, env: CameraEnv): { pos: Vec3; note?: string } {
  let p: Vec3 = [clamp(pos[0], env.safeMin[0], env.safeMax[0]), clamp(pos[1], env.safeMin[1], env.safeMax[1]), clamp(pos[2], env.safeMin[2], env.safeMax[2])];
  let note: string | undefined;
  if (p[0] !== pos[0] || p[1] !== pos[1] || p[2] !== pos[2]) note = 'clamped to camera-safe volume';
  for (let iter = 0; iter < 8; iter++) {
    const hit = env.colliders.find((c) => p[0] > c.min[0] - 0.08 && p[0] < c.max[0] + 0.08 && p[1] > c.min[1] - 0.08 && p[1] < c.max[1] + 0.08 && p[2] > c.min[2] - 0.08 && p[2] < c.max[2] + 0.08);
    if (!hit) break;
    p = lerp3(p, target, 0.18);
    note = `pulled out of collider ${hit.id}`;
  }
  return { pos: p, note };
}

export function applyShake(cam: CameraState, amount: number, t: number, seed: number): CameraState {
  const s = hashSeed('shake') ^ seed;
  // subtle "operator" drift always on + impact shake
  const drift = 0.0035;
  const a = amount + drift;
  const off: Vec3 = [noise1(t * (amount ? 26 : 0.7), s) * a, noise1(t * (amount ? 29 : 0.6), s + 1) * a, 0];
  return { ...cam, pos: add(cam.pos, off), target: add(cam.target, scale(off, 0.5)), roll: (cam.roll ?? 0) + noise1(t * 21, s + 2) * amount * 0.4 };
}
