// Multi-set engine (S6): every set an episode uses built once at its own world origin, one visible at a time, with
// per-set lighting. Additive module: production.ts (the single-set Visual Comedy runtime) is untouched.
import type { EnvironmentManifest } from '../../schema/src/assets.ts';
import type { EnvInstance } from './build.ts';
import type { Lighting } from './gl/renderer.ts';
import { Node, hex } from './gl/scene.ts';
import { add, type Vec3 } from './math.ts';

/** single-set default: the shadow volume every existing episode renders with (Production.lighting) */
export const DEFAULT_SHADOW: Readonly<{ center: Vec3; radius: number }> = Object.freeze({ center: [0, 1, -0.5] as Vec3, radius: 5.2 });

/** Renderer lighting for one environment preset (same mapping as Production.lighting). `shadowCenter` / `shadowRadius` default to the single-set values. */
export function environmentLighting(envM: EnvironmentManifest, preset: string, opts: { shadowCenter?: Vec3; shadowRadius?: number } = {}): Lighting {
  const L = envM.lighting[preset];
  if (!L) throw new Error(`environment ${envM.id}@${envM.version} has no lighting preset "${preset}"`);
  const sc = hex(L.sunColor).map((c) => c * L.sunIntensity) as [number, number, number];
  return {
    sunDir: L.sunDir, sunColor: sc, skyColor: hex(L.sky).map((c) => c * L.ambientIntensity) as [number, number, number],
    groundColor: hex(L.ground).map((c) => c * L.ambientIntensity * 0.6) as [number, number, number], points: [],
    fogColor: hex(L.fog), fogNear: L.fogNear, fogFar: L.fogFar, exposure: L.exposure,
    shadowCenter: [...(opts.shadowCenter ?? DEFAULT_SHADOW.center)] as Vec3, shadowRadius: opts.shadowRadius ?? DEFAULT_SHADOW.radius,
  };
}

/** One built set placed in a multi-set scene: everything in WORLD coordinates (manifest coordinates + origin). */
export interface StagedSet {
  id: string;
  key: string;
  env: EnvInstance;
  origin: Vec3;
  /** world-space colliders (floor included) */
  colliders: Array<{ id: string; min: Vec3; max: Vec3 }>;
  safeMin: Vec3;
  safeMax: Vec3;
  /** per-set content (actors / props staged in this set) — shown and hidden with the set */
  content: Node;
}

/**
 * Multi-set engine: every set an episode uses is built once and placed at its own origin (so geometry never overlaps);
 * exactly one set is visible at a time. The renderer draws only visible subtrees (shadow pass included), so hiding the
 * inactive sets keeps both the frame and the single shadow map to the active set; lighting is per set and centres the
 * shadow volume on the set's own origin.
 */
export class SetStack {
  readonly root = new Node('sets');
  private readonly sets = new Map<string, StagedSet>();
  private activeId: string | null = null;

  add(id: string, key: string, env: EnvInstance, origin: Vec3): StagedSet {
    if (this.sets.has(id)) throw new Error(`set ${id} added twice`);
    const holder = new Node(`set:${id}`);
    holder.pos = [...origin] as Vec3;
    holder.add(env.root);
    const content = new Node(`set_content:${id}`);
    holder.add(content);
    this.root.add(holder);
    const off = (v: readonly number[]): Vec3 => [v[0] + origin[0], v[1] + origin[1], v[2] + origin[2]];
    const cs = env.manifest.cameraSafe;
    const s: StagedSet = {
      id, key, env, origin: [...origin] as Vec3, content,
      colliders: env.colliders.map((c) => ({ id: c.id, min: off(c.min), max: off(c.max) })),
      safeMin: off(cs.min), safeMax: off(cs.max),
    };
    this.sets.set(id, s);
    if (this.activeId === null) this.activate(id);
    else holder.visible = false;
    return s;
  }
  get(id: string): StagedSet | undefined { return this.sets.get(id); }
  list(): StagedSet[] { return [...this.sets.values()]; }
  get active(): string | null { return this.activeId; }
  /** show exactly one set (and its content) */
  activate(id: string): StagedSet {
    const s = this.sets.get(id);
    if (!s) throw new Error(`set ${id} is not built`);
    for (const x of this.sets.values()) x.env.root.parent!.visible = x.id === id;
    this.activeId = id;
    return s;
  }
  /** holder node of a set (content parent), for callers that need to place nodes in set-local coordinates */
  holder(id: string): Node { const s = this.sets.get(id); if (!s) throw new Error(`set ${id} is not built`); return s.env.root.parent!; }
  /** per-set lighting: shadow volume centred on the set origin, sized to the set bounds */
  lighting(id: string, preset: string): Lighting {
    const s = this.sets.get(id);
    if (!s) throw new Error(`set ${id} is not built`);
    const b = s.env.manifest.bounds;
    // half the larger floor extent + 0.6 m (the classroom's 9.2 m floor gives exactly the single-set 5.2 m)
    const radius = Math.max(3, Math.max(b.max[0] - b.min[0], b.max[2] - b.min[2]) / 2 + 0.6);
    return environmentLighting(s.env.manifest, preset, { shadowCenter: add(s.origin, DEFAULT_SHADOW.center), shadowRadius: radius });
  }
}
