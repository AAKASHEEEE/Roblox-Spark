# S7 MVP — captions, graphics, VFX, emotes, and audio

This branch implements the S7-owned surface of the vignette pipeline:

- `packages/captions/**` — `caption_bold`, `world_text_3d`, `ui_popup`, `title_card`, preview compositor, still generator, and MVP verifier.
- `packages/engine/src/vfx/**` — registry/runtime for every existing and planned VFX, deterministic particles/post/camera effects, and seven original emote icons.
- `packages/audio-mix/**` — voice-over plus event SFX mixer, all planned procedural SFX, no-music policy, 10-second WAV fixture, loudness/true-peak reporting.
- `packages/captions/showcase/**` — three verified H.264/AAC MP4 visual feature showcases.

The code is deterministic and random-access safe: seeking to a frame or rendering frames in another order produces the same visual/audio result for the same inputs and seed.

## Delivered behavior

### `caption_bold`

- Captions are generated from aligned phrase text with no dropped, inserted, duplicated, or reordered words.
- Each caption contains **1–4 words**.
- Text is horizontally centred, 900-weight white with a thick dark outline.
- Exactly one keyword per caption is highlighted; danger/negation/impact terms use red and other keywords use yellow.
- Pop-in settles in 130 ms.
- Face-aware placement scores projected scene geometry for every 30 fps frame in each segment. Placement is stable during a camera shot and may relocate only on a hard camera cut. The checked fixture has **61/61 captions clear of faces** across **90 shot segments**.

### Graphics

- `world_text_3d`: lit, extruded world-space text with dark depth layers, pop-in and fade-out.
- `ui_popup`: game notification pill with inferred coin/star/up/bell icon and target-relative placement.
- `title_card`: full-screen animated sunburst, slide-in/out, balanced title wrapping and optional subtitle.

### VFX and emotes

All reserved S7 VFX are implemented: `sparkle`, `smoke_puff`, `fire`, `explosion`, `zoom_punch`, `emote_exclaim`, `emote_question`, `emote_sweat`, `emote_anger`, `emote_hearts`, and `emote_tears`. Existing effects are also exposed through the same registry without changing their legacy pixels.

The icon set is original Canvas2D vector art: exclamation, question, sweat, anger, hearts, tears, and dots. Emotes are world-anchored billboards that face the camera.

### Audio

- Input: voice-over plus one SFX cue for each beat-sheet `sfx` event.
- **No music or ambience is mixed.** Beat-sheet music entries are reported as ignored with `music_added_in_editing`; planned music IDs are not implemented or substituted.
- SFX are loudness-matched, ducked under speech, and guarded to remain at least 6 dB below voice in measured speech windows.
- Output target: approximately **−14 LUFS integrated** and no higher than **−1 dBTP**.
- Included result: 10.000 s, 48 kHz, stereo, 24-bit WAV measured at **−14.01 LUFS / −1.20 dBTP** by the project meter. A digest-bound independent `pyloudnorm`/SciPy check measured **−14.05 LUFS / −1.20 dBTP** (4× and 8×).

## Quick start (step by step)

Run commands from the repository root.

1. Install dependencies and check the render environment:

   ```bash
   npm install
   npm run setup
   ```

2. Typecheck all browser/runtime packages:

   ```bash
   npm run typecheck
   ```

3. Generate the 10-second audio test (uses the approved phrase timings and a deterministic speech-like stand-in because the uploaded narration recording is not committed):

   ```bash
   node packages/audio-mix/tools/mix-test.ts
   ```

   Outputs:

   - `packages/audio-mix/samples/mix-test-10s.wav`
   - `packages/audio-mix/samples/mix-test-10s.report.json`
   - `packages/audio-mix/samples/mix-test-10s.independent-meter.json` (digest-bound external measurement evidence)

4. To test a real 48 kHz or other PCM WAV voice-over instead:

   ```bash
   node packages/audio-mix/tools/mix-test.ts --vo /path/to/voice.wav
   ```

   The tool keeps the voice timing unchanged, resamples to 48 kHz when needed, and replaces only the stand-in VO.

5. Generate caption, graphics, VFX, and emote stills over the approved narrated scene:

   ```bash
   node packages/captions/tools/render-stills.ts
   ```

   Primary review files:

   - `packages/captions/stills/sheet-caption_bold.jpg`
   - `packages/captions/stills/sheet-caption_bold-face-boxes.jpg` (cyan dashed boxes are faces)
   - `packages/captions/stills/sheet-graphics.jpg`
   - `packages/captions/stills/sheet-vfx.jpg`
   - `packages/captions/stills/emote-icons.png`
   - `packages/captions/stills/stills-index.json`

6. Review the three checked-in MP4 feature showcases:

   - `packages/captions/showcase/01-world-text-explosion.mp4`
   - `packages/captions/showcase/02-emote-reaction.mp4`
   - `packages/captions/showcase/03-caption-popup.mp4`
   - `packages/captions/showcase/verification.json`

   Each is a 2.4 s, 540×960, 15 fps H.264 High/yuv420p fast-start MP4 with a 48 kHz stereo AAC-LC track. These are deliberately short **visual** showcases, so their AAC tracks are silent; use `mix-test-10s.wav` for audio acceptance. Chromium playback verification decoded all three with zero dropped frames or media errors.

7. Run the single MVP gate after generating both artifact sets:

   ```bash
   node packages/captions/tools/verify-mvp.ts
   ```

   Expected summary:

   ```json
   {
     "status": "ok",
     "plannedImplemented": { "vfx": 11, "textStyles": 4, "sfx": 11 },
     "captions": { "phrases": 14, "captions": 61, "oneToFourWords": true, "faceSafe": "61/61" },
     "audio": { "durationSec": 10, "integratedLufs": -14.01, "truePeakDbtp": -1.2, "music": "none", "eventSfx": 3 },
     "showcaseMp4s": 3
   }
   ```

8. Run repository regression checks:

   ```bash
   npm test
   node scripts/narrated-integration-analysis.ts
   ```

   The narrated integration baseline must remain **47/47 gates passing**.

## Runtime use

### Plan bold captions from aligned phrases

```ts
import { planBoldCaptions } from './packages/captions/src/index.ts';

const plan = planBoldCaptions([
  { id: 'p01', start: 0, end: 1.8, text: 'Never press that button' },
]);
// NEVER (red) | PRESS THAT BUTTON (yellow keyword selected within the caption)
```

For beat-sheet input, call `phrasesFromBeats(sheet.beats)` first. `checkBoldPlan()` is the render gate for source-word, timing, word-count, and highlight invariants.

### Composite screen text

```ts
import { drawOverlay } from './packages/captions/src/index.ts';

// Call after drawing the 3D scene into the frame canvas.
drawOverlay(ctx, width, height, t, {
  captions: plan.captions,
  placements, // Map<captionId, centerY | shot placement segments>
  graphics: textGraphicsFromBeats(sheet.beats),
  anchor: (target, time) => projectTarget(target, time),
});
```

Use `placeBoldCaption()` with projected face/prop/graphic/body rectangles. For a caption crossing a camera cut, calculate one placement per shot segment and pass the segment array to `drawOverlay`; it changes band only at the cut.

### Add world text

```ts
import { WorldTextLayer } from './packages/captions/src/index.ts';

const layer = new WorldTextLayer();
sceneRoot.add(layer.root);
layer.update(textEvents, t, (target) => resolveWorldAnchor(target));
```

### Evaluate VFX

```ts
import { evalVfxEvents, applyZoom, EmoteLayer } from './packages/engine/src/vfx/index.ts';

const frame = evalVfxEvents(vfxEvents, t, resolveWorldAnchor, seed);
camera = applyZoom(camera, frame.zoom);
renderer.render(root, camera, lighting, frame.post, frame.particles);
```

Apply `frame.shake` through the engine `applyShake()`, merge `frame.lights` into scene lighting, and feed `frame.emotes` to `EmoteLayer.update()` before rendering.

### Mix VO plus event SFX

```ts
import { mixPlanFromBeatSheet, mixVoiceSfx, encodeWavStereo } from './packages/audio-mix/src/index.ts';

const plan = mixPlanFromBeatSheet(sheet); // sheet.music is explicitly ignored
const result = mixVoiceSfx({ left: voice48kMono }, plan.cues, loadedLibrary.audio, {
  targetLufs: -14,
  truePeakDbtp: -1,
  seed: sheet.seed,
});
const wav = encodeWavStereo(result.left, result.right, 48_000, 24, sheet.seed);
```

## Expected outputs and acceptance criteria

| Area | Acceptance result |
|---|---|
| Caption source | Exact aligned phrase words |
| Caption length | Every caption 1–4 words |
| Caption style | Centred, bold white, thick outline, one yellow/red keyword, 130 ms pop |
| Face safety | 61/61 fixture captions clear across all shot segments |
| Text graphics | All four text-style IDs implemented and visible in stills |
| Planned VFX | 11/11 implemented and visible in stills |
| Emotes | Seven icons plus six dedicated planned emote effects |
| Event audio | Every event cue resolves; SFX remain under voice |
| Music | None in output; suggested/planned music ignored |
| WAV | 10.000 s, 48 kHz, stereo, 24-bit |
| Loudness | About −14 LUFS integrated |
| True peak | At or below −1 dBTP |
| Existing narrated pipeline | 47/47 analysis gates pass |
| MP4 showcases | 3/3 H.264/AAC files pass Chromium playback with zero drops |

## Integration note

This branch intentionally does not edit S0-owned `packages/library/**` or the S0 beat-sheet contract. After merging, S0 should flip the implemented S7 IDs from `planned` to `available` and set their `source` fields to:

- text styles: `packages/captions/src/styles.ts`
- VFX: `packages/engine/src/vfx/defs.ts`
- SFX: `packages/audio-mix/src/sfx.ts`

The complete handoff prompt for that merge/integration work is in [`FUTURE_WORK_PROMPT.md`](./FUTURE_WORK_PROMPT.md).
