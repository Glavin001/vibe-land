import { useState, useCallback, useEffect, useRef, type CSSProperties } from 'react';
import { gameModeLabel, isPracticeMode, type GameMode } from './app/gameMode';
import { GameScene } from './scene/GameScene';
import type { CrosshairAimState } from './scene/aimTargeting';
import type { InputFamilyMode } from './input/types';
import { ControlHintsOverlay } from './ui/ControlHintsOverlay';
import { debugStatsToMarkdown, DebugOverlay } from './ui/DebugOverlay';
import { useControlHints } from './ui/useControlHints';
import { useDebugStats } from './ui/useDebugStats';
import { DEFAULT_WORLD_DOCUMENT, type WorldDocument } from './world/worldDocument';

type AppProps = {
  mode: GameMode;
  worldDocument?: WorldDocument;
};

export function App({ mode, worldDocument = DEFAULT_WORLD_DOCUMENT }: AppProps) {
  const practiceMode = isPracticeMode(mode);
  const modeLabel = gameModeLabel(mode);
  const [connected, setConnected] = useState(false);
  const [playerId, setPlayerId] = useState(0);
  const [status, setStatus] = useState('Click to join');
  const [copyNotice, setCopyNotice] = useState('');
  const [crosshairState, setCrosshairState] = useState<CrosshairAimState>('idle');
  const [inputFamilyMode, setInputFamilyMode] = useState<InputFamilyMode>('auto');
  const {
    visible: debugVisible,
    displayStats,
    updateFrame,
    recordSnapshot,
    getStatsSnapshot,
    rapierDebugModeBits,
  } = useDebugStats();
  const { displayState: controlHintsState, updateInputFrame, isDesktop } = useControlHints();
  const renderStatsParentRef = useRef<HTMLDivElement>(null);
  const copyNoticeTimerRef = useRef<number | null>(null);

  const handleConnect = useCallback(() => {
    setConnected(true);
    setCrosshairState('idle');
    setStatus(practiceMode ? 'Starting firing range...' : 'Connecting...');
  }, [practiceMode]);

  const handleWelcome = useCallback((id: number) => {
    setPlayerId(id);
    setStatus(`${practiceMode ? modeLabel : `Player #${id}`} — KB/M: WASD + mouse, Gamepad: sticks + RT, E/X interact, Q/LB remove, F/RB place`);
  }, [modeLabel, practiceMode]);

  const handleDisconnect = useCallback(() => {
    setStatus(`${practiceMode ? `${modeLabel} stopped` : 'Disconnected'} — click to rejoin`);
    setConnected(false);
    setPlayerId(0);
    setCrosshairState('idle');
  }, [modeLabel, practiceMode]);

  useEffect(() => {
    const setTimedCopyNotice = (message: string) => {
      setCopyNotice(message);
      if (copyNoticeTimerRef.current != null) {
        window.clearTimeout(copyNoticeTimerRef.current);
      }
      copyNoticeTimerRef.current = window.setTimeout(() => {
        setCopyNotice('');
        copyNoticeTimerRef.current = null;
      }, 2000);
    };

    const handleCopyDebug = async () => {
      const markdown = debugStatsToMarkdown(getStatsSnapshot(), {
        connected,
        status,
        path: window.location.pathname,
        userAgent: navigator.userAgent,
        renderStatsText: renderStatsParentRef.current?.innerText ?? '',
      });
      try {
        await navigator.clipboard.writeText(markdown);
        setTimedCopyNotice('Copied debug markdown');
      } catch {
        setTimedCopyNotice('Clipboard copy failed');
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const isMac = navigator.platform.includes('Mac');
      const modPressed = isMac ? event.metaKey : event.ctrlKey;
      const wantsCopyDebug =
        event.code === 'F4'
        || (modPressed && event.shiftKey && event.code === 'KeyD');
      if (!wantsCopyDebug) return;
      event.preventDefault();
      void handleCopyDebug();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      if (copyNoticeTimerRef.current != null) {
        window.clearTimeout(copyNoticeTimerRef.current);
      }
    };
  }, [connected, getStatsSnapshot, status]);

  const crosshairColor =
    crosshairState === 'head'
      ? 'rgba(255, 36, 36, 0.98)'
      : crosshairState === 'body'
        ? 'rgba(255, 92, 92, 0.96)'
        : 'rgba(255, 255, 255, 0.9)';
  const crosshairGlow =
    crosshairState === 'idle'
      ? 'rgba(255, 255, 255, 0.18)'
      : crosshairState === 'head'
        ? 'rgba(255, 48, 48, 0.55)'
        : 'rgba(255, 96, 96, 0.45)';

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      {!connected && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 10,
            background: 'rgba(0,0,0,0.8)',
            cursor: 'pointer',
          }}
          onClick={handleConnect}
        >
          <div style={{ textAlign: 'center' }}>
            <h1 style={{ fontSize: 48, marginBottom: 16 }}>vibe-land</h1>
            <p style={{ fontSize: 14, opacity: 0.5, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.18em' }}>
              {mode === 'multiplayer' ? '/play' : '/practice'}
            </p>
            <p style={{ fontSize: 20, opacity: 0.7 }}>
              {practiceMode ? 'Click anywhere to launch the firing range' : 'Click anywhere to join multiplayer'}
            </p>
          </div>
        </div>
      )}
      <div
        style={{
          position: 'absolute',
          top: 8,
          left: 8,
          zIndex: 5,
          background: 'rgba(0,0,0,0.6)',
          padding: '4px 12px',
          borderRadius: 4,
          fontSize: 14,
          pointerEvents: 'none',
        }}
      >
        {status}
      </div>
      <div
        style={{
          position: 'absolute',
          top: 8,
          right: 8,
          zIndex: 5,
          display: 'flex',
          gap: 8,
        }}
      >
        <a href="/" style={navLinkStyle}>
          Home
        </a>
        <a href={practiceMode ? '/play' : '/practice'} style={navLinkStyle}>
          {practiceMode ? 'Multiplayer' : 'Firing range'}
        </a>
      </div>
      {copyNotice && (
        <div
          style={{
            position: 'absolute',
            top: 44,
            left: 8,
            zIndex: 6,
            background: 'rgba(0,0,0,0.72)',
            padding: '4px 10px',
            borderRadius: 4,
            fontSize: 13,
            color: '#9ef79e',
            pointerEvents: 'none',
          }}
        >
          {copyNotice}
        </div>
      )}
      {connected && (
        <div
          style={{
            position: 'absolute',
            left: '50%',
            top: '50%',
            width: 18,
            height: 18,
            transform: 'translate(-50%, -50%)',
            pointerEvents: 'none',
            zIndex: 6,
            filter: `drop-shadow(0 0 6px ${crosshairGlow})`,
          }}
        >
          <div
            style={{
              position: 'absolute',
              left: '50%',
              top: 0,
              width: 2,
              height: '100%',
              transform: 'translateX(-50%)',
              background: crosshairColor,
            }}
          />
          <div
            style={{
              position: 'absolute',
              top: '50%',
              left: 0,
              width: '100%',
              height: 2,
              transform: 'translateY(-50%)',
              background: crosshairColor,
            }}
          />
        </div>
      )}
      <ControlHintsOverlay
        state={controlHintsState}
        visible={connected && isDesktop}
        inputFamilyMode={inputFamilyMode}
        onInputFamilyModeChange={setInputFamilyMode}
      />
      <DebugOverlay stats={displayStats} visible={debugVisible} />
      {debugVisible && (
        <div
          ref={renderStatsParentRef}
          style={{
            position: 'absolute',
            right: 8,
            bottom: 8,
            zIndex: 20,
          }}
        />
      )}
      {connected && (
        <GameScene
          mode={mode}
          worldDocument={worldDocument}
          onWelcome={handleWelcome}
          onDisconnect={handleDisconnect}
          onAimStateChange={setCrosshairState}
          playerId={playerId}
          onDebugFrame={updateFrame}
          onInputFrame={updateInputFrame}
          inputFamilyMode={inputFamilyMode}
          onSnapshot={recordSnapshot}
          rapierDebugModeBits={rapierDebugModeBits}
          renderStatsParent={renderStatsParentRef}
          showRenderStats={debugVisible}
        />
      )}
    </div>
  );
}

const navLinkStyle: CSSProperties = {
  background: 'rgba(0,0,0,0.6)',
  color: '#fff',
  textDecoration: 'none',
  padding: '6px 10px',
  borderRadius: 4,
  fontSize: 13,
};
