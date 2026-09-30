// Provider orchestration. Offline generation is always authoritative; OpenRouter can only add validated intent.
import { generateOfflineBeatSheet, normalizeDirectorRequest, type DirectorMode, type DirectorProviderReport, type DirectorRequest, type DirectorResult, type ProviderAttempt } from './offline.ts';
import { OpenRouterIntentProvider, OpenRouterProviderError, type OpenRouterIntentOptions } from './openrouter.ts';
import type { DirectorIntent } from './intent.ts';

export interface DirectorIntentClient {
  readonly models: string[];
  infer(lines: string[]): Promise<{ intent: DirectorIntent; model: string; attempts: ProviderAttempt[] }>;
}
export interface DirectScriptOptions {
  provider?: DirectorMode;
  openrouter?: Omit<OpenRouterIntentOptions, 'apiKey'> & { apiKey?: string };
  /** Test/server injection seam; no live network is needed to exercise orchestration. */
  intentClient?: DirectorIntentClient;
}

export async function directScript(input: DirectorRequest, options: DirectScriptOptions = {}): Promise<DirectorResult> {
  const request = normalizeDirectorRequest(input);
  const requested = options.provider ?? 'offline';
  if (requested === 'offline') return generateOfflineBeatSheet(request, { provider: { requested, used: 'offline', attempts: [] } });

  const key = options.openrouter?.apiKey?.trim();
  if (!options.intentClient && !key) {
    if (requested === 'openrouter') throw new OpenRouterProviderError('config', 'OPENROUTER_API_KEY is not set');
    return generateOfflineBeatSheet(request, { provider: fallbackReport(requested, [], 'openrouter_key_missing', 'OPENROUTER_API_KEY is not set; used deterministic offline Director') });
  }

  try {
    const client = options.intentClient ?? new OpenRouterIntentProvider({ ...options.openrouter, apiKey: key! });
    const inferred = await client.infer(request.lines);
    const provider: DirectorProviderReport = { requested, used: 'openrouter', model: inferred.model, attempts: sanitizeAttempts(inferred.attempts, key) };
    return generateOfflineBeatSheet(request, { intent: inferred.intent, provider, library: options.openrouter?.library });
  } catch (error) {
    if (requested === 'openrouter') throw error;
    const attempts = sanitizeAttempts(error instanceof OpenRouterProviderError ? error.attempts : [], key);
    const code = error instanceof OpenRouterProviderError ? `openrouter_${error.code}` : 'openrouter_failed';
    const reason = error instanceof OpenRouterProviderError ? `${error.message}; used deterministic offline Director` : 'OpenRouter intent generation failed; used deterministic offline Director';
    return generateOfflineBeatSheet(request, { provider: fallbackReport(requested, attempts, code, reason), library: options.openrouter?.library });
  }
}

function fallbackReport(requested: DirectorMode, attempts: ProviderAttempt[], code: string, message: string): DirectorProviderReport {
  return { requested, used: 'offline', attempts, fallback: { code, message } };
}

function sanitizeAttempts(attempts: ProviderAttempt[], secret: string | undefined): ProviderAttempt[] {
  if (!secret) return attempts;
  return attempts.map((attempt) => ({ ...attempt, ...(attempt.detail ? { detail: attempt.detail.split(secret).join('[redacted]') } : {}) }));
}