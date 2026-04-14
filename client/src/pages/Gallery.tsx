import { useEffect, useState, type CSSProperties } from 'react';
import { fetchCloudConfig, listPublishedWorlds, type GalleryWorldSummary } from '../world/worldsCloud';

const shellStyle: CSSProperties = {
  minHeight: '100%',
  background:
    'radial-gradient(circle at top, rgba(93, 215, 255, 0.14), transparent 32%), linear-gradient(180deg, #08111d 0%, #04070d 100%)',
  color: '#edf6ff',
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'center',
  padding: '32px',
};

const panelStyle: CSSProperties = {
  width: 'min(1280px, 100%)',
  background: 'rgba(6, 12, 20, 0.86)',
  border: '1px solid rgba(110, 190, 255, 0.2)',
  borderRadius: 28,
  boxShadow: '0 30px 90px rgba(0, 0, 0, 0.45)',
  padding: '40px',
};

const headerRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  flexWrap: 'wrap',
  gap: 16,
  marginBottom: 24,
};

const cardStyle: CSSProperties = {
  display: 'block',
  textDecoration: 'none',
  color: 'inherit',
  borderRadius: 20,
  border: '1px solid rgba(145, 198, 255, 0.18)',
  background: 'linear-gradient(180deg, rgba(18, 29, 45, 0.95) 0%, rgba(8, 14, 23, 0.95) 100%)',
  padding: '22px',
  cursor: 'pointer',
};

const mutedTextStyle: CSSProperties = {
  color: 'rgba(237, 246, 255, 0.62)',
  fontSize: 14,
  lineHeight: 1.6,
};

type LoadState =
  | { kind: 'loading' }
  | { kind: 'disabled' }
  | { kind: 'error'; message: string }
  | { kind: 'loaded'; worlds: GalleryWorldSummary[] };

export function GalleryPage() {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const config = await fetchCloudConfig();
        if (cancelled) return;
        if (!config.enabled) {
          setState({ kind: 'disabled' });
          return;
        }
        const worlds = await listPublishedWorlds();
        if (cancelled) return;
        setState({ kind: 'loaded', worlds });
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'Failed to load gallery.';
        setState({ kind: 'error', message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div style={shellStyle}>
      <div style={panelStyle}>
        <div style={headerRowStyle}>
          <div>
            <div style={{ letterSpacing: '0.28em', fontSize: 12, textTransform: 'uppercase', color: '#79baf5' }}>
              vibe-land
            </div>
            <h1 style={{ fontSize: 'clamp(32px, 6vw, 60px)', lineHeight: 1, margin: '10px 0 6px', fontWeight: 700 }}>
              Gallery
            </h1>
            <p style={{ maxWidth: 640, fontSize: 16, lineHeight: 1.6, color: 'rgba(237, 246, 255, 0.74)', margin: 0 }}>
              Published worlds from the community. Click any card to open it in the builder and keep editing.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 12, fontSize: 14 }}>
            <a href="/builder/world" style={{ color: '#9cd4ff' }}>Back to builder</a>
            <a href="/" style={{ color: '#9cd4ff' }}>Home</a>
          </div>
        </div>

        {state.kind === 'loading' && <div style={mutedTextStyle}>Loading published worlds…</div>}

        {state.kind === 'disabled' && (
          <div style={mutedTextStyle}>
            Cloudflare R2 is not configured on this deployment, so there is nothing to show yet. Set the
            <code style={{ margin: '0 4px' }}>R2_*</code>
            environment variables and redeploy to enable publishing.
          </div>
        )}

        {state.kind === 'error' && (
          <div style={{ ...mutedTextStyle, color: '#ffb4a6' }}>{state.message}</div>
        )}

        {state.kind === 'loaded' && state.worlds.length === 0 && (
          <div style={mutedTextStyle}>
            No worlds published yet. Open the <a href="/builder/world" style={{ color: '#9cd4ff' }}>builder</a> and hit
            Publish to be the first.
          </div>
        )}

        {state.kind === 'loaded' && state.worlds.length > 0 && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
              gap: 18,
            }}
          >
            {state.worlds.map((world) => (
              <a
                key={world.id}
                href={`/builder/world?published=${encodeURIComponent(world.id)}`}
                style={cardStyle}
              >
                <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.18em', color: '#87d6ff', marginBottom: 8 }}>
                  {formatRelativeTime(world.createdAt)} · {formatSize(world.size)}
                </div>
                <h2 style={{ margin: '6px 0 10px', fontSize: 22 }}>{world.name || 'Untitled World'}</h2>
                <p
                  style={{
                    margin: 0,
                    color: 'rgba(237, 246, 255, 0.72)',
                    fontSize: 14,
                    lineHeight: 1.5,
                    display: '-webkit-box',
                    WebkitLineClamp: 3,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                  }}
                >
                  {world.description || 'No description provided.'}
                </p>
                <div style={{ marginTop: 14, fontSize: 12, color: 'rgba(237, 246, 255, 0.5)' }}>
                  id <code>{world.id}</code>
                </div>
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatRelativeTime(createdAt: number): string {
  const deltaMs = Date.now() - createdAt;
  if (!Number.isFinite(deltaMs) || deltaMs < 0) return 'just now';
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(months / 12);
  return `${years}y ago`;
}
