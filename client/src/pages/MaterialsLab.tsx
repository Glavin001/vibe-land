// /materials: the Matter material lab. A gallery of every material on every
// form, photographed live, and an inspector that retunes one specimen with
// the recipe's own parameters (uniforms only, no recompile) and copies the
// recipe as JSON for the town kit's material table.
//
// WebGPU only: the materials are WGSL (graphics/matter). In the legacy WebGL
// build the page says so.

import { useEffect, useMemo, useRef, useState } from 'react';

import { DEFAULTS, KINDS, MATERIALS, type MaterialKind, type MaterialRecipe } from '../graphics/matter/recipes';
import type { SpecimenCamera, SpecimenView } from '../graphics/matter/lab';
import type { Lighting, ShapeName, StageOptions } from '../graphics/matter/specimens';

// The gallery's forms (graphics/matter/shapes.ts SHAPES; listed here so the
// WebGL build need not import three/webgpu to draw the page).
const SHAPES: ShapeName[] = [
  'Sphere', 'Box', 'Rounded box', 'Cylinder', 'Cone', 'Capsule', 'Torus', 'Torus knot',
  'Dodecahedron', 'Icosahedron', 'Convex hull I', 'Convex hull II', 'Lathed vessel',
  'Extruded arch', 'Compound pedestal', 'Pipe assembly',
];
const INSPECT_ONLY: ShapeName[] = ['Section block', 'Thin slab', 'Architectural pane'];
const LIGHTS: Lighting[] = ['Studio', 'Neutral', 'Grazing', 'Backlit'];
const TILE = 320;

type Lab = { camera: SpecimenCamera; createView: (el: HTMLElement) => Promise<SpecimenView> };

async function openLab(): Promise<Lab> {
  if (!__WEBGPU__) throw new Error('The material lab needs the WebGPU build (VITE_RENDER_BACKEND is webgl).');
  const lab = await import('../graphics/matter/lab');
  const camera = await lab.SpecimenCamera.create();
  lab.installLabHook(camera);
  return { camera, createView: (el) => lab.SpecimenView.create(el) };
}

export function MaterialsLabPage() {
  const [lab, setLab] = useState<Lab | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tiles, setTiles] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<{ kind: MaterialKind; shape: ShapeName } | null>(null);

  useEffect(() => {
    let cancelled = false;
    let opened: Lab | null = null;
    openLab()
      .then((value) => {
        opened = value;
        if (cancelled) value.camera.dispose();
        else setLab(value);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
      opened?.camera.dispose();
      delete window.__MATTER_LAB__;
    };
  }, []);

  // Photograph the gallery, row by row, one specimen at a time. `?capture`
  // leaves the camera to window.__MATTER_LAB__ alone (e2e/matter-parity.ts).
  useEffect(() => {
    if (!lab || new URLSearchParams(window.location.search).has('capture')) return;
    let cancelled = false;
    void (async () => {
      for (const shape of SHAPES) {
        for (const kind of KINDS) {
          if (cancelled) return;
          const url = await lab.camera.snapshot(structuredClone(DEFAULTS[kind]), shape, TILE, 'image/webp');
          if (!cancelled) setTiles((prev) => ({ ...prev, [`${kind}/${shape}`]: url }));
        }
      }
    })().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [lab]);

  const done = Object.keys(tiles).length;
  return (
    <div className="min-h-screen bg-[#141616] text-[#e6e8e2]" style={{ fontFamily: 'ui-sans-serif, system-ui' }}>
      <header className="flex items-baseline justify-between px-4 py-5 text-sm tracking-widest">
        <div>
          <span className="font-mono">{KINDS.length * SHAPES.length} SPECIMENS</span>
          <span className="mx-3 opacity-40">|</span>
          <span className="tracking-normal opacity-80">Select any object to inspect and tune it</span>
        </div>
        <div className="font-mono text-xs opacity-60">
          {error ? 'ERROR' : done < KINDS.length * SHAPES.length ? `GENERATING ${done}/${KINDS.length * SHAPES.length}` : 'ALL MATERIALS · GENERATED LIVE'}
        </div>
      </header>
      {error && <p className="px-4 pb-4 text-red-300">{error}</p>}
      <div className="grid gap-3 px-4 pb-10" style={{ gridTemplateColumns: `100px repeat(${KINDS.length}, minmax(0, 1fr))` }}>
        <div className="font-mono text-xs tracking-widest opacity-60">FORM</div>
        {KINDS.map((kind, i) => (
          <div key={kind} className="rounded bg-[#191b1b] p-3">
            <div className="flex justify-between font-mono text-[10px] opacity-60">
              <span>{String(i + 1).padStart(2, '0')}</span>
              <span className="inline-block h-2 w-2" style={{ background: MATERIALS[kind].color }} />
            </div>
            <div className="mt-2 text-lg">{MATERIALS[kind].name}</div>
            <div className="text-[11px] opacity-60">{MATERIALS[kind].tag}</div>
          </div>
        ))}
        {SHAPES.map((shape, row) => (
          <Row key={shape} shape={shape} row={row} tiles={tiles} onOpen={(kind) => setOpen({ kind, shape })} />
        ))}
      </div>
      {open && lab && <Inspector lab={lab} initial={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function Row(props: { shape: ShapeName; row: number; tiles: Record<string, string>; onOpen: (kind: MaterialKind) => void }) {
  return (
    <>
      <div className="pt-6 text-sm">
        <div className="font-mono text-[10px] opacity-60">{String(props.row + 1).padStart(2, '0')}</div>
        <div className="mt-2">{props.shape}</div>
      </div>
      {KINDS.map((kind) => {
        const url = props.tiles[`${kind}/${props.shape}`];
        return (
          <button
            key={kind}
            type="button"
            onClick={() => props.onOpen(kind)}
            className="relative aspect-square overflow-hidden rounded bg-[#c5cabf] text-left"
            data-specimen={`${kind}/${props.shape}`}
          >
            {url ? <img src={url} alt={`${kind} ${props.shape}`} className="h-full w-full object-cover" /> : null}
            <span className="absolute bottom-3 left-4 font-mono text-[11px] tracking-widest text-[#3a3f3a]">
              {String(props.row + 1).padStart(2, '0')} / {kind.toUpperCase()}
            </span>
          </button>
        );
      })}
    </>
  );
}

function Inspector(props: { lab: Lab; initial: { kind: MaterialKind; shape: ShapeName }; onClose: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<SpecimenView | null>(null);
  const [recipe, setRecipe] = useState<MaterialRecipe>(() => structuredClone(DEFAULTS[props.initial.kind]));
  const [shape, setShape] = useState<ShapeName>(props.initial.shape);
  const [options, setOptions] = useState<StageOptions>({ light: 'Studio', exposure: 1, cut: 0, ablation: false, optical: false });
  const [frameMs, setFrameMs] = useState(0);
  const material = MATERIALS[recipe.kind];

  useEffect(() => {
    if (!host.current) return;
    let created: SpecimenView | null = null;
    let cancelled = false;
    let smoothed = 16;
    const timer = setInterval(() => setFrameMs(smoothed), 500);
    void props.lab.createView(host.current).then((v) => {
      created = v;
      if (cancelled) { v.dispose(); return; }
      v.onFrameTime = (ms) => { smoothed = smoothed * 0.95 + ms * 0.05; };
      setView(v);
    });
    return () => {
      cancelled = true;
      clearInterval(timer);
      created?.dispose();
    };
  }, [props.lab]);

  // A new form or kind rebuilds the specimen; parameter changes only retune it.
  useEffect(() => { view?.show(recipe, shape); }, [view, shape, recipe.kind]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { view?.update(recipe); }, [view, recipe]);
  useEffect(() => { view?.setOptions(options); }, [view, options]);

  const json = useMemo(() => JSON.stringify(recipe), [recipe]);
  const set = (group: 'structure' | 'finish', index: number, value: number) =>
    setRecipe((r) => {
      const next = structuredClone(r);
      next[group][index] = value;
      return next;
    });

  return (
    <div className="fixed inset-0 z-50 flex bg-[#141616]/95">
      <div ref={host} className="relative min-w-0 flex-1">
        <div className="absolute left-4 top-4 font-mono text-xs opacity-70">
          {material.name} · {shape} · {frameMs.toFixed(1)} ms
        </div>
      </div>
      <aside className="w-[360px] overflow-y-auto border-l border-white/10 p-4 text-sm">
        <div className="flex items-center justify-between">
          <h2 className="text-xl">{material.name}</h2>
          <button type="button" onClick={props.onClose} className="rounded px-2 py-1 hover:bg-white/10">Close</button>
        </div>
        <p className="mt-2 text-xs opacity-70">{material.description}</p>
        <label className="mt-4 block text-xs opacity-70">Material</label>
        <select
          className="mt-1 w-full rounded bg-[#222] p-1"
          value={recipe.kind}
          onChange={(e) => setRecipe(structuredClone(DEFAULTS[e.target.value as MaterialKind]))}
        >
          {KINDS.map((k) => <option key={k} value={k}>{MATERIALS[k].name}</option>)}
        </select>
        <label className="mt-3 block text-xs opacity-70">Form</label>
        <select className="mt-1 w-full rounded bg-[#222] p-1" value={shape} onChange={(e) => setShape(e.target.value as ShapeName)}>
          {[...SHAPES, ...INSPECT_ONLY].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <label className="mt-3 block text-xs opacity-70">Light</label>
        <select
          className="mt-1 w-full rounded bg-[#222] p-1"
          value={options.light}
          onChange={(e) => setOptions((o) => ({ ...o, light: e.target.value as Lighting }))}
        >
          {LIGHTS.map((l) => <option key={l} value={l}>{l}</option>)}
        </select>
        <Slider label="Exposure" min={0.3} max={2.5} step={0.05} value={options.exposure}
          onChange={(v) => setOptions((o) => ({ ...o, exposure: v }))} />
        {shape === 'Section block' && (
          <Slider label="Section cut" min={-1} max={1} step={0.05} value={options.cut}
            onChange={(v) => setOptions((o) => ({ ...o, cut: v }))} />
        )}
        <h3 className="mt-5 text-xs tracking-widest opacity-60">PARAMETERS</h3>
        {material.parameters.map((p) => (
          <Slider
            key={`${p.group}${p.index}`}
            label={`${p.label}${p.unit ? ` (${p.unit})` : ''}`}
            title={p.description}
            min={p.min} max={p.max} step={p.step} factor={p.factor}
            value={recipe[p.group][p.index]}
            onChange={(v) => set(p.group, p.index, v)}
          />
        ))}
        <Slider label="Scale" min={0.1} max={10} step={0.05} value={recipe.scale}
          onChange={(v) => setRecipe((r) => ({ ...r, scale: v }))} />
        {(['R', 'G', 'B'] as const).map((c, i) => (
          <Slider key={c} label={`Tint ${c}`} min={0} max={2} step={0.01} value={(recipe.tint ?? [1, 1, 1])[i]}
            onChange={(v) => setRecipe((r) => {
              const tint = [...(r.tint ?? [1, 1, 1])] as [number, number, number];
              tint[i] = v;
              return { ...r, tint };
            })} />
        ))}
        <div className="mt-3 flex gap-2">
          <button type="button" className="rounded bg-white/10 px-2 py-1 hover:bg-white/20"
            onClick={() => setRecipe((r) => ({ ...r, seed: Math.floor(Math.random() * 1_000_000) }))}>New seed</button>
          <button type="button" className="rounded bg-white/10 px-2 py-1 hover:bg-white/20"
            onClick={() => setRecipe(structuredClone(DEFAULTS[recipe.kind]))}>Reset</button>
          <button type="button" className="rounded bg-white/10 px-2 py-1 hover:bg-white/20"
            onClick={() => void navigator.clipboard?.writeText(json)}>Copy recipe JSON</button>
        </div>
        <label className="mt-3 flex items-center gap-2 text-xs">
          <input type="checkbox" checked={options.optical} onChange={(e) => setOptions((o) => ({ ...o, optical: e.target.checked }))} />
          Baseline optics (stock three, for comparison)
        </label>
        <label className="mt-1 flex items-center gap-2 text-xs">
          <input type="checkbox" checked={options.ablation} onChange={(e) => setOptions((o) => ({ ...o, ablation: e.target.checked }))} />
          Without fine detail
        </label>
        <pre className="mt-3 whitespace-pre-wrap break-all rounded bg-black/30 p-2 font-mono text-[10px] opacity-70">{json}</pre>
      </aside>
    </div>
  );
}

function Slider(props: {
  label: string; title?: string; min: number; max: number; step: number; value: number; factor?: number;
  onChange: (value: number) => void;
}) {
  const shown = props.value * (props.factor ?? 1);
  return (
    <label className="mt-2 block" title={props.title}>
      <div className="flex justify-between text-xs opacity-80">
        <span>{props.label}</span>
        <span className="font-mono">{Number(shown.toPrecision(4))}</span>
      </div>
      <input type="range" className="w-full" min={props.min} max={props.max} step={props.step} value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))} />
    </label>
  );
}
