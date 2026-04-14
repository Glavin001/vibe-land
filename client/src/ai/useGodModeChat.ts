import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { stepCountIs, streamText } from 'ai';
import {
  makeChatId,
  toModelMessages,
  type ChatMessage,
  type ChatPart,
} from './chatTypes';
import { createLanguageModel, type ProviderId } from './providers';
import { SYSTEM_PROMPT } from './systemPrompt';
import { createExecuteJsTool } from './worldTool';
import type { WorldAccessors } from './worldToolHelpers';

export type ChatStatus = 'idle' | 'streaming' | 'error';

export type GodModeChatOptions = {
  accessors: WorldAccessors;
  provider: ProviderId;
  model: string;
  apiKey: string | undefined;
};

export type GodModeChatHandle = {
  messages: ChatMessage[];
  status: ChatStatus;
  error: Error | null;
  pendingHumanEdits: number;
  canSend: boolean;
  sendMessage(text: string): Promise<void>;
  stop(): void;
  clear(): void;
  pushHumanEdit(summary: string): void;
};

const MAX_TOOL_STEPS = 12;

export function useGodModeChat(options: GodModeChatOptions): GodModeChatHandle {
  const { accessors, provider, model, apiKey } = options;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<ChatStatus>('idle');
  const [error, setError] = useState<Error | null>(null);
  const [pendingHumanEdits, setPendingHumanEdits] = useState<string[]>([]);

  const accessorsRef = useRef(accessors);
  useEffect(() => {
    accessorsRef.current = accessors;
  }, [accessors]);

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

  const clear = useCallback(() => {
    stop();
    setMessages([]);
    setError(null);
    setPendingHumanEdits([]);
    setStatus('idle');
  }, [stop]);

  const canSend = Boolean(apiKey) && status === 'idle';

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (trimmed.length === 0) return;
      if (!apiKey) {
        setError(new Error(`Add an API key for ${provider} first.`));
        setStatus('error');
        return;
      }
      if (status === 'streaming') return;

      // Snapshot pending human edits and clear them up-front so concurrent
      // edits while we wait for the model start a fresh buffer.
      let hiddenContext: string | undefined;
      if (pendingHumanEdits.length > 0) {
        hiddenContext = `<context>Human edits since last turn: ${pendingHumanEdits.join('; ')}</context>`;
      }
      setPendingHumanEdits([]);

      const userMessage: ChatMessage = {
        id: makeChatId(),
        role: 'user',
        parts: [{ type: 'text', text: trimmed }],
        createdAt: Date.now(),
        hiddenContext,
      };
      const assistantId = makeChatId();
      const assistantMessage: ChatMessage = {
        id: assistantId,
        role: 'assistant',
        parts: [],
        createdAt: Date.now(),
      };

      const baseMessages = [...messages, userMessage];
      setMessages([...baseMessages, assistantMessage]);
      setStatus('streaming');
      setError(null);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const languageModel = createLanguageModel(provider, model, apiKey);
        const result = streamText({
          model: languageModel,
          system: SYSTEM_PROMPT,
          messages: toModelMessages(baseMessages),
          tools: { execute_js: createExecuteJsTool(accessorsRef.current) },
          stopWhen: stepCountIs(MAX_TOOL_STEPS),
          abortSignal: controller.signal,
        });

        // Track in-flight text/reasoning blocks so streamed deltas append to
        // the same part instead of creating a new one per chunk.
        const textPartIds = new Map<string, number>(); // delta id -> parts index
        const reasoningPartIds = new Map<string, number>();

        const updateAssistant = (mutator: (parts: ChatPart[]) => ChatPart[]) => {
          setMessages((current) => {
            const idx = current.findIndex((m) => m.id === assistantId);
            if (idx === -1) return current;
            const target = current[idx];
            const nextParts = mutator(target.parts);
            const nextMessage: ChatMessage = { ...target, parts: nextParts };
            const next = current.slice();
            next[idx] = nextMessage;
            return next;
          });
        };

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
            case 'tool-result': {
              updateAssistant((parts) => [
                ...parts,
                {
                  type: 'tool-result',
                  toolCallId: part.toolCallId,
                  toolName: part.toolName,
                  output: part.output,
                },
              ]);
              break;
            }
            case 'tool-error': {
              updateAssistant((parts) => [
                ...parts,
                {
                  type: 'tool-result',
                  toolCallId: part.toolCallId,
                  toolName: part.toolName,
                  output: { error: errorMessage(part.error) },
                  isError: true,
                },
              ]);
              break;
            }
            case 'error': {
              throw toError(part.error);
            }
            default:
              break;
          }
        }

        if (controller.signal.aborted) {
          setStatus('idle');
        } else {
          setStatus('idle');
        }
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
    [apiKey, messages, model, pendingHumanEdits, provider, status],
  );

  return useMemo<GodModeChatHandle>(
    () => ({
      messages,
      status,
      error,
      pendingHumanEdits: pendingHumanEdits.length,
      canSend,
      sendMessage,
      stop,
      clear,
      pushHumanEdit,
    }),
    [canSend, clear, error, messages, pendingHumanEdits.length, pushHumanEdit, sendMessage, status, stop],
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

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
