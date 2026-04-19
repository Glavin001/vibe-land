import { useEffect, useMemo, useState } from 'react';
import {
  fetchCloudConfig,
  listPublishedWorlds,
  screenshotUrlForWorld,
  type GalleryWorldSummary,
} from '../world/worldsCloud';
import { loadPublishedHistory, type PublishedHistoryEntry } from '../world/publishedHistory';

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
    <div className="relative h-full w-full bg-[#050c16] text-[#edf6ff] overflow-x-hidden overflow-y-auto">

      {/* Ambient glows — fixed so they stay put while content scrolls */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-32 left-1/2 -translate-x-1/2 w-[800px] h-[500px] rounded-full bg-sky-500/[0.06] blur-[120px]" />
        <div className="absolute top-1/2 -right-32 w-[400px] h-[400px] rounded-full bg-violet-600/[0.04] blur-[100px]" />
      </div>

      <div className="relative z-10 mx-auto w-full max-w-[1280px] px-8 py-8">

        {/* Header */}
        <div className="flex items-baseline justify-between flex-wrap gap-4 mb-8">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.35em] text-sky-500/50 mb-3 flex items-center gap-3">
              <span className="w-6 h-px bg-sky-500/30" />
              vibe-land
            </div>
            <h1 className="text-[clamp(32px,6vw,60px)] font-black leading-none tracking-tight mb-2">
              Gallery
            </h1>
            <p className="max-w-[640px] text-base leading-relaxed text-white/45 m-0">
              Worlds shared by other builders. Click any card to play it or open it in the builder to keep editing.
            </p>
          </div>
          <div className="flex gap-4 text-sm font-mono">
            <a href="/builder/world" className="text-sky-400/60 hover:text-sky-400 transition-colors duration-200">
              Back to builder
            </a>
            <a href="/" className="text-sky-400/60 hover:text-sky-400 transition-colors duration-200">
              Home
            </a>
          </div>
        </div>

        {state.kind === 'loading' && (
          <p className="text-white/45 text-sm leading-relaxed">Loading published worlds…</p>
        )}

        {state.kind === 'disabled' && (
          <p className="text-white/45 text-sm leading-relaxed">
            World publishing isn't enabled on this deployment, so there's nothing here yet.
            Once publishing is set up, worlds from the community will appear here.
          </p>
        )}

        {state.kind === 'error' && (
          <p className="text-red-300/80 text-sm leading-relaxed">{state.message}</p>
        )}

        {state.kind === 'loaded' && state.worlds.length === 0 && history.length === 0 && (
          <p className="text-white/45 text-sm leading-relaxed">
            No worlds published yet. Open the{' '}
            <a href="/builder/world" className="text-sky-400/70 hover:text-sky-400 transition-colors">
              builder
            </a>{' '}
            and hit Publish to be the first.
          </p>
        )}

        {ownedSummaries && ownedSummaries.length > 0 && (
          <section className="mb-8">
            <div className="flex items-baseline justify-between gap-3 mb-4 flex-wrap">
              <h2 className="m-0 text-xl font-semibold text-white/85">Your publications</h2>
              <span className="text-xs font-mono text-white/35">
                Tracked locally on this device ({ownedSummaries.length})
              </span>
            </div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4">
              {ownedSummaries.map((world) => (
                <GalleryCard key={`own-${world.id}`} world={world} owned publicUrl={publicUrl} />
              ))}
            </div>
          </section>
        )}

        {communitySummaries && communitySummaries.length > 0 && (
          <section>
            <div className="flex items-baseline justify-between gap-3 mb-4 flex-wrap">
              <h2 className="m-0 text-xl font-semibold text-white/85">Community gallery</h2>
              <span className="text-xs font-mono text-white/35">
                {communitySummaries.length} world{communitySummaries.length === 1 ? '' : 's'}
              </span>
            </div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4">
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

function GalleryCard({
  world,
  owned = false,
  publicUrl = null,
}: {
  world: GalleryWorldSummary;
  owned?: boolean;
  publicUrl?: string | null;
}) {
  const [screenshotFailed, setScreenshotFailed] = useState(false);
  const playHref = `/practice/shared/${encodeURIComponent(world.id)}`;
  const editHref = `/builder/world?published=${encodeURIComponent(world.id)}`;

  return (
    <div className="flex flex-col rounded-2xl border border-white/[0.08] bg-gradient-to-b from-white/[0.04] to-transparent p-4 gap-3">

      {/* Preview image */}
      <a
        href={playHref}
        className="block w-full aspect-video rounded-xl overflow-hidden bg-gradient-to-br from-[#0f1c2f] to-[#04070d] border border-white/[0.08] no-underline"
        aria-label={`Play ${world.name || 'Untitled World'}`}
      >
        {screenshotFailed ? (
          <div className="w-full h-full flex items-center justify-center text-white/30 text-xs uppercase tracking-[0.18em] font-mono">
            No preview
          </div>
        ) : (
          <img
            src={screenshotUrlForWorld(world.id, publicUrl)}
            alt={`Preview of ${world.name || 'Untitled World'}`}
            loading="lazy"
            className="w-full h-full object-cover block"
            onError={() => setScreenshotFailed(true)}
          />
        )}
      </a>

      {/* Meta row */}
      <div className="flex items-center justify-between gap-2">
        <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-sky-400/60">
          {formatRelativeTime(world.createdAt)} · {formatSize(world.size)}
        </div>
        {owned && (
          <span className="inline-block px-2.5 py-0.5 rounded-full bg-emerald-400/[0.15] border border-emerald-400/30 text-emerald-300 text-[11px] tracking-[0.12em] uppercase font-mono">
            yours
          </span>
        )}
      </div>

      {/* Title */}
      <h2 className="m-0 text-xl font-semibold leading-tight text-white/90">
        {world.name || 'Untitled World'}
      </h2>

      {/* Description */}
      <p className="m-0 text-sm leading-relaxed text-white/50 flex-1 line-clamp-3">
        {world.description || 'No description provided.'}
      </p>

      {/* Actions */}
      <div className="flex gap-2.5 items-center flex-wrap">
        <a
          href={playHref}
          className="inline-block px-4 py-2 rounded-full bg-gradient-to-b from-sky-400 to-sky-600 text-[#04121f] font-semibold text-sm no-underline hover:from-sky-300 hover:to-sky-500 transition-all duration-200"
        >
          Play
        </a>
        <a
          href={editHref}
          className="inline-block px-3.5 py-2 rounded-full border border-white/[0.15] text-white/65 text-[13px] no-underline hover:border-white/25 hover:text-white/85 transition-all duration-200"
        >
          Edit in builder
        </a>
      </div>

      {/* Footer meta */}
      <div className="font-mono text-xs text-white/30">
        id <code className="text-white/40">{world.id}</code>
      </div>
      {world.parentId && (
        <div className="font-mono text-xs text-white/30">
          forked from{' '}
          <a
            href={`/builder/world?published=${encodeURIComponent(world.parentId)}`}
            className="text-sky-400/60 hover:text-sky-400 transition-colors"
          >
            {world.parentId.slice(0, 8)}…
          </a>
        </div>
      )}

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
