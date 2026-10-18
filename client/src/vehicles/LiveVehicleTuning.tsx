import {useRef, useState} from 'react';
import {DrivingControls} from './DrivingControls';
import {normalizeConfiguration, serializeConfiguration, type VehicleConfiguration} from './configuration.mjs';
import {resolveMultiplayerBackend} from '../app/runtimeConfig';

type Prepared = {configuration:VehicleConfiguration;assetHash:string;geometryHash:string;partCount:number;shapeCount:number;bondCount:number};
export function LiveVehicleTuning({matchId,vehicle,onApplied,onBack}:{matchId:string;vehicle:Prepared;onApplied:(vehicle:Prepared)=>void;onBack:()=>void}) {
  const [open,setOpen]=useState(false),[draft,setDraft]=useState(vehicle.configuration);
  const [previous,setPrevious]=useState<VehicleConfiguration|null>(null);
  const [pending,setPending]=useState(false),[status,setStatus]=useState(''),[error,setError]=useState('');
  const inFlight=useRef(false);
  const [bombardment,setBombardment]=useState(false),[bombPending,setBombPending]=useState(false),[bombError,setBombError]=useState('');
  const bombInFlight=useRef(false);
  // Towers firing in each volley (of 16 on the ring) and meteors in the mix.
  const [towers,setTowers]=useState(6),[meteors,setMeteors]=useState(false);
  async function updateBombardment(enabled:boolean,next={towers,meteors}) {
    if(bombInFlight.current)return;
    bombInFlight.current=true;setBombPending(true);setBombError('');
    try {
      const response=await fetch(`${resolveMultiplayerBackend().httpOrigin}/vehicle-assets/session/${encodeURIComponent(matchId)}/bombardment`,{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled,towers:next.towers,meteors:next.meteors}),
      });
      if(!response.ok)throw Error(await response.text());
      const result=await response.json();setBombardment(result.enabled===true);
      if(typeof result.towers==='number')setTowers(result.towers);
      if(typeof result.meteors==='boolean')setMeteors(result.meteors);
    } catch(cause) {setBombError(cause instanceof Error?cause.message:String(cause));}
    finally {bombInFlight.current=false;setBombPending(false);}
  }
  // Changed while firing: applied at once. Otherwise sent with the next start.
  function setOption(next:{towers:number;meteors:boolean}) {
    setTowers(next.towers);setMeteors(next.meteors);
    if(bombardment)void updateBombardment(true,next);
  }
  const dirty=serializeConfiguration(draft)!==serializeConfiguration(vehicle.configuration);
  async function apply(configuration=draft) {
    if(inFlight.current)return;
    inFlight.current=true;setPending(true);setError('');setStatus('Applying…');
    const started=performance.now();
    try {
      const response=await fetch(`${resolveMultiplayerBackend().httpOrigin}/vehicle-assets/session/${encodeURIComponent(matchId)}/tuning`,{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({expectedAssetHash:vehicle.assetHash,driving:configuration.driving}),
      });
      if(!response.ok)throw Error(await response.text());
      const result=await response.json();
      const next:Prepared={...result.vehicle,configuration:normalizeConfiguration(result.vehicle.configuration)};
      if(next.geometryHash!==vehicle.geometryHash)throw Error('The server returned different geometry. Reopen the test drive.');
      setPrevious(vehicle.configuration);setDraft(next.configuration);onApplied(next);
      setStatus(`Applied & saved · ${Math.round(performance.now()-started)} ms · physics tick ${result.serverTick}`);
    } catch(cause) {setStatus('');setError(cause instanceof Error?cause.message:String(cause));}
    finally {inFlight.current=false;setPending(false);}
  }
  return <>
    <div className="garage-drive-controls"><button disabled={pending} onClick={onBack}>← Back to garage</button>
      <button aria-expanded={open} aria-controls="live-vehicle-tuning" onClick={()=>{document.exitPointerLock?.();setOpen(!open);}}>Tune driving</button>
      <button aria-pressed={bombardment} disabled={bombPending} onClick={()=>void updateBombardment(!bombardment)}>{bombPending?'Updating…':bombardment?'Stop bombardment':'Start bombardment'}</button>
      <label>Towers <select value={towers} disabled={bombPending} onChange={e=>setOption({towers:Number(e.target.value),meteors})}>
        {[1,2,4,6,8,12,16].map(n=><option key={n} value={n}>{n}</option>)}</select></label>
      <label><input type="checkbox" checked={meteors} disabled={bombPending} onChange={e=>setOption({towers,meteors:e.target.checked})}/> Meteors</label>
      <span role="status">{bombardment?`Incoming fire · ${towers} tower${towers===1?'':'s'} per volley${meteors?' · meteors every 10 s':''} · fires while you are driving · dodge by changing course`:'Test drive · E to enter · WASD to drive'}</span>
      <span>Impact testing · vehicle fracture pending</span>
      {bombError && <span role="alert">{bombError}</span>}
    </div>
    {open && <aside id="live-vehicle-tuning" className="garage-live-tuning" aria-label="Live driving tuning">
      <header><div><span className="garage-eyebrow">LIVE SETUP</span><h2>Tune. Apply. Drive.</h2></div><button className="garage-secondary" onClick={()=>setOpen(false)} aria-label="Close tuning">✕</button></header>
      <p className="garage-note">Stay in your vehicle. Apply updates its driving setup without rebuilding or restarting. Changes blend over 0.2 seconds.</p>
      <fieldset disabled={pending}><DrivingControls configuration={draft} onChange={setDraft}/></fieldset>
      <footer>
        <p role="status" aria-live="polite" className="garage-note">{pending?status:dirty?'Unapplied changes':status||'Current setup · ready to tune'}</p>
        {error && <p role="alert" className="garage-error">{error}</p>}
        <button className="garage-primary" disabled={pending||!dirty} onClick={()=>void apply()}>{pending?'Applying…':'Apply & save'}</button>
        <div className="garage-buttons"><button disabled={pending||!dirty} onClick={()=>{setDraft(vehicle.configuration);setError('');}}>Discard edits</button>
          <button disabled={pending||!previous} onClick={()=>previous&&void apply(previous)}>Undo last apply</button></div>
        <p className="garage-note">Dimensions and model changes still need garage preparation. Click the driving view to resume keyboard control.</p>
      </footer>
    </aside>}
  </>;
}
