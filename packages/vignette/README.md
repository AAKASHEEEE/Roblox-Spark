# packages/vignette (S6): staging, camera and multi-set engine

Beat sheet → staged world plan → multi-set scene → per-beat camera on camera safety → script coverage → report + stills.

```
npm run vignette:stage                                   # packages/director/fixtures/free-coins-classroom.beats.json
node scripts/vignette-stage.ts --sheet packages/vignette/fixtures/multi-set-demo.beats.json
node scripts/vignette-stage.ts --no-stills               # analysis only (~10 s, no browser)
```

Output goes to `out/vignette/<sheet id>/`: `analysis-report.md` / `.json`, `shots.json` and `stills/<phraseId>.png`. The exit code is 2 when the sheet is blocked. Committed runs are in `docs/vignette/stage/`.

| File | Role |
|---|---|
| `src/sets.ts` | Set layouts in one world. Each set gets its own origin (40 m apart). Available sets use manifest + catalog marks, dressing implied by prop marks (`button_desk` is the hero desk), and staging doorways. Planned sets get a grey room whose marks and doors are allocated from the names the beats use. |
| `src/stage.ts` | Staging planner. Produces placements, cuts versus carry-over, entrances and exits (walk timed to the event, door state checked), prop spans, and action timing aligned to cues. The output is one narrated `WorldPlan` built from the existing contracts (move_to with path_clear, press_button reach/facing bridges, spawn/grow/tip_coin_onto + fall_prone at contact, and so on). |
| `src/path.ts` | Walk routing around obstacles inflated by the body radius (visibility graph). |
| `src/scene.ts` | `VignetteScene`. Builds every set through `engine/src/build-dispatch.ts` into `engine/src/set-stack.ts`. Shows one set per beat. Poses rigs, coin and button with the existing `NarratedEngineAdapter`, and places doors, held/on props and labels. |
| `src/placeholders.ts`, `src/label.ts` | Grey labelled placeholder rooms, characters and props, drawn in a deterministic block font. |
| `src/resolve.ts` | Decides for each ID whether it is available, a placeholder, or a labelled fallback (planned actions and expressions play the nearest existing behaviour, with a label above the actor). |
| `src/camera-recipes.ts` | 19 `CameraRecipe`s: the 9 planned ids plus the 10 available ids, all re-built on camera safety. |
| `src/camera.ts` | Per-beat solve. Recipe variants are calibrated on the posed heads and fitted to content, then evaluated with `evaluateCameraCandidate` on every sampled frame. Accepted variants are ranked by coverage, then score. Otherwise it falls back to camera safety's vetted fallbacks, and failing those the beat is BLOCKED. |
| `src/coverage.ts` | Script coverage check. Cast, props and events must be visible in the beat's shot. The sheet is blocked below 90 %. SFX are audio-only and not counted. |
| `src/pipeline.ts` | `runVignette()` plus the analysis report. |

Known limits:
- The pose adapter resolves look targets only for actors, the coin, the button and the first door. For any other target, the body turns and the head stays neutral.
- `sit` is a labelled standing placeholder. `--waistUp` framing is off by default.
- One world button press and one coin are supported per sheet, as in the narrated world model.
