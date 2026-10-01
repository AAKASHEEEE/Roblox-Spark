// Walk paths for staging: shortest route on the floor (xz) around obstacle rectangles inflated by the body radius.
// Visibility graph over the inflated corners + Dijkstra; fully deterministic (ties broken by node order). An endpoint
// standing inside an inflated rectangle (a mark right behind a desk) shrinks only that rectangle's nearest face to the
// endpoint, so the route may leave / reach the mark but never cuts through the obstacle itself.
import type { Box2, Vec3 } from './sets.ts';

export const BODY_RADIUS = 0.2;
const EPS = 1e-4;

export interface PathResult { pts: Vec3[]; length: number; blockedBy: string | null; adjusted: string[] }

const inflate = (b: Box2, r: number): Box2 => ({ id: b.id, x0: b.x0 - r, x1: b.x1 + r, z0: b.z0 - r, z1: b.z1 + r });
const inside = (b: Box2, x: number, z: number, e = EPS) => x > b.x0 + e && x < b.x1 - e && z > b.z0 + e && z < b.z1 - e;
function shrinkFor(b: Box2, x: number, z: number): Box2 {
  if (!inside(b, x, z)) return b;
  const d = [x - b.x0, b.x1 - x, z - b.z0, b.z1 - z], k = d.indexOf(Math.min(...d)), c = { ...b }, m = 2e-3;
  if (k === 0) c.x0 = x + m; else if (k === 1) c.x1 = x - m; else if (k === 2) c.z0 = z + m; else c.z1 = z - m;
  return c;
}
/** does the open segment a->b pass through the open rectangle? (Liang-Barsky) */
export function segmentHits(b: Box2, ax: number, az: number, bx: number, bz: number): boolean {
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dz = bz - az;
  const clip = (p: number, q: number) => { if (Math.abs(p) < 1e-12) return q > 0; const r = q / p; if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; } return true; };
  if (!clip(-dx, ax - (b.x0 + EPS)) || !clip(dx, b.x1 - EPS - ax) || !clip(-dz, az - (b.z0 + EPS)) || !clip(dz, b.z1 - EPS - az)) return false;
  return t1 - t0 > 1e-6;
}

export function planPath(from: Vec3, to: Vec3, obstacles: Box2[], walk: Box2, r = BODY_RADIUS): PathResult {
  const adjusted: string[] = [];
  const boxes = obstacles.map((o) => {
    let b = inflate(o, r);
    const s1 = shrinkFor(b, from[0], from[2]), s2 = shrinkFor(s1, to[0], to[2]);
    if (s2 !== b) adjusted.push(o.id);
    b = s2;
    return b;
  });
  const clear = (a: number[], c: number[]) => boxes.every((b) => !segmentHits(b, a[0], a[1], c[0], c[1]));
  const A = [from[0], from[2]], B = [to[0], to[2]];
  const straight = Math.hypot(B[0] - A[0], B[1] - A[1]);
  if (clear(A, B)) return { pts: [[from[0], 0, from[2]], [to[0], 0, to[2]]], length: straight, blockedBy: null, adjusted };
  const m = 0.02, nodes: number[][] = [A, B];
  for (const b of boxes) for (const [x, z] of [[b.x0 - m, b.z0 - m], [b.x1 + m, b.z0 - m], [b.x0 - m, b.z1 + m], [b.x1 + m, b.z1 + m]]) {
    if (x < walk.x0 + r || x > walk.x1 - r || z < walk.z0 + r || z > walk.z1 - r) continue;
    if (boxes.some((o) => inside(o, x, z))) continue;
    nodes.push([x, z]);
  }
  const n = nodes.length, dist = new Array(n).fill(Infinity), prev = new Array(n).fill(-1), done = new Array(n).fill(false);
  dist[0] = 0;
  for (;;) {
    let u = -1;
    for (let i = 0; i < n; i++) if (!done[i] && dist[i] < Infinity && (u < 0 || dist[i] < dist[u] - 1e-12)) u = i;
    if (u < 0 || u === 1) break;
    done[u] = true;
    for (let v = 0; v < n; v++) {
      if (done[v] || v === u) continue;
      const w = Math.hypot(nodes[v][0] - nodes[u][0], nodes[v][1] - nodes[u][1]);
      if (dist[u] + w < dist[v] - 1e-12 && clear(nodes[u], nodes[v])) { dist[v] = dist[u] + w; prev[v] = u; }
    }
  }
  if (!(dist[1] < Infinity)) {
    const hit = boxes.find((b) => segmentHits(b, A[0], A[1], B[0], B[1]));
    // Never return the blocked direct segment: callers may report/fallback, but must not animate through a collider.
    return { pts: [[from[0], from[1], from[2]]], length: 0, blockedBy: hit?.id ?? 'walk-boundary', adjusted };
  }
  const idx: number[] = [];
  for (let k = 1; k >= 0; k = prev[k]) { idx.push(k); if (k === 0) break; }
  idx.reverse();
  return { pts: idx.map((k) => [nodes[k][0], 0, nodes[k][1]] as Vec3), length: dist[1], blockedBy: null, adjusted };
}
