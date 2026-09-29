# Benchmark results — provider `rules`

Dataset `bench/dev-ideas.json` (12 ideas). Analyzer: on.

```json
{
  "run": {
    "provider": "rules",
    "model": "rules-v1 (deterministic keyword slot-filler, not an LLM)",
    "dataset": "bench/dev-ideas.json",
    "ideas": 12,
    "compatible": 0,
    "mustReject": 0,
    "ipTransformable": 0,
    "analyzer": true,
    "date": "2026-09-27T13:25:16.058Z"
  },
  "m01_schemaValidResponseRate": 100,
  "m01b_finalSchemaValidOrExplicitRejection": 100,
  "m02_assetCompatibleFirstPlanRate": 100,
  "m03_firstPassCompilerSuccess_compatible": 0,
  "m04_firstPassValidatorAcceptance_compatible": 0,
  "m05_acceptanceAfterRepair_compatible": 0,
  "m06_avgRepairs_compatible": 0,
  "m06b_avgRepairs_accepted": 0.25,
  "m07_rejectionCorrectness_mustReject": 0,
  "m07b_rejectionCategoryMatch": 0,
  "m07c_unsafeRejected": 0,
  "m07d_protectedIpRejectedOrTransformed": 0,
  "m07e_falseRejections_compatible": [],
  "m08_avgLatencyMs_all": 417,
  "m08b_avgLatencyMs_accepted": 626,
  "m09_cost": {
    "modelTokensIn": 0,
    "modelTokensOut": 0,
    "modelCostUsd": 0,
    "computeCostUsdPerIdea_at_0_35_per_hour": 0.000041,
    "estimatedLlmPromptTokensPerIdea": {
      "normalize": 1038,
      "plan": 2160,
      "note": "estimated from the real prompts (chars/4); output ~1.5-4k tokens per plan; repairs add ~1 plan-sized prompt each"
    }
  },
  "m10_causeResultCompleteness": 100,
  "m11_reversalPlacementCompliance": 100,
  "m12_loopCompliance": 100,
  "m13_mutedStoryHeuristicScore_mean": 98,
  "m14_cameraQualityPass_firstCompiled": 0,
  "m14b_cameraQualityPass_final": 0,
  "m15_collisionQualityPass_firstCompiled": 0,
  "m15b_collisionQualityPass_final": 0,
  "m16_deterministicRecompilation": 100,
  "zeroArbitraryCodeExecution": "by construction: provider output is parsed as data and schema-validated; no eval/Function/dynamic import/shell exists on the output path (tests/story.security.test.ts)",
  "silentAssetInvention": 0,
  "confusion": {
    "compatible": {
      "accepted": 0,
      "rejected": 0,
      "failed": 0
    },
    "mustReject": {
      "rejected": 0,
      "accepted": [],
      "failed": []
    },
    "ipTransform": []
  },
  "perEngine": {
    "ordinary_object_extreme": {
      "compatible": 0,
      "firstPass": 0,
      "afterRepair": 0
    },
    "visible_secret_chase": {
      "compatible": 0,
      "firstPass": 0,
      "afterRepair": 0
    },
    "apparent_win_instant_loss": {
      "compatible": 0,
      "firstPass": 0,
      "afterRepair": 0
    },
    "noob_vs_smart": {
      "compatible": 0,
      "firstPass": 0,
      "afterRepair": 0
    }
  },
  "substitutionsDeclared": 10,
  "failures": [],
  "determinism": {
    "sameProcessAndFresh": "8/8",
    "mismatches": []
  }
}
```

| id | kind | expected | result | repairs | subs | reject category | reason |
|---|---|---|---|---|---|---|---|
| dev01 | undefined | undefined | **accepted** | 0 | 1 |  |  |
| dev02 | undefined | undefined | **accepted** | 0 | 1 |  |  |
| dev03 | undefined | undefined | **rejected** | 0 | 0 | unavailable | no rig for non-human character(s): hamster |
| dev04 | undefined | undefined | **accepted** | 1 | 0 |  |  |
| dev05 | undefined | undefined | **accepted** | 1 | 1 |  |  |
| dev06 | undefined | undefined | **rejected** | 0 | 0 | unavailable | requires unregistered prop(s): backpack (no safe same-class substitute) |
| dev07 | undefined | undefined | **accepted** | 0 | 1 |  |  |
| dev08 | undefined | undefined | **rejected** | 0 | 1 | unavailable | requires unregistered prop(s): cake (no safe same-class substitute) |
| dev09 | undefined | undefined | **accepted** | 0 | 1 |  |  |
| dev10 | undefined | undefined | **accepted** | 0 | 1 |  |  |
| dev11 | undefined | undefined | **accepted** | 0 | 2 |  |  |
| dev12 | undefined | undefined | **rejected** | 0 | 1 | unsafe | unsafe content (dangerous_imitation: "on fire") |
