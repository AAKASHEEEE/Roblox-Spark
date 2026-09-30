// Frame-strip stage for the action library stills (no GL here: builds the scene and poses it at t).
// Each strip plays one library action on a real rig through LibraryTrack, with placeholder props
// (grey-box stand-ins named with the S4 anchor roles) until S4's props land. Deterministic: pure function of t.
import type { CharacterManifest, EnvironmentManifest, PropManifest } from '../../../../schema/src/assets.ts';
import { buildCharacter, buildEnvironment, buildProp, partNode, type Rig } from '../../build.ts';
import { Node } from '../../gl/scene.ts';
import { DEG, add, qEuler, qMul, qRotate, type Quat, type Vec3 } from '../../math.ts';
import type { ActionCtx } from '../actions.ts';
import { FaceTrack, applyFace } from '../face-track.ts';
import { PhraseMouth } from '../talking.ts';
import { attachToHand, blendPlacement, flightAt, throwVelocity, type PropPlacement } from './attach.ts';
import { LIB_ACTIONS } from './registry.ts';
import { LibraryTrack, type LibTrackAction } from './track.ts';
import { ANCHOR_ROLES, type AnchorRole } from './anchors.ts';

export interface StripLibrary { characters: Record<string, CharacterManifest>; props: Record<string, PropManifest>; environments: Record<string, EnvironmentManifest> }

type Kind = 'ball' | 'phone' | 'cup' | 'pizza' | 'laptop_desk' | 'chair' | 'crate' | 'rope' | 'door' | 'pedestal_ball' | 'button_desk' | 'coin_desk';
/** a placeholder: `mover` is the part that can leave with the hand (the ball on its pedestal, the coin on its desk) */
interface Built { root: Node; anchors: Record<string, Vec3>; hinge?: Node; mover?: { node: Node; offset: Vec3 } }
interface StageProp extends Built { id: string; kind: Kind; base: PropPlacement; held?: boolean }

export interface StripSpec {
  /** strip name (file name) */
  name: string;
  /** action ID (LIB_ACTIONS) or a face strip ('talk', 'expressions') */
  action: string;
  label: string;
  /** actions before the shown one (e.g. sit before stand_up) */
  pre?: Array<{ action: string; dur: number; to?: string; params?: Record<string, number | boolean> }>;
  dur?: number;
  from: [number, number];
  yaw: number;
  to?: string;
  target?: string;
  params?: Record<string, number | boolean>;
  props?: Array<{ id: string; kind: Kind; at: Vec3; yaw?: number; held?: boolean }>;
  /** camera azimuth (deg, 0 = in front of +z), distance, look height */
  cam?: { az?: number; dist?: number; y?: number; center?: [number, number]; /** camera height above the look point */ h?: number };
}

const S: [number, number] = [0, 1.4];
const off = (dx: number, dz: number): [number, number] => [S[0] + dx, S[1] + dz];
const P = (dx: number, y: number, dz: number): Vec3 => [S[0] + dx, y, S[1] + dz];
/** marks used by the strips */
export const STRIP_MARKS: Record<string, Vec3> = {
  stage: P(0, 0, 0), left: P(-1.3, 0, 0), right: P(1.3, 0, 0), front: P(0, 0, 0.9), door_in: P(-1.5, 0, 0), door_out: P(1.5, 0, 0),
  camera: P(0, 1.3, 4), aside: P(2.5, 0.2, 0.3),
};

const HELD = (id: string, kind: Kind): StripSpec['props'] => [{ id, kind, at: P(0, 0, 0), held: true }];
export const STRIP_SPECS: StripSpec[] = [
  // ---- planned body actions
  { name: 'sit', action: 'sit', label: 'sit (plop + squash)', from: S, yaw: 0, params: { seatHeight: 0.45 }, props: [{ id: 'chair', kind: 'chair', at: P(0, 0, -0.18) }], cam: { az: 55 } },
  { name: 'stand_up', action: 'stand_up', label: 'stand_up (lean, rise, overshoot)', pre: [{ action: 'sit', dur: 1.0, params: { seatHeight: 0.45 } }], from: S, yaw: 0, params: { seatHeight: 0.45 }, props: [{ id: 'chair', kind: 'chair', at: P(0, 0, -0.18) }], cam: { az: 55 } },
  { name: 'celebrate', action: 'celebrate', label: 'celebrate (crouch, jump, squash)', from: S, yaw: 20 },
  { name: 'dance', action: 'dance', label: 'dance (beat loop)', from: S, yaw: 15 },
  { name: 'cry', action: 'cry', label: 'cry (sobs, wail)', from: S, yaw: 15 },
  { name: 'scream', action: 'scream', label: 'scream (inhale, stretch)', from: S, yaw: 15 },
  { name: 'grab', action: 'grab', label: 'grab (cock, snatch, yank)', from: S, yaw: 0, target: 'ball.grip', props: [{ id: 'ball', kind: 'pedestal_ball', at: P(-0.28, 0, 0.5) }], cam: { az: 40 } },
  { name: 'tug', action: 'tug', label: 'tug (heave x3)', from: S, yaw: 90, target: 'rope.contact', props: [{ id: 'rope', kind: 'rope', at: P(0.55, 0, 0), yaw: 90 }], cam: { az: 20, center: off(0.5, 0) } },
  { name: 'push', action: 'push', label: 'push (wind, shove)', from: S, yaw: 90, target: 'crate.contact', props: [{ id: 'crate', kind: 'crate', at: P(0.72, 0, 0), yaw: 90 }], cam: { az: 20, center: off(0.4, 0) } },
  { name: 'sleep', action: 'sleep', label: 'sleep (nods off, jerks awake)', dur: 3.2, from: S, yaw: 20 },
  { name: 'sleep_lying', action: 'sleep', label: 'sleep lying', from: S, yaw: 90, params: { lying: true }, cam: { az: 0, dist: 3.6, y: 0.6, center: off(0.6, 0) } },
  { name: 'flattened', action: 'flattened', label: 'flattened (pancake)', from: S, yaw: 0, cam: { az: 20, dist: 2.2, y: 0.1, h: 2.4, center: off(0, -0.7) } },
  { name: 'look_around', action: 'look_around', label: 'look_around (nervous scan, double-take)', from: S, yaw: 0 },
  { name: 'shrug', action: 'shrug', label: 'shrug', from: S, yaw: 10 },
  { name: 'wave', action: 'wave', label: 'wave', from: S, yaw: 10, target: 'camera' },
  { name: 'clap', action: 'clap', label: 'clap', from: S, yaw: 20 },
  { name: 'sneak', action: 'sneak', label: 'sneak (tiptoe crouch)', from: off(-1.3, 0), yaw: 90, to: 'right', cam: { az: 8, dist: 7.2, center: S } },
  // ---- prop interactions
  { name: 'throw', action: 'throw', label: 'throw (wind-up, whip, release)', from: S, yaw: 70, target: 'aside', props: HELD('ball', 'ball'), cam: { az: 10, dist: 5 } },
  { name: 'use_phone', action: 'use_phone', label: 'use_phone (taps, double-take)', from: S, yaw: 20, params: { takeAt: 0.72 }, props: HELD('phone', 'phone') },
  { name: 'type_laptop', action: 'type_laptop', label: 'type_laptop (hacker + enter slam)', from: S, yaw: 0, target: 'laptop.keyboard', params: { intensity: 1 }, props: [{ id: 'laptop', kind: 'laptop_desk', at: P(0, 0, 0.62) }], cam: { az: 45 } },
  { name: 'eat', action: 'eat', label: 'eat (wide, big bite, chew)', from: S, yaw: 30, props: HELD('pizza', 'pizza') },
  { name: 'drink', action: 'drink', label: 'drink (gulps, ahh)', from: S, yaw: 30, props: HELD('cup', 'cup') },
  // ---- doors
  { name: 'open_door', action: 'open_door', label: 'open_door (grip, pull, peek)', from: off(0.6, 0.72), yaw: 200, target: 'door.door_handle', props: [{ id: 'door', kind: 'door', at: P(0, 0, 0) }], cam: { az: 105, dist: 4.4, center: off(0.1, 0.45) } },
  { name: 'slam_door', action: 'slam_door', label: 'slam_door (wind, slam, jolt)', from: off(0.15, 0.95), yaw: -150, target: 'door.door_handle', props: [{ id: 'door', kind: 'door', at: P(0, 0, 0) }], cam: { az: 105, dist: 4.4, center: off(0.1, 0.45) } },
  { name: 'enter_door', action: 'enter_door', label: 'enter_door (peek, walk in)', from: off(-1.5, 0), yaw: 90, to: 'right', props: [{ id: 'door', kind: 'door', at: P(-1.5, 0, 0), yaw: -90 }], cam: { az: 14, dist: 6, center: off(-0.2, 0) } },
  { name: 'exit_door', action: 'exit_door', label: 'exit_door (walk out, glance back)', from: off(-1.3, 0), yaw: 90, to: 'door_out', props: [{ id: 'door', kind: 'door', at: P(1.5, 0, 0), yaw: -90 }], cam: { az: 14, dist: 6, center: off(0.2, 0) } },
  // ---- engine actions with library upgrades
  { name: 'jump', action: 'jump', label: 'jump (+ squash & stretch)', from: S, yaw: 20 },
  { name: 'victory_pose', action: 'victory_pose', label: 'victory_pose (+ landing squash)', from: S, yaw: 20 },
  { name: 'pick_up', action: 'pick_up', label: 'pick_up (+ hand attachment)', from: S, yaw: 0, target: 'coin.grip', props: [{ id: 'coin', kind: 'coin_desk', at: P(0.1, 0, 0.55) }], cam: { az: 40 } },
  { name: 'hold', action: 'hold', label: 'hold (+ prop in hand)', from: S, yaw: 20, props: HELD('cup', 'cup') },
  { name: 'put_down', action: 'put_down', label: 'put_down (+ release)', from: S, yaw: 0, target: 'ball.grip', props: [{ id: 'ball', kind: 'pedestal_ball', at: P(-0.28, 0, 0.5), held: true }], cam: { az: 40 } },
  // ---- talking and faces
  { name: 'talk', action: 'talk', label: 'talking: phrase-timed mouth flaps (placeholder mouth states)', dur: 1.6, from: S, yaw: 0, cam: { az: 0, dist: 2.2, y: 1.55 } },
  { name: 'expressions', action: 'expressions', label: 'expression per beat, blink on each change', dur: 3.0, from: S, yaw: 0, cam: { az: 0, dist: 2.2, y: 1.55 } },
];
// every remaining engine action (as-is) gets a plain strip too
for (const id of Object.keys(LIB_ACTIONS)) {
  if (STRIP_SPECS.some((s) => s.action === id)) continue;
  const d = LIB_ACTIONS[id];
  const loco = !!d.locomotion;
  STRIP_SPECS.push({
    name: id, action: id, label: `${id} (engine)`, from: loco ? off(-1.3, 0) : S, yaw: loco ? 90 : 15, ...(loco ? { to: 'right', cam: { az: 8, dist: 7.2, center: S } } : {}),
    ...(id === 'press_button' ? { target: 'button.contact', props: [{ id: 'button', kind: 'button_desk' as Kind, at: P(0.1, 0, 0.55) }], yaw: 0, cam: { az: 40 } } : {}),
    ...(['point', 'look_at', 'turn_toward', 'curious_lean', 'arms_crossed', 'shock_recoil', 'chase'].includes(id) && !loco ? { target: 'aside' } : {}),
    ...(id === 'facepalm' ? { target: 'face' } : {}),
    ...(id === 'fall' || id === 'dive_prone' ? { cam: { az: 20, dist: 5, y: 0.7, center: loco ? S : off(0, -0.4) } } : {}),
  });
}

// ---------------------------------------------------------------- placeholder props

const box = (id: string, size: number[], pos: number[], color: string, extra: Record<string, unknown> = {}) => partNode({ id, size, pos, color, bevel: 0.01, ...extra });
function placeholder(kind: Kind, lib: StripLibrary): Built {
  const root = new Node(`strip:${kind}`);
  const anchors: Record<string, Vec3> = {};
  let mover: Built['mover'];
  switch (kind) {
    case 'ball': case 'pedestal_ball': {
      const y = kind === 'pedestal_ball' ? 0.9 : 0.11;
      if (kind === 'pedestal_ball') root.add(box('pedestal', [0.3, 0.78, 0.3], [0, 0.39, 0], '#8c93a3'));
      const ball = partNode({ id: 'ball', shape: 'sphere', size: [0.11], pos: [0, y, 0], color: '#e8452c' });
      root.add(ball);
      anchors.grip = [0, y + 0.02, -0.1]; anchors.center = [0, y, 0];
      if (kind === 'pedestal_ball') mover = { node: ball, offset: [0, y, 0] };
      break;
    }
    case 'phone':
      root.add(box('phone', [0.085, 0.16, 0.016], [0, 0.08, 0], '#1b1d24'), box('screen', [0.07, 0.13, 0.004], [0, 0.085, 0.009], '#56c8f5', { emissive: '#56c8f5' }));
      anchors.grip = [0, 0.03, -0.012]; anchors.screen = [0, 0.085, 0.012];
      break;
    case 'cup':
      root.add(partNode({ id: 'cup', shape: 'cylinder', size: [0.05, 0.13], pos: [0, 0.065, 0], color: '#f4f4f2' }), partNode({ id: 'drink', shape: 'cylinder', size: [0.043, 0.01], pos: [0, 0.12, 0], color: '#d9482b' }));
      anchors.grip = [0, 0.05, -0.055]; anchors.rim = [0, 0.13, 0.05];
      break;
    case 'pizza':
      root.add(box('slice', [0.16, 0.022, 0.2], [0, 0.011, 0.07], '#f2b33d'), box('crust', [0.17, 0.035, 0.04], [0, 0.017, -0.03], '#c9812f'));
      anchors.grip = [0, 0.02, -0.04]; anchors.bite = [0, 0.02, 0.16];
      break;
    case 'laptop_desk': {
      const desk = buildProp(lib.props['student_desk@1.0.0'], 'desk');
      root.add(desk.root);
      root.add(box('lap_base', [0.36, 0.02, 0.25], [0, 0.77, 0], '#9aa3b2'));
      const lid = box('lap_lid', [0.36, 0.24, 0.015], [0, 0.89, -0.13], '#9aa3b2'); lid.rot = qEuler(-12 * DEG, 0, 0); root.add(lid);
      root.add(box('lap_screen', [0.32, 0.2, 0.004], [0, 0.89, -0.12], '#56c8f5', { emissive: '#56c8f5' }));
      anchors.keyboard = [0, 0.8, 0.05]; anchors.screen = [0, 0.89, -0.12];
      break;
    }
    case 'chair':
      root.add(box('seat', [0.46, 0.05, 0.44], [0, 0.425, 0], '#c07a3a'), box('back', [0.46, 0.5, 0.05], [0, 0.7, -0.22], '#c07a3a'));
      for (const [x, z] of [[-0.2, -0.19], [0.2, -0.19], [-0.2, 0.19], [0.2, 0.19]]) root.add(box(`leg${x}${z}`, [0.04, 0.42, 0.04], [x, 0.21, z], '#6b4a2a'));
      anchors.seat = [0, 0.45, 0];
      break;
    case 'crate':
      // front face at local z = 0, body behind it
      root.add(box('crate', [0.7, 1.0, 0.7], [0, 0.5, 0.35], '#b8874b'), box('band', [0.72, 0.08, 0.72], [0, 0.7, 0.35], '#8a6232'));
      anchors.contact = [0, 0.95, 0];
      break;
    case 'rope':
      root.add(box('rope', [0.035, 0.035, 1.4], [0, 0.95, 0.7], '#d9c38b'), box('post', [0.12, 1.3, 0.12], [0, 0.65, 1.45], '#6b4a2a'));
      anchors.contact = [0, 0.95, 0];
      break;
    case 'door': {
      root.add(box('post_l', [0.1, 2.1, 0.12], [-0.5, 1.05, 0], '#7a5230'), box('post_r', [0.1, 2.1, 0.12], [0.5, 1.05, 0], '#7a5230'), box('lintel', [1.1, 0.1, 0.12], [0, 2.15, 0], '#7a5230'));
      const hinge = new Node('hinge').at(-0.45, 0, 0);
      hinge.add(box('panel', [0.9, 2.0, 0.05], [0.45, 1.0, 0], '#c8553d'), partNode({ id: 'knob', shape: 'sphere', size: [0.035], pos: [0.8, 0.95, 0.05], color: '#e3c15a' }));
      root.add(hinge);
      anchors.handle = [0.35, 0.95, 0.08]; // on the panel, hinge-local x offset added in doorHandle()
      return { root, anchors, hinge };
    }
    case 'button_desk': case 'coin_desk': {
      const desk = buildProp(lib.props['student_desk@1.0.0'], 'desk'); root.add(desk.root);
      if (kind === 'button_desk') {
        const b = buildProp(lib.props['suspicious_button@1.0.0'], 'button'); b.root.pos = [0, 0.76, 0]; root.add(b.root);
        for (const [k, v] of Object.entries({ ...b.manifest.anchors })) anchors[k] = [v[0], v[1] + 0.76, v[2]];
        anchors.contact = anchors.press_surface;
      } else {
        const c = buildProp(lib.props['spark_coin@1.0.0'], 'coin'); c.root.pos = [0, 0.76, 0]; root.add(c.root);
        for (const [k, v] of Object.entries({ ...c.manifest.grips })) anchors[k] = [v[0], v[1] + 0.76, v[2]];
        anchors.grip = anchors.rim;
        mover = { node: c.root, offset: [0, 0.76, 0] };
      }
      break;
    }
  }
  return { root, anchors, mover };
}

// ---------------------------------------------------------------- stage

export interface StripFrame { t: number; u: number; camera: { pos: Vec3; target: Vec3; fovY: number } }

export class StripStage {
  readonly root = new Node('strip-stage');
  readonly rig: Rig;
  readonly track: LibraryTrack;
  readonly face: FaceTrack;
  readonly spec: StripSpec;
  readonly start: number;
  readonly dur: number;
  readonly env: EnvironmentManifest;
  private readonly props = new Map<string, StageProp>();
  constructor(spec: StripSpec, lib: StripLibrary) {
    this.spec = spec;
    this.env = lib.environments['classroom@1.1.0'];
    this.root.add(buildEnvironment(this.env, 0.6).root);
    this.rig = buildCharacter(lib.characters['zapp@1.0.0']);
    this.root.add(this.rig.root);
    for (const p of spec.props ?? []) {
      const b = placeholder(p.kind, lib);
      const rot = qEuler(0, (p.yaw ?? 0) * DEG, 0);
      b.root.pos = p.at; b.root.rot = rot;
      this.root.add(b.root);
      this.props.set(p.id, { ...b, id: p.id, kind: p.kind, base: { pos: p.at, rot }, held: p.held });
    }
    const def = LIB_ACTIONS[spec.action];
    const face = spec.action === 'talk' || spec.action === 'expressions';
    this.dur = spec.dur ?? def?.defaultDuration ?? 1.5;
    let t = 0.3;
    const acts: LibTrackAction[] = [];
    for (const p of spec.pre ?? []) { acts.push({ actor: 'zapp', action: p.action, start: t, duration: p.dur, ...(p.to ? { to: p.to } : {}), ...(p.params ? { params: p.params } : {}) }); t += p.dur; }
    this.start = t;
    if (!face) acts.push({ actor: 'zapp', action: spec.action, start: t, duration: this.dur, ...(spec.to ? { to: spec.to } : {}), ...(spec.target ? { target: spec.target } : {}), ...(spec.params ? { params: spec.params } : {}) });
    const startPos: Vec3 = [spec.from[0], 0, spec.from[1]];
    const res = { point: (id: string, tt: number) => this.point(id, tt), markFacing: () => undefined };
    this.track = new LibraryTrack('zapp', this.rig, acts, startPos, spec.yaw, res, 20260930);
    const allowed = this.rig.manifest.allowedExpressions;
    const beats = spec.action === 'expressions'
      ? [{ start: 0, end: t + 0.9, expressionId: 'neutral' }, { start: t + 0.9, end: t + 1.9, expressionId: 'shocked' }, { start: t + 1.9, end: t + 9, expressionId: 'determined' }]
      : [{ start: 0, end: t + this.dur + 2, expressionId: allowed[0] }];
    const mouth = spec.action === 'talk' ? new PhraseMouth([{ speaker: 'zapp', start: t, end: t + this.dur, text: 'Free coins? Oh no, not again!' }], 'zapp') : undefined;
    this.face = new FaceTrack({ seed: this.track.seed, allowed, beats, duration: t + this.dur + 2, mouth });
  }

  /** ctx of the shown action at t (for its prop / face / door cues) */
  private ctx(t: number): ActionCtx {
    const lt = Math.min(Math.max(t - this.start, 0), this.dur);
    return { lt, d: this.dur, u: lt / this.dur, t, seed: this.track ? this.track.seed : 0, params: (this.spec.params ?? {}) as Record<string, number | boolean> };
  }
  private doorOpen(t: number): number {
    const def = LIB_ACTIONS[this.spec.action];
    if (this.spec.action === 'enter_door' || this.spec.action === 'exit_door') return 1;
    return def?.door ? def.door(this.ctx(t)) : 0;
  }
  private anchorWorld(p: StageProp, name: string, t: number): Vec3 {
    if (p.kind === 'door' && name === 'handle') {
      const ang = this.doorOpen(t) * 100 * DEG, local = qRotate(qEuler(0, -ang, 0), [0.8, 0.95, 0.08]);
      return add(p.base.pos, qRotate(p.base.rot, [local[0] - 0.45, local[1], local[2]]));
    }
    const a = p.anchors[name];
    return add(p.base.pos, qRotate(p.base.rot, a));
  }
  /** PointResolver: marks, `<prop>.<anchor|role>`, 'face' */
  point(id: string, t: number): Vec3 | undefined {
    if (STRIP_MARKS[id]) return STRIP_MARKS[id];
    if (id === 'face') { const r = this.track ? this.track.rootAt(t).pos : [this.spec.from[0], 0, this.spec.from[1]]; return [r[0], 1.6, r[2] + 0.34]; }
    const [pid, a] = id.split('.');
    const p = this.props.get(pid);
    if (!p) return undefined;
    const names = a in ANCHOR_ROLES ? ANCHOR_ROLES[a as AnchorRole] : [a];
    const n = names.find((k) => k in p.anchors || (p.kind === 'door' && k === 'handle'));
    return n ? this.anchorWorld(p, n, t) : undefined;
  }

  /** pose everything at t */
  apply(t: number): void {
    this.track.apply(t);
    const def = LIB_ACTIONS[this.spec.action];
    const c = this.ctx(t);
    // props: held props follow the hand (attach cue), thrown props fly from the release point
    for (const p of this.props.values()) {
      if (p.kind === 'door') { if (p.hinge) p.hinge.rot = qEuler(0, -this.doorOpen(t) * 100 * DEG, 0); continue; }
      const cue = def?.props?.(c);
      const movable = p.held || (cue && this.spec.target?.startsWith(`${p.id}.`));
      this.placeNode(p.root, p.base);
      if (p.mover) { p.mover.node.pos = [...p.mover.offset] as Vec3; p.mover.node.rot = [0, 0, 0, 1]; }
      if (!movable || !cue || cue.attach <= 0 && cue.releaseU === undefined && !p.held) continue;
      const off = p.mover?.offset ?? [0, 0, 0];
      const grip = p.anchors[ANCHOR_ROLES[cue.grip].find((k) => k in p.anchors) ?? 'grip'] ?? [0, 0, 0];
      const localGrip: Vec3 = [grip[0] - off[0], grip[1] - off[1], grip[2] - off[2]];
      const free: PropPlacement = { pos: add(p.base.pos, qRotate(p.base.rot, off)), rot: p.base.rot };
      let pl: PropPlacement;
      if (cue.releaseU !== undefined && c.u >= cue.releaseU) pl = this.releasePlacement(t, cue.releaseU, localGrip, cue.hand);
      else pl = blendPlacement(free, attachToHand(this.rig, cue.hand, localGrip), cue.attach);
      if (p.mover) this.placeWorldChild(p.root, p.mover.node, pl);
      else this.placeNode(p.root, pl);
    }
    this.root.updateWorld();
    const f = this.face.at(t, def?.face?.(c));
    applyFace(this.rig, f);
  }
  private releasePlacement(t: number, releaseU: number, localGrip: Vec3, hand: 'l' | 'r'): PropPlacement {
    const tr = this.start + releaseU * this.dur;
    this.track.apply(tr);
    const rel = attachToHand(this.rig, hand, localGrip);
    const tgt = this.spec.target ? this.point(this.spec.target, tr) ?? STRIP_MARKS.aside : STRIP_MARKS.aside;
    const v = throwVelocity(rel.pos, tgt, 0.55);
    const fl = flightAt(rel.pos, v, t - tr, { floorY: 0.11 });
    this.track.apply(t);
    return { pos: fl.pos, rot: qMul(qEuler(fl.spinDeg * DEG, 0, 0), rel.rot) };
  }
  private placeNode(n: Node, pl: PropPlacement): void { n.pos = [...pl.pos] as Vec3; n.rot = [...pl.rot] as Quat; }
  /** place a child node at a world placement under an unrotated-or-yawed parent */
  private placeWorldChild(parent: Node, child: Node, pl: PropPlacement): void {
    const inv: Quat = [-parent.rot[0], -parent.rot[1], -parent.rot[2], parent.rot[3]];
    const d: Vec3 = [pl.pos[0] - parent.pos[0], pl.pos[1] - parent.pos[1], pl.pos[2] - parent.pos[2]];
    child.pos = qRotate(inv, d); child.rot = qMul(inv, pl.rot);
  }

  /** evenly spaced frame times over the shown action (both ends included) and a fixed camera framing it */
  frames(n: number): StripFrame[] {
    const cam = this.spec.cam ?? {};
    const center = cam.center ?? (this.spec.to ? [(this.spec.from[0] + (STRIP_MARKS[this.spec.to]?.[0] ?? 0)) / 2, (this.spec.from[1] + (STRIP_MARKS[this.spec.to]?.[2] ?? 0)) / 2] : this.spec.from);
    const az = (cam.az ?? 25) * DEG, dist = cam.dist ?? 4.0, y = cam.y ?? 0.95;
    const target: Vec3 = [center[0], y, center[1]];
    const pos: Vec3 = [center[0] + Math.sin(az) * dist, y + (cam.h ?? 0.35), center[1] + Math.cos(az) * dist];
    return Array.from({ length: n }, (_, i) => {
      const u = i / (n - 1);
      return { t: this.start + u * this.dur, u, camera: { pos, target, fovY: 38 * DEG } };
    });
  }
}
