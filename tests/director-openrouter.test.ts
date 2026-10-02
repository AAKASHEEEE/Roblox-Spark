import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { directScript } from '../packages/director/src/pipeline.ts';
import { DIRECTOR_ALGORITHM_VERSION, normalizeDirectorRequest } from '../packages/director/src/offline.ts';
import { NodeDirectorCache, shouldCacheDirectorResult, type DirectorCacheDescriptor } from '../packages/director/node/cache.ts';
import { OpenRouterIntentProvider, OpenRouterProviderError, normalizeFreeModelList } from '../packages/director/src/openrouter.ts';
import { validateDirectorIntent } from '../packages/director/src/intent.ts';
import type { DirectorIntentClient } from '../packages/director/src/pipeline.ts';

const intent = (lineCount = 1) => ({
  set: 'classroom',
  characters: ['zapp'],
  beats: Array.from({ length: lineCount }, (_, line) => ({ line, action: line ? 'runs' : 'grabs', props: line ? [] : ['phone'], shots: [] })),
});
const answer = (value: unknown, status = 200) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }), { status, headers: { 'content-type': 'application/json' } });
const fakeFetch = (fn: (body: any, init: RequestInit, call: number) => Promise<Response> | Response): { fetch: typeof fetch; bodies: any[] } => {
  const bodies: any[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)); bodies.push({ body, headers: init?.headers });
    return fn(body, init ?? {}, bodies.length);
  }) as typeof fetch;
  return { fetch: fetchImpl, bodies };
};

test('OpenRouter enforces free-only model configuration', () => {
  assert.deepEqual(normalizeFreeModelList(undefined), ['openrouter/free']);
  assert.deepEqual(normalizeFreeModelList(['a/model:free', 'a/model:free']), ['a/model:free']);
  for (const paidOrAmbiguous of ['paid/model', 'vendor/model:free:paid', 'openrouter/free?fallback=paid', 'OPENROUTER/FREE']) {
    assert.throws(() => normalizeFreeModelList([paidOrAmbiguous]), (error: unknown) => error instanceof OpenRouterProviderError && error.code === 'config');
  }
  assert.throws(() => new OpenRouterIntentProvider({ apiKey: 'secret', baseUrl: 'https://example.invalid/api/v1', fetchImpl: fakeFetch(() => answer(intent())).fetch }),
    (error: unknown) => error instanceof OpenRouterProviderError && error.code === 'config' && /credentials are restricted/.test(error.message));
  assert.doesNotThrow(() => new OpenRouterIntentProvider({ apiKey: 'secret', baseUrl: 'https://openrouter.ai/api/v1/' }));
});

test('strict invalid intent gets exactly one repair attempt without echoing reflected credentials', async () => {
  const secret = 'test-secret';
  const mock = fakeFetch((_body, _init, call) => answer(call === 1 ? { ...intent(), set: secret, [secret]: true } : intent()));
  const provider = new OpenRouterIntentProvider({ apiKey: secret, models: ['vendor/model:free'], timeoutMs: 50, fetchImpl: mock.fetch });
  const result = await provider.infer(['Zapp grabs a phone.']);
  assert.deepEqual(result.intent, intent());
  assert.deepEqual(result.attempts.map((x) => [x.phase, x.outcome]), [['initial', 'invalid'], ['repair', 'ok']]);
  assert.equal(mock.bodies.length, 2);
  assert.equal(mock.bodies[0].body.response_format.json_schema.strict, true);
  assert.equal(mock.bodies[0].body.response_format.json_schema.schema.additionalProperties, false);
  assert.ok(mock.bodies[0].body.response_format.json_schema.schema.properties.beats.items.required.includes('shots'));
  assert.equal(mock.bodies[0].body.model, 'vendor/model:free');
  assert.doesNotMatch(JSON.stringify(mock.bodies.map((x) => x.body)), /test-secret/);
  assert.equal((mock.bodies[0].headers as Record<string, string>).authorization, 'Bearer test-secret');
});

test('timeout and HTTP 429 fail over across the configured free models', async () => {
  const mock = fakeFetch((_body, init, call) => {
    if (call === 1) return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => { const error = new Error('aborted'); error.name = 'AbortError'; reject(error); }, { once: true });
    });
    if (call === 2) return new Response('{}', { status: 429 });
    return answer(intent());
  });
  const provider = new OpenRouterIntentProvider({ apiKey: 'k', models: ['one:free', 'two:free', 'three:free'], timeoutMs: 5, fetchImpl: mock.fetch });
  const result = await provider.infer(['Zapp grabs a phone.']);
  assert.equal(result.model, 'three:free');
  assert.deepEqual(result.attempts.map((x) => x.outcome), ['timeout', 'rate_limited', 'ok']);
  assert.deepEqual(mock.bodies.map((x) => x.body.model), ['one:free', 'two:free', 'three:free']);
});

test('repair budget is global even when later models also return invalid JSON', async () => {
  const mock = fakeFetch(() => answer({ nope: true }));
  const provider = new OpenRouterIntentProvider({ apiKey: 'k', models: ['one:free', 'two:free'], timeoutMs: 50, fetchImpl: mock.fetch });
  await assert.rejects(provider.infer(['line']), (error: unknown) => {
    assert.ok(error instanceof OpenRouterProviderError);
    assert.equal(error.code, 'exhausted');
    assert.equal(error.attempts.filter((x) => x.phase === 'repair').length, 1);
    return true;
  });
  assert.equal(mock.bodies.length, 3);
});

test('auto mode transparently falls back to deterministic offline generation', async () => {
  const attempts = [{ model: 'one:free', phase: 'initial' as const, outcome: 'rate_limited' as const, detail: 'HTTP 429 rate limited' }];
  const client: DirectorIntentClient = {
    models: ['one:free'],
    async infer() { throw new OpenRouterProviderError('exhausted', 'all models failed', attempts); },
  };
  const result = await directScript({ script: 'Zapp runs in class.', duration: 3, seed: 2 }, { provider: 'auto', intentClient: client });
  assert.equal(result.report.provider.used, 'offline');
  assert.equal(result.report.provider.fallback?.code, 'openrouter_exhausted');
  assert.deepEqual(result.report.provider.attempts, attempts);
  assert.equal(result.report.validation.ok, true);
});

test('validated OpenRouter intent is resolved through local library ids, never copied blindly', async () => {
  const client: DirectorIntentClient = { models: ['fake:free'], async infer() { return { intent: { set: 'playground', characters: ['zapp'], beats: [{ line: 0, action: 'runs', props: ['ball'], shots: [] }] }, model: 'fake:free', attempts: [] }; } };
  const result = await directScript({ script: 'He moves quickly.', duration: 2, seed: 1 }, { provider: 'openrouter', intentClient: client });
  assert.match(result.sheet.beats[0].setId, /^playground@/);
  assert.equal(result.sheet.beats[0].cast[0].actionId, 'run');
  assert.match(result.sheet.beats[0].props[0].propId, /^ball@/);
  assert.equal(result.report.provider.used, 'openrouter');
});

test('schema-valid reflected credential is omitted from report and persisted cache', async () => {
  const secret = 'review-secret-value';
  const reflected = { set: secret, characters: [secret], beats: [{ line: 0, action: secret, props: [secret], shots: [] }] };
  const mock = fakeFetch(() => answer(reflected));
  const provider = new OpenRouterIntentProvider({ apiKey: secret, models: ['safe:free'], timeoutMs: 50, fetchImpl: mock.fetch });
  const request = { script: 'Someone waits quietly.', duration: 2, seed: 4 };
  const result = await directScript(request, { provider: 'openrouter', intentClient: provider });
  assert.ok(result.report.missingAssets.length > 0);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));

  const root = mkdtempSync(join(tmpdir(), 'spark-director-secret-cache-'));
  try {
    const descriptor: DirectorCacheDescriptor = {
      algorithmVersion: DIRECTOR_ALGORITHM_VERSION,
      request: normalizeDirectorRequest(request), provider: 'openrouter', models: ['safe:free'], timeoutMs: 50, openRouterConfigured: true,
    };
    const cache = new NodeDirectorCache(root);
    cache.put(descriptor, result);
    assert.doesNotMatch(readFileSync(cache.pathFor(descriptor), 'utf8'), new RegExp(secret));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('configured auto fallback is not cached, so a recovered provider is retried', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spark-director-recovery-cache-'));
  try {
    const request = { script: 'Zapp runs in class.', duration: 3, seed: 2 };
    const descriptor: DirectorCacheDescriptor = {
      algorithmVersion: DIRECTOR_ALGORITHM_VERSION,
      request: normalizeDirectorRequest(request), provider: 'auto', models: ['one:free'], timeoutMs: 50, openRouterConfigured: true,
    };
    const cache = new NodeDirectorCache(root);
    const failedClient: DirectorIntentClient = {
      models: ['one:free'],
      async infer() { throw new OpenRouterProviderError('exhausted', 'temporary outage'); },
    };
    const fallback = await directScript(request, { provider: 'auto', intentClient: failedClient });
    assert.equal(shouldCacheDirectorResult(descriptor, fallback), false);
    assert.equal(cache.get(descriptor), null);

    let calls = 0;
    const recoveredClient: DirectorIntentClient = {
      models: ['one:free'],
      async infer() { calls++; return { intent: { set: 'classroom', characters: ['zapp'], beats: [{ line: 0, action: 'runs', props: [], shots: [] }] }, model: 'one:free', attempts: [] }; },
    };
    const recovered = await directScript(request, { provider: 'auto', intentClient: recoveredClient });
    assert.equal(calls, 1);
    assert.equal(recovered.report.provider.used, 'openrouter');
    assert.equal(shouldCacheDirectorResult(descriptor, recovered), true);
    cache.put(descriptor, recovered);
    assert.equal(cache.get(descriptor)?.value.report.provider.used, 'openrouter');
    assert.notEqual(cache.digest(descriptor), cache.digest({ ...descriptor, timeoutMs: 51 }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('advisory shot intents are strict, ordered, line-bounded, and capped', () => {
  const base = intent();
  assert.equal(validateDirectorIntent(base, 1, [1]).ok, true);
  const outsideLine = { ...base, beats: [{ ...base.beats[0], shots: [{ clause: 1, recipe: 'chase_cam', subject: 'zapp', secondary: '' }] }] };
  assert.equal(validateDirectorIntent(outsideLine, 1, [1]).ok, false);
  const outOfOrder = {
    ...base,
    beats: [{ ...base.beats[0], shots: [
      { clause: 2, recipe: 'medium_single', subject: 'zapp', secondary: '' },
      { clause: 1, recipe: 'chase_cam', subject: 'zapp', secondary: '' },
    ] }],
  };
  assert.equal(validateDirectorIntent(outOfOrder, 1).ok, false);

  const extraKey = {
    ...base,
    beats: [{ ...base.beats[0], shots: [
      { clause: 1, recipe: 'chase_cam', subject: 'zapp', secondary: '', extra: true },
    ] }],
  };
  assert.equal(validateDirectorIntent(extraKey, 1).ok, false);

  const tooMany = {
    ...base,
    beats: [{ ...base.beats[0], shots: Array.from({ length: 5 }, (_, index) => ({ clause: index + 1, recipe: 'medium_single', subject: 'zapp', secondary: '' })) }],
  };
  assert.equal(validateDirectorIntent(tooMany, 1).ok, false);
});

test('local planner accepts valid catalog shot hints and rebuilds invalid ones without copying them', async () => {
  const reflected = 'not-a-real-camera-secret';
  const client: DirectorIntentClient = {
    models: ['fake:free'],
    async infer() {
      return {
        intent: {
          set: 'classroom', characters: ['zapp', 'kira'],
          beats: [{
            line: 0, action: 'runs', props: ['phone'], shots: [
              { clause: 1, recipe: 'chase_cam', subject: 'kira', secondary: '' },
              { clause: 2, recipe: reflected, subject: reflected, secondary: '' },
            ],
          }],
        },
        model: 'fake:free', attempts: [],
      };
    },
  };
  const result = await directScript({ script: 'Zapp waits, then Kira runs, but the phone drops.', duration: 6, seed: 12 }, { provider: 'openrouter', intentClient: client });
  const clauses = result.report.editPlan.beats[0].clauses;
  const accepted = clauses.find((clause) => clause.index === 1)!;
  const rebuilt = clauses.find((clause) => clause.index === 2)!;
  assert.equal(accepted.providerHint, 'accepted');
  assert.deepEqual(accepted.shot, { recipeId: 'chase_cam', subject: 'kira', source: 'provider' });
  assert.equal(rebuilt.providerHint, 'rebuilt');
  assert.equal(rebuilt.shot.source, 'local');
  assert.doesNotMatch(JSON.stringify(result), new RegExp(reflected));
  assert.equal(result.report.validation.ok, true);
});


test('injected intent clients receive the same runtime structure and clause-bound validation', async () => {
  const client: DirectorIntentClient = {
    models: ['fake:free'],
    async infer() {
      return {
        intent: { set: 'classroom', characters: ['zapp'], beats: [{ line: 0, action: 'runs', props: [], shots: [{ clause: 7, recipe: 'chase_cam', subject: 'zapp', secondary: '' }] }] },
        model: 'fake:free', attempts: [],
      };
    },
  };
  await assert.rejects(
    directScript({ script: 'Zapp runs.', duration: 3, seed: 1 }, { provider: 'openrouter', intentClient: client }),
    (error: unknown) => error instanceof OpenRouterProviderError && error.code === 'exhausted' && /invalid compact intent/.test(error.message),
  );
});