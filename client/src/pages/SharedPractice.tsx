import { useEffect, useState } from 'react';
import { App } from '../App';
import { parseWorldDocument, type WorldDocument } from '../world/worldDocument';
import { fetchCloudConfig, fetchPublishedWorld } from '../world/worldsCloud';

async function loadPublishedWorldForRoute(id: string): Promise<unknown> {
  const params = new URLSearchParams(window.location.search);
  const useLocalPublished = import.meta.env.DEV && params.get('local') === '1';
  if (useLocalPublished) {
    const response = await fetch(`/published/${encodeURIComponent(id)}.world.json`);
    if (!response.ok) {
      throw new Error(
        `Local world file missing (HTTP ${response.status}). Place worlds/${id}.world.json at the repo root or drop ?local=1.`,
      );
    }
    return response.json();
  }
  const config = await fetchCloudConfig();
  return fetchPublishedWorld(id, config.publicUrl);
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'loaded'; world: WorldDocument };

type SharedPracticePageProps = {
  id: string;
};

export function SharedPracticePage({ id }: SharedPracticePageProps) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const loadFromLocalDevFile = import.meta.env.DEV
    && new URLSearchParams(window.location.search).get('local') === '1';

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    loadPublishedWorldForRoute(id)
      .then((raw) => {
        if (cancelled || !raw) return;
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
      <div className="relative min-h-full bg-[#050c16] text-[#edf6ff] flex items-center justify-center p-8 overflow-hidden">
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -top-32 left-1/2 -translate-x-1/2 w-[700px] h-[500px] rounded-full bg-sky-500/[0.07] blur-[120px]" />
        </div>
        <div className="relative z-10 w-full max-w-[520px] bg-white/[0.03] border border-white/[0.08] rounded-3xl p-8 text-center">
          <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-sky-500/50 mb-4">
            vibe-land
          </div>
          <h1 className="text-3xl font-bold m-0 mb-2 text-white/90">Loading world…</h1>
          <p className="text-white/45 m-0 text-sm leading-relaxed">
            {loadFromLocalDevFile ? (
              <>
                Loading <code className="font-mono text-white/60">{id}</code> from{' '}
                <code className="font-mono text-white/60">worlds/{id}.world.json</code> (dev).
              </>
            ) : (
              <>
                Fetching <code className="font-mono text-white/60">{id}</code> from the cloud.
              </>
            )}
          </p>
        </div>
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div className="relative min-h-full bg-[#050c16] text-[#edf6ff] flex items-center justify-center p-8 overflow-hidden">
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -top-32 left-1/2 -translate-x-1/2 w-[700px] h-[500px] rounded-full bg-red-500/[0.05] blur-[120px]" />
        </div>
        <div className="relative z-10 w-full max-w-[520px] bg-white/[0.03] border border-white/[0.08] border-t-2 border-t-red-400 rounded-3xl p-8 text-center">
          <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-red-400/60 mb-4">
            vibe-land
          </div>
          <h1 className="text-2xl font-bold m-0 mb-3 text-white/85">Could not load world</h1>
          <p className="text-white/55 m-0 leading-relaxed text-sm">{state.message}</p>
          <div className="flex justify-center gap-5 mt-5 text-sm font-mono">
            <a href="/gallery" className="text-sky-400/60 hover:text-sky-400 transition-colors duration-200">
              Back to gallery
            </a>
            <a href="/" className="text-sky-400/60 hover:text-sky-400 transition-colors duration-200">
              Home
            </a>
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
        <div className="absolute top-4 right-4 flex gap-3 px-3.5 py-2.5 rounded-full bg-[rgba(5,12,22,0.82)] border border-white/[0.14] text-[#edf6ff] text-[13px] items-center pointer-events-auto backdrop-blur-sm">
          <span className="text-white/50">Shared world</span>
          <strong className="font-semibold text-white/85">{state.world.meta.name || 'Untitled'}</strong>
          <a href="/gallery" className="text-sky-400/70 no-underline hover:text-sky-400 transition-colors duration-200">
            Back to gallery
          </a>
          <a
            href={`/builder/world?published=${encodeURIComponent(id)}`}
            className="text-amber-300/70 no-underline hover:text-amber-300 transition-colors duration-200"
          >
            Open in builder
          </a>
        </div>
      )}
    />
  );
}
