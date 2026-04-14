import { defaultModelFor, isProviderId, MODELS, type ProviderId } from './providers';

const STORAGE_KEY = 'vibe-land:godmode-ai-settings:v1';

export type AiChatSettings = {
  provider: ProviderId;
  model: string;
  apiKeys: Partial<Record<ProviderId, string>>;
};

export function defaultSettings(): AiChatSettings {
  return {
    provider: 'anthropic',
    model: defaultModelFor('anthropic'),
    apiKeys: {},
  };
}

function safeStorage(): Storage | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadSettings(): AiChatSettings {
  const storage = safeStorage();
  if (!storage) {
    return defaultSettings();
  }
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) {
      return defaultSettings();
    }
    const parsed = JSON.parse(raw) as Partial<AiChatSettings> | null;
    if (!parsed || typeof parsed !== 'object') {
      return defaultSettings();
    }
    const provider: ProviderId = isProviderId(parsed.provider) ? parsed.provider : 'anthropic';
    const candidateModel = typeof parsed.model === 'string' ? parsed.model : defaultModelFor(provider);
    // If the persisted model isn't in the known list, still allow it (custom IDs).
    const model = candidateModel || defaultModelFor(provider);
    const apiKeys: Partial<Record<ProviderId, string>> = {};
    if (parsed.apiKeys && typeof parsed.apiKeys === 'object') {
      for (const key of Object.keys(MODELS) as ProviderId[]) {
        const value = (parsed.apiKeys as Record<string, unknown>)[key];
        if (typeof value === 'string' && value.length > 0) {
          apiKeys[key] = value;
        }
      }
    }
    return { provider, model, apiKeys };
  } catch {
    return defaultSettings();
  }
}

export function saveSettings(settings: AiChatSettings): void {
  const storage = safeStorage();
  if (!storage) {
    return;
  }
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Ignore quota / privacy errors — settings just won't persist.
  }
}

export function clearStoredApiKeys(): void {
  const storage = safeStorage();
  if (!storage) {
    return;
  }
  try {
    const current = loadSettings();
    saveSettings({ ...current, apiKeys: {} });
  } catch {
    storage.removeItem(STORAGE_KEY);
  }
}
