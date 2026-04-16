import type { ModelMessage, ToolContent, ToolResultPart } from 'ai';

export type ChatTextPart = { type: 'text'; text: string };
export type ChatReasoningPart = { type: 'reasoning'; text: string };
export type ChatToolCallPart = {
  type: 'tool-call';
  toolCallId: string;
  toolName: string;
  input: unknown;
};
export type ChatToolResultPart = {
  type: 'tool-result';
  toolCallId: string;
  toolName: string;
  output: unknown;
  isError?: boolean;
  /** Captured screenshots attached to this result. Stored separately so the large dataUrls don't bloat the JSON output that gets replayed to the model. */
  images?: Array<{ dataUrl: string; mediaType: string }>;
};
export type ChatImagePart = { type: 'image'; dataUrl: string; mediaType: string };

export type ChatPart =
  | ChatTextPart
  | ChatReasoningPart
  | ChatToolCallPart
  | ChatToolResultPart
  | ChatImagePart;

export type ChatRole = 'user' | 'assistant';

export type ChatMessage = {
  id: string;
  role: ChatRole;
  parts: ChatPart[];
  createdAt: number;
  /**
   * Optional hidden context prepended to the user message before sending.
   * Used to inject auto-summarized human edits without polluting the visible
   * chat bubble.
   */
  hiddenContext?: string;
};

/**
 * Convert our local chat-message list into AI SDK `ModelMessage[]` for
 * `streamText`. Tool calls and results are inlined onto the assistant
 * message and a follow-up tool message respectively, matching the shape the
 * SDK expects.
 */
export function toModelMessages(messages: ChatMessage[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const msg of messages) {
    if (msg.role === 'user') {
      const content = renderUserContent(msg);
      out.push({ role: 'user', content });
      continue;
    }
    // assistant message — content can be a mix of text/reasoning/tool-call parts
    const assistantContent: Array<
      | { type: 'text'; text: string }
      | { type: 'reasoning'; text: string }
      | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
    > = [];
    const toolResults: ToolContent = [];

    for (const part of msg.parts) {
      if (part.type === 'text' && part.text.length > 0) {
        assistantContent.push({ type: 'text', text: part.text });
      } else if (part.type === 'reasoning' && part.text.length > 0) {
        assistantContent.push({ type: 'reasoning', text: part.text });
      } else if (part.type === 'tool-call') {
        assistantContent.push({
          type: 'tool-call',
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: part.input ?? {},
        });
      } else if (part.type === 'tool-result') {
        let output: ToolResultPart['output'];
        if (part.isError) {
          output = { type: 'error-text', value: stringifyForModel(part.output) };
        } else if (part.images && part.images.length > 0) {
          // Multi-modal tool result: text summary + captured image(s).
          // The AI SDK v6 'content' output lets us embed images in tool results so
          // the model can see them in the same streaming step.
          output = {
            type: 'content',
            value: [
              { type: 'text', text: stringifyForModel(part.output) },
              ...part.images.map((img) => ({
                type: 'image' as const,
                data: img.dataUrl,
                mimeType: img.mediaType as 'image/png',
              })),
            ],
          } as ToolResultPart['output'];
        } else {
          output = { type: 'json', value: toJsonValue(part.output) } as ToolResultPart['output'];
        }
        const resultPart: ToolResultPart = {
          type: 'tool-result',
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          output,
        };
        toolResults.push(resultPart);
      }
    }

    if (assistantContent.length > 0) {
      out.push({ role: 'assistant', content: assistantContent });
    }
    if (toolResults.length > 0) {
      out.push({ role: 'tool', content: toolResults });
    }
  }
  return out;
}

function renderUserContent(
  msg: ChatMessage,
): string | Array<{ type: 'text'; text: string } | { type: 'image'; image: string; mimeType: string }> {
  const imageParts = msg.parts.filter((p): p is ChatImagePart => p.type === 'image');
  const visible = msg.parts
    .filter((p): p is ChatTextPart => p.type === 'text')
    .map((p) => p.text)
    .join('');
  const fullText =
    msg.hiddenContext && msg.hiddenContext.length > 0
      ? `${msg.hiddenContext}\n\n${visible}`
      : visible;
  if (imageParts.length === 0) return fullText;
  return [
    { type: 'text', text: fullText },
    ...imageParts.map((img) => ({ type: 'image' as const, image: img.dataUrl, mimeType: img.mediaType })),
  ];
}

function stringifyForModel(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Coerce an arbitrary JS value into something the AI SDK accepts as a
 * JSONValue tool result. We round-trip through JSON to drop functions/symbols
 * and turn cycles into strings.
 */
function toJsonValue(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value ?? null));
  } catch {
    return String(value);
  }
}

export function makeChatId(): string {
  const cryptoRef = typeof crypto !== 'undefined' ? crypto : undefined;
  if (cryptoRef && typeof cryptoRef.randomUUID === 'function') {
    return cryptoRef.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
