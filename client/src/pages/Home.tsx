import { useCallback, useState } from 'react';
import { MAX_USERNAME_LEN, setUsername, useUsername } from '../app/username';

function UsernameField() {
  const stored = useUsername();
  const [draft, setDraft] = useState(stored);
  const [saved, setSaved] = useState(false);

  if (draft === '' && stored !== '') {
    setDraft(stored);
  }

  const commit = useCallback(() => {
    const next = setUsername(draft);
    setDraft(next);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1500);
  }, [draft]);

  return (
    <div className="mb-6 sm:mb-8 flex items-center gap-3 flex-wrap">
      <label className="font-mono text-[10px] uppercase tracking-[0.25em] text-sky-500/60">
        Your name
      </label>
      <input
        type="text"
        value={draft}
        maxLength={MAX_USERNAME_LEN}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.currentTarget.blur();
          }
        }}
        spellCheck={false}
        autoComplete="off"
        className={[
          'bg-white/[0.04] border border-white/[0.12] rounded-md',
          'px-3 py-1.5 text-sm text-white/90 font-mono',
          'focus:outline-none focus:border-sky-400/60 focus:bg-white/[0.07]',
          'transition-colors duration-200 min-w-[180px]',
        ].join(' ')}
      />
      {saved ? (
        <span className="text-emerald-300/75 text-xs font-mono">saved</span>
      ) : null}
    </div>
  );
}

interface CardProps {
  href: string;
  tag: string;
  title: string;
  description: string;
  note: string;
  accentClass: string;
  tagClass: string;
  noteClass: string;
}

function NavCard({ href, tag, title, description, note, accentClass, tagClass, noteClass }: CardProps) {
  return (
    <a
      href={href}
      className={[
        'block no-underline text-inherit rounded-2xl p-5 sm:p-6',
        'border border-white/[0.08]',
        'border-t-2',
        accentClass,
        'bg-gradient-to-b from-white/[0.04] to-transparent',
        'transition-all duration-200',
        'hover:border-white/[0.16] hover:from-white/[0.07]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60',
      ].join(' ')}
    >
      <div className={`font-mono text-[10px] uppercase tracking-[0.25em] mb-3 ${tagClass}`}>
        {tag}
      </div>
      <h2 className="m-0 text-[22px] font-semibold leading-tight text-white/90 mb-2">
        {title}
      </h2>
      <p className="text-sm leading-relaxed text-white/55 mt-2 mb-3">
        {description}
      </p>
      <div className={`text-xs font-medium ${noteClass}`}>{note}</div>
    </a>
  );
}

export function HomePage() {
  return (
    <div className="relative h-full w-full overflow-x-hidden overflow-y-auto font-sans bg-[#050c16] text-[#edf6ff]">

      {/* Ambient background glows — fixed layer so they stay put while content scrolls */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-32 left-1/2 -translate-x-1/2 w-[900px] h-[600px] rounded-full bg-sky-500/[0.07] blur-[120px]" />
        <div className="absolute top-1/3 -right-32 w-[500px] h-[500px] rounded-full bg-cyan-600/[0.04] blur-[100px]" />
        <div className="absolute bottom-0 left-0 w-[400px] h-[400px] rounded-full bg-indigo-600/[0.03] blur-[80px]" />
      </div>

      <div className="relative z-10 mx-auto w-full max-w-[1040px] px-5 py-10 sm:px-8 sm:py-14 md:py-20">

        {/* Eyebrow */}
        <div className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.35em] text-sky-500/50 mb-6 sm:mb-10">
          <span className="w-8 h-px bg-sky-500/30" />
          vibe-land
          <span className="w-8 h-px bg-sky-500/30" />
        </div>

        {/* Hero */}
        <div className="mb-8 sm:mb-12">
          <h1 className="text-[clamp(40px,8vw,88px)] font-black leading-[0.95] tracking-tight mb-4 sm:mb-6">
            A sandbox shooter,
            <br />
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-sky-400 via-cyan-300 to-teal-300">
              live in your browser.
            </span>
          </h1>
          <p className="max-w-[640px] text-base sm:text-[17px] leading-relaxed text-white/60">
            Drill against bots solo, drop into a live match with real players, or sculpt
            a world from scratch and share it. No install. No login. Just play.
          </p>
        </div>

        <UsernameField />

        {/* Mode cards — 3 columns */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5 mb-3.5">
          <NavCard
            href="/play"
            tag="/play"
            title="Multiplayer"
            description="Jump into a live match with real players — plus bots if you want more chaos. Low-latency netcode, server-authoritative physics, vehicles and hitscan weapons."
            note="Live servers · ready to join."
            accentClass="border-t-sky-400"
            tagClass="text-sky-400/60"
            noteClass="text-sky-300/75"
          />
          <NavCard
            href="/practice"
            tag="/practice"
            title="Solo"
            description="You versus up to 32 AI bots. Tune their skill, grab a vehicle, dial in your aim. Full physics, running entirely in your browser."
            note="Works offline once loaded."
            accentClass="border-t-emerald-400"
            tagClass="text-emerald-400/60"
            noteClass="text-emerald-300/75"
          />
          <NavCard
            href="/builder/world"
            tag="/builder/world"
            title="World Builder"
            description="Sculpt terrain, carve ramps, paint materials, drop in vehicles. Spawn bots to test your arena, then publish it to the gallery."
            note="Autosaves · import + export JSON."
            accentClass="border-t-amber-400"
            tagClass="text-amber-400/60"
            noteClass="text-amber-300/70"
          />
        </div>

        {/* Gallery — full width */}
        <div className="mb-10">
          <NavCard
            href="/gallery"
            tag="/gallery"
            title="Gallery"
            description="Play worlds built by the community. Drop straight in against bots, or fork any one of them in the builder and remix it into something of your own."
            note="Fresh maps from real builders."
            accentClass="border-t-violet-400"
            tagClass="text-violet-400/60"
            noteClass="text-violet-300/70"
          />
        </div>

        {/* Footer */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 font-mono text-xs text-white/30">
          <a href="/stats" className="hover:text-sky-400/80 transition-colors duration-200">
            server stats
          </a>
          <span>·</span>
          <a href="/loadtest" className="hover:text-sky-400/80 transition-colors duration-200">
            load test
          </a>
        </div>

      </div>
    </div>
  );
}
