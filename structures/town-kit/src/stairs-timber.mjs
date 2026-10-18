/**
 * Timber stairs, built the way site-built house stairs are, and laid out from
 * the building code so that the player's character controller can climb them.
 *
 * Layouts (every one has a platform: a stair here never runs floor to floor in
 * one flight):
 *   'switchback'  up a flight, a half landing the width of both flights, back
 *                 the other way beside it (a U or dog-leg stair);
 *   'l'           up a flight, a quarter landing, a quarter turn to the side;
 *   'straight'    one direction, the flight broken by a landing.
 *
 * Geometry (IRC 2021 R311.7, the house stair; metres):
 *   riser <= 196 mm (7 3/4 in, R311.7.5.1), all risers in a stair equal (the
 *     code allows 3/8 in of variation; these have none);
 *   going (tread depth, nosing to nosing) >= 254 mm (10 in, R311.7.5.2), with a
 *     19-32 mm nosing (R311.7.5.3); 2R + T within 590-650 mm, the step rule
 *     (DIN 18065 Table 1 / Blondel), so the going suits the rise;
 *   clear width >= 914 mm (36 in, R311.7.1);
 *   headroom >= 2032 mm (6 ft 8 in, R311.7.2) measured vertically from the sloped
 *     plane through the nosings and from every landing: planStair() returns the
 *     floor void that needs, checkHeadroom() measures what was framed;
 *   a landing at least as deep, in the direction of travel, as the stair is wide
 *     (R311.7.6 asks 36 in; the width rule is IBC 1011.6's) and a flight rising
 *     at most 3.66 m between landings (IBC 1011.8, 12 ft; the IRC allows 151 in).
 *
 * The player (netcode/src/movement.rs MoveConfig::default, the Rapier
 * controller, and server/src/physx_runtime.rs, the PhysX CCT built from the
 * same config): a 0.35 m radius capsule 1.6 m tall that steps up 0.55 m
 * (max_step_height, the autostep / PhysX stepOffset) onto a step at least
 * 0.2 m deep (min_step_width) and walks slopes to 45 degrees
 * (max_slope_radians). A 196 mm riser is 36% of the step, a 254 mm going 1.3x
 * the step width, the pitch (atan R/T, <= 37.7 degrees at the code limits) under
 * 45, the clear width 0.94 m over the capsule's 0.7 m and the headroom over its
 * 1.6 m: checkStair() asserts each.
 *
 * Construction (buildTimberStair):
 *   two housed stringers per flight, 38 x 286 (a 2 x 12), the treads (38 mm
 *   softwood) and risers (18 mm) housed 12 mm into them; risers nailed to the
 *   treads; each stringer two or three pieces (plumb cuts), like the veneer
 *   house's members;
 *   the head of each flight hung from what it climbs to -- the floor opening's
 *   trimmer or header, or the landing's rim -- with a stair-stringer hanger;
 *   the foot of each flight on the slab against a kicker, or on the landing deck;
 *   the landing a framed platform: two 190 x 45 rims across the flights, 140 x 45
 *   joists between them, 22 mm particleboard on top, on 90 x 90 posts standing in
 *   post bases on the slab, free of the walls;
 *   the floor opening (frameFloorOpening) trimmed with doubled trimmer joists and
 *   doubled headers, the tail joists and the headers in joist hangers.
 * Every joint is rated by its fasteners (STAIR_CONNECTIONS, in the style of
 * materials.mjs CONNECTIONS, C24 timber throughout).
 */
import {NAIL,SLIP,BEARING} from './materials.mjs';

/** The building code's limits (metres). */
export const CODE={
 maxRiser:.196,          // IRC R311.7.5.1: 7 3/4 in
 minGoing:.254,          // IRC R311.7.5.2: 10 in
 nosing:[.019,.032],     // IRC R311.7.5.3: 3/4 - 1 1/4 in where the going is under 11 in
 minWidth:.914,          // IRC R311.7.1: 36 in clear
 headroom:2.032,         // IRC R311.7.2: 6 ft 8 in
 minLanding:.914,        // IRC R311.7.6: 36 in in the direction of travel
 maxFlightRise:3.66,     // IBC 1011.8: 12 ft between landings
 stepRule:[.59,.65],     // DIN 18065: 2R + T, 590-650 mm
};

/** The player's controller (netcode/src/movement.rs MoveConfig::default). */
export const CONTROLLER={
 maxStep:.55,            // max_step_height
 minStepWidth:.2,        // min_step_width
 maxSlopeDegrees:45,     // max_slope_radians
 radius:.35,             // capsule_radius
 height:2*(.45+.35),     // 2 (capsule_half_segment + capsule_radius)
 offset:.01,             // collision_offset
};

/** Member sizes (metres): AS 1684 / EN 336 metric sawn sizes, as the veneer house. */
export const STAIR_SIZES={
 stringer:.038,stringerDepth:.286,   // 2 x 12 (1.5 x 11.25 in)
 stringerAbove:.04,                  // housed string's margin over the nosing line
 tread:.038,riser:.018,nosing:.025,housing:.012,
 clearWidth:.94,going:.27,gap:.05,   // between stringers; the well between switchback flights
 rim:.045,rimDepth:.19,joist:.045,joistDepth:.14,deck:.022,post:.09,joistSpacing:.6,
};
const Z=STAIR_SIZES;

const LB=4.448,HANGER_DEFLECTION=.003175;
/**
 * Connections in a stair and its floor opening, as materials.mjs CONNECTIONS:
 * per joint, capacities in N (tension, shear), bearing in Pa, slip stiffness in
 * N/m. Hanger capacities are Simpson Strong-Tie catalogue allowables (SPF
 * column, 100% load duration) taken to characteristic at twice the allowable,
 * the kit's convention (materials.mjs TIE_DOWN: the allowable is the tested
 * ultimate over 3); a hanger's allowable is also capped at 1/8 in of
 * deflection (ICC-ES AC13), so allowable / 3.175 mm is its stiffness.
 */
export const STAIR_CONNECTIONS={
 // Tail joist into the header: LUS210 face-mount hanger, 1,150 lb download
 // (C-C-2021 LUS table, SPF); the joist's 4 nails (0.148 x 3) laterally
 // resist its pulling out of the seat.
 'joist-hanger':{per:'joint',tension:4*NAIL.lateral,shear:2*1150*LB,compression:BEARING.compression,slip:1150*LB/HANGER_DEFLECTION},
 // Doubled header into the doubled trimmer: LUS210-2, 1,575 lb (SPF); 6 joist nails.
 // IRC R502.10: headers over 6 ft are hung, trimmers and headers doubled.
 'header-hanger':{per:'joint',tension:6*NAIL.lateral,shear:2*1575*LB,compression:BEARING.compression,slip:1575*LB/HANGER_DEFLECTION},
 // Stringer head to the trimmer, header or landing rim: LSCZ adjustable stair-
 // stringer connector, 650 lb vertical, 755 lb lateral (ICC-ES ESR-2549).
 'stair-hanger':{per:'joint',tension:2*755*LB,shear:2*650*LB,compression:BEARING.compression,slip:650*LB/HANGER_DEFLECTION},
 // Stringer foot on the slab against a 38 x 89 kicker shot to it, or on the
 // landing deck: 2 toe nails into the kicker / landing joist (NDS 12.5.4 toe factors).
 'stair-foot':{per:'joint',tension:2*NAIL.withdrawal*NAIL.toeWithdrawal,shear:2*NAIL.lateral*NAIL.toeLateral,compression:BEARING.compression,slip:2*SLIP.nail},
 // Tread end housed 12 mm into the string: it bears on the housing's ledge
 // (f_c,90,k 2.5 MPa over 12 mm x the tread's depth, set per stair: housingShear)
 // and is held in by 2 screws, 4.5 x 60, through the string into its end grain
 // (EN 1995-1-1 8.7.2, rho_k 350, l_ef 45 mm, k_d 0.56: 5.4 kN each).
 'tread-housing':{per:'joint',tension:2*5.4e3,shear:null,compression:BEARING.compression,slip:2*SLIP.screw},
 // Riser end housed the same way, one screw.
 'riser-housing':{per:'joint',tension:5.4e3,shear:null,compression:BEARING.compression,slip:SLIP.screw},
 // Riser to the tread above and below it (or the floor it stands on): nailed at
 // ~250 mm, 4 nails a joint across a 0.94 m stair.
 'riser-tread':{per:'joint',tension:4*NAIL.withdrawal,shear:4*NAIL.lateral,compression:BEARING.compression,slip:4*SLIP.nail},
 // Top riser face-nailed to the trimmer or landing rim behind it: 4 nails.
 'riser-back':{per:'joint',tension:4*NAIL.withdrawal,shear:4*NAIL.lateral,compression:BEARING.compression,slip:4*SLIP.nail},
 // Landing joist end-nailed through the rim: IRC R602.3(1) "band or rim joist to
 // joist, 3-16d end nail", lateral in end grain at NDS 12.5.2's 0.67; withdrawal
 // from end grain is not relied on, so tension is 3 toe nails'.
 'landing-joist':{per:'joint',tension:3*NAIL.withdrawal*NAIL.toeWithdrawal,shear:3*NAIL.lateral*.67,compression:BEARING.compression,slip:3*SLIP.nail},
 // Landing rim on its post: bearing, 4 toe nails.
 'post-cap':{per:'joint',tension:4*NAIL.withdrawal*NAIL.toeWithdrawal,shear:4*NAIL.lateral*NAIL.toeLateral,compression:BEARING.compression,slip:4*SLIP.nail},
 // Post in a post base on the slab, one M12 anchor: as materials.mjs 'anchor' per bolt.
 'post-base':{per:'joint',tension:7.5e3,shear:8e3,compression:BEARING.compression,slip:2*SLIP.bolt},
};

/** Node types this module authors. */
export const STAIR_TYPES=['stair-stringer','stair-tread','stair-riser','landing-rim','landing-joist','landing-deck','landing-post'];
/** Floor-opening framing types (frameFloorOpening); tails stay the floor's own joist type. */
export const OPENING_TYPES=['trimmer-joist','header-joist'];

/** Risers for a rise: the fewest that keep each at or under the code's maximum. */
export function riserCount(rise,maxRiser=CODE.maxRiser){return Math.ceil(rise/maxRiser-1e-9);}

const DIRS={'+x':[1,0],'-x':[-1,0],'+z':[0,1],'-z':[0,-1]};
const vec=d=>{if(Array.isArray(d))return d;if(!DIRS[d])throw Error(`direction ${d}: one of ${Object.keys(DIRS).join(', ')}`);return DIRS[d];};

/** The stringer's geometry in a flight's own coordinates (s along travel from the first riser face, y). */
function stringerLines(f){
 const {rise:R,going:T}=f,cos=T/Math.hypot(R,T);
 const nose=s=>f.base+R+(s+Z.nosing)*R/T;
 return {cos,nose,top:s=>nose(s)+Z.stringerAbove/cos,bottom:s=>nose(s)-(Z.stringerDepth-Z.stringerAbove)/cos};
}
/** How far past its first riser a flight's stringer foot reaches (it must bear on what the flight starts from). */
function footReach(R,T){const cos=T/Math.hypot(R,T);return ((Z.stringerDepth-Z.stringerAbove)/cos-R)*T/R-Z.nosing;}

/**
 * Plan a stair.
 *   y0, y1        floor levels (finished surfaces) it joins
 *   origin [x,z]  the foot of the first flight: on its first riser's face, at
 *                 the flight's outer edge (the side away from the turn)
 *   direction     travel of the first flight: '+x', '-x', '+z' or '-z'
 *   across        the side the stair turns or widens to ('+x' ...), across the first flight
 *   layout        'switchback' | 'l' | 'straight'
 *   clearWidth    between stringers (>= 0.914); going (tread depth); split: risers in the first flight
 * Returns { flights, landings, void (rects that must be open above for headroom),
 * route (walking waypoints), width, rise, going, risers }.
 */
export function planStair({y0,y1,origin=[0,0],direction='+x',across,layout='switchback',clearWidth=Z.clearWidth,going=Z.going,split,gap=Z.gap,maxRiser=CODE.maxRiser}){
 if(!['switchback','l','straight'].includes(layout))throw Error(`layout ${layout}: switchback, l or straight`);
 const rise=y1-y0,N=riserCount(rise,maxRiser),R=rise/N,T=going,Wl=clearWidth+2*Z.stringer;
 const N1=split??Math.ceil(N/2),N2=N-N1;
 if(N1<2||N2<2)throw Error(`split ${N1}/${N2}: each flight needs two risers`);
 const du=vec(direction),dv=vec(across??(du[0]?'+z':'+x'));
 if(du[0]*dv[0]+du[1]*dv[1]!==0)throw Error('across must be perpendicular to direction');
 const world=(u,v)=>[origin[0]+u*du[0]+v*dv[0],origin[1]+u*du[1]+v*dv[1]];
 const head=n=>(n-1)*T+Z.riser,reach=footReach(R,T),footLen=reach+Z.riser,depth=Math.max(Wl,CODE.minLanding);
 const yL=y0+N1*R,h1=head(N1);
 // Flights in local (u, v): the first riser's face at the lane centre, and the travel direction.
 let f2,landing;
 if(layout==='straight'){landing={u:[h1,h1+depth+footLen],v:[0,Wl]};f2={at:[h1+depth,Wl/2],t:[1,0]};}
 else if(layout==='switchback'){landing={u:[h1,h1+depth+footLen],v:[0,2*Wl+gap]};f2={at:[h1+footLen,Wl+gap+Wl/2],t:[-1,0]};}
 else{landing={u:[h1,h1+Wl],v:[0,depth+footLen]};f2={at:[h1+Wl/2,depth],t:[0,1]};}
 const toWorldDir=([a,b])=>[a*du[0]+b*dv[0],a*du[1]+b*dv[1]];
 const flight=(id,at,t,n,base,top)=>({id,foot:world(...at),travel:toWorldDir(t),risers:n,rise:R,going:T,base,top,head:head(n),width:Wl,clearWidth});
 const flights=[flight('lower',[0,Wl/2],[1,0],N1,y0,yL),flight('upper',f2.at,f2.t,N2,yL,y1)];
 const rect=(us,vs)=>{const p=[world(us[0],vs[0]),world(us[1],vs[1])];return {x0:Math.min(p[0][0],p[1][0]),x1:Math.max(p[0][0],p[1][0]),z0:Math.min(p[0][1],p[1][1]),z1:Math.max(p[0][1],p[1][1])};};
 // Rims run across the first flight; a switchback's well (between its flights) gets a post under each rim.
 const well=layout==='switchback'?world(0,Wl+gap/2)[du[0]?1:0]:null;
 const landings=[{...rect(landing.u,landing.v),level:yL,base:y0,rimAxis:du[0]?'z':'x',well}];
 const plan={layout,y0,y1,rise,risers:N,riser:R,going:T,clearWidth,width:Wl,split:[N1,N2],flights,landings,footLen,landingDepth:depth,du,dv};
 plan.route=routeOf(plan);
 return plan;
}

/** A flight's point at travel s, lateral q from its centreline. */
export function flightPoint(f,s,q=0){const [tx,tz]=f.travel;return [f.foot[0]+s*tx-q*tz,f.foot[1]+s*tz+q*tx];}
/** The world rect of a flight's lane between travel s0 and s1. */
export function laneRect(f,s0,s1,half=f.width/2){
 const a=flightPoint(f,s0,-half),b=flightPoint(f,s1,half);
 return {x0:Math.min(a[0],b[0]),x1:Math.max(a[0],b[0]),z0:Math.min(a[1],b[1]),z1:Math.max(a[1],b[1])};
}

/** Walking waypoints (centre of the player's feet): foot, landing, head, onto the floor above. */
function routeOf(plan){
 const [f1,f2]=plan.flights,L=plan.landings[0],r=[],depth=plan.landingDepth;
 const at=(name,[x,z],y)=>r.push({name,at:[x,y,z]});
 at('stair-foot',flightPoint(f1,-.45),f1.base);
 at('lower-flight',flightPoint(f1,f1.head/2),f1.base+f1.rise*f1.risers/2);
 if(plan.layout==='switchback'){
  at('landing-arrive',flightPoint(f1,f1.head+plan.footLen+depth*.5),L.level);
  at('landing-turn',flightPoint(f2,-depth*.5),L.level);
 }else if(plan.layout==='l')at('landing-arrive',flightPoint(f1,f1.head+f1.width/2),L.level);
 else at('landing-arrive',flightPoint(f1,f1.head+depth*.5),L.level);
 at('upper-foot',flightPoint(f2,-.3),f2.base);
 at('upper-flight',flightPoint(f2,f2.head/2),f2.base+f2.rise*f2.risers/2);
 at('stair-head',flightPoint(f2,f2.head+.45),f2.top);
 return r;
}

/**
 * The code and the controller, checked: a list of failures (empty when the
 * stair is good). planStair() output only; checkHeadroom() measures headroom.
 */
export function checkStair(plan,{controller=CONTROLLER}={}){
 const out=[],R=plan.riser,T=plan.going,fail=(ok,msg)=>{if(!ok)out.push(msg);};
 fail(R<=CODE.maxRiser+1e-9,`riser ${(R*1e3).toFixed(1)} mm over the ${CODE.maxRiser*1e3} mm maximum (IRC R311.7.5.1)`);
 fail(T>=CODE.minGoing-1e-9,`going ${(T*1e3).toFixed(0)} mm under the ${CODE.minGoing*1e3} mm minimum (IRC R311.7.5.2)`);
 fail(Z.nosing>=CODE.nosing[0]&&Z.nosing<=CODE.nosing[1],'nosing outside 19-32 mm (IRC R311.7.5.3)');
 fail(2*R+T>=CODE.stepRule[0]-1e-9&&2*R+T<=CODE.stepRule[1]+1e-9,`2R + T ${((2*R+T)*1e3).toFixed(0)} mm outside ${CODE.stepRule.map(x=>x*1e3).join('-')} (DIN 18065)`);
 fail(plan.clearWidth>=CODE.minWidth,`clear width ${plan.clearWidth} under ${CODE.minWidth} (IRC R311.7.1)`);
 for(const f of plan.flights)fail(f.rise*f.risers<=CODE.maxFlightRise,`${f.id} flight rises ${(f.rise*f.risers).toFixed(2)} m without a landing (IBC 1011.8)`);
 for(const f of plan.flights)fail(Math.abs(f.rise-R)<1e-9,`${f.id} flight's risers differ from the stair's`);
 // The landing in each flight's direction of travel, from where it arrives / to where it leaves.
 const L=plan.landings[0],[f1,f2]=plan.flights;
 const along=(f,a,b)=>Math.abs((b[0]-a[0])*f.travel[0]+(b[1]-a[1])*f.travel[1]);
 const corner=(f,sign)=>{const xs=[L.x0,L.x1],zs=[L.z0,L.z1];return [f.travel[0]>0?xs[sign>0?1:0]:f.travel[0]<0?xs[sign>0?0:1]:0,f.travel[1]>0?zs[sign>0?1:0]:f.travel[1]<0?zs[sign>0?0:1]:0];};
 const d1=along(f1,flightPoint(f1,f1.head),corner(f1,1)),d2=along(f2,corner(f2,-1),f2.foot);
 const need=Math.max(plan.clearWidth,CODE.minLanding);
 fail(d1>=need-1e-6,`landing ${d1.toFixed(3)} m deep for the lower flight, under ${need} (IRC R311.7.6)`);
 fail(d2>=need-1e-6,`landing ${d2.toFixed(3)} m deep for the upper flight, under ${need} (IRC R311.7.6)`);
 // The player.
 fail(R<=controller.maxStep,`riser ${R.toFixed(3)} m over the controller's ${controller.maxStep} m step`);
 fail(T>=controller.minStepWidth,`going ${T.toFixed(3)} m under the controller's ${controller.minStepWidth} m step width`);
 fail(Math.atan2(R,T)*180/Math.PI<=controller.maxSlopeDegrees,`pitch ${(Math.atan2(R,T)*180/Math.PI).toFixed(1)} over the controller's walkable ${controller.maxSlopeDegrees} degrees`);
 fail(plan.clearWidth>=2*(controller.radius+controller.offset),`clear width ${plan.clearWidth} under the capsule's ${2*(controller.radius+controller.offset)}`);
 fail(CODE.headroom>=controller.height,`code headroom under the capsule's ${controller.height} m`);
 return out;
}

/**
 * The floor void headroom needs: each flight's lane from where the nosing line
 * plus 2032 mm reaches `underside` (the lowest face of the floor above) to its
 * head, and every landing whose level plus 2032 mm does. World rects.
 */
export function requiredVoid(plan,underside){
 const out=[];
 for(const f of plan.flights){
  if(f.top<=underside-CODE.headroom-1e-9&&f.base<=underside-CODE.headroom)continue;
  const s=Math.max(-Z.nosing,(underside-CODE.headroom-f.base-f.rise)*f.going/f.rise-Z.nosing);
  if(s<f.head)out.push({...laneRect(f,s,f.head),flight:f.id});
 }
 for(const L of plan.landings)if(L.level+CODE.headroom>underside)out.push({x0:L.x0,x1:L.x1,z0:L.z0,z1:L.z1,landing:true});
 return out;
}

/**
 * Headroom as framed: the clearance over every flight's nosing line (across
 * its clear width) and every landing, to `underside` wherever the point is not
 * under one of `openings` (world rects), and to `ceiling` (the storey above's)
 * where it is. Returns { min, failures }.
 */
export function checkHeadroom(plan,{underside,ceiling=Infinity,openings=[]}){
 const inside=(x,z)=>openings.some(o=>x>o.x0+1e-6&&x<o.x1-1e-6&&z>o.z0+1e-6&&z<o.z1-1e-6);
 let min=Infinity;const failures=[];
 const probe=(x,z,y,what)=>{const h=(inside(x,z)?ceiling:underside)-y;if(h<min)min=h;if(h<CODE.headroom-1e-6&&failures.length<8)failures.push(`${what} at (${x.toFixed(2)}, ${z.toFixed(2)}): ${h.toFixed(3)} m`);};
 for(const f of plan.flights){
  const {nose}=stringerLines(f);
  for(let s=-Z.nosing;s<=f.head+1e-9;s+=.01)for(const q of [-.5,0,.5].map(k=>k*f.clearWidth))probe(...flightPoint(f,s,q),Math.max(f.base,nose(s)),`${f.id} flight`);
 }
 for(const L of plan.landings)for(let x=L.x0+.02;x<L.x1;x+=.05)for(let z=L.z0+.02;z<L.z1;z+=.05)probe(x,z,L.level,'landing');
 return {min,failures};
}

/** Clip a convex polygon [[a,b],...] to the half-plane n.p >= c. */
function clip(poly,n,c){
 const out=[],d=p=>n[0]*p[0]+n[1]*p[1]-c;
 for(let i=0;i<poly.length;i++){const p=poly[i],q=poly[(i+1)%poly.length],dp=d(p),dq=d(q);
  if(dp>=0)out.push(p);if(dp*dq<0){const t=dp/(dp-dq);out.push([p[0]+t*(q[0]-p[0]),p[1]+t*(q[1]-p[1])]);}}
 return out;
}

/**
 * Build a planned stair's timber. `box(type,min,max,{pieceId,material,split})`
 * and `prism(type,axis,lo,hi,poly,{pieceId,material})` are the building's own
 * member functions (they return node indices or member records);
 * `nextPiece()` a fresh piece id. `materials`: {timber, deck}.
 * Each flight's head is hung from a support the building provides (a trimmer
 * or header face at flight.head), except where it lands on this stair's landing.
 */
export function buildTimberStair(plan,{box,prism,nextPiece,materials}){
 const T=Z,members=[];
 const add=(m,role)=>{members.push({...m,role});return m;};
 for(const f of plan.flights){
  const {rise:R,going:G}=f,lines=stringerLines(f),half=f.clearWidth/2;
  // Boxes in flight coordinates (s along travel, q across, y up).
  const fbox=(type,s0,s1,q0,q1,y0,y1,opt={})=>{
   const a=flightPoint(f,s0,q0),b=flightPoint(f,s1,q1);
   return add(box(type,[Math.min(a[0],b[0]),y0,Math.min(a[1],b[1])],[Math.max(a[0],b[0]),y1,Math.max(a[1],b[1])],{material:materials.timber,...opt}),type);
  };
  for(let j=1;j<=f.risers;j++){
   const s=(j-1)*G,top=j<f.risers?f.base+j*R-T.tread:f.top;
   fbox('stair-riser',s,s+T.riser,-half,half,f.base+(j-1)*R,top);
   if(j<f.risers)fbox('stair-tread',s-T.nosing,j*G+T.riser,-half,half,f.base+j*R-T.tread,f.base+j*R);
  }
  // Stringers: the strip along the nosing line, cut level at the floor it starts on and at
  // the level it climbs to, plumb at the foot and at the head; two or three pieces.
  const s0=-T.nosing-.02,s1=f.head;
  let poly=[[s0,lines.bottom(s0)],[s1,lines.bottom(s1)],[s1,lines.top(s1)],[s0,lines.top(s0)]];
  poly=clip(poly,[0,1],f.base);poly=clip(poly,[0,-1],-f.top);
  const length=(s1-s0)/lines.cos,pieces=Math.max(2,Math.min(3,Math.ceil(length/1.25)));
  const cuts=Array.from({length:pieces+1},(_,k)=>s0+(s1-s0)*k/pieces);
  const alongX=f.travel[0]!==0,sign=alongX?f.travel[0]:f.travel[1];
  for(const q of [-half-T.stringer,half]){
   const pieceId=nextPiece();
   for(let k=0;k<pieces;k++){
    let p=clip(clip(poly,[1,0],cuts[k]),[-1,0],-cuts[k+1]);
    // Into world: the prism's axis is across the flight; its polygon is (x, y) or (y, z).
    const at=s=>flightPoint(f,s,0)[alongX?0:1];
    const lat=[flightPoint(f,0,q)[alongX?1:0],flightPoint(f,0,q+T.stringer)[alongX?1:0]];
    let pts=p.map(([s,y])=>alongX?[at(s),y]:[y,at(s)]);
    if(sign<0===alongX)pts=pts.reverse();
    add(prism('stair-stringer',alongX?'z':'x',Math.min(...lat),Math.max(...lat),pts,{pieceId,material:materials.timber}),'stair-stringer');
   }
  }
 }
 for(const L of plan.landings)landingFrame(L);
 function landingFrame(L){
  // Rims across the flights at the landing's two ends (along `rimAxis`), joists between, deck on top, posts under the rims.
  const top=L.level-T.deck,rimLo=top-T.rimDepth,joistLo=top-T.joistDepth,alongZ=L.rimAxis==='z';
  const [a0,a1]=alongZ?[L.x0,L.x1]:[L.z0,L.z1],[b0,b1]=alongZ?[L.z0,L.z1]:[L.x0,L.x1];
  const B=(type,ua,ub,va,vb,y0,y1,opt={})=>add(box(type,alongZ?[ua,y0,va]:[va,y0,ua],alongZ?[ub,y1,vb]:[vb,y1,ub],{material:materials.timber,...opt}),type);
  B('landing-rim',a0,a0+T.rim,b0,b1,rimLo,top);B('landing-rim',a1-T.rim,a1,b0,b1,rimLo,top);
  const n=Math.max(2,Math.ceil((b1-b0-T.joist)/T.joistSpacing))+1;
  for(let k=0;k<n;k++){const v=b0+(b1-b0-T.joist)*k/(n-1);B('landing-joist',a0+T.rim,a1-T.rim,v,v+T.joist,joistLo,top);}
  B('landing-deck',a0,a1,b0,b1,top,L.level,{material:materials.deck,split:alongZ?[1,1,Math.max(1,Math.round((b1-b0)/1.1))]:[Math.max(1,Math.round((b1-b0)/1.1)),1,1]});
  // Posts at the corners and, over 1.8 m, at mid-span (the switchback's well).
  const vs=[b0,b1-T.post];if(b1-b0>1.8)vs.push((L.well??(b0+b1)/2)-T.post/2);
  for(const u of [a0,a1-T.post])for(const v of vs)B('landing-post',u,u+T.post,v,v+T.post,L.base,rimLo);
 }
 return members;
}

/**
 * The connection kind joining two node types where at least one is a stair's
 * (STAIR_CONNECTIONS), `null` for contacts nothing fixes, `undefined` when
 * neither is a stair type. `normal`: the bond's ({x,y,z}); a stringer's or
 * riser's end against a support is a hanger or face fixing, its underside on a
 * floor a foot.
 */
export function stairConnection(ta,tb,normal={x:0,y:1,z:0}){
 const stair=new Set(STAIR_TYPES);if(!stair.has(ta)&&!stair.has(tb))return undefined;
 const has=(x,y)=>(ta===x&&tb===y)||(ta===y&&tb===x),one=t=>ta===t||tb===t,vertical=Math.abs(normal.y)>.5;
 const support=t=>['trimmer-joist','header-joist','floor-joist','rim-joist','landing-rim'].includes(t);
 const other=t=>ta===t?tb:ta;
 if(has('stair-tread','stair-stringer'))return 'tread-housing';
 if(has('stair-riser','stair-stringer'))return 'riser-housing';
 if(has('stair-riser','stair-tread'))return 'riser-tread';
 if(one('stair-riser')){const o=other('stair-riser');
  if(vertical&&['foundation','landing-deck','subfloor'].includes(o))return 'riser-tread';
  if(!vertical&&support(o))return 'riser-back';
  return null;}
 if(one('stair-stringer')){const o=other('stair-stringer');
  if(!vertical&&support(o))return 'stair-hanger';
  if(vertical&&['foundation','landing-deck'].includes(o))return 'stair-foot';
  return null;}
 if(has('landing-deck','landing-rim')||has('landing-deck','landing-joist'))return 'landing-deck';
 if(has('landing-joist','landing-rim'))return 'landing-joist';
 if(one('landing-post')){const o=other('landing-post');return o==='foundation'?'post-base':['landing-rim','landing-joist'].includes(o)?'post-cap':null;}
 return null;
}

/** The housing joints' shear: the tread or riser bearing on the housing's ledge (f_c,90,k x 12 mm x its depth). */
export function housingShear(plan){return {'tread-housing':BEARING.compression*Z.housing*(plan.going+Z.nosing+Z.riser),'riser-housing':BEARING.compression*Z.housing*(plan.riser-Z.tread)};}

/**
 * Frame a rectangular floor opening in joists running along `axis` ('z' or
 * 'x'). `joists`: each line's [lo, hi] across; `span`: [lo, hi] along, where
 * the joists bear; `opening` {x0,x1,z0,z1}: the hole, whose two sides across
 * the joists fall on joist faces (those joists become the trimmers, doubled on
 * their far side). Returns the members: trimmers (doubled, full span), headers
 * (doubled, between the trimmers, outside the hole, wherever the hole stops
 * short of a span end) and the tails (the cut joists, from header to bearing),
 * and the joist lines that keep their ordinary joist. IRC R502.10.
 */
export function frameFloorOpening({axis='z',joists,span,opening,ply=.045}){
 const along=axis==='z'?[opening.z0,opening.z1]:[opening.x0,opening.x1],across=axis==='z'?[opening.x0,opening.x1]:[opening.z0,opening.z1],EPS=1e-6;
 const lo=joists.findIndex(([,h])=>Math.abs(h-across[0])<1e-4),hi=joists.findIndex(([l])=>Math.abs(l-across[1])<1e-4);
 if(lo<0||hi<0)throw Error(`opening sides ${across.map(x=>x.toFixed(4))} not on joist faces`);
 const trimmers=[[joists[lo][0]-ply,joists[lo][1]],[joists[hi][0],joists[hi][1]+ply]].map(c=>({across:c,along:span}));
 const headers=[];
 if(along[0]>span[0]+EPS)headers.push({across,along:[along[0]-2*ply,along[0]]});
 if(along[1]<span[1]-EPS)headers.push({across,along:[along[1],along[1]+2*ply]});
 const tails=[],kept=[];
 joists.forEach((c,i)=>{
  if(i===lo||i===hi)return;
  if(c[1]<=across[0]+EPS||c[0]>=across[1]-EPS){kept.push(i);return;}
  if(along[0]>span[0]+EPS)tails.push({across:c,along:[span[0],along[0]-2*ply],line:i});
  if(along[1]<span[1]-EPS)tails.push({across:c,along:[along[1]+2*ply,span[1]],line:i});
 });
 return {trimmers,headers,tails,kept,trimmerLines:[lo,hi]};
}
