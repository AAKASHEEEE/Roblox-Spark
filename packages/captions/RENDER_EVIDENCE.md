# Production render evidence v2

The checked competitor render remains the existing 540×960 MP4; this evidence hardening did **not** render or replace it. Because its manifest was added afterward, the existing artifact is explicitly marked `retroactive-integrity-seal`: it proves byte/source consistency, not pre-render authorization. Its records are:

- `full-render-v2/render-input-manifest.json` — retroactive integrity identity for this unchanged artifact: source commit/tree/base, storyboard, BeatSheet, approved voice, deterministic solved compositions, asset lock, package lock, and exact renderer tool versions. Runtime-byte hashes are intentionally `null` because they were not recorded before the historical render.
- `full-render-v2/render-evidence.json` — output/media/evidence byte pins. It includes the MP4, all seven representative PNGs, the comparison sheet, and the historical `verification.json` diagnostics.
- `full-render-v2/verification.json` — historical renderer diagnostics only. It is hash-bound evidence, but no verifier accepts its booleans as proof.

Run the independent verifier from the repository root:

```bash
node packages/captions/tools/verify-mvp.ts
```

The v2 verifier recomputes tracked and pinned-source input hashes, the deterministic 41-composition solve, the asset/package locks, the MP4 hash and parsed media fingerprint (including exact H.264 profile/level), and every PNG/JPEG/diagnostics hash. It verifies the pinned git objects and rejects unknown schema fields, traversal paths, missing files, changed bytes, wrong codecs/profile/resolution/frame rate, and stale or tampered evidence. The default checkout result is intentionally `partial`, not trusted: the historical artifact was retroactively sealed, its ignored runtime bytes were not recorded, the current checkout is newer than its pinned source, no scheduler authorization digest is supplied, and raw approved voice is intentionally untracked. To verify the actual voice bytes too:

```bash
node packages/captions/tools/verify-mvp.ts --v2Voice .scratch/voice/eleven-1.mp3
```

No file under `.agents/**`, including an approval or review result, is a trust input. The strict manifest schema rejects approval fields; trust comes from content hashes and pinned git objects.

## Render configuration boundaries

Three independent choices replace the old overloaded `--visual` switch:

- `--visual vignette|narrated` selects the generic scene renderer.
- `--profile review-vertical-540p|production-vertical-1080p` selects immutable dimensions, fps, and bitrates. Conflicting width/height/fps/bitrate overrides fail.
- `--evidenceProfile none|competitor-v2` selects fixture-specific teacher/door/action/evidence gates. `competitor-v2` requires the Vignette renderer and review profile; generic Vignette jobs do not inherit those fixture assumptions.

A competitor evidence render must receive an input manifest before any output is created:

```bash
FFPROBE_PATH=node_modules/ffprobe-static/bin/linux/x64/ffprobe \
node packages/captions/tools/render-full.ts \
  --visual vignette \
  --profile review-vertical-540p \
  --evidenceProfile competitor-v2 \
  --prebuilt \
  --jobId <scheduler-job-id> \
  --inputManifest /scheduler/render-authorizations/job-manifest.json \
  --authorizedManifestSha256 <scheduler-owned-canonical-manifest-sha256> \
  --voice .scratch/voice/eleven-1.mp3 \
  --ffmpeg node_modules/ffmpeg-static/ffmpeg \
  --out packages/captions/full-render-v2
```

The checked retroactive manifest cannot authorize a render. For new evidence, a trusted scheduler must create a `pre-render-authorized` manifest after source and the prebuilt bundle are committed/reviewed, pin the job/output identity, emitted `dist` tree, and actual FFmpeg/FFprobe/Playwright/Chromium bytes, retain its canonical digest outside the upload area, and pass that digest separately. `render-full.ts` requires a clean exact source, a mode-correct entry, all runtime hashes, and exact source/tool/input matches before creating output.

After rendering and regenerating `comparison-sheet.jpg`, seal the byte hashes without rendering media again, then verify with the scheduler digest and approved voice:

```bash
node packages/captions/tools/seal-render-evidence.ts
node packages/captions/tools/verify-mvp.ts \
  --v2Voice .scratch/voice/eleven-1.mp3 \
  --authorizedManifestSha256 <scheduler-owned-canonical-manifest-sha256>
```

## Worker-safe mode

`--workerSafe --prebuilt` disables per-job compilation into shared `dist/`, requires a scheduler-authorized manifest plus separately supplied digest, rejects any pre-existing output directory, and enforces symlink-aware allowlists. Runtime file/tree hashes are compared before FFmpeg, FFprobe, Chromium, or Playwright is executed:

- manifest: scheduler-only `out/render-authorizations` (never `out/render-inputs`);
- storyboard/BeatSheet: approved fixture or `out/render-inputs` roots;
- voice: `out/render-inputs` or `.scratch/voice`;
- FFmpeg/FFprobe: their locked `node_modules` package roots;
- output: a new directory under `out/render-jobs`;
- Chromium/Playwright: known installation roots.

Playback checks use a unique `out/render-verify-*` directory and remove it in `finally`, avoiding collisions between workers.

## Shared Vignette render primitive

`src/preview/vignette-render-session.ts` now owns validate/register/stage, interval-aware composition selection, exact-time scene posing, final scene+S7 VFX camera calculation, and scene rendering. The captions adapter consumes this primitive and adds only caption/VFX overlay, placement, capture, and evidence diagnostics.

`packages/vignette/src/web-entry.ts` is outside the captions ownership boundary and was not edited. Its owner should replace its local `load()`/`renderAt()` staging-camera-render sequence with `VignetteRenderSession` (or move this neutral contract into an agreed lower-level package), pass optional solved composition intervals, and keep only `drawVignetteOverlay` plus encoding in the entry. Until that integration lands, the neutral module prevents further captions-side duplication but both entry points are not yet a single import graph.
