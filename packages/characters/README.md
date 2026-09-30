# @spark/characters — locked character reference profiles

This package turns character details and reference-file **metadata** into locked, versioned profiles of original modular characters. It handles data and compatibility only. It never builds meshes, opens uploaded files or renders anything.

| Module | Role |
| --- | --- |
| `schema.ts` | Strict profile/reference schema v1.0, prototype-key scan, finding types |
| `references.ts` | Checks reference metadata: MIME allowlist per type, executable/archive/traversal rejection, opaque `cas://references/sha256/<hex>` storage keys |
| `licensing.ts` | Provenance gate (`original … prohibited`), attribution, derivative/output/redistribution flags, protected-character copy tripwire |
| `catalog.ts` | Registry of pinned modular components (`id@x.y.z`) with content hashes, anchors, zones, palette slots and environment scale data |
| `recipe.ts` | Resolves a profile to registered components only. Emits `ASSET_COMPONENT_UNAVAILABLE` with suggestions that need approval, and substitutes only when an explicit approval exists |
| `compatibility.ts` | Checks rig, expressions/face set, motion (actions, height, anchors), hand/foot anchors, camera face target, bounds, clothing intersections, accessory limits and environment scale |
| `lock.ts` | `evaluateProfile`, deterministic `contentHash`, and `CharacterRegistry` (draft → validated → approved → locked → deprecated). Also handles exact episode pins |

Episodes reference `{ characterId, version, contentHash }`. `resolvePin` rejects `latest`, version ranges and hash mismatches. Deprecated versions still resolve, with a warning.

The content hash covers every identity field plus the resolved recipe (component refs, component hashes and palettes). Lifecycle fields (`status`, `locked`, `contentHash`, `deprecation`) are not hashed.

Example: `examples/zapp@1.0.0.profile.json`. Tests: `tests/character-profiles.test.ts`.
