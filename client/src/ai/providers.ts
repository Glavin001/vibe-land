import type { LanguageModel } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';

export type ProviderId = 'openai' | 'anthropic' | 'google';

// NOTE: model IDs drift over time. These are sensible defaults that the
// user can override at runtime via the chat settings UI.
export const MODELS: Record<ProviderId, string[]> = {
  openai: ['gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-4.1', 'gpt-4.1-mini'],
  anthropic: [
    'claude-opus-4-6',
    'claude-sonnet-4-6',
    'claude-haiku-4-5-20251001',
  ],
  google: ['gemini-2.5-pro', 'gemini-2.5-flash'],
};

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google Gemini',
};

export function isProviderId(value: unknown): value is ProviderId {
  return value === 'openai' || value === 'anthropic' || value === 'google';
}

export function defaultModelFor(provider: ProviderId): string {
  return MODELS[provider][0];
}

/**
 * Build a LanguageModel that talks directly to the provider from the browser.
 *
 * The user supplies their own API key (BYOK) — there is no backend proxy. We
 * pass `dangerouslyAllowBrowser`-style flags where each provider supports them
 * so the SDK doesn't refuse to run in a browser environment.
 */
export function createLanguageModel(
  provider: ProviderId,
  modelId: string,
  apiKey: string,
): LanguageModel {
  if (!apiKey) {
    throw new Error(`Missing API key for ${PROVIDER_LABELS[provider]}.`);
  }
  switch (provider) {
    case 'openai': {
      const client = createOpenAI({ apiKey });
      return client.chat(modelId);
    }
    case 'anthropic': {
      const client = createAnthropic({
        apiKey,
        // Required for the Anthropic Messages API to accept browser-origin
        // requests (CORS preflight). Without this header the call fails.
        headers: { 'anthropic-dangerous-direct-browser-access': 'true' },
      });
      return client(modelId);
    }
    case 'google': {
      const client = createGoogleGenerativeAI({ apiKey });
      return client(modelId);
    }
    default: {
      const exhaustive: never = provider;
      throw new Error(`Unknown provider: ${String(exhaustive)}`);
    }
  }
}
