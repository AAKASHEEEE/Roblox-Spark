// Real-model providers (OpenAI-compatible Chat Completions with strict JSON-schema output, and Anthropic Messages
// with forced tool use). Output is still re-validated by the pipeline. Credentials come ONLY from the environment.
import { toJsonSchema } from '../../../schema/src/v.ts';
import { beatPlanSchema, normalizedIdeaSchema, RepairResponseSchema } from '../schemas.ts';
import { registrySummary } from '../registry.ts';
import { SLOT_SPECS } from '../templates.ts';
import { ProviderError, estimateTokens, type CallMeta, type NormalizeInput, type PlanInput, type RepairInput, type StoryModelProvider } from './types.ts';

export interface TransportOptions { timeoutMs: number; maxRetries: number; backoffMs: number; fetchImpl?: typeof fetch }

/** POST JSON with timeout + bounded retries on network errors / 429 / 5xx. Never retries 4xx auth/validation errors. */
export async function postJson(url: string, body: unknown, headers: Record<string, string>, o: TransportOptions): Promise<{ json: any; attempts: number }> {
  const f = o.fetchImpl ?? fetch;
  let last: ProviderError | null = null;
  for (let attempt = 0; attempt <= o.maxRetries; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, o.backoffMs * 2 ** (attempt - 1)));
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), o.timeoutMs);
    try {
      const res = await f(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ac.signal });
      const text = await res.text();
      if (!res.ok) {
        last = new ProviderError('http', `HTTP ${res.status}: ${text.slice(0, 200)}`, res.status);
        if (res.status === 429 || res.status >= 500) continue;
        throw last;
      }
      try { return { json: JSON.parse(text), attempts: attempt + 1 }; } catch { throw new ProviderError('malformed', `non-JSON HTTP body: ${text.slice(0, 120)}`); }
    } catch (e) {
      if (e instanceof ProviderError && (e.kind === 'malformed' || (e.kind === 'http' && e.status! < 500 && e.status !== 429))) throw e;
      last = (e as Error).name === 'AbortError' ? new ProviderError('timeout', `timed out after ${o.timeoutMs} ms`) : e instanceof ProviderError ? e : new ProviderError('network', String(e));
    } finally { clearTimeout(timer); }
  }
  throw last ?? new ProviderError('network', 'unknown transport failure');
}

const SYSTEM = [
  'You are a story planner for an automated animation engine that renders short, silent, family-safe, original comedy videos.',
  'You output ONLY JSON matching the provided schema. Never output code, shell commands, shaders, markdown or prose outside JSON.',
  'Use ONLY the registered characters, props, environment, actions, expressions and camera presets listed in the registry. Never invent assets.',
  'If the idea needs something unavailable, either declare a substitution of the same affordance class or reject it with a precise reason.',
  'Reject unsafe ideas (violence, weapons, sexual content, drugs/alcohol, dangerous imitation, self-harm, cruelty, real-money or platform-currency giveaways)',
  'and ideas that depend on protected characters, brands or real people. A brand used only as a style word may be removed (declare it).',
  'Stories must read with the sound off: no dialogue, no text needed; every cause has a visible result; faces react when information changes.',
].join(' ');

function prompts(stage: 'normalize' | 'plan' | 'repair', input: NormalizeInput | PlanInput | RepairInput): string {
  const reg = registrySummary(input.registry);
  if (stage === 'normalize') {
    const i = input as NormalizeInput;
    return JSON.stringify({ task: 'Stage A: normalize the idea into template roles; list every character/prop/place/action the idea mentions; declare substitutions; classify safety; reject if needed.', request: i.request, registry: reg, engines: ['ordinary_object_extreme', 'visible_secret_chase', 'apparent_win_instant_loss', 'noob_vs_smart'], fixedStructure: 'The causal prop is always suspicious_button, the escalation prop is spark_coin, the loop is button_resets, the reversal is topple_onto.', previousErrors: i.constraints });
  }
  if (stage === 'plan') {
    const i = input as PlanInput;
    return JSON.stringify({ task: 'Stage B: fill the template slots with 7-12 beats. Follow the grammar order exactly; use the slot actions, effects and shot presets; beat ids b01..; set causeBeatId/resultBeatId per the template causal links.', idea: i.idea, template: i.template, slots: Object.fromEntries(i.template.grammar.map(([s]) => [s, SLOT_SPECS[s]])), registry: reg, previousErrors: i.constraints });
  }
  const i = input as RepairInput;
  return JSON.stringify({ task: 'Stage G repair: return ONLY patches for the beat fields named in the constraints (op "set" with beatId+field+value, or op "set_plan" field stagingVariant). Do not change anything else.', plan: i.plan, constraints: i.constraints, registry: reg, attempt: i.attempt });
}

abstract class HttpProvider implements StoryModelProvider {
  abstract readonly name: string;
  readonly model: string;
  protected transport: TransportOptions;
  protected meta: CallMeta | null = null;
  constructor(model: string, transport: TransportOptions) { this.model = model; this.transport = transport; }
  lastCall(): CallMeta | null { return this.meta; }
  protected abstract complete(stage: string, user: string, schema: Record<string, unknown>, schemaName: string): Promise<{ value: unknown; tokensIn: number; tokensOut: number; attempts: number }>;
  private async run(stage: 'normalize' | 'plan' | 'repair', input: NormalizeInput | PlanInput | RepairInput, schema: Record<string, unknown>, name: string): Promise<unknown> {
    const t0 = performance.now();
    const user = prompts(stage, input);
    try {
      const r = await this.complete(stage, user, schema, name);
      this.meta = { stage, ms: performance.now() - t0, tokensIn: r.tokensIn, tokensOut: r.tokensOut, ok: true, model: this.model, attempts: r.attempts };
      return r.value;
    } catch (e) {
      this.meta = { stage, ms: performance.now() - t0, tokensIn: estimateTokens(SYSTEM + user), tokensOut: 0, ok: false, error: String((e as Error).message), model: this.model, attempts: this.transport.maxRetries + 1 };
      throw e;
    }
  }
  normalizeIdea(i: NormalizeInput) { return this.run('normalize', i, toJsonSchema(normalizedIdeaSchema(i.registry.ids), true), 'normalized_idea'); }
  planBeats(i: PlanInput) { return this.run('plan', i, toJsonSchema(beatPlanSchema(i.registry.ids), true), 'visual_beat_plan'); }
  repairPlan(i: RepairInput) { return this.run('repair', i, toJsonSchema(RepairResponseSchema, true), 'repair_patches'); }
}

/** OpenAI-compatible Chat Completions (response_format json_schema). Works with any compatible base URL. */
export class OpenAICompatibleProvider extends HttpProvider {
  readonly name = 'openai';
  private baseUrl: string; private apiKey: string;
  constructor(o: { baseUrl: string; apiKey: string; model: string } & TransportOptions) { super(o.model, o); this.baseUrl = o.baseUrl.replace(/\/$/, ''); this.apiKey = o.apiKey; }
  protected async complete(_stage: string, user: string, schema: Record<string, unknown>, name: string) {
    const { json, attempts } = await postJson(`${this.baseUrl}/chat/completions`, {
      model: this.model, temperature: 0, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
      response_format: { type: 'json_schema', json_schema: { name, strict: false, schema } },
    }, { authorization: `Bearer ${this.apiKey}` }, this.transport);
    const content = json?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new ProviderError('malformed', 'response has no message content');
    let value: unknown;
    try { value = JSON.parse(content); } catch { throw new ProviderError('malformed', `model content is not JSON: ${content.slice(0, 80)}`); }
    return { value, tokensIn: json?.usage?.prompt_tokens ?? estimateTokens(SYSTEM + user), tokensOut: json?.usage?.completion_tokens ?? estimateTokens(content), attempts };
  }
}

/** Anthropic Messages API with a single forced tool whose input_schema is the stage schema. */
export class AnthropicProvider extends HttpProvider {
  readonly name = 'anthropic';
  private baseUrl: string; private apiKey: string;
  constructor(o: { baseUrl?: string; apiKey: string; model: string } & TransportOptions) { super(o.model, o); this.baseUrl = (o.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, ''); this.apiKey = o.apiKey; }
  protected async complete(_stage: string, user: string, schema: Record<string, unknown>, name: string) {
    const { json, attempts } = await postJson(`${this.baseUrl}/v1/messages`, {
      model: this.model, max_tokens: 4096, temperature: 0, system: SYSTEM, messages: [{ role: 'user', content: user }],
      tools: [{ name, description: `Emit the ${name} object`, input_schema: schema }], tool_choice: { type: 'tool', name },
    }, { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' }, this.transport);
    const block = (json?.content ?? []).find((b: any) => b.type === 'tool_use');
    if (!block) throw new ProviderError('malformed', 'response has no tool_use block');
    return { value: block.input, tokensIn: json?.usage?.input_tokens ?? estimateTokens(SYSTEM + user), tokensOut: json?.usage?.output_tokens ?? 0, attempts };
  }
}

/** estimated prompt size per stage (for cost projections when no real run is possible) */
export function promptSizes(input: PlanInput): Record<string, number> {
  return { normalize: estimateTokens(SYSTEM + prompts('normalize', { request: input.request, registry: input.registry, constraints: [] })), plan: estimateTokens(SYSTEM + prompts('plan', input)) };
}
