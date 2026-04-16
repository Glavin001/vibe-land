import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { App } from '../App';
import { resolveMultiplayerBackend } from '../app/runtimeConfig';

type ActiveWorldArena = {
  arenaId: string;
  playerCount: number;
};

type ActiveWorld = {
  worldId: string;
  worldName: string;
  arenas: ActiveWorldArena[];
};

type ActiveWorldsResponse = {
  worlds: ActiveWorld[];
  defaultArenas: ActiveWorldArena[];
  maxHostedArenas: number;
  activeArenaCount: number;
};

const shellStyle: CSSProperties = {
  minHeight: '100%',
  background:
    'radial-gradient(circle at top, rgba(93, 215, 255, 0.14), transparent 32%), linear-gradient(180deg, #08111d 0%, #04070d 100%)',
  color: '#edf6ff',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '32px',
};

const cardStyle: CSSProperties = {
  width: 'min(520px, 100%)',
  background: 'rgba(6, 12, 20, 0.86)',
  border: '1px solid rgba(110, 190, 255, 0.2)',
  borderRadius: 24,
  padding: '32px',
  textAlign: 'center',
};

const overlayStyle: CSSProperties = {
  position: 'absolute',
  top: 16,
  right: 16,
  display: 'flex',
  gap: 12,
  padding: '10px 14px',
  borderRadius: 999,
  background: 'rgba(6, 12, 20, 0.78)',
  border: '1px solid rgba(110, 190, 255, 0.22)',
  color: '#edf6ff',
  fontSize: 13,
  alignItems: 'center',
  pointerEvents: 'auto',
};

type HostedWorldPageProps = {
  worldId: string;
  arenaId?: string;
};

export function HostedWorldPage({ worldId, arenaId }: HostedWorldPageProps) {
  const backend = useMemo(() => resolveMultiplayerBackend(), []);
  const [resolvedArenaId, setResolvedArenaId] = useState<string | null>(
    arenaId ?? null,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (arenaId) {
      // Arena ID was explicitly provided in the URL, use it directly.
      setResolvedArenaId(arenaId);
      return;
    }

    // No arena ID — query the server for existing arenas for this world.
    let cancelled = false;
    fetch(`${backend.httpOrigin}/active-worlds`)
      .then((r) => r.json())
      .then((data: ActiveWorldsResponse) => {
        if (cancelled) return;
        const world = data.worlds.find((w) => w.worldId === worldId);
        if (world && world.arenas.length > 0) {
          // Pick the arena with the most players (most likely to be active).
          const best = world.arenas.reduce((a, b) =>
            b.playerCount > a.playerCount ? b : a,
          );
          setResolvedArenaId(best.arenaId);
          window.history.replaceState(
            null,
            '',
            `/play/world/${encodeURIComponent(worldId)}/${encodeURIComponent(best.arenaId)}`,
          );
        } else {
          // No existing arena — create a new "main" arena.
          setResolvedArenaId('main');
          window.history.replaceState(
            null,
            '',
            `/play/world/${encodeURIComponent(worldId)}/main`,
          );
        }
      })
      .catch(() => {
        if (cancelled) return;
        // If the active-worlds endpoint fails (e.g., old server), fall back to "main".
        setResolvedArenaId('main');
        window.history.replaceState(
          null,
          '',
          `/play/world/${encodeURIComponent(worldId)}/main`,
        );
      });
    return () => {
      cancelled = true;
    };
  }, [worldId, arenaId, backend.httpOrigin]);

  if (error) {
    return (
      <div style={shellStyle}>
        <div style={cardStyle}>
          <div
            style={{
              letterSpacing: '0.28em',
              fontSize: 12,
              textTransform: 'uppercase',
              color: '#ffb4a6',
            }}
          >
            vibe-land
          </div>
          <h1 style={{ fontSize: 28, margin: '10px 0 12px' }}>
            Could not join world
          </h1>
          <p
            style={{
              color: 'rgba(237, 246, 255, 0.78)',
              margin: 0,
              lineHeight: 1.5,
            }}
          >
            {error}
          </p>
          <div
            style={{
              display: 'flex',
              justifyContent: 'center',
              gap: 16,
              marginTop: 18,
              fontSize: 14,
            }}
          >
            <a href="/gallery" style={{ color: '#9cd4ff' }}>
              Back to gallery
            </a>
            <a href="/" style={{ color: '#9cd4ff' }}>
              Home
            </a>
          </div>
        </div>
      </div>
    );
  }

  if (!resolvedArenaId) {
    return (
      <div style={shellStyle}>
        <div style={cardStyle}>
          <div
            style={{
              letterSpacing: '0.28em',
              fontSize: 12,
              textTransform: 'uppercase',
              color: '#79baf5',
            }}
          >
            vibe-land
          </div>
          <h1 style={{ fontSize: 32, margin: '10px 0 8px' }}>
            Finding arena...
          </h1>
          <p style={{ color: 'rgba(237, 246, 255, 0.74)', margin: 0 }}>
            Looking for active arenas for this world.
          </p>
        </div>
      </div>
    );
  }

  const matchId = `${worldId}:${resolvedArenaId}`;

  return (
    <App
      mode="multiplayer"
      matchId={matchId}
      autoConnect
      overlay={
        <div style={overlayStyle}>
          <span style={{ opacity: 0.75 }}>Online world</span>
          <strong>{worldId.slice(0, 8)}...</strong>
          <a
            href="/gallery"
            style={{ color: '#9cd4ff', textDecoration: 'none' }}
          >
            Gallery
          </a>
          <a href="/" style={{ color: '#9cd4ff', textDecoration: 'none' }}>
            Home
          </a>
        </div>
      }
    />
  );
}
