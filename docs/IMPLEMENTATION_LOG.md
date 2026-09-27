# Implementation log

On this sandbox, every command ran with `unset NODE_OPTIONS` first: the host injected a preload script that does not exist.

## Phase 0 — environment
- `npm view three version` → **403**. PyPI, GitHub and the Playwright CDN also returned 403, so there is no package installation.
- Found:
  - `/opt/playwright/chromium-1232` (Chromium 151);
  - `playwright-core` (bundled inside global `@playwright/mcp`);
  - a stripped FFmpeg (VP8/PNG only);
  - tsc 7.0.2;
  - Node 22.23 native TypeScript.
- Probed headless Chromium:
  - WebGL2 works through SwiftShader.
  - WebCodecs is present only on a secure origin (`http://localhost`).
  - H.264 High, VP9 and AV1 encode at 1080×1920; audio encode is **Opus only (no AAC)**.
- Decision: a zero-dependency TypeScript stack, with WebCodecs encoding and our own MP4 muxer.

## Phase 1 — rendering spike (commit 1)
- WebGL2 renderer, fixed-timestep capture, H.264 encode, MP4 muxer and inspector.
- `node scripts/spike-render.ts`:
  - 90 frames at 1080×1920;
  - two runs produced identical MP4 SHA-256 and identical pixel hashes;
  - Chromium decoded the output with 0 dropped frames.

## Phase 2 — full proof of concept (commit 2)
- Built:
  - schema and validator;
  - manifests with hash lock;
  - procedural textures and the 5×7 font;
  - face decals and the rig builder;
  - 29 actions with two-bone IK and look-at;
  - prop events and physics;
  - 10 camera presets;
  - visual effects;
  - procedural audio with BS.1770 loudness;
  - render worker and 23 quality gates.
- Iterated with `node scripts/stills.ts …` contact sheets and the validator's frame issues:
  - fixed face-away shots, action-safe violations and the loop mismatch (28% → 2.6% frame diff);
  - fixed hand-to-button contact (9.4 cm → 0.0 cm) and loudness (−15.5 → −14.1 LUFS).
- The first full render took 3m50s and passed 19/23 gates.

## Phase 3 — quality (commit 3 + final)
- **Foot sliding.** Diagnosed with `scripts/diag-motion.ts` and `scripts/diag-slip.ts`. Fixes:
  - stance-foot-only grounding;
  - distance-driven phase;
  - stride fitting to mid-stance;
  - Hermite swing;
  - turns deferred until after the stop.

  Result: median slip 1.45 → 0.005 m/s, p95 4.3 → 0.041 m/s.
- **Hands.** Review of the stills showed Zapp's hand clipping through the button and Kira's "crossed" arms not crossing. Fixes:
  - soft hand-over-furniture constraint (picks the highest clearance);
  - `HAND_PENETRATION` check using exact collision shapes in each prop's local space;
  - `arms_crossed` rebuilt with local-space IK targets.
- **Cameras.** A chase-cam experiment put the camera inside the growing coin, so I reverted it and added a `CAMERA_IN_PROP` check. The payoff shot hid Zapp's face inside the coin, so I added a buried-face and prop-occlusion check and restaged the dive mark.
- Final canonical render plus determinism run (`node scripts/determinism.ts`):
  - **23/23 gates**;
  - 510/510 frames pixel-identical;
  - MP4 bytes identical;
  - 430 ms/frame.

## Phase 4 — studio
- `apps/studio/server.ts` (API and in-process job queue) and `apps/studio/src/studio.ts` (UI).
- `node scripts/studio-smoke.ts`:
  - starts the studio, opens the UI, clicks **Render preview**;
  - the MP4 appeared in the UI in 85 s;
  - screenshot: `docs/poc/studio-ui.png`.
- `npm test`: 24/24 pass.
