// Runtime composition for S3/S4 producers. Locked manifests remain the data source; registering them activates the
// character decorators and prop rigs without changing the generic build dispatch used by older render paths.
import type { ManifestLibrary } from '../../engine/src/build-dispatch.ts';
import { registerBuilder } from '../../engine/src/build-dispatch.ts';
import { characterRecipe } from '../../engine/src/faces/recipes.ts';
import { propBuilder } from '../../engine/src/props/index.ts';

export interface RuntimeLibraryRegistration { characters: number; props: number }

/** Register every exact locked version; build-dispatch also makes the highest version available under the bare ID. */
export function registerRuntimeLibrary(lib: ManifestLibrary): RuntimeLibraryRegistration {
  const characters = Object.values(lib.characters);
  const props = Object.values(lib.props);
  for (const manifest of characters) registerBuilder(characterRecipe(manifest));
  for (const manifest of props) registerBuilder(propBuilder(manifest));
  return { characters: characters.length, props: props.length };
}
