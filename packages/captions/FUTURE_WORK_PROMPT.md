# Future prompt — integrate S7 into the vignette renderer

Copy the prompt below into a new Kiro session after the S2–S7 pull requests have merged into `integration/vignette-v1` (or its successor).

S7 now includes `packages/captions/tools/render-full.ts`, the neutral `packages/captions/src/preview/vignette-render-session.ts` primitive, and independently verifiable real-voice render evidence. The future task is to reuse those paths in the general Vignette worker and Studio rather than rebuilding staging/camera/render logic. Read `packages/captions/RENDER_EVIDENCE.md` first.

---

You are integrating the completed S7 captions/VFX/audio MVP into the full vignette renderer. Work from the branch containing the merged S2 sets, S3 characters/faces, S4 props, S5 actions, S6 staging/camera, and S7 `feature/captions-vfx-audio` changes.

Goals:

1. **Do not redesign S7.** Reuse:
   - `packages/captions/src/index.ts`
   - `packages/captions/src/preview/vignette-render-session.ts`
   - `packages/captions/src/preview/composition.ts`
   - `packages/engine/src/vfx/index.ts`
   - `packages/audio-mix/src/index.ts`
   Replace `packages/vignette/src/web-entry.ts`'s local validate/stage/pose/camera/render sequence with the neutral render session (or move that contract to an agreed lower-level package). Keep the Vignette overlay and encoder in the entry; do not create a third renderer.
2. In the S0-owned library manifest, flip every implemented S7 planned ID to `available` without renaming IDs:
   - text styles: `caption_bold`, `world_text_3d`, `ui_popup`, `title_card`
   - VFX: `sparkle`, `smoke_puff`, `fire`, `explosion`, `zoom_punch`, `emote_exclaim`, `emote_question`, `emote_sweat`, `emote_anger`, `emote_hearts`, `emote_tears`
   - SFX: `door_open`, `door_slam`, `footsteps`, `whoosh`, `boing`, `pop`, `gasp`, `crowd_laugh`, `bell`, `phone_ring`, `notification`
   Set sources to the corresponding S7 registry files. Do not add planned music IDs.
3. Wire beat-sheet events into the render path:
   - `vfx` events -> `evalVfxEvents()`; apply particles, post, shake, zoom, lights, and `EmoteLayer`
   - `text_graphic` events -> `WorldTextLayer` for `world_text_3d`; `drawOverlay()` for `ui_popup` / `title_card`
   - beat captions/aligned phrases -> `planBoldCaptions()` / `phrasesFromBeats()`
4. Project all visible face bounds for caption placement. Build one stable placement for each caption within each camera-shot segment. A caption may change vertical band only on a hard camera cut. Require zero face overlap; fail render QA if no safe placement exists.
5. Replace the old music/ambience audio path for vignette output with `mixPlanFromBeatSheet()` + `mixVoiceSfx()`:
   - preserve the voice-over timing and samples (except required 48 kHz resampling)
   - add SFX only for explicit `sfx` events
   - never mix music or ambience
   - never add planned music IDs
   - write/report about −14 LUFS integrated and <= −1 dBTP
6. Keep the existing Visual Comedy and narrated render modes backward compatible unless their output explicitly selects the new S7 pipeline.
7. Generate a strict pre-render manifest before running `packages/captions/tools/render-full.ts`; never use `.agents/**` review metadata as authorization. Port the proven exact-frame WebCodecs/AAC/mux/probe/playback flow into the supported general Vignette worker, then seal and independently verify output/media/input/evidence hashes. Do not use the synthetic stand-in for production output.
8. Validate:
   - `npm run typecheck`
   - `npm test`
   - `node packages/audio-mix/tools/mix-test.ts`
   - `node packages/captions/tools/render-stills.ts`
   - `node packages/captions/tools/verify-mvp.ts`
   - `node scripts/narrated-integration-analysis.ts` remains 47/47
   - inspect the generated video at hook, action, graphic, VFX, and payoff timestamps
   - independently measure output loudness and true peak
9. Update top-level README/render instructions only after the complete renderer can produce the end-to-end video in one command.
10. Commit, push, and open a pull request against the shared integration branch. Include exact test results, artifact links/paths, any ID status changes, and before/after stills.

Acceptance criteria:

- captions contain exactly the aligned phrase words, 1–4 words at a time
- centred bold white text, thick outline, exactly one yellow/red keyword, quick pop-in
- no caption overlaps any visible face
- all four text styles, all planned VFX, and all emote icons render in the final pipeline
- one SFX cue per explicit event, under the voice
- no music or ambience in the file
- output near −14 LUFS integrated and no higher than −1 dBTP
- no regressions in existing tests and 47/47 narrated integration gates

---
