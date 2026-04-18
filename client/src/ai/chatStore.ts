import { makeChatId, type ChatMessage, type ChatPart, type ChatRole, type ChatTextPart, type ChatUsage } from './chatTypes';

export type PersistedChatState = {
  messages: ChatMessage[];
  pendingHumanEdits: string[];
};

export type ChatMeta = {
  id: string;
  createdAt: number;
  updatedAt: number;
  preview: string;
  messageCount: number;
};

type StoredChat = {
  id: string;
  createdAt: number;
  messages: ChatMessage[];
  pendingHumanEdits: string[];
};

const DB_NAME = 'vibe-land-godmode-chats';
const DB_VERSION = 1;
const STORE_CHATS = 'chats';
const STORE_META = 'chatMeta';
const STORE_DRAFTS = 'drafts';
const STORE_SETTINGS = 'settings';

const ACTIVE_CHAT_SETTING_KEY = 'activeChatId';
const LEGACY_MIGRATION_FLAG = 'legacyChatMigrated';

const LEGACY_CHAT_KEY = 'vibe-land:godmode-ai-chat:v1';
const LEGACY_DRAFT_KEY = 'vibe-land:godmode-ai-chat-draft:v1';

const PREVIEW_MAX_LENGTH = 120;

let dbPromise: Promise<IDBDatabase | null> | null = null;
let migrationPromise: Promise<void> | null = null;
const listeners = new Set<() => void>();

function openChatDatabase(): Promise<IDBDatabase | null> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      if (typeof window === 'undefined' || !('indexedDB' in window)) {
        resolve(null);
        return;
      }
      const request = window.indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_CHATS)) db.createObjectStore(STORE_CHATS);
        if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META);
        if (!db.objectStoreNames.contains(STORE_DRAFTS)) db.createObjectStore(STORE_DRAFTS);
        if (!db.objectStoreNames.contains(STORE_SETTINGS)) db.createObjectStore(STORE_SETTINGS);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        console.warn('Failed to open Godmode chat IndexedDB', request.error);
        resolve(null);
      };
    });
  }
  return dbPromise;
}

async function idbGet<T>(storeName: string, key: IDBValidKey): Promise<T | null> {
  const db = await openChatDatabase();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).get(key);
      req.onsuccess = () => resolve((req.result as T | undefined) ?? null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function idbPut(storeName: string, key: IDBValidKey, value: unknown): Promise<void> {
  const db = await openChatDatabase();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

async function idbDelete(storeName: string, key: IDBValidKey): Promise<void> {
  const db = await openChatDatabase();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

async function idbGetAll<T>(storeName: string): Promise<T[]> {
  const db = await openChatDatabase();
  if (!db) return [];
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => resolve((req.result as T[]) ?? []);
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

export function subscribeToChats(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emitChatsChanged(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // ignore listener errors
    }
  }
}

function safeLocalStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readLegacyChatState(): PersistedChatState | null {
  const storage = safeLocalStorage();
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(LEGACY_CHAT_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedChatState> | null;
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      messages: normalizeMessages(parsed.messages),
      pendingHumanEdits: normalizePendingHumanEdits(parsed.pendingHumanEdits),
    };
  } catch {
    return null;
  }
}

function readLegacyComposerDraft(): string {
  const storage = safeLocalStorage();
  if (!storage) return '';
  try {
    const raw = storage.getItem(LEGACY_DRAFT_KEY);
    return typeof raw === 'string' ? raw : '';
  } catch {
    return '';
  }
}

function clearLegacyChat(): void {
  const storage = safeLocalStorage();
  if (!storage) return;
  try {
    storage.removeItem(LEGACY_CHAT_KEY);
    storage.removeItem(LEGACY_DRAFT_KEY);
  } catch {
    // ignore
  }
}

async function ensureLegacyMigration(): Promise<void> {
  if (!migrationPromise) {
    migrationPromise = (async () => {
      const alreadyMigrated = await idbGet<boolean>(STORE_SETTINGS, LEGACY_MIGRATION_FLAG);
      if (alreadyMigrated) return;
      const legacy = readLegacyChatState();
      if (legacy && legacy.messages.length > 0) {
        const id = makeChatId();
        const now = Date.now();
        const stored: StoredChat = {
          id,
          createdAt: now,
          messages: legacy.messages,
          pendingHumanEdits: legacy.pendingHumanEdits,
        };
        await idbPut(STORE_CHATS, id, stored);
        await idbPut(STORE_META, id, computeMeta(stored));
        await idbPut(STORE_SETTINGS, ACTIVE_CHAT_SETTING_KEY, id);
        const draft = readLegacyComposerDraft();
        if (draft) {
          await idbPut(STORE_DRAFTS, id, draft);
        }
      }
      await idbPut(STORE_SETTINGS, LEGACY_MIGRATION_FLAG, true);
      clearLegacyChat();
    })();
  }
  return migrationPromise;
}

function computePreview(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const text = msg.parts
      .filter((p): p is ChatTextPart => p.type === 'text')
      .map((p) => p.text)
      .join(' ')
      .trim();
    if (text.length > 0) {
      return text.length > PREVIEW_MAX_LENGTH ? `${text.slice(0, PREVIEW_MAX_LENGTH)}…` : text;
    }
  }
  return '';
}

function computeMeta(stored: StoredChat): ChatMeta {
  const updatedAt = stored.messages.length > 0
    ? Math.max(...stored.messages.map((m) => m.createdAt))
    : stored.createdAt;
  return {
    id: stored.id,
    createdAt: stored.createdAt,
    updatedAt,
    preview: computePreview(stored.messages),
    messageCount: stored.messages.length,
  };
}

export async function listChatMeta(): Promise<ChatMeta[]> {
  await ensureLegacyMigration();
  const items = await idbGetAll<unknown>(STORE_META);
  const metas: ChatMeta[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.id !== 'string') continue;
    const createdAt = typeof candidate.createdAt === 'number' ? candidate.createdAt : 0;
    const updatedAt = typeof candidate.updatedAt === 'number' ? candidate.updatedAt : createdAt;
    const messageCount = typeof candidate.messageCount === 'number' ? candidate.messageCount : 0;
    if (messageCount === 0) continue;
    metas.push({
      id: candidate.id,
      createdAt,
      updatedAt,
      preview: typeof candidate.preview === 'string' ? candidate.preview : '',
      messageCount,
    });
  }
  metas.sort((a, b) => b.updatedAt - a.updatedAt);
  return metas;
}

export async function loadChat(id: string): Promise<PersistedChatState> {
  await ensureLegacyMigration();
  const stored = await idbGet<unknown>(STORE_CHATS, id);
  if (!stored || typeof stored !== 'object') {
    return { messages: [], pendingHumanEdits: [] };
  }
  const candidate = stored as Partial<StoredChat>;
  return {
    messages: normalizeMessages(candidate.messages),
    pendingHumanEdits: normalizePendingHumanEdits(candidate.pendingHumanEdits),
  };
}

export async function saveChat(id: string, state: PersistedChatState): Promise<void> {
  await ensureLegacyMigration();
  if (state.messages.length === 0 && state.pendingHumanEdits.length === 0) {
    // Don't materialize an empty chat in the list. If a chat existed before
    // and is now empty, leave its prior data alone (caller can deleteChat).
    return;
  }
  const existing = (await idbGet<StoredChat>(STORE_CHATS, id)) as StoredChat | null;
  const createdAt = existing?.createdAt ?? Date.now();
  const stored: StoredChat = {
    id,
    createdAt,
    messages: state.messages,
    pendingHumanEdits: state.pendingHumanEdits,
  };
  await idbPut(STORE_CHATS, id, stored);
  await idbPut(STORE_META, id, computeMeta(stored));
  emitChatsChanged();
}

export async function deleteChat(id: string): Promise<void> {
  await ensureLegacyMigration();
  await Promise.all([
    idbDelete(STORE_CHATS, id),
    idbDelete(STORE_META, id),
    idbDelete(STORE_DRAFTS, id),
  ]);
  emitChatsChanged();
}

export async function loadActiveChatId(): Promise<string | null> {
  await ensureLegacyMigration();
  const value = await idbGet<unknown>(STORE_SETTINGS, ACTIVE_CHAT_SETTING_KEY);
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export async function saveActiveChatId(id: string): Promise<void> {
  await ensureLegacyMigration();
  await idbPut(STORE_SETTINGS, ACTIVE_CHAT_SETTING_KEY, id);
}

export async function loadComposerDraft(chatId: string): Promise<string> {
  await ensureLegacyMigration();
  const value = await idbGet<unknown>(STORE_DRAFTS, chatId);
  return typeof value === 'string' ? value : '';
}

export async function saveComposerDraft(chatId: string, draft: string): Promise<void> {
  await ensureLegacyMigration();
  if (draft.length === 0) {
    await idbDelete(STORE_DRAFTS, chatId);
    return;
  }
  await idbPut(STORE_DRAFTS, chatId, draft);
}

export async function clearComposerDraft(chatId: string): Promise<void> {
  await ensureLegacyMigration();
  await idbDelete(STORE_DRAFTS, chatId);
}

function normalizeMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return [];
  const messages: ChatMessage[] = [];
  for (const item of value) {
    const normalized = normalizeMessage(item);
    if (normalized) messages.push(normalized);
  }
  return messages;
}

function normalizeMessage(value: unknown): ChatMessage | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const role = normalizeRole(candidate.role);
  const id = typeof candidate.id === 'string' ? candidate.id : null;
  const createdAt = typeof candidate.createdAt === 'number' && Number.isFinite(candidate.createdAt)
    ? candidate.createdAt
    : null;
  const parts = normalizeParts(candidate.parts);
  if (!role || !id || createdAt === null || !parts) return null;
  const message: ChatMessage = { id, role, createdAt, parts };
  if (typeof candidate.hiddenContext === 'string' && candidate.hiddenContext.length > 0) {
    message.hiddenContext = candidate.hiddenContext;
  }
  const usage = normalizeUsage(candidate.usage);
  if (usage) message.usage = usage;
  return message;
}

function normalizeRole(value: unknown): ChatRole | null {
  return value === 'user' || value === 'assistant' ? value : null;
}

function normalizeParts(value: unknown): ChatPart[] | null {
  if (!Array.isArray(value)) return null;
  const parts: ChatPart[] = [];
  for (const item of value) {
    const normalized = normalizePart(item);
    if (normalized) parts.push(normalized);
  }
  return parts;
}

function normalizePart(value: unknown): ChatPart | null {
  if (!value || typeof value !== 'object') return null;
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
  if (!value || typeof value !== 'object') return null;
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
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}
