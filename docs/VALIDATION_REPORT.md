# Validation report — RBLX SPARK Video Factory

**Recommendation: B — MODIFY.** Build the web-native platform (Option B). It is technically viable, with zero manual steps per episode for rendering. The named compromises are in [section 5](#5-recommendation).

Evidence is in `docs/poc/`:
- the MP4;
- render log, quality report, validation report and determinism report;
- contact sheet, thumbnail and studio screenshot.

## 1. Test environment (and its limits)
- Linux, 8 vCPU (Xeon Platinum 8488C), 30 GB RAM, **no GPU**.
- Node 22.23 and Chromium 151 (Playwright build).
- **No network.** npm, PyPI and GitHub all return 403.

Consequences:
- three.js, Rapier, Zod, Next.js, FFmpeg (full build) and Blender could not be installed.
- The proof of concept is therefore **dependency-free TypeScript**:
  - its own WebGL2 renderer;
  - its own Zod-style validator;
  - its own MP4 muxer;
  - WebCodecs for H.264 and Opus encoding.
- The only FFmpeg available was Playwright's stripped build (VP8/PNG only), which is unusable for the final encode.
- Rendering used SwiftShader (CPU WebGL). **GPU numbers below are estimates, not measurements.**

## 2. What was validated, with evidence

### A. Browser 3D staging — validated
- Two original blocky characters, built from locked manifests.
- Nine face states: Zapp has 5, Kira has 4.
- Classroom with desks, board, windows, posters and shelf.
- Button, coin and desk props.
- PCF sun shadows, hemisphere lighting, point-light glow, ACES tone mapping and fog.
- Particles (sparkles, dust, confetti, rings), flashes, shake, and a looming-shadow grade.
- Deterministic prop physics: the coin pop and bounces are pre-simulated at 240 Hz.
- 13 shots using 8 of the 10 camera presets, framed for 9:16. `over_shoulder` and `chase_cam` are implemented but not used in the final cut: chase_cam was tried for s10 and rejected by QA.

The contact sheet `docs/poc/contact-sheet.png` shows one frame per shot. The renderer draws about 130 draw calls and 52k triangles per frame.

### B. Deterministic automated rendering — validated
One command renders the episode:

```
node apps/render-worker/render.ts --episode episodes/free-coins-loop-001.json
```

The pipeline is:
1. Validate the episode.
2. Run an analysis pass.
3. Mix audio and encode it to Opus.
4. Render frames at `t = i/30` in headless Chromium.
5. Encode to H.264 High with WebCodecs.
6. Mux to MP4.
7. Decode the file independently in Chromium's media stack.
8. Write the reports.

There is **no screen recording and no real-time dependency**: frames are rendered as fast as the machine allows.

| Metric | Measured |
|---|---|
| Output | `free-coins-loop-001.mp4`, 1080×1920, H.264 High + Opus stereo 48 kHz, 17.00 s, 510 frames, constant 30.000 fps, 22.4 MB, fast-start |
| Decode check | Chromium decodes the video at 1080×1920 with 0 dropped frames. Audio decodes. |
| Determinism | Two from-scratch renders in separate browser processes: **all 510 frames pixel-identical** (SHA-256 of raw RGBA per frame) and **byte-identical MP4** (`f8c0a2bd…2609`) |
| Render speed (CPU, no GPU) | **430 ms/frame, 12.9× slower than real time; 230 s total** for 17 s of video |
| Memory | Worker RSS 310 MB; page JS heap 22 MB peak. Chromium GPU-process memory was not measured separately. The host had 30 GB and used a small fraction. |
| Estimated cost, 20 s episode | About 4.5 min on 8 vCPU ≈ **$0.03** at about $0.35/h on-demand. With a GPU, likely much faster (not measured). |

Determinism holds for a fixed software and hardware stack. Pixel hashes can differ across GPU or driver families, so production should pin a render image and compare hashes per host class.

### C. Animation quality — partially validated

**Procedural plus authored keyframe tables is enough for this format's physical comedy.** The episode uses walk, run, look-at, curious lean, press, victory, shock recoil, arms-crossed, head-shake, cower, dive-to-prone and laugh.

Measured:

| Check | Result |
|---|---|
| Hand-to-button contact at the press frame | **0.0 cm** error (analytic two-bone IK onto the button's anchor, which is parented to the desk) |
| Planted-foot slip during locomotion | **median 0.005 m/s, p95 0.041 m/s**, while the body moves at 1.2–2.7 m/s |
| Hand penetration into props or scenery | Hands are lifted over furniture and devices by a soft constraint. A per-frame check exact to each prop's collision shape found **0 penetrations** in the final render. |
| Unexplained teleports | 0 across 510 frames (actors and props) |

**How sliding feet are avoided:**
- Leg phase is driven by distance travelled, not time.
- Only the stance foot is grounded.
- Stride length is fitted so each path starts and ends at mid-stance.
- Swing uses a Hermite curve, so the foot has zero velocity at lift-off and touch-down.
- Arrival turns happen in place after the stop.

**How weightless motion is avoided:**
- Anticipation and overshoot are built into the keyframe tables.
- Easing is applied to root motion.
- Props have ballistic arcs with restitution.
- Growth uses easeOutBack.
- The topple uses an accelerating fall.
- Big hits combine impact shake, dust and a sound effect.

**Known weaknesses:**
- During touchdown frames the arriving foot moves up to 2.9 m/s for one frame (excluded from the metric and reported).
- The run's flight phase is short.
- Hands are mitten blocks: there are no fingers, so grips are approximate.
- `pick_up`, `hold`, `put_down`, `throw`, `drink`, `jump`, `fall`, `angry_stomp`, `facepalm` and `hover` are implemented, but **not visually reviewed**, because the sample episode doesn't use them.
- Richer acting, such as nuanced laughs and double-takes, will need authored clips (commissioned or keyed in Blender) loaded into the existing action slots.
- Retargeting between different GLB skeletons was **not tested**, because there is no GLB loader yet. Instead, the procedural rig is generated from each character's locked proportions, which works in effect as retargeting for this cast.

### D. Asset consistency — validated
- Characters, props, environment and audio exist only as `<id>@<semver>.json` manifests.
- `assets/asset-lock.json` stores the SHA-256 of each canonical manifest.
- Editing a locked asset without bumping its version makes library loading fail (tested).
- Episodes pin versions, and the strict schema rejects unknown keys, so an episode **cannot** carry appearance data (tested).
- The reports record the asset hashes used for every render.

### E. Automatic storytelling — partially validated

**Validated:** episodes are pure data, and the validator is strong enough to gate rendering. It catches:
- missing assets and unknown references;
- impossible locomotion speeds;
- actions or expressions outside a character's lock;
- forbidden prop transforms;
- cause without effect (a press with no hand contact, a spawn with no press);
- timeline overlaps and shot gaps;
- stale stretches over 1.5 s;
- a missing or early reversal;
- a non-looping ending;
- A/V sync more than one frame off;
- protected or unsafe terms.

Small issues are auto-repaired and reported; everything else is refused. There are 14 tests for these cases. Screen-space framing, face visibility and occlusion, hand penetration and camera-inside-prop are checked per frame, **before** pixels are rendered.

**Not validated:** automatic generation of the idea, beats and staging. There was no LLM in this offline sandbox, and the deterministic "stager" (beat intents → marks, timings, shots) is not built yet. The sample episode was authored by hand as JSON and then tuned iteratively using the automatic QA.

This is the largest remaining unknown. The schema, validator and repair loop are the containment mechanism for whatever generator is built.

### F. Legal and platform safety
See `LEGAL_AND_ASSET_SAFETY.md`.
- All assets are original and procedural, and the engine loads no external media.
- The **brand name "RBLX SPARK" is itself the biggest IP risk**, because RBLX is Roblox's ticker. Rename before launch.

## 3. Quality gates (final render)
**23/23 passed.** Full table: `docs/poc/quality-report.md`.

**G23 ("readable while muted") is a proxy check only.** Everything else in that table is measured or statically enforced.

## 4. Known limitations (not hidden)
1. **Audio codec is Opus, not AAC.** WebCodecs here has no AAC encoder. Opus-in-MP4 is standards-compliant and plays in Chromium, but some upload pipelines or players may reject it. Fix: FFmpeg `-c:a aac` in the render container (one line). **Not tested here.**
2. **The idea → storyboard generator is not built.** See 2E.
3. **No GPU benchmark**, and no Docker image. Both were blocked by the lack of network access.
4. **A clean-checkout `npm install` was not exercised** (offline). It was verified only with the preinstalled Node, TypeScript, playwright-core and Chromium. Declared dev dependencies: `typescript ^5.8`, `playwright-core ^1.50`.
5. **Studio is an MVP:**
   - episode picker, storyboard, live preview with audio, validation panel, render queue, downloads, duplicate-with-new-seed, locked-asset table;
   - **no** per-beat regenerate or lock, timeline editing, asset upload or admin, or persistent job store.
6. **Camera solver:**
   - Wide shots trigger 38 "clamped to camera-safe volume" adjustments. The solver wants to be further back than the room allows, so framing ends up slightly tighter than solved.
   - One frame has Kira slightly outside the action-safe area.
   - Several shots needed per-shot parameter tuning. Presets are good defaults, not yet fully automatic composition.
7. **Only 2 of the 5 cast and 1 of the 8 environments exist**, and only 3 of the 15 props.
8. **Visual ceiling:** matte, blocky, clean lighting with no ambient occlusion, global illumination or motion blur. Faces are 2D decals, which is on-style but flat.
9. **Safety screening is a keyword list.** A human should approve every published episode.
10. **Determinism is proven on one host.** Cross-host determinism is not tested.

## 5. Recommendation
**B — MODIFY: proceed with Option B, the web-native deterministic engine, with these named compromises:**
1. **One optional human step per episode:**
   - approve the storyboard;
   - watch the 17-second MP4 once, muted, before publishing.

   Rendering, audio, sync, encoding and QA need no human.
2. **One-time human or commissioned animation work** for richer acting clips. This is per action, not per episode, and plugs into the existing slots, with IK and grounding kept as layers.
3. **Production render image:** Chromium + GPU + FFmpeg for AAC, pinned for determinism.
4. **Rename the brand** before public release.

**What would change this to STOP:**
- An LLM-plus-stager that cannot reach at least 80% first-pass validator acceptance after repair loops.
- GPU rendering that fails to beat CPU.

Neither is expected, but both are unmeasured and should be the next two experiments.
