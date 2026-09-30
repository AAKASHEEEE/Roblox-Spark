// Character recipes (S3) against the CharacterRecipe contract (packages/library/src/types.ts), plus crowd colour variants.
// Manifests stay the locked source of truth (assets/characters/*.json); a recipe only adds the library identity, the
// default expression, the full expression list (face set v1 states + face set v2) and an optional decorate step.
import type { CharacterManifest } from '../../../schema/src/assets.ts';
import type { CharacterRecipe } from '../../../library/src/types.ts';
import type { Rig } from '../build.ts';
import { hex } from '../gl/scene.ts';
import { faceStatesFor, setFace, setFaceSkin } from './index.ts';
import { mix } from './design.ts';

/** cast ids S3 provides recipes for (LIBRARY.characters) */
export const CAST_IDS = ['zapp', 'kira', 'teacher', 'mom', 'dad', 'friend_boy', 'friend_girl', 'noob', 'pro', 'crowd_kid'] as const;

// ---------------------------------------------------------------- crowd colour variants

/** crowd_kid palette slots. Part ids in crowd_kid@* are prefixed with their slot: hair_*, shirt_*, shirtdark_*, pants_*, shoe_* */
export const CROWD_PALETTE = {
  skin: ['#f3d2b6', '#e0ac84', '#c68a5e', '#9a6440', '#6b4428', '#4a2e1c'],
  shirt: ['#4f7fb8', '#e06a4f', '#58b368', '#e8c33c', '#9a6fd0', '#e27fb0', '#3fb3b0', '#f0f0ea', '#ef8a2c'],
  pants: ['#3d4250', '#2d3f66', '#6b5a44', '#4b4f57', '#7a3040', '#2f5a4a'],
  shoes: ['#e9e9e6', '#1f2024', '#d9483b', '#3a6fd8', '#f0c23c'],
  hair: ['#1a1410', '#3a2a1e', '#6b3a1e', '#c98f3c', '#2b2b33', '#8a2f1a'],
} as const;
export interface CrowdVariant { skin: string; shirt: string; pants: string; shoes: string; hair: string }

/** deterministic 32-bit mix (splitmix-style) so neighbouring seeds give unrelated colours */
function hash(seed: number, salt: number): number {
  let x = (Math.imul(seed | 0, 0x9e3779b1) + Math.imul(salt + 1, 0x632be5ab)) >>> 0;
  for (let i = 0; i < 2; i++) { x ^= x >>> 16; x = Math.imul(x, 0x7feb352d); x ^= x >>> 15; x = Math.imul(x, 0x846ca68b); x ^= x >>> 16; }
  return x >>> 8; // high bits: the low bits of a multiply-xor mix are weak under small moduli
}

/** colours for crowd seed `seed`; seed 0 = the manifest's own colours */
export function crowdVariant(m: CharacterManifest, seed: number): CrowdVariant {
  if (!seed) {
    const hair = m.parts.find((p) => p.id.startsWith('hair_'))?.color ?? '#3a2a1e';
    return { skin: m.body.skin, shirt: m.body.torsoColor, pants: m.body.legColor, shoes: m.body.shoeColor, hair };
  }
  const P = CROWD_PALETTE;
  const pick = <T>(list: readonly T[], salt: number) => list[hash(seed, salt) % list.length];
  // shirt and pants palettes are disjoint, so a variant never wears a one-colour outfit
  return { skin: pick(P.skin, 1), shirt: pick(P.shirt, 2), pants: pick(P.pants, 3), shoes: pick(P.shoes, 4), hair: pick(P.hair, 5) };
}

const SLOT: Array<[RegExp, (v: CrowdVariant) => string]> = [
  [/^(head_mesh|hand_[lr]_mesh)$/, (v) => v.skin],
  [/^(torso_mesh|upperarm_[lr]_mesh|forearm_[lr]_mesh)$/, (v) => v.shirt],
  [/^(upperleg_[lr]_mesh|lowerleg_[lr]_mesh)$/, (v) => v.pants],
  [/^shoe_[lr]_mesh$/, (v) => v.shoes],
  [/^hair_/, (v) => v.hair],
  [/^shirtdark_/, (v) => mix(v.shirt, '#000000', 0.28)],
  [/^shirt_/, (v) => v.shirt],
  [/^pants_/, (v) => mix(v.pants, '#000000', 0.2)],
  [/^shoe_/, (v) => v.shoes],
];

/** recolour a built crowd_kid rig in place and point its face at the variant skin (v2 tints mix with it) */
export function applyCrowdVariant(rig: Rig, seed: number): CrowdVariant {
  const v = crowdVariant(rig.manifest, seed);
  if (!seed) return v;
  for (const n of rig.meshes) {
    const slot = SLOT.find(([re]) => re.test(n.name));
    if (slot && n.material) n.material.color = hex(slot[1](v));
  }
  setFaceSkin(rig, v.skin);
  rig.setFace = (state: string, blink: number) => setFace(rig, state, blink);
  return v;
}

/** per-character build step run after buildCharacter (CharacterRecipe.decorate); a no-op for fixed-look characters */
export function decorateCharacter(rig: Rig, opts: { seed: number }): void {
  if (rig.manifest.id === 'crowd_kid') applyCrowdVariant(rig, opts.seed);
}

// ---------------------------------------------------------------- recipes

const semver = (a: string, b: string) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };

export function characterRecipe(m: CharacterManifest): CharacterRecipe {
  return {
    id: m.id, version: m.version, kind: 'character', displayName: m.displayName, manifest: m,
    defaultExpression: m.allowedExpressions[0],
    expressions: faceStatesFor(m),
    ...(m.id === 'crowd_kid' ? { decorate: (rig: Rig, opts: { seed: number }) => { applyCrowdVariant(rig, opts.seed); } } : {}),
  };
}

/** recipes for the cast, built from the loaded character manifests (latest version per id unless pinned) */
export function characterRecipes(characters: Record<string, CharacterManifest>, pins: Partial<Record<string, string>> = {}): Record<string, CharacterRecipe> {
  const out: Record<string, CharacterRecipe> = {};
  for (const id of CAST_IDS) {
    const all = Object.values(characters).filter((m) => m.id === id).sort((a, b) => semver(b.version, a.version));
    const m = pins[id] ? all.find((x) => x.version === pins[id]) : all[0];
    if (m) out[id] = characterRecipe(m);
  }
  return out;
}
