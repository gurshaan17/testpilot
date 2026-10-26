/**
 * Multi-provider LLM access via the Vercel AI SDK.
 * Model ids are defaults only; verify them against each provider's current
 * model list before relying on them in production.
 */
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import {
  NoObjectGeneratedError,
  Output,
  generateText,
  type LanguageModel,
  type LanguageModelUsage
} from 'ai';
import type { z } from 'zod';

export type ProviderName = 'anthropic' | 'openai' | 'google';

const DEFAULT_MODELS: Record<ProviderName, string> = {
  anthropic: 'claude-opus-5-5',
  openai: 'gpt-6-astra',
  google: 'gemini-4-argon'
};

interface ProviderSpec {
  envKey: string;
  modelEnvKey: string;
  create: (apiKey: string) => (modelId: string) => LanguageModel;
}

const PROVIDERS: Record<ProviderName, ProviderSpec> = {
  anthropic: {
    envKey: 'ANTHROPIC_API_KEY',
    modelEnvKey: 'TESTPILOT_MODEL_ANTHROPIC',
    create: (apiKey) => createAnthropic({ apiKey })
  },
  openai: {
    envKey: 'OPENAI_API_KEY',
    modelEnvKey: 'TESTPILOT_MODEL_OPENAI',
    create: (apiKey) => createOpenAI({ apiKey })
  },
  google: {
    envKey: 'GOOGLE_GENERATIVE_AI_API_KEY',
    modelEnvKey: 'TESTPILOT_MODEL_GOOGLE',
    create: (apiKey) => createGoogleGenerativeAI({ apiKey })
  }
};

const PROVIDER_ORDER: ProviderName[] = ['anthropic', 'openai', 'google'];

export interface ResolvedModel {
  provider: ProviderName;
  modelId: string;
  model: LanguageModel;
}

function apiKeyFor(provider: ProviderName): string | undefined {
  return process.env[PROVIDERS[provider].envKey]?.trim() || undefined;
}

function isProviderName(value: string): value is ProviderName {
  return PROVIDER_ORDER.includes(value as ProviderName);
}

function configuredProvider(): ProviderName | undefined {
  const value = process.env.TESTPILOT_PROVIDER?.trim();
  if (!value) return undefined;
  if (!isProviderName(value)) {
    throw new Error(
      `TESTPILOT_PROVIDER must be one of ${PROVIDER_ORDER.join(', ')} (got "${value}")`
    );
  }
  return value;
}

export function listAvailableProviders(): ProviderName[] {
  return PROVIDER_ORDER.filter((provider) => apiKeyFor(provider) !== undefined);
}

export function providerEnvKey(provider: ProviderName): string {
  return PROVIDERS[provider].envKey;
}

export function resolveModel(provider?: ProviderName, modelId?: string): ResolvedModel {
  const selected =
    provider ??
    configuredProvider() ??
    PROVIDER_ORDER.find((candidate) => apiKeyFor(candidate) !== undefined);

  if (!selected) {
    throw new Error(
      'No LLM provider configured. Set TESTPILOT_PROVIDER and one of ' +
        'ANTHROPIC_API_KEY, OPENAI_API_KEY, or GOOGLE_GENERATIVE_AI_API_KEY.'
    );
  }

  const spec = PROVIDERS[selected];
  const apiKey = apiKeyFor(selected);
  if (!apiKey) {
    throw new Error(`Missing ${spec.envKey} (required for provider "${selected}")`);
  }

  const resolvedModelId =
    modelId?.trim() || process.env[spec.modelEnvKey]?.trim() || DEFAULT_MODELS[selected];

  return {
    provider: selected,
    modelId: resolvedModelId,
    model: spec.create(apiKey)(resolvedModelId)
  };
}

export function getModel(provider?: ProviderName, modelId?: string): LanguageModel {
  return resolveModel(provider, modelId).model;
}

export interface GenerateStructuredOptions<T> {
  provider?: ProviderName;
  model?: string;
  system?: string;
  prompt: string;
  schema: z.ZodType<T>;
  temperature?: number;
}

export interface StructuredResult<T> {
  data: T;
  provider: ProviderName;
  model: string;
  usage: LanguageModelUsage;
}

async function structuredCall<T>(
  resolved: ResolvedModel,
  options: GenerateStructuredOptions<T>,
  prompt: string
): Promise<StructuredResult<T>> {
  const result = await generateText({
    model: resolved.model,
    system: options.system,
    prompt,
    temperature: options.temperature,
    // AI SDK v7 structured output: generateText + Output.object.
    output: Output.object({ schema: options.schema })
  });

  return {
    data: result.output,
    provider: resolved.provider,
    model: resolved.modelId,
    usage: result.usage
  };
}

export async function generateStructured<T>(
  options: GenerateStructuredOptions<T>
): Promise<StructuredResult<T>> {
  const resolved = resolveModel(options.provider, options.model);

  try {
    return await structuredCall(resolved, options, options.prompt);
  } catch (error) {
    if (!isSchemaValidationFailure(error)) throw error;

    const retryPrompt =
      `${options.prompt}\n\n` +
      'Your previous response failed schema validation with this error:\n' +
      `${errorMessage(error)}\n` +
      'Return only JSON that matches the requested schema.';
    return structuredCall(resolved, options, retryPrompt);
  }
}

export interface TextResult {
  text: string;
  provider: ProviderName;
  model: string;
  usage: LanguageModelUsage;
}

export async function generateTextSimple(options: {
  provider?: ProviderName;
  model?: string;
  system?: string;
  prompt: string;
}): Promise<TextResult> {
  const resolved = resolveModel(options.provider, options.model);
  const result = await generateText({
    model: resolved.model,
    system: options.system,
    prompt: options.prompt
  });

  return {
    text: result.text,
    provider: resolved.provider,
    model: resolved.modelId,
    usage: result.usage
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function isSchemaValidationFailure(error: unknown): boolean {
  if (NoObjectGeneratedError.isInstance(error)) return true;

  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    if (/TypeValidation|JSONParse|NoObjectGenerated/.test(current.name)) return true;
    current = current.cause;
  }

  return false;
}