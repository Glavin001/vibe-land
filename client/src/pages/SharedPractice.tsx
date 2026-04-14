import { useEffect, useState, type CSSProperties } from 'react';
import { App } from '../App';
import { parseWorldDocument, type WorldDocument } from '../world/worldDocument';
import { fetchPublishedWorld } from '../world/worldsCloud';

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

const linkRowStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'center',
  gap: 16,
  marginTop: 18,
  fontSize: 14,
};

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'loaded'; world: WorldDocument };

type SharedPracticePageProps = {
  id: string;
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

export function SharedPracticePage({ id }: SharedPracticePageProps) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    fetchPublishedWorld(id)
      .then((raw) => {
        if (cancelled) return;
        const world = parseWorldDocument(raw);
        setState({ kind: 'loaded', world });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'Failed to load published world.';
        setState({ kind: 'error', message });
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (state.kind === 'loading') {
    return (
      <div style={shellStyle}>
        <div style={cardStyle}>
          <div style={{ letterSpacing: '0.28em', fontSize: 12, textTransform: 'uppercase', color: '#79baf5' }}>
            vibe-land
          </div>
          <h1 style={{ fontSize: 32, margin: '10px 0 8px' }}>Loading world…</h1>
          <p style={{ color: 'rgba(237, 246, 255, 0.74)', margin: 0 }}>
            Fetching <code>{id}</code> from the cloud.
          </p>
        </div>
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div style={shellStyle}>
        <div style={cardStyle}>
          <div style={{ letterSpacing: '0.28em', fontSize: 12, textTransform: 'uppercase', color: '#ffb4a6' }}>
            vibe-land
          </div>
          <h1 style={{ fontSize: 28, margin: '10px 0 12px' }}>Could not load world</h1>
          <p style={{ color: 'rgba(237, 246, 255, 0.78)', margin: 0, lineHeight: 1.5 }}>{state.message}</p>
          <div style={linkRowStyle}>
            <a href="/gallery" style={{ color: '#9cd4ff' }}>Back to gallery</a>
            <a href="/" style={{ color: '#9cd4ff' }}>Home</a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <App
      mode="practice"
      worldDocument={state.world}
      routeLabel={`/practice/shared/${id}`}
      autoConnect
      overlay={(
        <div style={overlayStyle}>
          <span style={{ opacity: 0.75 }}>Shared world</span>
          <strong>{state.world.meta.name || 'Untitled'}</strong>
          <a href="/gallery" style={{ color: '#9cd4ff', textDecoration: 'none' }}>Back to gallery</a>
          <a
            href={`/builder/world?published=${encodeURIComponent(id)}`}
            style={{ color: '#ffd89b', textDecoration: 'none' }}
          >
            Open in builder
          </a>
        </div>
      )}
    />
  );
}
