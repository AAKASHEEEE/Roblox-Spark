# packages/bulk — deterministic bulk episode queue (core)

This package takes a batch of 1–20 episode requests and runs them through validation, deterministic seeds, jobs, leasing, retry/resume and portable manifests. It never renders anything itself. All real work goes through an injected `EpisodePipeline` (`validate`, `generateStoryboard`, `approve`, `renderDraft`, `renderFinal`), so it doesn't import the renderer, camera, motion, captions or the narrated pipeline.

| File | Purpose |
| --- | --- |
| `src/schema.ts` | Strict request schema `1.0`. Rejects unknown keys, `__proto__`/`constructor`/`prototype` keys, duplicate IDs or seeds, unsafe or outside-root paths, too many episodes and invalid concurrency. Resolves defaults and seeds. |
| `src/seeds.ts` | `deriveSeed(batchId, episodeId, batchSeed, variant)` via SHA-256. The seed doesn't depend on episode order or batch size. |
| `src/states.ts` | Explicit transition table for the 13 job states. |
| `src/store.ts` | Content-hashed JSON envelopes, atomic writes, per-batch lock file, corruption detection and temp-file recovery. The file system is injected through `BulkFs`. |
| `src/queue.ts` | Enqueue, claim/lease, renew, advance, complete, fail, cancel, retry, and recovery of expired leases. |
| `src/runner.ts` | `BulkRunner`: concurrency limit, continue-on-error or `stopOnFirstError`, timeouts, retries (default max 2 attempts), cancellation and progress events. |
| `src/manifest.ts` | Deterministic, portable batch manifest. |
| `node/node-fs.ts` | Node `BulkFs` adapter: temp file → fsync → rename → dir fsync, plus `O_EXCL` lock files. |

```ts
const store = new BulkStore(new NodeBulkFs('out/bulk'));
const parsed = parseBatchRequest(json, { outputRoot: 'bulk' });
if (parsed.ok) store.createBatch(parsed.batch);
await new BulkRunner(new JobQueue(store), myPipeline).run(batchId, { onEvent });
writeManifest(store, batchId);
```

The store and queue are synchronous so that each locked read-modify-write stays atomic within one process. The lock file covers access across processes. If a lock file is stale (a process crashed while holding it), the next writer breaks it. Two processes breaking the same stale lock at the same moment can race. That is acceptable for this single-host MVP.
