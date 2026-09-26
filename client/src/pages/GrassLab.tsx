import { useEffect, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { Group, Mesh, Plane, Raycaster, Vector2, Vector3 } from 'three';
import { CityEnvironment } from '../scene/CityEnvironment';
import { WorldTerrain } from '../scene/WorldTerrain';
import { CITY_WORLD_DOCUMENT } from '../world/cityWorld';
import { grassVehicleCanopyContact } from '../scene/grass/GrassBodyContacts';
import { GrassField, type GrassStats } from '../scene/grass/GrassField';
import { grassExclusionsFromManifest, type GrassQuality } from '../scene/grass/grassPlacement';
import type { CityManifest } from '../city/manifest';
import './GrassLab.css';
import { resolveMultiplayerBackend } from '../app/runtimeConfig';
import { resolveRequestedMatchId } from '../app/matchId';
import { fetchSharedGrass, grassLayoutUrl, publishSharedGrass } from '../scene/grass/GrassLayoutSync';
import { cityGrassPaint, GRASS_BRUSHES, GRASS_MAX_HEIGHT, saveCityGrassPaint, type GrassBrush, type GrassPaintDocument } from '../scene/grass/GrassPaint';

// Optional world coordinates let the lab author a patch beside a city player.
// Opening a link only moves the preview; planting remains an explicit action.
const previewQuery = new URLSearchParams(window.location.search);
const previewCoordinate = (key: string, fallback: number) => {
  const raw = previewQuery.get(key), value = raw === null ? fallback : Number(raw);
  return Number.isFinite(value) ? Math.max(-232, Math.min(232, value)) : fallback;
};
const SHARED_MATCH = resolveRequestedMatchId(window.location.search, 'city-default');
const SHARED_URL = grassLayoutUrl(resolveMultiplayerBackend().httpOrigin, SHARED_MATCH);
const PREVIEW_X = previewCoordinate('x', 0), PREVIEW_Z = previewCoordinate('z', 2);
const PREVIEW_OFFSET = new Vector3(PREVIEW_X, 0, PREVIEW_Z-2);

// A reproducible city-edge view, using the production field and ground, with no server.
const BUILDINGS = [
  { x: -12, z: -18, w: 9, d: 8, h: 22 },
  { x: 3, z: -27, w: 10, d: 10, h: 32 },
  { x: 20, z: -21, w: 8, d: 9, h: 18 },
  { x: -28, z: -31, w: 12, d: 10, h: 28 },
  { x: 22, z: -44, w: 10, d: 10, h: 40 },
];
const MANIFEST: CityManifest = { version: 1, structures: BUILDINGS.map((b, i) => ({
  structureId: i, worldPosition: [b.x, b.h / 2, b.z], worldRotation: [0, 0, 0, 1],
  chunks: [{ nodeIndex: 0, centroid: [0, 0, 0], mass: 1, volume: b.w * b.d * b.h,
    size: [b.w, b.h, b.d], radius: b.h, support: true,
    geometry: { kind: 'cuboid', halfExtents: [b.w / 2, b.h / 2, b.d / 2] } }],
})) };
const EXCLUSIONS = grassExclusionsFromManifest(MANIFEST);

function PreviewField({ quality, wind, enabled, paused, driving, rubble, clearTracks, onStats }: {
  quality: GrassQuality; wind: number; enabled: boolean; paused: boolean;
  driving: boolean; rubble: number; clearTracks: number;
  onStats: (stats: GrassStats & { frameMs: number; pressedArea: number }) => void;
}) {
  const scene = useThree(s => s.scene);
  const field = useRef<GrassField | null>(null);
  const clock = useRef({ report: 0, frameMs: 16.7 });
  const car = useRef<Group>(null);
  const stone = useRef<Mesh>(null);
  const demo = useRef({ started: 0, drop: 0, previousX: NaN });
  useEffect(() => { demo.current.started = performance.now()/1000; demo.current.previousX = NaN; }, [driving]);
  useEffect(() => { demo.current.drop = performance.now()/1000; }, [rubble]);
  useEffect(() => { field.current?.interaction.clear(); }, [clearTracks]);
  useEffect(() => {
    const next = new GrassField(quality, EXCLUSIONS);
    field.current = next;
    scene.add(next.group);
    return () => { scene.remove(next.group); next.dispose(); field.current = null; };
  }, [quality, scene]);
  useFrame(({ camera }, delta) => {
    const grass = field.current;
    if (!grass) return;
    grass.group.visible = enabled;
    grass.setWind(wind, 65);
    const time = performance.now()/1000;
    const carX = PREVIEW_X+((time-demo.current.started)*4)%26-13;
    const stoneY = 0.3+Math.max(0, 6-4.9*(time-demo.current.drop)**2);
    if (car.current) { car.current.visible = driving; car.current.position.set(carX, 0.65, PREVIEW_Z); }
    if (stone.current) { stone.current.visible = rubble > 0; stone.current.position.set(PREVIEW_X, stoneY, PREVIEW_Z-2); }
    if (grass.interaction.begin(time, camera.position.x, camera.position.z)) {
      if (driving) for (const side of [-1,1]) for (const axle of [-1.1,1.1]) {
        grass.interaction.stamp({ x:carX+axle, z:PREVIEW_Z+side*0.9, radiusX:0.5, radiusZ:0.35,
          fromX:Number.isFinite(demo.current.previousX) ? demo.current.previousX+axle : undefined,
          fromZ:PREVIEW_Z+side*0.9, pressure:1, hold:1.6, damage:0.8 });
      }
      if (driving) {
        const canopy = grassVehicleCanopyContact(cityGrassPaint, carX, PREVIEW_Z, 0.9, 1.8, Math.PI/2);
        if (canopy) grass.interaction.stamp({ ...canopy,
          fromX: Number.isFinite(demo.current.previousX) ? demo.current.previousX : undefined, fromZ: PREVIEW_Z });
      }
      demo.current.previousX = carX;
      if (rubble > 0 && stoneY < 1) grass.interaction.stamp({ x:PREVIEW_X, z:PREVIEW_Z-2, radiusX:2.15, radiusZ:1.6, shape:'box', pressure:Math.min(1, 1.3-stoneY), hold:0.2 });
      grass.interaction.commit();
    }
    // Still air stops only the wind; patch streaming continues while exploring.
    grass.update(camera, performance.now() / 1000);
    if (paused) grass.shading.uniforms.grassWind.value.set(0, 0);
    clock.current.frameMs += (delta * 1000 - clock.current.frameMs) * 0.03;
    clock.current.report += delta;
    if (clock.current.report > 0.5) {
      clock.current.report = 0;
      onStats({ ...grass.stats, frameMs: clock.current.frameMs, pressedArea: grass.interaction.activeCells * grass.interaction.texel ** 2 });
    }
  });
  return <>
    <group ref={car} rotation={[0, Math.PI/2, 0]} visible={false}>
      <mesh castShadow><boxGeometry args={[1.8,0.45,3.6]} /><meshStandardMaterial color="#42645c" roughness={0.48} /></mesh>
      <mesh position={[0,0.43,-0.15]} castShadow><boxGeometry args={[1.45,0.55,1.65]} /><meshStandardMaterial color="#263e42" roughness={0.3} metalness={0.3} /></mesh>
      {[-0.9,0.9].flatMap(x => [-1.1,1.1].map(z => <mesh key={`${x},${z}`} position={[x,-0.3,z]} rotation={[0,0,Math.PI/2]} castShadow>
        <cylinderGeometry args={[0.35,0.35,0.28,16]} /><meshStandardMaterial color="#242725" roughness={1} />
      </mesh>))}
    </group>
    <mesh ref={stone} visible={false} castShadow receiveShadow><boxGeometry args={[3,0.6,1.9]} /><meshStandardMaterial color="#8c887b" roughness={0.95} /></mesh>
  </>;
}

function ViewControls({ view, painting }: { view: number; painting: boolean }) {
  const camera = useThree(s => s.camera);
  const controls = useRef<OrbitControlsImpl>(null);
  useEffect(() => {
    const positions = [[6, 1.4, 8], [13, 5, 15], [37, 27, 42], [10, 12, 15]];
    const targets = [[0, 0.45, -3], [0, 1, -7], [0, 0, -7], [0, 0, 2]];
    camera.position.fromArray(positions[view]).add(PREVIEW_OFFSET);
    controls.current?.target.fromArray(targets[view]).add(PREVIEW_OFFSET);
    controls.current?.update();
  }, [camera, view]);
  return <OrbitControls ref={controls} enabled={!painting} maxPolarAngle={Math.PI * 0.495} minDistance={0.5} maxDistance={130} />;
}

function PaintBrush({ enabled, brush, radius, onBegin, onSaved }: {
  enabled:boolean; brush:GrassBrush; radius:number; onBegin:()=>void; onSaved:(ok:boolean)=>void;
}) {
  const { gl, camera } = useThree();
  const marker = useRef<Mesh>(null);
  useEffect(() => {
    if (marker.current) marker.current.visible = false;
    const canvas = gl.domElement;
    const ray = new Raycaster(), pointer = new Vector2(), hit = new Vector3();
    const plane = new Plane(new Vector3(0,1,0), 0);
    let down = false, previous:Vector3|null = null;
    const locate = (event:PointerEvent) => {
      const bounds = canvas.getBoundingClientRect();
      pointer.set((event.clientX-bounds.left)/bounds.width*2-1, 1-(event.clientY-bounds.top)/bounds.height*2);
      ray.setFromCamera(pointer,camera);
      return ray.ray.intersectPlane(plane,hit);
    };
    const move = (event:PointerEvent) => {
      if (!enabled || !locate(event)) return;
      if (marker.current) { marker.current.visible = true; marker.current.position.set(hit.x,0.015,hit.z); }
      if (!down) return;
      if (previous && previous.distanceTo(hit) < radius*0.15) return;
      const steps = previous ? Math.min(20, Math.max(1, Math.ceil(previous.distanceTo(hit)/(radius*0.35)))) : 1;
      for (let i=1; i<=steps; i++) {
        const t=i/steps;
        cityGrassPaint.paint(previous ? previous.x+(hit.x-previous.x)*t : hit.x,
          previous ? previous.z+(hit.z-previous.z)*t : hit.z, radius, brush);
      }
      if (previous) previous.copy(hit); else previous=hit.clone();
    };
    const start = (event:PointerEvent) => {
      if (!enabled || event.button !== 0 || !locate(event)) return;
      onBegin(); down=true; previous=null; canvas.setPointerCapture(event.pointerId); move(event);
    };
    const end = () => { if (down) onSaved(saveCityGrassPaint()); down=false; previous=null; };
    canvas.addEventListener('pointerdown',start); canvas.addEventListener('pointermove',move);
    canvas.addEventListener('pointerup',end); canvas.addEventListener('pointercancel',end);
    return () => { end(); canvas.removeEventListener('pointerdown',start); canvas.removeEventListener('pointermove',move); canvas.removeEventListener('pointerup',end); canvas.removeEventListener('pointercancel',end); };
  }, [enabled, brush, radius, gl, camera, onBegin, onSaved]);
  return <mesh ref={marker} visible={false} rotation={[-Math.PI/2,0,0]} raycast={()=>{}}>
    <ringGeometry args={[radius*0.97,radius,64]} /><meshBasicMaterial color="#e6f5b0" depthWrite={false} />
  </mesh>;
}

export function GrassLabPage() {
  const [quality, setQuality] = useState<GrassQuality>('pretty');
  const [wind, setWind] = useState(5);
  const [enabled, setEnabled] = useState(true);
  const [paused, setPaused] = useState(false);
  const [mobileControls, setMobileControls] = useState(false);
  const [view, setView] = useState(0);
  const [driving,setDriving] = useState(false), [rubble,setRubble] = useState(0), [clearTracks,setClearTracks] = useState(0);
  const [painting,setPainting] = useState(false), [brush,setBrush] = useState<GrassBrush>(GRASS_BRUSHES.meadow);
  const [radius,setRadius] = useState(3), [paintStatus,setPaintStatus] = useState('Private draft — publish to share with city players');
  const undo = useRef<GrassPaintDocument[]>([]);
  const importInput = useRef<HTMLInputElement>(null);
  // Stable callbacks keep pointer capture intact while the metrics update.
  const beginPaint = useRef(() => { undo.current.push(cityGrassPaint.export()); if (undo.current.length>8) undo.current.shift(); }).current;
  const savedPaint = useRef((ok:boolean) => setPaintStatus(ok ? 'Draft saved locally — publish to share with city players' : 'Storage full — export to keep this layout')).current;
  const [sharedRevision, setSharedRevision] = useState<string | null>(null);
  const [editorKey, setEditorKey] = useState('');
  const [sharing, setSharing] = useState(false);
  const [sharedStatus, setSharedStatus] = useState('Checking shared city grass…');
  useEffect(() => {
    const abort = new AbortController();
    void fetchSharedGrass(SHARED_URL, null, abort.signal).then(snapshot => {
      if (!snapshot || abort.signal.aborted) return;
      setSharedRevision(snapshot.revision);
      setSharedStatus(`Shared layout ${snapshot.revision.slice(0,8)} · draft not published`);
    }).catch(() => { if (!abort.signal.aborted) setSharedStatus('Shared grass server unavailable. Your draft is safe locally.'); });
    return () => abort.abort();
  }, []);
  const loadShared = async () => {
    setSharing(true);
    try {
      const snapshot = await fetchSharedGrass(SHARED_URL, null, AbortSignal.timeout(10_000));
      if (!snapshot) return;
      beginPaint(); cityGrassPaint.import(snapshot.layout); savedPaint(saveCityGrassPaint());
      setSharedRevision(snapshot.revision); setSharedStatus(`Loaded shared layout ${snapshot.revision.slice(0,8)}`);
    } catch (error) { setSharedStatus(error instanceof Error ? error.message : 'Could not load shared grass'); }
    finally { setSharing(false); }
  };
  const publish = async () => {
    if (!sharedRevision) return;
    setSharing(true);
    try {
      const snapshot = await publishSharedGrass(SHARED_URL, sharedRevision, cityGrassPaint.export(), editorKey);
      setSharedRevision(snapshot.revision); setSharedStatus(`Published ${snapshot.revision.slice(0,8)} — city players update automatically`);
    } catch (error) { setSharedStatus(error instanceof Error ? error.message : 'Could not publish grass'); }
    finally { setSharing(false); }
  };
  const [stats, setStats] = useState<(GrassStats & { frameMs: number; pressedArea: number }) | null>(null);
  return <main className="grass-lab">
    <Canvas shadows dpr={[1, 1.5]} camera={{ fov: 55, near: 0.06, far: 450, position: [6, 1.4, 8] }}
      gl={{ antialias: true, powerPreference: 'high-performance' }}>
      <CityEnvironment fogDensity={0.004} windStrengthMps={wind} />
      <WorldTerrain world={CITY_WORLD_DOCUMENT} grassCover />
      {BUILDINGS.map((b, i) => <group key={i} position={[b.x, 0, b.z]}>
        <mesh position={[0, b.h / 2, 0]} castShadow receiveShadow>
          <boxGeometry args={[b.w, b.h, b.d]} />
          <meshStandardMaterial color={i % 2 ? '#99978b' : '#b4b3a6'} roughness={0.94} />
        </mesh>
        {Array.from({ length: Math.floor(b.h / 3) }, (_, floor) => <mesh key={floor}
          position={[0, 1.6 + floor * 3, b.d / 2 + 0.015]}>
          <boxGeometry args={[b.w - 1.2, 1.1, 0.035]} />
          <meshStandardMaterial color="#414e50" roughness={0.36} metalness={0.3} />
        </mesh>)}
      </group>)}
      <PreviewField quality={quality} wind={wind} enabled={enabled} paused={paused} driving={driving} rubble={rubble} clearTracks={clearTracks} onStats={setStats} />
      <ViewControls view={view} painting={painting} />
      <PaintBrush enabled={painting} brush={brush} radius={radius} onBegin={beginPaint} onSaved={savedPaint} />
    </Canvas>
    <header className="grass-lab-title"><a href="/">VIBE LAND <span>/ FIELD STUDY 01</span></a>
      <h1>A little more alive.</h1><p>City grass · wind through every blade</p>
    </header>
    <button className="grass-lab-controls-toggle" aria-expanded={mobileControls} aria-controls="grass-controls"
      onClick={()=>setMobileControls(v=>!v)}>{mobileControls?'Close controls':'Grass controls'}</button>
    <aside id="grass-controls" className="grass-lab-panel" data-mobile-open={mobileControls}>
      <div className="grass-lab-label">GROUND COVER</div>
      <div className="grass-lab-buttons" aria-label="Grass quality">
        {(['pretty', 'fast'] as const).map(tier => <button key={tier} aria-pressed={quality === tier}
          onClick={() => setQuality(tier)}>{tier === 'pretty' ? 'Full detail' : 'Performance'}</button>)}
      </div>
      <label className="grass-lab-wind">Breeze <span>{wind} m/s</span>
        <input aria-label="Wind speed" type="range" min="0" max="16" step="1" value={wind}
          onChange={e => setWind(Number(e.target.value))} />
      </label>
      <div className="grass-lab-buttons">
        <button aria-pressed={enabled} onClick={() => setEnabled(v => !v)}>{enabled ? 'Grass on' : 'Grass off'}</button>
        <button aria-pressed={paused} onClick={() => setPaused(v => !v)}>{paused ? 'Resume breeze' : 'Still air'}</button>
      </div>
      <div className="grass-lab-metrics" aria-live="off">
        <div><strong>{enabled && stats ? (stats.blades / 1000).toFixed(0) + 'k' : '0'}</strong><span>blades submitted</span></div>
        <div><strong>{enabled ? stats?.visiblePatches ?? '—' : 0}</strong><span>grass draw calls</span></div>
        <div><strong>{stats?.frameMs.toFixed(1) ?? '—'}<small> ms</small></strong><span>frame interval</span></div>
        <div><strong data-testid="grass-pressed-area">{stats?.pressedArea.toFixed(1) ?? '0'}<small> m²</small></strong><span>pressed grass</span></div>
      </div>
      <div className="grass-lab-label grass-lab-section">INTERACTION</div>
      <div className="grass-lab-buttons">
        <button aria-pressed={driving} onClick={()=>setDriving(v=>!v)}>{driving?'Stop car':'Drive through'}</button>
        <button onClick={()=>setRubble(v=>v+1)}>Drop rubble</button>
      </div>
      <div className="grass-lab-buttons" style={{marginTop:7}}>
        <button onClick={()=>{setRubble(0);setClearTracks(v=>v+1);}}>Clear tracks & rubble</button>
      </div>
      <div className="grass-lab-label grass-lab-section">PAINT THE GROUND</div>
      <p className="grass-lab-note">Test patch centre: X {PREVIEW_X}, Z {PREVIEW_Z} m</p>
      <button onClick={()=>{beginPaint();cityGrassPaint.paint(PREVIEW_X,PREVIEW_Z,18,GRASS_BRUSHES.vehicle);savedPaint(saveCityGrassPaint());setView(3);}}>Plant tall test patch</button>
      <button aria-pressed={painting} onClick={()=>{setPainting(v=>!v); if(!painting)setView(1);}}>{painting?'Finish painting':'Paint grass'}</button>
      {painting && <div className="grass-lab-paint">
        <div className="grass-lab-palette">{Object.entries(GRASS_BRUSHES).map(([name,value])=><button key={name} onClick={()=>setBrush({...value})}>{name === 'person' ? 'Person height' : name === 'vehicle' ? 'Vehicle height' : name}</button>)}</div>
        <label>Density <span>{Math.round(brush.density*100)}%</span><input aria-label="Grass density" type="range" min="0" max="1" step="0.05" value={brush.density} onChange={e=>setBrush({...brush,density:Number(e.target.value)})} /></label>
        <label>Height <span>{brush.height.toFixed(2)} m</span><input aria-label="Grass height" type="range" min="0.1" max={GRASS_MAX_HEIGHT} step="0.05" value={brush.height} onChange={e=>setBrush({...brush,height:Number(e.target.value)})} /></label>
        <label>Brush radius <span>{radius} m</span><input aria-label="Brush radius" type="range" min="1" max="12" step="0.5" value={radius} onChange={e=>setRadius(Number(e.target.value))} /></label>
        <label>Leaf color <input aria-label="Leaf color" type="color" value={brush.color} onChange={e=>setBrush({...brush,color:e.target.value})} /></label>
        <div className="grass-lab-buttons"><button onClick={()=>{const last=undo.current.pop();if(last){cityGrassPaint.import(last);savedPaint(saveCityGrassPaint());}}}>Undo</button><button onClick={()=>{beginPaint();cityGrassPaint.clear();savedPaint(saveCityGrassPaint());}}>Reset paint</button></div>
        <div className="grass-lab-buttons" style={{marginTop:7}}><button onClick={()=>{
          const url=URL.createObjectURL(new Blob([JSON.stringify(cityGrassPaint.export())],{type:'application/json'}));
          const link=document.createElement('a');link.href=url;link.download='city-grass.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
        }}>Export layout</button><button onClick={()=>importInput.current?.click()}>Import layout</button></div>
        <input ref={importInput} type="file" accept="application/json,.json" hidden onChange={async e=>{
          const file=e.target.files?.[0];if(!file)return;
          try { if(file.size>24*1024*1024)throw Error('Layout is too large');const value=JSON.parse(await file.text());beginPaint();cityGrassPaint.import(value);savedPaint(saveCityGrassPaint()); }
          catch(error){setPaintStatus(error instanceof Error?error.message:'Invalid layout');} e.target.value='';
        }} />
        <p role="status">{paintStatus}</p>
      </div>}
      <div className="grass-lab-label grass-lab-section">SHARED CITY LAYOUT</div>
      <p className="grass-lab-note">City: {SHARED_MATCH}. Painting edits your draft; publishing updates every player on this server.</p>
      <label className="grass-lab-key">Editor key<input aria-label="Grass editor key" type="password" autoComplete="off"
        value={editorKey} onChange={event=>setEditorKey(event.target.value)} /></label>
      <div className="grass-lab-buttons">
        <button disabled={sharing} onClick={()=>void loadShared()}>Load shared</button>
        <button disabled={sharing || !sharedRevision || !editorKey} onClick={()=>void publish()}>Publish to city</button>
      </div>
      <p role="status" className="grass-lab-note">{sharedStatus}</p>
      <p className="grass-lab-note">Drag to look around · scroll to explore</p>
    </aside>
    <nav className="grass-lab-views" aria-label="Camera view">{['Among the blades', 'City edge', 'Above the field', 'Canopy tracks'].map((label, i) =>
      <button key={label} aria-pressed={view === i} onClick={() => setView(i)}>{label}</button>)}</nav>
  </main>;
}
