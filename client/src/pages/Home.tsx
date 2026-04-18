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
        'block no-underline text-inherit rounded-2xl p-6',
        'border border-white/[0.08]',
        'border-t-2',
        accentClass,
        'bg-gradient-to-b from-white/[0.04] to-transparent',
        'transition-all duration-200',
        'hover:border-white/[0.16] hover:from-white/[0.07]',
      ].join(' ')}
    >
      <div className={`font-mono text-[10px] uppercase tracking-[0.25em] mb-3 ${tagClass}`}>
        {tag}
      </div>
      <h2 className="m-0 text-[22px] font-semibold leading-tight text-white/90 mb-2">
        {title}
      </h2>
      <p className="text-sm leading-relaxed text-white/50 mt-2 mb-3">
        {description}
      </p>
      <div className={`text-xs font-medium ${noteClass}`}>{note}</div>
    </a>
  );
}

export function HomePage() {
  return (
    <div className="relative min-h-screen font-sans bg-[#050c16] text-[#edf6ff] flex items-center justify-center p-8 overflow-hidden">

      {/* Ambient background glows */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -top-32 left-1/2 -translate-x-1/2 w-[900px] h-[600px] rounded-full bg-sky-500/[0.07] blur-[120px]" />
        <div className="absolute top-1/3 -right-32 w-[500px] h-[500px] rounded-full bg-cyan-600/[0.04] blur-[100px]" />
        <div className="absolute bottom-0 left-0 w-[400px] h-[400px] rounded-full bg-indigo-600/[0.03] blur-[80px]" />
      </div>

      <div className="relative z-10 w-full max-w-[1040px]">

        {/* Eyebrow */}
        <div className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.35em] text-sky-500/50 mb-10">
          <span className="w-8 h-px bg-sky-500/30" />
          vibe-land
          <span className="w-8 h-px bg-sky-500/30" />
        </div>

        {/* Hero */}
        <div className="mb-10">
          <h1 className="text-[clamp(44px,8vw,88px)] font-black leading-[0.9] tracking-tight mb-5">
            One build.
            <br />
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-sky-400 via-cyan-300 to-teal-300">
              Two ways to play.
            </span>
          </h1>
          <p className="max-w-[600px] text-base leading-relaxed text-white/45">
            Multiplayer and the firing range now ship in the same web app.
            Use direct links for fast entry, or start here.
          </p>
        </div>

        {/* Mode cards — 3 columns */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5 mb-3.5">
          <NavCard
            href="/play"
            tag="/play"
            title="Multiplayer"
            description="Jump into a live match with other players. Connects automatically using the best available protocol."
            note="Requires an active server connection."
            accentClass="border-t-sky-400"
            tagClass="text-sky-400/60"
            noteClass="text-yellow-300/70"
          />
          <NavCard
            href="/practice"
            tag="/practice"
            title="Firing Range"
            description="Play solo in your browser with no server needed. Full physics and gameplay, all running client-side."
            note="Works fully offline once assets are cached."
            accentClass="border-t-emerald-400"
            tagClass="text-emerald-400/60"
            noteClass="text-emerald-300/75"
          />
          <NavCard
            href="/builder/world"
            tag="/builder/world"
            title="World Builder"
            description="Sculpt terrain, place objects, and autosave drafts. Launch a solo run directly from your current world."
            note="All data stays in your browser — import and export as JSON."
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
            description="Browse worlds published by other builders. Jump straight into a single-player run or open one in the builder to tinker."
            note="Browse worlds shared by other players."
            accentClass="border-t-violet-400"
            tagClass="text-violet-400/60"
            noteClass="text-violet-300/70"
          />
        </div>

        {/* Footer */}
        <div className="flex items-center gap-4 font-mono text-xs text-white/25">
          <a href="/stats" className="hover:text-sky-400/70 transition-colors duration-200">
            server stats
          </a>
          <span>·</span>
          <a href="/loadtest" className="hover:text-sky-400/70 transition-colors duration-200">
            load test
          </a>
        </div>

      </div>
    </div>
  );
}
