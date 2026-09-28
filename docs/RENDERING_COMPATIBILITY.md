# Rendering compatibility policy

An episode renders the same pixels for as long as this build still supports the combination it declares. Behaviour is
chosen only by that declaration.

## The declaration

Episode schema 1.1 has a required `render` block:

```json
"render": { "rendererVersion": "1.0.0", "motionProfile": "corrected-head-v2" }
```

- `rendererVersion` is the pixel pipeline: geometry, shaders, lighting, post-processing, frame capture.
- `motionProfile` is the animation behaviour: gaze, head layers, turning, locomotion.
- `upgradedFrom` is optional. It is written only by the upgrade command and is provenance only.

| Renderer | Supported motion profiles | Status |
|---|---|---|
| 1.0.0 | `legacy-head-v1` | legacy: kept to reproduce existing episodes |
| 1.0.0 | `corrected-head-v2` | current: written into newly generated episodes |

The source of truth is `packages/schema/src/render-compat.ts`: `SUPPORTED_COMBINATIONS` and `MOTION_PROFILES`.

## Rules

1. **Behaviour comes only from the declaration.**
   - The engine reads a behaviour table (`MotionBehaviour`) selected by the declared profile.
   - Nothing is inferred from episode ids, file names, creation dates, schema history or hard-coded fixture checks.
   - `tests/render-compat.test.ts` enforces this. It checks that the same content with a different id resolves to the same behaviour, and that engine, pipeline and schema source never reference fixture ids. It also checks that the resolver never looks at dates, ids or files.
2. **Missing or unsupported values fail explicitly. There is no fallback.** The validator, `Production` (engine) and the render worker all refuse such an episode with a specific code:

   | Code | Meaning |
   |---|---|
   | `UNSUPPORTED_SCHEMA_VERSION` | e.g. an undeclared 1.0 file |
   | `RENDER_VERSION_MISSING` | no `render` block |
   | `RENDERER_VERSION_MISSING` | `render.rendererVersion` absent |
   | `MOTION_PROFILE_MISSING` | `render.motionProfile` absent |
   | `UNSUPPORTED_RENDERER_VERSION` | renderer version not in this build |
   | `UNSUPPORTED_MOTION_PROFILE` | motion profile not in this build |
   | `UNSUPPORTED_COMBINATION` | version and profile each known, but not supported together |

3. **Published combinations are immutable.**
   - Once a (rendererVersion, motionProfile) pair has golden hashes, its pixels never change. A change that alters them is a regression.
   - New motion behaviour needs a new `motionProfile`.
   - A pixel-pipeline change needs a new `rendererVersion`.
   - Both need new goldens. The old goldens stay.
4. **Defaults apply only to new episodes.**
   - The story compiler writes `CURRENT_RENDERER_VERSION` and `DEFAULT_MOTION_PROFILE` (`corrected-head-v2`), unless the request asks for another profile explicitly.
   - Existing episodes keep whatever they declare.
5. **Pinning is a one-time, explicit migration.**
   - `node scripts/episode-version.ts pin <file> --renderer <v> --profile <id>` rewrites an undeclared 1.0 file.
   - Both flags are required, and it refuses files that already declare a profile.
   - It was run once, on `episodes/free-coins-loop-001.json` (1.0.0 / `legacy-head-v1`). The file's canonical 1.0 content hash is still `f61e6af3…`, the hash recorded at 1dc7a26.
6. **Upgrading always writes a copy.**
   - Command: `node scripts/episode-version.ts upgrade <in> --to corrected-head-v2 --out <new>`.
   - It never writes the source: the source is hashed before and after, and `--out` may not be the source path.
   - It records `upgradedFrom` (previous declaration and source SHA-256).
   - It keeps the semantic hash, i.e. the canonical JSON of everything except `render`.
   - The pixels change on purpose.
7. **Retiring a combination** needs an explicit migration (upgrade copies of the affected episodes) and a release note. Afterwards the build must reject it with `UNSUPPORTED_*`, never map it silently to another profile.

## Motion profiles

**`legacy-head-v1`** reproduces the motion math exactly as it was before versioning (PoC commit 1dc7a26), defects included. The action reel measured these defects:

| Defect | Legacy | Corrected |
|---|---|---|
| Look-at pitch, with the head turned 54° | 17.1° reached of 30.3° needed | 30.1° |
| `head_shake` under an active look-at (weight 0.8) | 4° amplitude | 20.4° |
| `turn_toward` / `startFacing` an actor listed later in the cast | ignored (0°) | 29.8° |
| Planted-foot speed at locomotion onset (locomotion reel) | up to 2.7 m/s | 0.005 m/s |

The look-at pitch defect comes from the rotation order: pitch is composed about the spine's x axis, not the turned head's.

**`corrected-head-v2`** contains every correction in the table above:
- yaw-then-pitch look-at;
- head layers re-applied on top of the gaze;
- later-cast targets resolved once all tracks exist;
- a synchronised locomotion onset. The planted stance foot anchors the body as it pivots and steps off, the gait phase advances with gait distance, and the swing foot arcs from where it stood.

The profile name follows the requested naming. The locomotion-onset correction is included because keeping legacy fixtures pixel-identical requires every motion correction to be gated by the declared profile.

Known limits of `corrected-head-v2`, all measured in the action reel report:
- In-place turns (`turn_toward`, arrival facing) still rotate about the root centre, so the feet skate. This affects both profiles.
- After stopping, the legs blend back to idle while the root is still. This affects both profiles.
- Get-ups from lying poses keep the blended onset; so do dives that leap before the first step lands. The reason is recorded per segment (`onsetSkip`).

## Golden hashes

- **Layout:** `tests/golden/<episode id>/<rendererVersion>__<motionProfile>.json`, one immutable set per combination.
- **Contents of each file:**
  - fixture path, canonical episode SHA-256 and semantic SHA-256;
  - resolution and fps;
  - `frameHashes` for every frame;
  - `checkFrames`, the fast subset (every 15th frame and the last);
  - provenance.
- **What is hashed:** SHA-256 of the raw RGBA framebuffer (`renderer.readPixels`) of frame *i* rendered at *t = i / fps*. The render worker's capture path hashes the same bytes. The legacy check compares fast-path hashes against capture-path baseline hashes, so the two paths are proven equal.
- **Recording:** `node scripts/golden.ts record <fixture>`. It refuses to overwrite an existing golden.
- **Checking:** `node scripts/golden.ts check [--all-frames]` or `npm run golden:check`. A golden applies only to the exact fixture content and declaration it was recorded for.

| Golden | Frames | Resolution | Source |
|---|---|---|---|
| `free-coins-loop-001/1.0.0__legacy-head-v1` | 510 | 1080×1920 | the 1dc7a26 baseline; re-verified 510/510 with a full render of the pinned fixture (25/25 gates) |
| `free-coins-loop-001/1.0.0__corrected-head-v2` | 510 | 1080×1920 | upgrade copy `tests/fixtures/episodes/free-coins-loop-001.corrected-head-v2.json` |
| `gen-ooe-zapp-presses-a-free-ub5-s17/1.0.0__corrected-head-v2` | 510 | 540×960 | generator output for the brief's example idea (`scripts/fixture-generate.ts`), stored verbatim |
| `gen-ooe-zapp-presses-a-free-ub5-s17/1.0.0__corrected-head-v2__gen-example-free-coins.tuned` | 510 | 540×960 | the same idea and seed through the re-tuned generator (profile-aware fit pass, `docs/story/CLEARANCE_AND_FRAMING.md`); a separate fixture with the same episode id, so its golden is named after the fixture |

The two PoC goldens share one semantic hash. Their pixels differ in 445 of 510 frames: every frame from 0 to 14.87 s except 11.30–11.33 s. The last 63 frames (14.9–17 s) are identical. `tests/render-golden.integration.test.ts` asserts all of this.

**Scope:** goldens are byte-exact for this renderer on the same image and hardware (Chromium SwiftShader, CPU). Other GPUs or drivers are not byte-comparable. Cross-hardware equivalence is a separate, thresholded check.

## Render manifest

Every render writes `render-manifest.json` with:
- the declared `rendererVersion`, `motionProfile`, `renderKey` and any `upgradedFrom`;
- the episode and semantic hashes;
- resolution, fps and frame count;
- a digest of the hashed frames;
- the MP4 SHA-256;
- the asset-lock digest and the Chromium / GL renderer.
