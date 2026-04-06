import { useState, useCallback } from 'react';
import { GameScene } from './scene/GameScene';

export function App() {
  const [connected, setConnected] = useState(false);
  const [playerId, setPlayerId] = useState(0);
  const [status, setStatus] = useState('Click to join');

  const handleConnect = useCallback(() => {
    setConnected(true);
    setStatus('Connecting...');
  }, []);

  const handleWelcome = useCallback((id: number) => {
    setPlayerId(id);
    setStatus(`Player #${id} — WASD move, mouse look, Space jump`);
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
        <GameScene
          onWelcome={handleWelcome}
          onDisconnect={handleDisconnect}
          playerId={playerId}
        />
      )}
    </div>
  );
}
