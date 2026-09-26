import * as THREE from 'three';
import type { GrassInteraction } from './GrassInteraction';
import { GrassPaint, GRASS_MAX_HEIGHT } from './GrassPaint';
import { createFoliageAtlas } from './foliageAtlas';
import { FOLIAGE_HANDOFF, hasFoliageCanopy } from './foliageLod';
import type { GrassExclusion, GrassQuality } from './grassPlacement';

/** Coarse clumps for authored tall stands across the whole 512 m world.
 * 32 m batches, at most 1 clump/m² and 8 triangles/clump. No distance cutoff.
 * Three vertical cutouts retain side silhouettes; one overhead cutout retains
 * canopy coverage from aerial views. Neither is used for close-up plants. */
export class FoliageCanopy {
  readonly group = new THREE.Group();
  readonly material: THREE.MeshLambertMaterial;
  readonly uniforms: { foliageTime: {value:number}; foliageWind: {value:THREE.Vector2}; foliageHandoff: {value:THREE.Vector2} };
  private readonly contactBlend = {value:1};
  private readonly atlas = createFoliageAtlas();
  private readonly template = new THREE.BufferGeometry();
  private readonly chunks = new Map<string,THREE.Mesh<THREE.InstancedBufferGeometry,THREE.MeshLambertMaterial>>();
  private readonly pending = new Set<string>();
  private readonly unsubscribe: () => void;
  private readonly box = new THREE.Box3();
  private readonly frustum = new THREE.Frustum();
  private readonly matrix = new THREE.Matrix4();
  private shadows = true;
  setShadows(enabled:boolean):void {this.shadows=enabled;for(const mesh of this.chunks.values())mesh.receiveShadow=enabled;}
  visibleClumps = 0; draws = 0; instanceBytes = 0;
  get pendingChunks(): number { return this.pending.size; }

  constructor(private readonly paint: GrassPaint, quality: GrassQuality, private readonly exclusions: readonly GrassExclusion[], private readonly interaction: GrassInteraction) {
    this.group.name = 'Distant foliage canopy';
    const positions:number[]=[],uvs:number[]=[],normals:number[]=[],indices:number[]=[];
    for(let face=0;face<4;face++) {
      const n=positions.length/3;
      for(const [x,y] of [[-0.5,0],[0.5,0],[-0.5,1],[0.5,1]]) {
        positions.push(x,y,face);uvs.push(x+0.5,y);normals.push(0,1,0);
      }
      indices.push(n,n+1,n+2,n+1,n+3,n+2);
    }
    this.template.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
    this.template.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3));
    this.template.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));
    this.template.setIndex(indices);
    this.uniforms = {foliageTime:{value:0},foliageWind:{value:new THREE.Vector2()},foliageHandoff:{value:new THREE.Vector2(...FOLIAGE_HANDOFF[quality])}};
    this.material = new THREE.MeshLambertMaterial({map:this.atlas,alphaTest:0.3,side:THREE.DoubleSide});
    this.material.forceSinglePass=true;
    this.material.onBeforeCompile = shader => {
      Object.assign(shader.uniforms,this.uniforms,{
        canopyContacts:{value:interaction.texture},canopyPreviousContacts:{value:interaction.previousTexture},
        canopyContactBounds:{value:interaction.bounds},canopyContactBlend:this.contactBlend,
      });
      shader.vertexShader=shader.vertexShader.replace('#include <common>',`#include <common>
        attribute vec4 canopyRoot;
        attribute vec4 canopyStyle;
        varying vec3 vCanopyWorld;
        varying vec3 vCanopyTint;
        varying vec2 vCanopyUv;
        uniform float foliageTime;
        uniform vec2 foliageWind;
        uniform sampler2D canopyContacts;
        uniform sampler2D canopyPreviousContacts;
        uniform vec4 canopyContactBounds;
        uniform float canopyContactBlend;
      `).replace('#include <begin_vertex>',`
        float angle=canopyRoot.w+position.z*1.04719755;
        vec3 transformed;
        if(position.z < 2.5) {
          transformed=vec3(cos(angle)*position.x*1.4,position.y*canopyRoot.z,sin(angle)*position.x*1.4);
        } else {
          transformed=vec3(position.x*1.4,canopyRoot.z*0.76,(position.y-0.5)*1.4);
        }
        transformed.xz+=foliageWind*0.007*sin(foliageTime*1.7+canopyRoot.x*0.6+canopyRoot.y*0.4)*pow(transformed.y/max(canopyRoot.z,0.01),2.0);
        vec2 worldRoot=(modelMatrix*vec4(canopyRoot.x,0.0,canopyRoot.y,1.0)).xz;
        vec2 contactUv=(worldRoot-canopyContactBounds.xy)/canopyContactBounds.zw;
        vec4 contact=mix(texture2D(canopyPreviousContacts,clamp(contactUv,0.0,1.0)),texture2D(canopyContacts,clamp(contactUv,0.0,1.0)),canopyContactBlend);
        float edge=smoothstep(0.0,0.04,min(min(contactUv.x,contactUv.y),min(1.0-contactUv.x,1.0-contactUv.y)));
        float pressure=max(contact.r,contact.a*0.7)*edge;
        vec2 direction=(contact.gb*255.0-128.0)/127.0;
        transformed.xz+=direction*transformed.y*pressure*0.85;
        transformed.y*=1.0-pressure*0.91;
        transformed+=vec3(canopyRoot.x,0.006,canopyRoot.y);
        vCanopyWorld=(modelMatrix*vec4(transformed,1.0)).xyz;
        vCanopyTint=canopyStyle.rgb*mix(0.38,1.0,position.z>2.5?0.8:position.y);
        vCanopyUv=vec2((uv.x*0.984+0.008+canopyStyle.w)/5.0,(uv.y*0.984+0.008+(position.z>2.5?0.0:1.0))/2.0);
      `);
      shader.fragmentShader=shader.fragmentShader.replace('#include <common>',`#include <common>
        varying vec3 vCanopyWorld;
        varying vec3 vCanopyTint;
        varying vec2 vCanopyUv;
        uniform vec2 foliageHandoff;
      `).replace('#include <normal_fragment_begin>',`#include <normal_fragment_begin>
        normal=normalize((viewMatrix*vec4(0.0,1.0,0.0,0.0)).xyz);
      `).replace('#include <map_fragment>',`
        vec4 canopySample=texture2D(map,vCanopyUv);
        diffuseColor*=canopySample;
        diffuseColor.rgb*=vCanopyTint;
        float handoff=smoothstep(foliageHandoff.x,foliageHandoff.y,distance(cameraPosition,vCanopyWorld));
        float dither=fract(52.9829189*fract(dot(gl_FragCoord.xy,vec2(0.06711056,0.00583715))));
        if(dither>=handoff) discard;
      `);
    };
    this.material.customProgramCacheKey=()=> 'foliage-canopy-v1';
    const enqueue=(minX:number,minZ:number,maxX:number,maxZ:number)=>{
      for(let z=Math.max(-8,Math.floor(minZ/32));z<=Math.min(7,Math.floor(maxZ/32));z++)
        for(let x=Math.max(-8,Math.floor(minX/32));x<=Math.min(7,Math.floor(maxX/32));x++) this.pending.add(`${x},${z}`);
    };
    this.paint.forEachTile((x,z)=>enqueue(x*8-1,z*8-1,x*8+9,z*8+9));
    this.unsubscribe=paint.subscribe(b=>enqueue(b.minX-1,b.minZ-1,b.maxX+1,b.maxZ+1));
  }

  private build(cx:number,cz:number): void {
    const roots:number[]=[], styles:number[]=[], sample:number[]=[];
    for(let tz=0;tz<4;tz++) for(let tx=0;tx<4;tx++) {
      const px=cx*4+tx,pz=cz*4+tz,read=this.paint.sampler(px,pz);
      const exclusions=this.exclusions.filter(e=>e.maxX>=px*8 && e.minX<=px*8+8 && e.maxZ>=pz*8 && e.minZ<=pz*8+8);
      for(let z=0;z<8;z++) for(let x=0;x<8;x++) {
        read(x+0.5,z+0.5,sample);
        const species=Math.round(sample[5]*255), height=sample[1]*GRASS_MAX_HEIGHT*(0.45+sample[8]*0.55);
        if(!hasFoliageCanopy(species,height) || sample[0]<=0) continue;
        const wx=px*8+x+0.5,wz=pz*8+z+0.5;
        if(exclusions.some(e=>wx>=e.minX-0.3 && wx<=e.maxX+0.3 && wz>=e.minZ-0.3 && wz<=e.maxZ+0.3)) continue;
        let hash=Math.imul(Math.floor(wx*2),73856093)^Math.imul(Math.floor(wz*2),19349663);
        hash=Math.imul(hash^(hash>>>16),0x45d9f3b);hash=Math.imul(hash^(hash>>>16),0x45d9f3b);
        const random=((hash^(hash>>>16))>>>0)/4294967296;
        if(random>sample[0])continue;
        // Preserve canopy mass; coarse texture contains a height distribution.
        const canopyHeight=height*(species===4?0.42:species===2?0.85:0.94);
        roots.push(wx-cx*32+(random-0.5)*0.3,wz-cz*32+(((hash>>>8)&255)/255-0.5)*0.3,canopyHeight*(0.96+random*0.08),random*Math.PI*2);
        const dry=sample[7],health=0.72+sample[6]*0.36;
        styles.push((sample[2]*(1-dry*0.28)+0.46*dry*0.28)*health,
          (sample[3]*(1-dry*0.28)+0.33*dry*0.28)*health,
          (sample[4]*(1-dry*0.28)+0.12*dry*0.28)*health,species);
      }
    }
    const key=`${cx},${cz}`,old=this.chunks.get(key);
    if(old){this.group.remove(old);this.instanceBytes-=old.geometry.instanceCount*32;old.geometry.dispose();this.chunks.delete(key);}
    if(!roots.length)return;
    const geometry=new THREE.InstancedBufferGeometry();
    geometry.setIndex(this.template.index);
    for(const name of ['position','normal','uv'])geometry.setAttribute(name,this.template.getAttribute(name));
    geometry.setAttribute('canopyRoot',new THREE.InstancedBufferAttribute(Float32Array.from(roots),4));
    geometry.setAttribute('canopyStyle',new THREE.InstancedBufferAttribute(Float32Array.from(styles),4));
    geometry.instanceCount=roots.length/4;
    const mesh=new THREE.Mesh(geometry,this.material);
    mesh.receiveShadow=this.shadows;
    mesh.position.set(cx*32,0,cz*32);mesh.frustumCulled=false;mesh.matrixAutoUpdate=false;mesh.updateMatrix();mesh.raycast=()=>{};
    this.chunks.set(key,mesh);this.group.add(mesh);this.instanceBytes+=geometry.instanceCount*32;
  }

  update(camera:THREE.Camera,time:number,wind:THREE.Vector2): void {
    // One coarse batch per frame; only authored neighborhoods, independent of zoom.
    const next=this.pending.values().next().value;
    if(next!==undefined){this.pending.delete(next);const [x,z]=next.split(',').map(Number);this.build(x,z);}
    this.contactBlend.value=this.interaction.blendAt(time);
    this.uniforms.foliageTime.value=time;this.uniforms.foliageWind.value.copy(wind);
    this.matrix.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse);this.frustum.setFromProjectionMatrix(this.matrix);
    this.visibleClumps=this.draws=0;
    for(const mesh of this.chunks.values()) {
      this.box.min.set(mesh.position.x-6,0,mesh.position.z-6);this.box.max.set(mesh.position.x+38,5,mesh.position.z+38);
      mesh.visible=this.frustum.intersectsBox(this.box);
      if(mesh.visible){this.visibleClumps+=mesh.geometry.instanceCount;this.draws++;}
    }
  }
  dispose(): void {this.unsubscribe();for(const mesh of this.chunks.values())mesh.geometry.dispose();this.chunks.clear();this.group.clear();this.template.dispose();this.material.dispose();this.atlas.dispose();}
}
