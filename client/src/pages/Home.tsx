const cardClass =
  'flex-[1_1_280px] min-w-0 block no-underline text-inherit rounded-[20px] border border-[rgba(145,198,255,0.18)] bg-[linear-gradient(180deg,rgba(18,29,45,0.95)_0%,rgba(8,14,23,0.95)_100%)] p-6 transition-colors hover:border-[rgba(145,198,255,0.38)] hover:bg-[linear-gradient(180deg,rgba(22,36,56,0.95)_0%,rgba(10,18,30,0.95)_100%)]';

interface CardProps {
  href: string;
  tag: string;
  title: string;
  description: string;
  note: string;
  noteColor: string;
}

function NavCard({ href, tag, title, description, note, noteColor }: CardProps) {
  return (
    <a href={href} className={cardClass}>
      <div className="text-xs uppercase tracking-[0.18em] text-[#87d6ff] mb-2.5">{tag}</div>
      <h2 className="m-0 text-[30px] font-semibold">{title}</h2>
      <p className="mt-3 mb-[18px] text-[rgba(237,246,255,0.74)] leading-relaxed">{description}</p>
      <div className={`text-sm ${noteColor}`}>{note}</div>
    </a>
  );
}

export function HomePage() {
  return (
    <div className="font-sans min-h-full flex items-center justify-center p-8 text-[#edf6ff] bg-[radial-gradient(circle_at_top,rgba(93,215,255,0.14),transparent_32%),linear-gradient(180deg,#08111d_0%,#04070d_100%)]">
      <div className="w-full max-w-[1040px] bg-[rgba(6,12,20,0.86)] border border-[rgba(110,190,255,0.2)] rounded-[28px] shadow-[0_30px_90px_rgba(0,0,0,0.45)] p-10">

        {/* Header */}
        <div className="mb-7">
          <div className="tracking-[0.28em] text-xs uppercase text-[#79baf5]">
            vibe-land
          </div>
          <h1 className="text-[clamp(44px,8vw,88px)] leading-[0.95] mt-3 mb-[14px] font-bold">
            One build. Two ways to play.
          </h1>
          <p className="mt-4 max-w-[760px] text-lg leading-relaxed text-[rgba(237,246,255,0.74)]">
            Multiplayer and the firing range now ship in the same web app. Use direct links for fast entry, or start here.
          </p>
        </div>

        {/* Mode cards */}
        <div className="flex flex-wrap gap-[18px] mb-[18px]">
          <NavCard
            href="/play"
            tag="/play"
            title="Multiplayer"
            description="Join the networked game. WebTransport is preferred, with WebSocket fallback when needed."
            note="Best when the game backend is reachable from this browser."
            noteColor="text-[#fff5b1]"
          />
          <NavCard
            href="/practice"
            tag="/practice"
            title="Firing Range"
            description="Run the local WASM simulation in-browser with no Rust server required. This is the current single-player mode."
            note="Works offline after assets are cached."
            noteColor="text-[#b9ffc3]"
          />
          <NavCard
            href="/builder/world"
            tag="/builder/world"
            title="World Builder"
            description="Sculpt terrain, place authored objects, autosave local drafts, and launch a fresh single-player run from the current world document."
            note="Browser-local authoring with JSON import and export."
            noteColor="text-[#ffe0a2]"
          />
          <NavCard
            href="/gallery"
            tag="/gallery"
            title="Gallery"
            description="Browse worlds published by other builders. Jump straight into a single-player run or open one in the builder to tinker."
            note="Available when the deployment has Cloudflare R2 configured."
            noteColor="text-[#cdb1ff]"
          />
        </div>

        {/* Footer links */}
        <div className="flex flex-wrap gap-3 text-sm text-[rgba(237,246,255,0.62)]">
          <a href="/stats" className="text-[#9cd4ff] hover:text-[#c4e8ff] transition-colors">Server stats</a>
          <a href="/loadtest" className="text-[#9cd4ff] hover:text-[#c4e8ff] transition-colors">Load test</a>
        </div>
      </div>
    </div>
  );
}
