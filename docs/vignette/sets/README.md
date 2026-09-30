# Essential procedural set library

This S2 package publishes three original, asset-backed `SetBuilder`s. It uses only in-house primitive geometry and procedural textures; no Roblox map or copied asset is included.

## Available producers

| Producer | Version | Authored staging | Lighting |
|---|---:|---|---|
| `classroom` | `1.2.0` | Existing 1.1 marks plus `classroom_door_inside`; `classroom_door` threshold `[2.5,0,-3.95]` to `[2.5,0,-3.0]` | `morning`, `afternoon` |
| `school_hallway` | `1.0.0` | `hall_center`, `lockers`, `hall_door_inside`, notice board, fountain, end lane; `hall_door` | `day`, `after_school` |
| `playground` | `1.0.0` | `slide`, `swings`, `sandpit`, center, bench, path | `day`, `sunset` |

Both architectural doors have a measured 1.40m wide by 3.05m high collision-free opening in a 4.20m wall. Tests pass an adult envelope of 2.69m plus 0.21m head margin through each threshold and along its first-inside route.

The prior `classroom@1.0.0` and `classroom@1.1.0` files and narrated off-screen door cue remain unchanged and pinned. The new physical doorway exists only in the new immutable version.

## Runtime use

Registration is explicit and idempotent:

```ts
import { registerSetBuilders } from './packages/engine/src/sets/index.ts';
import { dispatchSet } from './packages/engine/src/build-dispatch.ts';

registerSetBuilders();
const result = dispatchSet('classroom', manifestLibrary, {
  seed: 47,
  placeholder: makePlaceholderManifest,
});
// result.source === 'builder'; result.built carries marks, doors, safe volume and lighting.
```

Use an exact ref such as `classroom@1.2.0` for reproducible production pins. Bare IDs resolve to the newest registered semantic version.

## Review and validation

The single bounded review artifact is [`procedural-sets-review.png`](./procedural-sets-review.png), 1600x900. Regenerate manifests and the sheet with:

```sh
node scripts/generate-lib-set-manifests.ts
python3 -m pip install -r scripts/review-requirements.txt
python3 scripts/set-review-sheet.py
# CI/review check modes (do not write):
node scripts/generate-lib-set-manifests.ts --check
python3 scripts/set-review-sheet.py --check
```

Validation covers schema/asset locks, producer IDs and registration, manifest/generated parity, mark reachability and clearance, camera zones, collider parity, both lighting presets, deterministic scene signatures, doorway dimensions and the review image size.

## Integration handoff (S0/S6 ownership)

This branch intentionally does **not** edit S0-owned `packages/library/src/ids.ts` or shared contracts. S0 should register `classroom@1.2.0`, mark `classroom_door_inside`, and flip `school_hallway@1.0.0` plus `playground@1.0.0` to available with the marks/doors/lighting above.

S6 should call `registerSetBuilders()` during bootstrap and retain `DispatchedSet.built` so rich doors, marks, camera-safe bounds and renderer lighting are not discarded. Once the S4 hinged `door` producer lands, it can occupy the already-authored frames; the architectural opening itself is complete without it.

## Next improvements

1. Merge the S0 availability update and S6 metadata adapter.
2. Add camera-solved beauty stills in addition to the current contract/plan review sheet.
3. Author the remaining six planned story sets only after these three are integrated.
4. Add seed-driven optional dressing variants while keeping structural geometry and staging fixed.
