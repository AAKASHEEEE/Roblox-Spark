# Production render evidence v2/v3

The checked competitor render remains the existing 540×960 MP4; this evidence hardening did **not** render or replace it. Because its manifest was added afterward, the existing artifact is explicitly marked `retroactive-integrity-seal`: it proves byte/source consistency, not pre-render authorization. Its records are:

- `full-render-v2/render-input-manifest.json` — retroactive integrity identity for this unchanged artifact: source commit/tree/base, storyboard, BeatSheet, approved voice, deterministic solved compositions, asset lock, package lock, and exact renderer tool versions. Runtime-byte hashes are intentionally `null` because they were not recorded before the historical render.
- `full-render-v2/render-evidence.json` — output/media/evidence byte pins. It includes the MP4, all seven historical renderer-snapshot PNGs, the comparison sheet, and the historical `verification.json` diagnostics. Those PNGs predate decoded-frame commitments and deliberately remain `frame-png`, not `decoded-frame-png`.
- `full-render-v2/verification.json` — historical renderer diagnostics only. It is hash-bound evidence, but no verifier accepts its booleans as proof.

The verifier retains read compatibility with historical `blockspark.render-evidence/2`; new reports use `/3`, whose strict schema is the only version permitted to carry `decoded-frame-png` claims.

Run the independent verifier from the repository root:

```bash
node packages/captions/tools/verify-mvp.ts
```

The v2 verifier recomputes tracked and pinned-source input hashes, the deterministic 41-composition solve, the asset/package locks, the MP4 hash and parsed media fingerprint (including exact H.264 profile/level), and every PNG/JPEG/diagnostics hash. It verifies the pinned git objects and rejects unknown schema fields, traversal paths, oversized files, missing files, changed bytes, wrong codecs/profile/resolution/frame rate, and stale or tampered evidence. The default checkout result is intentionally `partial`, never trusted: the historical artifact was retroactively sealed, its ignored runtime bytes were not recorded, its PNGs were renderer snapshots rather than output-decoded frame claims, the current checkout is newer than its pinned source, no scheduler authorization or independent post-render attestation digest is supplied, and raw approved voice is intentionally untracked. To verify the actual voice bytes too:

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
  --inputManifest out/render-authorizations/job-manifest.json \
  --authorizedManifestSha256 <scheduler-owned-canonical-manifest-sha256> \
  --voice .scratch/voice/eleven-1.mp3 \
  --ffmpeg node_modules/ffmpeg-static/ffmpeg \
  --out packages/captions/full-render-v2
```

The checked retroactive manifest cannot authorize a render. For new evidence, a trusted scheduler must create a `pre-render-authorized` manifest after source and the prebuilt bundle are committed/reviewed, pin the job/output identity, emitted `dist` tree, and actual FFmpeg/FFprobe/Playwright/Chromium bytes, retain its canonical digest outside the upload area, and pass that digest separately. `render-full.ts` bounds and authenticates the raw storyboard, BeatSheet, and voice as one batch before any JSON/container/native parser is entered. Trusted FFmpeg receives those authenticated voice bytes over stdin; FFprobe receives the just-created MP4 bytes over stdin; Playwright and Chromium are loaded/launched only from the exact authenticated paths. The generic no-manifest CLI remains a trusted-local operator workflow and can never produce trusted provenance.

After rendering, the worker copies the seven representative PNGs from decoded MP4 playback seeks, not from the pre-mux renderer, and writes `render-decoded-frames.json`. That bounded receipt pins the decode-time MP4 hash plus every frame seek/hash/size, so replacing the output before delayed sealing is rejected. The resulting `decoded-frame-png` report claims bind the fixed seek, committed PNG hash, and output hash. Regenerate `comparison-sheet.jpg`, then create the local integrity report without rendering media again:

```bash
node packages/captions/tools/seal-render-evidence.ts
node packages/captions/tools/verify-mvp.ts \
  --v2Voice .scratch/voice/eleven-1.mp3 \
  --authorizedManifestSha256 <scheduler-owned-canonical-manifest-sha256>
```

That standalone seal intentionally reports `integrity-sealed-untrusted`: for a new worker output it can preserve decoded claims only by validating the worker receipt against the current MP4 and committed PNG bytes; the historical directory has no receipt and remains legacy `frame-png`. The sealer never creates or prints a trust credential. A trusted scheduler/worker must separately retain and deliver `postRenderAttestationSha256`, computed over the canonical job hash plus input-manifest, output, media-fingerprint, and complete sorted evidence hashes. The caller supplies it to `verifyRenderV2` outside the artifact directory together with `authorizedManifestSha256`. `trusted` requires both independently supplied digests, exact source/voice/runtime recomputation, and all seven decoded-frame claims. Replacing output or evidence and locally resealing changes the expected post-render digest, so it remains untrusted.

## Worker-safe mode

`--workerSafe --prebuilt` disables per-job compilation into shared `dist/`, requires a scheduler-authorized manifest plus separately supplied digest, rejects any pre-existing output directory, and enforces symlink-aware allowlists. Before the first storyboard/BeatSheet JSON parse or MP3 container/FFmpeg operation, all three input files are opened no-follow, rejected by hard byte caps, read once, and compared to scheduler hashes. The same authenticated voice buffer is piped to FFmpeg. Runtime file/tree hashes are compared before invocation and again at the relevant launch boundary; trusted Playwright/Chromium and FFprobe have no PATH/default-runtime fallback:

- manifest: scheduler-only `out/render-authorizations` (never `out/render-inputs`);
- storyboard/BeatSheet: approved fixture or `out/render-inputs` roots;
- voice: `out/render-inputs` or `.scratch/voice`;
- FFmpeg/FFprobe: their locked `node_modules` package roots;
- output: a new directory under `out/render-jobs`;
- Chromium/Playwright: known installation roots.

Playback checks use the same authenticated browser plus a unique `out/render-verify-*` directory and remove that directory in `finally`, avoiding collisions between workers. As with any hash-before-spawn design, the scheduler must mount executable/package/runtime roots read-only (or use an immutable worker image); an in-process script cannot authenticate the Node process that is already running or prevent a privileged actor from replacing a pathname between hash and OS execution.

## Shared Vignette render primitive

`src/preview/vignette-render-session.ts` now owns validate/register/stage, interval-aware composition selection, exact-time scene posing, final scene+S7 VFX camera calculation, and scene rendering. The captions adapter consumes this primitive and adds only caption/VFX overlay, placement, capture, and evidence diagnostics.

`packages/vignette/src/web-entry.ts` is outside the captions ownership boundary and was not edited. Its owner should replace its local `load()`/`renderAt()` staging-camera-render sequence with `VignetteRenderSession` (or move this neutral contract into an agreed lower-level package), pass optional solved composition intervals, and keep only `drawVignetteOverlay` plus encoding in the entry. Until that integration lands, the neutral module prevents further captions-side duplication but both entry points are not yet a single import graph.
