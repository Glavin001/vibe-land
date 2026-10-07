// Optical glass for the material lab: a WGSL ray tracer through the mesh's own
// closed boundary (a triangle BVH in float textures), with Fresnel, total
// internal reflection, Beer absorption along the real path and three-band
// dispersion. Heavy: one BVH per geometry and an opaque-scene capture each
// frame (glass-scene.ts), so game glass uses the plain physical material.
//
// Only imported behind __WEBGPU__.
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as T from 'three/webgpu';
import {
  wgslFn,
  texture,
  positionGeometry,
  normalGeometry,
  cameraPosition,
  modelWorldMatrix,
  modelWorldMatrixInverse,
  vec4,
  uniform,
} from 'three/tsl';
import type { GlassScenePass } from './glass-scene';
import type { MaterialHandle } from './materials';
type Tri = {
  a: T.Vector3;
  b: T.Vector3;
  c: T.Vector3;
  center: T.Vector3;
  box: T.Box3;
  normals: T.Vector3[];
};
export type BoundaryCache = {
  nodes: T.DataTexture;
  triangles: T.DataTexture;
  count: number;
  dispose: () => void;
};
export function buildBoundaryCache(geometry: T.BufferGeometry): BoundaryCache {
  const pos = geometry.getAttribute('position'),
    ix = geometry.index,
    normal = geometry.getAttribute('normal');
  const triangles: Tri[] = [];
  for (let i = 0; i < (ix ? ix.count : pos.count); i += 3) {
    const v = [0, 1, 2].map((j) =>
      new T.Vector3().fromBufferAttribute(pos, ix ? ix.getX(i + j) : i + j),
    );
    const area = new T.Vector3()
      .subVectors(v[1], v[0])
      .cross(new T.Vector3().subVectors(v[2], v[0]))
      .lengthSq();
    if (area < 1e-20) continue;
    triangles.push({
      a: v[0],
      b: v[1],
      c: v[2],
      center: v[0]
        .clone()
        .add(v[1])
        .add(v[2])
        .multiplyScalar(1 / 3),
      box: new T.Box3().setFromPoints(v),
      normals: [0, 1, 2].map((j) =>
        new T.Vector3().fromBufferAttribute(
          normal,
          ix ? ix.getX(i + j) : i + j,
        ),
      ),
    });
  }
  const nodes: number[][] = [];
  const ordered: Tri[] = [];
  function build(items: Tri[]) {
    const index = nodes.length;
    nodes.push([]);
    const box = new T.Box3();
    items.forEach((t) => box.union(t.box));
    let start = 0,
      count = 0;
    if (items.length <= 6) {
      start = ordered.length;
      count = items.length;
      ordered.push(...items);
    } else {
      const size = box.getSize(new T.Vector3());
      const axis =
        size.x > size.y && size.x > size.z ? 'x' : size.y > size.z ? 'y' : 'z';
      items.sort((a, b) => a.center[axis] - b.center[axis]);
      const mid = items.length >> 1;
      build(items.slice(0, mid));
      build(items.slice(mid));
    }
    nodes[index] = [
      box.min.x,
      box.min.y,
      box.min.z,
      start,
      box.max.x,
      box.max.y,
      box.max.z,
      count,
      nodes.length,
      0,
      0,
      0,
    ];
  }
  build(triangles);
  function tex(data: number[]) {
    const width = 1024,
      height = Math.ceil(data.length / 4 / width);
    const buffer = new Float32Array(width * height * 4);
    buffer.set(data);
    const t = new T.DataTexture(
      buffer,
      width,
      height,
      T.RGBAFormat,
      T.FloatType,
    );
    t.minFilter = T.NearestFilter;
    t.magFilter = T.NearestFilter;
    t.needsUpdate = true;
    return t;
  }
  const nodesTex = tex(nodes.flat());
  const trianglesTex = tex(
    ordered.flatMap((t) => [
      ...t.a.toArray(),
      0,
      ...t.b.toArray(),
      0,
      ...t.c.toArray(),
      0,
      ...t.normals[0].toArray(),
      0,
      ...t.normals[1].toArray(),
      0,
      ...t.normals[2].toArray(),
      0,
    ]),
  );
  return {
    nodes: nodesTex,
    triangles: trianglesTex,
    count: nodes.length,
    dispose: () => {
      nodesTex.dispose();
      trianglesTex.dispose();
    },
  };
}
export const glassSource = `fn matterGlass(p:vec3f,n0:vec3f,eye:vec3f,a:vec4f,b:vec4f,m:mat4x4f,nodes:texture_2d<f32>,tris:texture_2d<f32>,env:texture_2d<f32>,envSampler:sampler,nodeCount:f32,sceneColor:texture_2d<f32>,sceneDepth:texture_depth_2d,viewProjection:mat4x4f,seed:f32,referenceScene:f32)->vec4f {
 let incident=normalize(p-eye);var n=normalize(n0);let perturb=vec3f(cos(p.y*83.+seed)*.007,sin(p.x*70.+seed*1.5)*.005,0.)*a.w*b.w;n=normalize(n+perturb);
 let eta=b.x;let F=mfresnel(abs(dot(-incident,n)),1.,eta);let wr=normalize((m*vec4f(reflect(incident,n),0.)).xyz);
 let origin=(m*vec4f(p,1.)).xyz;var result=menvRough(wr,env,envSampler,a.z)*F;var weight=vec3f(1.-F);var rd=refract(incident,n,1./eta);var ro=p+rd*.000003;var inside=true;var path=0.;
 for(var bounce=0;bounce<8;bounce++){
  let hit=mtrace(ro,rd,nodes,tris,i32(nodeCount));if(hit.w<0.){break;}
  if(inside){path+=hit.w;}
  let point=ro+rd*hit.w;let outward=normalize(hit.xyz);let face=select(outward,-outward,dot(rd,outward)>0.);
  let n1=select(1.,eta,inside);let n2=select(eta,1.,inside);let outgoing=refract(rd,face,n1/n2);
  if(dot(outgoing,outgoing)<.000001){rd=reflect(rd,face);}else{
   let f=mfresnel(abs(dot(-rd,face)),n1,n2);
   weight*=1.-f;rd=outgoing;inside=!inside;
  }
  ro=point+rd*.000003;
 }
 let sigma=mix(vec3f(.15,.03,.08),vec3f(3.4,.13,1.75),a.y)*b.z;
 weight*=exp(-sigma*path);
 let wp=(m*vec4f(ro,1.)).xyz;let wd=normalize((m*vec4f(rd,0.)).xyz);
 var transmitted=mlook(wp,wd,env,envSampler,sceneColor,sceneDepth,viewProjection,referenceScene);
 // Three restrained spectral bands, sharing the geometrically resolved center ray.
 let dispersion=b.y*.028;transmitted.r=mlook(wp,normalize(wd+vec3f(dispersion,0.,0.)),env,envSampler,sceneColor,sceneDepth,viewProjection,referenceScene).r;
 transmitted.b=mlook(wp,normalize(wd-vec3f(dispersion,0.,0.)),env,envSampler,sceneColor,sceneDepth,viewProjection,referenceScene).b;
 result+=weight*transmitted;return vec4f(result,1.);
}
fn mtfetch(t:texture_2d<f32>,i:i32)->vec4f{return textureLoad(t,vec2i(i%1024,i/1024),0);}
fn mtrace(ro:vec3f,rd:vec3f,nodes:texture_2d<f32>,tris:texture_2d<f32>,count:i32)->vec4f{
 var closest=1e6;var norm=vec3f(0.);var index=0;let inv=1./select(vec3f(.0000001),rd,abs(rd)>vec3f(.0000001));
 for(var visit=0;visit<384;visit++){
  if(index>=count){break;}let lo=mtfetch(nodes,index*3);let hi=mtfetch(nodes,index*3+1);let escape=i32(mtfetch(nodes,index*3+2).x);
  let t0=(lo.xyz-vec3f(.0000005)-ro)*inv;let t1=(hi.xyz+vec3f(.0000005)-ro)*inv;let mn=min(t0,t1);let mx=max(t0,t1);let near=max(max(mn.x,mn.y),mn.z);let far=min(min(mx.x,mx.y),mx.z);
  if(far<max(near,0.)||near>closest){index=escape;continue;}
  if(hi.w>.5){
   for(var j=0;j<6;j++){if(j>=i32(hi.w)){break;}let id=(i32(lo.w)+j)*6;let v0=mtfetch(tris,id).xyz;let e1=mtfetch(tris,id+1).xyz-v0;let e2=mtfetch(tris,id+2).xyz-v0;
    let h=cross(rd,e2);let det=dot(e1,h);if(abs(det)<1e-12){continue;}let invDet=1./det;let s=ro-v0;let u=invDet*dot(s,h);if(u<-.000001||u>1.000001){continue;}let q=cross(s,e1);let v=invDet*dot(rd,q);if(v<-.000001||u+v>1.000001){continue;}let t=invDet*dot(e2,q);if(t>.000001&&t<closest){closest=t;norm=normalize(mtfetch(tris,id+3).xyz*(1.-u-v)+mtfetch(tris,id+4).xyz*u+mtfetch(tris,id+5).xyz*v);}
   }index=escape;
  }else{index++;}
 }
 return vec4f(norm,select(closest,-1.,closest>99999.));
}
fn mfresnel(c:f32,n1:f32,n2:f32)->f32{let st2=(n1/n2)*(n1/n2)*(1.-c*c);if(st2>=1.){return 1.;}let ct=sqrt(1.-st2);let rs=(n1*c-n2*ct)/(n1*c+n2*ct);let rp=(n2*c-n1*ct)/(n2*c+n1*ct);return .5*(rs*rs+rp*rp);}
fn menv(d:vec3f,t:texture_2d<f32>,s:sampler)->vec3f{let uv=vec2f(atan2(d.z,d.x)*.15915494+.5,1.-acos(clamp(d.y,-1.,1.))*.31830989);return textureSampleLevel(t,s,uv,0.).rgb;}
fn menvRough(d:vec3f,t:texture_2d<f32>,s:sampler,r:f32)->vec3f{let a=normalize(cross(d,vec3f(.001,1.,0.)));let b=cross(d,a);let w=r*r*.7;return (menv(d,t,s)*.4+menv(normalize(d+a*w),t,s)*.15+menv(normalize(d-a*w),t,s)*.15+menv(normalize(d+b*w),t,s)*.15+menv(normalize(d-b*w),t,s)*.15);}
fn mlook(p:vec3f,d:vec3f,t:texture_2d<f32>,s:sampler,c:texture_2d<f32>,depth:texture_depth_2d,vp:mat4x4f,referenceScene:f32)->vec3f{
 let size=vec2i(textureDimensions(c));
 if(referenceScene>.5){
  var closest=1e6;var point=vec3f(0.);
  if(d.y<-.000001){let tHit=(-.0004-p.y)/d.y;if(tHit>0.){closest=tHit;point=p+d*tHit;}}
  if(d.z<-.000001){let tHit=(-.19-p.z)/d.z;let q=p+d*tHit;if(tHit>0.&&tHit<closest&&abs(q.x)<.9&&q.y>0.&&q.y<1.5){closest=tHit;point=q;}
   let wireDistance=(-.17-p.z)/d.z;let wire=p+d*wireDistance;let uvWire=wire.xy-vec2f(0.,.16);let spacing=.045;let nearest=round(uvWire/spacing)*spacing;
   let vertical=abs(uvWire.x-nearest.x)<.0006&&abs(nearest.x)<=.1351&&abs(uvWire.y)<.16;
   let horizontal=abs(uvWire.y-nearest.y)<.0006&&abs(nearest.y)<=.1351&&abs(uvWire.x)<.16;
   if(wireDistance>0.&&wireDistance<closest&&(vertical||horizontal)){closest=wireDistance;point=wire;}
  }
  if(closest<99999.){let clip=vp*vec4f(point,1.);let uvHit=vec2f(clip.x/clip.w*.5+.5,.5-clip.y/clip.w*.5);if(clip.w>0.&&all(uvHit>=vec2f(0.))&&all(uvHit<=vec2f(1.))){return textureLoad(c,clamp(vec2i(uvHit*vec2f(size)),vec2i(0),size-1),0).rgb;}return vec3f(.44,.46,.40);}
  return menv(d,t,s);
 }
 for(var i=0;i<40;i++){
  let distance=.0015*pow(1.25,f32(i));let point=p+d*distance;let clip=vp*vec4f(point,1.);if(clip.w<=0.){break;}let ndc=clip.xyz/clip.w;let uv=vec2f(ndc.x*.5+.5,.5-ndc.y*.5);if(any(uv<vec2f(0.))||any(uv>vec2f(1.))){break;}let pixel=clamp(vec2i(uv*vec2f(size)),vec2i(0),size-1);let z=textureLoad(depth,pixel,0);let sceneDistance=.001*80./max(80.-z*(80.-.001),.000001);let delta=clip.w-sceneDistance;
  if(z<.99999&&delta>=0.&&delta<max(.0005,distance*.025)){return textureLoad(c,pixel,0).rgb;}
 }return mscene(p,d,t,s);
}
fn mscene(p:vec3f,d:vec3f,t:texture_2d<f32>,s:sampler)->vec3f{
 return menv(d,t,s);
}`;
// menv reads the studio texture bottom-up, as three r182's equirect lookup
// does (specimens.ts environmentTexture).
const boundaryFragments = new WeakMap<T.Material, any>();
const opticalGlass: any = wgslFn(glassSource);
export function attachGlassBoundary(
  root: T.Object3D,
  handle: MaterialHandle,
  env: T.Texture,
  scenePass: GlassScenePass,
): () => void {
  const owned: {
    cache: BoundaryCache;
    material: T.MeshPhysicalNodeMaterial;
  }[] = [];
  root.traverse((object) => {
    if (!(object instanceof T.Mesh) || object.material !== handle.material)
      return;
    const cache = buildBoundaryCache(object.geometry);
    const mat = handle.material.clone();
    const eye = modelWorldMatrixInverse.mul(vec4(cameraPosition, 1)).xyz;
    mat.outputNode = opticalGlass(
      positionGeometry,
      normalGeometry,
      eye,
      handle.uniforms.a,
      handle.uniforms.b,
      modelWorldMatrix,
      texture(cache.nodes),
      texture(cache.triangles),
      texture(env),
      texture(env),
      uniform(cache.count),
      texture(scenePass.target.texture),
      texture(scenePass.target.depthTexture!),
      scenePass.viewProjection,
      handle.uniforms.seed,
      scenePass.referenceScene,
    );
    boundaryFragments.set(mat, mat.outputNode);
    mat.transmission = 0;
    mat.transparent = false;
    object.material = mat;
    object.castShadow = false;
    owned.push({ cache, material: mat });
  });
  return () =>
    owned.forEach(({ cache, material }) => {
      boundaryFragments.delete(material);
      cache.dispose();
      material.dispose();
    });
}

export function setBoundaryMode(root: T.Object3D, enabled: boolean) {
  root.traverse((o) => {
    if (o instanceof T.Mesh) {
      const material = o.material as T.MeshPhysicalNodeMaterial;
      const fragment = boundaryFragments.get(material);
      if (fragment && material.outputNode !== (enabled ? fragment : null)) {
        material.outputNode = enabled ? fragment : null;
        material.transmission = enabled ? 0 : 1;
        material.needsUpdate = true;
      }
    }
  });
}
