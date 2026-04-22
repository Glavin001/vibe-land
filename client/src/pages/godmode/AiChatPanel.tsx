import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ChangeEvent,
  type ForwardedRef,
  type FormEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { forwardRef } from 'react';
import type { ChatImagePart, ChatMessage, ChatPart, ChatToolResultPart } from '../../ai/chatTypes';
import { compactToolResultOutput, extractToolResultImages, makeChatId } from '../../ai/chatTypes';
import {
  findRetryAnchorUserMessageId,
  getMessageAttachments,
  getMessageText,
  removeMessageById,
  takeMessagesBefore,
  takeMessagesThrough,
} from '../../ai/chatHistory';
import {
  MODELS,
  PROVIDER_LABELS,
  defaultModelFor,
  isProviderId,
  type ProviderId,
} from '../../ai/providers';
import {
  clearComposerDraft,
  deleteChat,
  listChatMeta,
  loadActiveChatId,
  loadComposerDraft,
  saveChat,
  saveActiveChatId,
  saveComposerDraft,
  subscribeToChats,
  type ChatMeta,
} from '../../ai/chatStore';
import {
  clearStoredApiKeys,
  loadSettings,
  saveSettings,
  type AiChatSettings,
} from '../../ai/settingsStore';
import { useGodModeChat, type ImageAttachment } from '../../ai/useGodModeChat';
import type { CaptureFunction } from '../../scene/SceneCaptureController';
import type { WorldAccessors } from '../../ai/worldToolHelpers';

export type AiChatPanelHandle = {
  pushHumanEdit: (summary: string) => void;
};

type AiChatPanelProps = {
  accessors: WorldAccessors;
  captureScreenshot?: CaptureFunction;
  getEditorContext?: () => string;
  onClose?: () => void;
};

type PendingBranchAction =
  | { chatId: string; kind: 'retry'; anchorMessageId: string }
  | { chatId: string; kind: 'edit-submit'; text: string; attachments: ImageAttachment[] };

type PendingBranchPayload =
  | { kind: 'retry'; anchorMessageId: string }
  | { kind: 'edit-submit'; text: string; attachments: ImageAttachment[] };

export const AiChatPanel = forwardRef(function AiChatPanel(
  { accessors, captureScreenshot, getEditorContext, onClose }: AiChatPanelProps,
  ref: ForwardedRef<AiChatPanelHandle>,
) {
  const [settings, setSettings] = useState<AiChatSettings>(() => loadSettings());
  const apiKey = settings.apiKeys[settings.provider];

  // Active chat id. Seeded with a fresh id so the hook can mount synchronously
  // while we asynchronously restore the previous active id from IndexedDB.
  const [chatId, setChatId] = useState<string>(() => makeChatId());
  const [chatList, setChatList] = useState<ChatMeta[]>([]);
  const [restored, setRestored] = useState(false);

  const chat = useGodModeChat({
    chatId,
    accessors,
    provider: settings.provider,
    model: settings.model,
    apiKey,
    captureScreenshot,
    getEditorContext,
  });

  // Expose pushHumanEdit so the parent page can forward human edit summaries.
  useImperativeHandle(
    ref,
    () => ({
      pushHumanEdit: (summary: string) => chat.pushHumanEdit(summary),
    }),
    [chat],
  );

  // Restore the previous active chat id once on mount.
  useEffect(() => {
    let cancelled = false;
    void loadActiveChatId().then((existing) => {
      if (cancelled) return;
      if (existing) setChatId(existing);
      setRestored(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist active chat id whenever it changes (after initial restore).
  useEffect(() => {
    if (!restored) return;
    void saveActiveChatId(chatId);
  }, [chatId, restored]);

  // Subscribe to the chat metadata list so the sidebar stays in sync.
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void listChatMeta().then((items) => {
        if (cancelled) return;
        setChatList(items);
      });
    };
    refresh();
    const unsub = subscribeToChats(refresh);
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  // Persist settings whenever they change.
  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  const onProviderChange = useCallback((event: ChangeEvent<HTMLSelectElement>) => {
    const next = event.target.value;
    if (!isProviderId(next)) return;
    setSettings((current) => ({
      ...current,
      provider: next,
      model: defaultModelFor(next),
    }));
  }, []);

  const onModelChange = useCallback((event: ChangeEvent<HTMLSelectElement>) => {
    const next = event.target.value;
    setSettings((current) => ({ ...current, model: next }));
  }, []);

  const onApiKeyChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const next = event.target.value;
      setSettings((current) => ({
        ...current,
        apiKeys: { ...current.apiKeys, [current.provider]: next },
      }));
    },
    [],
  );

  const onClearKeys = useCallback(() => {
    clearStoredApiKeys();
    setSettings((current) => ({ ...current, apiKeys: {} }));
  }, []);

  const [draft, setDraft] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(!apiKey);
  const [chatListOpen, setChatListOpen] = useState(true);
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [editAttachments, setEditAttachments] = useState<ImageAttachment[]>([]);
  const [pendingBranchAction, setPendingBranchAction] = useState<PendingBranchAction | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerSnapshotRef = useRef<{ draft: string; attachments: ImageAttachment[] } | null>(null);

  // Restore the composer draft for the active chat whenever it changes.
  const draftChatIdRef = useRef<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    draftChatIdRef.current = null;
    void loadComposerDraft(chatId).then((value) => {
      if (cancelled) return;
      setDraft(value);
      draftChatIdRef.current = chatId;
    });
    return () => {
      cancelled = true;
    };
  }, [chatId]);

  // Persist composer draft — gated on the draft belonging to the current chat
  // to avoid overwriting it during a chat switch.
  useEffect(() => {
    if (draftChatIdRef.current !== chatId) return;
    void saveComposerDraft(chatId, draft);
  }, [chatId, draft]);

  const clearEditMode = useCallback((restoreComposer: boolean) => {
    if (restoreComposer && composerSnapshotRef.current) {
      setDraft(composerSnapshotRef.current.draft);
      setAttachments(composerSnapshotRef.current.attachments);
    }
    composerSnapshotRef.current = null;
    setEditingMessageId(null);
    setEditDraft('');
    setEditAttachments([]);
  }, []);

  const clearComposerState = useCallback(() => {
    composerSnapshotRef.current = null;
    setDraft('');
    setAttachments([]);
    setEditingMessageId(null);
    setEditDraft('');
    setEditAttachments([]);
  }, []);

  const onNewChat = useCallback(() => {
    if (chat.status === 'streaming') chat.stop();
    setPendingBranchAction(null);
    clearComposerState();
    const nextId = makeChatId();
    setChatId(nextId);
  }, [chat, clearComposerState]);

  const onSelectChat = useCallback(
    (id: string) => {
      if (id === chatId) return;
      if (chat.status === 'streaming') chat.stop();
      setPendingBranchAction(null);
      clearComposerState();
      setChatId(id);
    },
    [chat, chatId, clearComposerState],
  );

  const onDeleteChat = useCallback(
    (id: string, event: ReactMouseEvent) => {
      event.stopPropagation();
      void (async () => {
        await deleteChat(id);
        if (id === chatId) {
          if (chat.status === 'streaming') chat.stop();
          setPendingBranchAction(null);
          clearComposerState();
          setChatId(makeChatId());
        }
      })();
    },
    [chat, chatId, clearComposerState],
  );

  const branchIntoChat = useCallback(
    async (branchMessages: ChatMessage[], action?: PendingBranchPayload) => {
      if (chat.status === 'streaming') chat.stop();
      const nextId = makeChatId();
      await clearComposerDraft(nextId);
      await saveChat(nextId, {
        messages: branchMessages,
        pendingHumanEdits: chat.pendingHumanEditSummaries,
      });
      setPendingBranchAction(action ? { chatId: nextId, ...action } : null);
      clearComposerState();
      setChatId(nextId);
    },
    [chat, clearComposerState],
  );

  useEffect(() => {
    if (!pendingBranchAction) return;
    if (pendingBranchAction.chatId !== chatId) return;
    if (!chat.isLoaded || chat.status === 'streaming') return;
    setPendingBranchAction(null);
    void (async () => {
      if (pendingBranchAction.kind === 'retry') {
        await chat.regenerateMessage(pendingBranchAction.anchorMessageId);
        return;
      }
      await chat.sendMessage(
        pendingBranchAction.text,
        pendingBranchAction.attachments.length > 0 ? pendingBranchAction.attachments : undefined,
      );
    })();
  }, [chat, chatId, pendingBranchAction]);

  const isEditing = editingMessageId !== null;
  const activeDraft = isEditing ? editDraft : draft;
  const activeAttachments = isEditing ? editAttachments : attachments;

  const setActiveAttachments = useCallback(
    (updater: (current: ImageAttachment[]) => ImageAttachment[]) => {
      if (isEditing) {
        setEditAttachments(updater);
        return;
      }
      setAttachments(updater);
    },
    [isEditing],
  );

  const appendAttachment = useCallback(
    (attachment: ImageAttachment) => {
      setActiveAttachments((prev) => [...prev, attachment]);
    },
    [setActiveAttachments],
  );

  const onStartEdit = useCallback(
    (message: ChatMessage) => {
      if (chat.status === 'streaming' || message.role !== 'user') return;
      composerSnapshotRef.current = { draft, attachments };
      setEditingMessageId(message.id);
      setEditDraft(getMessageText(message));
      setEditAttachments(getMessageAttachments(message));
    },
    [attachments, chat.status, draft],
  );

  const onCancelEdit = useCallback(() => {
    clearEditMode(true);
  }, [clearEditMode]);

  const onRetryMessage = useCallback(
    (assistantMessageId: string) => {
      const anchorMessageId = findRetryAnchorUserMessageId(chat.messages, assistantMessageId);
      if (!anchorMessageId) return;
      const branchMessages = takeMessagesThrough(chat.messages, anchorMessageId);
      void branchIntoChat(branchMessages, {
        kind: 'retry',
        anchorMessageId,
      });
    },
    [branchIntoChat, chat.messages],
  );

  const onDeleteMessage = useCallback(
    (messageId: string) => {
      void branchIntoChat(removeMessageById(chat.messages, messageId));
    },
    [branchIntoChat, chat.messages],
  );

  const onPaste = useCallback((event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(event.clipboardData.items);
    const imageItems = items.filter((item) => item.type.startsWith('image/'));
    if (imageItems.length === 0) return;
    for (const item of imageItems) {
      const file = item.getAsFile();
      if (!file) continue;
      const reader = new FileReader();
      reader.onload = () => {
        appendAttachment({ dataUrl: reader.result as string, mediaType: item.type });
      };
      reader.readAsDataURL(file);
    }
  }, [appendAttachment]);

  const onFileChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      const reader = new FileReader();
      reader.onload = () => {
        appendAttachment({ dataUrl: reader.result as string, mediaType: file.type });
      };
      reader.readAsDataURL(file);
    }
  }, [appendAttachment]);

  const messageListRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = messageListRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [chat.messages]);

  const sendWithReset = useCallback(() => {
    const text = draft;
    const atts = attachments;
    setDraft('');
    void clearComposerDraft(chatId);
    setAttachments([]);
    void chat.sendMessage(text, atts.length > 0 ? atts : undefined);
  }, [attachments, chat, chatId, draft]);

  const submitEditedBranch = useCallback(() => {
    if (!editingMessageId) return;
    const branchMessages = takeMessagesBefore(chat.messages, editingMessageId);
    const text = editDraft;
    const atts = editAttachments;
    void branchIntoChat(branchMessages, {
      kind: 'edit-submit',
      text,
      attachments: atts,
    });
  }, [branchIntoChat, chat.messages, editAttachments, editDraft, editingMessageId]);

  const onSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!chat.canSend) return;
      if (isEditing) {
        submitEditedBranch();
        return;
      }
      sendWithReset();
    },
    [chat.canSend, isEditing, sendWithReset, submitEditedBranch],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        if (!chat.canSend) return;
        if (isEditing) {
          submitEditedBranch();
          return;
        }
        sendWithReset();
      }
    },
    [chat.canSend, isEditing, sendWithReset, submitEditedBranch],
  );

  const modelOptions = useMemo(() => MODELS[settings.provider], [settings.provider]);
  const placeholderHint = apiKey
    ? `Ask ${PROVIDER_LABELS[settings.provider]} (${settings.model}) to edit the world…`
    : `Add an ${PROVIDER_LABELS[settings.provider]} API key to start chatting`;
  const hasDraft = activeDraft.length > 0;
  const canSubmitComposer = chat.canSend && (activeDraft.trim().length > 0 || activeAttachments.length > 0);
  const messageActionsDisabled = chat.status === 'streaming' || !chat.isLoaded || isEditing;

  const resolvedPanelStyle: CSSProperties = onClose
    ? { ...panelStyle, height: '100%', width: '100%', borderLeft: 'none' }
    : panelStyle;

  return (
    <aside style={resolvedPanelStyle}>
      <div style={headerStyle}>
        <div style={headerRowStyle}>
          <div style={headerTitleGroupStyle}>
            <span style={eyebrowStyle}>AI Co-Editor</span>
            <h2 style={titleStyle}>Chat</h2>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button type="button" onClick={onNewChat} style={newChatButtonStyle} title="Start a new chat">
              + New chat
            </button>
            {onClose && (
              <button
                type="button"
                onClick={onClose}
                style={chatCloseButtonStyle}
                aria-label="Close chat panel"
                title="Close chat"
              >
                ✕
              </button>
            )}
          </div>
        </div>
        <p style={mutedStyle}>
          Bring-your-own-key. Calls go straight to the provider from your browser — no proxy.
        </p>
      </div>

      <div style={sectionStyle}>
        <div style={settingsHeaderStyle}>
          <button
            type="button"
            onClick={() => setChatListOpen((v) => !v)}
            style={ghostButtonStyle}
          >
            {chatListOpen ? '▾ History' : '▸ History'}
          </button>
          <span style={mutedStyle}>
            {chatList.length === 0
              ? 'No saved chats yet'
              : `${chatList.length} chat${chatList.length === 1 ? '' : 's'}`}
          </span>
        </div>
        {chatListOpen && (
          <div style={chatListStyle}>
            {chatList.length === 0 && (
              <p style={mutedStyle}>Send a message to save this chat.</p>
            )}
            {chatList.map((meta) => {
              const isActive = meta.id === chatId;
              return (
                <button
                  key={meta.id}
                  type="button"
                  onClick={() => onSelectChat(meta.id)}
                  style={isActive ? activeChatItemStyle : chatItemStyle}
                  title={meta.preview || 'Empty chat'}
                >
                  <div style={chatItemHeaderStyle}>
                    <span style={chatItemTimestampStyle}>{formatRelativeTime(meta.updatedAt)}</span>
                    <span
                      role="button"
                      tabIndex={0}
                      aria-label="Delete chat"
                      onClick={(e) => onDeleteChat(meta.id, e)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onDeleteChat(meta.id, e as unknown as ReactMouseEvent);
                        }
                      }}
                      style={chatItemDeleteStyle}
                      title="Delete chat"
                    >
                      ×
                    </span>
                  </div>
                  <div style={chatItemPreviewStyle}>
                    {meta.preview || <em style={chatItemEmptyStyle}>(no messages yet)</em>}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div style={sectionStyle}>
        <div style={settingsHeaderStyle}>
          <button
            type="button"
            onClick={() => setSettingsOpen((v) => !v)}
            style={ghostButtonStyle}
          >
            {settingsOpen ? '▾ Settings' : '▸ Settings'}
          </button>
          <span style={mutedStyle}>
            {PROVIDER_LABELS[settings.provider]} · {settings.model}
            {apiKey ? ' · key set' : ' · no key'}
          </span>
        </div>
        {settingsOpen && (
          <div style={settingsBodyStyle}>
            <label style={fieldLabelStyle}>
              Provider
              <select
                value={settings.provider}
                onChange={onProviderChange}
                style={selectStyle}
              >
                {(Object.keys(MODELS) as ProviderId[]).map((id) => (
                  <option key={id} value={id}>
                    {PROVIDER_LABELS[id]}
                  </option>
                ))}
              </select>
            </label>
            <label style={fieldLabelStyle}>
              Model
              <select value={settings.model} onChange={onModelChange} style={selectStyle}>
                {modelOptions.includes(settings.model) ? null : (
                  <option value={settings.model}>{settings.model} (custom)</option>
                )}
                {modelOptions.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
            <label style={fieldLabelStyle}>
              {PROVIDER_LABELS[settings.provider]} API key
              <input
                type="password"
                value={apiKey ?? ''}
                onChange={onApiKeyChange}
                placeholder="sk-…"
                style={inputStyle}
                spellCheck={false}
                autoComplete="off"
              />
            </label>
            <div style={buttonRowStyle}>
              <button type="button" onClick={onClearKeys} style={dangerButtonStyle}>
                Clear all keys
              </button>
            </div>
            <p style={mutedStyle}>
              Keys live in <code>localStorage</code> on this device only. They&apos;re sent
              directly to the provider with each request.
            </p>
          </div>
        )}
      </div>

      <div style={messageListStyle} ref={messageListRef}>
        {chat.messages.length === 0 && (
          <div style={emptyStateStyle}>
            <p>
              Try: <em>&ldquo;Add a 2&times;2&times;2 cuboid 5 meters north of the origin.&rdquo;</em>
            </p>
            <p>
              Or: <em>&ldquo;How many static props are in the world right now?&rdquo;</em>
            </p>
          </div>
        )}
        {chat.messages.map((msg) => (
          <MessageBubble
            key={msg.id}
            message={msg}
            actionsDisabled={messageActionsDisabled}
            onDelete={() => onDeleteMessage(msg.id)}
            onEdit={msg.role === 'user' ? () => onStartEdit(msg) : undefined}
            onRetry={msg.role === 'assistant' ? () => onRetryMessage(msg.id) : undefined}
          />
        ))}
        {chat.status === 'streaming' && <div style={streamingIndicatorStyle}>…thinking</div>}
      </div>

      {chat.error && (
        <div style={errorBannerStyle}>
          <strong>Error:</strong> {chat.error.message}
        </div>
      )}

      {chat.pendingHumanEdits > 0 && (
        <div style={pendingBannerStyle}>
          {chat.pendingHumanEdits} human edit{chat.pendingHumanEdits === 1 ? '' : 's'} pending — will be shared with the AI on your next message.
        </div>
      )}

      <form onSubmit={onSubmit} style={composerStyle}>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: 'none' }}
          onChange={onFileChange}
        />
        {isEditing && (
          <div style={editBannerStyle}>
            <div style={editBannerTextStyle}>
              Editing an earlier message. Submitting creates a new branched chat and keeps this one intact.
            </div>
            <button type="button" onClick={onCancelEdit} style={ghostButtonStyle}>
              Cancel edit
            </button>
          </div>
        )}
        {activeAttachments.length > 0 && (
          <div style={thumbnailStripStyle}>
            {activeAttachments.map((att, i) => (
              <div key={i} style={thumbnailWrapStyle}>
                <img src={att.dataUrl} style={thumbnailStyle} alt="" />
                <button
                  type="button"
                  onClick={() => setActiveAttachments((prev) => prev.filter((_, j) => j !== i))}
                  style={thumbnailRemoveStyle}
                  title="Remove"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          value={activeDraft}
          onChange={(e) => {
            if (isEditing) {
              setEditDraft(e.target.value);
              return;
            }
            setDraft(e.target.value);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={isEditing ? 'Edit this earlier message, then submit a branched retry…' : placeholderHint}
          rows={3}
          style={hasDraft ? expandedTextareaStyle : textareaStyle}
          disabled={chat.status === 'streaming'}
        />
        <div style={composerActionsStyle}>
          {chat.status === 'streaming' ? (
            <button type="button" onClick={chat.stop} style={dangerButtonStyle}>
              Stop
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                style={secondaryButtonStyle}
                title="Attach image"
              >
                Attach
              </button>
              <button
                type="submit"
                disabled={!canSubmitComposer}
                style={
                  canSubmitComposer
                    ? primaryButtonStyle
                    : disabledButtonStyle
                }
              >
                {isEditing ? 'Branch + send' : 'Send'}
              </button>
            </>
          )}
        </div>
      </form>
    </aside>
  );
});

function MessageBubble({
  message,
  actionsDisabled,
  onDelete,
  onEdit,
  onRetry,
}: {
  message: ChatMessage;
  actionsDisabled: boolean;
  onDelete: () => void;
  onEdit?: () => void;
  onRetry?: () => void;
}) {
  const isUser = message.role === 'user';
  return (
    <div style={isUser ? userBubbleStyle : assistantBubbleStyle}>
      <div style={messageHeaderStyle}>
        <div style={roleLabelStyle}>{isUser ? 'You' : 'Assistant'}</div>
        <div style={messageActionsStyle}>
          {onEdit && (
            <button
              type="button"
              onClick={onEdit}
              disabled={actionsDisabled}
              style={actionsDisabled ? disabledInlineActionStyle : inlineActionStyle}
            >
              Edit
            </button>
          )}
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              disabled={actionsDisabled}
              style={actionsDisabled ? disabledInlineActionStyle : inlineActionStyle}
            >
              Retry
            </button>
          )}
          <button
            type="button"
            onClick={onDelete}
            disabled={actionsDisabled}
            style={actionsDisabled ? disabledInlineActionStyle : dangerInlineActionStyle}
          >
            Delete
          </button>
        </div>
      </div>
      {message.parts.map((part, idx) => (
        <PartView key={idx} part={part} />
      ))}
      {!isUser && message.usage && (
        <div style={usageStyle}>
          {message.usage.inputTokens.toLocaleString()} in · {message.usage.outputTokens.toLocaleString()} out
        </div>
      )}
    </div>
  );
}

function PartView({ part }: { part: ChatPart }) {
  if (part.type === 'text') {
    return <div style={textPartStyle}>{part.text}</div>;
  }
  if (part.type === 'reasoning') {
    return <div style={reasoningPartStyle}>{part.text}</div>;
  }
  if (part.type === 'image') {
    return <img src={(part as ChatImagePart).dataUrl} style={attachedImageStyle} alt="Attached image" />;
  }
  if (part.type === 'tool-call') {
    const code = extractCode(part.input);
    return (
      <details style={toolCallStyle}>
        <summary style={toolSummaryStyle}>
          <span style={toolBadgeStyle}>tool</span> {part.toolName}
        </summary>
        <pre style={codeBlockStyle}>{code ?? jsonStringify(part.input)}</pre>
      </details>
    );
  }
  if (part.type === 'tool-result') {
    const isError = Boolean(part.isError);
    const typedPart = part as ChatToolResultPart;
    const images = extractToolResultImages(typedPart);
    return (
      <details
        open={isError}
        style={{ ...toolResultStyle, borderColor: isError ? 'rgba(255, 110, 110, 0.45)' : toolResultStyle.borderColor }}
      >
        <summary style={toolSummaryStyle}>
          <span style={isError ? toolErrorBadgeStyle : toolResultBadgeStyle}>
            {isError ? 'error' : 'result'}
          </span>{' '}
          {part.toolName}
        </summary>
        <pre style={codeBlockStyle}>{jsonStringify(compactToolResultOutput(typedPart))}</pre>
        {images.map((img, i) => (
          <img key={i} src={img.dataUrl} style={screenshotImageStyle} alt="Captured screenshot" />
        ))}
      </details>
    );
  }
  return null;
}

function extractCode(input: unknown): string | null {
  if (input && typeof input === 'object' && 'code' in (input as Record<string, unknown>)) {
    const code = (input as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return null;
}

function jsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 0) return 'just now';
  const seconds = Math.floor(diff / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const date = new Date(timestamp);
  return date.toLocaleDateString();
}

// ---------- styles (match GodMode.tsx palette) ----------

const panelStyle: CSSProperties = {
  borderLeft: '1px solid rgba(141, 186, 221, 0.14)',
  padding: 20,
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  minHeight: 0,
  background: 'rgba(3, 8, 14, 0.92)',
  color: '#eef7ff',
  overflow: 'hidden',
};

const chatCloseButtonStyle: CSSProperties = {
  width: 32,
  height: 32,
  borderRadius: 8,
  border: '1px solid rgba(167, 208, 237, 0.18)',
  background: 'rgba(20, 34, 48, 0.9)',
  color: '#eef7ff',
  cursor: 'pointer',
  fontSize: 14,
  lineHeight: 1,
};

const headerStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const headerRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 12,
};

const headerTitleGroupStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
};

const eyebrowStyle: CSSProperties = {
  fontSize: 11,
  letterSpacing: '0.24em',
  textTransform: 'uppercase',
  color: '#86d6f5',
};

const titleStyle: CSSProperties = {
  margin: '4px 0 2px',
  fontSize: 24,
  lineHeight: 1.1,
  fontWeight: 700,
};

const mutedStyle: CSSProperties = {
  fontSize: 12,
  color: 'rgba(238, 247, 255, 0.6)',
  margin: 0,
};

const sectionStyle: CSSProperties = {
  border: '1px solid rgba(141, 186, 221, 0.14)',
  borderRadius: 14,
  padding: 12,
  background: 'rgba(14, 26, 38, 0.84)',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};

const settingsHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
};

const settingsBodyStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};

const fieldLabelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  fontSize: 12,
  color: 'rgba(238, 247, 255, 0.82)',
};

const selectStyle: CSSProperties = {
  background: 'rgba(20, 34, 48, 0.96)',
  color: '#eef7ff',
  border: '1px solid rgba(167, 208, 237, 0.18)',
  borderRadius: 8,
  padding: '6px 8px',
  fontSize: 13,
};

const inputStyle: CSSProperties = {
  background: 'rgba(20, 34, 48, 0.96)',
  color: '#eef7ff',
  border: '1px solid rgba(167, 208, 237, 0.18)',
  borderRadius: 8,
  padding: '8px 10px',
  fontSize: 13,
  fontFamily: 'inherit',
};

const buttonRowStyle: CSSProperties = {
  display: 'flex',
  gap: 8,
  flexWrap: 'wrap',
};

const baseButtonStyle: CSSProperties = {
  borderRadius: 10,
  padding: '8px 12px',
  border: '1px solid rgba(167, 208, 237, 0.16)',
  cursor: 'pointer',
  fontWeight: 600,
  fontSize: 13,
};

const primaryButtonStyle: CSSProperties = {
  ...baseButtonStyle,
  background: '#9ed86f',
  color: '#10210d',
};

const secondaryButtonStyle: CSSProperties = {
  ...baseButtonStyle,
  background: 'rgba(20, 34, 48, 0.96)',
  color: '#eef7ff',
};

const dangerButtonStyle: CSSProperties = {
  ...baseButtonStyle,
  background: '#ff8573',
  color: '#38130e',
};

const ghostButtonStyle: CSSProperties = {
  ...baseButtonStyle,
  background: 'transparent',
  border: '1px solid transparent',
  padding: '4px 6px',
  color: '#86d6f5',
};

const disabledButtonStyle: CSSProperties = {
  ...baseButtonStyle,
  background: 'rgba(20, 34, 48, 0.96)',
  color: 'rgba(238, 247, 255, 0.4)',
  cursor: 'not-allowed',
};

const newChatButtonStyle: CSSProperties = {
  ...baseButtonStyle,
  background: '#86d6f5',
  color: '#052233',
  whiteSpace: 'nowrap',
};

const chatListStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  maxHeight: 220,
  overflowY: 'auto',
  paddingRight: 2,
};

const chatItemStyle: CSSProperties = {
  textAlign: 'left',
  background: 'rgba(8, 18, 28, 0.72)',
  border: '1px solid rgba(141, 186, 221, 0.14)',
  borderRadius: 10,
  padding: '8px 10px',
  color: '#eef7ff',
  cursor: 'pointer',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  font: 'inherit',
};

const activeChatItemStyle: CSSProperties = {
  ...chatItemStyle,
  borderColor: 'rgba(116, 212, 255, 0.55)',
  background: 'rgba(116, 212, 255, 0.12)',
};

const chatItemHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
};

const chatItemTimestampStyle: CSSProperties = {
  fontSize: 11,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: '#86d6f5',
};

const chatItemDeleteStyle: CSSProperties = {
  fontSize: 14,
  lineHeight: 1,
  color: 'rgba(238, 247, 255, 0.5)',
  cursor: 'pointer',
  padding: '0 4px',
  borderRadius: 4,
  userSelect: 'none',
};

const chatItemPreviewStyle: CSSProperties = {
  fontSize: 12,
  lineHeight: 1.4,
  color: 'rgba(238, 247, 255, 0.85)',
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
  wordBreak: 'break-word',
};

const chatItemEmptyStyle: CSSProperties = {
  color: 'rgba(238, 247, 255, 0.45)',
};

const messageListStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  paddingRight: 4,
};

const emptyStateStyle: CSSProperties = {
  color: 'rgba(238, 247, 255, 0.55)',
  fontSize: 13,
  lineHeight: 1.5,
  border: '1px dashed rgba(141, 186, 221, 0.2)',
  borderRadius: 14,
  padding: 14,
};

const userBubbleStyle: CSSProperties = {
  alignSelf: 'flex-end',
  maxWidth: '92%',
  background: 'rgba(116, 212, 255, 0.16)',
  border: '1px solid rgba(116, 212, 255, 0.32)',
  borderRadius: 14,
  padding: '8px 12px',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

const assistantBubbleStyle: CSSProperties = {
  alignSelf: 'flex-start',
  maxWidth: '96%',
  background: 'rgba(14, 26, 38, 0.84)',
  border: '1px solid rgba(141, 186, 221, 0.14)',
  borderRadius: 14,
  padding: '8px 12px',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

const messageHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
};

const roleLabelStyle: CSSProperties = {
  fontSize: 10,
  letterSpacing: '0.16em',
  textTransform: 'uppercase',
  color: '#86d6f5',
};

const messageActionsStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flexWrap: 'wrap',
};

const inlineActionStyle: CSSProperties = {
  border: '1px solid rgba(167, 208, 237, 0.16)',
  borderRadius: 999,
  background: 'rgba(20, 34, 48, 0.96)',
  color: '#eef7ff',
  fontSize: 11,
  padding: '3px 8px',
  cursor: 'pointer',
};

const dangerInlineActionStyle: CSSProperties = {
  ...inlineActionStyle,
  color: '#ffbcb0',
  borderColor: 'rgba(255, 133, 115, 0.2)',
};

const disabledInlineActionStyle: CSSProperties = {
  ...inlineActionStyle,
  color: 'rgba(238, 247, 255, 0.4)',
  cursor: 'not-allowed',
};

const textPartStyle: CSSProperties = {
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  fontSize: 13,
  lineHeight: 1.5,
};

const reasoningPartStyle: CSSProperties = {
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  fontSize: 12,
  lineHeight: 1.5,
  color: 'rgba(238, 247, 255, 0.55)',
  fontStyle: 'italic',
};

const toolCallStyle: CSSProperties = {
  border: '1px solid rgba(116, 212, 255, 0.2)',
  borderRadius: 10,
  padding: '6px 8px',
  background: 'rgba(8, 18, 28, 0.72)',
};

const toolResultStyle: CSSProperties = {
  border: '1px solid rgba(158, 216, 111, 0.2)',
  borderRadius: 10,
  padding: '6px 8px',
  background: 'rgba(8, 18, 28, 0.72)',
};

const toolSummaryStyle: CSSProperties = {
  cursor: 'pointer',
  fontSize: 11,
  letterSpacing: '0.08em',
  color: 'rgba(238, 247, 255, 0.7)',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
};

const toolBadgeStyle: CSSProperties = {
  background: 'rgba(116, 212, 255, 0.2)',
  color: '#bae8ff',
  padding: '1px 6px',
  borderRadius: 6,
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: '0.12em',
};

const toolResultBadgeStyle: CSSProperties = {
  ...toolBadgeStyle,
  background: 'rgba(158, 216, 111, 0.2)',
  color: '#d6efaf',
};

const toolErrorBadgeStyle: CSSProperties = {
  ...toolBadgeStyle,
  background: 'rgba(255, 133, 115, 0.22)',
  color: '#ffbcb0',
};

const codeBlockStyle: CSSProperties = {
  margin: '8px 0 2px',
  padding: 8,
  background: 'rgba(0, 0, 0, 0.32)',
  border: '1px solid rgba(141, 186, 221, 0.12)',
  borderRadius: 8,
  fontSize: 11,
  lineHeight: 1.45,
  overflowX: 'auto',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  color: 'rgba(238, 247, 255, 0.86)',
  maxHeight: 240,
};

const usageStyle: CSSProperties = {
  fontSize: 10,
  color: 'rgba(238, 247, 255, 0.35)',
  letterSpacing: '0.06em',
  marginTop: 2,
};

const streamingIndicatorStyle: CSSProperties = {
  alignSelf: 'flex-start',
  fontSize: 12,
  color: 'rgba(116, 212, 255, 0.7)',
  fontStyle: 'italic',
};

const errorBannerStyle: CSSProperties = {
  border: '1px solid rgba(255, 110, 110, 0.36)',
  background: 'rgba(255, 110, 110, 0.12)',
  color: '#ffd0c8',
  borderRadius: 12,
  padding: '8px 12px',
  fontSize: 12,
};

const pendingBannerStyle: CSSProperties = {
  border: '1px solid rgba(116, 212, 255, 0.28)',
  background: 'rgba(116, 212, 255, 0.10)',
  color: '#bae8ff',
  borderRadius: 12,
  padding: '8px 12px',
  fontSize: 12,
};

const editBannerStyle: CSSProperties = {
  border: '1px solid rgba(158, 216, 111, 0.28)',
  background: 'rgba(158, 216, 111, 0.12)',
  color: '#d6efaf',
  borderRadius: 12,
  padding: '8px 12px',
  fontSize: 12,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
};

const editBannerTextStyle: CSSProperties = {
  flex: 1,
};

const composerStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

const composerActionsStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 8,
};

const textareaStyle: CSSProperties = {
  width: '100%',
  resize: 'vertical',
  background: 'rgba(20, 34, 48, 0.96)',
  color: '#eef7ff',
  border: '1px solid rgba(167, 208, 237, 0.18)',
  borderRadius: 10,
  padding: '10px 12px',
  fontSize: 13,
  fontFamily: 'inherit',
  lineHeight: 1.4,
  minHeight: 78,
  transition: 'min-height 140ms ease',
};

const expandedTextareaStyle: CSSProperties = {
  ...textareaStyle,
  minHeight: 132,
};

const thumbnailStripStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
};

const thumbnailWrapStyle: CSSProperties = {
  position: 'relative',
  width: 52,
  height: 52,
  flexShrink: 0,
};

const thumbnailStyle: CSSProperties = {
  width: 52,
  height: 52,
  objectFit: 'cover',
  borderRadius: 6,
  border: '1px solid rgba(116, 212, 255, 0.3)',
  display: 'block',
};

const thumbnailRemoveStyle: CSSProperties = {
  position: 'absolute',
  top: -6,
  right: -6,
  width: 16,
  height: 16,
  borderRadius: '50%',
  background: 'rgba(255, 133, 115, 0.9)',
  color: '#38130e',
  border: 'none',
  cursor: 'pointer',
  fontSize: 11,
  lineHeight: '16px',
  textAlign: 'center',
  padding: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontWeight: 700,
};

const attachedImageStyle: CSSProperties = {
  maxWidth: '100%',
  maxHeight: 200,
  borderRadius: 8,
  border: '1px solid rgba(116, 212, 255, 0.2)',
  display: 'block',
};

const screenshotImageStyle: CSSProperties = {
  maxWidth: '100%',
  borderRadius: 6,
  border: '1px solid rgba(116, 212, 255, 0.25)',
  display: 'block',
  marginTop: 8,
};
