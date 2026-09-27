// Provider factory — configuration comes from environment variables only (see .env.example). No secrets in code.
import { RulesProvider } from './rules.ts';
import { FaultyProvider } from './mock.ts';
import { AnthropicProvider, OpenAICompatibleProvider } from './llm.ts';
import { ProviderError, type StoryModelProvider } from './types.ts';

export function createProvider(env: Record<string, string | undefined>, override?: string): StoryModelProvider {
  const kind = override ?? env.BLOCKSPARK_LLM_PROVIDER ?? 'rules';
  const transport = { timeoutMs: Number(env.BLOCKSPARK_LLM_TIMEOUT_MS ?? 45000), maxRetries: Number(env.BLOCKSPARK_LLM_MAX_RETRIES ?? 2), backoffMs: Number(env.BLOCKSPARK_LLM_BACKOFF_MS ?? 1000) };
  if (kind === 'rules') return new RulesProvider();
  if (kind.startsWith('faulty')) return new FaultyProvider(new RulesProvider(), Number(kind.split(':')[1] ?? env.BLOCKSPARK_FAULT_RATE ?? 0.5), Number(env.BLOCKSPARK_FAULT_SEED ?? 7));
  if (kind === 'openai') {
    const apiKey = env.OPENAI_API_KEY;
    if (!apiKey) throw new ProviderError('config', 'OPENAI_API_KEY is not set');
    return new OpenAICompatibleProvider({ baseUrl: env.BLOCKSPARK_LLM_BASE_URL ?? 'https://api.openai.com/v1', apiKey, model: env.BLOCKSPARK_LLM_MODEL ?? 'gpt-4o-mini', ...transport });
  }
  if (kind === 'anthropic') {
    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new ProviderError('config', 'ANTHROPIC_API_KEY is not set');
    return new AnthropicProvider({ baseUrl: env.BLOCKSPARK_LLM_BASE_URL, apiKey, model: env.BLOCKSPARK_LLM_MODEL ?? 'claude-sonnet-4-5', ...transport });
  }
  throw new ProviderError('config', `unknown provider "${kind}" (rules | faulty:<rate> | openai | anthropic)`);
}

export { RulesProvider, FaultyProvider, OpenAICompatibleProvider, AnthropicProvider };
