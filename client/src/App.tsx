import { useState, useCallback } from 'react';
import { GameScene } from './scene/GameScene';
import { DebugOverlay } from './ui/DebugOverlay';
import { useDebugStats } from './ui/useDebugStats';

export function App() {
  const [connected, setConnected] = useState(false);
  const [playerId, setPlayerId] = useState(0);
  const [status, setStatus] = useState('Click to join');
  const { visible: debugVisible, displayStats, updateFrame, recordSnapshot } = useDebugStats();

  const handleConnect = useCallback(() => {
    setConnected(true);
    setStatus('Connecting...');
  }, []);

  const handleWelcome = useCallback((id: number) => {
    setPlayerId(id);
    setStatus(`Player #${id} — WASD move, mouse look, Space jump, left click remove, right click place, 1/2 switch block`);
  }, []);

  const handleDisconnect = useCallback(() => {
    setStatus('Disconnected — click to rejoin');
    setConnected(false);
    setPlayerId(0);
  }, []);

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
            <p style={{ fontSize: 20, opacity: 0.7 }}>Click anywhere to join</p>
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
              background: 'rgba(255,255,255,0.9)',
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
              background: 'rgba(255,255,255,0.9)',
            }}
          />
        </div>
      )}
      <DebugOverlay stats={displayStats} visible={debugVisible} />
      {connected && (
        <GameScene
          onWelcome={handleWelcome}
          onDisconnect={handleDisconnect}
          playerId={playerId}
          onDebugFrame={updateFrame}
          onSnapshot={recordSnapshot}
        />
      )}
    </div>
  );
}
