# Run 4 protocol (pre-registered, committed before execution)

## Dataset

`bench/holdout3-ideas.json` has 60 ideas:

| Group | Count | Breakdown |
|---|---|---|
| Compatible | 40 | 10 per engine |
| Must-reject | 18 | 11 unsafe, 2 protected IP, 3 unavailable, 1 impossible, 1 requires text |
| IP-transformable | 2 | protected brand used only as a style reference |

**Probes.** Each idea carries `probes` tags:
- unsafe probes: adversarial paraphrases, implied targets, split-sentence intent, pronouns, concealment, weapon plus ambush;
- harmless controls: sport contexts, ordinary tool use, benign strike, wait/hide and pursuit verbs.

Two of the three unavailable ideas are sport/tool controls. They must be rejected for the unregistered prop, **not** as unsafe.

**Freshness.** No idea was run through the generator or the safety analysis before this commit. Against 698 sentences from every existing dataset, test and safety probe, the maximum token Jaccard similarity is 0.44.

**Labels.** Labels follow the documented policy (registry, substitution classes, safety rules), not predictions of the implementation.

**Author bias.** The author of the dataset also wrote the generator and the safety rules. The set is independent of all tuning data, but not of the author.

## Under test

- Generator at `91ea6ca`: re-tuned corrected-head-v2 fit pass and contextual intent safety.
- This commit adds harness code only:
  - `bench-generate`: `--resume`, metrics `m07g` and `m07h`;
  - `bench-render`: `--select first-per-engine`, `--resume`, `--limit`.
- Nothing in the generator, fit pass, safety, lexicon, registry or assets changes until execution ends.
- Provider: `rules` (offline, deterministic). No LLM endpoint is available.

## Execution (each step exactly once)

1. **Headline pass, default profile.** New episodes declare corrected-head-v2; the browser analyzer is on.
   `node scripts/bench-generate.ts --set bench/holdout3-ideas.json --provider rules --out out/bench/run4-holdout3`
2. **Profile-specific pass.** Diagnostic, never the headline.
   `node scripts/bench-generate.ts --set bench/holdout3-ideas.json --provider rules --motion-profile legacy-head-v1 --out out/bench/run4-holdout3-legacy`
3. **Diagnostic renders.** Every accepted episode of step 1, at scale 0.25:
   `node scripts/bench-render.ts --run out/bench/run4-holdout3 --scale 0.25 --out out/bench-renders/run4-diag --resume --limit 12`
   Repeated until the summary says `complete`. Batches are needed because one tool call is limited to 30 min.
4. **Full renders, 1080×1920.** The selection rule is declared here: for each dataset engine, the accepted step-1 episode with the lowest idea id (at most 4 renders).
   `node scripts/bench-render.ts --run out/bench/run4-holdout3 --scale 1 --select first-per-engine --out out/bench-renders/run4-final --resume --limit 2`
   Repeated until complete.

**Interruptions and re-runs.**
- An interrupted step resumes with `--resume`: existing records and results are loaded, never regenerated.
- Every resume is logged (`resume-log.jsonl`) and reported.
- No completed idea or render is re-run for any reason, including a surprising result.

## Reported separately (`docs/story/bench/run4-holdout3/REPORT.md`)

| Section | Metrics |
|---|---|
| First pass | `m03`; `m04` (compatible and accepted with 0 repairs); per engine |
| Repaired | `m05` (accepted after ≤ 3 repairs); `m06`; per engine; the repair constraint codes |
| Safety / IP | `m07`; `m07b` (strict primary category); `m07f` (expected category among the recorded reasons); `m07c` (unsafe rejected); `m07d` (IP rejected or transformed); `m07g` (false unsafe rejections); `m07h` (harmless controls not rejected as unsafe); a per-idea table of every must-reject and control idea |
| Rendering | diagnostic renders (gates per episode, including M01); full renders (all gates, production profile) |
| Profile-specific | step 1 vs step 2 for every metric; per-idea status changes |
| Determinism | `m16`: same process twice, plus a fresh process |

**Failures and labels.**
- Failures are reported as measured. Nothing is excluded or relabelled.
- A label found to be wrong later goes into an erratum, and the metric is still computed with the frozen label.
- The recommendation stays **MODIFY** unless this evidence supports a different conclusion.

## Freezing

Outputs are copied to `docs/story/bench/run4-holdout3/`:
- records and episodes of both passes;
- metrics and results;
- render summaries and per-episode quality reports.

A sha256 manifest, `docs/story/bench/run4-FROZEN.sha256.json`, covers them. `tests/frozen-runs.test.ts` verifies it.

## Limits of interpretation

- Rules provider only.
- The dataset author is the generator's author.
- One environment and two built characters.
- CPU rendering (SwiftShader).
