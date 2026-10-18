import {Cannon} from './cannon';
import {recordTour} from './tourVideo';
import {gardenGround} from './gardenGround';
import * as THREE from 'three';
import {OutdoorAttachments} from './outdoorAttachments';
import {canonicalHull} from './hullReuse';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { SSAOPass } from 'three/examples/jsm/postprocessing/SSAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { buildBoxGeometry,buildHullGeometry } from '@game/city/chunkGeometry';
import { finishPresets } from './finishes';
import { applyCityTriplanar,setCityTextureTuning } from '@game/scene/cityMaterialShader';
import { loadCityTextures } from '@game/scene/cityTextures';
import { layerCodeForMaterial } from '@game/structures/structurePack';
const $=(id:string)=>document.getElementById(id) as any;
async function fetchJson(url:string){
 const r=await fetch(url,{cache:'no-store'}),type=r.headers.get('content-type')??'';
 if(!type.includes('application/json'))throw Error(`Preview returned a page instead of asset data: ${url}. Restart the preview service.`);
 const data=await r.json();if(!r.ok)throw Error(data.error??`Unable to load ${url}`);return data;
}
let catalog:any[]=[];
const recordingLabels=new Map(Array.from(($('recording') as HTMLSelectElement).options).map(o=>[o.value,o.text]));
function recordingOptions(name:string){
 $('recording').replaceChildren(new Option('Intact / authoring',''));
 for(const r of catalog.find(a=>a.name===name)?.recordings??[]){
  const reason=!r.current?'outdated':!r.available?'not recorded':!r.passed?'failed review':'';
  const option=new Option(`${recordingLabels.get(r.mode)??r.mode}${reason?` (${reason})`:''}`,r.mode);option.disabled=!!reason;option.title=r.error??'';$('recording').add(option);
 }
}
const query=new URLSearchParams(location.search);if(query.has('clean'))document.body.classList.add('clean');
const finishName=(query.get('finish')??'fine') as keyof typeof finishPresets;
if(!finishPresets[finishName])throw Error('Unknown finish preset');
setCityTextureTuning(finishPresets[finishName]);
const renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});renderer.info.autoReset=false;renderer.setPixelRatio(1);renderer.setSize(innerWidth,innerHeight);renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.0;document.body.prepend(renderer.domElement);
const scene=new THREE.Scene();scene.background=new THREE.Color('#dce6e3');scene.fog=new THREE.Fog('#dce6e3',90,230);
const camera=new THREE.PerspectiveCamera(48,innerWidth/innerHeight,.03,350),controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=true;controls.dampingFactor=.12;controls.maxDistance=100;controls.minDistance=.1;controls.maxPolarAngle=Math.PI*.95;
const pmrem=new THREE.PMREMGenerator(renderer);scene.environment=pmrem.fromScene(new RoomEnvironment(),.08).texture;scene.environmentIntensity=.55;
scene.add(new THREE.HemisphereLight('#e4f0f7','#85775f',1.1));
const sun=new THREE.DirectionalLight('#fff0cd',2.4);sun.position.set(-18,30,-20);sun.castShadow=true;sun.shadow.mapSize.set(4096,4096);Object.assign(sun.shadow.camera,{left:-23,right:23,top:23,bottom:-23,near:.5,far:90});sun.shadow.bias=-.00015;sun.shadow.normalBias=.018;scene.add(sun);
const fill=new THREE.DirectionalLight('#c7dce5',.8);fill.position.set(15,12,12);scene.add(fill);
const ground=new THREE.Mesh(new THREE.PlaneGeometry(500,500),new THREE.MeshStandardMaterial({color:'#b4b6a1',roughness:1}));ground.rotation.x=-Math.PI/2;ground.position.y=-.005;ground.receiveShadow=true;scene.add(ground);
// Display plinth is preview scenery only, explicitly excluded from the asset.
const apron=new THREE.Mesh(new THREE.BoxGeometry(15,.08,20),new THREE.MeshStandardMaterial({color:'#c7c3af',roughness:1}));apron.position.set(0,-.045,.1);apron.receiveShadow=true;scene.add(apron);
const road=new THREE.Mesh(new THREE.PlaneGeometry(140,8),new THREE.MeshStandardMaterial({color:'#727a76',roughness:1}));road.rotation.x=-Math.PI/2;road.position.set(0,-.003,-14);scene.add(road);
const walker=new THREE.Mesh(new THREE.CapsuleGeometry(.35,.9,4,8),new THREE.MeshStandardMaterial({color:0xc75e38,transparent:true,opacity:.6}));walker.visible=false;scene.add(walker);
let outdoor:OutdoorAttachments|null=null,assetLoad=0,recordingLoad=0;
let gardenSurface:ReturnType<typeof gardenGround>|null=null;
let followWalker=false,followDebris=false,frameCursor=0,lastSeek=-1,playbackStart=0;
let livePositions:number[][]=[];
let pack:any,meta:any,slots:any[]=[],meshes:THREE.InstancedMesh[]=[],recording:any=null,playing=false,time=0,cutaway=false;
let cannonRecording:any=null,activeReport:any=null,exporting=false;
const filmButton=document.createElement('button');filmButton.textContent='Record cannon tour';filmButton.hidden=true;document.querySelector('aside')!.append(filmButton);
const filmStatus=document.createElement('p');document.querySelector('aside')!.append(filmStatus);
filmButton.onclick=()=>exportCannonTour().catch(fail);
const cannon=new Cannon(scene,camera,renderer.domElement,{reset:()=>loadRecording(''),error:fail,result:(r,report)=>{
 cannonRecording={r,report};if(!Array.from(($('recording') as HTMLSelectElement).options).some(o=>o.value==='cannon'))$('recording').add(new Option('Your cannon shot','cannon'));
 $('recording').value='cannon';installRecording(r,report,'Cannon shot');playing=true;$('play').textContent='Pause';
}});
const composer=new EffectComposer(renderer);composer.addPass(new RenderPass(scene,camera));const oldRandom=Math.random;let noiseSeed=271828;Math.random=()=>{noiseSeed=(1664525*noiseSeed+1013904223)>>>0;return noiseSeed/4294967296;};const ao=new SSAOPass(scene,camera,innerWidth,innerHeight);Math.random=oldRandom;ao.kernelRadius=.35;ao.minDistance=.002;ao.maxDistance=.035;composer.addPass(ao);composer.addPass(new OutputPass());
const matrix=new THREE.Matrix4(),pos=new THREE.Vector3(),rot=new THREE.Quaternion(),scale=new THREE.Vector3();
const boundsDirty=new Set<THREE.InstancedMesh>();
const cutTypes=new Set(['roof','gable','ridge-beam','eave-plate','gable-plate','ceiling']);
function renderPose(i:number,p:number[]) {outdoor?.setPose(i,p);livePositions[i]=p.slice(0,3);const slot=slots[i];pos.fromArray(p);rot.fromArray(p,3);if(slot.rotation)rot.multiply(slot.rotation);scale.fromArray(slot.scale);if(cutaway&&cutTypes.has(pack.scenario.nodeTypes[i]))scale.set(0,0,0);matrix.compose(pos,rot,scale);slot.mesh.setMatrixAt(slot.instance,matrix);slot.mesh.instanceMatrix.needsUpdate=true;boundsDirty.add(slot.mesh);}
function resetPoses(){if(!pack)return;pack.scenario.nodes.forEach((n:any,i:number)=>renderPose(i,[n.centroid.x,n.centroid.y,n.centroid.z,0,0,0,1]));}
function setCamera(p:any){camera.position.fromArray(p.position);controls.target.fromArray(p.target);if(meta?.sceneLayout){camera.near=Math.min(.7,Math.max(.03,camera.position.distanceTo(controls.target)/300));camera.updateProjectionMatrix();}controls.update();}
function debrisCenter(){
 const center=new THREE.Vector3();let total=0;
 pack.scenario.nodes.forEach((n:any,i:number)=>{if(n.mass>0){center.addScaledVector(new THREE.Vector3().fromArray(livePositions[i]),n.mass);total+=n.mass;}});
 return total?center.divideScalar(total):center;
}
function damageCameras(){
 const box=new THREE.Box3();
 pack.scenario.nodes.forEach((n:any,i:number)=>{if(n.mass<=0)return;const p=new THREE.Vector3().fromArray(livePositions[i]),sz=pack.scenario.nodeSizes[i],r=Math.hypot(sz.x,sz.y,sz.z)/2;box.expandByPoint(p.clone().addScalar(r));box.expandByPoint(p.clone().addScalar(-r));});
 outdoor?.expandBounds(box);
 const target=box.getCenter(new THREE.Vector3()),distance=Math.max(3.4,box.getSize(new THREE.Vector3()).length()/2/Math.sin(24*Math.PI/180)*1.12);
 return Object.fromEntries(Object.entries({hero:[1,.7,-1],front:[0,.35,-1],rear:[1,.6,1]}).map(([name,direction])=>[name,{position:target.clone().addScaledVector(new THREE.Vector3().fromArray(direction).normalize(),distance).toArray(),target:target.toArray()}]));
}
function movePropLighting(delta:THREE.Vector3){if(!['prop','tree'].includes(meta.kind))return;sun.position.add(delta);sun.target.position.add(delta);sun.target.updateMatrixWorld();}
function frameFragments(){const pose=damageCameras().hero;setCamera(pose);if(['prop','tree'].includes(meta.kind)){const delta=new THREE.Vector3().fromArray(pose.target).sub(sun.target.position);movePropLighting(delta);}}
function trackFragments(value:boolean){followDebris=value;if(value)followWalker=false;$('track').textContent=value?'Stop tracking':'Track fragments';}
async function loadAsset(name:string){
 const load=++assetLoad;cannon.setAsset('',null,[]);cannonRecording=null;
 recordingOptions(name);
 recordingLoad++;$('recording').value='';$('play').textContent='Play';$('timeline').min='0';$('timeline').value='0';$('timeline').max='0';$('time').textContent='0.00 s';
 $('error').textContent='';(window as any).__TOWN_KIT__.ready=false;(window as any).__TOWN_KIT__.error=null;recording=null;time=0;playbackStart=0;playing=false;walker.visible=false;frameCursor=0;lastSeek=-1;followWalker=false;trackFragments(false);livePositions=[];sun.position.set(-18,30,-20);sun.target.position.set(0,0,0);sun.target.updateMatrixWorld();
 outdoor?.dispose();outdoor=null;
 for(const mesh of meshes){scene.remove(mesh);mesh.geometry.dispose();(mesh.material as THREE.Material).dispose();}meshes=[];slots=[];boundsDirty.clear();
 const loaded=await Promise.all([fetchJson(`/kit/${name}.json`),fetchJson(`/kit/${name}.meta.json`)]);
 if(load!==assetLoad)return;[pack,meta]=loaded;
 $('title').textContent=pack.title;
 gardenSurface?.dispose();gardenSurface=meta.sourceScene?gardenGround():null;if(gardenSurface)scene.add(gardenSurface.group);
 filmButton.hidden=!meta.cannonTour;filmStatus.textContent='';
 const town=!!meta.sceneLayout,large=['district','small-town','outdoor'].includes(meta.buildingType);road.visible=!town;apron.visible=!town;ground.position.y=town?-.021:-.005;ground.scale.setScalar(large?4:1);controls.maxDistance=large?450:town?180:100;scene.fog=new THREE.Fog('#dce6e3',meta.preview?.fogNear??(large?280:town?160:90),meta.preview?.fogFar??(large?600:town?330:230));
 const shadowExtent=large?185:town?65:23;Object.assign(sun.shadow.camera,{left:-shadowExtent,right:shadowExtent,top:shadowExtent,bottom:-shadowExtent,far:large?550:town?200:90});sun.shadow.camera.updateProjectionMatrix();if(town)sun.position.set(large?-100:-55,large?180:85,large?-130:-60);camera.far=large?800:350;camera.updateProjectionMatrix();

 const s=pack.scenario,table=pack.defaults.solver.materials,groups=new Map(),hulls=new Map(),rotations=new Map();
 s.nodes.forEach((n:any,i:number)=>{let c=s.nodeColliders[i];if(c.kind==='shape')c=s.shapeLibrary[c.shape];let shape='box';if(c.kind!=='cuboid'){let h=hulls.get(c);if(!h){h=canonicalHull(c.points);hulls.set(c,h);}shape=h.key;rotations.set(i,h.rotation);c={kind:'convex_hull',points:h.points};}const key=`${n.m}:${shape}`;const list=groups.get(key)??{c,material:n.m,nodes:[]};list.nodes.push(i);groups.set(key,list);});
 for(const {c,material,nodes} of groups.values()){
  const spec=table[material],geo=c.kind==='cuboid'?buildBoxGeometry():buildHullGeometry(Float32Array.from(c.points));
  const anchors=new Float32Array(nodes.length*4),scales=new Float32Array(nodes.length*3);
  nodes.forEach((i:number,k:number)=>{const n=s.nodes[i],sz=s.nodeSizes[i],box=c.kind==='cuboid';anchors.set([n.centroid.x,n.centroid.y,n.centroid.z,layerCodeForMaterial(spec)],k*4);scales.set(box?[sz.x,sz.y,sz.z]:[1,1,1],k*3);});
  geo.setAttribute('cityAnchor',new THREE.InstancedBufferAttribute(anchors,4));geo.setAttribute('cityRestScale',new THREE.InstancedBufferAttribute(scales,3));
  const mat=spec.opacity!=null?new THREE.MeshPhysicalMaterial({color:spec.color,transparent:true,opacity:spec.opacity,roughness:spec.roughness??.08,metalness:0,side:THREE.FrontSide,depthWrite:false,envMapIntensity:.65}):new THREE.MeshStandardMaterial({color:spec.color,roughness:spec.textureKey?1:spec.roughness??.85,metalness:spec.metalness??0});
  if(spec.textureKey&&spec.opacity==null)applyCityTriplanar(mat,true,'full',true);
  const mesh=new THREE.InstancedMesh(geo,mat,nodes.length);mesh.castShadow=spec.opacity==null;mesh.receiveShadow=true;
  nodes.forEach((i:number,k:number)=>slots[i]={mesh,instance:k,scale:Array.from(scales.slice(k*3,k*3+3)),rotation:rotations.get(i)});scene.add(mesh);meshes.push(mesh);
 }
 if(meta.visuals){const assetMeta=meta;const response=await fetch(`/kit/${assetMeta.visuals.file}`);if(!response.ok)throw Error('Missing outdoor visual sidecar');const bytes=await response.arrayBuffer();const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(n=>n.toString(16).padStart(2,'0')).join('');if(load!==assetLoad)return;if(digest!==assetMeta.visuals.sha256)throw Error('Outdoor visual sidecar checksum mismatch');const layer=new OutdoorAttachments(scene);try{await layer.load(JSON.parse(new TextDecoder().decode(bytes)),assetMeta.assetSha256,s.nodes.length);}catch(e){layer.dispose();throw e;}if(load!==assetLoad){layer.dispose();return;}outdoor=layer;}
 resetPoses();const cams=meta.cameras??{hero:{position:[3,2.1,-3],target:[0,.6,0]},front:{position:[0,1.3,-3.5],target:[0,.6,0]},rear:{position:[3,2,3],target:[0,.5,0]}};meta.cameras=cams;
 $('camera').innerHTML=Object.keys(cams).map(k=>`<option>${k}</option>`).join('');setCamera(cams[query.get('camera')??'hero']??Object.values(cams)[0]);
 const hasReview=catalog.find(a=>a.name===name)?.recordings.some((r:any)=>r.available&&r.current&&r.passed);
 $('status').textContent=`${s.nodes.length.toLocaleString()} pieces · ${s.bonds.length.toLocaleString()} bonds\nGeometry: ${meta.validation?.passed?'passed':'requires review'}\nPhysics: ${hasReview?'select a measured review':'no current passing recording'}`;
 cannon.setAsset(name,meta,meshes);
 (window as any).__TOWN_KIT__.ready=true;
}
function seek(t:number){const before=followDebris?debrisCenter():null;time=t;if(t<lastSeek||lastSeek<0){outdoor?.resetEffects();resetPoses();cannon.pose(null);frameCursor=0;}if(recording)while(frameCursor<recording.frames.length){const f=recording.frames[frameCursor];if(f.time>t)break;frameCursor++;if('round' in f)cannon.pose(f.round);for(const [i,p] of f.poses)renderPose(i,p);for(const id of f.broken??[]){const b=pack.scenario.bonds[id];if(b){outdoor?.broken(b.node0,f.time);outdoor?.broken(b.node1,f.time);}}if(f.player){walker.position.fromArray(f.player);walker.visible=!followWalker;}}
 lastSeek=t;
 if(before){const delta=debrisCenter().sub(before);camera.position.add(delta);controls.target.add(delta);movePropLighting(delta);controls.update();}
 if(followWalker&&walker.position.length()){const delta=new THREE.Vector3().subVectors(walker.position,camera.position);delta.y=0;if(delta.length()>.03){controls.target.copy(walker.position).add(delta.normalize().multiplyScalar(2));controls.target.y=walker.position.y+.72;}camera.position.copy(walker.position).add(new THREE.Vector3(0,.72,0));controls.update();}
 $('timeline').value=String(time);$('time').textContent=`${Math.max(0,time-playbackStart).toFixed(2)} s`;
}
async function loadRecording(mode:string){const load=assetLoad,request=++recordingLoad;cannon.hide();playing=false;$('play').textContent='Play';if(!mode){$('recording').value='';$('error').textContent='';(window as any).__TOWN_KIT__.error=null;recording=null;time=0;playbackStart=0;lastSeek=-1;outdoor?.resetEffects();resetPoses();$('timeline').min='0';$('timeline').max='0';$('timeline').value='0';$('time').textContent='0.00 s';$('status').textContent=`Intact / authoring · ${pack.scenario.nodes.length} pieces`;return;}
 if(mode==='cannon'&&cannonRecording){installRecording(cannonRecording.r,cannonRecording.report,'Cannon shot');return;}
 const name=$('asset').value,base=`/kit/reviews/${name}-${mode}`;
 const entry=catalog.find(a=>a.name===name)?.recordings.find((r:any)=>r.mode===mode);
 if(entry&&!entry.current)throw Error('This recording is outdated. Run the native review for the current asset.');
 const [r,report]=await Promise.all([fetchJson(`${base}/recording.json`),fetchJson(`${base}/report.json`)]);
 if(load!==assetLoad||request!==recordingLoad)return;
 if(r.packHash!==meta.assetSha256)throw Error('Recording belongs to a different asset revision; run review again');
 $('recording').value=mode;installRecording(r,report,mode);
}
function installRecording(r:any,report:any,mode:string){
 activeReport=report;
 recording=r;lastSeek=-1;frameCursor=0;$('timeline').max=String(r.frames.at(-1)?.time??0);playbackStart=Math.max(0,(report.shots?.[0]?.tick??0)/60-.75);$('timeline').min=String(playbackStart);time=playbackStart;seek(time);$('status').textContent=`${report.passed?'PASS':'FAIL'} · ${mode}\n${report.error??'Native GPU review'}\n${report.destruction?.brokenBonds??report.stability?.brokenBonds??0} bonds broken`;
 if(mode==='Cannon shot')$('status').textContent=`Cannon shot · complete\n${report.destruction?.brokenBonds??0} bonds broken`;
 if(report.destruction?.treeFractures){const f=report.destruction.treeFractures;$('status').textContent+=`\nTrunk: ${f.trunk??0} · Branch: ${f.branch??0} · Root: ${f.root??0}`;}
}
async function exportCannonTour(){
 if(exporting||!meta?.cannonTour)return;
 filmButton.disabled=true;
 try{
  await loadRecording('cannon');
  const audit=await fetchJson(`/kit/reviews/${$('asset').value}-cannon/tour-check.json`);
  if(!activeReport?.passed||!audit.passed||audit.assetSha256!==meta.assetSha256)throw Error('The cannon tour has not passed every target check.');
  const tour=meta.cannonTour,chapters=tour.chapters,intro=6,duration=intro+chapters.at(-1).endTick/60+8;
  const base=activeReport.shots[0].tick/60-meta.shots.cannon[0].tick/60;
  const hero=meta.cameras.hero;
  playing=false;exporting=true;controls.enabled=false;
  renderer.setSize(1280,720,false);composer.setSize(1280,720);camera.aspect=1280/720;camera.updateProjectionMatrix();
  const saved=await recordTour({canvas:renderer.domElement,duration,progress:message=>{filmStatus.textContent=message;},render:seconds=>{
   const elapsed=Math.max(0,seconds-intro),tick=elapsed*60;
   const chapter=chapters.find((c:any)=>tick>=c.startTick&&tick<c.endTick)??chapters.find((c:any)=>tick<c.startTick);
   const finished=tick>=chapters.at(-1).endTick;
   seek(seconds<intro?0:base+elapsed);
   let pose=seconds<intro||finished?hero:chapter.camera;
   if(chapter&&['shade','street','ornamental'].includes(chapter.type)&&seconds>=intro&&!finished){
    const target=new THREE.Vector3().fromArray(pose.target),position=new THREE.Vector3().fromArray(pose.position);position.sub(target).multiplyScalar(1.5).add(target);pose={position:position.toArray(),target:pose.target};
   }
   setCamera(pose);outdoor?.update(camera,seconds,time);for(const mesh of boundsDirty)mesh.computeBoundingSphere();boundsDirty.clear();composer.render();
   return seconds<intro?{title:pack.title,subtitle:'Six furnished buildings · gardens, market, bus stop and workshop yard'}:finished?{title:'A lived-in town. A destructible world.',subtitle:`${audit.results.length} cannon targets verified · real fractured chunks and moving debris`}:{title:chapter.title.replace(/^./,(c:string)=>c.toUpperCase()),subtitle:`${chapter.zone} · ${chapter.shot.mass.toLocaleString()} kg at ${chapter.shot.speed} m/s · ${chapters.indexOf(chapter)+1} / ${chapters.length}`};
  }});
  filmStatus.replaceChildren(document.createTextNode('Film saved: '));const link=document.createElement('a');link.href=saved.url;link.textContent=saved.file;filmStatus.append(link);
 }finally{
  exporting=false;filmButton.disabled=false;controls.enabled=true;renderer.setSize(innerWidth,innerHeight);composer.setSize(innerWidth,innerHeight);camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();
 }
}
function fail(e:any){$('error').textContent=e.message??String(e);console.error(e);(window as any).__TOWN_KIT__.error=String(e);}
(window as any).__TOWN_KIT__={ready:false,error:null,setCamera,seek,loadRecording,damageCameras,frameFragments,trackFragments,followWalker:(value:boolean)=>{followWalker=value;if(value)trackFragments(false);walker.visible=!value;},stats:()=>({finish:finishName,finishTuning:finishPresets[finishName],kind:meta?.kind,outdoor:outdoor?.stats(),render:renderer.info.render,memory:renderer.info.memory,chunks:pack?.scenario.nodes.length,cameras:meta?.cameras,hash:meta?.assetSha256,webglError:renderer.getContext().getError()}),screenshot:()=>renderer.domElement.toDataURL('image/png')};
$('frame').onclick=frameFragments;$('track').onclick=()=>trackFragments(!followDebris);
$('asset').value=query.get('asset')??'victorian-corner';$('asset').onchange=()=>loadAsset($('asset').value).catch(fail);$('camera').onchange=()=>setCamera(meta.cameras[$('camera').value]);$('recording').onchange=()=>loadRecording($('recording').value).catch(fail);$('play').onclick=()=>{if(!recording)return;playing=!playing;$('play').textContent=playing?'Pause':'Play';};$('reset').onclick=()=>{playing=false;$('play').textContent='Play';seek(playbackStart);};$('timeline').oninput=()=>{playing=false;$('play').textContent='Play';seek(Number($('timeline').value));};$('cut').onclick=()=>{cutaway=!cutaway;lastSeek=-1;seek(time);};
async function start(){
 catalog=(await fetchJson('/kit/catalog.json')).assets;
 const names=new Set(catalog.map(a=>a.name)),ordered=Array.from(($('asset') as HTMLSelectElement).options).map(o=>o.value).filter(n=>names.has(n));
 for(const {name}of catalog)if(!ordered.includes(name))ordered.push(name);
 $('asset').replaceChildren(...ordered.map(name=>new Option(name,name)));$('asset').disabled=false;
 const name=query.get('asset')??(names.has('outdoor-gallery')?'outdoor-gallery':ordered[0]);
 if(!name||!names.has(name))throw Error(`Asset ${name??''} is not built. Choose an available asset from the menu.`);
 $('asset').value=name;await loadAsset(name);if(query.get('recording'))await loadRecording(query.get('recording')!);
}
loadCityTextures();start().catch(fail);
let last=performance.now();function animate(now:number){requestAnimationFrame(animate);const dt=Math.min((now-last)/1000,.1);last=now;if(exporting)return;controls.update();cannon.update();if(playing&&recording){seek(Math.min(time+dt,Number($('timeline').max)));if(time>=Number($('timeline').max)){playing=false;$('play').textContent='Play';}}outdoor?.update(camera,now/1000,time);for(const mesh of boundsDirty)mesh.computeBoundingSphere();boundsDirty.clear();renderer.info.reset();composer.render();}requestAnimationFrame(animate);
addEventListener('resize',()=>{if(exporting)return;camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);composer.setSize(innerWidth,innerHeight);});
