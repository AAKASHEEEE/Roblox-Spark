# Narrated Draft V3 — still-frame preview

**Temporary preview, do not merge.** This branch only adds this folder. It is not the Draft V3 render: no MP4, no audio, no video encode.

- Source: `fix/narrated-draft-v3-targeted` at `d94a0c0`, approved narrated storyboard, seed 17, 540×960.
- Analysis before drawing: 47/47 gates.
- Frames come from the existing render page (`__spark.load` → `loadNarrated` → `__spark.still(frame / 30)`, the same `drawAt` the encoder uses; renderer: WebKit WebGL, headless Chromium software GL).
- Captions are burned in with the renderer's own `FrameCapture.prototype.drawCaption` over the frame, as `FrameCapture.composite` does before encoding.
- Frame rule: frame = round(t × 30), drawn at t = frame / 30. `index.json` maps every frame to time, frame, shot, camera, screen direction and caption chunk.
- The contact sheet uses the repo's `contactSheet` helper (10 columns, time + shot ID under each cell), saved as JPEG (quality 0.9).

## Key frames

| t (s) | frame | shot | camera | screen direction |
|---|---:|---|---|---|
| 5.5 | 165 | s004 | `s004:three_quarter:a40:d5.40:h0.30` | consistent:left |
| 7.2 | 216 | s005 | `s005:profile:a10:d2.82:h-0.10` | consistent:left |
| 8.8 | 264 | s006 | `s006:profile:a24:d5.39:h0.30` | consistent:left |
| 14.7 | 441 | s009 | `s009:medium:a0:d4.94:h0.10` | consistent:left |
| 21.7 | 651 | s013 | `s013:medium:a0:d4.74:h0.10` | consistent:left |
| 42.7 | 1281 | s025a | `s025a:reaction_close:y40:d1.7` | consistent:left |
| 16.4 | 492 | s010 | `s010:two_shot:a-48:d5.43:h0.90` | consistent:left |
| 18.1 | 543 | s011 | `s011:reaction:a-43:d2.68:h0.10` | consistent:left |
| 20.0 | 600 | s012 | `s012:two_shot:a-45:d5.52:h0.90` | consistent:left |
| 25.0 | 750 | s015 | `s015:top_down_insert_long:p50:a270:d2.2:f12` | neutral_insert |
| 26.00 | 780 | s016a | `s016a:speaker_ots:s1:u0:o1.85:b0.6:medium0.26` | reset_after_neutral:right |
| 26.27 | 788 | s016a | `s016a:speaker_ots:s1:u0:o1.85:b0.6:medium0.26` | reset_after_neutral:right |
| 26.43 | 793 | s016a | `s016a:speaker_ots:s1:u0:o1.85:b0.6:medium0.26` | reset_after_neutral:right |
| 26.80 | 804 | s016a | `s016a:speaker_ots:s1:u0:o1.85:b0.6:medium0.26` | reset_after_neutral:right |
| 27.3 | 819 | s016b | `s016b:reaction_close:y-60:d2.1` | neutral |
| 28.7 | 861 | s017 | `s017:two_shot:a-17:d5.88:h0.15` | reset_after_neutral:left |
| 45.0 | 1350 | s026 | `s026:widesw_f62:a-20:d9.33:h2.20:f62` | consistent:left |
| 46.6 | 1398 | s027 | `s027:widesw_f52:a-12:d13.62:h2.22:f52` | consistent:left |
| 48.6 | 1458 | s028 | `s028:widesw_f62:a0:d11.01:h2.21:f62` | consistent:left |
| 50.6 | 1518 | s029 | `s029:scale_mid_f62:a35:d8.08:h0.81:f62` | consistent:left |
| 52.4 | 1572 | s030 | `s030:wide_f62:a20:d11.69:h2.20:f62` | consistent:left |
| 54.2 | 1626 | s031 | `s031:wide_f62:a20:d13.32:h2.20:f62` | consistent:left |
| 55.4 | 1662 | s032a | `s032a:wide_f62:a40:d7.36:h1.84:f62` | consistent:left |
| 55.933 | 1678 | s032b | `s032b:wide_f52:a30:d9.87:h2.90:f52` | consistent:left |
| 56.3 | 1689 | s032b | `s032b:wide_f52:a30:d9.87:h2.90:f52` | consistent:left |
| 57.5 | 1725 | s033 | `s033:frontal_medium:y60:d2.5` | consistent:left |
| 59.1 | 1773 | s034 | `s034:elevated_consequence:p24:a60:d7.60:f62` | consistent:left |
| 66.4 | 1992 | s038 | `s038:top_down_insert:p55:a0:d1.2` | neutral_insert |

## Visible problems noticed in this preview (not fixed here)

- s011 (17.2–19.1 s) and s035–s037 (59.9–65.3 s): Kira's face is largely covered by a black hair block. V2 showed her face in s036–s037. The face checks accepted these cameras, so the self-occlusion check appears to miss this hair part.
- s015 (24.1–25.9 s): the top-down button insert shows the button, but its FREE COINS label is not readable (seen edge-on at the bottom edge).
- s016b (26.9–27.8 s): Zapp's reaction is seen from behind his shoulder; only part of his face reads.

## Files

| File | Bytes |
|---|---:|
| `contact-sheet-1fps.jpg` | 867,259 |
| `index.json` | 40,993 |
| `t05.5s_s004_three_quarter-a40-d5.40-h0.30.png` | 277,973 |
| `t07.2s_s005_profile-a10-d2.82-h-0.10.png` | 315,772 |
| `t08.8s_s006_profile-a24-d5.39-h0.30.png` | 316,467 |
| `t14.7s_s009_medium-a0-d4.94-h0.10.png` | 265,893 |
| `t16.4s_s010_two_shot-a-48-d5.43-h0.90.png` | 274,529 |
| `t18.1s_s011_reaction-a-43-d2.68-h0.10.png` | 222,041 |
| `t20.0s_s012_two_shot-a-45-d5.52-h0.90.png` | 300,067 |
| `t21.7s_s013_medium-a0-d4.74-h0.10.png` | 296,256 |
| `t25.0s_s015_top_down_insert_long-p50-a270-d2.2-f12.png` | 189,715 |
| `t26.00s_s016a_speaker_ots-s1-u0-o1.85-b0.6-medium0.26.png` | 199,789 |
| `t26.27s_s016a_speaker_ots-s1-u0-o1.85-b0.6-medium0.26.png` | 189,532 |
| `t26.43s_s016a_speaker_ots-s1-u0-o1.85-b0.6-medium0.26.png` | 206,650 |
| `t26.80s_s016a_speaker_ots-s1-u0-o1.85-b0.6-medium0.26.png` | 202,542 |
| `t27.3s_s016b_reaction_close-y-60-d2.1.png` | 296,803 |
| `t28.7s_s017_two_shot-a-17-d5.88-h0.15.png` | 316,121 |
| `t42.7s_s025a_reaction_close-y40-d1.7.png` | 264,346 |
| `t45.0s_s026_widesw_f62-a-20-d9.33-h2.20-f62.png` | 274,032 |
| `t46.6s_s027_widesw_f52-a-12-d13.62-h2.22-f52.png` | 257,755 |
| `t48.6s_s028_widesw_f62-a0-d11.01-h2.21-f62.png` | 189,759 |
| `t50.6s_s029_scale_mid_f62-a35-d8.08-h0.81-f62.png` | 253,740 |
| `t52.4s_s030_wide_f62-a20-d11.69-h2.20-f62.png` | 271,083 |
| `t54.2s_s031_wide_f62-a20-d13.32-h2.20-f62.png` | 263,664 |
| `t55.4s_s032a_wide_f62-a40-d7.36-h1.84-f62.png` | 273,624 |
| `t55.933s_s032b_wide_f52-a30-d9.87-h2.90-f52.png` | 286,629 |
| `t56.3s_s032b_wide_f52-a30-d9.87-h2.90-f52.png` | 281,723 |
| `t57.5s_s033_frontal_medium-y60-d2.5.png` | 230,882 |
| `t59.1s_s034_elevated_consequence-p24-a60-d7.60-f62.png` | 252,756 |
| `t66.4s_s038_top_down_insert-p55-a0-d1.2.png` | 195,495 |
