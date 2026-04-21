import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { streamText, tool } from 'ai';
import {
  makeChatId,
  toModelMessages,
  type ChatMessage,
  type ChatImagePart,
  type ChatPart,
} from './chatTypes';
import { loadChat, saveChat } from './chatStore';
import { createLanguageModel, getThinkingProviderOptions, type ProviderId } from './providers';
import { SYSTEM_PROMPT } from './systemPrompt';
import { createExecuteJsTool, createRollbackTool } from './worldTool';
import { createCaptureScreenshotTool } from './screenshotTool';
import type { CaptureFunction } from '../scene/SceneCaptureController';
import type { WorldAccessors } from './worldToolHelpers';

export type ChatStatus = 'idle' | 'streaming' | 'error';

export type GodModeChatOptions = {
  chatId: string;
  accessors: WorldAccessors;
  provider: ProviderId;
  model: string;
  apiKey: string | undefined;
  captureScreenshot?: CaptureFunction;
};

export type ImageAttachment = { dataUrl: string; mediaType: string };

export type GodModeChatHandle = {
  messages: ChatMessage[];
  status: ChatStatus;
  error: Error | null;
  pendingHumanEdits: number;
  pendingHumanEditSummaries: string[];
  isLoaded: boolean;
  canSend: boolean;
  setMessages(messages: ChatMessage[]): void;
  sendMessage(text: string, attachments?: ImageAttachment[]): Promise<void>;
  regenerateMessage(messageId: string): Promise<void>;
  submitEditedMessage(messageId: string, text: string, attachments?: ImageAttachment[]): Promise<void>;
  stop(): void;
  pushHumanEdit(summary: string): void;
};

const MAX_TOOL_STEPS = 12;

export function useGodModeChat(options: GodModeChatOptions): GodModeChatHandle {
  const { chatId, accessors, provider, model, apiKey, captureScreenshot } = options;

  const [messages, setMessageState] = useState<ChatMessage[]>([]);
  const [pendingHumanEdits, setPendingHumanEdits] = useState<string[]>([]);
  const [status, setStatus] = useState<ChatStatus>('idle');
  const [error, setError] = useState<Error | null>(null);
  // Chat is "loaded" when the persisted state for the active chatId has been
  // hydrated into local state. We gate sends/saves on this so that switching
  // chats doesn't briefly overwrite the destination chat with empty data.
  const [loadedChatId, setLoadedChatId] = useState<string | null>(null);

  const accessorsRef = useRef(accessors);
  useEffect(() => {
    accessorsRef.current = accessors;
  }, [accessors]);

  const captureScreenshotRef = useRef(captureScreenshot);
  useEffect(() => {
    captureScreenshotRef.current = captureScreenshot;
  }, [captureScreenshot]);

  const abortRef = useRef<AbortController | null>(null);

  const stop = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, []);

  useEffect(() => () => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, []);

  const pushHumanEdit = useCallback((summary: string) => {
    if (!summary || summary.length === 0) return;
    setPendingHumanEdits((prev) => [...prev, summary]);
  }, []);

  // When chatId changes, abort any in-flight stream and (re)hydrate state
  // from storage. Race-protected via a cancellation flag.
  useEffect(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setStatus('idle');
    setError(null);
    setMessageState([]);
    setPendingHumanEdits([]);
    setLoadedChatId(null);
    let cancelled = false;
    void loadChat(chatId).then((state) => {
      if (cancelled) return;
      setMessageState(state.messages);
      setPendingHumanEdits(state.pendingHumanEdits);
      setLoadedChatId(chatId);
    });
    return () => {
      cancelled = true;
    };
  }, [chatId]);

  // Persist whenever local state changes — but only after the chat has been
  // loaded for the current chatId, to avoid clobbering it during the swap.
  useEffect(() => {
    if (loadedChatId !== chatId) return;
    void saveChat(chatId, { messages, pendingHumanEdits });
  }, [chatId, loadedChatId, messages, pendingHumanEdits]);

  const isLoaded = loadedChatId === chatId;
  const canSend = Boolean(apiKey) && status !== 'streaming' && isLoaded;

  const buildUserMessage = useCallback(
    (text: string, attachments?: ImageAttachment[], hiddenContext?: string): ChatMessage => {
      const parts: ChatPart[] = [{ type: 'text', text }];
      if (attachments && attachments.length > 0) {
        const imageParts: ChatImagePart[] = attachments.map((att) => ({
          type: 'image',
          dataUrl: att.dataUrl,
          mediaType: att.mediaType,
        }));
        parts.push(...imageParts);
      }
      return {
        id: makeChatId(),
        role: 'user',
        parts,
        createdAt: Date.now(),
        hiddenContext,
      };
    },
    [],
  );

  const ensureCanStartRequest = useCallback((): boolean => {
      if (!apiKey) {
        setError(new Error(`Add an API key for ${provider} first.`));
        setStatus('error');
        return false;
      }
      if (status === 'streaming') return false;
      if (!isLoaded) return false;
      return true;
    }, [apiKey, isLoaded, provider, status]);

  const consumePendingHumanEdits = useCallback((): string | undefined => {
    if (pendingHumanEdits.length === 0) return undefined;
    setPendingHumanEdits([]);
    return `<context>Human edits since last turn: ${pendingHumanEdits.join('; ')}</context>`;
  }, [pendingHumanEdits]);

  const runAssistantTurn = useCallback(
    async (baseMessages: ChatMessage[]) => {
      const activeApiKey = apiKey;
      if (!activeApiKey) {
        throw new Error(`Add an API key for ${provider} first.`);
      }
      const assistantId = makeChatId();
      const assistantMessageBase: Omit<ChatMessage, 'parts'> = {
        id: assistantId,
        role: 'assistant',
        createdAt: Date.now(),
      };
      let assistantParts: ChatPart[] = [];

      setMessageState([...baseMessages, { ...assistantMessageBase, parts: assistantParts }]);
      setStatus('streaming');
      setError(null);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const languageModel = createLanguageModel(provider, model, activeApiKey);
        const thinkingOpts = getThinkingProviderOptions(provider, model);
        const updateAssistant = (mutator: (parts: ChatPart[]) => ChatPart[]) => {
          assistantParts = mutator(assistantParts);
          setMessageState((current) => {
            const idx = current.findIndex((m) => m.id === assistantId);
            if (idx === -1) return current;
            const next = current.slice();
            next[idx] = { ...current[idx], parts: assistantParts };
            return next;
          });
        };
        const executeJsTool = createExecuteJsTool(accessorsRef.current);
        const rollbackTool = createRollbackTool(accessorsRef.current);
        const captureScreenshotTool = createCaptureScreenshotTool(
          () => captureScreenshotRef.current,
          accessorsRef.current,
        );
        const llmTools = {
          execute_js: tool({
            description: executeJsTool.description,
            inputSchema: executeJsTool.inputSchema,
          }),
          rollback_to_commit: tool({
            description: rollbackTool.description,
            inputSchema: rollbackTool.inputSchema,
          }),
          capture_screenshot: tool({
            description: captureScreenshotTool.description,
            inputSchema: captureScreenshotTool.inputSchema,
          }),
        };

        let totalInputTokens = 0;
        let totalOutputTokens = 0;

        for (let step = 0; step < MAX_TOOL_STEPS; step += 1) {
          const messagesForStep = [...baseMessages, { ...assistantMessageBase, parts: assistantParts }];
          const modelMessages = toModelMessages(messagesForStep);

          const result = streamText({
            model: languageModel,
            system: SYSTEM_PROMPT,
            messages: modelMessages,
            tools: llmTools,
            abortSignal: controller.signal,
            maxRetries: 0,
            providerOptions: {
              ...thinkingOpts,
              openai: { parallelToolCalls: false, ...thinkingOpts.openai },
            },
          });

          const textPartIds = new Map<string, number>();
          const reasoningPartIds = new Map<string, number>();

          for await (const part of result.fullStream) {
            if (controller.signal.aborted) break;

            switch (part.type) {
              case 'text-start': {
                updateAssistant((parts) => {
                  textPartIds.set(part.id, parts.length);
                  return [...parts, { type: 'text', text: '' }];
                });
                break;
              }
              case 'text-delta': {
                updateAssistant((parts) => {
                  let index = textPartIds.get(part.id);
                  let nextParts = parts;
                  if (index === undefined) {
                    index = parts.length;
                    textPartIds.set(part.id, index);
                    nextParts = [...parts, { type: 'text', text: '' }];
                  }
                  const target = nextParts[index];
                  if (target?.type !== 'text') return nextParts;
                  const updated: ChatPart = { type: 'text', text: target.text + part.text };
                  const out = nextParts.slice();
                  out[index] = updated;
                  return out;
                });
                break;
              }
              case 'reasoning-start': {
                updateAssistant((parts) => {
                  reasoningPartIds.set(part.id, parts.length);
                  return [...parts, { type: 'reasoning', text: '' }];
                });
                break;
              }
              case 'reasoning-delta': {
                updateAssistant((parts) => {
                  let index = reasoningPartIds.get(part.id);
                  let nextParts = parts;
                  if (index === undefined) {
                    index = parts.length;
                    reasoningPartIds.set(part.id, index);
                    nextParts = [...parts, { type: 'reasoning', text: '' }];
                  }
                  const target = nextParts[index];
                  if (target?.type !== 'reasoning') return nextParts;
                  const updated: ChatPart = { type: 'reasoning', text: target.text + part.text };
                  const out = nextParts.slice();
                  out[index] = updated;
                  return out;
                });
                break;
              }
              case 'tool-call': {
                updateAssistant((parts) => [
                  ...parts,
                  {
                    type: 'tool-call',
                    toolCallId: part.toolCallId,
                    toolName: part.toolName,
                    input: part.input,
                  },
                ]);
                break;
              }
              case 'tool-result':
              case 'tool-error':
              case 'error': {
                if (part.type === 'error') throw toError(part.error);
                if (part.type === 'tool-error') throw toError(part.error);
                break;
              }
              default:
                break;
            }
          }

          try {
            const { inputTokens, outputTokens } = await result.totalUsage;
            if (inputTokens !== undefined) totalInputTokens += inputTokens;
            if (outputTokens !== undefined) totalOutputTokens += outputTokens;
          } catch {
            // Usage unavailable from this provider/model — skip silently.
          }

          const finishReason = await result.finishReason;
          if (finishReason !== 'tool-calls') {
            break;
          }

          const toolCalls = await result.toolCalls;
          for (const toolCall of toolCalls) {
            let output: unknown;
            switch (toolCall.toolName) {
              case 'execute_js':
                output = await (executeJsTool.execute as ((input: unknown, options: unknown) => Promise<unknown>))(
                  toolCall.input,
                  {
                    toolCallId: toolCall.toolCallId,
                    messages: modelMessages,
                    abortSignal: controller.signal,
                  },
                );
                break;
              case 'rollback_to_commit':
                output = await (rollbackTool.execute as ((input: unknown, options: unknown) => Promise<unknown>))(
                  toolCall.input,
                  {
                    toolCallId: toolCall.toolCallId,
                    messages: modelMessages,
                    abortSignal: controller.signal,
                  },
                );
                break;
              case 'capture_screenshot':
                output = await (captureScreenshotTool.execute as ((input: unknown, options: unknown) => Promise<unknown>))(
                  toolCall.input,
                  {
                    toolCallId: toolCall.toolCallId,
                    messages: modelMessages,
                    abortSignal: controller.signal,
                  },
                );
                break;
              default:
                throw new Error(`Unsupported tool call: ${toolCall.toolName}`);
            }

            const rawOutput = output as Record<string, unknown> | null | undefined;
            let storedOutput: unknown = rawOutput;
            let images: Array<{ dataUrl: string; mediaType: string }> | undefined;
            if (
              toolCall.toolName === 'capture_screenshot'
              && rawOutput
              && typeof rawOutput.capturedImageDataUrl === 'string'
            ) {
              const capturedImageDataUrl = rawOutput.capturedImageDataUrl;
              // eslint-disable-next-line @typescript-eslint/no-unused-vars
              const { capturedImageDataUrl: _stripped, ...rest } = rawOutput;
              storedOutput = rest;
              images = [{ dataUrl: capturedImageDataUrl, mediaType: 'image/png' }];
            }

            updateAssistant((parts) => [
              ...parts,
              {
                type: 'tool-result',
                toolCallId: toolCall.toolCallId,
                toolName: toolCall.toolName,
                output: storedOutput,
                ...(images ? { images } : {}),
              },
            ]);
          }
        }

        if (totalInputTokens > 0 || totalOutputTokens > 0) {
          setMessageState((current) => {
            const idx = current.findIndex((m) => m.id === assistantId);
            if (idx === -1) return current;
            const next = current.slice();
            next[idx] = { ...current[idx], usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens } };
            return next;
          });
        }

        setStatus('idle');
      } catch (err) {
        const wrapped = toError(err);
        if (wrapped.name === 'AbortError') {
          setStatus('idle');
        } else {
          setError(wrapped);
          setStatus('error');
        }
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
      }
    },
    [apiKey, isLoaded, model, provider, status],
  );

  const setMessages = useCallback(
    (nextMessages: ChatMessage[]) => {
      if (status === 'streaming') return;
      setMessageState(nextMessages);
      setStatus('idle');
      setError(null);
    },
    [status],
  );

  const sendMessage = useCallback(
    async (text: string, attachments?: ImageAttachment[]) => {
      const trimmed = text.trim();
      if (trimmed.length === 0 && (!attachments || attachments.length === 0)) return;
      if (!ensureCanStartRequest()) return;
      const hiddenContext = consumePendingHumanEdits();
      const userMessage = buildUserMessage(trimmed, attachments, hiddenContext);
      await runAssistantTurn([...messages, userMessage]);
    },
    [buildUserMessage, consumePendingHumanEdits, ensureCanStartRequest, messages, runAssistantTurn],
  );

  const regenerateMessage = useCallback(
    async (messageId: string) => {
      if (!ensureCanStartRequest()) return;
      const targetIndex = messages.findIndex((message) => message.id === messageId);
      if (targetIndex === -1) return;
      let userIndex = targetIndex;
      if (messages[targetIndex]?.role !== 'user') {
        userIndex = -1;
        for (let index = targetIndex - 1; index >= 0; index -= 1) {
          if (messages[index]?.role === 'user') {
            userIndex = index;
            break;
          }
        }
      }
      if (userIndex === -1) return;
      await runAssistantTurn(messages.slice(0, userIndex + 1));
    },
    [ensureCanStartRequest, messages, runAssistantTurn],
  );

  const submitEditedMessage = useCallback(
    async (messageId: string, text: string, attachments?: ImageAttachment[]) => {
      const targetIndex = messages.findIndex(
        (message) => message.id === messageId && message.role === 'user',
      );
      if (targetIndex === -1) return;
      const trimmed = text.trim();
      if (trimmed.length === 0 && (!attachments || attachments.length === 0)) return;
      if (!ensureCanStartRequest()) return;
      const hiddenContext = consumePendingHumanEdits();
      const userMessage = buildUserMessage(trimmed, attachments, hiddenContext);
      await runAssistantTurn([...messages.slice(0, targetIndex), userMessage]);
    },
    [buildUserMessage, consumePendingHumanEdits, ensureCanStartRequest, messages, runAssistantTurn],
  );

  return useMemo<GodModeChatHandle>(
    () => ({
      messages,
      status,
      error,
      pendingHumanEdits: pendingHumanEdits.length,
      pendingHumanEditSummaries: pendingHumanEdits,
      isLoaded,
      canSend,
      setMessages,
      sendMessage,
      regenerateMessage,
      submitEditedMessage,
      stop,
      pushHumanEdit,
    }),
    [
      canSend,
      error,
      isLoaded,
      messages,
      pendingHumanEdits.length,
      pendingHumanEdits,
      pushHumanEdit,
      regenerateMessage,
      sendMessage,
      setMessages,
      status,
      stop,
      submitEditedMessage,
    ],
  );
}

function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === 'string') return new Error(value);
  try {
    return new Error(JSON.stringify(value));
  } catch {
    return new Error(String(value));
  }
}
