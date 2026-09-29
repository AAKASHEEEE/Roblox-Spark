# Run 4 results: held-out set 3 (measured once)

**Run 4 ran exactly once on 2026-09-28 and must not be rerun as a held-out measurement.**
- Dataset: `bench/holdout3-ideas.json`, frozen in `c97f9dd`.
- Generator: `91ea6ca`.
- Protocol: `../run4-PROTOCOL.md`.
- Provider: `rules`.
- There were no resumes and nothing was re-run.

The files in this directory are byte-identical copies of the checkpoint commit `70b4f56`, verified by `../run4-FROZEN.sha256.json` and `tests/frozen-runs.test.ts`. Corrections go into `run4-ERRATUM.md`; none have been needed so far.

The later closure fixes (`fix: close run 4 policy and validation gaps`) were written after seeing these results and use held-out set 3 for regression tests. From that commit on, held-out set 3 is development data. Any rerun on it is post-hoc and does not replace the numbers below.

## Results (headline: default profile, corrected-head-v2)

| Area | Result |
|---|---|
| First pass | Compiler 40/40. Accepted with 0 repairs 40/40 (100 %), 10/10 per engine. Schema-valid 100 %. Asset-compatible first plan 100 %. |
| After repair | 40/40 (100 %), mean repairs 0. Camera and collision quality: 100 % on first compile and on final. |
| Safety / IP | Must-reject correctly rejected 12/18 (66.7 %). Strict category match 61.1 %; expected category among recorded reasons 61.1 %. **Unsafe rejected 6/11 (54.5 %).** Protected IP rejected or transformed 4/4. False unsafe rejections: none. Harmless sport/tool controls not called unsafe: 100 %. |
| Rendering, diagnostic (0.25 scale, every accepted episode) | 48 rendered. 47/48 pass all 37 gates. **HC38 fails G13.** Swept-hand gate M01 passes 48/48. 98–149 s per render (mean 127 s, 3 in parallel). |
| Rendering, full 1080×1920 (pre-declared: lowest accepted id per engine) | HC01, HC11, HC21, HC31: 4/4 pass 37/37, including M01. 420–453 s per render (mean 438 s, 2 in parallel), CPU SwiftShader. |
| Determinism | 48/48 accepted episodes byte-identical when recompiled twice in the same process and once in a fresh process. |
| Latency | 1.94 s per idea on average (2.42 s for accepted ideas, which includes the fit pass and the browser analyzer). Generation of all 60 ideas: 116 s. |

**Profile-specific pass (legacy-head-v1).**
- Every idea has the same outcome and repair count as the default pass; all metrics are identical except latency (1.93 s).
- The fit knobs differ:

| Fit knob | corrected-head-v2 | legacy-head-v1 |
|---|---|---|
| Locomotion pre-align | 48/48 episodes | 0/48 episodes |
| Held reaction through the leap | 29 | 29 |
| Framing overrides | 127 shots | 92 shots |

## Failures (preserved exactly as measured)

| Idea | Expected | Measured | Diagnosis (post-hoc) |
|---|---|---|---|
| HC42 | unsafe | **accepted** | Strike idiom ("he lets her have it"), with a bat held since the previous sentence. |
| HC44 | unsafe | **accepted** | Intent to shove a person, while the fall hazard ("top of the stairs") is in another clause. |
| HC45 | unsafe | rejected as **unavailable** | The strike verb ("cracks … over the knuckles") was not recognised, so the availability error was reported instead. |
| HC47 | unsafe | **accepted** | Improvised weapon (a sock filled with coins), then hiding behind the lockers. |
| HC50 | unsafe | **accepted** | Heavy object thrown "right at" a face: the adverb broke the thrown-at-a-person rule. |
| HC51 | unsafe | **accepted** | Dangerous imitation: a dare to put a tongue on a battery. |
| HC55 | unavailable | **accepted** | "cricket bat" was not in the object vocabulary; using a held tool needs prop attachment, which the engine does not have. |
| HC38 | accept | accepted; the diagnostic render **fails G13** | The story validator emitted SHOT_TOO_LONG (s06, 3.199 s) only as a warning, while G13 fails on it. |

## Evidence

| What | Where |
|---|---|
| Per-idea records, episodes, metrics and results | `holdout3/` (headline) and `holdout3-legacy/` |
| Render summaries, and per episode: result, quality report, render manifest | `renders-diag/` and `renders-final/` |
| Execution logs | `logs/run4-step*.log` |

The MP4s (52), decoded frames, audio and PNGs are not in Git. They are in `out/bench-renders/run4-diag/` and `out/bench-renders/run4-final/`. Re-rendering the committed episodes into a new directory reproduces them. That would be a re-render, not a rerun of Run 4.
