// Vignette scene runtime: every set of the episode built once (engine build dispatch -> SetStack), one rig per
// character, one engine prop per instance, placeholder labels. pose(t) shows exactly the beat's set, samples the
// authoritative world plan and lets the existing NarratedEngineAdapter pose rigs / coin / button from the WorldState;
// staging-owned props (doors, placeholders, dressing, held / on placements) are placed here. Browser-safe (no node).
import { buildProp, type PropInstance, type Rig } from '../../engine/src/build.ts';
import { dispatchCharacter, dispatchProp, dispatchSet, type BuildSource, type ManifestLibrary } from '../../engine/src/build-dispatch.ts';
import type { BuiltProp, PropBuilder } from '../../library/src/types.ts';
import { LibraryTrack } from '../../engine/src/animation/lib/track.ts';
import { LIB_ACTIONS } from '../../engine/src/animation/lib/registry.ts';
import { resolveAnchor } from '../../engine/src/animation/lib/anchors.ts';
import { attachToHand, blendPlacement } from '../../engine/src/animation/lib/attach.ts';
import { FaceTrack } from '../../engine/src/animation/face-track.ts';
import { applyS3FaceFrame } from '../../engine/src/faces/face-track-adapter.ts';
import { faceStatesFor } from '../../engine/src/faces/index.ts';
import { anchorLocal, DOOR, type RiggedProp } from '../../engine/src/props/index.ts';
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
const DOOR_SWING_SEC = 0.3;
const smooth = (u: number) => { const x = Math.max(0, Math.min(1, u)); return x * x * (3 - 2 * x); };

export interface PosedFrame { t: number; world: WorldState; diag: AdapterDiagnostics; beat: StagedBeat; set: StagedSet }
export interface SceneProp {
  inst: PropInstance; instance: string; source: BuildSource; key: string; dressing: boolean; setId: string | null;
  built?: BuiltProp; builder?: PropBuilder;
}
interface ActionRuntime { track: LibraryTrack; prop?: string; door?: string }

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
  private readonly doorLeaves = new Map<string, { prop: SceneProp; setId: string; doorId: string; facingDeg: number }>();
  private readonly actionTracks = new Map<string, ActionRuntime>();
  private readonly faceTracks = new Map<string, FaceTrack>();

  constructor(plan: StagePlan, lib: ManifestLibrary) {
    this.plan = plan;
    this.root.add(this.stack.root, this.actorsRoot, this.propsRoot);
    const realDoorways = new Set(Object.values(plan.props).filter((p) => p.propId === 'door' && p.resolution.resolution === 'available').flatMap((p) => p.spans.filter((sp) => sp.kind === 'door').map((sp) => `${sp.setId}:${sp.target}`)));
    // ---- sets (dispatch: builder -> manifest -> placeholder), dressing, doorways, placeholder set labels
    for (const s of plan.sets) {
      const d = dispatchSet(s.resolution === 'available' ? s.key : s.id, s.resolution === 'available' ? lib : EMPTY, { seed: plan.seed, placeholder: () => s.manifest });
      const st = this.stack.add(s.id, d.key, d.env, s.origin);
      this.sources[`set:${s.id}`] = { kind: 'set', source: d.source, key: d.key };
      const local = (p: readonly number[]): Vec3 => [p[0] - s.origin[0], p[1] - s.origin[1], p[2] - s.origin[2]];
      for (const dr of s.dressing) {
        const d = dispatchProp(dr.propRef, dr.instance, lib, { seed: plan.seed, placeholder: placeholderProp });
        d.inst.root.pos = local(dr.pos); d.inst.root.rot = qEuler(0, dr.yawDeg * DEG, 0);
        st.content.add(d.inst.root);
        this.props.set(dr.instance, { inst: d.inst, instance: dr.instance, source: d.source, key: d.key, dressing: true, setId: s.id, ...(d.built ? { built: d.built } : {}), ...(d.builder ? { builder: d.builder } : {}) });
      }
      for (const door of Object.values(s.doors)) if (door.source === 'staging') {
        const point = local(door.threshold);
        st.content.add(realDoorways.has(`${s.id}:${door.id}`) ? doorOpening(door.id, point, door.facingDeg) : doorFrame(door.id, point, door.facingDeg));
      }
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
      const sceneProp: SceneProp = { inst: d.inst, instance: p.instance, source: d.source, key: d.key, dressing: false, setId: null, ...(d.built ? { built: d.built } : {}), ...(d.builder ? { builder: d.builder } : {}) };
      this.props.set(p.instance, sceneProp);
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
          this.doorLeaves.set(p.instance, { prop: sceneProp, setId: set!.id, doorId: door.id, facingDeg: door.facingDeg });
        }
      }
    }
    // ---- S5 body/action tracks and S3 face tracks. Narration text is not supplied as speech, so it never lip-syncs.
    let faceSeed = plan.seed;
    for (const [id, rig] of this.rigs) {
      const beats = plan.beats.flatMap((b) => b.cast.filter((c) => c.id === id).map((c) => ({ start: b.start, end: b.end, expressionId: c.face.requested })));
      this.faceTracks.set(id, new FaceTrack({ seed: faceSeed++, allowed: faceStatesFor(rig.manifest), beats, duration: plan.duration }));
    }
    for (const b of plan.beats) for (const sc of b.cast) {
      if (sc.play.runtime !== 'library') continue;
      const def = LIB_ACTIONS[sc.actionId];
      if (!def) continue;
      const propIds = b.props;
      const spanOf = (id: string) => plan.props[id]?.spans.find((sp) => sp.beat === b.phraseId);
      const door = propIds.find((id) => spanOf(id)?.kind === 'door' && (!sc.lookAt || spanOf(id)?.target === sc.lookAt))
        ?? (def.needs?.includes('door') ? propIds.find((id) => spanOf(id)?.kind === 'door') : undefined);
      const held = propIds.find((id) => { const sp = spanOf(id); return sp?.kind === 'held' && sp.target === sc.id; });
      const looked = sc.lookAt && plan.props[sc.lookAt] ? sc.lookAt : undefined;
      const prop = door ?? held ?? looked;
      let target = sc.lookAt ?? undefined;
      if (prop && def.targetRole) {
        const anchor = resolveAnchor(this.props.get(prop)!.inst.manifest, def.targetRole);
        if (anchor) target = `${prop}.${anchor}`;
      }
      const start = Math.max(b.start, Math.min(sc.actionT0, b.end - 0.05));
      const duration = Math.max(0.05, Math.min(def.defaultDuration, b.end - start));
      const actor = sampleWorld(plan.world, start).actors[sc.id];
      const resolver = {
        point: (id: string, _t?: number) => id === '__staged_to' ? sc.to : this.entityPoint(id, b) ?? actor.pos,
        markFacing: (id: string) => id === '__staged_to' ? actor.yawDeg : (plan.sets.find((s) => s.id === b.setId)?.marks[id]?.facingDeg ?? 0),
      };
      const track = new LibraryTrack(sc.id, this.rigs.get(sc.id)!, [{ actor: sc.id, action: sc.actionId, start, duration, ...(def.locomotion ? { to: '__staged_to' } : {}), ...(target ? { target } : {}) }], sc.from, actor.yawDeg, resolver, plan.seed);
      this.actionTracks.set(`${sc.id}@${b.phraseId}`, { track, ...(prop ? { prop } : {}), ...(door ? { door } : {}) });
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
      // ui_popup is rendered as a real screen-space card by the vignette overlay, not as a grey 3D placeholder.
      if (ev.type === 'text_graphic' && ev.textStyleId === 'ui_popup') continue;
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

  /** world point of an entity (actor head / posed prop anchor / prop centre / mark / door) at the current pose */
  entityPoint(id: string, beat: StagedBeat): Vec3 | undefined {
    const dot = id.indexOf('.');
    if (dot > 0) {
      const p = this.props.get(id.slice(0, dot)), anchor = id.slice(dot + 1);
      const n = p?.inst.anchors[anchor];
      if (n) { p!.inst.root.updateWorld(); const q = n.worldPos(); return [q[0], q[1], q[2]]; }
    }
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
    // Library door actions can override the event timeline while active; their pure curve drives S4's hinged leaf.
    const doorAmounts = new Map<string, number>();
    for (const sc of beat.cast) {
      const rt = this.actionTracks.get(`${sc.id}@${beat.phraseId}`), actor = world.actors[sc.id];
      if (!rt?.door || !actor) continue;
      const active = rt.track.activeAt(t, { pos: actor.pos, yaw: actor.yawDeg });
      const amount = active?.s.def.door?.(active.c);
      if (amount !== undefined) doorAmounts.set(rt.door, amount);
    }
    // staging-owned props: per-beat placement span; world props keep the adapter transform but follow the beat's roster
    for (const [id, p] of this.props) {
      if (p.dressing) continue;
      const staged = this.plan.props[id];
      const sp = staged?.spans.find((s) => t >= s.t0 - 1e-9 && t < s.t1 - 1e-9 && s.beat === beat.phraseId);
      const on = !!sp && sp.setId === beat.setId;
      if (staged?.world) { if (!on) p.inst.root.visible = false; continue; }
      if (!sp || !on) { p.inst.root.visible = false; continue; }
      const leaf = this.doorLeaves.get(id);
      if (leaf) {
        const open = doorAmounts.get(id) ?? this.doorOpenAmount(leaf.setId, leaf.doorId, t);
        if (p.built && p.builder && p.built.states.includes('open')) p.builder.applyState(p.built, 'open', open);
        applyPropTransform(p.inst, { pos: sp.pos, rotDeg: [0, leaf.facingDeg, 0], scale: 1, visible: true });
        continue;
      }
      if (p.built && p.builder && p.built.states.includes(sp.state)) {
        const prev = staged.spans.slice(0, staged.spans.indexOf(sp)).reverse().find((x) => x.setId === sp.setId);
        const u = prev && prev.state !== sp.state ? smooth((t - sp.t0) / DOOR_SWING_SEC) : 1;
        p.builder.applyState(p.built, sp.state, u);
      }
      let pos: Vec3 = sp.pos;
      if (sp.kind === 'held') { const r = this.rigs.get(sp.target); if (r) { this.actorsRoot.updateWorld(); const h = r.hand_r.worldPos(); pos = [h[0], Math.max(0, h[1] - p.inst.manifest.dimensions[1] * 0.95), h[2]]; } }
      else if (sp.kind === 'on') { const q = this.props.get(sp.target); if (q) { q.inst.root.updateWorld(); const w = q.inst.root.world; pos = [w[12], w[13] + q.inst.manifest.dimensions[1] * Math.hypot(w[4], w[5], w[6]), w[14]]; } }
      applyPropTransform(p.inst, { pos, rotDeg: [0, sp.yawDeg, 0], scale: 1, visible: true });
    }
    this.root.updateWorld();
    // S5 owns the body/action pose; the authoritative WorldPlan still owns each actor's root position and yaw.
    for (const sc of beat.cast) {
      const rt = this.actionTracks.get(`${sc.id}@${beat.phraseId}`), actor = world.actors[sc.id];
      if (rt && actor) rt.track.applyAtRoot(t, actor.pos, actor.yawDeg);
    }
    this.root.updateWorld();
    // Action prop cues apply real S4 states and hand attachment. Cup tilt is an attachment orientation, not a rig state.
    for (const sc of beat.cast) {
      const rt = this.actionTracks.get(`${sc.id}@${beat.phraseId}`), actor = world.actors[sc.id];
      if (!rt?.prop || !actor || rt.door) continue;
      const active = rt.track.activeAt(t, { pos: actor.pos, yaw: actor.yawDeg }), cue = active?.s.def.props?.(active.c);
      const p = this.props.get(rt.prop);
      if (!cue || !p || !p.inst.root.visible) continue;
      if (cue.state && p.built && p.builder && p.built.states.includes(cue.state.name)) p.builder.applyState(p.built, cue.state.name, cue.state.u);
      if (cue.attach <= 0) continue;
      const anchor = resolveAnchor(p.inst.manifest, cue.grip);
      if (!anchor) continue;
      const local = p.built ? anchorLocal(p.built as RiggedProp, anchor) : (p.inst.manifest.grips[anchor] ?? p.inst.manifest.anchors[anchor] ?? p.inst.manifest.effectAnchors[anchor]) as Vec3;
      const r = cue.orientation?.rotDeg ?? [0, 0, 0];
      const held = attachToHand(this.rigs.get(sc.id)!, cue.hand, local, 1, qEuler(r[0] * DEG, r[1] * DEG, r[2] * DEG));
      const placed = blendPlacement({ pos: [...p.inst.root.pos] as Vec3, rot: [...p.inst.root.rot] as [number, number, number, number] }, held, cue.attach);
      p.inst.root.pos = placed.pos; p.inst.root.rot = placed.rot; p.inst.root.visible = true;
    }
    this.root.updateWorld();
    // S5 FaceTrack drives S3's renderer. No PhraseMouth is created from Beat.text: that text is narrator VO only.
    for (const sc of beat.cast) {
      const rig = this.rigs.get(sc.id), track = this.faceTracks.get(sc.id);
      if (!rig || !track) continue;
      const rt = this.actionTracks.get(`${sc.id}@${beat.phraseId}`), actor = world.actors[sc.id];
      const active = rt && actor ? rt.track.activeAt(t, { pos: actor.pos, yaw: actor.yawDeg }) : undefined;
      applyS3FaceFrame(rig, track.at(t, active?.s.def.face?.(active.c)));
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

/** dark backing that masks an uncut staging wall through the real S4 frame; no duplicate posts, lintel, or leaf. */
function doorOpening(id: string, threshold: Vec3, facingDeg: number): Node {
  const g = new Node(`doorway:${id}:opening`);
  g.pos = [...threshold] as Vec3; g.rot = qEuler(0, facingDeg * DEG, 0);
  const gap = new Node(`${id}_gap`, roundedBox(DOOR.openingW, DOOR.openingH, 0.04, 0, 1), { color: [0.03, 0.03, 0.035], sheen: 0 });
  gap.pos = [0, DOOR.openingH / 2, -0.1]; g.add(gap);
  return g;
}

/** fallback frame used only when no real S4 door builder/manifest resolved. */
function doorFrame(id: string, threshold: Vec3, facingDeg: number): Node {
  const g = doorOpening(id, threshold, facingDeg);
  g.name = `doorway:${id}:fallback`;
  const mat = { color: [0.12, 0.11, 0.1] as [number, number, number], sheen: 0.1 };
  const jambX = DOOR.openingW / 2 + 0.05;
  for (const s of [-1, 1]) { const n = new Node(`${id}_post`, roundedBox(0.1, DOOR.frameH, 0.26, 0.01, 1), mat); n.pos = [s * jambX, DOOR.frameH / 2, 0]; g.add(n); }
  const l = new Node(`${id}_lintel`, roundedBox(DOOR.frameW, 0.1, 0.26, 0.01, 1), mat); l.pos = [0, DOOR.openingH + 0.05, 0]; g.add(l);
  return g;
}
