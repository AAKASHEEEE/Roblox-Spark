// Producer dispatch API kept byte-shape compatible with the S6 staging branch.
import type { CharacterManifest, EnvironmentManifest, PropManifest } from '../../schema/src/assets.ts';
import type { BuiltProp, BuiltSet, CharacterRecipe, PropBuilder, SetBuilder } from '../../library/src/types.ts';
import { buildCharacter, buildEnvironment, buildProp, type EnvInstance, type PropInstance, type Rig } from './build.ts';

export type BuildSource = 'builder' | 'manifest' | 'placeholder';
export interface ManifestLibrary { characters: Record<string, CharacterManifest>; props: Record<string, PropManifest>; environments: Record<string, EnvironmentManifest> }

const REGISTRY = { set: new Map<string, SetBuilder>(), prop: new Map<string, PropBuilder>(), character: new Map<string, CharacterRecipe>() };
type Registered = SetBuilder | PropBuilder | CharacterRecipe;

/** Registers exact id@version and advances the bare-id alias only to an equal/newer semver. */
export function registerBuilder(item: Registered): void {
  const map = REGISTRY[item.kind] as Map<string, Registered>;
  map.set(`${item.id}@${item.version}`, item);
  const current = map.get(item.id);
  if (!current || semverCmp(item.version, current.version) >= 0) map.set(item.id, item);
}
export function unregisterBuilders(): void { for (const map of Object.values(REGISTRY)) map.clear(); }
export function registeredBuilder<K extends keyof typeof REGISTRY>(kind: K, ref: string): (typeof REGISTRY)[K] extends Map<string, infer V> ? V | undefined : never {
  return (REGISTRY[kind] as Map<string, Registered>).get(ref) as never;
}

const semverCmp = (a: string, b: string): number => {
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((left[i] ?? 0) !== (right[i] ?? 0)) return (left[i] ?? 0) - (right[i] ?? 0);
  return 0;
};
export function resolveManifestKey(ref: string, records: Record<string, unknown>): string | undefined {
  if (ref.includes('@')) return records[ref] ? ref : undefined;
  const versions = Object.keys(records).filter((key) => key.split('@')[0] === ref).map((key) => key.split('@')[1]).sort(semverCmp);
  return versions.length ? `${ref}@${versions[versions.length - 1]}` : undefined;
}

export interface DispatchedSet { env: EnvInstance; built?: BuiltSet; source: BuildSource; key: string }
export function dispatchSet(ref: string, lib: ManifestLibrary, opts: { seed: number; decorDensity?: number; placeholder: (id: string) => EnvironmentManifest }): DispatchedSet {
  const id = ref.split('@')[0];
  const builder = registeredBuilder('set', ref);
  if (builder) {
    const built = builder.build({ seed: opts.seed, decorDensity: opts.decorDensity });
    const manifest = builder.manifest ?? opts.placeholder(id);
    return { env: { manifest, root: built.root, colliders: built.colliders }, built, source: 'builder', key: `${builder.id}@${builder.version}` };
  }
  const key = resolveManifestKey(ref, lib.environments);
  if (key) return { env: buildEnvironment(lib.environments[key], opts.decorDensity ?? lib.environments[key].extras.decorDensity), source: 'manifest', key };
  const manifest = opts.placeholder(id);
  return { env: buildEnvironment(manifest, 1), source: 'placeholder', key: `${manifest.id}@${manifest.version}` };
}

export interface DispatchedCharacter { rig: Rig; source: BuildSource; key: string }
export function dispatchCharacter(ref: string, lib: ManifestLibrary, opts: { seed: number; placeholder: (id: string) => CharacterManifest }): DispatchedCharacter {
  const recipe = registeredBuilder('character', ref);
  if (recipe) {
    const rig = buildCharacter(recipe.manifest);
    recipe.decorate?.(rig, { seed: opts.seed });
    return { rig, source: 'builder', key: `${recipe.id}@${recipe.version}` };
  }
  const key = resolveManifestKey(ref, lib.characters);
  if (key) return { rig: buildCharacter(lib.characters[key]), source: 'manifest', key };
  const manifest = opts.placeholder(ref.split('@')[0]);
  return { rig: buildCharacter(manifest), source: 'placeholder', key: `${manifest.id}@${manifest.version}` };
}

export interface DispatchedProp { inst: PropInstance; built?: BuiltProp; builder?: PropBuilder; source: BuildSource; key: string }
export function dispatchProp(ref: string, instance: string, lib: ManifestLibrary, opts: { seed: number; placeholder: (id: string) => PropManifest }): DispatchedProp {
  const builder = registeredBuilder('prop', ref);
  if (builder) {
    const built = builder.build(instance, { seed: opts.seed });
    return { inst: built.instance, built, builder, source: 'builder', key: `${builder.id}@${builder.version}` };
  }
  const key = resolveManifestKey(ref, lib.props);
  if (key) return { inst: buildProp(lib.props[key], instance), source: 'manifest', key };
  const manifest = opts.placeholder(ref.split('@')[0]);
  return { inst: buildProp(manifest, instance), source: 'placeholder', key: `${manifest.id}@${manifest.version}` };
}
