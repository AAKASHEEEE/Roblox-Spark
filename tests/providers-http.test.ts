// Real-provider transport against a LOCAL fake HTTP server (no network, no keys): timeout, 5xx/429 retry, 401 no
// retry, malformed bodies, OpenAI-compatible + Anthropic response shapes, and a full pipeline run through the HTTP
// provider path. The fake server is NOT a language model: it answers with the offline rules provider's output.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { postJson, OpenAICompatibleProvider, AnthropicProvider } from '../packages/story/src/providers/llm.ts';
import { ProviderError } from '../packages/story/src/providers/types.ts';
import { createProvider } from '../packages/story/src/providers/index.ts';
import { RulesProvider } from '../packages/story/src/providers/rules.ts';
import { buildRegistry } from '../packages/story/src/registry.ts';
import { generateEpisode } from '../packages/story/src/pipeline.ts';
import { lib } from './helpers.ts';

type Handler = (req: { url: string; headers: Record<string, string | string[] | undefined>; body: any }, n: number) => { status?: number; body?: unknown; raw?: string; delayMs?: number };
let server: Server, base = '', handler: Handler = () => ({ body: {} }), hits = 0;
const bodies: any[] = [];
before(async () => {
  server = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', async () => {
      hits++;
      const body = data ? JSON.parse(data) : null; bodies.push({ url: req.url, headers: req.headers, body });
      const r = handler({ url: req.url!, headers: req.headers, body }, hits);
      if (r.delayMs) await new Promise((ok) => setTimeout(ok, r.delayMs));
      if (res.destroyed) return;
      res.writeHead(r.status ?? 200, { 'content-type': 'application/json' });
      res.end(r.raw ?? JSON.stringify(r.body ?? {}));
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => { server.closeAllConnections?.(); server.close(); });
const reset = (h: Handler) => { handler = h; hits = 0; bodies.length = 0; };
const T = { timeoutMs: 200, maxRetries: 2, backoffMs: 5 };

test('timeout: aborted after timeoutMs, retried maxRetries times, then a timeout error', async () => {
  reset(() => ({ delayMs: 400, body: { ok: 1 } }));
  await assert.rejects(postJson(`${base}/x`, {}, {}, T), (e: unknown) => e instanceof ProviderError && e.kind === 'timeout');
  await new Promise((ok) => setTimeout(ok, 450));
  assert.equal(hits, 3);
});

test('HTTP 500 and 429 are retried with backoff; success on a later attempt is reported', async () => {
  reset((_r, n) => (n === 1 ? { status: 500, raw: 'boom' } : n === 2 ? { status: 429, raw: 'slow down' } : { body: { ok: true } }));
  const r = await postJson(`${base}/x`, {}, {}, T);
  assert.deepEqual(r.json, { ok: true });
  assert.equal(r.attempts, 3);
});

test('HTTP 401 is not retried and surfaces as an explicit http error', async () => {
  reset(() => ({ status: 401, raw: '{"error":"bad key"}' }));
  await assert.rejects(postJson(`${base}/x`, {}, {}, T), (e: unknown) => e instanceof ProviderError && e.kind === 'http' && e.status === 401);
  assert.equal(hits, 1);
});

test('malformed HTTP body (not JSON) is an explicit malformed error, not retried', async () => {
  reset(() => ({ raw: '<html>gateway</html>' }));
  await assert.rejects(postJson(`${base}/x`, {}, {}, T), (e: unknown) => e instanceof ProviderError && e.kind === 'malformed');
  assert.equal(hits, 1);
});

test('missing credentials are a config error (keys only come from the environment)', () => {
  assert.throws(() => createProvider({}, 'openai'), /OPENAI_API_KEY is not set/);
  assert.throws(() => createProvider({}, 'anthropic'), /ANTHROPIC_API_KEY is not set/);
  assert.equal(createProvider({}, 'rules').name, 'rules');
});

const reg = buildRegistry(lib);
const REQ = { idea: 'Zapp presses a free-coins button, celebrates, and the coin becomes too large.', durationTarget: 17, comedyEngine: null, seed: 9 };
/** fake "model": answers each stage with the offline rules provider (so the HTTP path is exercised end to end) */
async function stageAnswer(body: any): Promise<unknown> {
  const user = JSON.parse(body.messages.find((m: any) => m.role === 'user').content);
  const rules = new RulesProvider();
  if (user.task.startsWith('Stage A')) return rules.normalizeIdea({ request: user.request, registry: reg, constraints: [] });
  if (user.task.startsWith('Stage B')) return rules.planBeats({ request: REQ as never, idea: user.idea, template: user.template, registry: reg, constraints: [] });
  return { patches: [], notes: 'fake' };
}

test('OpenAI-compatible provider: strict JSON-schema request, bearer auth, usage tokens, malformed content rejected', async () => {
  let pending: Promise<unknown> | null = null;
  reset(({ body }) => { pending = stageAnswer(body); return { body: { __deferred: true } }; });
  const p = new OpenAICompatibleProvider({ baseUrl: base, apiKey: 'test-key', model: 'fake-model', ...T });
  // handler cannot await: answer synchronously with the rules output computed up front
  const answer = await stageAnswer({ messages: [{ role: 'user', content: JSON.stringify({ task: 'Stage A', request: REQ }) }] });
  reset(() => ({ body: { choices: [{ message: { content: JSON.stringify(answer) } }], usage: { prompt_tokens: 1234, completion_tokens: 321 } } }));
  const v = await p.normalizeIdea({ request: REQ as never, registry: reg, constraints: [] });
  assert.deepEqual(v, answer);
  const sent = bodies[0];
  assert.equal(sent.url, '/chat/completions');
  assert.equal(sent.headers.authorization, 'Bearer test-key');
  assert.equal(sent.body.response_format.type, 'json_schema');
  assert.equal(sent.body.response_format.json_schema.schema.type, 'object');
  assert.equal(sent.body.temperature, 0);
  assert.deepEqual([p.lastCall()!.tokensIn, p.lastCall()!.tokensOut, p.lastCall()!.ok], [1234, 321, true]);
  reset(() => ({ body: { choices: [{ message: { content: 'Here is your story!' } }] } }));
  await assert.rejects(p.normalizeIdea({ request: REQ as never, registry: reg, constraints: [] }), (e: unknown) => e instanceof ProviderError && e.kind === 'malformed');
  void pending;
});

test('Anthropic provider: forced tool use; a response without tool_use is malformed', async () => {
  const answer = await stageAnswer({ messages: [{ role: 'user', content: JSON.stringify({ task: 'Stage A', request: REQ }) }] });
  reset(() => ({ body: { content: [{ type: 'tool_use', name: 'normalized_idea', input: answer }], usage: { input_tokens: 10, output_tokens: 20 } } }));
  const p = new AnthropicProvider({ baseUrl: base, apiKey: 'k', model: 'fake', ...T });
  assert.deepEqual(await p.normalizeIdea({ request: REQ as never, registry: reg, constraints: [] }), answer);
  assert.equal(bodies[0].url, '/v1/messages');
  assert.equal(bodies[0].headers['x-api-key'], 'k');
  assert.equal(bodies[0].body.tool_choice.name, 'normalized_idea');
  reset(() => ({ body: { content: [{ type: 'text', text: 'hi' }] } }));
  await assert.rejects(p.normalizeIdea({ request: REQ as never, registry: reg, constraints: [] }), (e: unknown) => e instanceof ProviderError && e.kind === 'malformed');
});

test('full pipeline through the HTTP provider path (fake server answering with rules output) is accepted', async () => {
  const answers: unknown[] = [];
  const A = await stageAnswer({ messages: [{ role: 'user', content: JSON.stringify({ task: 'Stage A', request: REQ }) }] }) as any;
  const tpl = (await import('../packages/story/src/templates.ts')).TEMPLATES[A.engine as 'ordinary_object_extreme'];
  const B = await new RulesProvider().planBeats({ request: REQ as never, idea: A, template: tpl, registry: reg, constraints: [] });
  answers.push(A, B);
  reset((r, n) => ({ body: { choices: [{ message: { content: JSON.stringify(n <= 2 ? answers[n - 1] : { patches: [], notes: 'fake' }) } }], usage: { prompt_tokens: 100, completion_tokens: 50 } } }));
  const p = new OpenAICompatibleProvider({ baseUrl: base, apiKey: 'test-key', model: 'fake-model', ...T });
  const rec = await generateEpisode(REQ, { provider: p, registry: reg, lib, analyzer: null, sha256: (s: string) => createHash('sha256').update(s).digest('hex') });
  assert.equal(rec.status, 'accepted', rec.failure ?? '');
  assert.equal(rec.provider.name, 'openai');
  assert.equal(rec.tokens.in, 200);
  assert.equal(rec.calls.length, 2);
});
