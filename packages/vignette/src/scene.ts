// Vignette scene runtime: every set of the episode built once (engine build dispatch -> SetStack), one rig per
// character, one engine prop per instance, placeholder labels. pose(t) shows exactly the beat's set, samples the
// authoritative world plan and lets the existing NarratedEngineAdapter pose rigs / coin / button from the WorldState;
// staging-owned props (doors, placeholders, dressing, held / on placements) are placed here. Browser-safe (no node).
import { buildProp, type PropInstance, type Rig } from '../../engine/src/build.ts';
import { dispatchCharacter, dispatchProp, dispatchSet, type BuildSource, type ManifestLibrary } from '../../engine/src/build-dispatch.ts';
import { SetStack, type StagedSet } from '../../engine/src/set-stack.ts';
import type { Lighting, Particle, PointLight, PostFx } from '../../engine/src/gl/renderer.ts';
import { Node } from '../../engine/src/gl/scene.ts';
import { roundedBox } from '../../engine/src/gl/geometry.ts';
import { DEG, m4TransformPoint, qEuler, type Vec3 } from '../../engine/src/math.ts';
import { applyPropTransform } from '../../engine/src/prop-transform.ts';
import { evalVfx } from '../../engine/src/vfx.ts';
import { VFX } from '../../schema/src/episode.ts';
import type { EpisodeVfx } from '../../schema/src/episode.ts';
import { sampleWorld, type WorldState } from '../../narrated/src/world.ts';
import { NarratedEngineAdapter, type AdapterDiagnostics } from '../../../apps/render-worker/narrated-world-adapter.ts';
import { labelNode } from './label.ts';
import { placeholderCharacter, placeholderProp } from './placeholders.ts';
import { actorPresent, beatAt, type StagePlan, type StagedBeat } from './stage.ts';

const EMPTY: ManifestLibrary = { characters: {}, props: {}, environments: {} };
const DOOR_OPEN_DEG = 80, DOOR_SWING_SEC = 0.3;
const smooth = (u: number) => { const x = Math.max(0, Math.min(1, u)); return x * x * (3 - 2 * x); };

export interface PosedFrame { t: number; world: WorldState; diag: AdapterDiagnostics; beat: StagedBeat; set: StagedSet }
export interface SceneProp { inst: PropInstance; instance: string; source: BuildSource; key: string; dressing: boolean; setId: string | null }

export class VignetteScene {
  readonly plan: StagePlan;
  readonly root = new Node('vignette');
  readonly stack = new SetStack();
  readonly actorsRoot = new Node('actors');
  readonly propsRoot = new Node('props');
  readonly rigs = new Map<string, Rig>();
  /** engine prop instances (EngineScene.props for the adapter) incl. set dressing */
  readonly props = new Map<string, SceneProp>();
  readonly sources: Record<string, { kind: 'set' | 'character' | 'prop'; source: BuildSource; key: string }> = {};
  readonly adapter: NarratedEngineAdapter;
  /** billboard labels over actors per beat (placeholder actions / faces) */
  private readonly actorLabels = new Map<string, Node>();
  /** event placeholder labels (planned VFX / text graphics), visible in their window */
  private readonly eventLabels: Array<{ node: Node; t0: number; t1: number; setId: string; target: string | null; lift: number }> = [];
  private readonly vfxEvents: Array<{ v: EpisodeVfx; setId: string }> = [];
  private readonly doorLeaves = new Map<string, { node: PropInstance; setId: string; doorId: string; hinge: Vec3; baseYaw: number; half: number }>();

  constructor(plan: StagePlan, lib: ManifestLibrary) {
    this.plan = plan;
    this.root.add(this.stack.root, this.actorsRoot, this.propsRoot);
    // ---- sets (dispatch: builder -> manifest -> placeholder), dressing, doorways, placeholder set labels
    for (const s of plan.sets) {
      const d = dispatchSet(s.resolution === 'available' ? s.key : s.id, s.resolution === 'available' ? lib : EMPTY, { seed: plan.seed, placeholder: () => s.manifest });
      const st = this.stack.add(s.id, d.key, d.env, s.origin);
      this.sources[`set:${s.id}`] = { kind: 'set', source: d.source, key: d.key };
      const local = (p: readonly number[]): Vec3 => [p[0] - s.origin[0], p[1] - s.origin[1], p[2] - s.origin[2]];
      for (const dr of s.dressing) {
        const inst = buildProp(lib.props[dr.propRef], dr.instance);
        inst.root.pos = local(dr.pos); inst.root.rot = qEuler(0, dr.yawDeg * DEG, 0);
        st.content.add(inst.root);
        this.props.set(dr.instance, { inst, instance: dr.instance, source: 'manifest', key: dr.propRef, dressing: true, setId: s.id });
      }
      for (const door of Object.values(s.doors)) if (door.source === 'staging') st.content.add(doorFrame(door.id, local(door.threshold), door.facingDeg));
      if (s.resolution === 'placeholder') {
        const lab = labelNode(`set_label:${s.id}`, [s.id.replace(/_/g, ' '), 'placeholder set'], 0.5);
        const b = s.manifest.bounds;
        lab.pos = [0, 2.5, b.min[2] + 0.02];
        st.content.add(lab);
      }
    }
    // ---- characters
    for (const c of Object.values(plan.characters)) {
      const ph = c.resolution.resolution === 'placeholder';
      const d = dispatchCharacter(c.ref, ph ? EMPTY : lib, { seed: plan.seed, placeholder: (id) => (ph ? c.manifest : placeholderCharacter(id)) });
      this.rigs.set(c.id, d.rig);
      this.sources[`character:${c.id}`] = { kind: 'character', source: d.source, key: d.key };
      this.actorsRoot.add(d.rig.root);
      if (d.source === 'placeholder') {
        const chest = labelNode(`label:${c.id}`, [c.id.replace(/_/g, ' ')], 0.09);
        const [, th, td] = d.rig.manifest.body.torso;
        chest.pos = [0, th * 0.62, td / 2 + 0.004];
        d.rig.joints.spine.add(chest);
      }
    }
    for (const b of plan.beats) for (const sc of b.cast) {
      if (!sc.labels.length) continue;
      const n = labelNode(`tag:${sc.id}:${b.phraseId}`, sc.labels.map((l) => l.replace(/_/g, ' ')), 0.075 * sc.labels.length, { billboard: true });
      n.visible = false;
      this.actorsRoot.add(n);
      this.actorLabels.set(`${sc.id}@${b.phraseId}`, n);
    }
    // ---- props
    for (const p of Object.values(plan.props)) {
      const ph = p.resolution.resolution === 'placeholder';
      const d = dispatchProp(p.ref, p.instance, ph ? EMPTY : lib, { seed: plan.seed, placeholder: (id) => placeholderProp(id) });
      this.props.set(p.instance, { inst: d.inst, instance: p.instance, source: d.source, key: d.key, dressing: false, setId: null });
      this.sources[`prop:${p.instance}`] = { kind: 'prop', source: d.source, key: d.key };
      this.propsRoot.add(d.inst.root);
      if (d.source === 'placeholder') {
        const m = d.inst.manifest, [w, h, dz] = m.dimensions;
        const lab = labelNode(`label:${p.instance}`, [p.propId.replace(/_/g, ' ')], Math.min(0.16, Math.max(0.05, Math.min(w, h) * 0.3)));
        lab.pos = [0, Math.min(h * 0.6, 1.5), dz / 2 + 0.004];
        d.inst.root.add(lab);
        if (Math.max(w, h) < 0.5) { const tag = labelNode(`tag:${p.instance}`, [p.propId.replace(/_/g, ' ')], 0.07, { billboard: true }); tag.pos = [0, h + 0.14, 0]; d.inst.root.add(tag); }
      }
      if (p.propId === 'door' || d.inst.manifest.category === 'door') {
        const span = p.spans.find((s) => s.kind === 'door');
        const set = span ? plan.sets.find((s) => s.id === span.setId) : undefined;
        const door = set && span ? set.doors[span.target] : undefined;
        if (door) {
          // closed leaf: its front (+z) faces into the room, its width runs along the wall
          const half = d.inst.manifest.dimensions[0] / 2, a = door.facingDeg * DEG;
          // hinge on the upstage jamb (away from the audience side): the open leaf never stands between the lens and the doorway
          const hinge: Vec3 = [door.threshold[0] + Math.cos(a) * half, 0, door.threshold[2] - Math.sin(a) * half];
          this.doorLeaves.set(p.instance, { node: d.inst, setId: set!.id, doorId: door.id, hinge, baseYaw: door.facingDeg, half });
        }
      }
    }
    // ---- events: engine VFX (available) and labelled placeholders (planned VFX / text graphics)
    const vfxNames = new Set<string>(VFX);
    for (const b of plan.beats) for (const e of b.events) {
      const ev = e.event;
      if (ev.type !== 'vfx' && ev.type !== 'text_graphic') continue;
      const dur = ev.type === 'text_graphic' ? ev.duration : ev.duration ?? 1.0;
      if (ev.type === 'vfx' && e.resolution?.resolution === 'available' && vfxNames.has(ev.vfxId)) {
        this.vfxEvents.push({ v: { type: ev.vfxId as EpisodeVfx['type'], at: ev.at, duration: ev.duration ?? defaultVfxDuration(ev.vfxId), ...(ev.target ? { target: ev.target } : {}) } as EpisodeVfx, setId: b.setId });
        continue;
      }
      const text = ev.type === 'vfx' ? [`vfx ${ev.vfxId.replace(/_/g, ' ')}`] : [`${ev.textStyleId.replace(/_/g, ' ')}`, ev.text];
      const n = labelNode(`event:${b.phraseId}:${e.index}`, text, 0.07 * text.length, { billboard: true, style: { fg: '#101010', bg: '#d0d0d0', border: '#303030' } });
      n.visible = false;
      this.root.add(n);
      this.eventLabels.push({ node: n, t0: ev.at, t1: ev.at + dur, setId: b.setId, target: ev.target ?? null, lift: ev.type === 'vfx' ? 0.55 : 0.8 });
    }
    // ---- adapter: the world plan is the only writer of rig / coin / button transforms
    this.adapter = new NarratedEngineAdapter({ propInstances: plan.adapter.propInstances, allowMissing: true });
    this.adapter.initialize({ ...plan.world, status: 'ok' }, { rigs: this.rigs, props: new Map([...this.props].map(([k, v]) => [k, { inst: v.inst }])) });
  }

  private engineScene() { return { rigs: this.rigs, props: new Map([...this.props].map(([k, v]) => [k, { inst: v.inst }])) }; }

  /** world point of an entity (actor head / prop centre / mark / door) at the current pose */
  entityPoint(id: string, beat: StagedBeat): Vec3 | undefined {
    const rig = this.rigs.get(id);
    if (rig) return rig.face.worldPos();
    const p = this.props.get(id);
    if (p) { const q = m4TransformPoint(p.inst.root.world, p.inst.manifest.collision.offset as Vec3); return [q[0], q[1], q[2]]; }
    const set = this.plan.sets.find((s) => s.id === beat.setId)!;
    if (set.marks[id]) { const m = set.marks[id].pos; return [m[0], 1.0, m[2]]; }
    if (set.doors[id]) { const m = set.doors[id].threshold; return [m[0], 1.2, m[2]]; }
    return undefined;
  }

  /** pose the whole scene at t (pure function of t; `previous` only feeds adapter diagnostics) */
  pose(t: number, previous: WorldState | null = null): PosedFrame {
    const beat = beatAt(this.plan, t);
    const set = this.stack.activate(beat.setId);
    const world = sampleWorld(this.plan.world, t);
    const diag = this.adapter.applySnapshot(world, previous, this.engineScene());
    diag.blocking = diag.blocking.filter((b) => b.code !== 'MISSING_ENGINE_ENTITY');
    for (const [id, rig] of this.rigs) rig.root.visible = actorPresent(this.plan, id, t, beat.setId);
    // staging-owned props: per-beat placement span; world props keep the adapter transform but follow the beat's roster
    for (const [id, p] of this.props) {
      if (p.dressing) continue;
      const sp = this.plan.props[id]?.spans.find((s) => t >= s.t0 - 1e-9 && t < s.t1 - 1e-9 && s.beat === beat.phraseId);
      const on = !!sp && sp.setId === beat.setId;
      if (this.plan.props[id]?.world) { if (!on) p.inst.root.visible = false; continue; }
      if (!on) { p.inst.root.visible = false; continue; }
      const leaf = this.doorLeaves.get(id);
      if (leaf) {
        const open = this.doorOpenAmount(leaf.setId, leaf.doorId, t);
        // opens into the room
        const yaw = leaf.baseYaw + open * DOOR_OPEN_DEG, a = yaw * DEG;
        applyPropTransform(p.inst, { pos: [leaf.hinge[0] - Math.cos(a) * leaf.half, 0, leaf.hinge[2] + Math.sin(a) * leaf.half], rotDeg: [0, yaw, 0], scale: 1, visible: true });
        continue;
      }
      let pos: Vec3 = sp.pos;
      if (sp.kind === 'held') { const r = this.rigs.get(sp.target); if (r) { this.actorsRoot.updateWorld(); const h = r.hand_r.worldPos(); pos = [h[0], Math.max(0, h[1] - p.inst.manifest.dimensions[1] * 0.95), h[2]]; } }
      else if (sp.kind === 'on') { const q = this.props.get(sp.target); if (q) { q.inst.root.updateWorld(); const w = q.inst.root.world; pos = [w[12], w[13] + q.inst.manifest.dimensions[1] * Math.hypot(w[4], w[5], w[6]), w[14]]; } }
      applyPropTransform(p.inst, { pos, rotDeg: [0, sp.yawDeg, 0], scale: 1, visible: true });
    }
    this.root.updateWorld();
    // labels: actor tags follow the head, event labels their target
    for (const [key, n] of this.actorLabels) {
      const [id, ph] = key.split('@');
      const rig = this.rigs.get(id)!;
      n.visible = ph === beat.phraseId && rig.root.visible;
      if (n.visible) { const h = rig.headTop.worldPos(); n.pos = [h[0], h[1] + 0.22, h[2]]; }
    }
    for (const e of this.eventLabels) {
      e.node.visible = t >= e.t0 && t < e.t1 && e.setId === beat.setId;
      if (!e.node.visible) continue;
      const p = e.target ? this.entityPoint(e.target, beat) : undefined;
      e.node.pos = p ? [p[0], p[1] + e.lift, p[2]] : [set.origin[0], 2.2, set.origin[2] + 0.5];
    }
    this.root.updateWorld();
    return { t, world, diag, beat, set };
  }

  private doorOpenAmount(setId: string, doorId: string, t: number): number {
    const d = this.plan.doors.find((x) => x.setId === setId && x.doorId === doorId);
    if (!d) return 0;
    let v = d.initialOpen ? 1 : 0;
    for (const c of d.changes) {
      if (c.t > t) break;
      const u = smooth((t - c.t) / DOOR_SWING_SEC);
      v = c.open ? v + (1 - v) * u : v * (1 - u);
    }
    return v;
  }

  /** lighting of the beat's set at the posed frame (+ the button glow, as the narrated scene) */
  lighting(f: PosedFrame): Lighting {
    const L = this.stack.lighting(f.set.id, f.beat.lighting);
    const pts: PointLight[] = [];
    const bid = this.plan.adapter.propInstances.button, b = bid ? this.props.get(bid) : undefined, glow = f.world.props.button?.glow ?? 0;
    const g = b?.inst.anchors.glow;
    if (g && glow > 0.01 && b!.inst.root.visible) { const p = g.worldPos(); pts.push({ pos: [p[0], p[1] + 0.05, p[2] + 0.05], color: [1, 0.22, 0.18], intensity: 0.9 * glow, range: 0.45 }); }
    L.points = pts;
    return L;
  }

  /** engine VFX of the beat's set at the posed frame (available VFX only; planned ones are labels) */
  vfx(f: PosedFrame): { particles: Particle[]; post: PostFx; shake: number } {
    const list = this.vfxEvents.filter((x) => x.setId === f.set.id).map((x) => x.v);
    const vf = evalVfx(list, f.t, (id) => this.entityPoint(id.split('.')[0], f.beat), this.plan.seed);
    return { particles: vf.particles, post: vf.post, shake: vf.shake };
  }
}

function defaultVfxDuration(id: string): number {
  return ({ confetti: 1.4, sparkle_burst: 0.9, dust_puff: 0.9, impact_ring: 0.6, screen_flash: 0.35, screen_shake: 0.6, glow_pulse: 1.2, shadow_looming: 1.5, speed_lines: 0.8, emote: 1.0 } as Record<string, number>)[id] ?? 0.8;
}

/** dark door frame (posts + lintel) standing in the wall at a staging doorway, set-local coordinates */
function doorFrame(id: string, threshold: Vec3, facingDeg: number): Node {
  const g = new Node(`doorway:${id}`);
  g.pos = [...threshold] as Vec3; g.rot = qEuler(0, facingDeg * DEG, 0);
  const mat = { color: [0.12, 0.11, 0.1] as [number, number, number], sheen: 0.1 };
  for (const s of [-1, 1]) { const n = new Node(`${id}_post`, roundedBox(0.1, 2.2, 0.26, 0.01, 1), mat); n.pos = [s * 0.56, 1.1, 0]; g.add(n); }
  const l = new Node(`${id}_lintel`, roundedBox(1.22, 0.12, 0.26, 0.01, 1), mat); l.pos = [0, 2.26, 0]; g.add(l);
  const gap = new Node(`${id}_gap`, roundedBox(1.02, 2.1, 0.04, 0, 1), { color: [0.03, 0.03, 0.035], sheen: 0 }); gap.pos = [0, 1.05, -0.1]; g.add(gap);
  return g;
}
