import { useEffect, useRef, useState } from 'react';
import { PALETTE_SLOTS, paletteClipId, type PaletteChoice, type PaletteSlot, type PaletteCatalog } from './soundPalette';
import './SoundPalettePanel.css';

type PaletteSource = PaletteCatalog['sources'][number];
export interface SoundPalettePanelProps {
  choices: Record<PaletteSlot, PaletteChoice>;
  onChoose: (slot: PaletteSlot, choice: PaletteChoice) => void;
  onAudition: (slot: PaletteSlot, choice: PaletteChoice, options: { reflections: boolean }) => Promise<void>;
  onStop: () => void;
  reflections: boolean;
  onReflectionsChange: (enabled: boolean) => void;
  onPlayScene: () => void;
}
const ROLES: Record<PaletteSlot, { label: string; detail: string; group: string }> = {
  masonryImpact: { label: 'Brick & stone impact', detail: 'Heavy individual masonry hits and breaks, such as a large chunk striking the ground.', group: 'MATERIAL' },
  masonryCollapse: { label: 'Masonry collapse', detail: 'The sustained rubble around you as masonry keeps falling and colliding.', group: 'MATERIAL' },
  metalImpact: { label: 'Metal impact', detail: 'A hard contact with steel, vehicle structure, or a metal prop.', group: 'MATERIAL' },
  metalCollapse: { label: 'Metal collapse', detail: 'Bent structure and falling metal, with a longer breakup than a single hit.', group: 'MATERIAL' },
  projectileFlyby: { label: 'Fast projectile', detail: 'A compact, fast object such as a cannonball passing close by.', group: 'NEAR MISS' },
  debrisFlyby: { label: 'Flying debris', detail: 'A tumbling chunk or slab crossing near the listener.', group: 'NEAR MISS' },
  massiveFlyby: { label: 'Massive flyby', detail: 'The broader pass of a meteor or another large moving object.', group: 'NEAR MISS' },
};
const CHOICES: readonly PaletteChoice[] = ['original', 'natural', 'designed'];
const ORIGIN_LABELS = { recorded: 'Recording', hybrid: 'Layered recordings', synth: 'Synthesis' };
function isFlyby(slot: PaletteSlot) { return slot.endsWith('Flyby'); }
function choiceName(slot: PaletteSlot, choice: PaletteChoice): string {
  if (choice === 'original') return 'Original layer';
  if (choice === 'natural') return isFlyby(slot) ? 'Clean pass' : 'Recording focus';
  return isFlyby(slot) ? 'Shaped motion' : 'Designed weight';
}
function fallbackDescription(slot: PaletteSlot, choice: PaletteChoice): string {
  if (choice === 'original') return 'Preview one isolated layer. Use in mix restores the full original recipe for this role.';
  if (isFlyby(slot)) return choice === 'natural' ? 'A restrained pass with a distinct approach and departure.' : 'A broader motion shape that gives this object its own character.';
  return choice === 'natural' ? 'Bring the recorded contact or break texture forward.' : 'Layer the source for more body and a stronger sense of scale.';
}

export function SoundPalettePanel({ choices, onChoose, onAudition, onStop, reflections, onReflectionsChange, onPlayScene }: SoundPalettePanelProps) {
  const [slot, setSlot] = useState<PaletteSlot>('masonryImpact');
  const [catalog, setCatalog] = useState<PaletteCatalog | null>(null);
  const [previewed, setPreviewed] = useState<Set<string>>(() => new Set());
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState('Previewing a take leaves your mix unchanged.');
  const generation = useRef(0);
  const latestReflections = useRef(reflections);
  latestReflections.current = reflections;
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/audio/options/catalog.json', { signal: controller.signal }).then(async response => {
      if (!response.ok) return;
      const data = await response.json() as PaletteCatalog;
      if (data && typeof data.clips === 'object' && Array.isArray(data.sources)) setCatalog(data);
    }).catch(() => { /* Audition errors are reported separately; provenance links still work. */ });
    return () => { controller.abort(); generation.current++; };
  }, []);
  function stop() { generation.current++; onStop(); setPending(null); setMessage('Preview stopped.'); }
  async function preview(choice: PaletteChoice) {
    const key = `${slot}:${choice}`, token = ++generation.current;
    onStop(); setPending(key); setMessage(`Loading ${choiceName(slot, choice).toLowerCase()}…`);
    try {
      await onAudition(slot, choice, { reflections });
      if (generation.current !== token) return;
      setPreviewed(previous => new Set([...previous, key]));
      setMessage(`${ROLES[slot].label} · ${choiceName(slot, choice)} · ${latestReflections.current ? 'with reflections' : 'dry reference'}.`);
    } catch (error) {
      if (generation.current === token) setMessage(error instanceof DOMException && error.name === 'AbortError' ? 'Preview cancelled.' : `Preview unavailable: ${error instanceof Error ? error.message : String(error)}`);
    } finally { if (generation.current === token) setPending(null); }
  }
  const currentRole = ROLES[slot];
  return <section className="sound-casting" aria-label="Sound casting">
    <header className="sound-casting-heading">
      <div><span className="sound-casting-eyebrow">SOUND CASTING</span><h2>Choose the sounds in your mix.</h2><p>Preview a role, choose a take, then hear it in the scene.</p></div>
      <div className="sound-casting-tools">
        <div className="sound-casting-room" aria-label="Review reflections">
          <button type="button" aria-pressed={!reflections} onClick={() => onReflectionsChange(false)}>Dry</button>
          <button type="button" aria-pressed={reflections} onClick={() => onReflectionsChange(true)}>With reflections</button>
        </div>
        <button type="button" className="sound-casting-stop" onClick={stop}>■ <span>Stop preview</span></button>
        <button type="button" className="sound-casting-scene" onClick={() => { generation.current++; setPending(null); setMessage('Playing the current scene with your selected takes.'); onPlayScene(); }}>Play current scene ▶</button>
      </div>
    </header>
    <div className="sound-casting-body">
      <nav className="sound-casting-roles" aria-label="Sound roles">
        {PALETTE_SLOTS.map(role => <button type="button" key={role} aria-pressed={slot === role} aria-label={`Edit ${ROLES[role].label}`} onClick={() => { if (role !== slot) stop(); setSlot(role); setMessage(`${ROLES[role].label}: compare the three takes below.`); }}>
          <span><strong>{ROLES[role].label}</strong><small>{choiceName(role, choices[role])}</small></span>
          <span className="sound-role-previewed" title={previewed.has(`${role}:${choices[role]}`) ? 'Current choice previewed' : 'Current choice not previewed'} aria-label={previewed.has(`${role}:${choices[role]}`) ? 'Current choice previewed' : 'Current choice not previewed'}>{previewed.has(`${role}:${choices[role]}`) ? '✓' : '○'}</span>
        </button>)}
      </nav>
      <div className="sound-casting-options">
        <div className="sound-casting-role-heading"><div><span className="sound-casting-eyebrow">{currentRole.group}</span><h3>{currentRole.label}</h3></div><p>{currentRole.detail}</p></div>
        <div className="sound-casting-cards">{CHOICES.map((choice, index) => {
          const selected = choices[slot] === choice, key = `${slot}:${choice}`, heard = previewed.has(key), busy = pending === key;
          const clip = catalog?.clips[paletteClipId(slot, choice)];
          const origin = clip?.origin ?? (choice === 'original' ? isFlyby(slot) ? 'synth' : 'hybrid' : null);
          const sources = clip?.sources?.map(id => catalog?.sources.find(source => source.id === id)).filter((source): source is PaletteSource => Boolean(source)) ?? [];
          const name = choiceName(slot, choice);
          return <article className={`sound-casting-card ${selected ? 'is-selected' : ''}`} key={key} aria-label={`${currentRole.label}: ${name}`}>
            <div className="sound-casting-card-top"><span>TAKE 0{index + 1}</span><span>{selected ? 'In your mix' : heard ? 'Previewed' : 'Not previewed'}</span></div>
            <h4>{name}</h4>
            <p className="sound-casting-card-description">{clip?.description || fallbackDescription(slot, choice)}</p>
            <div className="sound-casting-source"><span>{origin ? choice === 'original' && origin === 'hybrid' ? 'Recording + synthesis' : ORIGIN_LABELS[origin] : 'Source details in catalog'}</span>
              {sources.length ? <ul>{sources.map(source => <li key={source.id}><a href={/^https?:\/\//.test(source.url) ? source.url : '/audio/options/SOURCES.md'} target="_blank" rel="noreferrer">{source.title} ↗</a><small>{source.creator} · {source.license}</small></li>)}</ul> : <a href={choice === 'original' ? '/audio/destruction/SOURCES.md' : '/audio/options/SOURCES.md'} target="_blank" rel="noreferrer">Source notes ↗</a>}
            </div>
            <div className="sound-casting-card-actions"><button type="button" className="sound-casting-preview" aria-label={`Preview ${name}`} aria-busy={busy} onClick={() => void preview(choice)}>{busy ? 'Loading…' : '▶ Preview'}{heard && !selected && <span className="sound-preview-mark" aria-hidden="true">✓</span>}</button><button type="button" className="sound-casting-use" aria-label={`Use ${name} in mix`} aria-pressed={selected} onClick={() => { onChoose(slot, choice); setMessage(`${currentRole.label} now uses ${name}. Play the scene to hear your choice.`); }}>{selected ? '✓ In mix' : 'Use in mix'}</button></div>
          </article>;
        })}</div>
        <div className="sound-casting-footer"><p role="status" aria-live="polite">{message}</p><span>Level matched where peak headroom allows.</span></div>
      </div>
    </div>
    <details className="sound-casting-provenance"><summary>What are these sounds made from?</summary><p>The original palette uses <a href="https://kenney.nl/assets/impact-sounds" target="_blank" rel="noreferrer">Kenney</a> and <a href="/audio/destruction/SOURCES.md" target="_blank" rel="noreferrer">rubberduck recordings</a>, with synthesized body and air layers. Reflections are added separately. Its building-collapse sound is assembled from smaller recordings and synthesis; the original bank contains no recording of a full building collapse. Each new take shows its own source type and attribution above.</p></details>
  </section>;
}
