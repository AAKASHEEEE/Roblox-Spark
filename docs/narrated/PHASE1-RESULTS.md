# Narrated Story — Phase 1 results

Scope: **script + uploaded voice-over → phrase alignment → phrase-level captions → constrained narrated storyboard → JSON download.** No narrated rendering. Visual Comedy is unchanged.

## Implemented
- `packages/narrated/src/`:
  - **`schema.ts`**:
    - Versioned strict schema (`schemaVersion` "1.0", `mode` "narrated_story").
    - Semantic validator that rejects:
      - forbidden keys (`__proto__`, `prototype`, `constructor`) and unknown keys;
      - characters, actions and faces outside the registry or not allowed for that character;
      - cameras and environments outside the registry;
      - negative, reversed or overlapping phrase ranges;
      - timelines outside the audio;
      - empty captions.
  - **`audio.ts`**:
    - Safe-filename policy.
    - Magic-byte container sniffing (executables, scripts and archives are rejected).
    - Extension ↔ content match and a per-container codec allow-list.
    - Native RIFF/WAVE decoder.
    - Duration, sample-rate and channel limits.
  - **`align.ts`**:
    - The `NarrationAligner` interface (the seam for future aligners).
    - `SilenceGuidedAligner` (see below).
  - **`captions.ts`**:
    - Up to 2 lines of up to 32 characters each.
    - Balanced break with an orphan penalty; names kept together; punctuation preserved.
    - Up to 2 emphasis words, stored separately.
    - Words per second, with warnings above 3.6 wps and for captions visible less than 0.6 s.
    - Lower-middle placement at 72 % of the height, above the bottom 16 % UI area.
  - **`pipeline.ts`**:
    - Server-side request schema.
    - Script parsing: one phrase per line; blank lines start new sections.
    - Safety via the existing `scanIdea` (terms and contextual intent) plus `findBannedTerms`.
    - Precedence: invalid input > unsafe > protected IP > unavailable > story incompatibility > timeline incompatibility.
    - Rules-based beat planner: one beat per phrase, using the capability registry only.
- **Studio**:
  - `apps/studio/narrated-api.ts`: upload, audio lookup, generate, fetch and download endpoints. It is mounted in `server.ts` under `/api/narrated/`.
  - `apps/studio/src/narrated.ts`: the three screens (Input → Alignment review → Storyboard).
  - A mode selector in `index.html`.

### Beat planner rules
- **Story purpose** comes from the pattern, the line's position and cue words:
  - a turn is detected by openers like "But…", "Suddenly…", "One day…";
  - escalation by words like "worst", "even", "again", "forever".
- **Actions**: narration verbs map to registered actions (e.g. *miss* → `regret_freeze`, *laugh* → `laugh`).
- **Unbuilt content** becomes a declared substitution with a reason:
  - driving → `run`;
  - flying → `jump`;
  - eating or holding objects → `look_at` or `point`, because hand attachment does not exist;
  - places other than the classroom are staged in the classroom.
- **Faces** come from `EMOTION_FACE`, which maps emotions to each character's locked expressions.
- **Cameras** come from per-purpose candidate presets. The pick is seeded, and the same preset never appears twice in a row.

## Alignment approach
1. The audio is decoded to mono and split into 20 ms RMS frames (dB).
2. The noise floor is the 10th percentile and the speech level the 95th. With less than 12 dB of contrast there are no usable pauses.
3. The speech threshold is floor + 30 % of the contrast. Gaps under 150 ms are closed, and regions under 80 ms are dropped.
4. A monotone dynamic-programming pass maps phrases to regions. Its cost is the squared log ratio of a region's duration to the phrase's word-count share of the speech span, plus penalties for merges and splits:
   - one region per phrase: `silence-guided`;
   - several regions for one phrase: `merged-regions`;
   - one region shared by several phrases, split by word count: `split-region`.
5. With no contrast, the whole file is divided by word count: `word-proportional`.
6. Clean-up: each caption is held 120 ms past its speech, but never into the next phrase and never past the end of the file. Times are rounded to milliseconds, and overlaps are removed.

Confidence scores:

| Method | Per-phrase confidence |
|---|---|
| silence-guided | 0.6–0.95 (how well duration matches word share) |
| merged-regions | 0.5–0.7 |
| split-region | 0.35–0.45 |
| word-proportional | 0.25 |

The project level is:
- **high** when every phrase is silence-guided and the mean confidence is at least 0.8;
- **low** when more than half the phrases are estimated or the mean is below 0.55;
- **medium** otherwise.

Alignment ignores the seed; the seed changes only the visual choices.

## Tested
`tests/narrated.test.ts` has 8 focused tests, using in-memory tone/silence WAV fixtures:
1. Ordered timings.
2. Byte-identical JSON for the same inputs and seed.
3. No overlaps in the 1:1, merged, split and no-pause cases.
4. Ranges inside the audio, even when speech reaches the last sample.
5. A low-confidence warning.
6. Unsafe content rejected first, then protected IP, then unavailable. Unknown keys and `__proto__` are also rejected.
7. Unknown characters, actions, expressions, cameras and environments are rejected, as are overlaps, out-of-range times and empty captions.
8. The Studio HTTP API:
   - Visual Comedy options and generation still work;
   - uploads with traversal names, `.exe`, executable content or empty files are rejected;
   - a valid upload, generation and download work.

Results:

| Run | Result |
|---|---|
| Focused tests | 8/8 pass |
| Existing fast tests (`studio-workflow`, `story-stages`, `security`, `schema`, `registry`) | 23/23 pass |
| All fast tests except render/integration and bench smoke | 131: 130 pass, 1 skipped, 0 fail |
| `npm run typecheck` | Clean |
| Manual HTTP smoke on a 43.9 s voice-over, uploaded as WAV, MP3 and M4A | WAV, MP3 and M4A accepted (FFmpeg 7.0.2 static build given via `FFMPEG_PATH`; a temporary copy outside the repo, never committed or referenced by code); MP3-named-`.wav`, fake executable, traversal name and shell-metacharacter name rejected; 14-phrase script aligned at **high** confidence (0.904) |

## Known limitations
- Phrase-level timing only; there is no word timing and no lip-sync.
- Speech over a continuous music bed, like all three references, usually falls back to low-confidence word-count timing. The UI says so honestly, but it cannot fix it.
- The planner uses rules and keywords. It demonstrates narration with the 23 story-usable actions of two characters in one classroom, so many scripts produce substitution warnings.
- There is no manual timestamp editing and one caption preset. MP3/M4A need FFmpeg.
- The browser UI has had an **automated** headless smoke test (see below) but no manual review by a person.
- Best results need a **dry voice-over**: voice only, with short pauses between script lines.

## Reproducibility checkpoint
- **FFmpeg** (MP3/M4A only) is resolved explicitly by `ffmpegStatus()` in `apps/studio/narrated-api.ts`, using the same convention as the existing `FFPROBE_PATH`:
  - `FFMPEG_PATH`, which must be an absolute path to a runnable FFmpeg (no silent fallback);
  - otherwise `ffmpeg` on `PATH`.
- It is never installed or bundled. Without it, the UI shows *WAV only* with setup steps, and MP3/M4A uploads get HTTP 422 `DECODER_UNAVAILABLE` with the same text. WAV needs no FFmpeg.
- **UI smoke test**: 16/16 checks in the preinstalled Chrome for Testing 151 (`/opt/playwright`, found by the project's `findChromium()`), via `launchBrowser()`. It covered:
  - mode switch; the WAV-only notice and MP3 setup error;
  - WAV upload, alignment review (HIGH), storyboard (6 cards, render notice, no Render button) and JSON download;
  - refresh after the stored audio was removed: storyboard restored, re-upload message shown, a different file refused, the same file accepted;
  - Visual Comedy still shown, and no page errors.
- It found one bug, now fixed: the Visual Comedy step bar stayed visible in Narrated Story mode, because `#steps{display:flex}` overrode `hidden`. `index.html` now has `[hidden]{display:none !important}`.
- **Dry voice-over check**: a 66.4 s dry TTS voice-over supplied for this checkpoint (MP3, 44.1 kHz mono; not committed) decoded through the committed path. It showed 17 speech regions, 41 dB contrast and pauses of 0.20–0.44 s: clean phrase boundaries for 1:1 alignment. It is longer than the 35–60 s target, which only warns.

## Real-validation fixes (schema 1.1)
The first real run (14 sentence-length lines, ElevenLabs MP3 `e;leven 1.mp3`) found these problems, now fixed. Each has a regression test in `tests/narrated-regressions.test.ts`:
- **A:** 12 of 14 lines were rejected for caption width. Each line now stays one beat, and its caption becomes timed **chunks**, which:
  - have at most 2 lines of 32 characters;
  - are chosen by a dynamic-programming pass that prefers the fewest chunks, punctuation breaks, no orphan words and unsplit names;
  - keep every word, in order;
  - are timed by word count, contiguous from `phrase.start` to `phrase.end`.
  
  Too little time gives `READING_SPEED_HIGH`, not a rejection.
- **B:** a `;` in the filename was rejected. Display names are now sanitized (`e_leven 1.mp3`); paths, `..`, and control or bidi characters are still rejected.
- **C:** the rejection listed only the first 8 lines. It now lists every line, or the first N and "and N more".
- **D1–D3:** `semantics.ts` replaces blank-line alternation and first-keyword verbs:
  - actors come from subject, pronoun, object and story subject, in that order;
  - actions come from verb and object;
  - prop events come from props as subjects (`propEvents`, `cause`, `actorRole`);
  - unavailable people stay off-screen with a warning, or block when they must act visibly.

## Phase 2 requires
- A narrated episode compiler that turns a storyboard into an `Episode` (shots 1–2 s, actions timed to phrases). It must support 35–60 s, but the current schema allows only 14–22 s and 30 beats, so a schema version bump is needed.
- Caption burn-in in the capture compositor, which can extend the existing debug overlay path. The uploaded voice-over must be muxed as the main audio track under a lowered music bed.
- More environments and actions, or reusable sets, to reduce substitutions. Optionally, a forced aligner (WhisperX or Montreal Forced Aligner) behind the `NarrationAligner` interface.
- Manual timing correction and an approval step, as in Visual Comedy.
