// Procedural geometry generators. All original; no external meshes are required for the PoC.
export interface Geometry {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  /** local-space AABB half extents around origin (used by shot validation) */
  half: [number, number, number];
}

class Builder {
  p: number[] = []; n: number[] = []; u: number[] = []; i: number[] = [];
  vert(px: number, py: number, pz: number, nx: number, ny: number, nz: number, uu: number, vv: number): number {
    this.p.push(px, py, pz); this.n.push(nx, ny, nz); this.u.push(uu, vv);
    return this.p.length / 3 - 1;
  }
  tri(a: number, b: number, c: number) { this.i.push(a, b, c); }
  build(): Geometry {
  // Fix winding: ensure every triangle faces outward (robust against the per-face orientation logic above).
  const P = this.p, I = this.i;
  for (let k = 0; k < I.length; k += 3) {
    const ia = I[k] * 3, ib = I[k + 1] * 3, ic = I[k + 2] * 3;
    const e1 = [P[ib] - P[ia], P[ib + 1] - P[ia + 1], P[ib + 2] - P[ia + 2]];
    const e2 = [P[ic] - P[ia], P[ic + 1] - P[ia + 1], P[ic + 2] - P[ia + 2]];
    const cx = e1[1] * e2[2] - e1[2] * e2[1], cy = e1[2] * e2[0] - e1[0] * e2[2], cz = e1[0] * e2[1] - e1[1] * e2[0];
    const n = this.n;
    const d = cx * (n[ia] + n[ib] + n[ic]) + cy * (n[ia + 1] + n[ib + 1] + n[ic + 1]) + cz * (n[ia + 2] + n[ib + 2] + n[ic + 2]);
    if (d < 0) { const t = I[k + 1]; I[k + 1] = I[k + 2]; I[k + 2] = t; }
  }
    let hx = 0, hy = 0, hz = 0;
    for (let k = 0; k < this.p.length; k += 3) {
      hx = Math.max(hx, Math.abs(this.p[k])); hy = Math.max(hy, Math.abs(this.p[k + 1])); hz = Math.max(hz, Math.abs(this.p[k + 2]));
    }
    return {
      positions: new Float32Array(this.p), normals: new Float32Array(this.n), uvs: new Float32Array(this.u),
      indices: new Uint32Array(this.i), half: [hx, hy, hz],
    };
  }
}

/**
 * Box with softly bevelled edges (centered). bevel = radius; seg = bevel segments.
 * Built by projecting a subdivided cube onto an inner box + radius (rounded-box trick).
 */
export function roundedBox(w: number, h: number, d: number, bevel = 0.04, seg = 3): Geometry {
  const b = new Builder();
  const H: [number, number, number] = [w / 2, h / 2, d / 2];
  const r = Math.min(bevel, H[0], H[1], H[2]);
  const coords = (hl: number): number[] => {
    if (r <= 0) return [-hl, hl];
    const c: number[] = [];
    for (let k = 0; k <= seg; k++) c.push(-hl + (r * k) / seg);
    for (let k = seg; k >= 0; k--) c.push(hl - (r * k) / seg);
    // remove duplicates when hl == r
    return c.filter((v, idx) => idx === 0 || Math.abs(v - c[idx - 1]) > 1e-9);
  };
  const faces: Array<{ n: [number, number, number]; u: number; v: number }> = [
    { n: [0, 0, 1], u: 0, v: 1 }, { n: [0, 0, -1], u: 0, v: 1 },
    { n: [1, 0, 0], u: 2, v: 1 }, { n: [-1, 0, 0], u: 2, v: 1 },
    { n: [0, 1, 0], u: 0, v: 2 }, { n: [0, -1, 0], u: 0, v: 2 },
  ];
  for (const f of faces) {
    const axisN = f.n[0] ? 0 : f.n[1] ? 1 : 2;
    const sN = f.n[axisN];
    const cu = coords(H[f.u]);
    const cv = coords(H[f.v]);
    const base = b.p.length / 3;
    for (let j = 0; j < cv.length; j++) {
      for (let i = 0; i < cu.length; i++) {
        const g: [number, number, number] = [0, 0, 0];
        g[axisN] = sN * H[axisN];
        // orient u so that faces are consistently wound (flip u for negative faces)
        const uSign = (axisN === 2 ? sN : axisN === 0 ? -sN : 1);
        g[f.u] = cu[i] * uSign;
        g[f.v] = axisN === 1 ? -sN * cv[j] : cv[j];
        const inner = [0, 1, 2].map((a) => Math.max(-(H[a] - r), Math.min(H[a] - r, g[a])));
        let dx = g[0] - inner[0], dy = g[1] - inner[1], dz = g[2] - inner[2];
        const dl = Math.hypot(dx, dy, dz);
        let nx: number, ny: number, nz: number;
        if (dl < 1e-9) { nx = f.n[0]; ny = f.n[1]; nz = f.n[2]; dx = dy = dz = 0; }
        else { nx = dx / dl; ny = dy / dl; nz = dz / dl; }
        const px = inner[0] + nx * r, py = inner[1] + ny * r, pz = inner[2] + nz * r;
        b.vert(px, py, pz, nx, ny, nz, i / (cu.length - 1), j / (cv.length - 1));
      }
    }
    const cols = cu.length;
    for (let j = 0; j < cv.length - 1; j++) {
      for (let i = 0; i < cols - 1; i++) {
        const a = base + j * cols + i, c = a + cols;
        b.tri(a, a + 1, c + 1); b.tri(a, c + 1, c);
      }
    }
  }
  return b.build();
}

export const box = (w: number, h: number, d: number): Geometry => roundedBox(w, h, d, 0, 1);

/** Cylinder along Y, centered. Caps get planar UVs (0..1) so an emblem texture maps onto both faces. */
export function cylinder(radius: number, height: number, segs = 40, bevel = 0): Geometry {
  const b = new Builder();
  const hh = height / 2;
  const rIn = radius - bevel;
  // side (with optional bevel rings)
  const rings: Array<[number, number, number, number]> = []; // r, y, nr, ny
  if (bevel > 0) {
    rings.push([rIn, hh, 0, 1]);
    for (let k = 1; k <= 3; k++) {
      const a = (k / 3) * (Math.PI / 2);
      rings.push([rIn + Math.sin(a) * bevel, hh - bevel + Math.cos(a) * bevel, Math.sin(a), Math.cos(a)]);
    }
    for (let k = 0; k <= 3; k++) {
      const a = (k / 3) * (Math.PI / 2);
      rings.push([rIn + Math.cos(a) * bevel, -hh + bevel - Math.sin(a) * bevel, Math.cos(a), -Math.sin(a)]);
    }
    rings.push([rIn, -hh, 0, -1]);
  } else {
    rings.push([radius, hh, 1, 0], [radius, -hh, 1, 0]);
  }
  const base = 0;
  for (let ri = 0; ri < rings.length; ri++) {
    const [r, y, nr, ny] = rings[ri];
    for (let s = 0; s <= segs; s++) {
      const a = (s / segs) * Math.PI * 2;
      const c = Math.cos(a), sn = Math.sin(a);
      b.vert(c * r, y, sn * r, c * nr, ny, sn * nr, s / segs, ri / (rings.length - 1));
    }
  }
  for (let ri = 0; ri < rings.length - 1; ri++) {
    for (let s = 0; s < segs; s++) {
      const a = base + ri * (segs + 1) + s, c = a + segs + 1;
      b.tri(a, a + 1, c + 1); b.tri(a, c + 1, c);
    }
  }
  // caps
  for (const sy of [1, -1]) {
    const center = b.vert(0, sy * hh, 0, 0, sy, 0, 0.5, 0.5);
    const first = b.p.length / 3;
    for (let s = 0; s <= segs; s++) {
      const a = (s / segs) * Math.PI * 2;
      const c = Math.cos(a), sn = Math.sin(a);
      b.vert(c * rIn, sy * hh, sn * rIn, 0, sy, 0, 0.5 + 0.5 * c * (rIn / radius), 0.5 - 0.5 * sn * (rIn / radius) * sy);
    }
    for (let s = 0; s < segs; s++) {
      if (sy > 0) b.tri(center, first + s + 1, first + s);
      else b.tri(center, first + s, first + s + 1);
    }
  }
  return b.build();
}

export function sphere(radius: number, wSegs = 24, hSegs = 16): Geometry {
  const b = new Builder();
  for (let j = 0; j <= hSegs; j++) {
    const v = j / hSegs, th = v * Math.PI;
    for (let i = 0; i <= wSegs; i++) {
      const u = i / wSegs, ph = u * Math.PI * 2;
      const x = -Math.cos(ph) * Math.sin(th), y = Math.cos(th), z = Math.sin(ph) * Math.sin(th);
      b.vert(x * radius, y * radius, z * radius, x, y, z, u, v);
    }
  }
  for (let j = 0; j < hSegs; j++) {
    for (let i = 0; i < wSegs; i++) {
      const a = j * (wSegs + 1) + i, c = a + wSegs + 1;
      b.tri(a, c, a + 1); b.tri(a + 1, c, c + 1);
    }
  }
  return b.build();
}

/** Quad in the XY plane facing +Z, centered. */
export function plane(w: number, h: number): Geometry {
  const b = new Builder();
  const a = b.vert(-w / 2, -h / 2, 0, 0, 0, 1, 0, 1);
  const c = b.vert(w / 2, -h / 2, 0, 0, 0, 1, 1, 1);
  const d = b.vert(w / 2, h / 2, 0, 0, 0, 1, 1, 0);
  const e = b.vert(-w / 2, h / 2, 0, 0, 0, 1, 0, 0);
  b.tri(a, c, d); b.tri(a, d, e);
  return b.build();
}

/** Triangular prism (wedge) — used for hair spikes. Base in XZ, apex along +Y, leaning via caller rotation. */
export function wedge(w: number, h: number, d: number): Geometry {
  const b = new Builder();
  const hw = w / 2, hd = d / 2;
  const P: Array<[number, number, number]> = [
    [-hw, 0, hd], [hw, 0, hd], [0, h, hd], [-hw, 0, -hd], [hw, 0, -hd], [0, h, -hd],
  ];
  const face = (ids: number[], n: [number, number, number]) => {
    const l = Math.hypot(n[0], n[1], n[2]);
    const base = b.p.length / 3;
    ids.forEach((id, k) => b.vert(P[id][0], P[id][1], P[id][2], n[0] / l, n[1] / l, n[2] / l, k & 1, k >> 1));
    b.tri(base, base + 1, base + 2);
    if (ids.length === 4) b.tri(base, base + 2, base + 3);
  };
  face([0, 1, 2], [0, 0, 1]);
  face([4, 3, 5], [0, 0, -1]);
  face([1, 4, 5, 2], [h, hw, 0]);
  face([3, 0, 2, 5], [-h, hw, 0]);
  face([3, 4, 1, 0], [0, -1, 0]);
  return b.build();
}
