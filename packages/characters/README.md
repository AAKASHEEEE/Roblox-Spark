# @spark/characters — locked character reference profiles

This package turns character details and reference-file **metadata** into locked, versioned profiles of original modular characters. It handles data and compatibility only. It never builds meshes, opens uploaded files or renders anything.

| Module | Role |
| --- | --- |
| `schema.ts` | Strict profile/reference schema v1.0, prototype-key scan, finding types |
| `references.ts` | Required-evidence check, MIME allowlist per type, executable/archive/traversal rejection, opaque `cas://references/sha256/<hex>` storage keys, trusted byte and attestation verification |
| `trust.ts` | `TrustedWorkflow` interface (no default implementation) and the human actor-identity rules |
| `licensing.ts` | Provenance gate (`original … prohibited`), attribution, derivative/output/redistribution flags, protected-character copy tripwire |
| `catalog.ts` | Registry of pinned modular components (`id@x.y.z`) with content hashes, anchors, zones, palette slots and environment scale data |
| `recipe.ts` | Resolves a profile to registered components only. Emits `ASSET_COMPONENT_UNAVAILABLE` with suggestions that need approval, and substitutes only when an explicit approval exists |
| `compatibility.ts` | Checks rig, expressions/face set, motion (actions, height, anchors), hand/foot anchors, camera face target, bounds, clothing intersections, accessory limits and environment scale |
| `lock.ts` | `evaluateProfile`, deterministic `contentHash`, and `CharacterRegistry` (draft → validated → approved → locked → deprecated). Also handles exact episode pins |

## Evidence and trust

- **Drafts may be incomplete.** A reference only needs `referenceId` and `type` to be stored in a draft. The licence record may also be absent.
- **Evidence is required to leave draft.** Validation, approval and locking fail until every reference has complete evidence: content hash, MIME type, byte size, filename, CAS storage key, provenance, explicit attestation, and redistribution/output flags.
- **Nothing is ever defaulted.** No API fills in `attested`, `attestedBy`, `attestedAt`, provenance or hashes.
- **Evidence is confirmed by the trusted workflow.** The server-side workflow that ingested the upload implements `TrustedWorkflow`. It must re-hash the actual stored bytes and confirm that the attestation was recorded by an authenticated human session. Without it, a reference is `REFERENCE_BYTES_UNVERIFIED` / `REFERENCE_ATTESTATION_UNVERIFIED`.
- **`CharacterRegistry` requires a `TrustedWorkflow`.** There is no fallback that trusts everything.
- **Actor ids must be namespaced accounts** (e.g. `github:<login>`).
  - Empty ids are rejected with `ACTOR_MISSING`.
  - Bare or generic names are rejected with `ACTOR_ID_INVALID`.
  - Placeholder ids (`owner`, `reviewer`, `example`, …) are rejected with `ACTOR_PLACEHOLDER`.
  - Ids the workflow does not recognise as authenticated are rejected with `ACTOR_UNAUTHENTICATED`.
- **Where actor checks apply:** at validation (for attesters), and at approval and `importLocked` (for approvers).
- **Evidence is re-verified at approval and again at lock.**

## Hash formats

The package uses two hash formats, and each field accepts exactly one of them:

| Hash | Format | Regex constant |
| --- | --- | --- |
| Reference evidence `references[].contentHash` (digest of the uploaded bytes) | algorithm-qualified `sha256:<64 lowercase hex>`; its `storageRef` must be exactly `cas://references/sha256/<same hex>` | `REFERENCE_CONTENT_HASH` |
| Profile lock / episode pin (`CharacterProfile.contentHash`, `LockedManifest.contentHash`, `CharacterPin.contentHash`) | bare `<64 lowercase hex>` SHA-256 digest, the same as Environment Catalog and Bulk Core exact-resource pins | `PROFILE_CONTENT_HASH` |

- **No second format:** there is no prefix stripping, and no field accepts both formats.
- **Component and catalog hashes** inside the recipe are also bare digests (`contentHashOf`).

## Content-hash rule

`contentHash = sha256(canonicalJson(profile minus LIFECYCLE_FIELDS, plus resolved recipe))`, as bare hex.

- **Excluded:** only `status`, `locked`, `contentHash` and `deprecation`. The approver and verification results are lifecycle facts kept by the registry. There are no lock timestamps.
- **Included:** every other field, automatically. This covers:
  - reference hashes and metadata, provenance/ownership, licence terms, attribution and the full user attestation;
  - identity rules and approved substitutions;
  - role, voice, proportions, expressions, motion profile and face style;
  - through the recipe, every component `id@version`, component hash and resolved colour.
- **Changing a locked version:** if any hashed field changes, re-submitting the same version fails with `IDENTITY_CHANGE_REQUIRES_NEW_VERSION`.

Episodes reference `{ characterId, version, contentHash }`. `resolvePin` rejects `latest`, version ranges and hash mismatches. Deprecated versions still resolve, with a warning.

## Example

`examples/zapp@1.0.0.profile.json` is a **draft** (`status: "draft"`, `locked: false`). It contains only Zapp's modular recipe, personality and identity rules, taken from `assets/characters/zapp@1.0.0.json`.

It deliberately has no references, licence record or attestation. Real reference records are added only after actual bytes have been ingested, hashed and attested through an authenticated human workflow. The owner supplies the licence record. Until then the draft cannot validate.

Tests: `tests/character-profiles.test.ts`. The synthetic bytes and in-memory trusted workflow used there are test-only fixtures.
