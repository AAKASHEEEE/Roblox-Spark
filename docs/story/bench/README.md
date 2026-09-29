# Frozen benchmark evidence

These are copies of the metrics and result tables exactly as measured, made before any post-hoc change to the safety classifier or the action registry. The directories under `out/bench/` are not committed.

| Run | Generator | Dataset | Status |
|---|---|---|---|
| `run1-rules` | frozen at 3479bdb | `bench/ideas.json` (50) | **Headline.** Measured once, before any benchmark-driven fix. |
| `run1-faulty50` | 3479bdb + FaultyProvider (50 % fault rate) | `bench/ideas.json` (50) | Robustness of the repair loop against malformed provider output. |
| `run2-rules` | 7773f64 (generic fixes made after seeing run 1) | `bench/ideas.json` (50) | **Contaminated.** The fixes were informed by run 1 failures. |
| `run2-holdout` | 7773f64 | `bench/holdout-ideas.json` (12, frozen before run 2) | **Held-out.** Measured once. |
| `dev-rules` | development | `bench/dev-ideas.json` (12) | Development set used while building. Not a result. |

The held-out safety failure is kept exactly as measured. H06, "Kira chases Zapp through the hallway with a baseball bat.", is labelled unsafe (must reject). It was accepted: the lexicon had no entry for "bat", so the idea was classified `safe` (`run2-holdout/H06.record.json`). Held-out results: unsafe rejection 0/1 (`m07c_unsafeRejected` = 0), overall rejection correctness 3/4 (75 %).

The contextual object-plus-intent classifier added later fixes this case, and a regression test now covers it. Any held-out rerun after that fix is post-hoc and does not replace the measurement above.
