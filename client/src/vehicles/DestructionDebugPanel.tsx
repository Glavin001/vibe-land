// Garage destruction controls: the range cannon (ball mass/speed), bombardment,
// reset, and the debug readback of what PhysX holds for the car.
import { useEffect, useRef, useState } from 'react';
import { resolveMultiplayerBackend } from '../app/runtimeConfig';
import { setShotMode, shotMode } from '../city/shotMode';
import { actorColor, anyDebugLayer, updateDebug, useDebugState, type Assembly, type DebugLayers } from './destructionDebug';

const MASSES = [30, 100, 300, 1000, 3000];
// Above ~24 m/s the 0.4 m ball can pass through a thin part between ticks.
const SPEEDS = [10, 20, 40, 60];
const LAYERS: [keyof DebugLayers, string, string][] = [
  ['colliders', 'Colliders', 'PhysX hulls at their server pose, coloured by owning body (green = car, orange = wheel hull excluded from terrain)'],
  ['bonds', 'Bonds', 'Intact bonds: part centre → bond centroid → part centre, green to red by stress utilisation; red across two bodies = graph/body mismatch'],
  ['centers', 'Mass', 'Each body\'s centre of mass and velocity'],
  ['hideVisuals', 'Hide visuals', 'Hide the rendered vehicle to see only what the server simulates'],
];

// A range can park several copies of the car (the server's MAX_RANGE_CARS).
const MAX_CARS = 4;

export function DestructionDebugPanel({ matchId, geometryHash, range, onReset, cars = 1, onCars }: {
  matchId: string; geometryHash: string; range: boolean; onReset?: () => void;
  /** Cars in this session, and a request for a fresh range with another count. */
  cars?: number; onCars?: (cars: number) => void;
}) {
  const { layers, data, assembly, selectedPart } = useDebugState();
  // The car the debug readback, part shots and meteor are for. Sides are as
  // the range player sees them, facing +z: +x is on the left.
  const [car, setCar] = useState(0);
  useEffect(() => { if (car >= cars) setCar(0); }, [car, cars]);
  useEffect(() => { updateDebug({ data: null }); }, [car]);
  const origin = resolveMultiplayerBackend().httpOrigin, session = `${origin}/vehicle-assets/session/${encodeURIComponent(matchId)}`;
  const [mass, setMass] = useState(1000), [speed, setSpeed] = useState(20), [error, setError] = useState(''), [open, setOpen] = useState(true);
  const polling = useRef(false);

  useEffect(() => {
    if (!range) return;
    const previous = shotMode(); setShotMode('cannonball');
    return () => setShotMode(previous);
  }, [range]);
  useEffect(() => {
    if (!range) return;
    fetch(`${session}/range`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ballMass: mass, ballSpeed: speed }) })
      .then(async r => { if (!r.ok) throw Error(await r.text()); setError(''); }).catch(e => setError(String(e instanceof Error ? e.message : e)));
  }, [session, range, mass, speed]);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`${origin}/vehicle-assets/${geometryHash}/metadata.json`, { signal: controller.signal })
      .then(r => r.ok ? r.json() : null).then((m: Assembly | null) => { if (m) updateDebug({ assembly: m }); }).catch(() => {});
    return () => { controller.abort(); updateDebug({ assembly: null, data: null, selectedPart: null }); };
  }, [origin, geometryHash]);
  // Poll while any layer or the panel is showing.
  const active = anyDebugLayer(layers) || open;
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      if (polling.current) return;
      polling.current = true;
      fetch(`${session}/debug?car=${car}`).then(async r => { if (!r.ok) throw Error(await r.text()); updateDebug({ data: await r.json() }); setError(''); })
        .catch(e => setError(String(e instanceof Error ? e.message : e))).finally(() => { polling.current = false; });
    }, 100);
    return () => clearInterval(timer);
  }, [session, active, car]);

  // The server picks a clear line to the part (eye line first).
  async function fireAt() {
    if (selectedPart === null) return;
    try {
      const r = await fetch(`${session}/range/fire`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ part: selectedPart, car }) });
      if (!r.ok) throw Error(await r.text());
    } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
  }
  async function meteor() {
    try {
      const r = await fetch(`${session}/range/meteor`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(selectedPart === null ? { car } : { part: selectedPart, car }) });
      if (!r.ok) throw Error(await r.text());
    } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
  }
  const partName = (i: number) => assembly?.parts[i] ? `${assembly.parts[i].name ?? assembly.parts[i].id} #${i}` : `#${i}`;
  const hullsByActor = new Map<number, Set<number>>();
  data?.hulls.forEach(h => { const s = hullsByActor.get(h.actor) ?? new Set(); s.add(h.part); hullsByActor.set(h.actor, s); });
  const stressed = data ? [...data.bonds].filter(b => !b.broken).sort((a, b) => b.utilisation - a.utilisation).slice(0, 8) : [];
  const wheels = data ? [0, 1, 2, 3].map(w => data.vehicle.wheelMask & (1 << w) ? '●' : '○').join('') : '';

  return <div className="garage-debug">
    <div className="garage-debug-bar">
      {range && <>
        {onCars && <label title="Park this many copies of the car side by side (resets the range)">Cars <select value={cars} onChange={e => onCars(Number(e.target.value))}>
          {Array.from({ length: MAX_CARS }, (_, i) => i + 1).map(n => <option key={n} value={n}>{n}</option>)}</select></label>}
        {cars > 1 && <label title="The car the debug readback, part shots and meteor are for">Car <select value={car} onChange={e => setCar(Number(e.target.value))}>
          {Array.from({ length: cars }, (_, i) => <option key={i} value={i}>{i === 0 ? '1 (centre)' : `${i + 1} (${i % 2 ? 'left' : 'right'})`}</option>)}</select></label>}
        <label>Ball <select value={mass} onChange={e => setMass(Number(e.target.value))}>{MASSES.map(m => <option key={m} value={m}>{m} kg</option>)}</select></label>
        <label title="Above ~24 m/s the ball can pass through thin parts between physics ticks"><select value={speed} onChange={e => setSpeed(Number(e.target.value))}>{SPEEDS.map(s => <option key={s} value={s}>{s} m/s</option>)}</select></label>
        <label>Target <select value={selectedPart ?? ''} onChange={e => updateDebug({ selectedPart: e.target.value === '' ? null : Number(e.target.value) })}>
          <option value="">(pick a part)</option>
          {assembly?.parts.map((p, i) => p.shapes.length ? <option key={i} value={i}>{p.name ?? p.id} #{i}</option> : null)}
        </select></label>
        <button disabled={selectedPart === null || !data} onClick={() => void fireAt()}>Fire at part</button>
        <button title="Drop the city's meteor (2 m, 110 t, 140 m/s) on the selected part, or the car" onClick={() => void meteor()}>Meteor</button>
        {onReset && <button onClick={onReset}>{cars > 1 ? 'Reset cars' : 'Reset car'}</button>}
      </>}
      {LAYERS.map(([key, label, title]) => <button key={key} title={title} aria-pressed={layers[key]} onClick={() => updateDebug({ layers: { ...layers, [key]: !layers[key] } })}>{label}</button>)}
      <button aria-expanded={open} onClick={() => setOpen(!open)}>Details</button>
    </div>
    {open && <aside className="garage-debug-panel" aria-label="Destruction debug">
      {error && <p role="alert" className="garage-error">{error}</p>}
      {!data ? <p>Waiting for the server…</p> : <>
        <p>{cars > 1 && `car ${car + 1} · `}tick {data.serverTick} · stress steps {data.steps} · rejected {data.rejectedSteps} · last {data.lastStatus ? `${data.lastStatus.converged ? 'converged' : 'NOT converged'} in ${data.lastStatus.iterations} it, error ${data.lastStatus.error}` : '—'}</p>
        <p>broken bonds {data.brokenBonds} / {data.bonds.length} · wheels {wheels} · engine {data.vehicle.engineConnected ? 'on' : 'off'}</p>
        <h3>Bodies ({data.actors.length})</h3>
        <table><thead><tr><th/><th>parts</th><th>mass</th><th>|v|</th><th>v.y</th><th>state</th></tr></thead><tbody>
          {data.actors.map(a => { const v = Math.hypot(...a.linearVelocity); const parts = [...(hullsByActor.get(a.actor) ?? [])];
            return <tr key={a.actor} className={a.gravityDisabled && a.actor !== 0 ? 'warn' : ''} title={parts.map(partName).join('\n')}>
              <td><i style={{ background: actorColor(a.actor) }} />{a.actor === 0 ? 'car' : a.actor}</td><td>{parts.length}</td><td>{a.mass.toFixed(1)}</td><td>{v.toFixed(2)}</td><td>{a.linearVelocity[1].toFixed(2)}</td>
              <td>{[a.sleeping && 'asleep', a.kinematic && 'kinematic', a.gravityDisabled && 'NO GRAVITY'].filter(Boolean).join(' ') || 'awake'}</td></tr>; })}
        </tbody></table>
        <h3>Most stressed intact bonds</h3>
        <ul>{stressed.map(b => <li key={b.index}><button onClick={() => updateDebug({ selectedPart: selectedPart === b.a ? null : b.a })}>{partName(b.a)}</button> ↔ <button onClick={() => updateDebug({ selectedPart: selectedPart === b.b ? null : b.b })}>{partName(b.b)}</button> · {(b.utilisation * 100).toFixed(0)}% · dmg {b.damage.toFixed(2)}</li>)}</ul>
        <h3>Events</h3>
        <ul className="garage-debug-events">{data.events.map((e, i) => <li key={i}>step {e.step}: {e.text}</li>)}</ul>
      </>}
    </aside>}
  </div>;
}
