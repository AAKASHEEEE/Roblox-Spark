// OpenRouter intent provider. It uses only free model routes and returns untrusted compact JSON,
// which is strictly validated before the deterministic Director may consume it.
import { LIBRARY, type Library, type LibraryEntry } from '../../library/src/ids.ts';
import { directorIntentJsonSchema, validateDirectorIntent, type DirectorIntent } from './intent.ts';
import { splitDirectorClauses, type ProviderAttempt } from './offline.ts';

export const DEFAULT_OPENROUTER_MODELS = ['openrouter/free'] as const;
const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

export interface OpenRouterIntentOptions {
  apiKey: string;
  models?: string[];
  timeoutMs?: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  library?: Library;
}
export interface OpenRouterIntentResult { intent: DirectorIntent; model: string; attempts: ProviderAttempt[] }

export class OpenRouterProviderError extends Error {
  readonly code: 'config' | 'auth' | 'http' | 'exhausted';
  readonly attempts: ProviderAttempt[];
  constructor(code: OpenRouterProviderError['code'], message: string, attempts: ProviderAttempt[] = []) {
    super(message); this.name = 'OpenRouterProviderError'; this.code = code; this.attempts = attempts;
  }
}

interface Completion { content: string }
class AttemptError extends Error {
  readonly outcome: ProviderAttempt['outcome'];
  readonly retryable: boolean;
  constructor(outcome: ProviderAttempt['outcome'], message: string, retryable: boolean) { super(message); this.outcome = outcome; this.retryable = retryable; }
}

export function normalizeFreeModelList(models: string[] | undefined): string[] {
  const out = [...new Set((models?.length ? models : [...DEFAULT_OPENROUTER_MODELS]).map((x) => x.trim()).filter(Boolean))];
  if (!out.length) throw new OpenRouterProviderError('config', 'OpenRouter model list is empty');
  for (const model of out) {
    if (model !== 'openrouter/free' && !model.endsWith(':free')) throw new OpenRouterProviderError('config', `OpenRouter model "${model}" is not a free-only route (expected :free or openrouter/free)`);
  }
  return out;
}

const SYSTEM = [
  'You extract compact animation staging intent from script lines.',
  'Return JSON only, exactly matching the supplied strict schema; do not rewrite, summarize, add, or remove script lines.',
  'Use short catalog ids or tags when possible. Use an empty string/array when there is no clue.',
  'The line field is the zero-based input line index, in order.',
  'The shots list contains sub-shot suggestions only: use strictly increasing supplied clause indexes above zero and exact camera/entity catalog ids; use an empty list or at most four rows.',
  'Never include dialogue, captions, timing, markdown, or extra keys.',
].join(' ');

function catalogForPrompt(lib: Library): Record<string, Array<{ id: string; tags: string[]; status: string }>> {
  const kinds = ['sets', 'characters', 'actions', 'props', 'cameraRecipes'] as const;
  return Object.fromEntries(kinds.map((kind) => [kind, (lib[kind] as LibraryEntry[]).map((e) => ({ id: e.id, tags: e.tags, status: e.status }))]));
}
function promptLines(lines: string[], lib: Library): Array<{ line: number; text: string; clauses: Array<{ clause: number; text: string }> }> {
  return lines.map((text, line) => ({ line, text, clauses: splitDirectorClauses(text, lib).map((clause) => ({ clause: clause.index, text: clause.text })) }));
}
function initialPrompt(lines: string[], lib: Library): string {
  return JSON.stringify({ task: 'Extract one global set query, global character queries, one action/prop row per line, and optional catalog-only sub-shot suggestions for useful later clauses.', lines: promptLines(lines, lib), catalog: catalogForPrompt(lib) });
}
function repairPrompt(lines: string[], issueCount: number, lib: Library): string {
  // Regenerate from trusted input instead of echoing invalid model output, which could reflect the bearer credential.
  return JSON.stringify({ task: 'Regenerate the complete corrected JSON object once. The previous output failed strict validation.', lines: promptLines(lines, lib), validationIssueCount: issueCount, catalog: catalogForPrompt(lib) });
}

export class OpenRouterIntentProvider {
  readonly models: string[];
  private apiKey: string;
  private timeoutMs: number;
  private baseUrl: string;
  private fetchImpl: typeof fetch;
  private library: Library;

  constructor(options: OpenRouterIntentOptions) {
    if (!options.apiKey?.trim()) throw new OpenRouterProviderError('config', 'OPENROUTER_API_KEY is not set');
    this.apiKey = options.apiKey.trim();
    this.models = normalizeFreeModelList(options.models);
    this.timeoutMs = options.timeoutMs ?? 12_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new OpenRouterProviderError('config', 'OpenRouter timeout must be greater than zero');
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.library = options.library ?? LIBRARY;
  }

  private async complete(model: string, user: string): Promise<Completion> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify({
            model, temperature: 0, max_tokens: 8000,
            messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
            response_format: { type: 'json_schema', json_schema: { name: 'director_intent', strict: true, schema: directorIntentJsonSchema() } },
          }),
          signal: controller.signal,
        });
      } catch (error) {
        if ((error as Error)?.name === 'AbortError') throw new AttemptError('timeout', `timed out after ${this.timeoutMs} ms`, true);
        throw new AttemptError('network', 'network request failed', true);
      }
      // Drain the body, but never include it in errors: a gateway must not be able to reflect credentials into logs/reports.
      let text: string;
      try { text = await response.text(); }
      catch (error) {
        if ((error as Error)?.name === 'AbortError') throw new AttemptError('timeout', `timed out after ${this.timeoutMs} ms`, true);
        throw new AttemptError('network', 'failed while reading response', true);
      }
      if (response.status === 429) throw new AttemptError('rate_limited', 'HTTP 429 rate limited', true);
      if (response.status === 401 || response.status === 403) throw new AttemptError('http', `HTTP ${response.status} authentication rejected`, false);
      if (!response.ok) throw new AttemptError('http', `HTTP ${response.status}`, response.status >= 500 || response.status === 408);
      let envelope: unknown;
      try { envelope = JSON.parse(text); } catch { throw new AttemptError('malformed', 'OpenRouter response body is not JSON', true); }
      const content = (envelope as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new AttemptError('malformed', 'OpenRouter response has no string message content', true);
      return { content };
    } finally { clearTimeout(timer); }
  }

  async infer(lines: string[]): Promise<OpenRouterIntentResult> {
    const attempts: ProviderAttempt[] = [];
    let repairUsed = false;
    const firstPrompt = initialPrompt(lines, this.library);
    for (const model of this.models) {
      let completion: Completion;
      try { completion = await this.complete(model, firstPrompt); }
      catch (error) {
        const e = error as AttemptError;
        attempts.push({ model, phase: 'initial', outcome: e.outcome ?? 'network', detail: e.message });
        if (!e.retryable) throw new OpenRouterProviderError(e.message.includes('authentication') ? 'auth' : 'http', e.message, attempts);
        continue; // timeout / 429 / network / 5xx fail over to the next configured free model
      }
      const first = parseIntentContent(completion.content, lines, this.library);
      if (first.ok) {
        attempts.push({ model, phase: 'initial', outcome: 'ok' });
        return { intent: first.value, model, attempts };
      }
      attempts.push({ model, phase: 'initial', outcome: 'invalid', detail: summarizeIssues(first.issues) });
      if (repairUsed) continue;
      repairUsed = true;
      let repaired: Completion;
      try { repaired = await this.complete(model, repairPrompt(lines, first.issues.length, this.library)); }
      catch (error) {
        const e = error as AttemptError;
        attempts.push({ model, phase: 'repair', outcome: e.outcome ?? 'network', detail: e.message });
        if (!e.retryable) throw new OpenRouterProviderError(e.message.includes('authentication') ? 'auth' : 'http', e.message, attempts);
        continue;
      }
      const second = parseIntentContent(repaired.content, lines, this.library);
      if (second.ok) {
        attempts.push({ model, phase: 'repair', outcome: 'ok' });
        return { intent: second.value, model, attempts };
      }
      attempts.push({ model, phase: 'repair', outcome: 'invalid', detail: summarizeIssues(second.issues) });
    }
    throw new OpenRouterProviderError('exhausted', `all ${this.models.length} configured free OpenRouter model(s) failed`, attempts);
  }
}

type Parsed = { ok: true; value: DirectorIntent } | { ok: false; issues: Array<{ path: string; message: string }> };
function parseIntentContent(content: string, lines: string[], lib: Library): Parsed {
  let raw: unknown;
  try { raw = JSON.parse(content); }
  catch { return { ok: false, issues: [{ path: '$', message: 'model content is not JSON' }] }; }
  const checked = validateDirectorIntent(raw, lines.length, lines.map((line) => splitDirectorClauses(line, lib).length));
  return checked.ok ? { ok: true, value: checked.value! } : { ok: false, issues: checked.issues };
}
function summarizeIssues(issues: Array<{ path: string; message: string }>): string {
  // Do not persist model-controlled paths/keys: an endpoint could reflect the bearer credential as an unknown key.
  return `${issues.length} compact-intent validation issue(s)`;
}
