# Narrated draft validation artifacts v0.1 (temporary)

These are **temporary Phase 2A validation artifacts** for the Narrated Story draft render.

- **This branch (`artifacts/narrated-draft-v0.1`) must never be merged into `main`.**
- Source code commit: `de012e1` (branch `feature/narrated-draft-render`).
- **PR #4** remains the code-review PR. This branch only carries these output files.
- This branch may be deleted once the artifacts have been downloaded.

## Draft MP4
`draft-540x960.mp4` is labelled "Draft Preview — Not Final Quality":
- 540×960 (9:16), 30 fps constant, 2075 frames
- 69.167 seconds (the 69.146 s voice-over, padded to whole frames)
- H.264 High video + AAC-LC 48 kHz stereo audio
- 24,324,749 bytes

It is the one real render of the approved 14-phrase storyboard: comparison pattern, Zapp and Kira, seed 17, 26 schema 1.1 caption chunks. It passed 18/18 narrated draft quality gates, with −15.07 LUFS integrated loudness and an estimated −1.85 dBTP true peak.

## Files

| File | Bytes | SHA-256 |
|---|---:|---|
| draft-540x960.mp4 | 24,324,749 | `8c52721e493ddec1faaad6a7ad710782f414f3cbaf318d63909f410b5ef0a1f9` |
| contact-sheet.jpg | 227,730 | `add95bd6552a86a89751b44fefc049f71a65970003b6964dd29e5c759420eaf7` |
| approved-screen.png | 89,297 | `d456660c2be946b0cc7f7f8f3ce2c994611b17cc5d0104e3fff96bed3722587f` |
| complete-screen.png | 326,560 | `3bc424b536dba7286b03d5b3f1f36e341823694678969b8fc5fb8c254671e05b` |
| approved-narrated.json | 19,198 | `76a6b5f26af5f9e0f1bcf635677f8c9f7a79f16d9f1bfc48575f3e0be2985856` |
| render-timeline.json | 25,096 | `d0375278738466477b27861d4394bd42bc1169b4cfc4b4c6f8cf738247a3d15a` |
| render-manifest.json | 1,524 | `2ab4f0b4b858e11003f945a5830a63f471fa3f9679995d99dc8c82e6e3321349` |
| quality-report.json | 3,278 | `14648f714d3d3740962b6bad86018c5e6c70dc90bc37078260d414fa47995dbd` |
| validation-log.json | 2,360 | `4aad83b18629f9c498a82a5647b642fcea43fb93ab350a2f9d8bdac5fb291b35` |

The voice-over itself is not included; `approved-narrated.json` holds only its content hash.
