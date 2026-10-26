/**
 * LLM provider configuration and a stubbed completion call.
 * Reads ANTHROPIC_API_KEY or OPENAI_API_KEY from the environment; no network
 * requests are made yet.
 */

export type LlmProvider = 'anthropic' | 'openai';

export interface LlmConfig {
  provider: LlmProvider;
  apiKey: string;
  model: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const anthropicKey = env.ANTHROPIC_API_KEY?.trim();
  if (anthropicKey) {
    return {
      provider: 'anthropic',
      apiKey: anthropicKey,
      model: env.TESTPILOT_MODEL || 'claude-sonnet-4-5'
    };
  }

  const openaiKey = env.OPENAI_API_KEY?.trim();
  if (openaiKey) {
    return {
      provider: 'openai',
      apiKey: openaiKey,
      model: env.TESTPILOT_MODEL || 'gpt-4.1'
    };
  }

  throw new Error('Set ANTHROPIC_API_KEY or OPENAI_API_KEY');
}

export async function complete(_prompt: string, _config?: LlmConfig): Promise<string> {
  throw new Error('Not implemented: llm/client.complete');
}
