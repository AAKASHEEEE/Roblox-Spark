// Neutral exact-time Vignette render primitive. This is intentionally free of S7 caption/evidence policy so the
// supported packages/vignette/src/web-entry.ts can consume it once that package's owner wires the integration.
import { Renderer, type CameraState } from '../../../engine/src/gl/renderer.ts';
import { applyShake } from '../../../engine/src/camera.ts';
import type { ManifestLibrary } from '../../../engine/src/build-dispatch.ts';
import type { Vec3 } from '../../../engine/src/math.ts';
import { applyZoom, evalVfxEvents, type VfxEvent } from '../../../engine/src/vfx/index.ts';
import { validateBeatSheet } from '../../../director/src/beat-sheet.ts';
import { poseAt, type ShotChoice } from '../../../vignette/src/camera.ts';
import { registerRuntimeLibrary } from '../../../vignette/src/runtime-library.ts';
import { VignetteScene } from '../../../vignette/src/scene.ts';
import { beatAt, stageBeatSheet, type StagePlan, type StagedBeat } from '../../../vignette/src/stage.ts';
import { assertCompositionTimeline, compositionAt, type TimedComposition } from './composition.ts';
import { ExactFrameLease, type FrameLease } from './frame-lease.ts';

export type VignetteComposition = TimedComposition<ShotChoice>;
type PosedFrame = ReturnType<VignetteScene['pose']>;
type SceneEffects = ReturnType<VignetteScene['vfx']>;
type S7Effects = ReturnType<typeof evalVfxEvents>;

export interface VignetteFrameContext {
  readonly t: number;
  /** Internal freshness token; consumers must not retain frame contexts across another frame() call. */
  readonly lease: FrameLease;
  readonly posed: PosedFrame;
  readonly beat: StagedBeat;
  readonly composition?: VignetteComposition;
  /** Camera after the solved lens, scene shake, and all S7 shake/zoom effects. */
  readonly camera: CameraState;
  readonly sceneEffects: SceneEffects;
  readonly s7Effects: S7Effects;
  /** Resolve against the scene pose and beat for this exact frame only. */
  anchor(id: string): Vec3 | undefined;
}

export interface VignetteRenderSessionOptions {
  sheet: unknown;
  library: ManifestLibrary;
  shots: Record<string, ShotChoice>;
  compositions?: readonly VignetteComposition[];
  width: number;
  height: number;
}

/**
 * The shared validate -> register -> stage -> pose -> final-camera -> render path. Caption placement, diagnostics,
 * and evidence policy stay in the caller; both the Vignette web entry and S7 adapter can use this same primitive.
 */
export class VignetteRenderSession {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: Renderer;
  readonly plan: StagePlan;
  readonly scene: VignetteScene;
  readonly shots: Record<string, ShotChoice>;
  readonly compositions: readonly VignetteComposition[];
  private warm = false;
  private readonly frameLease = new ExactFrameLease();

  constructor(options: VignetteRenderSessionOptions) {
    const validation = validateBeatSheet(options.sheet);
    if (!validation.value) throw new Error('beat sheet invalid');
    registerRuntimeLibrary(options.library);
    this.plan = stageBeatSheet(validation.value, options.library);
    this.scene = new VignetteScene(this.plan, options.library);
    this.shots = options.shots;
    this.compositions = [...(options.compositions ?? [])];
    assertCompositionTimeline(this.compositions);
    this.canvas = document.createElement('canvas');
    document.body.appendChild(this.canvas);
    this.renderer = new Renderer(this.canvas, options.width, options.height);
  }

  /** Prepare one exact-time scene pose and the final camera used by both rendering and placement. */
  frame(t: number, vfx: readonly VfxEvent[] = []): VignetteFrameContext {
    if (!Number.isFinite(t) || t < 0 || t > this.plan.duration + 1e-6) throw new Error(`frame time outside stage: ${t}`);
    const lease = this.frameLease.issue(t);
    const posed = this.scene.pose(t);
    const beat = beatAt(this.plan, t);
    const composition = compositionAt(this.compositions, t, beat.phraseId);
    const shot = composition?.shot ?? this.shots[beat.phraseId];
    if (!shot) throw new Error(`no solved shot for beat ${beat.phraseId} at ${t}`);
    const shotStart = composition?.start ?? beat.start;
    const pose = poseAt(shot, shotStart, t);
    const sceneEffects = this.scene.vfx(posed);
    const anchor = (id: string): Vec3 | undefined => {
      this.frameLease.assertCurrent(lease);
      this.scene.pose(t);
      return this.scene.entityPoint(id, beat);
    };
    let camera: CameraState = applyShake({
      pos: pose.pos,
      target: pose.target,
      fovY: (pose.fovDeg * Math.PI) / 180,
      ...(pose.roll ? { roll: pose.roll } : {}),
    }, sceneEffects.shake, t, this.plan.seed);
    const s7Effects = evalVfxEvents(vfx as VfxEvent[], t, anchor, this.plan.seed);
    camera = applyZoom(applyShake(camera, s7Effects.shake, t, this.plan.seed), s7Effects.zoom);
    return { t, lease, posed, beat, composition, camera, sceneEffects, s7Effects, anchor };
  }

  /** Draw the exact prepared frame. Callers may update extra scene nodes (emotes/world text) before invoking this. */
  render(frame: VignetteFrameContext): void {
    this.frameLease.assertCurrent(frame.lease);
    // Restore the shared scene to the leased time in case a diagnostic posed it directly between frame() and render().
    this.scene.pose(frame.t);
    const lighting = this.scene.lighting(frame.posed);
    for (const light of frame.s7Effects.lights) {
      const point = frame.anchor(light.target);
      if (point) lighting.points.push({ pos: point, color: light.color, intensity: light.intensity, range: 0.9 });
    }
    const scenePost = frame.sceneEffects.post, s7Post = frame.s7Effects.post;
    const post = {
      ...scenePost,
      flash: Math.max(scenePost.flash, s7Post.flash),
      darken: Math.max(scenePost.darken ?? 0, s7Post.darken ?? 0),
      vignette: Math.max(scenePost.vignette, s7Post.vignette),
      ...(s7Post.tint ? { tint: s7Post.tint } : scenePost.tint ? { tint: scenePost.tint } : {}),
    };
    const particles = [...frame.sceneEffects.particles, ...frame.s7Effects.particles];
    const draws = this.warm ? 1 : 2;
    for (let i = 0; i < draws; i++) this.renderer.render(this.scene.root, frame.camera, lighting, post, particles);
    this.warm = true;
  }
}
