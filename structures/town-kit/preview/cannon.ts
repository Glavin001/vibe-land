import * as THREE from 'three';

type Callbacks={reset:()=>Promise<void>;result:(recording:any,report:any)=>void;error:(e:Error)=>void};
const el=(id:string)=>document.getElementById(id) as any;
async function json(url:string,options:RequestInit={}){
 const r=await fetch(url,{...options,cache:'no-store'});
 if(!r.headers.get('content-type')?.includes('application/json'))throw Error('Restart the preview service to enable the cannon range.');
 const data=await r.json();if(!r.ok)throw Error(data.error??'Cannon request failed.');return data;
}
export class Cannon {
 private name='';private meta:any;private meshes:THREE.InstancedMesh[]=[];
 private target=new THREE.Vector3();private from=new THREE.Vector3();private aiming=false;private busy=false;
 private down=[0,0];private ray=new THREE.Raycaster();private revision=0;
 private ball=new THREE.Mesh(new THREE.SphereGeometry(1,24,16),new THREE.MeshStandardMaterial({color:'#252c32',metalness:.8,roughness:.28}));
 private marker=new THREE.Mesh(new THREE.SphereGeometry(.075,12,8),new THREE.MeshBasicMaterial({color:'#ed6e30',depthTest:false}));
 private guide=new THREE.Line(new THREE.BufferGeometry(),new THREE.LineDashedMaterial({color:'#dd653a',dashSize:.2,gapSize:.12,transparent:true,opacity:.7}));
 constructor(private scene:THREE.Scene,private camera:THREE.Camera,private canvas:HTMLCanvasElement,private callbacks:Callbacks){
  this.ball.castShadow=true;this.ball.receiveShadow=true;this.marker.renderOrder=10;
  for(const item of [this.ball,this.marker,this.guide]){item.visible=false;scene.add(item);}
  el('aim-shot').onclick=()=>this.aim().catch(callbacks.error);
  el('fire-shot').onclick=()=>this.fire().catch(callbacks.error);
  el('ball-speed').oninput=()=>this.speedLabel();
  el('ball-mass').onchange=()=>this.speedLimit();this.speedLimit();
  canvas.addEventListener('pointerdown',e=>{this.down=[e.clientX,e.clientY];});
  canvas.addEventListener('pointerup',e=>{
   if(!this.aiming||this.busy||e.button!==0||Math.hypot(e.clientX-this.down[0],e.clientY-this.down[1])>5)return;
   const r=canvas.getBoundingClientRect();this.ray.setFromCamera(new THREE.Vector2((e.clientX-r.left)/r.width*2-1,-(e.clientY-r.top)/r.height*2+1),camera);
   const hit=this.ray.intersectObjects(this.meshes,false)[0];
   if(!hit){el('cannon-hint').textContent='No wood under the cursor. Click the trunk or a visible branch.';return;}
   this.target.copy(hit.point);this.updateGuide();el('cannon-hint').textContent='Target set. Orbit to change the firing direction, then fire.';
  });
 }
 setAsset(name:string,meta:any,meshes:THREE.InstancedMesh[]){
  this.revision++;this.name=name;this.meta=meta;this.meshes=meshes;this.aiming=false;this.hide();
  el('cannon').hidden=meta?.kind!=='tree';
  this.target.fromArray(meta?.shots?.collapse?.[0]?.to??[0,2,0]);
  el('cannon-hint').textContent='Aim at wood, then fire. Each shot starts with a fresh tree.';
 }
 hide(){this.ball.visible=false;this.marker.visible=false;this.guide.visible=false;this.aiming=false;}
 pose(round:number[]|null){this.ball.visible=!!round;if(round){this.ball.position.fromArray(round);this.ball.scale.setScalar(round[3]);}}
 private speedLabel(){el('speed-label').textContent=`${el('ball-speed').value} m/s`;}
 private speedLimit(){
  const radius=Math.cbrt(Number(el('ball-mass').value)/(7850*4/3*Math.PI));
  el('ball-speed').max=String(Math.min(60,Math.floor(radius*120*.9/5)*5));this.speedLabel();
 }
 private updateGuide(){
  const direction=new THREE.Vector3().subVectors(this.camera.position,this.target);direction.y=0;
  if(direction.length()<.01)direction.set(0,0,-1);direction.normalize();
  this.from.copy(this.target).addScaledVector(direction,Math.min(6,Number(el('ball-speed').value)**2/(9.81*2)));this.from.y=Math.max(.7,this.target.y);
  this.marker.position.copy(this.target);this.marker.visible=true;this.guide.visible=true;
  let positions=this.guide.geometry.getAttribute('position') as THREE.BufferAttribute;
  if(!positions){positions=new THREE.BufferAttribute(new Float32Array(6),3);this.guide.geometry.setAttribute('position',positions);}
  positions.setXYZ(0,this.from.x,this.from.y,this.from.z);positions.setXYZ(1,this.target.x,this.target.y,this.target.z);positions.needsUpdate=true;this.guide.geometry.computeBoundingSphere();this.guide.computeLineDistances();
 }
 update(){if(this.aiming)this.updateGuide();}
 async aim(){
  if(this.busy||this.meta?.kind!=='tree')return;
  await this.callbacks.reset();this.aiming=true;this.updateGuide();
  el('aim-shot').textContent='Click wood';el('cannon-hint').textContent='Click the trunk or a branch to aim. Drag to orbit; the shot comes from your side.';
 }
 async fire(){
  if(this.busy||this.meta?.kind!=='tree')return;
  this.busy=true;const revision=this.revision;
  const disabled=['asset','recording','aim-shot','fire-shot','ball-mass','ball-speed','play','reset','timeline'];
  const previous=disabled.map(id=>el(id).disabled);disabled.forEach(id=>el(id).disabled=true);
  el('error').textContent='';el('fire-shot').textContent='Calculating…';el('cannon-hint').textContent='Running your shot through the native stress solver…';
  try{
   await this.callbacks.reset();this.updateGuide();this.aiming=false;this.marker.visible=false;this.guide.visible=false;
   const input={asset:this.name,from:this.from.toArray(),to:this.target.toArray(),mass:Number(el('ball-mass').value),speed:Number(el('ball-speed').value)};
   let job=await json('/api/cannon/jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
   const started=performance.now();
   while(job.state==='running'){
    if(performance.now()-started>100000)throw Error('The shot timed out. Try again after the native solver finishes.');
    await new Promise(resolve=>setTimeout(resolve,400));job=await json(`/api/cannon/jobs/${job.id}`);
   }
   if(job.state!=='complete')throw Error(job.error??'The native solver could not complete this shot.');
   const recording=await json(`${job.base}/recording.json`);
   if(revision!==this.revision)return;
   if(recording.packHash!==this.meta.assetSha256)throw Error('Tree changed while the shot was running. Reload and fire again.');
   this.callbacks.result(recording,job.report);
   el('cannon-hint').textContent=`${input.mass.toLocaleString()} kg at ${input.speed} m/s · actual ball motion and fractures. Aim again for a fresh tree.`;
  }catch(e){el('cannon-hint').textContent='Shot could not finish. Adjust the shot or choose another tree and try again.';throw e;}finally{
   this.busy=false;disabled.forEach((id,i)=>el(id).disabled=previous[i]);el('fire-shot').textContent='Fire ball';el('aim-shot').textContent='Aim shot';
  }
 }
}
