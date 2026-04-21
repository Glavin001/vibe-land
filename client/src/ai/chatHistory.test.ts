import { describe, expect, it } from 'vitest';
import {
  findRetryAnchorUserMessageId,
  getMessageAttachments,
  getMessageText,
  removeMessageById,
  takeMessagesBefore,
  takeMessagesThrough,
} from './chatHistory';
import type { ChatMessage } from './chatTypes';

function message(
  id: string,
  role: 'user' | 'assistant',
  text: string,
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id,
    role,
    createdAt: 1,
    parts: [{ type: 'text', text }],
    ...extra,
  };
}

describe('chatHistory', () => {
  it('takes messages before a selected message id', () => {
    const messages = [
      message('u1', 'user', 'first'),
      message('a1', 'assistant', 'reply'),
      message('u2', 'user', 'second'),
    ];

    expect(takeMessagesBefore(messages, 'u2').map((item) => item.id)).toEqual(['u1', 'a1']);
  });

  it('takes messages through a selected message id', () => {
    const messages = [
      message('u1', 'user', 'first'),
      message('a1', 'assistant', 'reply'),
      message('u2', 'user', 'second'),
    ];

    expect(takeMessagesThrough(messages, 'a1').map((item) => item.id)).toEqual(['u1', 'a1']);
  });

  it('finds the retry anchor user for an assistant message', () => {
    const messages = [
      message('u1', 'user', 'first'),
      message('a1', 'assistant', 'reply'),
      message('u2', 'user', 'second'),
      message('a2', 'assistant', 'second reply'),
    ];

    expect(findRetryAnchorUserMessageId(messages, 'a2')).toBe('u2');
  });

  it('removes only the selected bubble', () => {
    const messages = [
      message('u1', 'user', 'first'),
      message('a1', 'assistant', 'reply'),
      message('u2', 'user', 'second'),
    ];

    expect(removeMessageById(messages, 'a1').map((item) => item.id)).toEqual(['u1', 'u2']);
  });

  it('extracts visible text and image attachments from a user message', () => {
    const richMessage: ChatMessage = {
      id: 'u1',
      role: 'user',
      createdAt: 1,
      parts: [
        { type: 'text', text: 'hello ' },
        { type: 'text', text: 'world' },
        { type: 'image', dataUrl: 'data:image/png;base64,abc', mediaType: 'image/png' },
      ],
    };

    expect(getMessageText(richMessage)).toBe('hello world');
    expect(getMessageAttachments(richMessage)).toEqual([
      { dataUrl: 'data:image/png;base64,abc', mediaType: 'image/png' },
    ]);
  });
});
