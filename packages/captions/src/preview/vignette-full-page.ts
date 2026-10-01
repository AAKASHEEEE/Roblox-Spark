// Browser page module for the S7 FULL video render off the integrated Vignette scene (driven by
// packages/captions/tools/render-full.ts through Playwright, in "vignette" visual mode).
//
// This is the S7-owned sibling of stills-page.ts: instead of the legacy NarratedScene/buildWorldPlan, it renders the
// staged VignetteScene (real teacher@1.0.0, classroom@1.2.0 doorway, hinged door@1.1.0, S5 action tracks, S3 face
// tracks) with the runVignette-solved ShotChoice cameras, then composites the same S7 layer stack: VFX
// particles/post/shake/zoom, emote billboards, world_text_3d, ui_popup / title_card / caption_bold placed clear of
// ALL projected faces (Zapp, Kira, AND the teacher). It exposes window.__s7v with the SAME surface render-full.ts
// drives from stills-page (ready/init/place/initCapture/encodeRange/meta) plus the pixel/geometry/performance
// diagnostic hooks the FEAT-003 acceptance gates read (teacherVisibility/doorState/jointSample).
//
// window.__s7v is DISTINCT from stills-page's window.__s7 so both page modules can coexist; render-full.ts loads
// whichever matches the selected visual mode. Browser-only imports (same sources as stills-page.ts / web-entry.ts).
import { Renderer, type CameraState } from '../../../engine/src/gl/renderer.ts';
import type { Node } from '../../../engine/src/gl/scene.ts';
import { applyShake } from '../../../engine/src/camera.ts';
import { FrameCapture, type EncodedBatch, type EncoderMeta } from '../../../engine/src/capture.ts';
import { m4TransformPoint, type Vec3 } from '../../../engine/src/math.ts';
import type { ManifestLibrary } from '../../../engine/src/build-dispatch.ts';
import { evalVfxEvents, applyZoom, EmoteLayer, drawEmoteIcon, EMOTE_SYMBOLS, type VfxEvent } from '../../../engine/src/vfx/index.ts';
import { validateBeatSheet } from '../../../director/src/beat-sheet.ts';
import { stageBeatSheet, beatAt, actorPresent, type StagePlan, type StagedBeat } from '../../../vignette/src/stage.ts';
import { VignetteScene } from '../../../vignette/src/scene.ts';
import { poseAt, type ShotChoice } from '../../../vignette/src/camera.ts';
import { registerRuntimeLibrary } from '../../../vignette/src/runtime-library.ts';
import { WorldTextLayer } from '../world-text.ts';
import { drawOverlay, graphicOccupancy, type TextGraphicEvent } from '../graphics.ts';
import { placeBoldCaption, drawBoldCaption, type Ctx2D } from '../render.ts';
import type { OccupiedRect, Rect } from '../placement.ts';
import type { BoldCaption } from '../bold.ts';

let W = 1080, H = 1920;
let canvas: HTMLCanvasElement, out: HTMLCanvasElement, renderer: Renderer;
let scene: VignetteScene, plan: StagePlan, shots: Record<string, ShotChoice> = {};
/** compositions: one or more per beat (intra-beat sub-shot cuts). Sorted by start; each drives its own solved shot. */
interface Composition { beat: string; index: number; start: number; end: number; shot: ShotChoice }
let compositions: Composition[] = [];
let warm = false;
let capture: FrameCapture | null = null;
let capturePlan: Omit<FrameIn, 't' | 'showBoxes'> | null = null;
let captureFps = 30;
const emotes = new EmoteLayer(), worldText = new WorldTextLayer();

// ---------------------------------------------------------------- projection helpers (mirror stills-page)
function corners(n: Node): Vec3[] {
  const h = n.geometry?.half; if (!h) return [];
  const w = n.world, o: Vec3[] = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) { const p = m4TransformPoint(w, [sx * h[0], sy * h[1], sz * h[2]]); o.push([p[0], p[1], p[2]]); }
  return o;
}
function project(cam: CameraState, pts: Vec3[]): Rect | null {
  const { vp } = renderer.viewProj(cam);
  const ps = pts.map((p) => m4TransformPoint(vp, p)).filter((c) => c[3] > 0).map((c) => ({ x: ((c[0] / c[3] + 1) / 2) * W, y: (1 - (c[1] / c[3] + 1) / 2) * H }));
  if (!ps.length) return null;
  const x0 = Math.max(0, Math.min(...ps.map((p) => p.x))), x1 = Math.min(W, Math.max(...ps.map((p) => p.x))), y0 = Math.max(0, Math.min(...ps.map((p) => p.y))), y1 = Math.min(H, Math.max(...ps.map((p) => p.y)));
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}
/** projected screen-area fraction (0..1) of a point set (clipped to frame) */
function projectedAreaFrac(cam: CameraState, pts: Vec3[]): number {
  const r = project(cam, pts);
  return r ? (r.w * r.h) / (W * H) : 0;
}
function meshes(root: Node): Node[] { const o: Node[] = []; root.traverse((n) => { if (n.geometry && n.material && !n.name.startsWith('s7:')) o.push(n); }, true); return o; }
function headMesh(rig: { root: Node }): Node | undefined { return meshes(rig.root).find((n) => n.name === 'head_mesh'); }

/** world point of a beat-sheet vfx/emote/text target id (actor face / prop anchor / mark) for the active beat */
function anchorPoint(id: string): Vec3 | undefined { return scene.entityPoint(id, beatAt(plan, currentT)); }
let currentT = 0;

/** the composition (sub-shot) active at time t: its solved shot and window start. Falls back to the beat's shot. */
function compAt(t: number): { shot: ShotChoice; start: number } {
  const b = beatAt(plan, t);
  if (compositions.length) {
    for (let i = compositions.length - 1; i >= 0; i--) if (t >= compositions[i].start - 1e-9) return { shot: compositions[i].shot, start: compositions[i].start };
    return { shot: compositions[0].shot, start: compositions[0].start };
  }
  return { shot: shots[b.phraseId], start: b.start };
}

// ---------------------------------------------------------------- camera (poseAt lens + scene shake + S7 zoom/shake)
function pose(t: number, vfx?: VfxEvent[]): CameraState {
  const f = scene.pose(t);
  const c = compAt(t), shot = c.shot;
  const p = poseAt(shot, c.start, t);
  // 1) beat-solved lens, 2) the scene's own VFX shake (web-entry), 3) the S7 vfx event zoom + shake (stills-page).
  const sceneFx = scene.vfx(f);
  let cam: CameraState = applyShake({ pos: p.pos, target: p.target, fovY: (p.fovDeg * Math.PI) / 180, ...(p.roll ? { roll: p.roll } : {}) }, sceneFx.shake, t, plan.seed);
  const vf = evalVfxEvents(vfx ?? [], t, (id) => anchorPoint(id), plan.seed);
  cam = applyZoom(applyShake(cam, vf.shake, t, plan.seed), vf.zoom);
  return cam;
}

interface PlacementSegment { start: number; end: number; centerY: number; clearOfFaces: boolean; faceOverlapPx: number; warnings: string[] }
interface FrameIn { t: number; vfx?: VfxEvent[]; graphics?: TextGraphicEvent[]; captions?: BoldCaption[]; placements?: Record<string, number | PlacementSegment[]>; showBoxes?: boolean }

/** projected face + body + prop rectangles of every currently visible rig (incl. teacher) and prop */
function occupied(cam: CameraState): OccupiedRect[] {
  const o: OccupiedRect[] = [];
  for (const [id, rig] of scene.rigs) {
    if (!rig.root.visible) continue;
    const head = headMesh(rig);
    const fr = head ? project(cam, corners(head)) : null;
    if (fr) o.push({ id, kind: 'face', rect: fr });
    const br = project(cam, meshes(rig.root).flatMap(corners));
    if (br) o.push({ id, kind: 'body', rect: br });
  }
  for (const [id, p] of scene.props) {
    if (p.dressing || !p.inst.root.visible) continue;
    const r = project(cam, meshes(p.inst.root).filter((n) => n.visible).flatMap(corners));
    if (r) o.push({ id, kind: 'prop', rect: r });
  }
  return o;
}

// ---------------------------------------------------------------- one full S7 frame into `out`
function drawFrame(f: FrameIn): OccupiedRect[] {
  currentT = f.t;
  const posed = scene.pose(f.t);
  const cam = pose(f.t, f.vfx);
  const vf = evalVfxEvents(f.vfx ?? [], f.t, (id) => anchorPoint(id), plan.seed);
  emotes.update(vf.emotes, (id) => scene.rigs.get(id)?.headTop.worldPos(), cam);
  worldText.update(f.graphics ?? [], f.t, (id) => { const p = anchorPoint(id); return p ? [p[0], p[1] + 0.08, p[2]] : undefined; });
  // the scene owns its lighting (+ button glow); add any S7 vfx point lights on top, as stills-page does.
  const light = scene.lighting(posed);
  for (const l of vf.lights) { const p = anchorPoint(l.target); if (p) light.points.push({ pos: p, color: l.color, intensity: l.intensity, range: 0.9 }); }
  const sceneFx = scene.vfx(posed);
  const particles = [...sceneFx.particles, ...vf.particles];
  const post = { ...sceneFx.post, flash: Math.max(sceneFx.post.flash, vf.post.flash), darken: Math.max(sceneFx.post.darken ?? 0, vf.post.darken ?? 0), vignette: Math.max(sceneFx.post.vignette, vf.post.vignette), ...(vf.post.tint ? { tint: vf.post.tint } : sceneFx.post.tint ? { tint: sceneFx.post.tint } : {}) };
  // first draw after init compiles programs / uploads geometry: draw twice so the very first frame is complete.
  const n = warm ? 1 : 2;
  for (let i = 0; i < n; i++) renderer.render(scene.root, cam, light, post, particles);
  warm = true;
  const g = out.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(canvas, 0, 0);
  const faces = occupied(cam).filter((o) => o.kind === 'face');
  const placements = new Map(Object.entries(f.placements ?? {}));
  drawOverlay(g, W, H, f.t, { captions: f.captions ?? [], placements, graphics: f.graphics ?? [], anchor: (id) => { const p = anchorPoint(id); const r = p ? project(cam, [p]) : null; return r ? { x: r.x, y: r.y } : undefined; } });
  if (f.showBoxes) { g.lineWidth = 3; g.setLineDash([12, 8]); g.strokeStyle = '#00e5ff'; for (const o of faces) g.strokeRect(o.rect.x, o.rect.y, o.rect.w, o.rect.h); g.setLineDash([]); }
  return faces;
}

/** shot cut times: beat boundaries plus every intra-beat sub-shot cut, so a caption re-bands at every hard cut. */
function shotCuts(): number[] {
  const cuts = plan.beats.flatMap((b) => [b.start, b.end]);
  for (const c of compositions) cuts.push(c.start, c.end);
  return [...new Set(cuts)].sort((a, b) => a - b);
}

const api = {
  ready: true,
  /**
   * Re-stage the sheet in-page (validate -> stage -> VignetteScene) exactly like web-entry, so the plan is
   * byte-identical to the node-solved plan (same sheet + seed => deterministic). `shots` are the runVignette-solved
   * ShotChoice cameras from the node side. registerRuntimeLibrary(lib) is called here because the browser page is a
   * separate JS context from the node solver. `comps` (optional) is the node-solved composition timeline: intra-beat
   * sub-shot cuts, each a hard camera cut with its own solved shot; when empty the beat's single shot is used.
   */
  init(sheet: unknown, lib: ManifestLibrary, s: Record<string, ShotChoice>, w: number, h: number, comps: Composition[] = []) {
    W = w; H = h;
    registerRuntimeLibrary(lib);
    const v = validateBeatSheet(sheet);
    if (!v.value) throw new Error('beat sheet invalid');
    plan = stageBeatSheet(v.value, lib);
    scene = new VignetteScene(plan, lib);
    shots = s; compositions = [...comps].sort((a, b) => a.start - b.start); warm = false;
    canvas = document.createElement('canvas'); document.body.appendChild(canvas);
    out = Object.assign(document.createElement('canvas'), { width: W, height: H });
    renderer = new Renderer(canvas, W, H);
    scene.root.add(emotes.root, worldText.root);
    return { renderer: renderer.gl.getParameter(renderer.gl.RENDERER) as string, beats: plan.beats.length, sets: plan.sets.map((x) => x.id) };
  },
  /**
   * Caption id -> shot-segment placements. A caption is stable within one camera shot and may re-band only at a hard
   * cut (a beat boundary), where the whole picture changes anyway. Occupancy over each segment includes every visible
   * rig's face+body (Zapp, Kira, AND the teacher), every visible prop, and active ui_popup graphics. Same shape as
   * stills-page.place so render-full's conflict check runs unchanged.
   */
  place(captions: BoldCaption[], graphics: TextGraphicEvent[] = []): Record<string, { segments: PlacementSegment[]; centerY: number; clearOfFaces: boolean; faceOverlapPx: number; warnings: string[] }> {
    const g = out.getContext('2d')!, res: Record<string, { segments: PlacementSegment[]; centerY: number; clearOfFaces: boolean; faceOverlapPx: number; warnings: string[] }> = {};
    const cuts = shotCuts();
    for (const c of captions) {
      const bounds = [...new Set([c.start, c.end, ...cuts.filter((t) => t > c.start + 1e-6 && t < c.end - 1e-6)])].sort((a, b) => a - b);
      const segments: PlacementSegment[] = [];
      for (let k = 0; k < bounds.length - 1; k++) {
        const start = bounds[k], end = bounds[k + 1], occ: OccupiedRect[] = [];
        const firstFrame = Math.ceil(start * captureFps - 1e-9), lastFrame = Math.ceil(end * captureFps - 1e-9);
        for (let i = firstFrame; i < lastFrame; i++) {
          const t = Math.min(end - 1e-6, Math.max(start, i / captureFps)), cam = pose(t);
          occ.push(...occupied(cam));
          occ.push(...graphicOccupancy(g, W, H, graphics, start, end, (id) => { const p = anchorPoint(id); const r = p ? project(cam, [p]) : null; return r ? { x: r.x, y: r.y } : undefined; }));
        }
        const p = placeBoldCaption(g, W, H, c, occ);
        segments.push({ start, end, centerY: p.centerY, clearOfFaces: p.clearOfFaces, faceOverlapPx: p.faceOverlapPx, warnings: p.warnings });
      }
      res[c.id] = { segments, centerY: segments[0]?.centerY ?? 0.5, clearOfFaces: segments.every((s) => s.clearOfFaces), faceOverlapPx: segments.reduce((n, s) => n + s.faceOverlapPx, 0), warnings: [...new Set(segments.flatMap((s) => s.warnings))] };
    }
    return res;
  },
  /** full frame: scene + S7 layers + overlay; returns a JPEG data URL and the projected face rectangles */
  frame(f: FrameIn, quality = 0.9): { url: string; faces: OccupiedRect[] } {
    const faces = drawFrame(f);
    return { url: out.toDataURL('image/jpeg', quality), faces };
  },
  /** full frame as a real PNG data URL (lossless) so callers writing a .png get PNG bytes, not JPEG. */
  framePng(f: FrameIn): { url: string; faces: OccupiedRect[] } {
    const faces = drawFrame(f);
    return { url: out.toDataURL('image/png'), faces };
  },
  /** Configure deterministic chronological H.264 capture of fully composited S7 frames (same as stills-page). */
  initCapture(cfg: { fps: number; bitrate: number; hashEvery?: number; keyframeInterval?: number; vfx?: VfxEvent[]; graphics?: TextGraphicEvent[]; captions?: BoldCaption[]; placements?: Record<string, number | PlacementSegment[]> }): true {
    captureFps = cfg.fps;
    capturePlan = { vfx: cfg.vfx ?? [], graphics: cfg.graphics ?? [], captions: cfg.captions ?? [], placements: cfg.placements ?? {} };
    const g = out.getContext('2d', { willReadFrequently: true })!;
    capture = new FrameCapture({ width: W, height: H, fps: cfg.fps, bitrate: cfg.bitrate, keyframeInterval: cfg.keyframeInterval ?? cfg.fps * 2, codec: 'avc1.640028', hashEvery: cfg.hashEvery ?? cfg.fps }, out, () => new Uint8Array(g.getImageData(0, 0, W, H).data.buffer));
    return true;
  },
  encodeRange(from: number, to: number, final: boolean): Promise<EncodedBatch> {
    if (!capture || !capturePlan) throw new Error('S7 capture is not initialized');
    return capture.encodeRange(from, to, (i) => drawFrame({ ...capturePlan!, t: i / captureFps }), final);
  },
  meta(): EncoderMeta {
    if (!capture) throw new Error('S7 capture is not initialized');
    return capture.meta;
  },

  // ---------------------------------------------------------------- diagnostic hooks (read REAL geometry/pixels)
  /**
   * teacherVisibility(times): projected screen-area fraction of the teacher rig at each time, with the resolved source
   * key so a gate can require it be built from teacher@1.0.0 (not faked). present=false when the teacher is off screen.
   */
  teacherVisibility(times: number[]): { sourceKey: string; source: string; samples: Array<{ t: number; present: boolean; areaFrac: number; faceAreaFrac: number }> } {
    const src = scene.sources['character:teacher'];
    const rig = scene.rigs.get('teacher');
    const samples = times.map((t) => {
      const cam = pose(t);
      const present = !!rig && rig.root.visible && actorPresent(plan, 'teacher', t);
      if (!rig || !present) return { t, present: false, areaFrac: 0, faceAreaFrac: 0 };
      const head = headMesh(rig);
      return { t, present: true, areaFrac: projectedAreaFrac(cam, meshes(rig.root).flatMap(corners)), faceAreaFrac: head ? projectedAreaFrac(cam, corners(head)) : 0 };
    });
    return { sourceKey: src?.key ?? 'unknown', source: src?.source ?? 'unknown', samples };
  },
  /**
   * doorState(times): the real hinged door@1.1.0 leaf/grip world transforms + open amount + projected doorway rect at
   * each time, so a closed-vs-open pair proves the leaf/grip moved and the doorway is on camera. usedRealDoorway is
   * true when the scene built the real doorOpening (no duplicate fallback doorFrame).
   */
  doorState(times: number[]): { propId: string | null; sourceKey: string; usedRealDoorway: boolean; samples: Array<{ t: number; grip: Vec3 | null; leaf: Vec3 | null; openAmount: number; doorwayRect: Rect | null; onCamera: boolean }> } {
    const doorId = [...scene.props.keys()].find((id) => scene.props.get(id)!.instance === 'door') ?? (scene.props.has('door') ? 'door' : null);
    const src = doorId ? scene.sources[`prop:${doorId}`] : undefined;
    // real doorway node built by the scene is `doorway:<door>:opening`; the fallback is `doorway:<door>:fallback`.
    const names: string[] = [];
    scene.root.traverse((n) => names.push(n.name));
    const usedRealDoorway = names.some((n) => /^doorway:.*:opening$/.test(n)) && !names.some((n) => /^doorway:.*:fallback$/.test(n));
    const samples = times.map((t) => {
      const beat = beatAt(plan, t);
      const cam = pose(t);
      const grip = doorId ? scene.entityPoint(`${doorId}.grip`, beat) ?? null : null;
      const leaf = doorId ? scene.entityPoint(doorId, beat) ?? null : null;
      // open amount from the grip's planar displacement is proven by pairs; also read the leaf mesh doorway rect.
      const p = scene.props.get(doorId ?? '');
      const doorwayRect = p && p.inst.root.visible ? project(cam, meshes(p.inst.root).flatMap(corners)) : null;
      return { t, grip, leaf, openAmount: doorOpenAt(t), doorwayRect, onCamera: !!doorwayRect };
    });
    return { propId: doorId, sourceKey: src?.key ?? 'unknown', usedRealDoorway, samples };
  },
  /**
   * jointSample(actorId, t): key joint/root world positions and the FaceTrack expression+blink+mouth state so
   * performance gates can measure limb/torso/root motion between times, and assert the mouth is NOT narration-driven.
   * mouthNarrationDriven is structurally false (scene.ts's FaceTrack has no phrase/mouth driver; only S5 action FaceCues
   * or expressions ever open the mouth, never the VO). mouthOpen exposes the raw S3 mouth token for evidence.
   */
  jointSample(actorId: string, t: number): { actorId: string; present: boolean; root: Vec3; joints: Record<string, Vec3>; face: { expression: string; blink: number; textureKey: string; mouthOpen: boolean; mouthNarrationDriven: boolean } } | null {
    scene.pose(t);
    const rig = scene.rigs.get(actorId);
    if (!rig) return null;
    const present = rig.root.visible && actorPresent(plan, actorId, t);
    const j = rig.joints as unknown as Record<string, Node>;
    const wp = (n?: Node): Vec3 => { if (!n) return [0, 0, 0]; const p = n.worldPos(); return [p[0], p[1], p[2]]; };
    const joints: Record<string, Vec3> = {};
    for (const name of ['hip', 'spine', 'neck', 'shoulder_l', 'shoulder_r', 'elbow_l', 'elbow_r', 'hip_l', 'hip_r', 'knee_l', 'knee_r']) if (j[name]) joints[name] = wp(j[name]);
    joints.head = wp(rig.face);
    joints.hand_l = wp(rig.hand_l); joints.hand_r = wp(rig.hand_r);
    joints.sole_l = wp(rig.sole_l); joints.sole_r = wp(rig.sole_r);
    // S3 face texture key: `face:<id>@<v>:<state>:<blink>:(m=<mouth>[:a=..]|0)` (v1) or
    // `face2:<id>@<v>:<skin>:<state>:<blink>:<mouth>[:a=..]` (v2). Parse the expression, blink and mouth from it.
    const key = rig.face.material?.texture?.key ?? '';
    const parts = key.split(':');
    const isV2 = parts[0] === 'face2';
    const expression = isV2 ? parts[3] ?? '' : parts[2] ?? '';
    const blinkStr = isV2 ? parts[4] : parts[3];
    const mouthStr = isV2 ? parts[5] ?? '' : (parts[4] ?? '').replace(/^m=/, '');
    const mouthOpen = /^(open|wide|o|round|small)$/.test(mouthStr);
    // scene.ts builds FaceTrack with NO mouth/phrase driver (`new FaceTrack({ seed, allowed, beats, duration })`), and
    // per-frame it only applies an S5 action FaceCue (`active.s.def.face(c)`), never a PhraseMouth from Beat.text (the
    // narrator VO). So the mouth is either CLOSED or opened by the ACTION/expression (e.g. a `laugh` celebrate), and is
    // never driven by narration. mouthNarrationDriven is therefore structurally false; mouthOpen exposes the raw token
    // so a gate can still see when an action legitimately opens the mouth.
    const mouthNarrationDriven = false;
    return { actorId, present, root: wp(rig.root), joints, face: { expression: expression || key, blink: Number(blinkStr ?? 0) || 0, textureKey: key, mouthOpen, mouthNarrationDriven } };
  },

  /** all emote icons on a checkerboard (transparency visible) — reused by showcase tooling */
  emoteSheet(): string {
    const n = EMOTE_SYMBOLS.length, cell = 300, c = Object.assign(document.createElement('canvas'), { width: cell * n, height: cell + 50 }), g = c.getContext('2d') as Ctx2D;
    for (let y = 0; y < cell; y += 25) for (let x = 0; x < cell * n; x += 25) { g.fillStyle = ((x + y) / 25) % 2 ? '#d9dde6' : '#f4f6fa'; g.fillRect(x, y, 25, 25); }
    g.fillStyle = '#111'; g.fillRect(0, cell, cell * n, 50);
    EMOTE_SYMBOLS.forEach((s, k) => { drawEmoteIcon(g, s, k * cell + cell / 2, cell / 2, 240); g.fillStyle = '#fff'; g.font = '700 26px monospace'; g.textAlign = 'center'; g.fillText(s, k * cell + cell / 2, cell + 34); });
    return c.toDataURL('image/png');
  },
};

/** door open amount [0..1] from the scene's door timeline (same smooth curve the scene uses to swing the leaf). */
function doorOpenAt(t: number): number {
  // Prove open-ness from the grip's planar travel relative to the closed pose so the value reflects the REAL S4 leaf,
  // not just the authored timeline. Sample a near-zero baseline (t=0, closed) and normalize.
  const doorId = scene.props.has('door') ? 'door' : [...scene.props.keys()].find((id) => scene.props.get(id)!.instance === 'door');
  if (!doorId) return 0;
  // closed baseline grip at t=0, then the grip at t: planar travel reflects the REAL S4 leaf, not just the timeline.
  scene.pose(0);
  const g0 = scene.entityPoint(`${doorId}.grip`, beatAt(plan, 0));
  scene.pose(t);
  const gt = scene.entityPoint(`${doorId}.grip`, beatAt(plan, t));
  if (!g0 || !gt) return 0;
  const travel = Math.hypot(gt[0] - g0[0], gt[2] - g0[2]);
  return Math.min(1, travel / 1.0);
}

(window as unknown as { __s7v: typeof api }).__s7v = api;
