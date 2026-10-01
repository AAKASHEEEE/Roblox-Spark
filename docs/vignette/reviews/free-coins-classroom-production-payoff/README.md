# Free-coins classroom production-payoff review

This review covers the camera-only repair to `packages/director/fixtures/free-coins-classroom.beats.json` on `fix/production-payoff`, based on `9b5e6c736ca1483b7486ea197e8c0a344ba0fb8c`. Narration text, phrase timing, voice, events, schema, pipeline code, and thresholds were not changed. No MP4 was rendered.

## Result

- **No-render stage:** PASS, 96.5% coverage, 14/14 beat cameras accepted, zero blocked cameras, zero staging errors or warnings.
- **All-composition audit:** 41/41 compositions accepted, 38 authored recipe choices and three safe pre-existing fallbacks in unchanged beats (`p02c3`, `p03c2`, `p08c2`), zero blocked compositions. See [`composition-camera-audit.json`](composition-camera-audit.json).
- **Cadence:** 41 compositions at a 1.575 s average, inside the requested 1.2–2.2 s average target. Individual composition lengths range from 0.73 s to 2.95 s.
- **Review imagery:** every composition has a 540×960 midpoint still under [`composition-stills/`](composition-stills/). The complete sheet is [`composition-contact-sheet.jpg`](composition-contact-sheet.jpg) at 1751×1794. Exact narrative checks are under [`key-stills/`](key-stills/) and summarized in [`key-narrative-contact-sheet.jpg`](key-narrative-contact-sheet.jpg) at 1778×1403. Every image dimension is at most 1800 px.

The stills were generated through the existing composition-aware `vignette-full-page` preview adapter with the solved `runVignette().compositions` timeline. This is still-only review; no video encoder or muxer was invoked.

## Narrative inspection

| Requirement | Inspected evidence | Finding |
|---|---|---|
| Hook: teacher leaves through door with leads present | [`3.00 s`](key-stills/01-teacher-exit-leads-t03.00.png) | Teacher, open doorway, Zapp, and Kira are simultaneously readable. |
| Unobstructed button reveal | [`23.20 s`](key-stills/02-clean-button-reveal-t23.20.png) | Button face, red press surface, indicator lights, and FREE COINS label are unobstructed; Zapp remains only at the right edge. |
| Button contact | [`32.25 s`](key-stills/03-button-contact-t32.25.png) | Zapp's hand approaches the press surface without covering the button identity or label. |
| Coin spawn and readability | [`32.80 s`](key-stills/04-coin-spawn-t32.80.png), [`33.20 s`](key-stills/05-coin-spawn-hold-t33.20.png), [`33.80 s`](key-stills/06-coin-insert-t33.80.png) | Pop/contact is visible on the button with sparkle evidence, then the coin receives a clean isolated insert. |
| Growth with scale references | [`45.00 s desk`](key-stills/08-desk-scale-t45.00.png), [`46.80 s Zapp`](key-stills/09-zapp-scale-t46.80.png), [`48.80 s room`](key-stills/10-room-scale-t48.80.png) | Coin stays visible with desk, Zapp, and room geography during their matching words. |
| Tip, exact impact, and flattened Zapp | [`56.30 s tip`](key-stills/11-coin-tip-t56.30.png), [`56.936 s impact`](key-stills/12-exact-impact-t56.94.png), [`57.20 s`](key-stills/13-flatten-line-early-t57.20.png), [`57.50 s`](key-stills/14-flatten-line-late-t57.50.png) | One continuous action composition shows the coin rotate into Zapp and Zapp prone beneath it throughout “FLATTENS Zapp.” The Kira reaction cut begins only at 58.01 s, after that caption window ends. |
| Floor consequence | [`58.30 s reaction`](key-stills/15-kira-post-flatten-reaction-t58.30.png), [`58.90 s floor`](key-stills/16-floor-consequence-t58.90.png) | Brief Kira reaction follows the flatten line, then the camera returns to coin/Zapp for “classroom floor.” |
| Teacher return and Kira reaction | [`60.80 s`](key-stills/17-teacher-return-t60.80.png), [`62.40 s`](key-stills/18-teacher-kira-return-t62.40.png), [`63.80 s`](key-stills/19-kira-still-reaction-t63.80.png) | Doorway return is established with both characters, followed by Kira's stillness reaction close-up. |
| Reset readability | [`67.20 s`](key-stills/20-reset-insert-t67.20.png), [`68.50 s`](key-stills/21-reset-final-t68.50.png) | Reset wording remains on a clear button insert and finishes on a tighter button ECU. |

## Commands and checks

```text
node scripts/vignette-stage.ts --sheet packages/director/fixtures/free-coins-classroom.beats.json --out out/vignette/free_coins_classroom-production-payoff-no-render-final --no-stills
# PASS — coverage 96.5%; 14 recipe / 0 fallback / 0 blocked beat cameras; 0 staging errors/warnings

node --test tests/free-coins-classroom-narrative.test.ts tests/vignette-runtime-integration.test.ts
# PASS — 10/10 tests

node_modules/.bin/tsc -p tsconfig.web.json --noEmit
# PASS
```

The fixture-specific tests lock the approved narration words and phrase boundaries, semantic camera subjects at the key windows above, the complete half-open `FLATTENS Zapp` window against any Kira cut, the 41-composition count, and average cadence.

## Remaining visible limitations

- The p12 action stays wide enough to preserve tip-to-contact continuity and classroom geography. After impact, the coin physically occludes much of Zapp's torso; his orange head and flattened blue limbs remain visible beneath it. This reads as the intended flattening, but it is not a clean facial close-up.
- The three p10 scale comparisons deliberately hold a similar screen axis for continuity and safety. Desk/Zapp/room references are readable, but the sequence favors clarity over dramatic angle variety.
- Kira's p13 reaction is intentionally a calm, seated stillness close-up rather than a large motion, matching “sitting perfectly still.”
- The giant coin remains at the lower foreground edge of the p14 reset insert. It does not cover the button, but the frame retains consequence context rather than becoming a product-only shot.
