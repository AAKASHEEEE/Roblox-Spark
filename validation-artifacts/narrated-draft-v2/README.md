# Narrated Continuity Draft V2 (540×960 draft)

> [!WARNING]
> **This is a temporary artifact branch that exists only to make these files downloadable. Do not merge it, and do not base work on it; delete it after review.** It was created from `15a9489` and adds only this folder.

- **Source commit:** `15a9489` (`feature/narrated-continuity-integration`, Draft PR #8)
- **Status:** Draft preview only, **not final quality**. The technical gates pass; creative quality is **not** certified (see "Known visible problems" below).
- Rendered once at 540×960 in headless Chromium (software GL) on 8 vCPU: 457 s wall time. The storyboard is the approved narrated storyboard (schema 1.1), seed 17. The voice-over's SHA-256 matched the approved hash `d97fd865…e4f2`; the voice-over itself is **not** in this branch.

## Files

| File | Bytes | SHA-256 |
|---|---:|---|
| `draft-v2-540x960.mp4` | 17,562,965 | `a422875de5a7b25cdcc5ceb4b0448fd49d170c98820cade8cca98b9a2d488fad` |
| `contact-sheet-1fps.jpg` | 674,356 | `29e0d29187c585ea5b1e98e8695d3dac4c67d2dcb8e7d7fcf847c1b84d92cf21` |
| `opening-0-20s.jpg` | 704,748 | `f962ecc99b8956354a8647c6f9b86f86ae7bc189762806b4b33ea20216106809` |
| `growth-38-55s.jpg` | 710,671 | `5c3882cb149a746685538c47df539010efdd93a8c96395e5fe48ebc72dc68274` |
| `impact-52-62s.jpg` | 762,202 | `454433a0e41541b268966268e53f6f86e621174f815249c240a954db150b855d` |
| `ending-59-69s.jpg` | 391,473 | `b15e5188c0cefe72f2ff43c5ac9047d1e8d1fda9a1eb62aa4d095358c0834a11` |
| `complete-screen.png` | 372,142 | `346a27273770a616c5037b2c40cbc91e08d4a232f9129275634b8e140ce59f26` |
| `approved-narrated.json` | 30,442 | `fabc45ecdc1171999484864b7e94b53c92cfff106e0f8771cbbbaf261c2a52bb` |
| `render-timeline.json` | 154,879 | `1bd3080920b9306018f7d876d45a8270de96c8ed3ada7863d5ca8b6ed83ad20a` |
| `camera-plan.json` | 97,471 | `f9498c870c8f6b4974dc9cbefd90d9c8dc62b3143bc1b2d2007f57b54805ea3e` |
| `render-manifest.json` | 1,608 | `7edb1cf4eb924f746324027052387c37b304a45ad935d98654a0ecc1d54986f8` |
| `quality-report.json` | 25,022 | `8b93584ce84931646afa27fafeab7ad522a541bf8d06d80994511f6ae328771f` |
| `analysis-report.json` | 18,229 | `a7c1cffc36df0b57edf174f7cd6ed5458f2fd97c617ae4bab84a3d6d8d7c31bf` |

## MP4 metadata

- **Container:** MP4 (isom), 69.167 s, starts at 0.
- **Video:** H.264 High, yuv420p, 540×960 (DAR 9:16), constant 30 fps, 2075 frames. Every packet lasts 1/30 s and the first pts is 0.
- **Audio:** AAC-LC, 48 kHz stereo. The first decoded sample is at 0 (priming samples are trimmed by the edit list).
- **Loudness:** −15.1 LUFS integrated, −1.8 dBTP true peak (FFmpeg `ebur128` on the MP4 itself).
- **Mix:** voice-over first, original SFX ducked by 10 dB, no music.

## Validation summary

- Render job gates **64/64**: the narrated technical gates N01–N18 plus the 47 continuity/camera/caption/semantic gates.
- Analysis-only confirmation **47/47**. All 2075/2075 frames are assigned and evaluated, 0 shots are blocked, and there are 0 lens or camera-path collisions, 0 unresolved caption conflicts, 0 dropped required actors and 0 unmotivated screen-direction reversals.
- Captions: 26/26 chunks are placed and burned with exactly the planned text and timing.
- Independent post-render checks **66/66**: FFmpeg decode, packet timing, loudness and hash, plus Chromium decode.
- World: one coin/Zapp contact at 55.933 s, with the fall starting on the same frame. Coin/Zapp clearance is ≥ 0.0211 m, coin base drift is 0 m, Kira stays outside the hazard, Zapp stays prone to the end, and the reset does not stand him up.

## Known visible problems (from inspecting the contact sheets)

- **major**, 25.94-26.89 s (s016a, Kira warning): Kira's face is mostly hidden by her own black side-hair block; the warning expression does not read. The speaker-OTS camera passed because the camera evaluator counts an actor's own head parts (incl. side hair) as never occluding her face.
- **moderate**, 15.68-20.96 s (s010-s012, Kira mediums) and 44.22-45.80 s (s026): Zapp's head/body is cut at the left frame edge. He is an optional supporting actor there, and optional actors are not crop-checked in single-character coverage.
- **major**, 44.22-49.50 s (p10: "taller than the desk, wider than Zapp, almost fills the entire room"): The coin is mostly off screen while the narration describes its size: s026 shows Zapp and Kira without the coin, s027 shows it only partly at the left edge, s028 shows Kira alone.
- **moderate**, 51.47-54.70 s (p11-c02: "Kira has already moved safely out of the way"): The picture stays on Zapp; Kira is not shown during the line about her.
- **minor**, 55.13-56.70 s (s032, impact): The tip and flattening read, but the action is small in a distant wide shot (upper-middle third of the frame).
- **moderate**, 56.70-59.80 s (s033-s034): During "flattens Zapp against the classroom floor" the camera shows Kira walking; the flattened Zapp is off screen apart from the coin edge at the bottom.
- **minor**, 40.24-40.77 s (s024g1): The narration says the button flashes, but the insert shows only the small coin.
- **minor**, 41.0-42.2 s (s024g2) vs 43.1-44.2 s (s025b): Near-identical coin framings about one second apart.
- **minor**, 42.23-43.10 s (s025a): Zapp's reaction is shot from above; his face is foreshortened and the shock only partly reads.
- **minor**, 61.42-65.30 s (s036-s037): A 3.9 s near-static very tight close on Kira (head fills the frame width).
- **minor**, 65.30-67.57 s (s038): The lower-band caption covers the "FREE COINS" label on the button base.
- **info**, whole episode: Draft only: no lip-sync, software-GL shading at 540x960, blocky placeholder faces.
