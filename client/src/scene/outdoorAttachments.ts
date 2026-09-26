import * as THREE from 'three';
import {animateOutdoorMaterial,OUTDOOR_WIND_MARGIN} from './outdoorWind';

type VisualMesh={positions:number[];normals:number[];uvs:number[];indices:number[];material:{color:string;texture?:'oak'|'pine';foliage?:boolean;wind?:boolean;windHeight?:number}};
type Attachment={owner:number;matrix:number[];cell?:[number,number];levels:{distance:number;meshes:string[]}[]};
export type OutdoorVisuals={version:number;physicsSha256:string;meshes:Record<string,VisualMesh>;attachments:Attachment[]};
type Slot={mesh:THREE.InstancedMesh;index:number};

/** Visual detail consumes authoritative chunk poses; it owns no physical bodies. */
export class OutdoorAttachments {
 private meshes:THREE.InstancedMesh[]=[];
 private textures:THREE.Texture[]=[];
 private geometries=new Set<THREE.BufferGeometry>();
 private materials=new Set<THREE.Material>();
 private owners=new Map<number,number[]>();
 private poses=new Map<number,THREE.Matrix4>();
 private entries:{owner:number;local:THREE.Matrix4;world:THREE.Matrix4;tint:THREE.Color;levels:Attachment['levels'];slots:Slot[][];lod:number;dirty:boolean}[]=[];
 private clock={value:0};
 private rotation=new THREE.Quaternion();
 private scale=new THREE.Vector3(1,1,1);
 private point=new THREE.Vector3();
 private effects: {position:THREE.Vector3;velocity:THREE.Vector3;born:number}[]=[];
 private dustGeometry=new THREE.BufferGeometry();
 private dust:THREE.Points;
 private particlePositions=new Float32Array(256*3);

 constructor(private scene:THREE.Object3D){
  this.dustGeometry.setAttribute('position',new THREE.BufferAttribute(this.particlePositions,3));this.dustGeometry.setDrawRange(0,0);
  this.dust=new THREE.Points(this.dustGeometry,new THREE.PointsMaterial({color:'#89975d',size:.055,depthWrite:false}));this.dust.frustumCulled=false;scene.add(this.dust);
 }
 async load(data:OutdoorVisuals,hash:string,nodeCount:number){
  if(data.version!==1||data.physicsSha256!==hash)throw Error('Outdoor visuals belong to a different physics asset');
  const textureMap=new Map<string,THREE.Texture>();
  for(const kind of ['oak','pine'] as const){
   if(!Object.values(data.meshes).some(m=>m.material.texture===kind))continue;
   const url=kind==='oak'?new URL('../../../structures/town-kit/vendor/ez-tree/textures/oak.png',import.meta.url):new URL('../../../structures/town-kit/vendor/ez-tree/textures/pine.png',import.meta.url);
   const texture=await new THREE.TextureLoader().loadAsync(url.href);texture.colorSpace=THREE.SRGBColorSpace;textureMap.set(kind,texture);this.textures.push(texture);
  }
  const groups=new Map<string,{id:string;uses:{entry:number;lod:number}[]}>();
  for(const a of data.attachments){
   if(!Number.isInteger(a.owner)||a.owner<0||a.owner>=nodeCount||a.matrix.length!==16||!a.matrix.every(Number.isFinite)||a.levels.length!==3)throw Error('Invalid outdoor attachment');
   if(a.cell&&(a.cell.length!==2||!a.cell.every(Number.isSafeInteger)))throw Error('Invalid outdoor cell');
   const tone=(Math.sin(a.owner*12.9898+a.matrix[12]*78.233)*43758.5453)%1;
   const entry=this.entries.length;this.entries.push({owner:a.owner,local:new THREE.Matrix4().fromArray(a.matrix),world:new THREE.Matrix4(),tint:new THREE.Color().setRGB(.96+tone*.045,1+tone*.035,.94+tone*.035),levels:a.levels,slots:[[],[],[]],lod:-1,dirty:true});
   const owned=this.owners.get(a.owner)??[];owned.push(entry);this.owners.set(a.owner,owned);
   a.levels.forEach((level,lod)=>level.meshes.forEach(id=>{if(!data.meshes[id])throw Error(`Missing outdoor mesh ${id}`);const key=`${id}@${a.cell?.join(',')??'legacy'}`,group=groups.get(key)??{id,uses:[]};group.uses.push({entry,lod});groups.set(key,group);}));
  }
  const templates=new Map<string,{geo:THREE.BufferGeometry;mat:THREE.MeshStandardMaterial;depth:THREE.MeshDepthMaterial;distance:THREE.MeshDistanceMaterial}>();
  for(const {id,uses}of groups.values()){
   let template=templates.get(id);
   if(!template){
   const spec=data.meshes[id],geo=new THREE.BufferGeometry();
   geo.setAttribute('position',new THREE.Float32BufferAttribute(spec.positions,3));geo.setAttribute('normal',new THREE.Float32BufferAttribute(spec.normals,3));geo.setAttribute('uv',new THREE.Float32BufferAttribute(spec.uvs,2));geo.setIndex(spec.indices);geo.computeBoundingSphere();geo.computeBoundingBox();
   const foliage=!!spec.material.foliage,texture=spec.material.texture?textureMap.get(spec.material.texture):undefined;
   const mat=new THREE.MeshStandardMaterial({color:spec.material.color,map:texture??null,alphaTest:foliage?.35:0,side:foliage?THREE.DoubleSide:THREE.FrontSide,roughness:.95});
   const shadow={map:texture??null,alphaTest:foliage?.35:0,side:mat.side};
   const depth=new THREE.MeshDepthMaterial({...shadow,depthPacking:THREE.RGBADepthPacking});
   const distance=new THREE.MeshDistanceMaterial(shadow);
   if(spec.material.wind||foliage){
    const height=spec.material.windHeight??geo.boundingBox!.max.y;
    for(const material of [mat,depth,distance])animateOutdoorMaterial(material,this.clock,height,foliage);
    geo.boundingBox!.expandByScalar(OUTDOOR_WIND_MARGIN);geo.boundingSphere!.radius+=OUTDOOR_WIND_MARGIN;
   }
   this.geometries.add(geo);for(const material of [mat,depth,distance])this.materials.add(material);
   template={geo,mat,depth,distance};templates.set(id,template);
   }
   const {geo,mat,depth,distance}=template;
   const mesh=new THREE.InstancedMesh(geo,mat,uses.length);mesh.frustumCulled=true;mesh.castShadow=true;mesh.receiveShadow=true;mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
   mesh.customDepthMaterial=depth;mesh.customDistanceMaterial=distance;
   uses.forEach(({entry,lod},index)=>{this.entries[entry].slots[lod].push({mesh,index});});mesh.count=0;this.meshes.push(mesh);this.scene.add(mesh);
  }
 }
 setPose(owner:number,pose:ArrayLike<number>){
  const entries=this.owners.get(owner);if(!entries)return;
  const matrix=this.poses.get(owner)??new THREE.Matrix4();matrix.compose(this.point.set(pose[0],pose[1],pose[2]),this.rotation.set(pose[3],pose[4],pose[5],pose[6]),this.scale);this.poses.set(owner,matrix);
  for(const i of entries)this.entries[i].dirty=true;
 }
 update(camera:THREE.Camera,seconds:number,playbackTime:number){
  this.clock.value=seconds;
  let changed=false;
  for(const entry of this.entries){
   const pose=this.poses.get(entry.owner);if(!pose)continue;
   if(entry.dirty)entry.world.multiplyMatrices(pose,entry.local);this.point.setFromMatrixPosition(entry.world);
   const distance=this.point.distanceTo(camera.position);let lod=entry.lod<0?0:entry.lod;
   while(lod<2&&distance>entry.levels[lod+1].distance*1.06)lod++;
   while(lod>0&&distance<entry.levels[lod].distance*.94)lod--;
   if(!entry.dirty&&entry.lod===lod)continue;
   changed=true;entry.lod=lod;entry.dirty=false;
  }
  // Compact active instances. Zero-scaled hidden LODs still execute their vertex
  // shaders; reducing mesh.count makes distant detail genuinely cheaper.
  if(changed){
   for(const mesh of this.meshes)mesh.count=0;
   for(const entry of this.entries)if(entry.lod>=0)for(const slot of entry.slots[entry.lod]){const index=slot.mesh.count++;slot.mesh.setMatrixAt(index,entry.world);slot.mesh.setColorAt(index,entry.tint);}
   for(const mesh of this.meshes){
    mesh.instanceMatrix.needsUpdate=true;if(mesh.instanceColor)mesh.instanceColor.needsUpdate=true;
    // Debris can leave its original cell. Refit after every pose/LOD change,
    // including wind padding, so both camera and shadow culling stay correct.
    mesh.computeBoundingSphere();
   }
  }
  this.effects=this.effects.filter(e=>playbackTime-e.born<2.5&&playbackTime>=e.born);
  this.effects.forEach((e,i)=>{const age=playbackTime-e.born;this.point.copy(e.position).addScaledVector(e.velocity,age);this.point.y-=1.5*age*age;this.particlePositions.set(this.point.toArray(),i*3);});
  this.dustGeometry.setDrawRange(0,this.effects.length);this.dustGeometry.attributes.position.needsUpdate=true;
 }
 broken(owner:number,time:number){
  const pose=this.poses.get(owner);if(!pose)return;
  const position=new THREE.Vector3().setFromMatrixPosition(pose);
  for(let i=0;i<12;i++){if(this.effects.length>=256)this.effects.shift();const angle=(i+owner)*2.399;this.effects.push({position:position.clone(),velocity:new THREE.Vector3(Math.cos(angle)*.8,.5+(i%3)*.3,Math.sin(angle)*.8),born:time});}
 }
 resetEffects(){this.effects=[];this.dustGeometry.setDrawRange(0,0);}
 expandBounds(bounds:THREE.Box3){for(const entry of this.entries){const pose=this.poses.get(entry.owner);if(!pose)continue;const transform=new THREE.Matrix4().multiplyMatrices(pose,entry.local);for(const slot of entry.slots[0])if(slot.mesh.geometry.boundingBox)bounds.union(slot.mesh.geometry.boundingBox.clone().applyMatrix4(transform));}}
 stats(){return {attachments:this.entries.length,meshBatches:this.meshes.length,activeBatches:this.meshes.filter(m=>m.count>0).length,uniqueGeometries:this.geometries.size,activeParticles:this.effects.length,lods:[0,1,2].map(l=>this.entries.filter(e=>e.lod===l).length),triangles:[...this.geometries].reduce((n,g)=>n+(g.index?.count??0)/3,0),activeTriangles:this.meshes.reduce((n,m)=>n+m.count*(m.geometry.index?.count??0)/3,0)};}
 dispose(){for(const mesh of this.meshes){this.scene.remove(mesh);mesh.dispose();}for(const geo of this.geometries)geo.dispose();for(const material of this.materials)material.dispose();for(const texture of this.textures)texture.dispose();this.scene.remove(this.dust);this.dustGeometry.dispose();(this.dust.material as THREE.Material).dispose();}
}
