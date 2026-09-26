import {useEffect,useState,useSyncExternalStore} from 'react';
import {setShotMode,shotMode} from './shotMode';
import {subscribeTownKit,townKitSnapshot} from './townKitState';

export function TownKitControls({matchId,baseUrl}:{matchId:string;baseUrl:string}){
 const status=useSyncExternalStore(subscribeTownKit,townKitSnapshot);
 const [resetting,setResetting]=useState(false),[error,setError]=useState('');
 useEffect(()=>{const previous=shotMode();setShotMode('cannonball');return()=>setShotMode(previous);},[]);
 async function reset(){setResetting(true);setError('');try{const r=await fetch(`${baseUrl}/city-reset/${encodeURIComponent(matchId)}`,{method:'POST'});if(!r.ok)throw Error(await r.text());}catch(e){setError(String(e));}finally{setResetting(false);}}
 return <section aria-label="Town kit playground" className="absolute left-3 top-24 z-20 max-w-72 rounded-xl border border-white/20 bg-slate-950/85 p-3 text-xs text-slate-200 shadow-lg">
  <h2 className="mb-1 text-sm font-semibold text-emerald-200">{status.title??'Town kit · live playground'}</h2>
  <p>{status.ready?(status.description??`${status.assets} labelled exhibits · trees, street props and a furnished house`):'Loading town-kit details…'}</p>
  <p className="mt-2">WASD move · Mouse aim · Click fire<br/>N fly / return to walking · Esc release mouse</p>
  <p className="mt-2 text-emerald-200">Aim at brickwork, panels or supports. Tougher structures may need a few hits.</p>
  <button type="button" disabled={resetting} onClick={()=>void reset()} className="mt-2 rounded bg-white/10 px-3 py-2 hover:bg-white/20 disabled:opacity-50">{resetting?'Resetting…':'Reset playground'}</button>
  {(error||status.error)&&<p role="alert" className="mt-2 text-amber-200">{error||status.error}</p>}
 </section>;
}
