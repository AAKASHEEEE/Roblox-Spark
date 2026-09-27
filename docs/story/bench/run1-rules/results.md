# Benchmark results — provider `rules`

Dataset `bench/ideas.json` (50 ideas). Analyzer: on.

```json
{
  "run": {
    "provider": "rules",
    "model": "rules-v1 (deterministic keyword slot-filler, not an LLM)",
    "dataset": "bench/ideas.json",
    "ideas": 50,
    "compatible": 29,
    "mustReject": 19,
    "ipTransformable": 2,
    "analyzer": true,
    "date": "2026-09-27T13:25:45.824Z"
  },
  "m01_schemaValidResponseRate": 100,
  "m01b_finalSchemaValidOrExplicitRejection": 94,
  "m02_assetCompatibleFirstPlanRate": 100,
  "m03_firstPassCompilerSuccess_compatible": 100,
  "m04_firstPassValidatorAcceptance_compatible": 69,
  "m05_acceptanceAfterRepair_compatible": 93.1,
  "m06_avgRepairs_compatible": 0.45,
  "m06b_avgRepairs_accepted": 0.29,
  "m07_rejectionCorrectness_mustReject": 100,
  "m07b_rejectionCategoryMatch": 94.7,
  "m07c_unsafeRejected": 100,
  "m07d_protectedIpRejectedOrTransformed": 80,
  "m07e_falseRejections_compatible": [],
  "m08_avgLatencyMs_all": 385,
  "m08b_avgLatencyMs_accepted": 519,
  "m09_cost": {
    "modelTokensIn": 0,
    "modelTokensOut": 0,
    "modelCostUsd": 0,
    "computeCostUsdPerIdea_at_0_35_per_hour": 0.000037,
    "estimatedLlmPromptTokensPerIdea": {
      "normalize": 1046,
      "plan": 2132,
      "note": "estimated from the real prompts (chars/4); output ~1.5-4k tokens per plan; repairs add ~1 plan-sized prompt each"
    }
  },
  "m10_causeResultCompleteness": 100,
  "m11_reversalPlacementCompliance": 100,
  "m12_loopCompliance": 100,
  "m13_mutedStoryHeuristicScore_mean": 98,
  "m14_cameraQualityPass_firstCompiled": 96.6,
  "m14b_cameraQualityPass_final": 96.6,
  "m15_collisionQualityPass_firstCompiled": 93.1,
  "m15b_collisionQualityPass_final": 96.6,
  "m16_deterministicRecompilation": 100,
  "zeroArbitraryCodeExecution": "by construction: provider output is parsed as data and schema-validated; no eval/Function/dynamic import/shell exists on the output path (tests/story.security.test.ts)",
  "silentAssetInvention": 0,
  "confusion": {
    "compatible": {
      "accepted": 27,
      "rejected": 0,
      "failed": 2
    },
    "mustReject": {
      "rejected": 19,
      "accepted": [],
      "failed": []
    },
    "ipTransform": [
      "A12: failed",
      "D08: accepted (brand removed)"
    ]
  },
  "perEngine": {
    "ordinary_object_extreme": {
      "compatible": 9,
      "firstPass": 9,
      "afterRepair": 9
    },
    "visible_secret_chase": {
      "compatible": 7,
      "firstPass": 1,
      "afterRepair": 6
    },
    "apparent_win_instant_loss": {
      "compatible": 7,
      "firstPass": 6,
      "afterRepair": 7
    },
    "noob_vs_smart": {
      "compatible": 6,
      "firstPass": 4,
      "afterRepair": 5
    }
  },
  "substitutionsDeclared": 44,
  "failures": [
    {
      "id": "A12",
      "expected": "reject_or_transform",
      "reason": "not accepted after 3 repair(s): HAND_PENETRATION zapp r hand 1.7 cm inside prop:coin (1 sampled frames in s07) | BODY_PROP_INTERSECTION zapp head_-1_1_top 7.9 cm inside prop:coin (1 sampled frames in s07) | FOOT_SLIP planted-foot slip median 0.004 p95 0.848 m/s"
    },
    {
      "id": "B12",
      "expected": "accept",
      "reason": "not accepted after 3 repair(s): BODY_PROP_INTERSECTION zapp head_-1_1_top 3.2 cm inside prop:coin (1 sampled frames in s08)"
    },
    {
      "id": "D09",
      "expected": "accept",
      "reason": "not accepted after 3 repair(s): FACE_OUT_OF_FRAME zapp face not in frame (6 sampled frames in s02)"
    }
  ],
  "determinism": {
    "sameProcessAndFresh": "28/28",
    "mismatches": []
  }
}
```

| id | kind | expected | result | repairs | subs | reject category | reason |
|---|---|---|---|---|---|---|---|
| A01 | compatible | accept | **accepted** | 0 | 0 |  |  |
| A02 | compatible | accept | **accepted** | 0 | 0 |  |  |
| A03 | compatible | accept | **accepted** | 0 | 0 |  |  |
| A04 | ambiguous | accept | **accepted** | 0 | 1 |  |  |
| A05 | substitution | accept_with_substitution | **accepted** | 0 | 2 |  |  |
| A06 | substitution | accept_with_substitution | **accepted** | 0 | 1 |  |  |
| A07 | substitution | accept_with_substitution | **accepted** | 0 | 2 |  |  |
| A08 | reject_unavailable | reject | **rejected** | 0 | 1 | unavailable | requires unregistered prop(s): pizza (no safe same-class substitute) |
| A09 | reject_impossible | reject | **rejected** | 0 | 0 | impossible | shrinking a character or prop to nothing is not a registered effect |
| A10 | reject_unsafe | reject | **rejected** | 0 | 0 | unsafe | unsafe content (violence: "blow up the school") |
| A11 | reject_ip | reject | **rejected** | 0 | 0 | protected_ip | idea depends on protected IP (minecraft, creeper); original cast only |
| A12 | transform_ip | reject_or_transform | **failed** | 3 | 1 |  | not accepted after 3 repair(s): HAND_PENETRATION zapp r hand 1.7 cm inside prop:coin (1 sampled frames in s07) / BODY_PR |
| A13 | staging_conflict | accept | **accepted** | 0 | 1 |  |  |
| A14 | compatible | accept | **accepted** | 0 | 0 |  |  |
| A15 | reject_unsafe | reject | **rejected** | 0 | 0 | unsafe | unsafe content (platform_currency: "robux", platform_currency: "free robux") |
| B01 | compatible | accept | **accepted** | 1 | 1 |  |  |
| B02 | compatible | accept | **accepted** | 1 | 0 |  |  |
| B03 | ambiguous | accept | **accepted** | 1 | 0 |  |  |
| B04 | substitution | accept_with_substitution | **accepted** | 0 | 2 |  |  |
| B05 | reject_unavailable | reject | **rejected** | 0 | 1 | unavailable | BZTT (floating robot) is not built yet (floating_orb_v1 rig missing) and may never be replaced by a human character (ide |
| B06 | substitution | accept_with_substitution | **accepted** | 1 | 1 |  |  |
| B07 | reject_impossible | reject | **rejected** | 0 | 2 | impossible | flight is not supported (no flying rig or flight-path effect) |
| B08 | reject_unavailable | reject | **rejected** | 0 | 1 | unavailable | requires unregistered prop(s): phone (no safe same-class substitute) |
| B09 | reject_unsafe | reject | **rejected** | 0 | 1 | unsafe | unsafe content (weapon: "knife") |
| B10 | reject_ip | reject | **rejected** | 0 | 0 | protected_ip | idea depends on protected IP (sonic); original cast only |
| B11 | staging_conflict | accept | **accepted** | 1 | 1 |  |  |
| B12 | compatible | accept | **failed** | 3 | 0 |  | not accepted after 3 repair(s): BODY_PROP_INTERSECTION zapp head_-1_1_top 3.2 cm inside prop:coin (1 sampled frames in s |
| C01 | compatible | accept | **accepted** | 1 | 0 |  |  |
| C02 | compatible | accept | **accepted** | 0 | 0 |  |  |
| C03 | ambiguous | accept | **accepted** | 0 | 1 |  |  |
| C04 | substitution | accept_with_substitution | **accepted** | 0 | 2 |  |  |
| C05 | substitution | accept_with_substitution | **accepted** | 0 | 2 |  |  |
| C06 | reject_impossible | reject | **rejected** | 0 | 1 | impossible | flight is not supported (no flying rig or flight-path effect) |
| C07 | reject_unavailable | reject | **rejected** | 0 | 1 | unavailable | requires unregistered prop(s): video game, laptop (no safe same-class substitute) |
| C08 | reject_unsafe | reject | **rejected** | 0 | 1 | unsafe | unsafe content (drugs_alcohol: "beer") |
| C09 | reject_ip | reject | **rejected** | 0 | 2 | protected_ip | idea depends on protected IP (pokemon, pikachu); original cast only |
| C10 | staging_conflict | accept | **accepted** | 0 | 2 |  |  |
| C11 | compatible | accept | **accepted** | 0 | 2 |  |  |
| C12 | reject_impossible | reject | **rejected** | 0 | 1 | requires_text | the joke depends on reading text on screen; stories must read without text |
| D01 | compatible | accept | **accepted** | 0 | 0 |  |  |
| D02 | compatible | accept | **accepted** | 0 | 0 |  |  |
| D03 | ambiguous | accept | **accepted** | 0 | 1 |  |  |
| D04 | substitution | accept_with_substitution | **accepted** | 0 | 2 |  |  |
| D05 | reject_unavailable | reject | **rejected** | 0 | 1 | unavailable | requires unregistered prop(s): magnet (no safe same-class substitute) |
| D06 | reject_unavailable | reject | **rejected** | 0 | 1 | impossible | explosions/fire are not registered effects |
| D07 | reject_unsafe | reject | **rejected** | 0 | 1 | unsafe | unsafe content (dangerous_imitation: "fork in the outlet", dangerous_imitation: "outlet") |
| D08 | transform_ip | reject_or_transform | **accepted** | 1 | 2 |  |  |
| D09 | staging_conflict | accept | **failed** | 3 | 1 |  | not accepted after 3 repair(s): FACE_OUT_OF_FRAME zapp face not in frame (6 sampled frames in s02) |
| D10 | compatible | accept | **accepted** | 1 | 0 |  |  |
| D11 | reject_unsafe | reject | **rejected** | 0 | 1 | unsafe | unsafe content (cruelty: "ugly", cruelty: "dumb") |
