import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
  fetchCloudConfig,
  listPublishedWorlds,
  screenshotUrlForWorld,
  type GalleryWorldSummary,
} from '../world/worldsCloud';
import { loadPublishedHistory, type PublishedHistoryEntry } from '../world/publishedHistory';

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
  display: 'flex',
  flexDirection: 'column',
  textDecoration: 'none',
  color: 'inherit',
  borderRadius: 20,
  border: '1px solid rgba(145, 198, 255, 0.18)',
  background: 'linear-gradient(180deg, rgba(18, 29, 45, 0.95) 0%, rgba(8, 14, 23, 0.95) 100%)',
  padding: '18px',
  gap: 14,
};

const sectionHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: 12,
  marginBottom: 14,
  flexWrap: 'wrap',
};

const ownedBadgeStyle: CSSProperties = {
  display: 'inline-block',
  padding: '3px 10px',
  borderRadius: 999,
  background: 'rgba(140, 255, 174, 0.18)',
  border: '1px solid rgba(140, 255, 174, 0.35)',
  color: '#b9ffc3',
  fontSize: 11,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
};

const previewStyle: CSSProperties = {
  width: '100%',
  aspectRatio: '16 / 9',
  borderRadius: 12,
  overflow: 'hidden',
  background: 'linear-gradient(135deg, #0f1c2f 0%, #04070d 100%)',
  border: '1px solid rgba(145, 198, 255, 0.12)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: 'rgba(237, 246, 255, 0.4)',
  fontSize: 12,
  letterSpacing: '0.18em',
  textTransform: 'uppercase',
};

const primaryActionStyle: CSSProperties = {
  display: 'inline-block',
  padding: '9px 16px',
  borderRadius: 999,
  background: 'linear-gradient(180deg, #4cd1ff 0%, #2f8bd6 100%)',
  color: '#04121f',
  fontWeight: 600,
  fontSize: 14,
  textDecoration: 'none',
};

const secondaryActionStyle: CSSProperties = {
  display: 'inline-block',
  padding: '9px 14px',
  borderRadius: 999,
  border: '1px solid rgba(145, 198, 255, 0.3)',
  color: '#cfe7ff',
  fontSize: 13,
  textDecoration: 'none',
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
  const [publicUrl, setPublicUrl] = useState<string | null>(null);
  const [history, setHistory] = useState<PublishedHistoryEntry[]>(() => loadPublishedHistory());

  useEffect(() => {
    // Refresh whenever the page regains focus so a publish in another tab
    // shows up here immediately.
    const handleFocus = () => setHistory(loadPublishedHistory());
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, []);

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
        if (config.publicUrl) {
          setPublicUrl(config.publicUrl);
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

  const ownedSummaries = useMemo<GalleryWorldSummary[] | null>(() => {
    if (state.kind !== 'loaded' || history.length === 0) return null;
    const byId = new Map(state.worlds.map((world) => [world.id, world] as const));
    const result: GalleryWorldSummary[] = [];
    for (const entry of history) {
      const server = byId.get(entry.id);
      if (server) {
        result.push(server);
      } else {
        // The server listing didn't include this entry (pagination, deleted,
        // etc.) – fall back to the local record so the user can still see and
        // link to it.
        result.push({
          id: entry.id,
          name: entry.name,
          description: 'Published from this device – not returned by the current gallery listing.',
          createdAt: entry.publishedAt,
          size: 0,
        });
      }
    }
    return result;
  }, [state, history]);

  const communitySummaries = useMemo<GalleryWorldSummary[] | null>(() => {
    if (state.kind !== 'loaded') return null;
    if (!ownedSummaries || ownedSummaries.length === 0) return state.worlds;
    const ownedIds = new Set(ownedSummaries.map((world) => world.id));
    return state.worlds.filter((world) => !ownedIds.has(world.id));
  }, [state, ownedSummaries]);

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

        {state.kind === 'loaded' && state.worlds.length === 0 && history.length === 0 && (
          <div style={mutedTextStyle}>
            No worlds published yet. Open the <a href="/builder/world" style={{ color: '#9cd4ff' }}>builder</a> and hit
            Publish to be the first.
          </div>
        )}

        {ownedSummaries && ownedSummaries.length > 0 && (
          <section style={{ marginBottom: 30 }}>
            <div style={sectionHeaderStyle}>
              <h2 style={{ margin: 0, fontSize: 22 }}>Your publications</h2>
              <span style={{ fontSize: 13, color: 'rgba(237, 246, 255, 0.55)' }}>
                Tracked locally on this device ({ownedSummaries.length})
              </span>
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
                gap: 18,
              }}
            >
              {ownedSummaries.map((world) => (
                <GalleryCard key={`own-${world.id}`} world={world} owned publicUrl={publicUrl} />
              ))}
            </div>
          </section>
        )}

        {communitySummaries && communitySummaries.length > 0 && (
          <section>
            <div style={sectionHeaderStyle}>
              <h2 style={{ margin: 0, fontSize: 22 }}>Community gallery</h2>
              <span style={{ fontSize: 13, color: 'rgba(237, 246, 255, 0.55)' }}>
                {communitySummaries.length} world{communitySummaries.length === 1 ? '' : 's'}
              </span>
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
                gap: 18,
              }}
            >
              {communitySummaries.map((world) => (
                <GalleryCard key={world.id} world={world} publicUrl={publicUrl} />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function GalleryCard({ world, owned = false, publicUrl = null }: { world: GalleryWorldSummary; owned?: boolean; publicUrl?: string | null }) {
  const [screenshotFailed, setScreenshotFailed] = useState(false);
  const playHref = `/practice/shared/${encodeURIComponent(world.id)}`;
  const editHref = `/builder/world?published=${encodeURIComponent(world.id)}`;
  const previewHref = playHref;
  return (
    <div style={cardStyle}>
      <a
        href={previewHref}
        style={{ ...previewStyle, textDecoration: 'none' }}
        aria-label={`Play ${world.name || 'Untitled World'}`}
      >
        {screenshotFailed ? (
          <span>No preview</span>
        ) : (
          <img
            src={screenshotUrlForWorld(world.id, publicUrl)}
            alt={`Preview of ${world.name || 'Untitled World'}`}
            loading="lazy"
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            onError={() => setScreenshotFailed(true)}
          />
        )}
      </a>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.18em', color: '#87d6ff' }}>
          {formatRelativeTime(world.createdAt)} · {formatSize(world.size)}
        </div>
        {owned && <span style={ownedBadgeStyle}>yours</span>}
      </div>
      <h2 style={{ margin: '2px 0 4px', fontSize: 22 }}>{world.name || 'Untitled World'}</h2>
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
          flex: 1,
        }}
      >
        {world.description || 'No description provided.'}
      </p>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <a href={playHref} style={primaryActionStyle}>Play</a>
        <a href={editHref} style={secondaryActionStyle}>Edit in builder</a>
      </div>
      <div style={{ fontSize: 12, color: 'rgba(237, 246, 255, 0.5)' }}>
        id <code>{world.id}</code>
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
