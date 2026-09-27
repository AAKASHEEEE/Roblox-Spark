// Production runtime: episode data + locked asset library -> deterministic frame state at any time t.
import type { Episode, EpisodeShot } from '../../schema/src/episode.ts';
import type { CharacterManifest, EnvironmentManifest, PropManifest } from '../../schema/src/assets.ts';
import { ActorTrack, type PointResolver } from './animation/animator.ts';
import { ACTION_DEFS } from './animation/actions.ts';
import { buildCharacter, buildEnvironment, buildProp, type EnvInstance, type PropInstance, type Rig } from './build.ts';
import { applyShake, solveShot, type CameraEnv, type SubjectInfo } from './camera.ts';
import { plane } from './gl/geometry.ts';
import type { CameraState, Lighting, Particle, PostFx, PointLight, Renderer } from './gl/renderer.ts';
import { Node, hex } from './gl/scene.ts';
import { DEG, add, m4, m4Mul, m4TRS, m4TransformPoint, qEuler, qMul, scale, sub, type Mat4, type Vec3, dot, norm, len } from './math.ts';
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
    for (const [id, tr] of this.tracks) {
      const d = tr.apply(t);
      if (d.handError !== undefined) handErrors[id] = d.handError;
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
        const occ = this.occluder(f.cam.pos, face, base);
        if (occ) issues.push({ t: f.t, shot: shot.id, code: 'FACE_OCCLUDED', message: `${sid} face occluded by ${occ}`, subject: sid });
      }
    }
    for (const a of f.camAdjust) issues.push({ t: f.t, shot: shot.id, code: 'CAMERA_ADJUSTED', message: a });
    return issues;
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
