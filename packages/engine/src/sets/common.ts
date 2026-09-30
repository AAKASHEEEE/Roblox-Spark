import type { EnvironmentManifest } from '../../../schema/src/assets.ts';
import type { BuiltSet, SetDoor, SetMark } from '../../../library/src/types.ts';
import { buildEnvironment } from '../build.ts';
import type { Vec3 } from '../math.ts';
import type { Lighting } from '../gl/renderer.ts';
import { hex } from '../gl/scene.ts';

export type SetPosture = SetMark['postures'][number];

/** Converts authored sRGB manifest presets to renderer-linear lighting without shared mutable arrays. */
export function setLighting(manifest: EnvironmentManifest, shadowCenter: Vec3, shadowRadius: number): Record<string, Lighting> {
  return Object.fromEntries(Object.entries(manifest.lighting).map(([id, p]) => {
    const sunColor = hex(p.sunColor).map((c) => c * p.sunIntensity) as Vec3;
    const skyColor = hex(p.sky).map((c) => c * p.ambientIntensity) as Vec3;
    const groundColor = hex(p.ground).map((c) => c * p.ambientIntensity * 0.6) as Vec3;
    return [id, {
      sunDir: [...p.sunDir] as Vec3,
      sunColor,
      skyColor,
      groundColor,
      points: [],
      fogColor: hex(p.fog),
      fogNear: p.fogNear,
      fogFar: p.fogFar,
      exposure: p.exposure,
      shadowCenter: [...shadowCenter] as Vec3,
      shadowRadius,
    } satisfies Lighting];
  }));
}

export function authoredMarks(
  manifest: EnvironmentManifest,
  postures: Readonly<Record<string, readonly SetPosture[]>> = {},
  omit: ReadonlySet<string> = new Set(),
): SetMark[] {
  return Object.entries(manifest.marks)
    .filter(([id]) => !omit.has(id))
    .map(([id, m]) => ({
      id,
      position: [...m.pos] as Vec3,
      facingDeg: m.facingDeg,
      postures: [...(postures[id] ?? ['stand'])],
    }));
}

/** Asset-backed deterministic build shared by all S2 producers. */
export function buildAuthoredSet(
  manifest: EnvironmentManifest,
  marks: readonly SetMark[],
  doors: readonly SetDoor[],
  opts: { seed: number; decorDensity?: number },
  shadowCenter: Vec3,
  shadowRadius: number,
): BuiltSet {
  // Seed is intentionally reserved for future dressing variants. Geometry selection is stable by authored order;
  // equal seed+density therefore always yields the same scene, while density only removes decor-tagged pieces.
  void opts.seed;
  const canvasAvailable = typeof OffscreenCanvas !== 'undefined' || typeof document !== 'undefined';
  const renderManifest = canvasAvailable ? manifest : {
    ...manifest,
    // Spatial/headless validation has no Canvas2D; omit only surface textures, never geometry or collision.
    pieces: manifest.pieces.map(({ texture: _texture, ...piece }) => piece),
  } as EnvironmentManifest;
  const env = buildEnvironment(renderManifest, opts.decorDensity ?? manifest.extras.decorDensity);
  return {
    root: env.root,
    colliders: env.colliders,
    marks: marks.map((m) => ({ ...m, position: [...m.position] as Vec3, postures: [...m.postures] })),
    doors: doors.map((d) => ({ ...d, position: [...d.position] as Vec3 })),
    lighting: setLighting(manifest, shadowCenter, shadowRadius),
    safeMin: [...manifest.cameraSafe.min] as Vec3,
    safeMax: [...manifest.cameraSafe.max] as Vec3,
  };
}
