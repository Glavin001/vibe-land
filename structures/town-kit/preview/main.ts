import * as THREE from 'three';
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
const query=new URLSearchParams(location.search);if(query.has('clean'))document.body.classList.add('clean');
const finishName=(query.get('finish')??'fine') as keyof typeof finishPresets;
if(!finishPresets[finishName])throw Error('Unknown finish preset');
setCityTextureTuning(finishPresets[finishName]);
const renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});renderer.setPixelRatio(1);renderer.setSize(innerWidth,innerHeight);renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.0;document.body.prepend(renderer.domElement);
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
let followWalker=false,followDebris=false,frameCursor=0,lastSeek=-1;
let livePositions:number[][]=[];
let pack:any,meta:any,slots:any[]=[],meshes:THREE.InstancedMesh[]=[],recording:any=null,playing=false,time=0,cutaway=false;
const composer=new EffectComposer(renderer);composer.addPass(new RenderPass(scene,camera));const oldRandom=Math.random;let noiseSeed=271828;Math.random=()=>{noiseSeed=(1664525*noiseSeed+1013904223)>>>0;return noiseSeed/4294967296;};const ao=new SSAOPass(scene,camera,innerWidth,innerHeight);Math.random=oldRandom;ao.kernelRadius=.35;ao.minDistance=.002;ao.maxDistance=.035;composer.addPass(ao);composer.addPass(new OutputPass());
const matrix=new THREE.Matrix4(),pos=new THREE.Vector3(),rot=new THREE.Quaternion(),scale=new THREE.Vector3();
const cutTypes=new Set(['roof','gable','ridge-beam','eave-plate','gable-plate','ceiling']);
function renderPose(i:number,p:number[]) {livePositions[i]=p.slice(0,3);const slot=slots[i];pos.fromArray(p);rot.fromArray(p,3);scale.fromArray(slot.scale);if(cutaway&&cutTypes.has(pack.scenario.nodeTypes[i]))scale.set(0,0,0);matrix.compose(pos,rot,scale);slot.mesh.setMatrixAt(slot.instance,matrix);slot.mesh.instanceMatrix.needsUpdate=true;}
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
 const target=box.getCenter(new THREE.Vector3()),distance=Math.max(3.4,box.getSize(new THREE.Vector3()).length()/2/Math.sin(24*Math.PI/180)*1.12);
 return Object.fromEntries(Object.entries({hero:[1,.7,-1],front:[0,.35,-1],rear:[1,.6,1]}).map(([name,direction])=>[name,{position:target.clone().addScaledVector(new THREE.Vector3().fromArray(direction).normalize(),distance).toArray(),target:target.toArray()}]));
}
function movePropLighting(delta:THREE.Vector3){if(meta.kind!=='prop')return;sun.position.add(delta);sun.target.position.add(delta);sun.target.updateMatrixWorld();}
function frameFragments(){const pose=damageCameras().hero;setCamera(pose);if(meta.kind==='prop'){const delta=new THREE.Vector3().fromArray(pose.target).sub(sun.target.position);movePropLighting(delta);}}
function trackFragments(value:boolean){followDebris=value;if(value)followWalker=false;$('track').textContent=value?'Stop tracking':'Track fragments';}
async function loadAsset(name:string){
 $('error').textContent='';(window as any).__TOWN_KIT__.ready=false;(window as any).__TOWN_KIT__.error=null;recording=null;time=0;playing=false;walker.visible=false;frameCursor=0;lastSeek=-1;followWalker=false;trackFragments(false);livePositions=[];sun.position.set(-18,30,-20);sun.target.position.set(0,0,0);sun.target.updateMatrixWorld();
 for(const mesh of meshes){scene.remove(mesh);mesh.geometry.dispose();(mesh.material as THREE.Material).dispose();}meshes=[];slots=[];
 [pack,meta]=await Promise.all([fetch(`/kit/${name}.json`).then(r=>{if(!r.ok)throw Error(`Asset ${name} is not built`);return r.json();}),fetch(`/kit/${name}.meta.json`).then(r=>r.json())]);
 $('title').textContent=pack.title;
 const town=!!meta.sceneLayout,large=['district','small-town'].includes(meta.buildingType);road.visible=!town;apron.visible=!town;ground.position.y=town?-.021:-.005;ground.scale.setScalar(large?4:1);controls.maxDistance=large?450:town?180:100;scene.fog=new THREE.Fog('#dce6e3',meta.preview?.fogNear??(large?280:town?160:90),meta.preview?.fogFar??(large?600:town?330:230));
 const shadowExtent=large?185:town?65:23;Object.assign(sun.shadow.camera,{left:-shadowExtent,right:shadowExtent,top:shadowExtent,bottom:-shadowExtent,far:large?550:town?200:90});sun.shadow.camera.updateProjectionMatrix();if(town)sun.position.set(large?-100:-55,large?180:85,large?-130:-60);camera.far=large?800:350;camera.updateProjectionMatrix();

 const s=pack.scenario,table=pack.defaults.solver.materials,groups=new Map();
 s.nodes.forEach((n:any,i:number)=>{let c=s.nodeColliders[i];if(c.kind==='shape')c=s.shapeLibrary[c.shape];const key=`${n.m}:${c.kind==='cuboid'?'box':JSON.stringify(c.points)}`;const list=groups.get(key)??{c,material:n.m,nodes:[]};list.nodes.push(i);groups.set(key,list);});
 for(const {c,material,nodes} of groups.values()){
  const spec=table[material],geo=c.kind==='cuboid'?buildBoxGeometry():buildHullGeometry(Float32Array.from(c.points));
  const anchors=new Float32Array(nodes.length*4),scales=new Float32Array(nodes.length*3);
  nodes.forEach((i:number,k:number)=>{const n=s.nodes[i],sz=s.nodeSizes[i],box=c.kind==='cuboid';anchors.set([n.centroid.x,n.centroid.y,n.centroid.z,layerCodeForMaterial(spec)],k*4);scales.set(box?[sz.x,sz.y,sz.z]:[1,1,1],k*3);});
  geo.setAttribute('cityAnchor',new THREE.InstancedBufferAttribute(anchors,4));geo.setAttribute('cityRestScale',new THREE.InstancedBufferAttribute(scales,3));
  const mat=spec.opacity!=null?new THREE.MeshPhysicalMaterial({color:spec.color,transparent:true,opacity:spec.opacity,roughness:spec.roughness??.08,metalness:0,side:THREE.FrontSide,depthWrite:false,envMapIntensity:.65}):new THREE.MeshStandardMaterial({color:spec.color,roughness:spec.textureKey?1:spec.roughness??.85,metalness:spec.metalness??0});
  if(spec.textureKey&&spec.opacity==null)applyCityTriplanar(mat,true,'full',true);
  const mesh=new THREE.InstancedMesh(geo,mat,nodes.length);mesh.castShadow=spec.opacity==null;mesh.receiveShadow=true;mesh.frustumCulled=false;
  nodes.forEach((i:number,k:number)=>slots[i]={mesh,instance:k,scale:Array.from(scales.slice(k*3,k*3+3))});scene.add(mesh);meshes.push(mesh);
 }
 resetPoses();const cams=meta.cameras??{hero:{position:[3,2.1,-3],target:[0,.6,0]},front:{position:[0,1.3,-3.5],target:[0,.6,0]},rear:{position:[3,2,3],target:[0,.5,0]}};meta.cameras=cams;
 $('camera').innerHTML=Object.keys(cams).map(k=>`<option>${k}</option>`).join('');setCamera(cams[query.get('camera')??'hero']??Object.values(cams)[0]);
 $('status').textContent=`${s.nodes.length.toLocaleString()} pieces · ${s.bonds.length.toLocaleString()} bonds\nGeometry: ${meta.validation?.passed?'passed':'requires review'}\nPhysics: select a measured review`;
 (window as any).__TOWN_KIT__.ready=true;
}
function seek(t:number){const before=followDebris?debrisCenter():null;time=t;if(t<lastSeek||lastSeek<0){resetPoses();frameCursor=0;}if(recording)while(frameCursor<recording.frames.length){const f=recording.frames[frameCursor];if(f.time>t)break;frameCursor++;for(const [i,p] of f.poses)renderPose(i,p);if(f.player){walker.position.fromArray(f.player);walker.visible=!followWalker;}}
 lastSeek=t;
 if(before){const delta=debrisCenter().sub(before);camera.position.add(delta);controls.target.add(delta);movePropLighting(delta);controls.update();}
 if(followWalker&&walker.position.length()){const delta=new THREE.Vector3().subVectors(walker.position,camera.position);delta.y=0;if(delta.length()>.03){controls.target.copy(walker.position).add(delta.normalize().multiplyScalar(2));controls.target.y=walker.position.y+.72;}camera.position.copy(walker.position).add(new THREE.Vector3(0,.72,0));controls.update();}
 $('timeline').value=String(time);$('time').textContent=`${time.toFixed(2)} s`;
}
async function loadRecording(mode:string){if(!mode){recording=null;resetPoses();return;}
 const name=$('asset').value,base=`/kit/reviews/${name}-${mode}`;
 const [r,report]=await Promise.all([fetch(`${base}/recording.json`).then(r=>{if(!r.ok)throw Error('Run this native review before playback');return r.json();}),fetch(`${base}/report.json`).then(r=>r.json())]);
 if(r.packHash!==meta.assetSha256)throw Error('Recording belongs to a different asset revision; run review again');
 recording=r;lastSeek=-1;frameCursor=0;$('timeline').max=String(r.frames.at(-1)?.time??0);time=0;seek(0);$('status').textContent=`${report.passed?'PASS':'FAIL'} · ${mode}\n${report.error??'Native GPU review'}\n${report.destruction?.brokenBonds??report.stability?.brokenBonds??0} bonds broken`;
}
function fail(e:any){$('error').textContent=e.message??String(e);console.error(e);(window as any).__TOWN_KIT__.error=String(e);}
(window as any).__TOWN_KIT__={ready:false,error:null,setCamera,seek,loadRecording,damageCameras,frameFragments,trackFragments,followWalker:(value:boolean)=>{followWalker=value;if(value)trackFragments(false);walker.visible=!value;},stats:()=>({finish:finishName,finishTuning:finishPresets[finishName],kind:meta?.kind,chunks:pack?.scenario.nodes.length,cameras:meta?.cameras,hash:meta?.assetSha256,webglError:renderer.getContext().getError()}),screenshot:()=>renderer.domElement.toDataURL('image/png')};
if(query.get('asset')&&!Array.from($('asset').options).some((o:any)=>o.value===query.get('asset')))$('asset').add(new Option(query.get('asset')!,query.get('asset')!));
$('frame').onclick=frameFragments;$('track').onclick=()=>trackFragments(!followDebris);
$('asset').value=query.get('asset')??'victorian-corner';$('asset').onchange=()=>loadAsset($('asset').value).catch(fail);$('camera').onchange=()=>setCamera(meta.cameras[$('camera').value]);$('recording').onchange=()=>loadRecording($('recording').value).catch(fail);$('play').onclick=()=>{playing=!playing;$('play').textContent=playing?'Pause':'Play';};$('reset').onclick=()=>{playing=false;seek(0);};$('timeline').oninput=()=>{playing=false;seek(Number($('timeline').value));};$('cut').onclick=()=>{cutaway=!cutaway;lastSeek=-1;seek(time);};
loadCityTextures();loadAsset($('asset').value).then(()=>{if(query.get('recording'))return loadRecording(query.get('recording')!);}).catch(fail);
let last=performance.now();function animate(now:number){requestAnimationFrame(animate);const dt=Math.min((now-last)/1000,.1);last=now;controls.update();if(playing&&recording){seek(Math.min(time+dt,Number($('timeline').max)));if(time>=Number($('timeline').max))playing=false;}composer.render();}requestAnimationFrame(animate);
addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);composer.setSize(innerWidth,innerHeight);});
