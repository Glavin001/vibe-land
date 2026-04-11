import { useState, useCallback, useRef } from 'react';
import { GameScene } from './scene/GameScene';
import type { CrosshairAimState } from './scene/aimTargeting';
import { ControlHintsOverlay } from './ui/ControlHintsOverlay';
import { DebugOverlay } from './ui/DebugOverlay';
import { useControlHints } from './ui/useControlHints';
import { useDebugStats } from './ui/useDebugStats';

const IS_LOCAL_PREVIEW = import.meta.env.MODE === 'local-preview';

export function App() {
  const [connected, setConnected] = useState(false);
  const [playerId, setPlayerId] = useState(0);
  const [status, setStatus] = useState('Click to join');
  const [crosshairState, setCrosshairState] = useState<CrosshairAimState>('idle');
  const { visible: debugVisible, displayStats, updateFrame, recordSnapshot } = useDebugStats();
  const { displayState: controlHintsState, updateInputFrame, isDesktop } = useControlHints();
  const renderStatsParentRef = useRef<HTMLDivElement>(null);

  const handleConnect = useCallback(() => {
    setConnected(true);
    setCrosshairState('idle');
    setStatus(IS_LOCAL_PREVIEW ? 'Starting local preview...' : 'Connecting...');
  }, []);

  const handleWelcome = useCallback((id: number) => {
    setPlayerId(id);
    setStatus(`${IS_LOCAL_PREVIEW ? 'Local preview' : `Player #${id}`} — KB/M: WASD + mouse, Gamepad: sticks + RT, E/X interact, Q/LB remove, F/RB place`);
  }, []);

  const handleDisconnect = useCallback(() => {
    setStatus(`${IS_LOCAL_PREVIEW ? 'Local preview stopped' : 'Disconnected'} — click to rejoin`);
    setConnected(false);
    setPlayerId(0);
    setCrosshairState('idle');
  }, []);

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
            <p style={{ fontSize: 20, opacity: 0.7 }}>
              {IS_LOCAL_PREVIEW ? 'Click anywhere to launch local preview' : 'Click anywhere to join'}
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
      <ControlHintsOverlay state={controlHintsState} visible={connected && isDesktop} />
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
          onWelcome={handleWelcome}
          onDisconnect={handleDisconnect}
          onAimStateChange={setCrosshairState}
          playerId={playerId}
          onDebugFrame={updateFrame}
          onInputFrame={updateInputFrame}
          onSnapshot={recordSnapshot}
          renderStatsParent={renderStatsParentRef}
          showRenderStats={debugVisible}
        />
      )}
    </div>
  );
}
