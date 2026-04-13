import { useState, useCallback, useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { gameModeLabel, isPracticeMode, type GameMode } from './app/gameMode';
import { isTouchDevice } from './device';
import { buildMatchHref, resolveRequestedMatchId } from './app/matchId';
import {
  DEFAULT_INPUT_BINDINGS,
  loadInputBindings,
  resetAllInputBindings,
  saveInputBindings,
  type GamepadBindings,
  type InputBindings,
  type KeyboardBindings,
} from './input/bindings';
import { GameScene } from './scene/GameScene';
import type { CrosshairAimState } from './scene/aimTargeting';
import type { DeviceFamily, InputFamilyMode, InputSample } from './input/types';
import { ControlHintsOverlay } from './ui/ControlHintsOverlay';
import { ControlsSettingsPanel } from './ui/ControlsSettingsPanel';
import { debugStatsToMarkdown, DebugOverlay } from './ui/DebugOverlay';
import { MobileHUD } from './ui/MobileHUD';
import { useControlHints } from './ui/useControlHints';
import { useDebugStats } from './ui/useDebugStats';
import { DEFAULT_WORLD_DOCUMENT, type WorldDocument } from './world/worldDocument';
import { CalibrationOverlay } from './calibration/CalibrationOverlay';
import { FirstRunPrompt } from './calibration/FirstRunPrompt';
import { CALIBRATION_WORLD_DOCUMENT } from './calibration/calibrationWorld';
import {
  getInputSettings,
  hasStoredInputSettings,
  updateInputSettings,
} from './input/inputSettingsStore';

type AppProps = {
  mode: GameMode;
  worldDocument?: WorldDocument;
  overlay?: ReactNode;
  routeLabel?: string;
  autoConnect?: boolean;
  sessionKey?: number;
};

export function App({
  mode,
  worldDocument = DEFAULT_WORLD_DOCUMENT,
  overlay,
  routeLabel,
  autoConnect = false,
  sessionKey = 0,
}: AppProps) {
  const practiceMode = isPracticeMode(mode);
  const modeLabel = gameModeLabel(mode);
  const multiplayerMatchId = resolveRequestedMatchId(window.location.search);
  const pathLabel = routeLabel ?? (
    mode === 'multiplayer'
      ? buildMatchHref('/play', multiplayerMatchId)
      : '/practice'
  );
  const [connected, setConnected] = useState(autoConnect);
  const [playerId, setPlayerId] = useState(0);
  const [status, setStatus] = useState(
    autoConnect
      ? (practiceMode ? 'Starting firing range...' : 'Connecting...')
      : 'Click to join',
  );
  const [copyNotice, setCopyNotice] = useState('');
  const [crosshairState, setCrosshairState] = useState<CrosshairAimState>('idle');
  const [inputFamilyMode, setInputFamilyMode] = useState<InputFamilyMode>('auto');
  const [controlsOpen, setControlsOpen] = useState(false);
  const [inputBindings, setInputBindings] = useState<InputBindings>(() => loadInputBindings());
  const {
    visible: debugVisible,
    displayStats,
    updateFrame,
    recordSnapshot,
    getStatsSnapshot,
    rapierDebugModeBits,
  } = useDebugStats();
  const { displayState: controlHintsState, updateInputFrame, isDesktop } = useControlHints();
  const touchMode = isTouchDevice();
  const renderStatsParentRef = useRef<HTMLDivElement>(null);
  const copyNoticeTimerRef = useRef<number | null>(null);

  // Calibration wizard state (firing range only).
  const [calibrationOpen, setCalibrationOpen] = useState(false);
  const [firstRunPromptVisible, setFirstRunPromptVisible] = useState(false);
  const [calibrationActiveFamily, setCalibrationActiveFamily] = useState<DeviceFamily | null>(null);
  const [calibrationSceneExtras, setCalibrationSceneExtras] = useState<ReactNode>(null);
  const lastKnownFamilyRef = useRef<DeviceFamily | null>(null);
  // In practice mode, once the user has connected at least once, we auto-
  // reconnect after any disconnect (e.g. from swapping worlds when calibration
  // opens/closes). This avoids the player seeing "click to rejoin" mid-wizard.
  const hasEverConnectedRef = useRef(false);

  // While the wizard is open, render a deliberately-empty flat world so
  // drill targets aren't fighting terrain or props for visibility.
  const effectiveWorldDocument = calibrationOpen ? CALIBRATION_WORLD_DOCUMENT : worldDocument;

  useEffect(() => {
    saveInputBindings(inputBindings);
  }, [inputBindings]);

  const updateKeyboardBinding = useCallback(<K extends keyof KeyboardBindings>(key: K, value: KeyboardBindings[K]) => {
    setInputBindings((current) => ({
      ...current,
      keyboard: {
        ...current.keyboard,
        [key]: value,
      },
    }));
  }, []);

  const updateGamepadBinding = useCallback(<K extends keyof GamepadBindings>(key: K, value: GamepadBindings[K]) => {
    setInputBindings((current) => ({
      ...current,
      gamepad: {
        ...current.gamepad,
        [key]: value,
      },
    }));
  }, []);

  const resetKeyboardBinding = useCallback((key: keyof KeyboardBindings) => {
    updateKeyboardBinding(key, DEFAULT_INPUT_BINDINGS.keyboard[key]);
  }, [updateKeyboardBinding]);

  const resetGamepadBinding = useCallback((key: keyof GamepadBindings) => {
    updateGamepadBinding(key, DEFAULT_INPUT_BINDINGS.gamepad[key]);
  }, [updateGamepadBinding]);

  const resetBindings = useCallback(() => {
    setInputBindings(resetAllInputBindings());
  }, []);

  const handleInputFrame = useCallback((sample: InputSample) => {
    updateInputFrame(sample);
    if (sample.activeFamily && sample.activeFamily !== lastKnownFamilyRef.current) {
      lastKnownFamilyRef.current = sample.activeFamily;
    }
  }, [updateInputFrame]);

  // First-run prompt: show it only in practice mode, only once per user, and
  // only when no stored input settings exist yet.
  useEffect(() => {
    if (!practiceMode) return;
    const stored = hasStoredInputSettings();
    const settings = getInputSettings();
    if (!stored && !settings.meta.firstRunPromptDismissed) {
      setFirstRunPromptVisible(true);
    }
  }, [practiceMode]);

  const openCalibration = useCallback(() => {
    setFirstRunPromptVisible(false);
    // Snapshot the active family at the moment the wizard opens. If we don't
    // have a known family yet (e.g. player just loaded the page), default to
    // keyboardMouse — the input arbiter will update it if they use a gamepad
    // first.
    setCalibrationActiveFamily(lastKnownFamilyRef.current ?? 'keyboardMouse');
    setCalibrationOpen(true);
  }, []);

  const dismissFirstRunPrompt = useCallback(() => {
    setFirstRunPromptVisible(false);
    updateInputSettings((draft) => {
      draft.meta.firstRunPromptDismissed = true;
      return draft;
    });
  }, []);

  const closeCalibration = useCallback(() => {
    setCalibrationOpen(false);
    setCalibrationSceneExtras(null);
  }, []);

  const handleConnect = useCallback(() => {
    setConnected(true);
    setCrosshairState('idle');
    setStatus(practiceMode ? 'Starting firing range...' : 'Connecting...');
  }, [practiceMode]);

  const handleWelcome = useCallback((id: number) => {
    setPlayerId(id);
    hasEverConnectedRef.current = true;
    const touchHint = 'Touch: left thumb moves (push past ring to sprint), right thumb swipes look, tap FIRE/JUMP/RUN';
    const desktopHint = 'controls are configurable from the Controls panel';
    setStatus(`${practiceMode ? modeLabel : `Player #${id}`} — ${touchMode ? touchHint : desktopHint}`);
  }, [modeLabel, practiceMode, touchMode]);

  const handleDisconnect = useCallback(() => {
    setStatus(`${practiceMode ? `${modeLabel} stopped` : 'Disconnected'} — click to rejoin`);
    setConnected(false);
    setPlayerId(0);
    setCrosshairState('idle');
  }, [modeLabel, practiceMode]);

  useEffect(() => {
    if (!autoConnect || connected) {
      return;
    }
    handleConnect();
  }, [autoConnect, connected, handleConnect]);

  // Auto-reconnect in practice mode after a disconnect that was triggered by
  // swapping the world document (calibration open/close). Without this the
  // player would have to click "rejoin" every time the wizard toggled.
  useEffect(() => {
    if (!practiceMode || connected) return;
    if (!hasEverConnectedRef.current) return;
    handleConnect();
  }, [practiceMode, connected, handleConnect]);

  useEffect(() => {
    if (!connected || sessionKey === 0) {
      return;
    }
    setCrosshairState('idle');
    setStatus(practiceMode ? 'Starting firing range...' : 'Connecting...');
  }, [connected, practiceMode, sessionKey]);

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

  // Suppress the click-to-join overlay during auto-reconnect transitions in
  // practice mode so the player doesn't see it flash when the calibration
  // wizard opens or closes (which triggers a brief disconnect + reconnect).
  const clickToJoinVisible = !connected && !(practiceMode && hasEverConnectedRef.current);

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      {clickToJoinVisible && (
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
              {pathLabel}
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
          zIndex: 12,
          display: 'flex',
          gap: 8,
        }}
      >
        <a href="/" style={navLinkStyle}>
          Home
        </a>
        <a href={practiceMode ? buildMatchHref('/play', multiplayerMatchId) : '/practice'} style={navLinkStyle}>
          {practiceMode ? 'Multiplayer' : 'Firing range'}
        </a>
        <button type="button" onClick={() => setControlsOpen(true)} style={navButtonStyle}>
          Controls
        </button>
        {practiceMode && connected && (
          <button
            type="button"
            onClick={openCalibration}
            style={calibrateButtonStyle}
          >
            Calibrate
          </button>
        )}
      </div>
      {overlay}
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
        bindings={inputBindings}
        state={controlHintsState}
        visible={connected && isDesktop && !touchMode}
        inputFamilyMode={inputFamilyMode}
        onInputFamilyModeChange={setInputFamilyMode}
      />
      {connected && touchMode && <MobileHUD />}
      <ControlsSettingsPanel
        open={controlsOpen}
        bindings={inputBindings}
        inputFamilyMode={inputFamilyMode}
        onClose={() => setControlsOpen(false)}
        onInputFamilyModeChange={setInputFamilyMode}
        onKeyboardBindingChange={updateKeyboardBinding}
        onGamepadBindingChange={updateGamepadBinding}
        onKeyboardBindingReset={resetKeyboardBinding}
        onGamepadBindingReset={resetGamepadBinding}
        onResetAll={resetBindings}
      />
      {practiceMode && (
        <FirstRunPrompt
          visible={firstRunPromptVisible && connected}
          onStart={openCalibration}
          onDismiss={dismissFirstRunPrompt}
        />
      )}
      {practiceMode && (
        <CalibrationOverlay
          visible={calibrationOpen}
          activeFamily={calibrationActiveFamily}
          onRequestClose={closeCalibration}
          onRenderSceneExtras={setCalibrationSceneExtras}
        />
      )}
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
          key={sessionKey}
          mode={mode}
          worldDocument={effectiveWorldDocument}
          onWelcome={handleWelcome}
          onDisconnect={handleDisconnect}
          onAimStateChange={setCrosshairState}
          playerId={playerId}
          onDebugFrame={updateFrame}
          onInputFrame={handleInputFrame}
          inputFamilyMode={inputFamilyMode}
          inputBindings={inputBindings}
          onSnapshot={recordSnapshot}
          rapierDebugModeBits={rapierDebugModeBits}
          renderStatsParent={renderStatsParentRef}
          showRenderStats={debugVisible}
          sceneExtras={calibrationSceneExtras}
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

const navButtonStyle: CSSProperties = {
  ...navLinkStyle,
  border: 'none',
  cursor: 'pointer',
};

const calibrateButtonStyle: CSSProperties = {
  background: 'rgba(149, 233, 255, 0.22)',
  border: '1px solid rgba(149, 233, 255, 0.45)',
  color: '#edf6ff',
  padding: '6px 12px',
  borderRadius: 999,
  fontSize: 13,
  cursor: 'pointer',
  fontWeight: 600,
};
