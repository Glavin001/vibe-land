import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SoundPalettePanel } from '../audio/SoundPalettePanel';
import type { PaletteSlot, PaletteChoice } from '../audio/soundPalette';
import { AudioMixControls, MIX_LABELS } from '../audio/AudioSettingsPanel';
import { destructionAudio, installAudioLifecycle, type AudioDiagnostics } from '../audio/engine';
import { MATERIALS, type AcousticMaterial, type SoundEvent, type Vec3 } from '../audio/model';
import { audioSettings, MIXES, sanitizeSettings, setAudioSettings, setMixPreset, useAudioSettings, type AudioSettings, type MixPreset } from '../audio/settings';
import { createMaterialAudition, createReviewScenario, parseReviewSettings, REVIEW_SCENARIOS, ReviewTransport, sampleReviewEmitters, type ReviewScenario, type ReviewScenarioId, type ReviewImpactScale } from '../audio/reviewScenarios';
import './AudioLab.css';

const COLORS: Record<AcousticMaterial, string> = { concrete: '#cbbfa8', stone: '#a8bab4', metal: '#b9d8e3', sheet: '#9cccca', wood: '#d9a879', glass: '#8be1cd', earth: '#b8a072' };
const MATERIAL_NAMES: Record<AcousticMaterial, string> = { concrete: 'Concrete', stone: 'Stone', metal: 'Metal', sheet: 'Sheet metal', wood: 'Wood', glass: 'Glass', earth: 'Earth' };
const SNAPSHOT_KEY = 'vibe.audio.review-slots.v1';
const DEFAULT_LISTENER: Vec3 = [0, 1.7, 0];
type Slot = 'A' | 'B';
interface ReviewSnapshot { settings: AudioSettings; savedAt: string; }
function loadSnapshots(): Record<Slot, ReviewSnapshot> {
  const defaults = { A: { settings: { ...audioSettings() }, savedAt: '' }, B: { settings: { ...audioSettings(), ...MIXES.clarity, preset: 'clarity' as const }, savedAt: '' } };
  try { const saved = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) ?? 'null'); if (!saved) return defaults; return { A: { ...saved.A, settings: sanitizeSettings(saved.A.settings) }, B: { ...saved.B, settings: sanitizeSettings(saved.B.settings) } }; } catch { return defaults; }
}
function downloadBlob(blob: Blob, filename: string) { const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = filename; a.click(); window.setTimeout(() => URL.revokeObjectURL(url), 3000); }
function formatTime(ms: number) { return `${(ms / 1000).toFixed(1)}s`; }
function db(value: number) { return value > .00001 ? `${(20 * Math.log10(value)).toFixed(1)} dBFS` : '— dBFS'; }

interface StageState { scenario: ReviewScenario; elapsed: number; listener: Vec3; yaw: number; pulses: SoundEvent[]; playing: boolean; }
function drawStage(canvas: HTMLCanvasElement, state: StageState) {
  const context = canvas.getContext('2d'); if (!context) return;
  const box = canvas.getBoundingClientRect(), width = box.width, height = box.height, ratio = Math.min(window.devicePixelRatio || 1, 2);
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) { canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio); }
  const ctx = context; ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.clearRect(0, 0, width, height);
  const scale = Math.min(width / 126, height / 86), originX = width * .5, originY = height * .55;
  const project = ([x, y, z]: Vec3): [number, number] => [originX + (x - z) * scale * .71, originY + (x + z) * scale * .34 - y * scale * .85];
  const line = (from: Vec3, to: Vec3, color: string) => { const a = project(from), b = project(to); ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.strokeStyle = color; ctx.stroke(); };
  ctx.lineWidth = 1;
  for (let i = -50; i <= 50; i += 5) { line([i, 0, -50], [i, 0, 50], i % 25 === 0 ? '#303a3166' : '#27312855'); line([-50, 0, i], [50, 0, i], i % 25 === 0 ? '#303a3166' : '#27312855'); }
  const poly = (points: Vec3[], fill: string, stroke = '#6b756244') => { ctx.beginPath(); points.map(project).forEach((p, i) => i ? ctx.lineTo(...p) : ctx.moveTo(...p)); ctx.closePath(); ctx.fillStyle = fill; ctx.fill(); ctx.strokeStyle = stroke; ctx.stroke(); };
  const block = (x: number, z: number, h: number, size: number, collapsed = false) => {
    const y = collapsed ? Math.min(1.3, h) : h, d = size / 2;
    poly([[x - d, 0, z + d], [x + d, 0, z + d], [x + d, y, z + d], [x - d, y, z + d]], '#2d332b');
    poly([[x + d, 0, z - d], [x + d, 0, z + d], [x + d, y, z + d], [x + d, y, z - d]], '#232b25');
    poly([[x - d, y, z - d], [x + d, y, z - d], [x + d, y, z + d], [x - d, y, z + d]], '#3c4435');
  };
  if (state.scenario.id === 'interior') { [[-6, -6], [6, -6], [-6, 6], [6, 6]].forEach(([x, z], i) => block(x, z, 11, 2.6, state.elapsed > 1500 + i * 2350)); }
  if (state.scenario.id === 'hero') { block(16, -18, 14, 10, state.elapsed > 3300); block(25, -25, 9, 8, state.elapsed > 4600); block(-22, -29, 7, 8); }
  if (state.scenario.id === 'stress') { block(-28, -24, 17, 12, state.elapsed > 400); block(28, -24, 17, 12, state.elapsed > 1400); }
  if (state.scenario.id === 'mailbox') { block(2.8, -3.5, 1.5, 1); }
  if (state.scenario.id === 'vehicle') { block(12, -5, 3, 3, state.elapsed > 3300); }
  for (const e of state.scenario.emitters) {
    ctx.setLineDash([3, 5]); line(e.from, e.to, '#a9bc8244'); ctx.setLineDash([]);
  }
  for (const e of state.pulses) {
    const age = state.elapsed - e.atMs; if (age < 0 || age > 1800) continue;
    const fade = Math.max(0, 1 - age / 1800), p = project(e.position), radius = (4 + age / 33) * Math.sqrt(e.intensity) * scale * .22;
    ctx.globalAlpha = fade * .75; ctx.strokeStyle = e.protected ? '#e9f5a6' : COLORS[e.material]; ctx.lineWidth = e.protected ? 2 : 1;
    ctx.beginPath(); ctx.ellipse(p[0], p[1], radius, radius * .52, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(p[0], p[1], e.protected ? 3 : 1.5 + e.intensity * 2, 0, Math.PI * 2); ctx.fillStyle = ctx.strokeStyle; ctx.fill();
  }
  ctx.globalAlpha = 1; ctx.lineWidth = 1;
  for (const e of sampleReviewEmitters(state.scenario, state.elapsed)) {
    const p = project(e.position), ground = project([e.position[0], 0, e.position[2]]);
    ctx.strokeStyle = '#c2d5a04d'; ctx.beginPath(); ctx.moveTo(...p); ctx.lineTo(...ground); ctx.stroke();
    const glow = ctx.createRadialGradient(p[0], p[1], 0, p[0], p[1], 24); glow.addColorStop(0, '#dff4af55'); glow.addColorStop(1, '#dff4af00'); ctx.fillStyle = glow; ctx.fillRect(p[0] - 24, p[1] - 24, 48, 48);
    ctx.fillStyle = '#e9f5b9'; ctx.beginPath(); ctx.arc(...p, 4, 0, Math.PI * 2); ctx.fill();
  }
  const l = state.listener, a = state.yaw * Math.PI / 180, listener = project(l), forward: Vec3 = [l[0] - Math.sin(a) * 8, l[1], l[2] - Math.cos(a) * 8];
  const f = project(forward), direction = Math.atan2(f[1] - listener[1], f[0] - listener[0]);
  ctx.fillStyle = '#a8d9e214'; ctx.beginPath(); ctx.moveTo(...listener); ctx.arc(...listener, 40, direction - .7, direction + .7); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = '#a8d9e2'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(...listener, 7, 0, Math.PI * 2); ctx.stroke(); ctx.fillStyle = '#c9f0f5'; ctx.beginPath(); ctx.arc(...listener, 2, 0, Math.PI * 2); ctx.fill();
  line(l, [l[0] - Math.sin(a) * 3, l[1], l[2] - Math.cos(a) * 3], '#c9f0f5');
  ctx.font = '10px ui-monospace, monospace'; ctx.textAlign = 'center'; ctx.fillStyle = '#9cc6cf'; ctx.fillText('YOU', listener[0], listener[1] + 22);
  ctx.fillStyle = '#75836b'; ctx.fillText('FRONT / −Z', ...project([0, 0, -43])); ctx.fillText('REAR / +Z', ...project([0, 0, 43]));
}

export function AudioLabPage() {
  const engine = useMemo(() => destructionAudio(), []), settings = useAudioSettings();
  useEffect(() => installAudioLifecycle(), []);
  const [scenarioId, setScenarioId] = useState<ReviewScenarioId>('interior'), [seed, setSeed] = useState(2026);
  const scenario = useMemo(() => createReviewScenario(scenarioId, seed), [scenarioId, seed]);
  const meta = REVIEW_SCENARIOS.find(s => s.id === scenarioId)!;
  const [playing, setPlaying] = useState(false), [loading, setLoading] = useState(false), [elapsed, setElapsed] = useState(0), [loop, setLoop] = useState(false);
  const [auditionScale, setAuditionScale] = useState<ReviewImpactScale>('heavy'), [auditionMaterial, setAuditionMaterial] = useState<AcousticMaterial>('concrete');
  const [yaw, setYaw] = useState(0), [listener, setListener] = useState<Vec3>(DEFAULT_LISTENER);
  const [diagnostics, setDiagnostics] = useState<AudioDiagnostics>(() => engine.diagnostics());
  const [snapshots, setSnapshots] = useState(loadSnapshots), [activeSlot, setActiveSlot] = useState<Slot | null>(null);
  const [notice, setNotice] = useState(''), [notes, setNotes] = useState(''), [recording, setRecording] = useState(false), [recorded, setRecorded] = useState<{ url: string; filename: string } | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null), importInput = useRef<HTMLInputElement>(null);
  const run = useRef({ playing: false, elapsed: 0, base: 0, transport: new ReviewTransport(scenario), pulses: [] as SoundEvent[] });
  const generation = useRef(0), loopRef = useRef(loop), listenerRef = useRef({ position: listener, yaw }), recordingRef = useRef(false), recordedRef = useRef<string | null>(null);
  loopRef.current = loop; listenerRef.current = { position: listener, yaw };
  const pause = useCallback(() => { generation.current++; run.current.playing = false; setPlaying(false); setElapsed(run.current.elapsed); setLoading(false); engine.stop(); }, [engine]);
  const seek = useCallback((time: number) => {
    const next = Math.max(0, Math.min(scenario.durationMs, time)); engine.stop(); run.current.elapsed = next; run.current.base = performance.now() - next; run.current.transport.seek(next); run.current.pulses = []; setElapsed(next);
  }, [engine, scenario]);
  const play = useCallback(async (restart = false) => {
    const token = ++generation.current; setLoading(true); setNotice('');
    try {
      if (!audioSettings().enabled) setAudioSettings({ enabled: true });
      await engine.start(); if (generation.current !== token) return;
      engine.stop(); // A source preview must not bleed into a scene comparison.
      if (restart || run.current.elapsed >= scenario.durationMs) seek(0);
      run.current.base = performance.now() - run.current.elapsed; run.current.playing = true; setPlaying(true);
    } catch (error) { setNotice(`Sound could not start: ${error instanceof Error ? error.message : String(error)}`); }
    finally { if (generation.current === token) setLoading(false); }
  }, [engine, scenario.durationMs, seek]);
  useEffect(() => {
    generation.current++; engine.stop(); run.current = { playing: false, elapsed: 0, base: 0, transport: new ReviewTransport(scenario), pulses: [] }; setPlaying(false); setLoading(false); setElapsed(0);
  }, [engine, scenario]);
  useEffect(() => {
    let frame = 0, lastUi = 0;
    const tick = (now: number) => {
      const state = run.current, pose = listenerRef.current, angle = pose.yaw * Math.PI / 180;
      engine.setListener(pose.position, [-Math.sin(angle), 0, -Math.cos(angle)]);
      if (state.playing) {
        state.elapsed = Math.min(scenario.durationMs, now - state.base);
        const events = state.transport.advance(state.elapsed);
        for (const event of events) engine.emit({ ...event, atMs: state.base + event.atMs });
        state.pulses = [...state.pulses.filter(e => state.elapsed - e.atMs < 1800), ...events].slice(-160);
        for (const emitter of sampleReviewEmitters(scenario, state.elapsed)) engine.continuous(emitter, now);
        if (state.elapsed >= scenario.durationMs) {
          if (loopRef.current) { engine.stop(); state.elapsed = 0; state.base = now; state.transport.seek(0); state.pulses = []; }
          else { state.playing = false; setPlaying(false); }
        }
      }
      engine.update(now);
      if (canvas.current) drawStage(canvas.current, { scenario, elapsed: state.elapsed, listener: pose.position, yaw: pose.yaw, pulses: state.pulses, playing: state.playing });
      if (now - lastUi > 100) { lastUi = now; setElapsed(state.elapsed); setDiagnostics(engine.diagnostics()); }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    const onHide = () => { if (document.hidden) { pause(); setNotice('Playback paused while this tab was hidden.'); } };
    document.addEventListener('visibilitychange', onHide);
    return () => { cancelAnimationFrame(frame); document.removeEventListener('visibilitychange', onHide); engine.stop(); };
  }, [engine, scenario, pause]);
  useEffect(() => () => { generation.current++; if (recordingRef.current) void engine.endRecording(); if (recordedRef.current) URL.revokeObjectURL(recordedRef.current); }, [engine]);
  const applyPreset = useCallback((preset: MixPreset) => { setMixPreset(preset); setActiveSlot(null); void play(true); }, [play]);
  const recall = useCallback((slot: Slot) => { setAudioSettings(snapshots[slot].settings); setActiveSlot(slot); setNotice(`Replaying the same scene with mix ${slot}.`); void play(true); }, [snapshots, play]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.altKey || event.metaKey || event.ctrlKey || event.repeat || (event.target instanceof HTMLElement && (['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName) || event.target.isContentEditable))) return;
      // Keep native Space activation on focused controls; letter shortcuts
      // still work after selecting a mix or listener position.
      if (event.code === 'Space' && event.target instanceof HTMLElement && ['BUTTON', 'A', 'SUMMARY'].includes(event.target.tagName)) return;
      if (event.code === 'Space') { event.preventDefault(); run.current.playing ? pause() : void play(); }
      else if (event.key.toLowerCase() === 'r') void play(true);
      else if (event.key.toLowerCase() === 'a') recall('A');
      else if (event.key.toLowerCase() === 'b') recall('B');
      else if (['1', '2', '3'].includes(event.key)) applyPreset((['cinematic', 'natural', 'clarity'] as MixPreset[])[Number(event.key) - 1]);
      else if (event.key === 'Escape') pause();
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [applyPreset, pause, play, recall]);
  function saveSlot(slot: Slot) { const next = { ...snapshots, [slot]: { settings: { ...audioSettings() }, savedAt: new Date().toISOString() } }; setSnapshots(next); setActiveSlot(slot); try { localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(next)); } catch { /* In-memory slots remain available. */ } setNotice(`Current mix saved to ${slot}.`); }
  async function audition(material: AcousticMaterial, scale = auditionScale) {
    pause(); setAuditionMaterial(material); const token = ++generation.current;
    try { if (!audioSettings().enabled) setAudioSettings({ enabled: true }); await engine.start(); if (generation.current !== token) return; const atMs = performance.now(); engine.emit(createMaterialAudition(material, scale, seed, atMs)); setNotice(`${scale === 'heavy' ? 'Heavy' : 'Small'} ${MATERIAL_NAMES[material].toLowerCase()} · same intensity, six meters ahead.`); }
    catch { setNotice('Unable to start the material audition.'); }
  }
  async function auditionPalette(slot: PaletteSlot, choice: PaletteChoice, options: { reflections: boolean }) {
    const token = ++generation.current;
    if (!audioSettings().enabled) setAudioSettings({ enabled: true });
    await engine.start();
    if (token !== generation.current) throw new DOMException('Preview cancelled', 'AbortError');
    await engine.auditionPalette(slot, choice, options);
    if (token !== generation.current) throw new DOMException('Preview cancelled', 'AbortError');
  }
  async function toggleRecording() {
    if (recordingRef.current) {
      const blob = await engine.endRecording(); recordingRef.current = false; setRecording(false);
      if (blob) { if (recordedRef.current) URL.revokeObjectURL(recordedRef.current); const url = URL.createObjectURL(blob); recordedRef.current = url; setRecorded({ url, filename: `vibe-${scenarioId}-${settings.preset}-${seed}.${blob.type.includes('mp4') ? 'm4a' : 'webm'}` }); setNotice('Your stereo review clip is ready below.'); }
    } else {
      try { await engine.start(); if (engine.beginRecording()) { recordingRef.current = true; setRecording(true); void play(true); setNotice('Recording this review to a stereo clip. Stop recording when ready.'); } else setNotice('Recording is unavailable in this browser.'); }
      catch { setNotice('Sound could not start for recording.'); }
    }
  }
  function exportReport() { const report = { type: 'vibe-audio-review', version: 1, createdAt: new Date().toISOString(), scenario: { id: scenarioId, seed, durationMs: scenario.durationMs, eventCount: scenario.events.length }, listener: { position: listener, yaw }, settings: audioSettings(), snapshots, diagnostics: engine.diagnostics(), notes, browser: navigator.userAgent }; downloadBlob(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }), `vibe-sound-review-${scenarioId}-${seed}.json`); setNotice('Review report exported with settings, notes, and diagnostics.'); }
  async function importMix(file: File | undefined) { if (!file) return; try { if (file.size > 256 * 1024) throw new Error('Review files must be smaller than 256 KB.'); const next = parseReviewSettings(await file.text()); setAudioSettings(next); setActiveSlot(null); setNotice('Mix settings imported. Replay to compare.'); } catch (error) { setNotice(error instanceof Error ? error.message : 'The file could not be read.'); } finally { if (importInput.current) importInput.current.value = ''; } }
  const beat = [...scenario.markers].reverse().find(m => m.atMs <= elapsed)?.label ?? 'Ready when you are';
  const percentage = elapsed / scenario.durationMs * 100;
  return <div className="audio-lab">
    <header className="audio-lab-nav"><a href="/" className="audio-lab-brand"><span aria-hidden="true">◒</span> vibe-land <span className="audio-lab-divider">/</span> <strong>Sound studio</strong></a><div><span className="audio-lab-status"><i className={playing ? 'is-playing' : ''} />{loading ? 'Loading palette' : diagnostics.state === 'Ready' ? 'Audio ready' : playing ? 'Playing' : 'Listening lab'}</span><a href="/city" target="_blank" rel="noreferrer">Open the city ↗</a></div></header>
    <main className="audio-lab-main">
      <section className="audio-lab-intro"><div><p className="audio-lab-eyebrow">DESTRUCTION / LISTENING ROOM 01</p><h1>Feel every close call.</h1><p>One scene. Every detail. Find the mix that puts you there.</p></div><div className="audio-lab-session"><span>REPEATABLE PERFORMANCE</span><strong>Seed {seed}</strong><small>Scripted audio · no server required</small></div></section>
      <SoundPalettePanel
        choices={settings.palette}
        onChoose={(slot, choice) => { setAudioSettings({ palette: { ...audioSettings().palette, [slot]: choice } }); setActiveSlot(null); }}
        onAudition={auditionPalette}
        onStop={pause}
        reflections={settings.acoustics === 'reflections'}
        onReflectionsChange={enabled => setAudioSettings({ acoustics: enabled ? 'reflections' : 'dry' })}
        onPlayScene={() => void play(true)}
      />
      <div className="audio-lab-workspace">
        <aside className="audio-lab-scenes" aria-label="Listening scenes"><div className="audio-section-heading">01 <h2>Choose a scene</h2><span>{REVIEW_SCENARIOS.length}</span></div><div className="audio-scene-list">{REVIEW_SCENARIOS.map((s, i) => <button type="button" key={s.id} className={scenarioId === s.id ? 'selected' : ''} aria-pressed={scenarioId === s.id} onClick={() => { pause(); setScenarioId(s.id); }}><span className="audio-scene-number">0{i + 1}</span><span><strong>{s.title}</strong><small>{s.subtitle}</small></span><span className="audio-scene-duration">{Math.round(s.durationMs / 1000)}s</span></button>)}</div><div className="audio-scene-note"><span>LISTEN FOR</span><p>{meta.listenFor}</p></div><label className="audio-seed">Variation seed<input type="number" aria-label="Variation seed" value={seed} min="1" max="2147483647" onChange={e => { const next = Number(e.target.value); if (Number.isInteger(next) && next > 0 && next <= 2147483647) { pause(); setSeed(next); } }} /></label></aside>
        <section className="audio-lab-player" aria-label="Scene player">
          <div className="audio-stage-header"><div><p className="audio-lab-eyebrow">{scenarioId === 'stress' ? 'SYNTHETIC LOAD TEST' : 'SCRIPTED SPATIAL SCENE'}</p><h2>{meta.title}</h2></div><div className="audio-stage-actions"><span>{scenario.events.length.toLocaleString()} events</span><button type="button" className="audio-stage-listen" aria-label={playing ? 'Pause selected scene' : 'Play selected scene'} disabled={loading} onClick={() => playing ? pause() : void play()}>{loading ? 'Loading…' : playing ? 'Pause' : 'Listen ▶'}</button></div></div>
          <div className="audio-stage"><canvas ref={canvas} role="img" aria-label="Isometric sound map. Moving lights show emitters, expanding rings show impacts, and the blue listener shows your position and facing direction." /><div className="audio-stage-legend"><span><i className="listener" /> Listener</span><span><i className="source" /> Sound source</span><span>Grid · 5 m</span></div><div className="audio-stage-beat">{playing && <span className="audio-beat-dot" />} {beat}</div></div>
          <div className="audio-transport"><div className="audio-timeline-label"><span>{formatTime(elapsed)}</span><span>{formatTime(scenario.durationMs)}</span></div><input className="audio-timeline" aria-label="Scene position" type="range" min="0" max={scenario.durationMs} step="10" value={elapsed} style={{ '--progress': `${percentage}%` } as React.CSSProperties} onChange={e => seek(Number(e.target.value))} /><div className="audio-cue-list">{scenario.markers.map(m => <button type="button" key={m.atMs} onClick={() => seek(Math.max(0, m.atMs - 100))} title={`Jump to ${m.label}`}><span>{(m.atMs / 1000).toFixed(1)}</span>{m.label}</button>)}</div><div className="audio-transport-buttons"><button type="button" className="audio-play" disabled={loading} onClick={() => playing ? pause() : void play()}><span aria-hidden="true">{playing ? 'Ⅱ' : '▶'}</span>{loading ? 'Loading…' : playing ? 'Pause' : elapsed > 0 && elapsed < scenario.durationMs ? 'Resume scene' : 'Play scene'}</button><button type="button" className="audio-icon-button" aria-label="Restart scene" title="Restart (R)" disabled={loading} onClick={() => void play(true)}>↺</button><label className="audio-loop"><input type="checkbox" checked={loop} onChange={e => setLoop(e.target.checked)} />Loop</label><button type="button" className={`audio-record ${recording ? 'recording' : ''}`} onClick={() => void toggleRecording()}><span aria-hidden="true">●</span>{recording ? 'Stop recording' : 'Record clip'}</button></div></div>
          <div className="audio-listener-controls"><label>Turn your head <span>{yaw}°</span><input aria-label="Listener heading" type="range" min="-180" max="180" step="1" value={yaw} onChange={e => setYaw(Number(e.target.value))} /></label><div className="audio-viewpoints" aria-label="Listener position">{[{ name: 'Close', position: DEFAULT_LISTENER }, { name: 'Street', position: [-12, 1.7, 14] as Vec3 }, { name: 'Distant', position: [0, 1.7, 65] as Vec3 }, { name: 'Above', position: [0, 18, 0] as Vec3 }].map(v => <button type="button" key={v.name} aria-pressed={listener.every((n, i) => n === v.position[i])} onClick={() => setListener(v.position)}>{v.name}</button>)}</div></div>
          <div className="audio-material-audition"><div className="audio-audition-heading"><span>QUICK AUDITION</span><div aria-label="Audition object scale">{(['small', 'heavy'] as ReviewImpactScale[]).map(scale => <button type="button" key={scale} aria-pressed={auditionScale === scale} onClick={() => { setAuditionScale(scale); void audition(auditionMaterial, scale); }}>{scale === 'small' ? 'Small object' : 'Heavy object'}</button>)}</div></div><div>{MATERIALS.map(m => <button type="button" key={m} onClick={() => void audition(m)}><i style={{ background: COLORS[m] }} />{MATERIAL_NAMES[m]}</button>)}</div><p className="audio-audition-caption">Same position and intensity. Compare the object’s scale.</p></div>
        </section>
        <aside className="audio-lab-mix" aria-label="Mix controls"><div className="audio-section-heading">02 <h2>Find the feeling</h2></div><AudioMixControls onPreset={applyPreset} /><div className="audio-ab"><div className="audio-ab-heading"><h3>Compare your mixes</h3><span>Same scene, same seed</span></div>{(['A', 'B'] as Slot[]).map(slot => <div className="audio-ab-row" key={slot}><button type="button" aria-pressed={activeSlot === slot} onClick={() => recall(slot)}><b>{slot}</b><span>{MIX_LABELS[snapshots[slot].settings.preset].name}<small>{snapshots[slot].savedAt ? 'Saved mix' : 'Starting mix'}</small></span><span aria-hidden="true">▶</span></button><button type="button" className="audio-save-slot" aria-label={`Save current mix to ${slot}`} onClick={() => saveSlot(slot)}>Save</button></div>)}<p>Save a mix, tweak it, save the other. A or B replays from the beginning.</p></div></aside>
      </div>
      <section className="audio-lab-meters" aria-label="Live audio diagnostics"><div><span>ACTIVE VOICES</span><strong>{diagnostics.voices}<small> / {settings.maxVoices}</small></strong><meter min="0" max={settings.maxVoices} value={diagnostics.voices} aria-label="Active playback voices" /></div><div><span>DEBRIS BEDS</span><strong>{diagnostics.activityEmitters}</strong><small>From surrounding contact activity</small></div><div><span>SPATIAL VOICES</span><strong>{diagnostics.spatialVoices}<small> HRTF</small></strong></div><div><span>GROUPED / RECEIVED</span><strong>{diagnostics.grouped.toLocaleString()}<small> / {diagnostics.received.toLocaleString()}</small></strong></div><div><span>OUTPUT PEAK</span><strong>{db(diagnostics.peak)}</strong><small>{diagnostics.limiter}</small></div><div><span>SUSTAINED LEVEL</span><strong>{db(diagnostics.rms)}</strong><small>Output RMS · current window</small></div><div><span>AUDIO UPDATE</span><strong>{diagnostics.updateMs.toFixed(2)}<small> ms</small></strong><small>Not total audio-thread CPU</small></div><div><span>SOUND PALETTE</span><strong>{diagnostics.loaded}<small> / {diagnostics.total || '—'} clips</small></strong><small>{diagnostics.failures.length ? `${diagnostics.failures.length} unavailable` : diagnostics.sampleRate ? `${(diagnostics.sampleRate / 1000).toFixed(1)} kHz · ${Math.round(diagnostics.latencyMs)} ms estimated latency` : 'Loads on first play'}</small></div></section>
      <div className="audio-lab-notice" role="status" aria-live="polite">{notice || (diagnostics.failures.length ? 'Some sound assets are unavailable. Check the report for details.' : 'Start a scene to enable audio. Settings save automatically and also apply in the game.')}</div>
      {recorded && <section className="audio-recorded"><div><span className="audio-lab-eyebrow">LATEST REVIEW CLIP</span><p>Stereo capture · {recorded.filename}</p></div><audio controls src={recorded.url} /><a href={recorded.url} download={recorded.filename}>Download clip ↓</a></section>}
      <section className="audio-review-footer"><div><span className="audio-lab-eyebrow">03 / SAVE THE REVIEW</span><h2>Leave a useful trail.</h2><p>Capture what you heard. The report includes the exact mix, seed, listener position, both comparison slots, and audio diagnostics.</p><div className="audio-shortcuts"><kbd>Space</kbd> play / pause <kbd>R</kbd> restart <kbd>1–3</kbd> presets <kbd>A / B</kbd> compare</div></div><div className="audio-review-notes"><label htmlFor="audio-review-notes">Listening notes</label><textarea id="audio-review-notes" placeholder="For example: Clarity keeps the near miss distinct. Try less bass on the collapse…" value={notes} onChange={e => setNotes(e.target.value)} /><div><button type="button" onClick={exportReport}>Export review ↓</button><button type="button" onClick={() => importInput.current?.click()}>Import mix ↑</button><input ref={importInput} type="file" accept="application/json,.json" hidden aria-label="Import mix file" onChange={e => void importMix(e.target.files?.[0])} /></div></div></section>
      <footer className="audio-lab-bottom"><span>Physics-informed sound. Authored listening fixtures.</span><span>Headphones recommended for spatial review · verify surround on your speakers</span><a href="/audio/destruction/SOURCES.md" target="_blank" rel="noreferrer">Sound sources ↗</a></footer>
    </main>
  </div>;
}
