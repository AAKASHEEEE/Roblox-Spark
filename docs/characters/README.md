# Characters and faces (S3)

Stills are regenerated with `npm run build && node scripts/character-stills.ts`. They use the production `Renderer` and `buildCharacter` via `packages/engine/src/faces/lookdev.ts`.

| Still | What it shows |
|---|---|
| `turnaround-<id>.png` | 0/45/90/135/180° turnaround for each of the 10 cast members |
| `lineup.png` | Height and silhouette comparison: adults vs kids |
| `crowd_kid-variants.png` | `crowd_kid` seeds 0–9 (seed 0 = manifest colours) |
| `expression-sheet.png` | 13 face-set-v2 expressions + 4 talking shapes on 6 characters. Each cell is a 1:1 crop of a 540×960 frame with the head at 18% of frame height (the camera-safety `medium` minimum). `expression-frame-540.png` is one uncropped frame of the same setup. |
| `kira-1.2.0-before-after.png`, `kira-1.2.0-full-body.png` | Kira 1.1.0 vs 1.2.0 at yaw 0/±30/±45/±60 (the camera-safety three-quarter range), plus a full-body identity check |

## Code

- `packages/engine/src/faces/`
  - `legacy.ts`: face set v1, moved from `faces.ts`; the pixels are unchanged.
  - `expressions.ts`: face set v2.
  - `mouths.ts`: talking shapes.
  - `design.ts`: primitives.
  - `recipes.ts`: `CharacterRecipe`s and crowd variants.
  - `index.ts`: `faceTexture`, `setFace`, `EXPRESSION_DEFS`.
- `packages/engine/src/faces.ts`: re-exports `faceTexture`.
- **Face hook.** `build.ts` is not modified, because `tests/narrated-continuity-integration.test.ts` #2 freezes it byte-for-byte.
  - The existing `Rig.setFace(state, blink)` already reaches face set v2 through `faceTexture`.
  - Talking goes through `setFace(rig, state, blink, mouth)` from `faces/index.ts`.
  - A v1 state without a mouth keeps its old cache key and drawing, so existing renders and goldens are unchanged.

## Handoff

- **S0 (`ids.ts`):**
  - Flip `teacher`, `mom`, `dad`, `friend_boy`, `friend_girl`, `noob`, `pro` and `crowd_kid` to `available`, each with `versions: ['1.0.0']`.
  - Add `1.2.0` to `kira.versions`.
  - Flip the 13 planned expressions to `available`, with source `packages/engine/src/faces/expressions.ts`.
  - Test: `tests/faces-characters.test.ts`.
  - The manifest lists **13** planned expressions, not 17.
- **S0 (schema):** `CharacterManifest.allowedExpressions` is limited to the schema `EXPRESSIONS` enum. v2 ids are therefore listed in `CharacterRecipe.expressions` (`faceStatesFor`), not in manifests. Episode validation (`packages/pipeline/src/validate.ts`) rejects them until that enum or the validator accepts library expressions.
- **S5:** Call `setFace(rig, state, blink, mouth)` after the animator's `setFace`. `mouth` is one of `MOUTH_SHAPES` (`closed`, `open`, `wide`, `o`) or `null`. `narrated-motion.ts` only applies expressions found in `manifest.face.states`; use `hasFace()` to include v2.
- **S7:** v2 expressions reference emote ids `emote_anger`, `emote_sweat`, `emote_tears`, `emote_question` and `emote_hearts` via `ExpressionDef.emoteVfxId`.
- **S6:** Adults are about 2.3–2.4 m tall, compared with about 1.8–2.0 m for kids. Actions and cameras have only been checked in stills, not in motion.
