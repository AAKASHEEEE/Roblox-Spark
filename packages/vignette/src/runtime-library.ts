// Runtime composition for S3/S4 producers. Locked manifests remain the data source; registering them activates the
// character decorators and prop rigs without changing the generic build dispatch used by older render paths.
import type { ManifestLibrary } from '../../engine/src/build-dispatch.ts';
import { registerBuilder } from '../../engine/src/build-dispatch.ts';
import { characterRecipe } from '../../engine/src/faces/recipes.ts';
import { propBuilder } from '../../engine/src/props/index.ts';
import { BUILT_IN_SET_BUILDERS, registerSetBuilders } from '../../engine/src/sets/index.ts';

export interface RuntimeLibraryRegistration { sets: number; characters: number; props: number }

/** Register every exact locked producer; build-dispatch also exposes the highest version under the bare ID. */
export function registerRuntimeLibrary(lib: ManifestLibrary): RuntimeLibraryRegistration {
  const characters = Object.values(lib.characters);
  const props = Object.values(lib.props);
  registerSetBuilders();
  for (const manifest of characters) registerBuilder(characterRecipe(manifest));
  for (const manifest of props) registerBuilder(propBuilder(manifest));
  return { sets: BUILT_IN_SET_BUILDERS.length, characters: characters.length, props: props.length };
}
