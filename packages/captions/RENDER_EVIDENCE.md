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

A competitor evidence render is always a worker-safe render and must receive an input manifest before any output is created. It may never reuse the historical evidence directory:

```bash
FFPROBE_PATH=node_modules/ffprobe-static/bin/linux/x64/ffprobe \
node packages/captions/tools/render-full.ts \
  --visual vignette \
  --profile review-vertical-540p \
  --evidenceProfile competitor-v2 \
  --workerSafe \
  --prebuilt \
  --jobId <scheduler-job-id> \
  --inputManifest out/render-authorizations/job-manifest.json \
  --authorizedManifestSha256 <scheduler-owned-canonical-manifest-sha256> \
  --voice out/render-inputs/voice.mp3 \
  --ffmpeg node_modules/ffmpeg-static/ffmpeg \
  --out out/render-jobs/<scheduler-job-id>
```

The checked retroactive manifest cannot authorize a render. For new evidence, a trusted scheduler must create a `pre-render-authorized` manifest after source and the prebuilt bundle are committed/reviewed, pin the job/output identity, emitted `dist` tree, and actual FFmpeg/FFprobe/Playwright/Chromium bytes, retain its canonical digest outside the upload area, and pass that digest separately. `render-full.ts` bounds and authenticates the raw storyboard, BeatSheet, and voice as one batch before any JSON/container/native parser is entered. Trusted FFmpeg receives those authenticated voice bytes over stdin; FFprobe receives the just-created MP4 bytes over stdin; Playwright and Chromium are loaded/launched only from the exact authenticated paths. The generic no-manifest CLI remains a trusted-local operator workflow and can never produce trusted provenance.

After rendering, the worker copies the seven representative PNGs from decoded playback of the completed MP4, not from the pre-mux renderer, and writes `render-decoded-frames.json`. That bounded receipt pins the completed MP4 hash plus every exact seek, PNG hash, and byte count. The v3 report also commits `comparison-sheet.jpg` to that exact decoded-frame set and output hash; mtime alone is never accepted as trust evidence. The independent verifier re-reads and authenticates the MP4, every PNG/JPEG, all sizes and hashes, the fixed timestamps, the frame-set commitment, and the comparison-sheet commitment.

The worker-safe comparison builder must run first. It authenticates the completed MP4, decoded-frame receipt, every PNG, Playwright tree, and Chromium binary, creates the sheet without external inputs, and writes a strict generation receipt:

```bash
node packages/captions/tools/render-comparison-sheet.ts \
  --manifest out/render-authorizations/job-manifest.json \
  --authorizedManifestSha256 <scheduler-owned-canonical-manifest-sha256> \
  --evidenceDir out/render-jobs/<scheduler-job-id> \
  --playwrightCore node_modules/playwright-core \
  --chromium <authorized-chromium-path>
```

Local finalization validates that builder receipt against current output/frame/JPEG/runtime bytes. It can build the integrity report but cannot create trust:

```bash
node packages/captions/tools/seal-render-evidence.ts \
  --manifest out/render-authorizations/job-manifest.json \
  --output out/render-jobs/<scheduler-job-id>/zapp-vs-kira-competitor-performance-v2.mp4 \
  --evidenceDir out/render-jobs/<scheduler-job-id> \
  --report out/render-jobs/<scheduler-job-id>/render-evidence.json
```

That command always reports `integrity-sealed-untrusted`. An unkeyed digest—whether stored beside the artifact or supplied as an argument—is only an identifier and never authenticates a worker. After checking the current report against the current completed output, decoded-frame receipt, frame bytes, comparison bytes, and manifest, a trusted worker may create an Ed25519 attestation with a private key injected from **outside** the repository/job filesystem:

```bash
node packages/captions/tools/seal-render-attestation.ts \
  --manifest out/render-authorizations/job-manifest.json \
  --output out/render-jobs/<scheduler-job-id>/zapp-vs-kira-competitor-performance-v2.mp4 \
  --evidenceDir out/render-jobs/<scheduler-job-id> \
  --report out/render-jobs/<scheduler-job-id>/render-evidence.json \
  --privateKey /run/secrets/render-worker-ed25519.pem \
  --keyId production-render-worker-1 \
  --attestationOut out/render-attestations/<scheduler-job-id>.json
```

The scheduler retains that envelope outside the artifact channel. Verification requires the separately configured public key and key identity; the signature binds the full job, source/tree/base, authorized manifest, output hash/size, media fingerprint, every evidence hash, decoded-frame set, and comparison sheet:

```bash
node packages/captions/tools/verify-mvp.ts \
  --v2Report out/render-jobs/<scheduler-job-id>/render-evidence.json \
  --v2Voice out/render-inputs/voice.mp3 \
  --authorizedManifestSha256 <scheduler-owned-canonical-manifest-sha256> \
  --postRenderAttestation out/render-attestations/<scheduler-job-id>.json \
  --attestationPublicKey /etc/blockspark/render-worker-ed25519.pub.pem \
  --attestationKeyId production-render-worker-1 \
  --requireTrusted
```

Exit status is strict: `0` means the requested verification level passed, `1` means integrity or input verification failed, and `2` means integrity passed but `--requireTrusted` could not establish trusted provenance. `trusted` additionally requires worker-safe/new-output authorization, exact source/voice/runtime recomputation, and all seven decoded frames. Replacing output/evidence, changing a seek/image/size, changing source or job identity, substituting a key, or locally resealing invalidates the signed attestation.

The verifier-side threat model is explicit: it independently verifies all bytes and commitments, while the signed worker claim establishes that the seven committed PNGs were decoded from the completed MP4 and that the comparison sheet was built from those committed frames. The worker signing key must be inaccessible to render inputs and artifact writers and released only in the immutable worker after successful render/decode/finalization. Without that boundary, output-decoding provenance remains untrusted.

## Worker-safe mode

`--evidenceProfile competitor-v2` now requires `--workerSafe --prebuilt`; the authorized manifest itself must carry `job.workerSafe: true`. The worker rejects every pre-existing output directory, so trusted mode cannot reuse the checked historical directory or any prior job output. Worker-safe mode disables per-job compilation into shared `dist/`, requires a scheduler-authorized manifest plus separately supplied digest, and enforces symlink-aware allowlists. Before the first storyboard/BeatSheet/lock JSON parse or MP3/container/native operation, inputs are opened no-follow, rejected by hard byte caps, read once, and compared to scheduler hashes. Runtime trees have per-file/count/aggregate limits and selected executable binaries have hard limits before hashing or invocation. The same authenticated voice buffer is piped to FFmpeg. Runtime file/tree hashes are compared before invocation and again at the relevant launch boundary; trusted Playwright/Chromium and FFprobe have no PATH/default-runtime fallback:

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
