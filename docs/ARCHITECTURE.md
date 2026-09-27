# Architecture

```
episode JSON (data only) ──► validate (strict schema + semantic gates + safe repairs)
        │                                     │
        │                             refuses broken input
        ▼
Production runtime (pure function of t)       locked asset library (versioned manifests + sha256 lock)
  environment / props / cast rigs  ◄─────────  assets/{characters,props,environments,audio}/<id>@<ver>.json
  ActorTrack  : semantic actions → root motion, clip poses, IK, look-at, stance-foot grounding, faces
  PropTrack   : events + fixed-step (240 Hz) pre-simulated physics
  Camera      : semantic presets solved from subject bounds, stage-line + camera-safe clamps
  VFX         : closed-form particles, flashes, shake, looming shadow
        │
        ├── Studio preview (same code, requestAnimationFrame, WebAudio of the same mix)
        └── Render worker (headless Chromium, Playwright):
              analysis pass → shot validation, contacts, motion probes, derived footsteps
              audio: procedural synth → mix/duck → BS.1770 loudness → limiter → Opus (WebCodecs)
              frames: t = i/fps → WebGL2 → VideoFrame → H.264 High (WebCodecs)
              in-house ISO-BMFF muxer → fast-start MP4 → independent Chromium decode check
              → thumbnail, contact sheet, render-log.json, quality-report.{json,md}
```

## Repository layout
| Path | Purpose |
|---|---|
| `packages/schema` | Zod-style strict validator (`v.ts`), episode schema v1.0, asset manifest schemas |
| `packages/engine` | WebGL2 renderer, procedural geometry and textures, faces, rig builder, animation, props, camera, VFX, production runtime, capture |
| `packages/audio` | Deterministic synth patches, music/ambience generators, mixer, loudness |
| `packages/mp4` | MP4 muxer (avc1/avcC + Opus/dOps, edit list) and inspector |
| `packages/pipeline` | Episode validation/repair and quality gates |
| `apps/render-worker` | CLI + library: browser launch, static server, library loader/lock, verification, contact sheets |
| `apps/studio` | Local control plane: API server + UI (storyboard, preview, render queue, asset table) |
| `assets/` | Locked manifests + `asset-lock.json` |
| `episodes/` | Episode data |
| `scripts/` | doctor, spike, stills, determinism, motion diagnostics, asset lock |
| `tests/` | `node:test` unit and integration tests |

## Key design decisions
- **Determinism.**
  - Every frame is a pure function of `(episode, library, t)`.
  - No wall-clock time is used, and there is no `Math.random`. All randomness is seeded (mulberry32 / FNV).
  - Physics is pre-simulated at a fixed step, and frames are sampled at `t = i/fps`.
  - Encoder output timestamps are set by us.
  - The muxer writes no timestamps or random IDs.
  - Result: byte-identical MP4s on the same software stack.
  - Across different GPUs or drivers, pixels can differ slightly. Hashes should be compared per render host class.
- **Episodes are data only.** The strict schema rejects unknown keys, so appearance cannot be smuggled into an episode. Actions, presets and events are closed lists. Nothing from an episode is ever evaluated as code.
- **Identity lock.**
  - Characters exist only as manifests named `<id>@<semver>.json`.
  - `asset-lock.json` stores sha256 hashes of canonical JSON.
  - Changing a locked file fails library loading until a new version is published.
  - Episodes pin a version, so older episodes keep re-rendering identically.
- **Semantic actions → motion.**
  - Each action is an authored keyframe table plus procedural layers: locomotion phase, analytic two-bone arm IK, look-at, tremble and breathing.
  - Walking and running derive leg phase from distance travelled. Stride length is fitted to the path so the character arrives at mid-stance.
  - Only the stance foot is grounded. This is the no-sliding mechanism, measured by gate G21.
  - Additive layer actions (for example `head_shake`) can run on top of body actions.
- **Contact and causality.** `press_button` targets a prop anchor that is parented to the desk, and IK drives the hand onto it. The validator requires every `press` event to be within 0.1 s of the computed contact time, and every spawn to follow a press. Audio cues with `sync: contact:*` or `sync: impact:*` are snapped to the computed times.
- **Cameras.**
  - Presets are solved from the posed rig and prop bounds at shot start (or at `solveAt`), then held with small push-in, truck and operator drift.
  - Cameras stay on the audience side of the action line and are clamped to the environment's camera-safe volume and colliders.
  - `final_loop` re-solves the opening composition, so the last frame matches the first.
- **Shot validation.** Probe points are projected to screen space every 3rd frame, catching:
  - subject out of frame, outside action-safe, or behind the camera;
  - face out of frame, turned away, or occluded (ray against the environment AABBs);
  - camera adjustments.
- **Why a custom renderer and not three.js.** The sandbox has no package registry. The renderer is about 400 lines (forward shading, PCF shadow map, hemisphere and point lights, ACES tone mapping, fog, decals, particles, billboards) and is scoped to this art style. The renderer is behind a small interface (`Renderer.render(root, cam, light, post, particles)`), so swapping in three.js or Babylon.js later is a contained change if GLB/PBR assets are needed.

## Scaling to production (not built yet)
- A job queue: Postgres + a worker pool, or a simple Redis queue.
- Object storage for outputs.
- GPU render containers running Chromium with `--gpu` (ANGLE/Vulkan).
- Health checks: `/api/health` exists. Structured `render-log.json` records timings, memory, hashes and the host.
- The render worker is stateless, which makes horizontal scaling straightforward.
