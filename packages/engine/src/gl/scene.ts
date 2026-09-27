import { type Mat4, type Quat, type Vec3, m4, m4Mul, m4TRS, qIdentity } from '../math.ts';
import type { Geometry } from './geometry.ts';

export type RGB = [number, number, number];

export interface TextureSource {
  /** stable key; identical keys share one GPU texture */
  key: string;
  canvas: HTMLCanvasElement | OffscreenCanvas;
  /** bump when the canvas content changes */
  revision?: number;
}

export interface Material {
  /** linear RGB */
  color: RGB;
  emissive?: RGB;
  texture?: TextureSource;
  /** discard fragments whose texture alpha < alphaTest (decals, labels) */
  alphaTest?: number;
  /** 0 = chalky matte, 1 = subtle plastic sheen */
  sheen?: number;
  unlit?: boolean;
  /** 0..1 opacity multiplier for fades (uses alpha test dithering, keeps depth correct) */
  opacity?: number;
}

let nodeIds = 0;
export class Node {
  readonly id = ++nodeIds;
  name: string;
  pos: Vec3 = [0, 0, 0];
  rot: Quat = qIdentity();
  scl: Vec3 = [1, 1, 1];
  children: Node[] = [];
  parent: Node | null = null;
  geometry?: Geometry;
  material?: Material;
  visible = true;
  castShadow = true;
  /** decals render after opaque with polygon offset */
  decal = false;
  /** billboard: rotate to face camera (plane geometry) */
  billboard = false;
  readonly world: Mat4 = m4();
  private readonly local: Mat4 = m4();
  /** arbitrary tags used by shot validation (e.g. "face:zapp") */
  tags: string[] = [];

  constructor(name: string, geometry?: Geometry, material?: Material) {
    this.name = name;
    this.geometry = geometry;
    this.material = material;
  }
  add(...nodes: Node[]): this {
    for (const n of nodes) { n.parent = this; this.children.push(n); }
    return this;
  }
  at(x: number, y: number, z: number): this { this.pos = [x, y, z]; return this; }
  rotQ(q: Quat): this { this.rot = q; return this; }
  updateWorld(parentWorld?: Mat4): void {
    m4TRS(this.pos, this.rot, this.scl, this.local);
    if (parentWorld) m4Mul(parentWorld, this.local, this.world);
    else this.world.set(this.local);
    for (const c of this.children) c.updateWorld(this.world);
  }
  traverse(fn: (n: Node) => void, onlyVisible = false): void {
    if (onlyVisible && !this.visible) return;
    fn(this);
    for (const c of this.children) c.traverse(fn, onlyVisible);
  }
  find(name: string): Node | undefined {
    if (this.name === name) return this;
    for (const c of this.children) { const f = c.find(name); if (f) return f; }
    return undefined;
  }
  worldPos(): Vec3 { return [this.world[12], this.world[13], this.world[14]]; }
}

/** sRGB hex (#rrggbb) -> linear RGB. Manifests store sRGB hex; shading is linear. */
export function hex(h: string): RGB {
  const v = parseInt(h.replace('#', ''), 16);
  const c = (x: number) => { const s = x / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return [c((v >> 16) & 255), c((v >> 8) & 255), c(v & 255)];
}
