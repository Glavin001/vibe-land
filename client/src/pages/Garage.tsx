import { App } from '../App';
import { parseWorldDocument, type WorldDocument } from '../world/worldDocument';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { Grid, OrbitControls } from '@react-three/drei';
import { VehicleVisual } from '../vehicles/VehicleVisual';
import { defaultConfiguration, normalizeConfiguration, serializeConfiguration, vehicleFields, vehicles, type VehicleConfiguration } from '../vehicles/configuration.mjs';
import { resolveMultiplayerBackend } from '../app/runtimeConfig';
import { useVehicleValidation } from '../vehicles/useVehicleValidation';
import './Garage.css';

const STORAGE_KEY = 'vibe-land/garage/configuration-v1';
function initialConfiguration(): VehicleConfiguration {
  try { const saved=localStorage.getItem(STORAGE_KEY);if(saved)return normalizeConfiguration(JSON.parse(saved)); } catch { /* A stale configuration must not prevent opening the workshop. */ }
  return defaultConfiguration();
}
function Model({ configuration, explosion, wireframe, onParts }: {configuration: VehicleConfiguration; explosion: number; wireframe: boolean; onParts: (n:number)=>void}) {
  const [visual] = useState(()=>new VehicleVisual(configuration));
  useLayoutEffect(()=>{visual.configure(configuration);visual.inspect(explosion,wireframe);onParts(visual.partCount);},[visual,configuration,explosion,wireframe,onParts]);
  useEffect(()=>()=>visual.dispose(),[visual]);
  return <primitive object={visual.group} dispose={null}/>;
}
interface Prepared { configuration: VehicleConfiguration; assetHash: string; geometryHash: string; partCount: number; shapeCount: number; bondCount: number }

export function GaragePage() {
  const [configuration,setConfiguration]=useState(initialConfiguration);
  const [drive,setDrive]=useState<{matchId:string;world:WorldDocument}|null>(null);
  const [explosion,setExplosion]=useState(0),[wireframe,setWireframe]=useState(false),[parts,setParts]=useState(0);
  const [pending,setPending]=useState(false),[error,setError]=useState(''),[prepared,setPrepared]=useState<Prepared|null>(null);
  const [cityVehicle,setCityVehicle]=useState<{matchId:string;vehicleId:number;position:number[]}|null>(null);
  const request=useRef<AbortController|null>(null),revision=useRef(0),importInput=useRef<HTMLInputElement>(null);
  const preset=vehicles.find(v=>v.id===configuration.model)!;
  const validation=useVehicleValidation(configuration);
  useEffect(()=>{try {localStorage.setItem(STORAGE_KEY,serializeConfiguration(configuration));}catch{/* Storage may be unavailable. */}},[configuration]);
  useEffect(()=>()=>request.current?.abort(),[]);
  useEffect(()=>{
    if(!drive)return;
    return ()=>{void fetch(`${resolveMultiplayerBackend().httpOrigin}/vehicle-assets/session/${encodeURIComponent(drive.matchId)}`,{method:'DELETE',keepalive:true}).catch(()=>{});};
  },[drive]);
  function configure(value: VehicleConfiguration) {
    try {
      const next=normalizeConfiguration(value);revision.current++;request.current?.abort();
      setPending(false);setPrepared(null);setCityVehicle(null);setError('');setConfiguration(next);
    } catch(e){setError(String(e instanceof Error?e.message:e));}
  }
  async function prepare(destination: 'prepare' | 'session' | 'city' = 'prepare') {
    if(!validation.complete||validation.issue)return;
    request.current?.abort();const controller=new AbortController();request.current=controller;
    const current=revision.current;setPending(true);setError('');
    try {
      const origin=resolveMultiplayerBackend().httpOrigin;
      const response=await fetch(`${origin}/vehicle-assets/${destination}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({configuration}),signal:controller.signal});
      if(!response.ok)throw new Error(await response.text());
      const payload=await response.json();
      const result:Prepared=destination==='prepare'?payload:payload.vehicle;
      if(controller.signal.aborted||revision.current!==current)return;
      if(serializeConfiguration(result.configuration)!==serializeConfiguration(configuration))throw new Error('The server prepared a different configuration. Please try again.');
      setPrepared(result);
      if(destination==='session')setDrive({matchId:payload.matchId,world:parseWorldDocument(payload.worldDocument)});
      if(destination==='city')setCityVehicle({matchId:payload.matchId,vehicleId:payload.vehicleId,position:payload.position});
    } catch(e){if(!controller.signal.aborted)setError(e instanceof Error?e.message:String(e));}
    finally{if(revision.current===current&&!controller.signal.aborted)setPending(false);}
  }
  function download() {
    const url=URL.createObjectURL(new Blob([serializeConfiguration(configuration)+'\n'],{type:'application/json'}));
    const link=document.createElement('a');link.href=url;link.download=`${configuration.model}.vehicle.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  async function importFile(file?:File) {
    if(!file)return;
    try {if(file.size>8192)throw new Error('This configuration file is too large.');configure(normalizeConfiguration(JSON.parse(await file.text())));}
    catch(e){setError(e instanceof Error?e.message:String(e));}
  }
  if(drive)return <App mode="multiplayer" matchId={drive.matchId} worldDocument={drive.world} autoConnect sessionKey={1} hideTopNav
    overlay={<div className="garage-drive-controls"><button onClick={()=>setDrive(null)}>← Back to garage</button><span>Test drive · E to enter · WASD to drive · Destruction pending</span></div>}/>;
  return <main className="garage-page">
    <header className="garage-header"><a href="/">VIBELAND <span>/ GARAGE</span></a><nav><a href="/city">Return to city ↗</a></nav></header>
    <aside className="garage-sidebar">
      <div className="garage-heading"><span className="garage-eyebrow">BUILD YOUR RIDE</span><h1>Make it yours.</h1><p>Choose a chassis. Find your stance.<br/>Every detail, your configuration.</p></div>
      <section><h2>Garage <span>7 vehicles</span></h2><div className="garage-roster">{vehicles.map(v=><button key={v.id} className={v.id===configuration.model?'selected':''} aria-pressed={v.id===configuration.model} onClick={()=>{configure(defaultConfiguration(v.id));setExplosion(0);}}><span style={{color:v.color}}>{v.code}</span><strong>{v.kind}</strong><small>{v.name}</small></button>)}</div></section>
      <section><h2>Configuration <button aria-label="Reset configuration" onClick={()=>configure(defaultConfiguration(configuration.model))}>↺</button></h2>
        <div className="garage-note" role="status" aria-live="polite">
          {!validation.complete?'Checking physical connections… You can keep adjusting your vehicle.':!validation.issue?'Physical connections checked. Ready to prepare.':null}
        </div>
        {validation.issue&&<div role="alert" className="garage-error"><p>{validation.issue.message}</p><p>{validation.issue.recovery}</p>
          {validation.issue.fields.length>0&&<button onClick={()=>configure({...configuration,dimensions:defaultConfiguration(configuration.model).dimensions})}>Restore preset dimensions</button>}
        </div>}
        {vehicleFields(configuration.model).map(([key,label,min,max,step])=><label className="garage-control" key={key}><span>{label}<output>{configuration.dimensions[key].toFixed(key==='tireRadius'?3:2)} <small>m</small></output></span><input type="range" aria-label={label} min={min} max={max} step={step} value={configuration.dimensions[key]} onChange={e=>configure({...configuration,dimensions:{...configuration.dimensions,[key]:Number(e.target.value)}})}/></label>)}
        <label className="garage-control"><span>Frame finish <small>Powder coat</small></span><div className="garage-colors">{[preset.color,'#e7ad21','#b43227','#1c487b','#c1c1b7'].map((color,i)=><button key={`${color}-${i}`} aria-label={`Frame finish ${color}`} aria-pressed={configuration.finish===color} style={{background:color}} onClick={()=>configure({...configuration,finish:color})}/>)}<input type="color" aria-label="Custom frame finish" value={configuration.finish} onChange={e=>configure({...configuration,finish:e.target.value})}/></div></label>
      </section>
      <section><h2>Assembly <span>{parts.toLocaleString()} parts</span></h2><label className="garage-control"><span>Exploded view<output>{Math.round(explosion*100)}%</output></span><input type="range" aria-label="Exploded view" min="0" max="1" step=".01" value={explosion} onChange={e=>setExplosion(Number(e.target.value))}/></label><div className="garage-buttons"><button aria-pressed={!wireframe} onClick={()=>setWireframe(false)}>Materials</button><button aria-pressed={wireframe} onClick={()=>setWireframe(true)}>Wireframe</button></div></section>
      <section><h2>Your configuration</h2><div className="garage-buttons"><button onClick={download}>Save JSON</button><button onClick={()=>importInput.current?.click()}>Load JSON</button></div><input ref={importInput} hidden type="file" accept=".json,application/json" onChange={e=>{void importFile(e.target.files?.[0]);e.target.value='';}}/>
        <button className="garage-primary" disabled={pending||!validation.complete||!!validation.issue} onClick={()=>void prepare()}>{pending?'Preparing your vehicle…':'Prepare on server'}</button>
        <button className="garage-primary" disabled={pending||!validation.complete||!!validation.issue||configuration.model==='semi'} onClick={()=>void prepare('session')}>Test drive</button>
        <button className="garage-primary" disabled={pending||!validation.complete||!!validation.issue||configuration.model==='semi'} onClick={()=>void prepare('city')}>Send to city</button>
        {cityVehicle&&prepared&&<div role="status" className="garage-prepared"><strong>Your vehicle is in the city</strong><p>Everyone in this city can see and drive it. Open the city beside your vehicle, then press E to enter.</p><a href={`/city?match=${encodeURIComponent(cityVehicle.matchId)}&garageVehicle=${prepared.assetHash}&garagePosition=${encodeURIComponent(cityVehicle.position.join(','))}`}>Open city beside your vehicle ↗</a><p>The vehicle stays until the city server restarts. Destruction is still being integrated.</p></div>}
        {configuration.model==='semi'&&<p className="garage-note">Trailer driving is being integrated. Preview and configuration are available.</p>}
        <p className="garage-note">Dimensions update instantly. Test your suspension on rolling hills and an uneven lane, with a level starting pad.</p>
        {error&&<p role="alert" className="garage-error">{error}</p>}
        {prepared&&<div role="status" className="garage-prepared"><strong>Configuration prepared · Simple colliders</strong><p>{prepared.partCount.toLocaleString()} collision groups · {prepared.shapeCount.toLocaleString()} collision shapes · {prepared.bondCount.toLocaleString()} measured joints</p><a href={`${resolveMultiplayerBackend().httpOrigin}/vehicle-assets/${prepared.geometryHash}/metadata.json`} target="_blank" rel="noreferrer">Inspect prepared assembly ↗</a><p>Test drives use server physics. Destruction is still being integrated.</p></div>}
      </section>
    </aside>
    <section className="garage-viewport" aria-label={`${preset.kind} preview`}><div className="garage-model-title"><span>{preset.code} / CUSTOM BUILD</span><h2>{preset.kind}</h2><p>{preset.description}</p></div>
      <Canvas shadows camera={{position:configuration.model==='semi'?[8,5,-10]:[5,3,-6],fov:42}} dpr={[1,1.5]}>
        <color attach="background" args={['#e9ece6']}/><hemisphereLight args={['#ffffff','#83948c',2]}/><ambientLight intensity={.5}/>
        <directionalLight position={[5,8,-4]} intensity={3} castShadow shadow-mapSize={[2048,2048]} shadow-camera-left={-8} shadow-camera-right={8} shadow-camera-top={8} shadow-camera-bottom={-8} shadow-normalBias={.03}/>
        <directionalLight position={[-5,3,5]} intensity={1.8}/>
        <Model configuration={configuration} explosion={explosion} wireframe={wireframe} onParts={setParts}/>
        <mesh rotation={[-Math.PI/2,0,0]} position={[0,-.01,0]} receiveShadow><planeGeometry args={[200,200]}/><meshStandardMaterial color="#e9ece6" roughness={1}/></mesh>
        <Grid position={[0,0,0]} args={[100,100]} cellSize={.5} sectionSize={2} cellColor="#c9d0c8" sectionColor="#b4c0b5" fadeDistance={22} infiniteGrid/>
        <OrbitControls makeDefault target={[0,1,configuration.model==='semi'?1.5:0]} minDistance={2} maxDistance={22} maxPolarAngle={Math.PI*.49}/>
      </Canvas>
      <footer><span><i/> LIVE CONFIGURATION</span><span>Drag to orbit · Scroll to zoom</span></footer>
    </section>
  </main>;
}
