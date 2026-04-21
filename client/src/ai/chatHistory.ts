import type { ChatImagePart, ChatMessage } from './chatTypes';
import type { ImageAttachment } from './useGodModeChat';

export function getMessageText(message: ChatMessage): string {
  return message.parts
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

export function getMessageAttachments(message: ChatMessage): ImageAttachment[] {
  return message.parts
    .filter((part): part is ChatImagePart => part.type === 'image')
    .map((part) => ({ dataUrl: part.dataUrl, mediaType: part.mediaType }));
}

export function takeMessagesBefore(messages: ChatMessage[], messageId: string): ChatMessage[] {
  const index = messages.findIndex((message) => message.id === messageId);
  return index === -1 ? messages : messages.slice(0, index);
}

export function takeMessagesThrough(messages: ChatMessage[], messageId: string): ChatMessage[] {
  const index = messages.findIndex((message) => message.id === messageId);
  return index === -1 ? messages : messages.slice(0, index + 1);
}

export function removeMessageById(messages: ChatMessage[], messageId: string): ChatMessage[] {
  return messages.filter((message) => message.id !== messageId);
}

export function findRetryAnchorUserMessageId(
  messages: ChatMessage[],
  assistantMessageId: string,
): string | null {
  const assistantIndex = messages.findIndex((message) => message.id === assistantMessageId);
  if (assistantIndex === -1) return null;
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      return messages[index]?.id ?? null;
    }
  }
  return null;
}
