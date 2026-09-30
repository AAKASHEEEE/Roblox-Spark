// Build dispatch (S6): library ID -> registered producer | locked asset manifest | placeholder. Additive module next to
// build.ts (which stays the single-set builder, face hook included).
import type { CharacterManifest, EnvironmentManifest, PropManifest } from '../../schema/src/assets.ts';
import type { BuiltProp, BuiltSet, CharacterRecipe, PropBuilder, SetBuilder } from '../../library/src/types.ts';
import { buildCharacter, buildEnvironment, buildProp, type EnvInstance, type PropInstance, type Rig } from './build.ts';

// Library ID -> the producer that builds it. Order: a registered producer (S2 SetBuilder / S3 CharacterRecipe /
// S4 PropBuilder, see packages/library/src/types.ts) -> a locked asset manifest -> the caller's placeholder factory.
// The dispatch never invents geometry itself and never touches the face hook: characters are always built by
// buildCharacter (whose face plane / setFace stay as they are), recipes only add their decorate() step.

export type BuildSource = 'builder' | 'manifest' | 'placeholder';
export interface ManifestLibrary { characters: Record<string, CharacterManifest>; props: Record<string, PropManifest>; environments: Record<string, EnvironmentManifest> }

const REGISTRY = { set: new Map<string, SetBuilder>(), prop: new Map<string, PropBuilder>(), character: new Map<string, CharacterRecipe>() };
type Registered = SetBuilder | PropBuilder | CharacterRecipe;
/** register a producer under `id@version` (and `id`, latest registration wins for the bare id) */
export function registerBuilder(item: Registered): void {
  const m = REGISTRY[item.kind] as Map<string, Registered>;
  m.set(`${item.id}@${item.version}`, item);
  const cur = m.get(item.id);
  if (!cur || semverCmp(item.version, cur.version) >= 0) m.set(item.id, item);
}
export function unregisterBuilders(): void { for (const m of Object.values(REGISTRY)) m.clear(); }
export function registeredBuilder<K extends keyof typeof REGISTRY>(kind: K, ref: string): (typeof REGISTRY)[K] extends Map<string, infer V> ? V | undefined : never {
  return (REGISTRY[kind] as Map<string, Registered>).get(ref) as never;
}

const semverCmp = (a: string, b: string): number => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0); return 0; };
/** `id@x.y.z` -> that key when present; bare `id` -> the highest published version in `records` */
export function resolveManifestKey(ref: string, records: Record<string, unknown>): string | undefined {
  if (ref.includes('@')) return records[ref] ? ref : undefined;
  const vs = Object.keys(records).filter((k) => k.split('@')[0] === ref).map((k) => k.split('@')[1]).sort(semverCmp);
  return vs.length ? `${ref}@${vs[vs.length - 1]}` : undefined;
}

export interface DispatchedSet { env: EnvInstance; built?: BuiltSet; source: BuildSource; key: string }
export function dispatchSet(ref: string, lib: ManifestLibrary, opts: { seed: number; decorDensity?: number; placeholder: (id: string) => EnvironmentManifest }): DispatchedSet {
  const id = ref.split('@')[0];
  const b = registeredBuilder('set', ref);
  if (b) {
    const built = b.build({ seed: opts.seed, decorDensity: opts.decorDensity });
    const manifest = b.manifest ?? opts.placeholder(id);
    return { env: { manifest, root: built.root, colliders: built.colliders }, built, source: 'builder', key: `${b.id}@${b.version}` };
  }
  const key = resolveManifestKey(ref, lib.environments);
  if (key) return { env: buildEnvironment(lib.environments[key], opts.decorDensity ?? lib.environments[key].extras.decorDensity), source: 'manifest', key };
  const m = opts.placeholder(id);
  return { env: buildEnvironment(m, 1), source: 'placeholder', key: `${m.id}@${m.version}` };
}

export interface DispatchedCharacter { rig: Rig; source: BuildSource; key: string }
export function dispatchCharacter(ref: string, lib: ManifestLibrary, opts: { seed: number; placeholder: (id: string) => CharacterManifest }): DispatchedCharacter {
  const r = registeredBuilder('character', ref);
  if (r) { const rig = buildCharacter(r.manifest); r.decorate?.(rig, { seed: opts.seed }); return { rig, source: 'builder', key: `${r.id}@${r.version}` }; }
  const key = resolveManifestKey(ref, lib.characters);
  if (key) return { rig: buildCharacter(lib.characters[key]), source: 'manifest', key };
  const m = opts.placeholder(ref.split('@')[0]);
  return { rig: buildCharacter(m), source: 'placeholder', key: `${m.id}@${m.version}` };
}

export interface DispatchedProp { inst: PropInstance; built?: BuiltProp; source: BuildSource; key: string }
export function dispatchProp(ref: string, instance: string, lib: ManifestLibrary, opts: { seed: number; placeholder: (id: string) => PropManifest }): DispatchedProp {
  const b = registeredBuilder('prop', ref);
  if (b) { const built = b.build(instance, { seed: opts.seed }); return { inst: built.instance, built, source: 'builder', key: `${b.id}@${b.version}` }; }
  const key = resolveManifestKey(ref, lib.props);
  if (key) return { inst: buildProp(lib.props[key], instance), source: 'manifest', key };
  const m = opts.placeholder(ref.split('@')[0]);
  return { inst: buildProp(m, instance), source: 'placeholder', key: `${m.id}@${m.version}` };
}
