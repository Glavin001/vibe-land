import * as THREE from 'three';
import {OutdoorAttachments,type OutdoorVisuals} from './outdoorAttachments';
import type {CityPoseStore} from '../city/cityPoseStore';
import type {CityTopology} from '../city/topology';
import {resolveMultiplayerBackend} from '../app/runtimeConfig';
import {updateTownKitStatus} from '../city/townKitState';

type LiveVisuals=OutdoorVisuals&{manifestHash:string;nodeCount:number;title?:string;description?:string;assetCount?:number;labels:{title:string;position:[number,number,number]}[]};
/** Reads the SAME composed poses used by CityChunksLayer's GPU geometry. */
export class CityOutdoorLayer {
 private root=new THREE.Group();private layer:OutdoorAttachments;
 private abort=new AbortController();private disposed=false;private ready=false;
 private owners:number[]=[];private previous=new Map<number,Float32Array>();
 private bodies=new Map<number,number>();private brokenCount:number|null=null;
 private pose=new Float32Array(7);private labels:THREE.Sprite[]=[];
 constructor(parent:THREE.Group,hash:string,chunks:number){
  parent.add(this.root);this.layer=new OutdoorAttachments(this.root);
  updateTownKitStatus({ready:false,assets:0,attachments:0,error:null});
  void this.load(hash,chunks).catch(error=>{if(!this.disposed)updateTownKitStatus({ready:false,assets:0,attachments:0,error:String(error.message??error)});});
 }
 private async load(hash:string,chunks:number){
  const response=await fetch(`${resolveMultiplayerBackend().httpOrigin}/city-visuals/${hash}`,{signal:this.abort.signal,cache:'no-store'});
  const data=await response.json() as LiveVisuals&{error?:string};
  if(!response.ok)throw Error(data.error??'Town-kit details could not load.');
  if(data.manifestHash!==hash||data.nodeCount!==chunks)throw Error('Town-kit details do not match the live physics scene.');
  await this.layer.load(data,data.physicsSha256,chunks);
  if(this.disposed){this.layer.dispose();return;}
  this.owners=[...new Set(data.attachments.map(a=>a.owner))];
  for(const label of data.labels){
   const canvas=document.createElement('canvas');canvas.width=512;canvas.height=96;
   const ctx=canvas.getContext('2d')!;ctx.fillStyle='#18362edc';ctx.fillRect(0,0,512,96);ctx.font='500 30px system-ui';ctx.fillStyle='#f5f0d9';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(label.title,256,48,480);
   const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;
   const sprite=new THREE.Sprite(new THREE.SpriteMaterial({map:texture,depthTest:true,depthWrite:false}));sprite.position.fromArray(label.position);sprite.scale.set(1.8,.34,1);this.root.add(sprite);this.labels.push(sprite);
  }
  this.ready=true;updateTownKitStatus({ready:true,assets:data.assetCount??data.labels.length,attachments:data.attachments.length,error:null,title:data.title,description:data.description});
 }
 update(poses:CityPoseStore,camera:THREE.Camera,seconds:number,topology:CityTopology){
  if(!this.ready)return;
  const broken=topology.brokenBondCount(),fractured=this.brokenCount!==null&&broken>this.brokenCount;
  if(this.brokenCount!==null&&broken<this.brokenCount){this.layer.resetEffects();this.bodies.clear();}
  this.brokenCount=broken;
  for(const owner of this.owners){
   if(!poses.chunkWorldPoseInto(owner,this.pose)){this.pose.set([0,-10000,0,0,0,0,1]);}
   const before=this.previous.get(owner);
   const body=topology.chunkBodyKey(owner),previousBody=this.bodies.get(owner);this.bodies.set(owner,body);
   // A server-reported fracture that changes this limb's island sheds a few
   // cosmetic leaves. Mere wind, camera movement and initial loading cannot.
   const shed=fractured&&previousBody!==undefined&&previousBody!==body;
   if(shed)this.layer.broken(owner,seconds);
   if(before&&this.pose.every((v,i)=>Math.abs(v-before[i])<1e-6))continue;
   const pose=before??new Float32Array(7);pose.set(this.pose);this.previous.set(owner,pose);this.layer.setPose(owner,pose);
  }
  this.layer.update(camera,seconds,seconds);
  for(const label of this.labels)label.visible=label.position.distanceToSquared(camera.position)<50*50;
 }
 dispose(){this.disposed=true;this.abort.abort();this.root.removeFromParent();this.layer.dispose();for(const label of this.labels){label.material.map?.dispose();label.material.dispose();}this.labels=[];}
}
