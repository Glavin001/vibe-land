import { VehicleNetLabSetup } from '../netlab/VehicleNetLab';
import { App } from '../App';
import { parseWorldDocument, type WorldDocument } from '../world/worldDocument';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { Grid, OrbitControls } from '@react-three/drei';
import { VehicleVisual } from '../vehicles/VehicleVisual';
import { defaultConfiguration, normalizeConfiguration, serializeConfiguration, vehicleFields, vehicles, resolveVehicleGeometry, type VehicleConfiguration } from '../vehicles/configuration.mjs';
import { resolveMultiplayerBackend } from '../app/runtimeConfig';
import { useVehicleValidation, type ExplosionGroup } from '../vehicles/useVehicleValidation';
import {garageBuilds} from '../vehicles/builds.mjs';
import {DrivingControls} from '../vehicles/DrivingControls';
import {LiveVehicleTuning} from '../vehicles/LiveVehicleTuning';
import './Garage.css';

const STORAGE_KEY = 'vibe-land/garage/configuration-v1';
function initialConfiguration(): VehicleConfiguration {
  try { const saved=localStorage.getItem(STORAGE_KEY);if(saved)return normalizeConfiguration(JSON.parse(saved)); } catch { /* A stale configuration must not prevent opening the workshop. */ }
  return defaultConfiguration();
}
function Model({ configuration, explosion, wireframe, travel, steer, explosionGroups, onParts }: {configuration: VehicleConfiguration; explosion: number; wireframe: boolean; travel:number; steer:number; explosionGroups?:ExplosionGroup[]; onParts: (n:number)=>void}) {
  const [visual] = useState(()=>new VehicleVisual(configuration));
  const explosionCenters = useMemo(()=>explosionGroups && new Map(explosionGroups.flatMap(group=>
    group.visualIds.map(id=>[id,group.position] as [string,number[]]))),[explosionGroups]);
  const groupedExplosion = explosionCenters ? explosion : 0;
  useLayoutEffect(()=>{
    visual.configure(configuration);
    if(groupedExplosion) visual.setWheelState([0,1,2,3].map(()=>({travelM:0,steeringRad:0,rotationRad:0,grounded:true})));
    visual.inspect(groupedExplosion,wireframe,undefined,explosionCenters);
    if(!groupedExplosion){
      const g=resolveVehicleGeometry(configuration);
      visual.setWheelState([0,1,2,3].map(w=>({travelM:travel*(travel<0?g.extension:g.compression),steeringRad:w<2?steer*g.maxSteerRadians*configuration.driving.steeringLimit:0,rotationRad:0,grounded:true})));
    }
    onParts(visual.partCount);
  },[visual,configuration,groupedExplosion,explosionCenters,wireframe,travel,steer,onParts]);
  useEffect(()=>()=>visual.dispose(),[visual]);
  return <primitive object={visual.group} dispose={null}/>;
}
interface Prepared { configuration: VehicleConfiguration; assetHash: string; geometryHash: string; partCount: number; shapeCount: number; bondCount: number }

export function GaragePage() {
  const observe=new URLSearchParams(window.location.search).get('observe');
  return observe?<GarageObserver matchId={observe}/>:<GarageWorkshop/>;
}
function GarageObserver({matchId}:{matchId:string}) {
  const [world,setWorld]=useState<WorldDocument|null>(null),[error,setError]=useState('');
  useEffect(()=>{
    const controller=new AbortController();
    void (async()=>{try {
      const response=await fetch(`${resolveMultiplayerBackend().httpOrigin}/vehicle-assets/session/${encodeURIComponent(matchId)}`,{signal:controller.signal});
      if(!response.ok)throw Error('This test drive is unavailable. Keep the driver session open and open its observer link again.');
      const payload=await response.json();if(!controller.signal.aborted)setWorld(parseWorldDocument(payload.worldDocument));
    } catch(e){if(!controller.signal.aborted)setError(e instanceof Error?e.message:String(e));}})();
    return ()=>controller.abort();
  },[matchId]);
  if(error)return <main><p role="alert">{error}</p><a href="/garage?vehicleNetlab=1">Back to garage</a></main>;
  if(!world)return <main><p role="status">Loading the driver's test course…</p></main>;
  return <App mode="multiplayer" matchId={matchId} worldDocument={world} autoConnect sessionKey={1} hideTopNav/>;
}
function GarageWorkshop() {
  const [configuration,setConfiguration]=useState(initialConfiguration);
  const [tab,setTab]=useState<'build'|'style'|'drive'|'inspect'>('build');
  const [travel,setTravel]=useState(0),[steer,setSteer]=useState(0);
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
      result.configuration=normalizeConfiguration(result.configuration);
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
    overlay={prepared && <LiveVehicleTuning matchId={drive.matchId} vehicle={prepared}
      onBack={()=>setDrive(null)} onApplied={vehicle=>{setPrepared(vehicle);setConfiguration(vehicle.configuration);}}/>}/>;
  return <main className="garage-page">
    <header className="garage-header"><a href="/">VIBELAND <span>/ GARAGE</span></a><nav><a href="/city">Return to city ↗</a></nav></header>
    <aside className="garage-sidebar">
      <div className="garage-heading"><span className="garage-eyebrow">BUILD YOUR RIDE</span><h1>Make it yours.</h1><p>Choose a build. Shape its character.<br/>Make it unmistakably yours.</p></div>
      <nav className="garage-tabs" aria-label="Customization sections">{(['build','style','drive','inspect'] as const).map(t=><button key={t} aria-pressed={tab===t} onClick={()=>{setTab(t);if(t!=='inspect'){setTravel(0);setSteer(0);setExplosion(0);}}}>{t}</button>)}</nav>
      <div hidden={tab!=='build'}>
      <section><h2>Garage <span>{garageBuilds.length} builds · {vehicles.length} chassis</span></h2><div className="garage-roster">{garageBuilds.map(build=>{
        const selected=serializeConfiguration(build.configuration)===serializeConfiguration(configuration);
        return <button key={build.id} className={selected?'selected':''} aria-pressed={selected} onClick={()=>{configure(build.configuration);setExplosion(0);}}><span style={{color:build.configuration.finish}}>{vehicles.find(v=>v.id===build.configuration.model)?.code}</span><strong>{build.name}</strong><small>{build.description}</small></button>;
      })}</div></section>
      <section><h2>Configuration <button aria-label="Reset configuration" onClick={()=>configure(defaultConfiguration(configuration.model))}>↺</button></h2>
        {vehicleFields(configuration.model).map(([key,label,min,max,step])=><label className="garage-control" key={key}><span>{label}<output>{configuration.dimensions[key].toFixed(key==='tireRadius'?3:2)} <small>m</small></output></span><input type="range" aria-label={label} min={min} max={max} step={Math.min(step,.005)} value={configuration.dimensions[key]} onChange={e=>configure({...configuration,dimensions:{...configuration.dimensions,[key]:Number(e.target.value)}})}/></label>)}

      </section>
      </div>
      <div hidden={tab!=='style'}><section><h2>Style</h2>
        <label className="garage-control"><span>Frame finish <small>{configuration.appearance.paint}</small></span><div className="garage-colors">{[preset.color,'#e7ad21','#b43227','#1c487b','#c1c1b7'].map((color,i)=><button key={`${color}-${i}`} aria-label={`Frame finish ${color}`} aria-pressed={configuration.finish===color} style={{background:color}} onClick={()=>configure({...configuration,finish:color})}/>)}<input type="color" aria-label="Custom frame finish" value={configuration.finish} onChange={e=>configure({...configuration,finish:e.target.value})}/></div></label>
        {([['body','Body paint'],['accent','Accent & trim'],['wheels','Wheel finish'],['seats','Seat fabric']] as const).map(([key,label])=><label className="garage-color-control" key={key}><span>{label}</span><input type="color" aria-label={label} value={configuration.appearance[key]} onChange={e=>configure({...configuration,appearance:{...configuration.appearance,[key]:e.target.value}})}/></label>)}
        <label className="garage-select"><span>Paint surface</span><select aria-label="Paint surface" value={configuration.appearance.paint} onChange={e=>configure({...configuration,appearance:{...configuration.appearance,paint:e.target.value as VehicleConfiguration['appearance']['paint']}})}><option value="matte">Matte</option><option value="satin">Satin</option><option value="gloss">Gloss</option></select></label>
      </section>
      </div>
      <div hidden={tab!=='drive'}><DrivingControls configuration={configuration} onChange={configure}/></div>
      <div hidden={tab!=='inspect'}><section><h2>Linkage preview</h2>
        <p className="garage-note">Explore the wheel travel and steering available to this chassis. This is a geometry preview; use Test drive to feel its suspension under load.</p>
        <label className="garage-control"><span>Suspension travel<output>{Math.round(travel*100)}%</output></span><input type="range" aria-label="Suspension travel preview" min="-1" max="1" step=".01" value={travel} onChange={e=>{setTravel(Number(e.target.value));setExplosion(0);}}/></label>
        <label className="garage-control"><span>Steering<output>{Math.round(steer*100)}%</output></span><input type="range" aria-label="Steering preview" min="-1" max="1" step=".01" value={steer} onChange={e=>{setSteer(Number(e.target.value));setExplosion(0);}}/></label>
        <button className="garage-secondary" onClick={()=>{setTravel(0);setSteer(0);setExplosion(0);}}>Center wheels</button>
      </section><section><h2>Assembly <span>{validation.explosionGroups?.length.toLocaleString() ?? "…"} groups</span></h2><p className="garage-note">{parts.toLocaleString()} visual parts move with their Simple collider groups. Tires, rims and treads stay together.</p><label className="garage-control"><span>Exploded view<output>{Math.round(explosion*100)}%</output></span><input type="range" aria-label="Exploded view" disabled={!validation.explosionGroups} min="0" max="1" step=".01" value={explosion} onChange={e=>setExplosion(Number(e.target.value))}/></label><div className="garage-buttons"><button aria-pressed={!wireframe} onClick={()=>setWireframe(false)}>Materials</button><button aria-pressed={wireframe} onClick={()=>setWireframe(true)}>Wireframe</button></div></section>
      </div>
      <VehicleNetLabSetup/>
      <section><h2>Your configuration</h2><div className="garage-buttons"><button onClick={download}>Save JSON</button><button onClick={()=>importInput.current?.click()}>Load JSON</button></div><input ref={importInput} hidden type="file" accept=".json,application/json" onChange={e=>{void importFile(e.target.files?.[0]);e.target.value='';}}/>
        <div className="garage-note" role="status" aria-live="polite">
          {!validation.complete?'Checking physical connections… You can keep adjusting your vehicle.':!validation.issue?'Physical connections checked. Ready to prepare.':null}
        </div>
        {validation.issue&&<div role="alert" className="garage-error"><p>{validation.issue.message}</p><p>{validation.issue.recovery}</p>
          {validation.issue.fields.length>0&&<button onClick={()=>configure({...configuration,dimensions:defaultConfiguration(configuration.model).dimensions})}>Restore preset dimensions</button>}
        </div>}
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
    <section className="garage-viewport" aria-label={`${preset.kind} preview`}><div className="garage-model-title"><span>{preset.code} / CUSTOM BUILD</span><h2>{preset.kind}</h2><p>{preset.description}</p><div className="garage-build-badges"><span>{configuration.driving.drivetrain.toUpperCase()}</span><span>{Math.round(configuration.driving.topSpeed*3.6)} km/h setup</span><span>{configuration.appearance.paint} finish</span></div></div>
      <Canvas shadows camera={{position:configuration.model==='semi'?[8,5,-10]:[5,3,-6],fov:42}} dpr={[1,1.5]}>
        <color attach="background" args={['#e9ece6']}/><hemisphereLight args={['#ffffff','#83948c',2]}/><ambientLight intensity={.5}/>
        <directionalLight position={[5,8,-4]} intensity={3} castShadow shadow-mapSize={[2048,2048]} shadow-camera-left={-8} shadow-camera-right={8} shadow-camera-top={8} shadow-camera-bottom={-8} shadow-normalBias={.03}/>
        <directionalLight position={[-5,3,5]} intensity={1.8}/>
        <Model configuration={configuration} explosion={explosion} explosionGroups={validation.explosionGroups} wireframe={wireframe} travel={travel} steer={steer} onParts={setParts}/>
        <mesh rotation={[-Math.PI/2,0,0]} position={[0,-.01,0]} receiveShadow><planeGeometry args={[200,200]}/><meshStandardMaterial color="#e9ece6" roughness={1}/></mesh>
        <Grid position={[0,0,0]} args={[100,100]} cellSize={.5} sectionSize={2} cellColor="#c9d0c8" sectionColor="#b4c0b5" fadeDistance={22} infiniteGrid/>
        <OrbitControls makeDefault target={[0,1,configuration.model==='semi'?1.5:0]} minDistance={2} maxDistance={22} maxPolarAngle={Math.PI*.49}/>
      </Canvas>
      <footer><span><i/> LIVE CONFIGURATION</span><span>Drag to orbit · Scroll to zoom</span></footer>
    </section>
  </main>;
}
