import { defaults } from './buggy.mjs';
export const parameterKey=p=>Object.keys(defaults).map(k=>`${k}:${p[k]??defaults[k]}`).join('|')+(p.vehicle&&p.vehicle!=='buggy'?`|vehicle:${p.vehicle}`:'');

/** Live edits are synchronous and full-detail. Precision partitioning happens
 * only on an explicit export request, and never replaces the visible model.
 */
export class ModelPipeline {
 constructor({createWorker,createLiveModel,onModel,onStatus,onError,now=()=>performance.now()}) {
  Object.assign(this,{createWorker,createLiveModel,onModel,onStatus,onError,now});
  this.revision=0;this.disposed=false;this.cache=new Map();this.worker=null;this.job=null;
 }
 seed(model){if(!this.disposed)this.remember(model)}
 remember(model){if(model.quality==='preview'||model.quality==='live')throw Error('Only partitioned models can be cached for export');const key=parameterKey(model.parameters);this.cache.delete(key);this.cache.set(key,model);while(this.cache.size>8){const victim=[...this.cache.keys()].find(k=>k!==parameterKey(defaults));if(!victim)break;this.cache.delete(victim)}}
 request(parameters){
  if(this.disposed)return;
  const p={...defaults,...parameters};if(this.target&&parameterKey(this.target)===parameterKey(p))return;
  const started=this.now(),model=this.createLiveModel(p);
  this.cancel('Configuration changed. Export the updated model when ready.');
  this.target=p;this.revision++;
  this.onModel(model,{revision:this.revision,buildMs:this.now()-started,latencyMs:this.now()-started,cached:false});
  this.onStatus({phase:'ready',progress:100});
 }
 prepare(){
  if(this.disposed||!this.target)return Promise.reject(Error('No model to export'));
  const cached=this.cache.get(parameterKey(this.target));if(cached)return Promise.resolve(cached);
  if(this.job)return this.job.promise;
  const worker=this.createWorker();this.worker=worker;
  const job={id:this.revision,parameters:{...this.target},resolve:null,reject:null,promise:null};
  job.promise=new Promise((resolve,reject)=>{job.resolve=resolve;job.reject=reject});this.job=job;
  worker.onmessage=e=>{
   if(this.disposed||this.worker!==worker||this.job!==job||e.data.id!==job.id)return;
   const data=e.data;
   if(data.error){this.fail(data.error);return;}
   if(!data.model){this.onStatus({phase:'exporting',progress:data.progress??0});return;}
   if(parameterKey(data.model.parameters)!==parameterKey(job.parameters)||data.model.quality==='preview'||data.model.quality==='live'){this.fail('The export build did not match the selected configuration');return;}
   this.remember(data.model);this.worker=null;this.job=null;worker.terminate();this.onStatus({phase:'ready',progress:100});job.resolve(data.model);
  };
  worker.onerror=e=>{if(this.worker===worker)this.fail(e.message||'Export preparation failed')};
  this.onStatus({phase:'exporting',progress:0});worker.postMessage({id:job.id,parameters:job.parameters,quality:'final',detail:'high'});
  return job.promise;
 }
 fail(message){this.cancel(message);this.onStatus({phase:'ready',progress:100});this.onError(message,'export')}
 cancel(message='Export cancelled') {const job=this.job;this.job=null;this.worker?.terminate();this.worker=null;if(job)job.reject(Error(message));}
 dispose(){this.disposed=true;this.cancel('Viewer closed');this.cache.clear()}
}
