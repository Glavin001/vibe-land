import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Vector3 } from 'three';
import type { CityClient } from '../city/cityClient';
import type { LedgerBody } from '../city/topology';
import type { ManifestStructure } from '../city/manifest';
import type { DynamicBodyStateMeters, VehicleStateMeters } from '../net/protocol';
import { currentMeteorFlights, meteorDrawn } from '../vfx/meteorFlights';
import { destructionAudio, installAudioLifecycle } from './engine';
import { contactEntityId, contactEntityParts, drainAudioContacts, hasRecentAudioContacts, resetAudioContacts } from './contactStream';
import { acousticMaterial, clamp, distance, type AcousticMaterial, type SoundEvent, type Vec3 } from './model';
import { SoundMotionTracker } from './motion';
import { AcousticOcclusion, type AcousticRaycast } from './occlusion';
import { contactPresentationTime, soundFromDestruction } from './gameEvents';
import { audioSettings } from './settings';

interface AudioWorld {
  state:{dynamicBodies:Map<number,DynamicBodyStateMeters>;dynamicBodyInterpolationDelayMs?:number};
  vehicles?:Map<number,VehicleStateMeters>;
  getRenderedDynamicBodyState(id:number):DynamicBodyStateMeters|null;
  raycastScene?:AcousticRaycast;
}
interface Props {
  getRuntime:()=>AudioWorld|null;
  getCityClient:()=>CityClient|null;
  isPlaying?:()=>boolean;
  getNowMs?:()=>number;
}

/** Binds rendered poses and semantic events to the audio API. No audio nodes
 * are created per contact; the director budgets those later in the frame. */
export function GameAudioLayer({getRuntime,getCityClient,isPlaying,getNowMs}:Props):null {
  const {camera}=useThree();
  const state=useRef({city:null as CityClient|null,world:null as AudioWorld|null,
    structures:new Map<number,ManifestStructure>(),motion:new SoundMotionTracker(),
    listener:[0,0,0] as Vec3,occlusion:null as AcousticOcclusion|null,
    forward:new Vector3(),up:new Vector3(),lastTime:-Infinity,paused:false,motionBudget:0,epoch:-1,
    meteorPrevious:new Map<number,{position:Vec3;at:number}>()});
  useEffect(()=>{
    const remove=installAudioLifecycle();
    return ()=>{state.current.city?.observeAudio(false);resetAudioContacts();remove();};
  },[]);
  useFrame(()=>{
    const s=state.current,engine=destructionAudio(),now=performance.now(),world=getRuntime(),city=getCityClient();
    const enabled=audioSettings().enabled&&engine.context?.state==='running'&&!document.hidden&&(!isPlaying||isPlaying());
    const timeline=getNowMs?.()??now;
    const contactNow=timeline;
    s.listener=[camera.position.x,camera.position.y,camera.position.z];
    camera.getWorldDirection(s.forward);s.up.set(0,1,0).applyQuaternion(camera.quaternion);
    engine.setListener(s.listener,[s.forward.x,s.forward.y,s.forward.z],[s.up.x,s.up.y,s.up.z]);
    const materialAt=(index:number):AcousticMaterial=>{const a=city?.manifest.manifest.materialAppearance?.[index];return acousticMaterial(a?.name,a?.metalness);};
    const bodyMaterial=(body:LedgerBody):AcousticMaterial=>{
      const slot=body.chunkSlots[0],node=slot===undefined?undefined:city?.topology.chunkNode(slot);
      const structure=s.structures.get(body.structureId);
      return materialAt(node===undefined?0:structure?.chunks[node]?.material??0);
    };
    const emit=(event:SoundEvent)=>{
      event.occlusion=s.occlusion?.sample(s.listener,event.position,now)??0;
      engine.emit(event);
    };
    if(city!==s.city){
      s.city?.observeAudio(false);s.city=city;s.motion.clear();s.structures.clear();
      for(const structure of city?.manifest.manifest.structures??[])s.structures.set(structure.structureId,structure);
    }
    if(world!==s.world){
      s.world=world;engine.stop();s.motion.clear();s.meteorPrevious.clear();
      s.occlusion=world?.raycastScene?new AcousticOcclusion((o,d,m)=>world.raycastScene!(o,d,m)):null;
    }
    if(timeline<s.lastTime||s.epoch!==(city?.ledgerEpoch()??-1)){engine.stop();s.motion.clear();s.meteorPrevious.clear();if(timeline<s.lastTime)resetAudioContacts();}
    s.epoch=city?.ledgerEpoch()??-1;
    s.lastTime=timeline;
    // City pose callbacks run in the preceding visual layer. Set the callback
    // once per frame with current camera state; bound tracking to nearby bodies.
    city?.observeAudio(enabled,(key,body,tick,x,y,z,vx,vy,vz,mass,radius,atMs)=>{
      const dx=x-s.listener[0],dy=y-s.listener[1],dz=z-s.listener[2];
      if(dx*dx+dy*dy+dz*dz>120*120||s.motionBudget++>=256)return;
      s.motion.note({id:`city:${key}`,position:[x,y,z],velocity:[vx,vy,vz],nowMs:atMs,sampleTimeMs:tick*1000/city.audioTickRate(),
        // All-body city impacts arrive through the validated source queue.
        // This smaller nearby motion budget is only for swept near misses.
        material:bodyMaterial(body),mass,size:radius,impacts:false},s.listener,emit);
    });
    s.motionBudget=0;
    if(!enabled){if(!s.paused){engine.stop();s.motion.clear();s.meteorPrevious.clear();}s.paused=true;drainAudioContacts(contactNow);return;}
    s.paused=false;
    city?.drainAudioSources((source,impact)=>{
      if(impact&&hasRecentAudioContacts(contactNow,impact.entityId))return;
      const event=soundFromDestruction(source,materialAt(impact?.material??source.material),impact);
      if(event){
        if(impact)event.protected=impact.mass>=500&&impact.energy>=3000&&distance(event.position,s.listener)<=25;
        emit(event);
      }
    });
    const flights=currentMeteorFlights(),meteors=new Set(flights.map(f=>f.bodyId));
    for(const contact of drainAudioContacts(contactNow)){
      const body=city?.topology.body(contact.entityA)??city?.topology.body(contact.entityB);
      const parts=[contactEntityParts(contact.entityA),contactEntityParts(contact.entityB)];
      const vehicle=parts.some(p=>p.kind==='vehicle'&&world?.vehicles?.has(p.id));
      const meteor=parts.some(p=>p.kind==='dynamic'&&meteors.has(p.id));
      const material=body?bodyMaterial(body):vehicle?'metal':meteor?'stone':'concrete';
      const id=`contact:${Math.min(contact.entityA,contact.entityB)}:${Math.max(contact.entityA,contact.entityB)}`;
      if(contact.kind==='scrape')engine.continuous({id,kind:'scrape',position:contact.position,material,
        speed:contact.tangentSpeed,intensity:contact.intensity,occlusion:s.occlusion?.sample(s.listener,contact.position,now)},now);
      else emit({id:`${id}:${contact.simTick}`,kind:meteor&&contact.normalSpeed>12?'collapse':'impact',position:contact.position,material,
        intensity:contact.intensity,size:contact.size,seed:contact.simTick^contact.entityA,
        protected:meteor&&contact.normalSpeed>12,
        atMs:city?contactPresentationTime(contact.simTick,city.presentedTick(),now,city.audioTickRate()):now+(world?.state.dynamicBodyInterpolationDelayMs??0)});
    }
    for(const flight of flights){
      const drawn=meteorDrawn(flight.bodyId);
      if(!drawn||drawn.source==='hidden'||drawn.source==='hold')continue;
      const previous=s.meteorPrevious.get(flight.bodyId),dt=previous?(now-previous.at)/1000:0;
      const velocity:Vec3=previous&&dt>0&&dt<.2?drawn.position.map((v,i)=>(v-previous.position[i])/dt) as [number,number,number]:drawn.raw?.velocity??[0,0,0];
      s.meteorPrevious.set(flight.bodyId,{position:[...drawn.position],at:now});
      s.motion.note({id:`meteor:${flight.bodyId}`,position:drawn.position,velocity,nowMs:now,material:'stone',mass:2000*flight.radiusM**3,size:flight.radiusM,
        // Only the streamed body's motion can indicate impact. The launch arc
        // is presentation guidance and must never invent an explosion.
        impacts:drawn.source==='body',authoritative:hasRecentAudioContacts(contactNow,contactEntityId('dynamic',flight.bodyId))},s.listener,emit);
      const speed=Math.hypot(...velocity);
      if(speed>8)engine.continuous({id:`meteor-air:${flight.bodyId}`,kind:'air',position:drawn.position,material:'stone',speed,velocity,intensity:clamp(speed/90),occlusion:s.occlusion?.sample(s.listener,drawn.position,now)},now);
    }
    for(const id of s.meteorPrevious.keys())if(!meteors.has(id))s.meteorPrevious.delete(id);
    let tracked=0;
    for(const [id,raw] of world?.state.dynamicBodies??[]){
      if(meteors.has(id)||distance(raw.position,s.listener)>120||tracked++>=256)continue;
      const body=world!.getRenderedDynamicBodyState(id)??raw,size=Math.max(...body.halfExtents)*2;
      s.motion.note({id:`body:${id}`,position:body.position,velocity:body.velocity,nowMs:now,material:'metal',size,
        mass:Math.max(1,body.halfExtents.reduce((a,b)=>a*b,8)*700),authoritative:hasRecentAudioContacts(contactNow,contactEntityId('dynamic',id))},s.listener,emit);
      const speed=Math.hypot(...body.velocity);
      if(speed>20)engine.continuous({id:`air:${id}`,kind:'air',position:body.position,material:'metal',speed,velocity:body.velocity,intensity:clamp(speed/120)},now);
    }
    let vehicleCount=0;
    for(const [id,v] of world?.vehicles??[]){
      if(distance(v.position,s.listener)>80||vehicleCount++>=64)continue;
      const speed=Math.hypot(...v.linearVelocity);
      if(speed>.7)engine.continuous({id:`vehicle:${id}`,kind:'engine',material:'metal',position:v.position,speed,intensity:clamp(.08+speed/55)},now);
      s.motion.note({id:`vehicle:${id}`,position:v.position,velocity:v.linearVelocity,nowMs:now,material:'metal',size:2,mass:1200,authoritative:hasRecentAudioContacts(contactNow,contactEntityId('vehicle',id))},s.listener,emit);
    }
    s.motion.prune(now);engine.update(now,position=>s.occlusion?.sample(s.listener,position,now)??0);
  });
  return null;
}
