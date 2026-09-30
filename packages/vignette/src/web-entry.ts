// Browser entry for vignette stills: rebuilds the staging plan and scene in-page from the beat sheet + library
// (deterministic, so it is the same plan the node analysis solved cameras on) and renders a beat's frame with the
// solved camera. window.__vignette = { ready, load(sheet, lib, shots, w, h), still(t) -> PNG data URL, describe(t) }.
import { Renderer } from '../../engine/src/gl/renderer.ts';
import { applyShake } from '../../engine/src/camera.ts';
import type { ManifestLibrary } from '../../engine/src/build-dispatch.ts';
import { validateBeatSheet } from '../../director/src/beat-sheet.ts';
import { stageBeatSheet, beatAt, type StagePlan } from './stage.ts';
import { VignetteScene } from './scene.ts';
import { poseAt, type ShotChoice } from './camera.ts';

let warm = false;
let canvas: HTMLCanvasElement | null = null, renderer: Renderer | null = null, scene: VignetteScene | null = null, plan: StagePlan | null = null, shots: Record<string, ShotChoice> = {};

const api = {
  ready: true,
  load(sheet: unknown, lib: ManifestLibrary, s: Record<string, ShotChoice>, w: number, h: number) {
    const v = validateBeatSheet(sheet);
    if (!v.value) throw new Error('beat sheet invalid');
    plan = stageBeatSheet(v.value, lib);
    scene = new VignetteScene(plan, lib);
    shots = s; warm = false;
    if (!canvas) { canvas = document.createElement('canvas'); document.body.appendChild(canvas); }
    if (!renderer || renderer.width !== w || renderer.height !== h) renderer = new Renderer(canvas, w, h);
    return { beats: plan.beats.length, sets: plan.sets.map((x) => x.id) };
  },
  still(t: number): string {
    if (!scene || !plan || !renderer) throw new Error('load() first');
    const f = scene.pose(t), b = beatAt(plan, t), shot = shots[b.phraseId];
    const p = poseAt(shot, b.start, t), fx = scene.vfx(f);
    const cam = applyShake({ pos: p.pos, target: p.target, fovY: (p.fovDeg * Math.PI) / 180, ...(p.roll ? { roll: p.roll } : {}) }, fx.shake, t, plan.seed);
    // the first draw after load uploads geometry / textures and compiles programs: draw it twice so the first still is complete
    const n = warm ? 1 : 2;
    for (let i = 0; i < n; i++) renderer.render(scene.root, cam, scene.lighting(f), fx.post, fx.particles);
    warm = true;
    return canvas!.toDataURL('image/png');
  },
  describe(t: number) { const b = plan ? beatAt(plan, t) : null; return b ? { beat: b.phraseId, set: b.setId } : null; },
};
(window as unknown as { __vignette: typeof api }).__vignette = api;
