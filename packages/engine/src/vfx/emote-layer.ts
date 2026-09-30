// Emote billboards (S7): turns merged emote contributions into textured quads above/beside each target's head.
// Icons always face the camera; offsets are applied in the camera plane (+x = screen right, +y = world up) so a sweat
// drop sits beside the head whichever way the character faces. Supports per-icon roll and opacity.
import type { CameraState } from '../gl/renderer.ts';
import { plane } from '../gl/geometry.ts';
import { Node } from '../gl/scene.ts';
import { m4LookAt, qFromBasis, type Vec3 } from '../math.ts';
import { emoteTexture } from './emote-icons.ts';
import type { EmoteContribution } from './defs.ts';

/** icon edge length in metres at scale 1 */
export const EMOTE_SIZE = 0.34;

export class EmoteLayer {
  readonly root = new Node('s7:emotes');
  private pool: Node[] = [];

  /** `headTop(target)` = world point at the top of the target's head (e.g. rig.headTop.worldPos()) */
  update(emotes: readonly EmoteContribution[], headTop: (target: string) => Vec3 | undefined, cam: CameraState): void {
    const vm = m4LookAt(cam.pos, cam.target, [0, 1, 0], cam.roll ?? 0);
    const R: Vec3 = [vm[0], vm[4], vm[8]], U: Vec3 = [vm[1], vm[5], vm[9]], B: Vec3 = [vm[2], vm[6], vm[10]];
    let k = 0;
    for (const e of emotes) {
      const h = headTop(e.target);
      if (!h || e.scale <= 0.01) continue;
      const n = this.node(k++);
      const [ox, oy] = e.offset ?? [0.12, 0.3];
      n.pos = [h[0] + R[0] * ox, h[1] + oy, h[2] + R[2] * ox];
      const s = e.scale;
      n.scl = [s, s, s];
      const a = e.rot ?? 0, c = Math.cos(a), sn = Math.sin(a);
      const r2: Vec3 = [R[0] * c + U[0] * sn, R[1] * c + U[1] * sn, R[2] * c + U[2] * sn];
      const u2: Vec3 = [U[0] * c - R[0] * sn, U[1] * c - R[1] * sn, U[2] * c - R[2] * sn];
      n.rot = qFromBasis(r2, u2, B);
      n.material!.texture = emoteTexture(String(e.symbol));
      n.material!.opacity = e.alpha ?? 1;
      n.visible = true;
    }
    for (let i = k; i < this.pool.length; i++) this.pool[i].visible = false;
  }

  private node(i: number): Node {
    while (this.pool.length <= i) {
      const n = new Node(`s7:emote:${this.pool.length}`, plane(EMOTE_SIZE, EMOTE_SIZE), { color: [1, 1, 1], unlit: true, alphaTest: 0.5, texture: emoteTexture('exclaim') });
      n.castShadow = false; n.visible = false;
      this.root.add(n); this.pool.push(n);
    }
    return this.pool[i];
  }
}
