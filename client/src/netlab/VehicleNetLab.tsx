import { VEHICLE_QUALITY_SCENARIOS } from '../../netlab/vehicle/scenarios';
import { useEffect, useRef, useState } from 'react';
import { getNetlabProfile, resolveNetlabImpairment } from './impairment';
import { scoreVehicleLab, vehicleLabEnabled, vehicleLabHref, VEHICLE_LAB_PROFILES, type VehicleLabScore } from './vehicleLab';
import { resetVehicleTelemetry } from './vehicleTelemetry';
import type { RecorderEvent } from './recorder';
import './VehicleNetLab.css';

export function VehicleNetLabSetup() {
  const [contractId,setContractId]=useState('recorded-course');
  const contract=VEHICLE_QUALITY_SCENARIOS.find(s=>s.id===contractId)!;
  const search=window.location.search, enabled=vehicleLabEnabled(search);
  const selected=resolveNetlabImpairment(search)?.name ?? 'baseline';
  return <section className="vehicle-lab-setup"><h2>Vehicle net lab</h2>
    <p>Drive your build under delay, jitter and packet loss. Record corrections and open another client to check spectator smoothness.</p>
    {enabled ? <><label>Network conditions<select aria-label="Vehicle lab network conditions" value={selected}
      onChange={e=>{window.location.href=vehicleLabHref(e.target.value,search);}}>
      {VEHICLE_LAB_PROFILES.map(name=><option key={name} value={name}>{name}{name==='blackhole'?' · 100% packet loss':name==='baseline'?' · no added delay':` · +${2*(getNetlabProfile(name)?.delayMs??0)} ms round trip`}</option>)}</select></label>
      <p>Choose Test drive below, then New capture. Network changes reload the garage; your saved build stays.</p></>:
      <a href={vehicleLabHref('baseline')}>Open vehicle net lab →</a>}
    <details><summary>Quality scenario contracts · {VEHICLE_QUALITY_SCENARIOS.length} cases</summary>
      <label>Inspect an evaluation contract<select aria-label="Vehicle quality scenario contract" value={contractId} onChange={e=>setContractId(e.target.value)}>
        {VEHICLE_QUALITY_SCENARIOS.map(s=><option value={s.id} key={s.id}>{s.id}</option>)}
      </select></label>
      <strong>{contract.question}</strong><p>{contract.capture}</p>
      <p>{contract.status==='replay-ready'?'Available in the CPU replay suite.':'Needs native evidence · cannot currently qualify this scenario.'}</p>
      <p>Required evidence: {contract.required.join(', ')||'fixed-tick body poses and corrections'}. This selector explains the contract; it does not change the driving course. Runtime timings are reported separately from quality.</p>
    </details>
  </section>;
}

export function VehicleNetLab({matchId}:{matchId:string}) {
  const [open,setOpen]=useState(true),[active,setActive]=useState(false),[scores,setScores]=useState<VehicleLabScore[]>([]);
  const [status,setStatus]=useState('Ready to capture'),[count,setCount]=useState(0);
  const events=useRef<RecorderEvent[]>([]),cursor=useRef(0),started=useRef(0),ownsRecording=useRef(false),lost=useRef(0);
  const params=new URLSearchParams(window.location.search),profileName=resolveNetlabImpairment(window.location.search)?.name??'baseline';
  const profile=getNetlabProfile(profileName);
  function drain() {
    const recorder=window.__VIBE_RECORDER__;if(!recorder)return;
    const batch=recorder.drainEvents(cursor.current,65536);if(batch.nextSeq<cursor.current) {
      lost.current++;ownsRecording.current=false;setActive(false);setStatus('Capture was reset. Repeat the run on a stable build.');return;
    }
    cursor.current=batch.nextSeq;
    lost.current+=batch.lostEvents;events.current.push(...batch.events);setCount(events.current.length);
    setScores(scoreVehicleLab(events.current).map(score=>lost.current?{...score,verdict:'insufficient'}:score));
  }
  function stop() {
    if(ownsRecording.current)window.__VIBE_RECORDER__?.stop();
    ownsRecording.current=false;drain();setActive(false);
    setStatus(lost.current?'Incomplete capture: events were lost. Repeat the run.':'Capture stopped');
  }
  function start() {
    const recorder=window.__VIBE_RECORDER__;if(!recorder)return;
    if(recorder.active()&&!ownsRecording.current){setStatus('Another netlab capture is active. Stop it before starting this capture.');return;}
    recorder.start({maxEvents:65536,maxFrames:32768});resetVehicleTelemetry();
    events.current=[];cursor.current=0;lost.current=0;started.current=performance.now();ownsRecording.current=true;
    recorder.mark('vehicle-run-start',{matchId,profile:profileName,seed:params.get('impairSeed')??'42'});
    setScores([]);setCount(0);setActive(true);setStatus('Recording · auto-stop at 120 seconds');
  }
  useEffect(()=>{
    if(!active)return;
    const timer=setInterval(()=>{
      drain();
      if(performance.now()-started.current>=120000 || events.current.length>=60000)stop();
    },500);
    return ()=>clearInterval(timer);
  },[active]);
  useEffect(()=>()=>{if(ownsRecording.current)window.__VIBE_RECORDER__?.stop();},[]);
  function download() {
    stop();const recorder=window.__VIBE_RECORDER__;
    const frames=recorder?.drainFrames(0,32768);
    const artifact={version:1,kind:'vehicle-netlab',createdAt:new Date().toISOString(),matchId,
      profile:profileName,seed:params.get('impairSeed')??'42',impairment:'in-process: delay/jitter/independent loss only',
      lostEvents:lost.current,frames,events:events.current,scores:scoreVehicleLab(events.current)};
    const url=URL.createObjectURL(new Blob([JSON.stringify(artifact)],{type:'application/json'}));
    const a=document.createElement('a');a.href=url;a.download=`vehicle-netlab-${profileName}-${Date.now()}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  const observer=new URLSearchParams(window.location.search);observer.set('vehicleNetlab','1');observer.set('observe',matchId);observer.set('impairSeed',String((resolveNetlabImpairment(window.location.search)?.seed??42)+101));
  return <aside className="vehicle-net-lab" aria-label="Vehicle network lab">
    <button className="vehicle-lab-toggle" aria-expanded={open} onClick={()=>{document.exitPointerLock?.();setOpen(!open);}}>Vehicle net lab {active?'●':''} {open?'−':'+'}</button>
    {open&&<div className="vehicle-lab-content">
      <strong>{profileName} · {profile?`+${profile.delayMs*2} ms round trip · ±${profile.jitterMs} ms jitter / direction · ${profile.lossPct}% loss`:'No added impairment'}</strong>
      <p>WASD to drive · Space to handbrake. Capture idle → accelerate → slalom → brake → ramp/landing. Mark each segment. Press Esc to use this panel.</p>
      <div className="vehicle-lab-actions"><button onClick={start} disabled={active}>New capture</button><button onClick={stop} disabled={!active}>Stop</button><button onClick={download} disabled={!count}>Export JSON</button></div>
      <div className="vehicle-lab-actions">{['Idle','Accelerate','Slalom','Brake','Landing','Impact'].map(label=><button key={label} disabled={!active} onClick={()=>window.__VIBE_RECORDER__?.mark(label)}>{label}</button>)}</div>
      {matchId.startsWith('garage-')&&<a href={`/garage?${observer}`} target="_blank" rel="noreferrer">Open observer client ↗</a>}
      <p role="status">{status} · {count.toLocaleString()} events</p>
      {!scores.length&&<p>Enter a vehicle with E and drive during capture. In the observer client, watch the other player driving. Keep the driver session open.</p>}
      {scores.map(score=><section key={`${score.role}:${score.vehicleId}`}>
        <h3>{score.role==='driver'?'Driver':'Spectator'} · vehicle {score.vehicleId}</h3>
        <p className={`vehicle-lab-verdict ${score.verdict}`}>{score.verdict==='insufficient'?'Need more evidence':score.verdict==='needs-work'?'Needs work':'Within provisional targets'} · {score.seconds.toFixed(0)} s captured / {score.movingSeconds.toFixed(0)} s moving</p>
        <table><thead><tr><th>Measurement</th><th>Observed</th><th>Target ≤</th></tr></thead><tbody>{score.metrics.map(m=><tr key={m.label}><td>{m.label}</td><td>{m.value===null?'—':`${m.value.toFixed(2)} ${m.unit}`}</td><td>{m.target??'—'}</td></tr>)}</tbody></table>
      </section>)}
      <p className="vehicle-lab-note">Quality targets require 30 s of vehicle data and 5 s moving. Runtime timings are diagnostic and do not decide the verdict. Input timing measures input tick → predicted pose, not physical tire response or display latency. Motion residual includes real impacts; inspect marked segments. Spectator delay is intentional, not driver prediction error.</p>
      <p className="vehicle-lab-note">This simulates packet callbacks, not bandwidth or QUIC congestion. A green score is not proof of correct landings or dynamic collisions. Compare exported runs and video with the same build, route and seed.</p>
    </div>}
  </aside>;
}
