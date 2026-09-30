# Vignette pipeline

Branch `develop/vignette` holds the shared base. Every session branches from it and targets it.

## Flow

```
script (narration + phrase timings)
  -> director (S1)       picks set, cast, props, actions, camera, events and captions per phrase
  -> beat sheet          packages/director/src/beat-sheet.ts; one beat per narration phrase
  -> staging (S6)        resolves placements, doors, carry-over, camera recipes; builds a multi-set timeline
  -> render              engine builds sets (S2), characters/faces (S3), props (S4), actions (S5), VFX/text/audio (S7)
```

- **Library manifest** (`packages/library/src/ids.ts`): every ID the pipeline may use, grouped by kind (`sets`, `characters`, `props`, `actions`, `expressions`, `cameraRecipes`, `vfx`, `textStyles`, `sfx`, `music`). Each entry has a `status` (`available` | `planned`), an `owner` session, a one-line `description` and `tags`, which are the script words the director matches to it. Set entries also list their `marks`, `doors` and `lighting` presets.
- **Producer contracts** (`packages/library/src/types.ts`): `SetBuilder`, `PropBuilder`, `CharacterRecipe`, `ActionDef` (same shape as the engine's `ACTION_DEFS` entries), `ExpressionDef`, `CameraRecipe`, `VfxDef`, `TextStyleDef`, `SfxDef`, `MusicDef`.
- **Beat sheet validation** (`validateBeatSheet`): uses the strict `v.ts` schema, so unknown keys are errors. It checks each ID against the manifest, and **unknown IDs are errors**. IDs whose status is `planned` are valid but are returned separately in `planned`. They only fail when `requireAvailable: true`, which is the render gate. Validation also checks marks, doors and lighting against the set, `enter:`/`exit:` placements against matching events, `lookAt` and camera subjects against the entities in the beat, and caption word counts and highlights. It checks `carryOver` against the previous beat. When `phrases` are passed, it requires exactly one beat per phrase with the same timing and text.
- **Reference fixture:** `packages/director/fixtures/free-coins-classroom.beats.json` covers the approved narrated script (`tests/fixtures/narrated/approved-narrated-v0.1.json`). It validates with 0 issues and lists 32 planned IDs.

## Ownership

| Session | Owns |
|---|---|
| S0 contracts | `packages/library/**`, `packages/director/src/beat-sheet.ts`, this doc |
| S1 director | `packages/director/**` (except `beat-sheet.ts`) |
| S2 sets | `packages/engine/src/sets/**`, new `assets/environments` files, new environment profile files |
| S3 characters and faces | `packages/engine/src/faces/**`, new `assets/characters` files, the face hook in `build.ts` |
| S4 props | `packages/engine/src/props/**`, new `assets/props` files |
| S5 actions and talking | `packages/engine/src/animation/**` |
| S6 staging, camera, multi-set engine | `packages/vignette/**`, `packages/engine/src/production.ts`, the renderer's set handling, the `build.ts` dispatch |
| S7 captions, graphics, VFX, audio | `packages/captions/**`, `packages/engine/src/vfx/**`, `packages/audio-mix/**` |

Only S0 edits the shared contracts (`packages/library/**` and `beat-sheet.ts`). Other sessions report the changes they need, such as a new ID, a status flip or an interface field, and do not edit these files.

## ID rules

- IDs are lowercase snake_case: `^[a-z][a-z0-9]*(_[a-z0-9]+)*$`. For example `school_hallway`, `emote_exclaim`, `door_slam`.
- IDs are unique within a kind. The same word may exist in two kinds, for example `scream` as an action and as an expression.
- Versioned assets are referenced as `id` (latest) or `id@x.y.z`. The version must be in the entry's `versions`. Published versions are append-only and are hashed in `assets/asset-lock.json`.
- Placements are a mark ID, `enter:<doorId>` or `exit:<doorId>`. Props also accept a door ID, `held:<characterId>` or `on:<propInstanceId>`.
- Existing engine enums and assets stay `available` under their current IDs. A planned ID never renames an existing one. Where they overlap, for example planned `whoosh` next to existing `sfx_whoosh`, the planned entry may wrap the existing one.

## Adding an item

1. **Reserve the ID.** Ask S0 to add it to `ids.ts` as `planned`, with owner, description and tags. Or use an ID that is already reserved.
2. **Implement it** in your owned paths against the matching interface in `types.ts`. If it is asset-backed, add the new `assets/<kind>/<id>@x.y.z.json` and run `npm run assets:lock`.
3. **Make it available.** Report to S0 with the implementation path and a test. S0 flips it to `available` and sets `versions`/`source`; set entries also get `marks`, `doors` and `lighting`.
4. **Check it.** `npm run typecheck`, the fast suite, and the narrated analysis (`node scripts/narrated-integration-analysis.ts`, which must stay 47/47) must pass before a merge into `develop/vignette`.
