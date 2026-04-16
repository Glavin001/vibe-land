import type { ChatMessage, ChatPart, ChatRole, ChatUsage } from './chatTypes';

const CHAT_STORAGE_KEY = 'vibe-land:godmode-ai-chat:v1';
const CHAT_COMPOSER_DRAFT_KEY = 'vibe-land:godmode-ai-chat-draft:v1';

export type PersistedChatState = {
  messages: ChatMessage[];
  pendingHumanEdits: string[];
};

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

export function loadPersistedChatState(): PersistedChatState {
  const storage = safeStorage();
  if (!storage) {
    return { messages: [], pendingHumanEdits: [] };
  }
  try {
    const raw = storage.getItem(CHAT_STORAGE_KEY);
    if (!raw) {
      return { messages: [], pendingHumanEdits: [] };
    }
    const parsed = JSON.parse(raw) as Partial<PersistedChatState> | null;
    if (!parsed || typeof parsed !== 'object') {
      return { messages: [], pendingHumanEdits: [] };
    }
    return {
      messages: normalizeMessages(parsed.messages),
      pendingHumanEdits: normalizePendingHumanEdits(parsed.pendingHumanEdits),
    };
  } catch {
    return { messages: [], pendingHumanEdits: [] };
  }
}

export function savePersistedChatState(state: PersistedChatState): void {
  const storage = safeStorage();
  if (!storage) {
    return;
  }
  try {
    storage.setItem(CHAT_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore quota/privacy errors — chat just won't persist.
  }
}

export function clearPersistedChatState(): void {
  const storage = safeStorage();
  if (!storage) {
    return;
  }
  try {
    storage.removeItem(CHAT_STORAGE_KEY);
  } catch {
    // Ignore storage errors.
  }
}

export function loadPersistedComposerDraft(): string {
  const storage = safeStorage();
  if (!storage) {
    return '';
  }
  try {
    const raw = storage.getItem(CHAT_COMPOSER_DRAFT_KEY);
    return typeof raw === 'string' ? raw : '';
  } catch {
    return '';
  }
}

export function savePersistedComposerDraft(draft: string): void {
  const storage = safeStorage();
  if (!storage) {
    return;
  }
  try {
    if (draft.length === 0) {
      storage.removeItem(CHAT_COMPOSER_DRAFT_KEY);
      return;
    }
    storage.setItem(CHAT_COMPOSER_DRAFT_KEY, draft);
  } catch {
    // Ignore quota/privacy errors — draft just won't persist.
  }
}

export function clearPersistedComposerDraft(): void {
  const storage = safeStorage();
  if (!storage) {
    return;
  }
  try {
    storage.removeItem(CHAT_COMPOSER_DRAFT_KEY);
  } catch {
    // Ignore storage errors.
  }
}

function normalizeMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const messages: ChatMessage[] = [];
  for (const item of value) {
    const normalized = normalizeMessage(item);
    if (normalized) {
      messages.push(normalized);
    }
  }
  return messages;
}

function normalizeMessage(value: unknown): ChatMessage | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const role = normalizeRole(candidate.role);
  const id = typeof candidate.id === 'string' ? candidate.id : null;
  const createdAt = typeof candidate.createdAt === 'number' && Number.isFinite(candidate.createdAt)
    ? candidate.createdAt
    : null;
  const parts = normalizeParts(candidate.parts);
  if (!role || !id || createdAt === null || !parts) {
    return null;
  }
  const message: ChatMessage = { id, role, createdAt, parts };
  if (typeof candidate.hiddenContext === 'string' && candidate.hiddenContext.length > 0) {
    message.hiddenContext = candidate.hiddenContext;
  }
  const usage = normalizeUsage(candidate.usage);
  if (usage) {
    message.usage = usage;
  }
  return message;
}

function normalizeRole(value: unknown): ChatRole | null {
  return value === 'user' || value === 'assistant' ? value : null;
}

function normalizeParts(value: unknown): ChatPart[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const parts: ChatPart[] = [];
  for (const item of value) {
    const normalized = normalizePart(item);
    if (normalized) {
      parts.push(normalized);
    }
  }
  return parts;
}

function normalizePart(value: unknown): ChatPart | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  switch (candidate.type) {
    case 'text':
      return typeof candidate.text === 'string' ? { type: 'text', text: candidate.text } : null;
    case 'reasoning':
      return typeof candidate.text === 'string' ? { type: 'reasoning', text: candidate.text } : null;
    case 'tool-call':
      return typeof candidate.toolCallId === 'string' && typeof candidate.toolName === 'string'
        ? {
          type: 'tool-call',
          toolCallId: candidate.toolCallId,
          toolName: candidate.toolName,
          input: candidate.input,
        }
        : null;
    case 'tool-result':
      return typeof candidate.toolCallId === 'string' && typeof candidate.toolName === 'string'
        ? {
          type: 'tool-result',
          toolCallId: candidate.toolCallId,
          toolName: candidate.toolName,
          output: candidate.output,
          isError: candidate.isError === true ? true : undefined,
        }
        : null;
    case 'image':
      return typeof candidate.dataUrl === 'string' && typeof candidate.mediaType === 'string'
        ? {
          type: 'image',
          dataUrl: candidate.dataUrl,
          mediaType: candidate.mediaType,
        }
        : null;
    default:
      return null;
  }
}

function normalizeUsage(value: unknown): ChatUsage | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.inputTokens === 'number'
    && Number.isFinite(candidate.inputTokens)
    && typeof candidate.outputTokens === 'number'
    && Number.isFinite(candidate.outputTokens)
    ? {
      inputTokens: candidate.inputTokens,
      outputTokens: candidate.outputTokens,
    }
    : null;
}

function normalizePendingHumanEdits(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}
