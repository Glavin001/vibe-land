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
} from 'react';
import { forwardRef } from 'react';
import type { ChatImagePart, ChatMessage, ChatPart } from '../../ai/chatTypes';
import {
  MODELS,
  PROVIDER_LABELS,
  defaultModelFor,
  isLocalProvider,
  isProviderId,
  requiresApiKey,
  type ProviderId,
} from '../../ai/providers';
import {
  clearPersistedComposerDraft,
  loadPersistedComposerDraft,
  savePersistedComposerDraft,
} from '../../ai/chatStore';
import {
  clearStoredApiKeys,
  loadSettings,
  saveSettings,
  type AiChatSettings,
} from '../../ai/settingsStore';
import { useGodModeChat, type ImageAttachment } from '../../ai/useGodModeChat';
import type { WorldAccessors } from '../../ai/worldToolHelpers';
import {
  LOCAL_MODEL_APPROX_SIZE_MB,
  LOCAL_MODEL_LABEL,
  downloadLocalModel,
  isLocalModelReady,
  isWebGpuAvailable,
} from '../../ai/localLlm';
import { useSpeechRecognition } from '../../ai/speech';

export type AiChatPanelHandle = {
  pushHumanEdit: (summary: string) => void;
};

type LocalLoadState =
  | { status: 'idle' }
  | { status: 'downloading'; progress: number }
  | { status: 'ready' }
  | { status: 'error'; message: string };

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

type AiChatPanelProps = {
  accessors: WorldAccessors;
};

export const AiChatPanel = forwardRef(function AiChatPanel(
  { accessors }: AiChatPanelProps,
  ref: ForwardedRef<AiChatPanelHandle>,
) {
  const [settings, setSettings] = useState<AiChatSettings>(() => loadSettings());
  const apiKey = settings.apiKeys[settings.provider];
  const providerIsLocal = isLocalProvider(settings.provider);

  const [localLoadState, setLocalLoadState] = useState<LocalLoadState>(() =>
    isLocalModelReady() ? { status: 'ready' } : { status: 'idle' },
  );

  const chat = useGodModeChat({
    accessors,
    provider: settings.provider,
    model: settings.model,
    apiKey,
    localReady: localLoadState.status === 'ready',
  });

  // Expose pushHumanEdit so the parent page can forward human edit summaries.
  useImperativeHandle(
    ref,
    () => ({
      pushHumanEdit: (summary: string) => chat.pushHumanEdit(summary),
    }),
    [chat],
  );

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

  const onClearChat = useCallback(() => {
    setDraft('');
    setAttachments([]);
    clearPersistedComposerDraft();
    chat.clear();
  }, [chat]);

  const onPaste = useCallback((event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(event.clipboardData.items);
    const imageItems = items.filter((item) => item.type.startsWith('image/'));
    if (imageItems.length === 0) return;
    for (const item of imageItems) {
      const file = item.getAsFile();
      if (!file) continue;
      const reader = new FileReader();
      reader.onload = () => {
        setAttachments((prev) => [
          ...prev,
          { dataUrl: reader.result as string, mediaType: item.type },
        ]);
      };
      reader.readAsDataURL(file);
    }
  }, []);

  const onFileChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      const reader = new FileReader();
      reader.onload = () => {
        setAttachments((prev) => [
          ...prev,
          { dataUrl: reader.result as string, mediaType: file.type },
        ]);
      };
      reader.readAsDataURL(file);
    }
  }, []);

  const [draft, setDraft] = useState(() => loadPersistedComposerDraft());
  const needsSettings = providerIsLocal
    ? localLoadState.status !== 'ready'
    : !apiKey;
  const [settingsOpen, setSettingsOpen] = useState(needsSettings);
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const startLocalDownload = useCallback(async () => {
    setLocalLoadState({ status: 'downloading', progress: 0 });
    try {
      await downloadLocalModel({
        onProgress: (progressPct) => {
          setLocalLoadState((prev) =>
            prev.status === 'downloading'
              ? { status: 'downloading', progress: clampPercent(progressPct) }
              : prev,
          );
        },
      });
      setLocalLoadState({ status: 'ready' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setLocalLoadState({ status: 'error', message });
    }
  }, []);

  const speech = useSpeechRecognition({
    onFinal: (text: string) => {
      setDraft((prev) => (prev.length > 0 ? `${prev} ${text}` : text));
    },
  });
  const onMicClick = useCallback(() => {
    if (!speech.supported) return;
    if (speech.listening) {
      speech.stop();
    } else {
      speech.start();
    }
  }, [speech]);

  useEffect(() => {
    savePersistedComposerDraft(draft);
  }, [draft]);

  const messageListRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = messageListRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [chat.messages]);

  const onSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!chat.canSend) return;
      const text = draft;
      const atts = attachments;
      setDraft('');
      clearPersistedComposerDraft();
      setAttachments([]);
      void chat.sendMessage(text, atts.length > 0 ? atts : undefined);
    },
    [attachments, chat, draft],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        if (!chat.canSend) return;
        const text = draft;
        const atts = attachments;
        setDraft('');
        clearPersistedComposerDraft();
        setAttachments([]);
        void chat.sendMessage(text, atts.length > 0 ? atts : undefined);
      }
    },
    [attachments, chat, draft],
  );

  const modelOptions = useMemo(() => MODELS[settings.provider], [settings.provider]);
  const placeholderHint = providerIsLocal
    ? localLoadState.status === 'ready'
      ? `Ask ${LOCAL_MODEL_LABEL} (runs on your device)…`
      : `Download ${LOCAL_MODEL_LABEL} from Settings to start chatting`
    : apiKey
      ? `Ask ${PROVIDER_LABELS[settings.provider]} (${settings.model}) to edit the world…`
      : `Add an ${PROVIDER_LABELS[settings.provider]} API key to start chatting`;
  const hasDraft = draft.length > 0;

  return (
    <aside style={panelStyle}>
      <div style={headerStyle}>
        <span style={eyebrowStyle}>AI Co-Editor</span>
        <h2 style={titleStyle}>Chat</h2>
        <p style={mutedStyle}>
          Bring-your-own-key. Calls go straight to the provider from your browser — no proxy.
        </p>
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
            {providerIsLocal
              ? localLoadState.status === 'ready'
                ? ' · model ready'
                : localLoadState.status === 'downloading'
                  ? ` · downloading ${Math.round(localLoadState.progress)}%`
                  : localLoadState.status === 'error'
                    ? ' · download failed'
                    : ' · not downloaded'
              : apiKey
                ? ' · key set'
                : ' · no key'}
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
            {requiresApiKey(settings.provider) && (
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
            )}
            {providerIsLocal && (
              <LocalModelStatus
                state={localLoadState}
                onDownload={startLocalDownload}
              />
            )}
            <div style={buttonRowStyle}>
              {requiresApiKey(settings.provider) && (
                <button type="button" onClick={onClearKeys} style={dangerButtonStyle}>
                  Clear all keys
                </button>
              )}
              <button type="button" onClick={onClearChat} style={secondaryButtonStyle}>
                Clear chat
              </button>
            </div>
            {providerIsLocal ? (
              <p style={mutedStyle}>
                The local model runs fully in your browser — no network calls after the
                first download. WebGPU is{' '}
                {isWebGpuAvailable() ? 'available (fast).' : 'unavailable — will fall back to CPU (slow).'}{' '}
                Cached model weights persist in your browser storage.
              </p>
            ) : (
              <p style={mutedStyle}>
                Keys live in <code>localStorage</code> on this device only. They&apos;re sent
                directly to the provider with each request.
              </p>
            )}
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
          <MessageBubble key={msg.id} message={msg} />
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
        {attachments.length > 0 && (
          <div style={thumbnailStripStyle}>
            {attachments.map((att, i) => (
              <div key={i} style={thumbnailWrapStyle}>
                <img src={att.dataUrl} style={thumbnailStyle} alt="" />
                <button
                  type="button"
                  onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
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
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={placeholderHint}
          rows={3}
          style={hasDraft ? expandedTextareaStyle : textareaStyle}
          disabled={chat.status === 'streaming'}
        />
        {speech.listening && speech.interim.length > 0 && (
          <div style={interimStyle}>{speech.interim}…</div>
        )}
        {speech.error && (
          <div style={errorBannerStyle}>
            <strong>Mic error:</strong> {speech.error}
          </div>
        )}
        <div style={composerActionsStyle}>
          {chat.status === 'streaming' ? (
            <button type="button" onClick={chat.stop} style={dangerButtonStyle}>
              Stop
            </button>
          ) : (
            <>
              {speech.supported && (
                <button
                  type="button"
                  onClick={onMicClick}
                  style={speech.listening ? micActiveButtonStyle : secondaryButtonStyle}
                  title={speech.listening ? 'Stop dictation' : 'Dictate via microphone'}
                >
                  {speech.listening ? '● Listening' : '🎙 Speak'}
                </button>
              )}
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
                disabled={!chat.canSend || (draft.trim().length === 0 && attachments.length === 0)}
                style={
                  chat.canSend && (draft.trim().length > 0 || attachments.length > 0)
                    ? primaryButtonStyle
                    : disabledButtonStyle
                }
              >
                Send
              </button>
            </>
          )}
        </div>
      </form>
    </aside>
  );
});

function LocalModelStatus({
  state,
  onDownload,
}: {
  state: LocalLoadState;
  onDownload: () => void;
}) {
  if (state.status === 'idle') {
    return (
      <div style={localStatusStyle}>
        <div style={fieldLabelStyle}>
          Local model ({LOCAL_MODEL_LABEL})
        </div>
        <p style={mutedStyle}>
          Running {LOCAL_MODEL_LABEL} in the browser requires downloading about{' '}
          <strong>{LOCAL_MODEL_APPROX_SIZE_MB} MB</strong> of weights from the Hugging
          Face CDN. Files are cached after first use. Click below to accept and
          start the download.
        </p>
        <div style={buttonRowStyle}>
          <button type="button" onClick={onDownload} style={primaryButtonStyle}>
            Download {LOCAL_MODEL_LABEL} (~{LOCAL_MODEL_APPROX_SIZE_MB} MB)
          </button>
        </div>
      </div>
    );
  }
  if (state.status === 'downloading') {
    const pct = Math.round(state.progress);
    return (
      <div style={localStatusStyle}>
        <div style={fieldLabelStyle}>Downloading {LOCAL_MODEL_LABEL}…</div>
        <div style={progressTrackStyle}>
          <div style={{ ...progressFillStyle, width: `${pct}%` }} />
        </div>
        <p style={mutedStyle}>
          {pct}%
        </p>
      </div>
    );
  }
  if (state.status === 'ready') {
    return (
      <div style={localStatusStyle}>
        <div style={fieldLabelStyle}>{LOCAL_MODEL_LABEL} is ready.</div>
        <p style={mutedStyle}>
          Inference runs on your device. No API key or network calls required.
          Tool-calling uses Qwen3&apos;s native format — quality is lower than
          cloud models.
        </p>
      </div>
    );
  }
  return (
    <div style={localStatusStyle}>
      <div style={fieldLabelStyle}>Download failed</div>
      <p style={mutedStyle}>{state.message}</p>
      <div style={buttonRowStyle}>
        <button type="button" onClick={onDownload} style={secondaryButtonStyle}>
          Retry
        </button>
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  return (
    <div style={isUser ? userBubbleStyle : assistantBubbleStyle}>
      <div style={roleLabelStyle}>{isUser ? 'You' : 'Assistant'}</div>
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
        <pre style={codeBlockStyle}>{jsonStringify(part.output)}</pre>
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

const headerStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
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

const micActiveButtonStyle: CSSProperties = {
  ...baseButtonStyle,
  background: '#ff8573',
  color: '#38130e',
};

const localStatusStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  border: '1px solid rgba(116, 212, 255, 0.24)',
  borderRadius: 10,
  padding: 10,
  background: 'rgba(8, 18, 28, 0.72)',
};

const progressTrackStyle: CSSProperties = {
  width: '100%',
  height: 8,
  borderRadius: 4,
  background: 'rgba(167, 208, 237, 0.16)',
  overflow: 'hidden',
};

const progressFillStyle: CSSProperties = {
  height: '100%',
  background: '#86d6f5',
  transition: 'width 120ms linear',
};

const interimStyle: CSSProperties = {
  fontSize: 12,
  color: 'rgba(238, 247, 255, 0.55)',
  fontStyle: 'italic',
  padding: '0 2px',
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

const roleLabelStyle: CSSProperties = {
  fontSize: 10,
  letterSpacing: '0.16em',
  textTransform: 'uppercase',
  color: '#86d6f5',
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
