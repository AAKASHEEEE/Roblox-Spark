# Narrated shorts — reference grammar

These notes cover three third-party narrated block-game shorts. They were studied for under 10 minutes using only FFmpeg (`-i` metadata, the `scene>0.25` cut filter, `silencedetect` and 1/2 fps contact sheets). The videos were stored temporarily outside the repository and deleted afterwards. No scripts, dialogue, characters, maps, music, branding or shot orders are reproduced here. Only transferable structure is recorded.

## Measurements

| | A (hypothetical → consequence) | B (hypothetical, benefit → loss) | C (comparison, two archetypes) |
|---|---|---|---|
| Duration | 50.2 s | 40.2 s | 56.6 s |
| Video | 1080×1920, 60 fps | 1080×1920, 60 fps | 480×854, 30 fps |
| Audio | AAC 44.1 kHz stereo | AAC 44.1 kHz stereo | AAC 44.1 kHz stereo |
| Detected hard cuts | 28 (1 per 1.8 s) | 15 (1 per 2.7 s)¹ | 44 (1 per 1.3 s) |
| Silences ≥ 250 ms at −35 dB | 0 | 0 | 0 |

¹ Undercount. The contact sheet shows a new composition about every 2 s; cuts between shots of similar colour fall below the detector threshold.

## Transferable principles

- **The visuals change every 1–2 s.** Each change is a cut, a new framing, or a new action or face. Nothing stays static for more than about 3 s.
- **Narration runs continuously under a music bed.** No true silence was detected, so an aligner cannot rely on silence detection alone. Phrase-level timing must fall back to word-count distribution. Confidence must be reported honestly (see `PHASE1-RESULTS.md`).
- **Captions are burned in at phrase level.**
  - One line of 2–5 words at a time, in heavy white type with a dark outline.
  - Placed lower-middle, at about 72–78 % of frame height, well above the bottom UI zone.
  - Occasionally one emphasis word is in a contrasting colour.
  - Our captions are stored per phrase with up to two lines. A future renderer can show them in smaller chunks within each phrase's time range.
- **Each shot illustrates its narration.** The visible action shows the current phrase: "wakes up" shows waking, "no exams" shows a rejected exam, "they slam the door" shows a door slam. The illustration is literal and immediate, with no lag.
- **Close and medium shots dominate.** Faces fill the frame for reactions. Low angles and over-the-shoulder shots are used for confrontations. Wide shots appear only to establish a new place. Gestures are broad and readable.
- **Reactions come on the turn.** A facial change (smug → shock, happy → sad) lands on the phrase that reverses the situation, usually within the first second of that phrase.
- **Environments change by story section, not every shot.** Each video uses 3–8 settings, and a new section ("then…", "but one day…") often brings a new place or lighting mood.
- **Three story structures appear:**
  1. **Hypothetical:** "imagine if" → apparent benefits (a list of 3–5 quick beats) → turn → cost → "the worst part" → close.
  2. **Escalating consequence:** premise → reveal → stepwise escalation (each beat bigger) → aftermath → close.
  3. **Comparison:** alternating archetype A / archetype B beats on the same prompt, ending with the smart archetype's payoff.
- **Precise lip-sync is secondary.** Caption timing, gesture timing and cut timing carry the video.

## Implications for Phase 1

- One phrase maps to one beat, and each beat needs a distinct camera preset or action from its neighbours.
- A beat may have several caption lines. Longer phrases should warn about reading speed.
- Story patterns map to purpose sequences (setup → benefits → turn → consequence → close).
- Alignment must work without silences. Silence-guided alignment is only the better case.
