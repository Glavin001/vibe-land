import * as THREE from 'three';

/** Small, repeatable surface textures; no extra colliders or physics bodies. */
export function gardenGround(){
 const group=new THREE.Group(),textures:THREE.Texture[]=[];
 let seed=271828;const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
 const surface=(kind:'grass'|'gravel',width:number,depth:number,x:number,z:number)=>{
  const canvas=document.createElement('canvas');canvas.width=canvas.height=256;const ctx=canvas.getContext('2d')!;
  ctx.fillStyle=kind==='grass'?'#849574':'#b9af92';ctx.fillRect(0,0,256,256);
  for(let i=0;i<13000;i++){
   const value=Math.floor(random()*35);ctx.fillStyle=kind==='grass'?`rgb(${75+value},${94+value},${58+value})`:`rgb(${133+value},${125+value},${106+value})`;
   const px=random()*256,py=random()*256;
   if(kind==='grass'){ctx.globalAlpha=.25+random()*.35;ctx.fillRect(px,py,.7,2+random()*4);}else{ctx.globalAlpha=.4;ctx.fillRect(px,py,1+random()*2,1+random()*2);}
  }
  const map=new THREE.CanvasTexture(canvas);map.colorSpace=THREE.SRGBColorSpace;map.wrapS=map.wrapT=THREE.RepeatWrapping;map.repeat.set(width/3,depth/3);map.anisotropy=8;textures.push(map);
  const mesh=new THREE.Mesh(new THREE.PlaneGeometry(width,depth),new THREE.MeshStandardMaterial({map,roughness:1}));mesh.rotation.x=-Math.PI/2;mesh.position.set(x,kind==='grass'?-.019:-.017,z);mesh.receiveShadow=true;group.add(mesh);
 };
 surface('grass',116,82,0,0);
 surface('gravel',24,21,-38,-18);
 surface('gravel',24,23,34,19);
 return {group,dispose(){group.removeFromParent();group.children.forEach(o=>{const m=o as THREE.Mesh;m.geometry.dispose();(m.material as THREE.Material).dispose();});textures.forEach(t=>t.dispose());}};
}
