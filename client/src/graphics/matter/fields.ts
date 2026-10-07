// The Matter material fields: one WGSL function per material kind, all 3D
// solid textures in metres (no UVs, no images), sharing one noise library.
//
// Each kind compiles only its own field: the library is a separate code node
// every field includes, so a shader carries the noise once and nothing of the
// other four kinds.
//
// Every field returns the same mat4x4f:
//   [0] colour.rgb, roughness
//   [1] height (m), mask, clearcoat, anisotropy
//   [2] fiber/brushing direction (material space), detail
//   [3] the (possibly rotated) material-space position, 1
//
// Only imported behind __WEBGPU__: `three/tsl` is three-webgpu there.
import { wgsl, wgslFn } from 'three/tsl';

import type { MaterialKind } from './recipes';

// TSL nodes are loosely typed in @types/three 0.170.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

/** Hashes, value noise and cell noise: integer-free, aperiodic in 3D. */
const noiseLibrary: Node = wgsl(`
fn mseed(input:u32)->f32{var x=input;x=(x^(x>>16u))*0x7feb352du;x=(x^(x>>15u))*0x846ca68bu;x=x^(x>>16u);return f32(x&0x00ffffffu)/16777216.;}
fn mhash(p:vec3f)->f32 { var q=fract(p*vec3f(.1031,.1030,.0973)); q+=dot(q,q.yzx+33.33); return fract((q.x+q.y)*q.z); }
fn mnoise(p:vec3f)->f32 {
 let i=floor(p); let f=fract(p); let u=f*f*(3.-2.*f);
 return mix(mix(mix(mhash(i),mhash(i+vec3f(1.,0.,0.)),u.x),mix(mhash(i+vec3f(0.,1.,0.)),mhash(i+vec3f(1.,1.,0.)),u.x),u.y),mix(mix(mhash(i+vec3f(0.,0.,1.)),mhash(i+vec3f(1.,0.,1.)),u.x),mix(mhash(i+vec3f(0.,1.,1.)),mhash(i+vec3f(1.,1.,1.)),u.x),u.y),u.z)*2.-1.;
}
fn mcell(p:vec3f)->vec2f {
 let cell=floor(p); let f=fract(p); var d=100.;var id=0.;
 for(var z=-1;z<=1;z++){for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){
  let g=vec3f(f32(x),f32(y),f32(z));let h=mhash(cell+g);let v=g+vec3f(h,mhash(cell+g+17.),mhash(cell+g+39.))-f;let ds=dot(v,v);
  if(ds<d){d=ds;id=h;}
 }}}
 return vec2f(sqrt(d),id);
}
`);

const field = (name: string, body: string): Node =>
  wgslFn(
    `fn ${name}(p0: vec3f, normal: vec3f, a: vec4f, b: vec4f, seed: f32, footprint: f32, knot: vec3f) -> mat4x4f {
 var p=p0; var color=vec3f(.5); var height=0.0; var rough=.5; var fiber=vec3f(0.,1.,0.); var mask=0.0; var coat=0.0; var aniso=0.0;
 let detail=b.w; let fp=max(footprint,.0000001); let s=vec3f(mseed(u32(seed)),mseed(u32(seed)+151u),mseed(u32(seed)+491u))*97.;
${body}
 return mat4x4f(vec4f(clamp(color,vec3f(.001),vec3f(.95)),rough),vec4f(height,mask,coat,aniso),vec4f(fiber,detail),vec4f(p,1.));
}`,
    [noiseLibrary],
  );

/**
 * Oak: annual rings around the material +Y axis (the log), a branch knot,
 * earlywood vessels and radial ray flecks. a = ring spacing (m), knot
 * influence, vessel radius (m), coating; b = cut angle (deg), sanding, rays.
 */
const oakField = field('matterOak', `
  let angle=b.x*.0174532925; let c=cos(angle); let sn=sin(angle); p=vec3f(c*p.x-sn*p.y,sn*p.x+c*p.y,p.z);
  let q=p+vec3f(.093,.023,.062); let radial=length(q.xz); let branchAxis=normalize(vec3f(.48,1.,.14));let branchPoint=q-knot;let branchT=dot(branchPoint,branchAxis);let branch=length(branchPoint-branchT*branchAxis);
  let influence=exp(-branch*branch/0.00028)*a.y;
  let trunkGrowth=radial + .0018*mnoise(q*vec3f(25.,4.,25.)+s)+.0012*mnoise(q*vec3f(71.,8.,71.)+s)+.0027*influence*sin(q.y*70.);
  let branchGrowth=branch*1.8+.072+max(-branchT,0.)*1.4;
  let blend=clamp(.5+.5*(branchGrowth-trunkGrowth)/.022,0.,1.);let unionGrowth=mix(branchGrowth,trunkGrowth,blend)-.022*blend*(1.-blend);
  let growth=mix(trunkGrowth,unionGrowth,a.y);
  let elapsed=growth/max(a.x,.0001);let phase=elapsed+.25*sin(elapsed*.35+seed)+.12*sin(elapsed*.11+seed*1.4); let distortion=.08*mnoise(q*vec3f(95.,12.,95.)+s);
  let ring=fract(phase+distortion); let aa=min(fp/max(a.x,.0001)*1.5,.45);
  let late=smoothstep(.61-aa,.8+aa,ring)*(1.-smoothstep(.94-aa,1.+aa,ring));
  let early=1.-smoothstep(.05,.32,ring); let grain=mnoise(q*vec3f(310.,6.,310.)+s);
  let fine=mnoise(q*vec3f(950.,13.,950.)+s);
  color=mix(vec3f(.28,.137,.047),vec3f(.46,.275,.12),clamp(.48+grain*.23+fine*.09,0.,1.));
  color=mix(color,color*vec3f(.48,.46,.4),late*.5);
  let vq=vec3f((q.x+influence*.012)*1300.,q.y*7.,q.z*1300.)+s;
  let poreCell=mcell(vq); let pr=clamp(a.z*1300.,.035,.43); let pores=(1.-smoothstep(pr,pr+.08,poreCell.x))*(.15+early*.85);
  let resolved=1.-smoothstep(.00012,.0007,fp);
  color*=1.-pores*.48*resolved*detail;
  let theta=atan2(q.z,q.x); let rayCoord=theta*53.+mnoise(q*vec3f(14.,8.,14.)+s)*.7;
  let rays=(1.-smoothstep(.04,.14,abs(fract(rayCoord)-.5)))*(smoothstep(-.3,.6,mnoise(q*vec3f(11.,120.,11.)+s)));
  let cutNormal=vec3f(c*normal.x-sn*normal.y,sn*normal.x+c*normal.y,normal.z);
  let radialCut=abs(dot(normalize(vec3f(q.x,0.,q.z)),cutNormal));
  let rayShow=rays*(1.-radialCut)*b.z*detail;
  color=mix(color,vec3f(.49,.32,.16),rayShow*.65);
  height=(-pores*a.z*.28*(1.-b.y*.78)+fine*.000013*(1.-b.y))*resolved*detail;
  rough=clamp(.4-a.w*.19+pores*.15*resolved+fine*.025+(.035*(1.-resolved)),.12,.62);
  let localFiber=normalize(mix(vec3f(0.,1.,0.),branchAxis,(1.-blend)*a.y));fiber=vec3f(c*localFiber.x+sn*localFiber.y,-sn*localFiber.x+c*localFiber.y,localFiber.z); mask=late*.6+rayShow*.4; coat=a.w*.55; aniso=.23;
`);

/**
 * Concrete: graded aggregate under a paste skin, sand, micro pores and
 * trapped-air cavities. a = aggregate size (m), paste skin (m), cavity
 * population, grinding depth (m); b = polishing, cavity depth (m), paste
 * variation. mask = cavity (for the horizon occlusion).
 */
const concreteField = field('matterConcrete', `
  let broadVariation=mnoise(p*13.+s); let medium=mnoise(p*87.+s); let fine=mnoise(p*690.+s);
  let agg=mcell(p/max(a.x,.001)+s); let exposed=smoothstep(a.y-.0008,a.y+.0015,a.w);
  let sand=mcell(p/max(a.x*.23,.0003)+s+71.);
  let aggregateRadius=.18+.32*sqrt(agg.y);
  let irregularDistance=agg.x+mnoise(p/max(a.x*.3,.0003)+s)*.11;
  let coarse=(1.-smoothstep(aggregateRadius-.025,aggregateRadius+.025,irregularDistance))*smoothstep(.08,.3,agg.y);
  let fineAggregate=(1.-smoothstep(.20,.46,sand.x))*.38;
  let mineral=max(coarse,fineAggregate*(1.-coarse))*exposed;
  let aggregateColor=mix(vec3f(.105,.1,.082),vec3f(.38,.37,.31),agg.y);
  color=vec3f(.34,.345,.315)*(1.+broadVariation*b.z+medium*.045+fine*.023*detail);
  color=mix(color,aggregateColor,mineral*.9);
  let pores=mcell(p*430.+s*1.3); let large=mcell(p*95.+s*2.);
  let microVoid=(1.-smoothstep(.07,.16,pores.x))*smoothstep(.2,.4,pores.y);
  let cavityRadius=mix(.08,.39,pow(large.y,6.));
  let cavity=(1.-smoothstep(cavityRadius*.45,cavityRadius,large.x))*smoothstep(1.-a.z*.65,1.-a.z*.65+.05,large.y);
  let microResolved=1.-smoothstep(.0002,.0012,fp); let bigResolved=1.-smoothstep(.001,.006,fp);
  let cv=cavity*bigResolved;
  height=((-microVoid*.00012*microResolved-cv*b.y)+(medium*.00006+fine*.000018*microResolved))*(1.-b.x*.9)*detail;
  color*=1.-(microVoid*.18*microResolved+cv*.20)*detail;
  rough=clamp(.81-b.x*.59+fine*.025+mineral*.05+cv*.12,.12,.98); mask=cv;
`);

/**
 * Brushed steel: abrasive grooves running along material +Y (they vary
 * across X), overlapping passes, cross brushing and sparse handling
 * scratches. a = groove width (m), groove depth (m), direction spread, cross
 * brushing; b = pass overlap, scratches, base roughness. mask = how resolved
 * the grooves are at this pixel's footprint.
 */
const steelField = field('matterSteel', `
  let bend=mnoise(p*vec3f(10.,3.,10.)+s)*a.z*.03;
  let track=(p.x+bend)/max(a.x,.00001); let longitudinal=mnoise(p*vec3f(85.,8.,85.)+s);
  let density=1.-smoothstep(a.x*.5,a.x*3.,fp); let broad=mnoise(vec3f(track*.055,p.y*9.,p.z*80.)+s);
  let groove=sin(track*6.28318+mnoise(vec3f(track*.17,p.y*22.,0.)+s)*1.5);
  let interruption=.5+.5*mnoise(vec3f(track*.14,p.y*(20.+b.x*80.),p.z*10.)+s);
  let cross=sin(p.y/max(a.x*1.7,.00001)*6.28318+longitudinal*2.)*a.w;
  let scratches=mnoise(p*vec3f(1700.,9.,310.)+s*3.); let sparse=pow(max(scratches,0.),9.)*b.y;
  height=(groove*interruption+cross)*a.y*density*detail-sparse*.000016*detail;
  color=vec3f(0.66714468,0.64075098,0.60257098)*(1.+broad*.028*detail);
  rough=clamp(b.z+broad*.035+longitudinal*.012,.06,.8);
  aniso=clamp(.88-a.z*.25-a.w*.3,.2,.95); fiber=normalize(vec3f(a.z*.15,1.,0.)); mask=density;
`);

/**
 * Marble: domain-warped folded layers with veins and lace, a crystalline
 * grain field. a = vein scale (m), vein width, folding, grain size (m);
 * b = scattering distance (mm), mineral absorption, polishing. mask = vein.
 */
const marbleField = field('matterMarble', `
  var q=p/max(a.x,.001)+s*.15;
  q+=vec3f(mnoise(q*1.8+s),mnoise(q*2.3+s+vec3f(9.,3.,7.)),mnoise(q*1.7+s+vec3f(3.,8.,1.)))*a.z*.28;
  let layer=q.x*.77+q.z*.39+q.y*.17+.075*mnoise(q*3.4+s)+.028*mnoise(q*9.+s);
  let line=abs(sin(layer*8.+mnoise(q*5.+s)*.17)); let width=a.y;
  let vein=1.-smoothstep(width*.35,width*1.8,line);
  let lace=1.-smoothstep(.018,.045,abs(sin(layer*33.+mnoise(q*14.+s))));
  let mineral=clamp(vein*.8+lace*.08,0.,1.); let cloud=mnoise(p*21.+s)*.035;
  let grains=mcell(p/max(a.w,.0001)+s); let fine=mnoise(p*2100.+s);
  color=vec3f(.68,.675,.615)+cloud;
  let halo=(1.-smoothstep(width*.5,width*4.,line))*.12;
  color=mix(color,vec3f(.22,.24,.215),mineral*(.45+b.y*.5)+halo);
  let resolved=1.-smoothstep(a.w*.2,a.w*1.4,fp);
  color+=vec3f(grains.y-.5)*.02*resolved*detail;
  height=(fine*.000013*resolved+mineral*.000018)*(1.-b.z*.97)*detail;
  rough=clamp(.44-b.z*.31+grains.y*.016*resolved,.055,.7); mask=mineral; coat=0.;
`);

/** Glass: white base, surface roughness a.z and faint manufacturing waviness a.w. */
const glassField = field('matterGlassSurface', `
  color=vec3f(1.); rough=a.z;
  height=(sin(p.x*70.+sin(p.y*12.))*.000027+mnoise(p*160.+s)*.000003)*a.w*detail;
`);

const FIELDS: Record<MaterialKind, Node> = {
  oak: oakField,
  concrete: concreteField,
  steel: steelField,
  marble: marbleField,
  glass: glassField,
};

/** The field function for one kind: (p, normal, a, b, seed, footprint, knot) -> mat4x4f. */
export function matterField(kind: MaterialKind): Node {
  return FIELDS[kind];
}

/**
 * A normal from a scalar height in metres, by screen-space derivatives of
 * the view position and the height (no UVs or tangents needed).
 */
export const physicalBump: Node = wgslFn(`fn matterBump(p:vec3f,n:vec3f,h:f32)->vec3f {
 let dx=dpdx(p);let dy=dpdy(p);let rx=cross(dy,n);let ry=cross(n,dx);let det=dot(dx,rx);
 let grad=(dpdx(h)*rx+dpdy(h)*ry)*sign(det);
 if(abs(det)<1e-16){return normalize(n);}
 return normalize(abs(det)*n-grad);
}`);
