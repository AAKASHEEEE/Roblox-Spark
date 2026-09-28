// Node entry point for headless engine evaluation (see packages/engine/src/headless.ts) + a convenience pose reader.
import type { Vec3 } from '../../../packages/engine/src/math.ts';
import { headlessEngine, projectionRenderer, type HeadlessEngine } from '../../../packages/engine/src/headless.ts';
export { headlessEngine, projectionRenderer, type HeadlessEngine };
/** @deprecated name kept for dev scripts */
export const headlessRenderer = projectionRenderer;

/** world positions of an actor's hands, head probes, face and root after evaluate(t) */
export function actorPoints(e: HeadlessEngine, actor: string): { hands: { l: Vec3; r: Vec3 }; head: Vec3[]; face: Vec3; faceN: Vec3; root: Vec3; probes: Array<{ name: string; p: Vec3 }> } {
  const rig = e.prod.rigs.get(actor)!;
  const w = rig.face.world;
  const n = Math.hypot(w[8], w[9], w[10]) || 1;
  return {
    hands: { l: rig.hand_l.worldPos() as Vec3, r: rig.hand_r.worldPos() as Vec3 },
    head: rig.probes.filter((p) => p.name.startsWith('probe:head')).map((p) => p.worldPos() as Vec3),
    face: rig.face.worldPos() as Vec3, faceN: [w[8] / n, w[9] / n, w[10] / n],
    root: rig.root.worldPos() as Vec3,
    probes: rig.probes.map((p) => ({ name: p.name, p: p.worldPos() as Vec3 })),
  };
}
