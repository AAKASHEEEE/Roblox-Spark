# MVP scope (after this validation)

## Built in this proof of concept
- Episode schema v1.0 with a strict validator, auto-repair and explicit errors.
- Locked cast: Zapp and Kira.
- Classroom environment.
- Props: button, coin, desk.
- 29 semantic action names, all with runtime clips (`hover` is minimal until BZTT exists).
- 10 camera presets.
- 10 visual-effect types.
- Procedural audio with 19 sound effects, 1 music bed and 1 ambience.
- Render worker producing a verified MP4, plus 23 quality gates.
- Studio with:
  - episode picker;
  - storyboard;
  - live preview with audio;
  - validation warnings;
  - preview and final render buttons;
  - downloads (MP4, thumbnail, JSON, quality report, contact sheet);
  - duplicate/variation (new seed);
  - read-only locked-asset table.

## MVP: next build, in priority order
1. **Idea → episode compiler.** An LLM (or templates, if run offline) fills a *beat template per comedy engine*, then a deterministic stager turns it into episode JSON. Details:
   - The LLM only picks from closed lists: cast, marks, props, actions, presets.
   - Its output goes through `validateEpisode` with repair.
   - It is retried with the validator's error list as feedback, up to 3 times, and then fails loudly.
   - The validator and schema already enforce "data only". The remaining work is the stager: timing, marks and camera choice from beat intents.
2. **Remaining cast manifests:** Max, Ms. Byte and BZTT. BZTT needs the `floating_orb_v1` rig and `hover`.
3. **Environment kit.**
   - Add hallway, cafeteria, living room, exterior, bus, street and office.
   - Build them from a modular piece library: walls, windows, doors and furniture sets.
   - Each needs marks, anchors, camera-safe volume and lighting presets. The schema already requires all of these.
4. **Prop registry** for the 15 listed props, with grips/anchors. The schema is ready; only the manifests need writing.
5. **GLB path.**
   - Load glTF meshes and skins into the renderer, or swap the renderer for three.js.
   - Add authored animation clips (Mixamo-free, commissioned, or keyed in Blender) into `ACTION_DEFS` as sampled clips, keeping IK and grounding as layers.
6. **Studio additions:**
   - timeline editing (regenerate or lock a beat);
   - per-shot camera thumbnails;
   - asset admin (upload GLB, validate scale and skeleton, set anchors, licence form, draft→ready, versioned publish);
   - a persistent job store.
7. **AAC audio** using FFmpeg (`-c:a aac`) or a GPL-free AAC encoder in the render container. Opus-in-MP4 is valid but not universally accepted by upload pipelines.
8. **GPU render container.** A Dockerfile with Chromium and GPU drivers, and a benchmark on one GPU instance.

## Explicitly out of scope until render feasibility is proven at volume
Authentication, teams, billing and analytics. The cloud job queue and object storage come only after local single-user mode proves useful.
