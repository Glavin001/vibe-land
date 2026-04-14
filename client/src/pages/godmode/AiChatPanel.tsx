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
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { forwardRef } from 'react';
import type { ChatMessage, ChatPart } from '../../ai/chatTypes';
import {
  MODELS,
  PROVIDER_LABELS,
  defaultModelFor,
  isProviderId,
  type ProviderId,
} from '../../ai/providers';
import {
  clearStoredApiKeys,
  loadSettings,
  saveSettings,
  type AiChatSettings,
} from '../../ai/settingsStore';
import { useGodModeChat } from '../../ai/useGodModeChat';
import type { WorldAccessors } from '../../ai/worldToolHelpers';

export type AiChatPanelHandle = {
  pushHumanEdit: (summary: string) => void;
};

type AiChatPanelProps = {
  accessors: WorldAccessors;
};

export const AiChatPanel = forwardRef(function AiChatPanel(
  { accessors }: AiChatPanelProps,
  ref: ForwardedRef<AiChatPanelHandle>,
) {
  const [settings, setSettings] = useState<AiChatSettings>(() => loadSettings());
  const apiKey = settings.apiKeys[settings.provider];

  const chat = useGodModeChat({
    accessors,
    provider: settings.provider,
    model: settings.model,
    apiKey,
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

  const [draft, setDraft] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(!apiKey);

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
      setDraft('');
      void chat.sendMessage(text);
    },
    [chat, draft],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        if (!chat.canSend) return;
        const text = draft;
        setDraft('');
        void chat.sendMessage(text);
      }
    },
    [chat, draft],
  );

  const modelOptions = useMemo(() => MODELS[settings.provider], [settings.provider]);
  const placeholderHint = apiKey
    ? `Ask ${PROVIDER_LABELS[settings.provider]} (${settings.model}) to edit the world…`
    : `Add an ${PROVIDER_LABELS[settings.provider]} API key to start chatting`;

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
              <button type="button" onClick={chat.clear} style={secondaryButtonStyle}>
                Clear chat
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
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholderHint}
          rows={3}
          style={textareaStyle}
          disabled={chat.status === 'streaming'}
        />
        <div style={composerActionsStyle}>
          {chat.status === 'streaming' ? (
            <button type="button" onClick={chat.stop} style={dangerButtonStyle}>
              Stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={!chat.canSend || draft.trim().length === 0}
              style={chat.canSend && draft.trim().length > 0 ? primaryButtonStyle : disabledButtonStyle}
            >
              Send
            </button>
          )}
        </div>
      </form>
    </aside>
  );
});

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  return (
    <div style={isUser ? userBubbleStyle : assistantBubbleStyle}>
      <div style={roleLabelStyle}>{isUser ? 'You' : 'Assistant'}</div>
      {message.parts.map((part, idx) => (
        <PartView key={idx} part={part} />
      ))}
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
};
