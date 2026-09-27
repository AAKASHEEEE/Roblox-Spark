// Production runtime: episode data + locked asset library -> deterministic frame state at any time t.
import type { Episode, EpisodeShot } from '../../schema/src/episode.ts';
import type { CharacterManifest, EnvironmentManifest, PropManifest } from '../../schema/src/assets.ts';
import { ActorTrack, solveArmIk, type PointResolver } from './animation/animator.ts';
import { ACTION_DEFS } from './animation/actions.ts';
import { buildCharacter, buildEnvironment, buildProp, type EnvInstance, type PropInstance, type Rig } from './build.ts';
import { applyShake, solveShot, type CameraEnv, type SubjectInfo } from './camera.ts';
import { plane } from './gl/geometry.ts';
import type { CameraState, Lighting, Particle, PostFx, PointLight, Renderer } from './gl/renderer.ts';
import { Node, hex } from './gl/scene.ts';
import { DEG, add, m4, m4Mul, m4TRS, m4TransformPoint, m4Invert, qEuler, qMul, scale, sub, type Mat4, type Vec3, dot, norm, len } from './math.ts';
import { PropTrack, type PropState } from './props.ts';
import { texture } from './textures.ts';
import { evalVfx } from './vfx.ts';

export interface Library {
  characters: Record<string, CharacterManifest>; // key id@version
  props: Record<string, PropManifest>;
  environments: Record<string, EnvironmentManifest>;
}

export interface FrameIssue { t: number; shot: string; code: string; message: string; subject?: string }
export interface FrameState { t: number; shot: EpisodeShot; cam: CameraState; light: Lighting; post: PostFx; particles: Particle[]; handErrors: Record<string, number>; camAdjust: string[] }

const EMOTE_TEX: Record<string, string> = { '?': 'emote_question', '!': 'emote_exclaim', '...': 'emote_dots' };

export class Production {
  readonly root = new Node('scene');
  readonly env: EnvInstance;
  readonly rigs = new Map<string, Rig>();
  readonly tracks = new Map<string, ActorTrack>();
  readonly props = new Map<string, { inst: PropInstance; track: PropTrack; parent?: string; anchorLocal: Vec3 }>();
  private emoteNodes = new Map<string, Node>();
  private subjectCache = new Map<string, SubjectInfo>();
  readonly camEnv: CameraEnv;
  readonly firstShot: EpisodeShot;

  readonly ep: Episode;
  readonly lib: Library;
  constructor(ep: Episode, lib: Library) { this.ep = ep; this.lib = lib;
    const envM = lib.environments[`${ep.environment.id}@${ep.environment.version}`];
    if (!envM) throw new Error(`environment ${ep.environment.id}@${ep.environment.version} missing`);
    this.env = buildEnvironment(envM);
    this.root.add(this.env.root);
    this.camEnv = { safeMin: envM.cameraSafe.min, safeMax: envM.cameraSafe.max, colliders: this.env.colliders };
    const resolveFn = (id: string, t: number) => this.point(id, t);

    // props (parents first so child anchor-local placement is known)
    const order = [...ep.props].sort((a, b) => (a.parent ? 1 : 0) - (b.parent ? 1 : 0));
    for (const p of order) {
      const m = lib.props[`${p.id}@${p.version}`];
      if (!m) throw new Error(`prop ${p.id}@${p.version} missing`);
      const inst = buildProp(m, p.instance);
      const centered = m.collision.offset[1] === 0;
      let anchorLocal: Vec3;
      if (p.parent) {
        const par = this.props.get(p.parent);
        if (!par) throw new Error(`prop ${p.instance}: parent ${p.parent} missing`);
        const a = par.inst.manifest.anchors[p.anchor];
        if (!a) throw new Error(`prop ${p.instance}: parent anchor ${p.anchor} missing`);
        anchorLocal = [a[0], a[1], a[2]];
        par.inst.root.add(inst.root);
      } else {
        const a = envM.anchors[p.anchor] ?? envM.marks[p.anchor]?.pos;
        if (!a) throw new Error(`prop ${p.instance}: anchor ${p.anchor} missing`);
        anchorLocal = [a[0], a[1], a[2]];
        this.root.add(inst.root);
      }
      const initial: PropState = { pos: add(anchorLocal, [0, centered ? (m.dimensions[1] / 2) * p.scale : 0, 0]), rotX: 0, rotY: 0, rotZ: 0, scale: p.scale, visible: p.visible, capDepth: 0, glow: 0, upright: 0 };
      this.props.set(p.instance, { inst, track: undefined as unknown as PropTrack, parent: p.parent, anchorLocal });
      this.props.get(p.instance)!.track = new PropTrack(p.instance, inst, initial, ep.propEvents, resolveFn);
    }
    // cast
    const res: PointResolver = { point: resolveFn, markFacing: (id) => envM.marks[id]?.facingDeg };
    for (const c of ep.cast) {
      const m = lib.characters[`${c.id}@${c.version}`];
      if (!m) throw new Error(`character ${c.id}@${c.version} missing`);
      const rig = buildCharacter(m);
      this.rigs.set(c.id, rig);
      this.root.add(rig.root);
      const mark = envM.marks[c.startMark];
      if (!mark) throw new Error(`${c.id}: start mark ${c.startMark} missing`);
      let yaw = mark.facingDeg;
      if (c.startFacing) { const p = this.point(c.startFacing, 0); if (p) yaw = Math.atan2(p[0] - mark.pos[0], p[2] - mark.pos[2]) / DEG; }
      const track = new ActorTrack(c.id, rig, ep.actions, [mark.pos[0], 0, mark.pos[2]], yaw, res, ep.episode.seed, ep.episode.duration);
      const ex = [{ at: 0, state: c.startExpression as string }];
      for (const e of ep.expressions) if (e.actor === c.id) ex.push({ at: e.at, state: e.state });
      for (const a of ep.actions) if (a.actor === c.id && a.expression) ex.push({ at: a.start, state: a.expression });
      track.expressionTrack = ex.sort((a, b) => a.at - b.at);
      this.tracks.set(c.id, track);
      const em = new Node(`emote:${c.id}`, plane(0.34, 0.34), { color: [1, 1, 1], unlit: true, alphaTest: 0.5, texture: texture('emote_exclaim') });
      em.billboard = true; em.castShadow = false; em.visible = false;
      this.root.add(em);
      this.emoteNodes.set(c.id, em);
    }
    this.firstShot = [...ep.shots].sort((a, b) => a.start - b.start)[0];
  }

  // ---------- pure spatial queries ----------
  /** world matrix of a prop instance at t (pure: no scene mutation) */
  propMatrix(inst: string, t: number): Mat4 {
    const p = this.props.get(inst)!;
    const s = p.track.stateAt(t);
    const q = qMul(qEuler(0, s.rotY * DEG, 0), qMul(qEuler(s.rotX * DEG, 0, 0), qEuler(0, 0, s.rotZ * DEG)));
    const local = m4TRS(s.pos, q, [s.scale, s.scale, s.scale]);
    return p.parent ? m4Mul(this.propMatrix(p.parent, t), local) : local;
  }
  propAnchor(inst: string, anchor: string | undefined, t: number): Vec3 | undefined {
    const p = this.props.get(inst);
    if (!p) return undefined;
    const m = p.inst.manifest;
    const a = anchor ? (m.anchors[anchor] ?? m.effectAnchors[anchor] ?? m.grips[anchor]) : m.collision.offset;
    if (!a) return undefined;
    const w = m4TransformPoint(this.propMatrix(inst, t), a as Vec3);
    return [w[0], w[1], w[2]];
  }
  point(id: string, t: number): Vec3 | undefined {
    const [base, sub_] = id.split('.');
    const envM = this.env.manifest;
    if (envM.marks[id]) return [...envM.marks[id].pos] as Vec3;
    if (envM.anchors[id]) return [...envM.anchors[id]] as Vec3;
    if (this.props.has(base)) return this.propAnchor(base, sub_, t);
    const tr = this.tracks.get(base);
    if (tr) {
      const r = tr.rootAt(t);
      const h = tr.rig.dims;
      if (sub_ === 'feet') return r.pos;
      if (sub_ === 'face' || !sub_) return [r.pos[0] + Math.sin(r.yaw * DEG) * 0.3, h.height - h.headH / 2, r.pos[2] + Math.cos(r.yaw * DEG) * 0.3];
      if (sub_ === 'head') return [r.pos[0], h.height - h.headH / 2, r.pos[2]];
      if (sub_ === 'above_head') return [r.pos[0], h.height + 0.35, r.pos[2]];
    }
    return undefined;
  }

  /** Subject bounds for camera solving. Actor subjects are computed from the real posed rig (cached per time). */
  subject(id: string, t: number): SubjectInfo | undefined {
    const key = `${id}@${t.toFixed(4)}`;
    const c = this.subjectCache.get(key);
    if (c) return c;
    let s: SubjectInfo | undefined;
    const [base] = id.split('.');
    const tr = this.tracks.get(base);
    if (tr) {
      this.applyProps(t);
      tr.apply(t);
      const pts = tr.rig.probes.map((p) => p.worldPos());
      const min = pts.reduce((a, p) => [Math.min(a[0], p[0]), Math.min(a[1], p[1]), Math.min(a[2], p[2])] as Vec3, [Infinity, Infinity, Infinity] as Vec3);
      const max = pts.reduce((a, p) => [Math.max(a[0], p[0]), Math.max(a[1], p[1]), Math.max(a[2], p[2])] as Vec3, [-Infinity, -Infinity, -Infinity] as Vec3);
      const center = scale(add(min, max), 0.5);
      const head = tr.rig.face.worldPos();
      s = { kind: 'actor', center, head, top: [center[0], max[1], center[2]], bottom: [center[0], min[1], center[2]], radius: Math.max(max[0] - min[0], max[2] - min[2], 0.5) / 2, facingYaw: tr.rootAt(t).yaw, faceYaw: Math.atan2(tr.rig.face.world[8], tr.rig.face.world[10]) / DEG };
    } else if (this.props.has(base)) {
      const p = this.props.get(base)!;
      const st = p.track.stateAt(t);
      const m = p.inst.manifest;
      const center = this.propAnchor(base, undefined, t)!;
      const ws = this.worldScale(base, t);
      const dims = m.dimensions;
      const up = st.upright;
      const halfY = ((dims[1] * (1 - up) + Math.max(dims[0], dims[2]) * up) / 2) * ws;
      const radius = (Math.max(dims[0], dims[2]) / 2) * ws;
      s = { kind: 'prop', center, top: add(center, [0, halfY, 0]), bottom: sub(center, [0, halfY, 0]), radius: Math.max(radius, halfY) };
    } else {
      const p = this.point(id, t);
      if (p) s = { kind: 'prop', center: p, top: p, bottom: p, radius: 0.3 };
    }
    if (s) this.subjectCache.set(key, s);
    return s;
  }
  private worldScale(inst: string, t: number): number {
    const p = this.props.get(inst)!;
    const s = p.track.stateAt(t).scale;
    return p.parent ? s * this.worldScale(p.parent, t) : s;
  }

  shotAt(t: number): EpisodeShot {
    const shots = this.ep.shots;
    for (const s of shots) if (t >= s.start && t < s.end) return s;
    return shots[shots.length - 1];
  }

  private applyProps(t: number): void { for (const p of this.props.values()) p.track.apply(t); }

  lighting(): Lighting {
    const L = this.env.manifest.lighting[this.ep.environment.lighting];
    const sc = hex(L.sunColor).map((c) => c * L.sunIntensity) as [number, number, number];
    return {
      sunDir: L.sunDir, sunColor: sc, skyColor: hex(L.sky).map((c) => c * L.ambientIntensity) as [number, number, number],
      groundColor: hex(L.ground).map((c) => c * L.ambientIntensity * 0.6) as [number, number, number], points: [],
      fogColor: hex(L.fog), fogNear: L.fogNear, fogFar: L.fogFar, exposure: L.exposure, shadowCenter: [0, 1, -0.5], shadowRadius: 5.2,
    };
  }

  /** Evaluate the complete frame state at time t (does not draw). */
  evaluate(t: number): FrameState {
    const shot = this.shotAt(t);
    const solved = solveShot(shot, t, this, this.camEnv, this.firstShot);
    // apply scene state at t (after camera solve, which may probe other times)
    this.applyProps(t);
    const handErrors: Record<string, number> = {};
    const boxes = this.propBoxes(t);
    for (const [id, tr] of this.tracks) {
      const d = tr.apply(t);
      if (d.handError !== undefined) handErrors[id] = d.handError;
      this.avoidHandCollisions(tr, boxes, t);
    }
    const vf = evalVfx(this.ep.vfx, t, (id, tt) => this.point(id, tt), this.ep.episode.seed);
    for (const [id, n] of this.emoteNodes) {
      const e = vf.emotes.find((x) => x.target === id);
      n.visible = !!e && e.scale > 0.01;
      if (e) {
        const rig = this.rigs.get(id)!;
        const hp = rig.headTop.worldPos();
        n.pos = [hp[0] + 0.12, hp[1] + 0.3, hp[2]];
        n.scl = [e.scale, e.scale, e.scale];
        n.material!.texture = texture(EMOTE_TEX[e.symbol] ?? 'emote_exclaim');
      }
    }
    const light = this.lighting();
    const pts: PointLight[] = [];
    for (const [inst, p] of this.props) {
      const st = p.track.stateAt(t);
      if (st.glow > 0.01 && p.inst.manifest.effectAnchors.glow) {
        const g = this.propAnchor(inst, 'glow', t)!;
        pts.push({ pos: add(g, [0, 0.05, 0.05]), color: [1, 0.22, 0.18], intensity: 0.9 * st.glow, range: 0.45 });
      }
    }
    for (const l of vf.lights) { const p = this.point(l.target, t); if (p) pts.push({ pos: p, color: l.color, intensity: l.intensity, range: 0.6 }); }
    light.points = pts;
    const cam = applyShake(solved.cam, vf.shake, t, this.ep.episode.seed);
    return { t, shot, cam, light, post: vf.post, particles: vf.particles, handErrors, camAdjust: solved.adjustments };
  }

  render(r: Renderer, t: number): FrameState {
    const f = this.evaluate(t);
    r.render(this.root, f.cam, f.light, f.post, f.particles);
    return f;
  }

  // ---------- hand/prop collision ----------
  /** world AABBs of visible props (from manifest collision shapes) at time t */
  propBoxes(t: number): Array<{ inst: string; category: string; min: Vec3; max: Vec3 }> {
    const out: Array<{ inst: string; category: string; min: Vec3; max: Vec3 }> = [];
    for (const [inst, p] of this.props) {
      if (!p.track.stateAt(t).visible) continue;
      const c = p.inst.manifest.collision;
      const h: Vec3 = c.shape === 'box' ? [c.size[0] / 2, c.size[1] / 2, c.size[2] / 2] : c.shape === 'cylinder' ? [c.size[0], c.size[1] / 2, c.size[0]] : [c.size[0], c.size[0], c.size[0]];
      const m = this.propMatrix(inst, t);
      let min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
        const w = m4TransformPoint(m, [c.offset[0] + sx * h[0], c.offset[1] + sy * h[1], c.offset[2] + sz * h[2]]);
        min = [Math.min(min[0], w[0]), Math.min(min[1], w[1]), Math.min(min[2], w[2])];
        max = [Math.max(max[0], w[0]), Math.max(max[1], w[1]), Math.max(max[2], w[2])];
      }
      out.push({ inst, category: p.inst.manifest.category, min, max });
    }
    return out;
  }
  /** hand sample points: fingertip end and palm centre */
  private handPoints(rig: Rig, arm: 'l' | 'r'): Vec3[] {
    const tip = (arm === 'l' ? rig.hand_l : rig.hand_r).worldPos();
    const el = rig.joints[arm === 'l' ? 'elbow_l' : 'elbow_r'].worldPos();
    const k = 0.18 / Math.max(0.01, rig.dims.lowerArm);
    return [tip, [tip[0] + (el[0] - tip[0]) * k, tip[1] + (el[1] - tip[1]) * k, tip[2] + (el[2] - tip[2]) * k]];
  }
  /**
   * Soft constraint: a hand approaching the top of furniture/device props is lifted over it (continuous weight
   * over a margin zone, so no pops). Arms under intentional IK contact (press, pick up) are exempt.
   */
  private avoidHandCollisions(tr: ActorTrack, boxes: ReturnType<Production['propBoxes']>, t: number): void {
    const rig = tr.rig, r = rig.manifest.body.armWidth * 0.45, margin = 0.08;
    const solid = boxes.filter((b) => b.category === 'furniture' || b.category === 'device');
    for (const arm of ['l', 'r'] as const) {
      if (tr.lastIkArms.has(arm)) continue;
      let best: { w: number; target: Vec3 } | undefined;
      for (const p of this.handPoints(rig, arm)) for (const b of solid) {
        if (p[0] < b.min[0] - r || p[0] > b.max[0] + r || p[2] < b.min[2] - r || p[2] > b.max[2] + r || p[1] < b.min[1] - r) continue;
        const clear = b.max[1] + r;
        const w = Math.min(1, Math.max(0, (clear + margin - p[1]) / margin));
        if (w > 0 && (!best || w > best.w + 1e-6 || (Math.abs(w - best.w) <= 1e-6 && clear + margin * 0.5 > best.target[1]))) best = { w, target: [p[0], clear + margin * 0.5, p[2]] };
      }
      if (best) solveArmIk(rig, arm, best.target, best.w, [0, -0.5, -1], tr.rootAt(t).yaw);
    }
  }
  /**
   * Penetration depth (m, world units) of point p inside a prop's collision shape, tested exactly in the prop's
   * local space (so rotated/tilted props are not approximated by loose world AABBs). <= 0 means outside.
   */
  propDepth(inst: string, p: Vec3, t: number): number {
    const pr = this.props.get(inst)!;
    const c = pr.inst.manifest.collision;
    const m = this.propMatrix(inst, t);
    if (Math.hypot(m[0], m[1], m[2]) < 0.02) return -Infinity; // spawning at ~zero scale: nothing to intersect
    const inv = m4Invert(m);
    const l = m4TransformPoint(inv, p);
    const ws = Math.hypot(m[0], m[1], m[2]);
    const x = l[0] - c.offset[0], y = l[1] - c.offset[1], z = l[2] - c.offset[2];
    let d: number;
    if (c.shape === 'box') d = Math.min(c.size[0] / 2 - Math.abs(x), c.size[1] / 2 - Math.abs(y), c.size[2] / 2 - Math.abs(z));
    else if (c.shape === 'cylinder') d = Math.min(c.size[0] - Math.hypot(x, z), c.size[1] / 2 - Math.abs(y));
    else d = c.size[0] - Math.hypot(x, y, z);
    return d * ws;
  }
  /** QA: hand points inside any prop or environment collider (excluding floor and intentional contacts). */
  handPenetrations(t: number): FrameIssue[] {
    const issues: FrameIssue[] = [];
    const visible = [...this.props].filter(([, p]) => p.track.stateAt(t).visible).map(([k]) => k);
    const env = this.env.colliders.filter((c) => c.id !== 'floor');
    for (const [id, tr] of this.tracks) {
      const tgts = new Set(this.ep.actions.filter((a) => a.actor === id && a.target && t >= a.start && t < a.start + a.duration).map((a) => a.target!.split('.')[0]));
      for (const arm of ['l', 'r'] as const) {
        let worst: { d: number; what: string } | undefined;
        for (const p of this.handPoints(tr.rig, arm)) {
          for (const inst of visible) {
            if (tr.lastIkArms.has(arm) && tgts.has(inst)) continue;
            const d = this.propDepth(inst, p, t);
            if (d > 0.01 && (!worst || d > worst.d)) worst = { d, what: `prop:${inst}` };
          }
          for (const b of env) {
            const d = Math.min(p[0] - b.min[0], b.max[0] - p[0], p[1] - b.min[1], b.max[1] - p[1], p[2] - b.min[2], b.max[2] - p[2]);
            if (d > 0.01 && (!worst || d > worst.d)) worst = { d, what: `env:${b.id}` };
          }
        }
        if (worst) issues.push({ t, shot: this.shotAt(t).id, code: 'HAND_PENETRATION', message: `${id} ${arm} hand ${(worst.d * 100).toFixed(1)} cm inside ${worst.what}`, subject: id });
      }
    }
    return issues;
  }

  // ---------- screen-space shot validation ----------
  validateFrame(r: Renderer, f: FrameState): FrameIssue[] {
    const issues: FrameIssue[] = [];
    const { vp } = r.viewProj(f.cam);
    const safe = this.env.manifest.composition.actionSafe;
    const project = (p: Vec3) => { const c = m4TransformPoint(vp, p); return c[3] <= 0 ? null : { x: (c[0] / c[3] + 1) / 2, y: 1 - (c[1] / c[3] + 1) / 2 }; };
    const shot = f.shot;
    const needFace = ['frontal_medium', 'reaction_punch_in', 'two_shot'].includes(shot.preset);
    for (const [si, sid] of shot.subjects.entries()) {
      const [base] = sid.split('.');
      if (shot.preset === 'over_shoulder' && si === 0) continue; // foreground shoulder is intentionally cropped
      let pts: Vec3[] = [];
      let face: Vec3 | undefined, faceN: Vec3 | undefined;
      const rig = this.rigs.get(base);
      if (rig) {
        const tight = shot.preset === 'reaction_punch_in' || shot.preset === 'over_shoulder';
        pts = tight ? rig.probes.filter((p) => p.name.startsWith('probe:head')).map((p) => p.worldPos()) : rig.probes.map((p) => p.worldPos());
        face = rig.face.worldPos();
        const w = rig.face.world; faceN = norm([w[8], w[9], w[10]]);
      } else if (this.props.has(base)) {
        const s = this.subject(base, f.t)!;
        pts = [s.top, s.bottom, add(s.center, [s.radius, 0, 0]), add(s.center, [-s.radius, 0, 0])];
        if (!this.props.get(base)!.track.stateAt(f.t).visible) continue;
      }
      const proj = pts.map(project).filter(Boolean) as Array<{ x: number; y: number }>;
      if (!proj.length) { issues.push({ t: f.t, shot: shot.id, code: 'SUBJECT_BEHIND_CAMERA', message: `${sid} behind camera`, subject: sid }); continue; }
      const minX = Math.min(...proj.map((p) => p.x)), maxX = Math.max(...proj.map((p) => p.x));
      const minY = Math.min(...proj.map((p) => p.y)), maxY = Math.max(...proj.map((p) => p.y));
      const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
      if (maxX < 0 || minX > 1 || maxY < 0 || minY > 1) issues.push({ t: f.t, shot: shot.id, code: 'SUBJECT_OUT_OF_FRAME', message: `${sid} entirely out of frame`, subject: sid });
      else if (cx < safe.left || cx > safe.right || cy < safe.top || cy > safe.bottom) issues.push({ t: f.t, shot: shot.id, code: 'SUBJECT_OUTSIDE_ACTION_SAFE', message: `${sid} centre (${cx.toFixed(2)},${cy.toFixed(2)}) outside action-safe area`, subject: sid });
      if (face && faceN && needFace && rig) {
        const fp = project(face);
        const toCam = norm(sub(f.cam.pos, face));
        if (!fp || fp.x < 0.02 || fp.x > 0.98 || fp.y < 0.02 || fp.y > 0.98) issues.push({ t: f.t, shot: shot.id, code: 'FACE_OUT_OF_FRAME', message: `${sid} face not in frame`, subject: sid });
        else if (dot(toCam, faceN) < 0.15) issues.push({ t: f.t, shot: shot.id, code: 'FACE_TURNED_AWAY', message: `${sid} face turned away from camera (dot=${dot(toCam, faceN).toFixed(2)})`, subject: sid });
        const buried = [...this.props.keys()].find((k) => this.props.get(k)!.track.stateAt(f.t).visible && this.propDepth(k, face, f.t) > -0.03);
        const occ = buried ? `prop:${buried} (face buried inside it)` : this.occluder(f.cam.pos, face, base) ?? this.propOccluder(f.cam.pos, face, f.t);
        if (occ) issues.push({ t: f.t, shot: shot.id, code: 'FACE_OCCLUDED', message: `${sid} face occluded by ${occ}`, subject: sid });
      }
    }
    for (const a of f.camAdjust) issues.push({ t: f.t, shot: shot.id, code: 'CAMERA_ADJUSTED', message: a });
    // near plane must not be inside any visible prop (props can move/grow into a locked-off camera)
    for (const [inst, p] of this.props) {
      if (!p.track.stateAt(f.t).visible) continue;
      const d = this.propDepth(inst, f.cam.pos, f.t);
      if (d > -0.05) issues.push({ t: f.t, shot: shot.id, code: 'CAMERA_IN_PROP', message: `camera ${d > 0 ? 'inside' : 'within 5 cm of'} ${inst}` });
    }
    return issues;
  }

  /** props between camera and point (exact local-space shape tests along the ray, last 6 cm excluded). */
  private propOccluder(from: Vec3, to: Vec3, t: number): string | undefined {
    const L = len(sub(to, from));
    const n = Math.max(24, Math.ceil(L / 0.03));
    for (const [inst, p] of this.props) {
      if (!p.track.stateAt(t).visible) continue;
      for (let k = 1; k < n; k++) {
        const u = k / n;
        if ((1 - u) * L < 0.06) break;
        if (this.propDepth(inst, [from[0] + (to[0] - from[0]) * u, from[1] + (to[1] - from[1]) * u, from[2] + (to[2] - from[2]) * u], t) > 0) return `prop:${inst}`;
      }
    }
    return undefined;
  }
  /** segment vs AABB test against environment colliders (camera -> face). */
  private occluder(from: Vec3, to: Vec3, self: string): string | undefined {
    const d = sub(to, from);
    const L = len(d);
    const dir = scale(d, 1 / L);
    for (const c of this.env.colliders) {
      let tmin = 0, tmax = L - 0.05;
      let hit = true;
      for (let k = 0; k < 3; k++) {
        if (Math.abs(dir[k]) < 1e-9) { if (from[k] < c.min[k] || from[k] > c.max[k]) { hit = false; break; } continue; }
        let t1 = (c.min[k] - from[k]) / dir[k], t2 = (c.max[k] - from[k]) / dir[k];
        if (t1 > t2) [t1, t2] = [t2, t1];
        tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
        if (tmin > tmax) { hit = false; break; }
      }
      if (hit) return c.id;
    }
    void self;
    return undefined;
  }

  /** contact-time table for every action with a contact point (used for audio/vfx sync + QA) */
  contacts(): Array<{ actor: string; action: string; t: number; target?: string }> {
    const out: Array<{ actor: string; action: string; t: number; target?: string }> = [];
    for (const a of this.ep.actions) {
      const def = ACTION_DEFS[a.action];
      if (def?.contactU !== undefined) out.push({ actor: a.actor, action: a.action, t: a.start + a.duration * def.contactU, target: a.target });
    }
    return out;
  }
}

export { m4 };
