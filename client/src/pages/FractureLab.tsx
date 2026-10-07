// /fracture-lab: how broken pieces could look.
//
// One structure, broken, drawn twice: TODAY (the flat colliders, every face in
// the outer texture -- what /city draws now) beside ENHANCED (material-driven
// broken surfaces: crack relief, jagged outlines, aggregate, rebar, splinters).
// Explode it, throw it, look at the collider against the visual body, switch
// each layer on and off and see what it costs.
//
// WebGPU only (TSL). In the WebGL build the page says so and loads nothing.

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { FRACTURE_LOOKS, fractureLookVersion, resetFractureLooks } from '../city/fracture/looks';
import { FRACTURE_CLASS_NAMES, type FractureClass } from '../city/fracture/materialClass';
import { buildSpecimen, SPECIMEN_KEYS, SPECIMEN_TITLES, type Specimen, type SpecimenKey } from '../city/fracture/specimens';
import type { ExplodeMode } from '../fracturelab/explode';
import type { LabCameraApi, LabState, LabStats } from '../fracturelab/FractureLabScene';
import { LAB_PACKS, loadPackSpecimen, type LabPackKey } from '../fracturelab/packSpecimen';

const FractureLabCanvas = __WEBGPU__
  ? lazy(() => import('../fracturelab/FractureLabScene').then((m) => ({ default: m.FractureLabCanvas })))
  : null;

type SpecimenChoice = { kind: 'synthetic'; key: SpecimenKey } | { kind: 'pack'; key: LabPackKey };

const DEFAULT_STATE: LabState = {
  compare: 'split',
  mode: 'radial',
  amount: 0.3,
  spin: 0.35,
  blastToken: 0,
  blastStrength: 6,
  timeScale: 1,
  bodies: 'visual',
  shading: true,
  rough: true,
  wear: true,
  rebar: true,
  density: 1,
  debugKinds: false,
  wireframe: false,
  skin: 'procedural',
  copies: 1,
  seed: 7,
  tiered: false,
  tierRadius: 12,
  tierBudgetMs: 3,
  lookVersion: 0,
};

function initialChoice(): SpecimenChoice {
  const params = new URLSearchParams(window.location.search);
  const pack = params.get('pack');
  if (pack && LAB_PACKS.some((p) => p.key === pack)) return { kind: 'pack', key: pack as LabPackKey };
  const key = params.get('specimen');
  return { kind: 'synthetic', key: SPECIMEN_KEYS.includes(key as SpecimenKey) ? key as SpecimenKey : 'rc-wall' };
}

function initialState(): LabState {
  const params = new URLSearchParams(window.location.search);
  const state = { ...DEFAULT_STATE };
  const mode = params.get('mode');
  if (mode === 'intact' || mode === 'radial' || mode === 'crack' || mode === 'book' || mode === 'blast') state.mode = mode;
  const amount = Number(params.get('amount'));
  if (params.has('amount') && Number.isFinite(amount)) state.amount = amount;
  const compare = params.get('compare');
  if (compare === 'split' || compare === 'today' || compare === 'enhanced') state.compare = compare;
  // Layers and scale, so a link (or the stills tool) opens in a known state
  // without first building an expensive default.
  for (const key of ['shading', 'rough', 'wear', 'rebar', 'debugKinds', 'wireframe', 'tiered'] as const) {
    if (params.has(key)) state[key] = params.get(key) !== '0';
  }
  for (const key of ['spin', 'density', 'copies', 'seed', 'tierRadius', 'tierBudgetMs'] as const) {
    const v = Number(params.get(key));
    if (params.has(key) && Number.isFinite(v)) state[key] = v;
  }
  const skin = params.get('skin');
  if (skin === 'procedural' || skin === 'city') state.skin = skin;
  return state;
}

declare global {
  interface Window {
    __VIBE_FRACTURE_LAB__?: {
      ready: boolean;
      error: string | null;
      set: (partial: Partial<LabState>) => void;
      specimen: (choice: string) => void;
      stats: () => LabStats | null;
      camera: (position: [number, number, number], target: [number, number, number]) => void;
      frame: () => void;
      pieceCenter: (i: number) => [number, number, number] | null;
      pieceRadius: (i: number) => number;
      info: () => { impact: number[]; splitNormal: number[]; min: number[]; max: number[] } | null;
    };
  }
}

export function FractureLabPage() {
  const [choice, setChoice] = useState<SpecimenChoice>(initialChoice);
  const [state, setState] = useState<LabState>(initialState);
  const [specimen, setSpecimen] = useState<Specimen | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<LabStats | null>(null);
  const statsRef = useRef<LabStats | null>(null);
  const cameraRef = useRef<LabCameraApi | null>(null);
  const [panel, setPanel] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    if (choice.kind === 'synthetic') {
      setSpecimen(buildSpecimen(choice.key, state.seed));
    } else {
      setSpecimen(null);
      loadPackSpecimen(choice.key)
        .then((s) => { if (!cancelled) setSpecimen(s); })
        .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    }
    return () => { cancelled = true; };
  }, [choice, state.seed]);

  const set = useCallback((partial: Partial<LabState>) => setState((s) => ({ ...s, ...partial })), []);
  const onStats = useCallback((s: LabStats) => {
    statsRef.current = s;
    setStats(s);
  }, []);
  const onCamera = useCallback((api: LabCameraApi) => { cameraRef.current = api; }, []);

  useEffect(() => {
    window.__VIBE_FRACTURE_LAB__ = {
      ready: specimen !== null && statsRef.current !== null,
      error,
      set,
      specimen: (name: string) => {
        if (name.startsWith('pack:')) setChoice({ kind: 'pack', key: name.slice(5) as LabPackKey });
        else setChoice({ kind: 'synthetic', key: name as SpecimenKey });
      },
      stats: () => statsRef.current,
      camera: (position, target) => cameraRef.current?.setCamera(position, target),
      frame: () => cameraRef.current?.frame(),
      pieceCenter: (i: number) => cameraRef.current?.pieceCenter(i) ?? null,
      pieceRadius: (i: number) => cameraRef.current?.pieceRadius(i) ?? 0,
      info: () => (specimen
        ? { impact: specimen.impact, splitNormal: specimen.splitNormal, min: specimen.min, max: specimen.max }
        : null),
    };
  }, [specimen, error, set, stats]);
  useEffect(() => () => { delete window.__VIBE_FRACTURE_LAB__; }, []);

  const mainClass = useMemo<FractureClass | null>(() => {
    if (!specimen) return null;
    const counts = new Map<number, number>();
    for (const p of specimen.pieces) counts.set(p.cls, (counts.get(p.cls) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] as FractureClass ?? null;
  }, [specimen]);

  if (!__WEBGPU__ || !FractureLabCanvas) {
    return (
      <div style={{ padding: 24, fontFamily: 'system-ui', color: '#eee', background: '#222', minHeight: '100vh' }}>
        The Fracture Lab draws with WebGPU (TSL). Open it from the WebGPU build: <code>npm run dev:webgpu</code>.
      </div>
    );
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#1d1f22', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ position: 'absolute', top: 0, bottom: 0, right: 0, left: panel ? 300 : 0 }}>
        {specimen && (
          <Suspense fallback={null}>
            <FractureLabCanvas specimen={specimen} state={state} onStats={onStats} onCamera={onCamera} />
          </Suspense>
        )}
        {state.compare === 'split' && (
          <>
            <Label side="left">TODAY · flat colliders</Label>
            <Label side="right">ENHANCED · broken surfaces</Label>
          </>
        )}
      </div>
      {error && <div style={{ position: 'absolute', top: 12, left: 340, color: '#f88' }}>{error}</div>}
      <button type="button" onClick={() => setPanel((p) => !p)} style={toggleStyle}>{panel ? '‹' : '›'}</button>
      {panel && (
        <div style={panelStyle}>
          <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>Fracture Lab</h3>
          <Row label="Specimen">
            <select
              value={choice.kind === 'pack' ? `pack:${choice.key}` : choice.key}
              onChange={(e) => {
                const v = e.target.value;
                setChoice(v.startsWith('pack:') ? { kind: 'pack', key: v.slice(5) as LabPackKey } : { kind: 'synthetic', key: v as SpecimenKey });
              }}
              style={inputStyle}
            >
              <optgroup label="Test pieces">
                {SPECIMEN_KEYS.map((k) => <option key={k} value={k}>{SPECIMEN_TITLES[k]}</option>)}
              </optgroup>
              <optgroup label="Game buildings">
                {LAB_PACKS.map((p) => <option key={p.key} value={`pack:${p.key}`}>{p.title}</option>)}
              </optgroup>
            </select>
          </Row>
          <Row label="Show">
            <Seg value={state.compare} options={[['split', 'Side by side'], ['today', 'Today'], ['enhanced', 'Enhanced']]} onChange={(v) => set({ compare: v })} />
          </Row>
          <Row label="Bodies">
            <Seg value={state.bodies} options={[['visual', 'Visual'], ['both', 'Both'], ['collider', 'Collider']]} onChange={(v) => set({ bodies: v })} />
          </Row>

          <Section title="Explode">
            <Row label="Mode">
              <Seg<ExplodeMode> value={state.mode} options={[['intact', 'Intact'], ['radial', 'Radial'], ['crack', 'Crack'], ['book', 'Book'], ['blast', 'Blast']]} onChange={(v) => set({ mode: v, blastToken: state.blastToken + 1 })} />
            </Row>
            {state.mode !== 'blast' ? (
              <>
                <Slider label="Amount" min={0} max={1} step={0.01} value={state.amount} onChange={(v) => set({ amount: v })} />
                <Slider label="Tumble" min={0} max={1} step={0.01} value={state.spin} onChange={(v) => set({ spin: v })} />
              </>
            ) : (
              <>
                <button type="button" style={buttonStyle} onClick={() => set({ blastToken: state.blastToken + 1 })}>Blast again</button>
                <Slider label="Strength" min={1} max={14} step={0.5} value={state.blastStrength} onChange={(v) => set({ blastStrength: v })} />
                <Slider label="Time" min={0.02} max={1} step={0.01} value={state.timeScale} onChange={(v) => set({ timeScale: v })} />
              </>
            )}
            <Slider label="Seed" min={1} max={60} step={1} value={state.seed} onChange={(v) => set({ seed: v })} />
          </Section>

          <Section title="Enhanced layers">
            <Check label="Surface shading (outer skin + breaks)" value={state.shading} onChange={(v) => set({ shading: v })} />
            <Row label="Outer skin">
              <Seg value={state.skin} options={[['procedural', 'Procedural'], ['city', 'City texture']]} onChange={(v) => set({ skin: v })} />
            </Row>
            <Check label="Rough crack geometry" value={state.rough} onChange={(v) => set({ rough: v })} />
            <Check label="Worn, chipped outer edges" value={state.wear} onChange={(v) => set({ wear: v })} />
            <Check label="Rebar stubs" value={state.rebar} onChange={(v) => set({ rebar: v })} />
            <Slider label="Detail" min={0.25} max={2} step={0.05} value={state.density} onChange={(v) => set({ density: v })} />
            <Check label="Colour by face kind" value={state.debugKinds} onChange={(v) => set({ debugKinds: v })} />
            <Check label="Wireframe" value={state.wireframe} onChange={(v) => set({ wireframe: v })} />
            <Slider label="Copies" min={1} max={121} step={1} value={state.copies} onChange={(v) => set({ copies: v })} />
          </Section>

          <Section title="Scene scale">
            <Check label="Detail near the camera only (copies = one scene)" value={state.tiered} onChange={(v) => set({ tiered: v, compare: 'enhanced' })} />
            {state.tiered && (
              <>
                <Slider label="Radius" min={2} max={60} step={1} value={state.tierRadius} onChange={(v) => set({ tierRadius: v })} />
                <Slider label="ms/frame" min={0.5} max={12} step={0.5} value={state.tierBudgetMs} onChange={(v) => set({ tierBudgetMs: v })} />
              </>
            )}
          </Section>

          {mainClass !== null && (
            <LookPanel cls={mainClass} onGeometry={() => set({ lookVersion: fractureLookVersion.value })} />
          )}
        </div>
      )}
      {stats && <StatsHud stats={stats} state={state} />}
    </div>
  );
}

function LookPanel({ cls, onGeometry }: { cls: FractureClass; onGeometry: () => void }) {
  const [, force] = useState(0);
  const look = FRACTURE_LOOKS[cls];
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const geometry = (apply: () => void) => {
    apply();
    force((n) => n + 1);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      fractureLookVersion.value += 1;
      onGeometry();
    }, 180);
  };
  const shade = (apply: () => void) => {
    apply();
    force((n) => n + 1);
  };
  return (
    <Section title={`Look · ${FRACTURE_CLASS_NAMES[cls]}`}>
      <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 4 }}>Geometry (rebuilds)</div>
      <Slider label="Relief" min={0} max={0.08} step={0.001} value={look.relief.amplitude} onChange={(v) => geometry(() => { look.relief.amplitude = v; })} />
      <Slider label="Feature" min={0.01} max={0.5} step={0.005} value={look.relief.featureSize} onChange={(v) => geometry(() => { look.relief.featureSize = v; })} />
      <Slider label="Crests" min={0} max={1} step={0.01} value={look.relief.ridge} onChange={(v) => geometry(() => { look.relief.ridge = v; })} />
      <Slider label="Tilt" min={0} max={0.6} step={0.01} value={look.relief.tilt} onChange={(v) => geometry(() => { look.relief.tilt = v; })} />
      <Slider label="Gap" min={0} max={0.01} step={0.0002} value={look.relief.crackOpening} onChange={(v) => geometry(() => { look.relief.crackOpening = v; })} />
      <Slider label="Lattice" min={0.004} max={0.08} step={0.001} value={look.relief.lattice} onChange={(v) => geometry(() => { look.relief.lattice = v; })} />
      <Slider label="Rebar max" min={0.02} max={0.9} step={0.01} value={look.rebar.stubMax} onChange={(v) => geometry(() => { look.rebar.stubMax = v; })} />
      <Slider label="Rebar bend" min={0} max={90} step={1} value={look.rebar.bendDeg} onChange={(v) => geometry(() => { look.rebar.bendDeg = v; })} />
      <div style={{ fontSize: 11, opacity: 0.6, margin: '6px 0 4px' }}>Shading (live)</div>
      <Colour label="Break colour" value={look.shade.base} onChange={(v) => shade(() => { look.shade.base = v; })} />
      <Colour label="Accent" value={look.shade.accent} onChange={(v) => shade(() => { look.shade.accent = v; })} />
      <Slider label="Accent fill" min={0} max={1} step={0.01} value={look.shade.accentFill} onChange={(v) => shade(() => { look.shade.accentFill = v; })} />
      <Slider label="Accent size" min={0.002} max={0.1} step={0.001} value={look.shade.accentSize} onChange={(v) => shade(() => { look.shade.accentSize = v; })} />
      <Slider label="Bump depth" min={0} max={3} step={0.05} value={look.shade.bumpDepth} onChange={(v) => shade(() => { look.shade.bumpDepth = v; })} />
      <Slider label="Pores" min={0} max={0.3} step={0.005} value={look.shade.pores} onChange={(v) => shade(() => { look.shade.pores = v; })} />
      <Slider label="Roughness" min={0.02} max={1} step={0.01} value={look.shade.roughness} onChange={(v) => shade(() => { look.shade.roughness = v; })} />
      <Slider label="Cavity" min={0} max={1.5} step={0.01} value={look.shade.cavity} onChange={(v) => shade(() => { look.shade.cavity = v; })} />
      <button type="button" style={buttonStyle} onClick={() => { resetFractureLooks(); force((n) => n + 1); onGeometry(); }}>Reset looks</button>
    </Section>
  );
}

function StatsHud({ stats, state }: { stats: LabStats; state: LabState }) {
  const b = stats.build;
  const fmt = (n: number) => n.toLocaleString();
  return (
    <div style={hudStyle}>
      <div><b>{stats.frameMs.toFixed(1)} ms</b> frame · GPU {stats.gpuMs !== null ? `${stats.gpuMs.toFixed(2)} ms` : 'n/a'} · {stats.drawCalls} draws · {fmt(stats.triangles)} tris drawn</div>
      <div>{stats.pieces} pieces · today {fmt(stats.todayTriangles)} tris · enhanced {fmt(stats.enhancedTriangles)} tris ({(stats.enhancedTriangles / Math.max(1, stats.todayTriangles)).toFixed(0)}×)</div>
      {stats.tier && (
        <div>
          {fmt(stats.tier.chunks)} chunks · {fmt(stats.tier.skinned)} detailed near the camera · pool {fmt(stats.tier.poolVertices)} / {fmt(stats.tier.poolCapacity)} verts
          {' '}· {stats.tier.queue} queued · building {stats.tier.buildMs.toFixed(1)} ms/frame · {fmt(stats.tier.builtTotal)} built
        </div>
      )}
      {b && (
        <div>
          {b.contacts} contacts ({b.fullContacts} full) · {b.broken} broken · {b.interfaces} crack surfaces · {b.rebarStubs} rebar stubs · built in {b.ms.toFixed(0)} ms
          {state.copies > 1 ? ` · ×${state.copies} copies` : ''}
        </div>
      )}
    </div>
  );
}

// --- Small controls ---------------------------------------------------------

function Label({ side, children }: { side: 'left' | 'right'; children: ReactNode }) {
  return (
    <div style={{
      position: 'absolute', top: 14, [side]: '18%',
      color: '#fff', fontSize: 13, letterSpacing: 1.5, fontWeight: 600, textShadow: '0 1px 3px #000',
      pointerEvents: 'none',
    }}
    >
      {children}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid #ffffff22' }}>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, opacity: 0.85 }}>{title}</div>
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0', fontSize: 12 }}>
      <span style={{ width: 64, opacity: 0.75 }}>{label}</span>
      <span style={{ flex: 1 }}>{children}</span>
    </label>
  );
}

function Seg<T extends string>({ value, options, onChange }: { value: T; options: Array<[T, string]>; onChange: (v: T) => void }) {
  return (
    <span style={{ display: 'inline-flex', gap: 2, flexWrap: 'wrap' }}>
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          style={{ ...segStyle, background: v === value ? '#3b82f6' : '#2c2f35' }}
        >
          {label}
        </button>
      ))}
    </span>
  );
}

function Slider({ label, min, max, step, value, onChange }: {
  label: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void;
}) {
  return (
    <Row label={label}>
      <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} style={{ flex: 1 }} />
        <span style={{ width: 44, textAlign: 'right', fontVariantNumeric: 'tabular-nums', opacity: 0.8 }}>
          {Math.abs(value) < 0.1 && value !== 0 ? value.toFixed(4) : value.toFixed(2)}
        </span>
      </span>
    </Row>
  );
}

function Check({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, margin: '4px 0' }}>
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

const toHex = (rgb: [number, number, number]): string =>
  `#${rgb.map((c) => Math.round(Math.pow(Math.max(0, Math.min(1, c)), 1 / 2.2) * 255).toString(16).padStart(2, '0')).join('')}`;
const fromHex = (hex: string): [number, number, number] =>
  [1, 3, 5].map((i) => Math.pow(parseInt(hex.slice(i, i + 2), 16) / 255, 2.2)) as [number, number, number];

function Colour({ label, value, onChange }: { label: string; value: [number, number, number]; onChange: (v: [number, number, number]) => void }) {
  return (
    <Row label={label}>
      <input type="color" value={toHex(value)} onChange={(e) => onChange(fromHex(e.target.value))} />
    </Row>
  );
}

const panelStyle: React.CSSProperties = {
  position: 'absolute', top: 0, left: 0, bottom: 0, width: 300, overflowY: 'auto', padding: 12,
  background: 'rgba(18, 20, 24, 0.86)', color: '#e8e8e8', boxSizing: 'border-box', backdropFilter: 'blur(6px)',
};
const toggleStyle: React.CSSProperties = {
  position: 'absolute', top: 8, left: 304, zIndex: 2, background: '#2c2f35', color: '#ddd', border: 'none',
  borderRadius: 4, padding: '2px 8px', cursor: 'pointer',
};
const hudStyle: React.CSSProperties = {
  position: 'absolute', right: 10, bottom: 10, padding: '8px 10px', borderRadius: 6,
  background: 'rgba(10, 12, 16, 0.75)', color: '#dfe6ee', fontSize: 12, lineHeight: 1.5, maxWidth: 640,
  fontVariantNumeric: 'tabular-nums', pointerEvents: 'none',
};
const inputStyle: React.CSSProperties = { width: '100%', background: '#2c2f35', color: '#eee', border: '1px solid #444', borderRadius: 4, padding: 3 };
const segStyle: React.CSSProperties = { color: '#eee', border: 'none', borderRadius: 4, padding: '3px 7px', fontSize: 11, cursor: 'pointer' };
const buttonStyle: React.CSSProperties = { ...segStyle, background: '#3b82f6', margin: '4px 0', padding: '5px 10px' };
