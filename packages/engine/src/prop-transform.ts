// Generic prop-transform helpers: apply an externally planned transform (position of the prop origin, uniform scale,
// Euler rotation, visibility) directly to a prop instance and measure it back from the node's world matrix.
// Nothing here simulates or re-plans motion: the transform is taken verbatim.
import type { PropInstance } from './build.ts';
import type { Node } from './gl/scene.ts';
import { DEG, m4Invert, m4Mul, m4TRS, m4TransformPoint, qEuler, qMul, type Mat4, type Quat, type Vec3 } from './math.ts';

export interface PlannedPropTransform { pos: Vec3; scale: number; rotDeg: Vec3; visible: boolean }

/** same Euler convention as PropTrack.apply: Ry * Rx * Rz */
export const propQuat = (r: Vec3): Quat => qMul(qEuler(0, r[1] * DEG, 0), qMul(qEuler(r[0] * DEG, 0, 0), qEuler(0, 0, r[2] * DEG)));
export const propMatrix = (x: PlannedPropTransform): Mat4 => m4TRS(x.pos, propQuat(x.rotDeg), [x.scale, x.scale, x.scale]);

/**
 * Apply a WORLD-space planned transform to a prop root. When the root is parented (e.g. a button on a desk) the
 * transform is converted into the parent's frame so the resulting world transform is still the planned one.
 * Scale is always uniform (props forbid non-uniform scale: a coin never becomes a flat slab).
 */
export function applyPropTransform(inst: PropInstance, x: PlannedPropTransform): void {
  const r = inst.root;
  r.visible = x.visible;
  if (r.parent) {
    r.parent.updateWorld(parentChainWorld(r.parent));
    const local = m4Mul(m4Invert(r.parent.world), propMatrix(x));
    const p = [local[12], local[13], local[14]] as Vec3;
    const sx = Math.hypot(local[0], local[1], local[2]);
    r.pos = p; r.scl = [sx, sx, sx];
    r.rot = quatFromScaledMat(local, sx);
  } else {
    r.pos = [...x.pos] as Vec3; r.rot = propQuat(x.rotDeg); r.scl = [x.scale, x.scale, x.scale];
  }
  r.updateWorld(r.parent ? r.parent.world : undefined);
}
function parentChainWorld(n: Node): Mat4 | undefined { if (!n.parent) return undefined; n.parent.updateWorld(parentChainWorld(n.parent)); return n.parent.world; }
function quatFromScaledMat(m: Mat4, s: number): Quat {
  const a = [m[0] / s, m[1] / s, m[2] / s, m[4] / s, m[5] / s, m[6] / s, m[8] / s, m[9] / s, m[10] / s];
  const [m00, m10, m20, m01, m11, m21, m02, m12, m22] = a, tr = m00 + m11 + m22;
  if (tr > 0) { const S = Math.sqrt(tr + 1) * 2; return [(m21 - m12) / S, (m02 - m20) / S, (m10 - m01) / S, 0.25 * S]; }
  if (m00 > m11 && m00 > m22) { const S = Math.sqrt(1 + m00 - m11 - m22) * 2; return [0.25 * S, (m01 + m10) / S, (m02 + m20) / S, (m21 - m12) / S]; }
  if (m11 > m22) { const S = Math.sqrt(1 + m11 - m00 - m22) * 2; return [(m01 + m10) / S, 0.25 * S, (m12 + m21) / S, (m02 - m20) / S]; }
  const S = Math.sqrt(1 + m22 - m00 - m11) * 2; return [(m02 + m20) / S, (m12 + m21) / S, 0.25 * S, (m10 - m01) / S];
}

/** button cap / lamp / glow parts (same material mapping as PropTrack.apply) */
export function applyButtonState(inst: PropInstance, capDepth: number, glow: number): void {
  const cap = inst.parts['cap'];
  if (cap) {
    const baseY = inst.manifest.parts.find((p) => p.id === 'cap')!.pos[1];
    cap.pos = [cap.pos[0], baseY - 0.028 * capDepth, cap.pos[2]];
    cap.material!.emissive = [0.9 * glow + 0.08, 0.05 * glow, 0.06 * glow];
  }
  for (const lamp of ['lamp_l', 'lamp_r']) { const n = inst.parts[lamp]; if (n) n.material!.emissive = [0.05 * glow, 0.6 * glow + 0.05, 0.25 * glow]; }
  inst.root.updateWorld(inst.root.parent ? inst.root.parent.world : undefined);
}

/** measured world transform of a prop root (read back from its world matrix) */
export function measuredPropTransform(inst: PropInstance): { pos: Vec3; scale: number; axisY: Vec3 } {
  const m = inst.root.world, s = Math.hypot(m[0], m[1], m[2]);
  return { pos: [m[12], m[13], m[14]], scale: s, axisY: [m[4] / s, m[5] / s, m[6] / s] };
}

// ---------- cylinder (disc) props: coin geometry measured from the node ----------
/** manifest cylinder: radius (x/z) and full thickness (local y) at scale 1 */
export function discDims(inst: PropInstance): { radius: number; thickness: number } {
  const d = inst.manifest.dimensions;
  return { radius: Math.max(d[0], d[2]) / 2, thickness: d[1] };
}
/** world-space lowest point of the disc (rim sampled at 0.5 deg): the contact/base point for a standing coin */
export function discLowestPoint(inst: PropInstance): Vec3 {
  const { radius, thickness } = discDims(inst), m = inst.root.world, pts: Vec3[] = [];
  for (const yy of [-thickness / 2, thickness / 2]) for (let k = 0; k < 720; k++) {
    const a = (k / 720) * 2 * Math.PI, w = m4TransformPoint(m, [radius * Math.cos(a), yy, radius * Math.sin(a)]);
    pts.push([w[0], w[1], w[2]]);
  }
  // centroid of the lowest contact set (a single rim point for a standing disc, the face centre for a flat one)
  const lo = Math.min(...pts.map((p) => p[1])), tol = 1e-6 * Math.max(1, Math.hypot(m[0], m[1], m[2]));
  const set = pts.filter((p) => p[1] <= lo + tol);
  return [set.reduce((a, p) => a + p[0], 0) / set.length, lo, set.reduce((a, p) => a + p[2], 0) / set.length];
}
/** world thickness / radius of the disc as rendered (uniform scale from the world matrix) */
export function discWorldSize(inst: PropInstance): { radius: number; thickness: number; scaleX: number; scaleY: number; scaleZ: number } {
  const m = inst.root.world, sx = Math.hypot(m[0], m[1], m[2]), sy = Math.hypot(m[4], m[5], m[6]), sz = Math.hypot(m[8], m[9], m[10]), d = discDims(inst);
  return { radius: d.radius * Math.max(sx, sz), thickness: d.thickness * sy, scaleX: sx, scaleY: sy, scaleZ: sz };
}
/** signed distance (m) from a world point to the disc solid (negative = inside) */
export function discSignedDistance(inst: PropInstance, p: Vec3): number {
  const { radius, thickness } = discDims(inst), inv = m4Invert(inst.root.world), l = m4TransformPoint(inv, p), s = Math.hypot(inst.root.world[0], inst.root.world[1], inst.root.world[2]);
  const dr = Math.hypot(l[0], l[2]) - radius, dy = Math.abs(l[1]) - thickness / 2;
  const out = Math.hypot(Math.max(dr, 0), Math.max(dy, 0)), inside = Math.min(Math.max(dr, dy), 0);
  return (out + inside) * s;
}
