# BlockSpark Vignette MVP — diagnostic Draft 1

**Temporary artifact branch. Never merge this branch into main.**

This is the first MP4 rendered from the integrated Vignette scene at source commit `4e04ccf5e61f716587f067b333b69940d41dbe52`.

- Visuals: current BeatSheet → real sets/characters/props/actions → safe solved cameras → captions/UI overlay.
- Analysis: PASS, 98.2% semantic coverage, 14/14 recipe cameras, zero fallback/blocked cameras, zero staging errors/warnings.
- Output: 540×960, 30 fps, 2073 frames, H.264 High/yuv420p, AAC-LC 48 kHz stereo, 69.12 s.
- Audio: approved voice-over plus the existing S7 event-SFX mix, remuxed/truncated to the current video; no music.
- MP4 SHA-256: `cc92aead238485d327490a171e922be5feb6c04c85b5fa9681fc104e5fc6ef8d`.
- Loudness: -14.1 LUFS integrated, -1.1 dBTP.

## Candid visual review

The story now reads literally: the teacher visibly leaves/returns through a real door, Zapp celebrates and presses the button, the coin appears/grows/tips, Kira reaches safety, Zapp is flattened, and the button resets. This is materially better than V2.

It is still a diagnostic draft, not competitor-level final output. The main visible blocker is the button insert around 21–25 s: a foreground Zapp limb occupies too much of the right side. Several later shots are intentionally wide/static to guarantee literal coverage; future work should add safe multi-shot coverage inside beats.

Do not authorize a second render until this MP4 is reviewed.
