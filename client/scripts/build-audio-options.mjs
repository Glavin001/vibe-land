// Optional audition palette. Original runtime palette is never modified.
// node client/scripts/build-audio-options.mjs [--fetch | /path/to/source-cache]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { measure } from './verify-audio-options.mjs';

const sha = b => createHash('sha256').update(b).digest('hex');
const rate=48000, root=fileURLToPath(new URL('../public/audio/options/',import.meta.url));
const cache=process.argv[2]&&process.argv[2]!=='--fetch'?path.resolve(process.argv[2]):path.join(os.tmpdir(),'vibe-audio-options-sources');
const sources=[
  {id:'bricks',title:'Bricks.wav',creator:'cejordi84',url:'https://freesound.org/people/cejordi84/sounds/232396/',license:'CC0 1.0',format:'Public HQ MP3 preview of the recording',download:'https://cdn.freesound.org/previews/232/232396_3270296-hq.mp3',file:'bricks.mp3',sha256:'43860aaa1bb1eadf0a588276a2e6ca66709abd03e773f6ba8b44e69a85e6159b'},
  {id:'rockslide',title:'rock slide.wav',creator:'21100495',url:'https://freesound.org/people/21100495/sounds/655368/',license:'CC0 1.0',format:'Public HQ MP3 preview of recorded rock layers',download:'https://cdn.freesound.org/previews/655/655368_13723333-hq.mp3',file:'rockslide.mp3',sha256:'fa9331415d4a31d11b6615faaf0e70decac8c8eaea33224ab3b8cae7109e0e1e'},
  {id:'rocks',title:'rockfall2a.wav',creator:'AlanCat',url:'https://freesound.org/people/AlanCat/sounds/389303/',license:'CC0 1.0',format:'Public HQ MP3 preview; real cliff rockfall, background-noise cleanup only',download:'https://cdn.freesound.org/previews/389/389303_5486695-hq.mp3',file:'cliff.mp3',sha256:'db15885029d027756ef2b90114c202f4837f10a128371f493904b4886818ffcd'},
  {id:'swishes',title:'Swishes Sound Pack',creator:'artisticdude',url:'https://opengameart.org/content/swishes-sound-pack',license:'CC0 1.0',format:'Original WAV pack; hanger and wood swung past microphone',download:'https://opengameart.org/sites/default/files/swishes.zip',file:'swishes.zip',sha256:'7980215241b739a787dcf26f660ce510bb237900968789395a86911619795693',extract:'swishes'},
  {id:'metalwood',title:'100 CC0 metal and wood SFX',creator:'rubberduck',url:'https://opengameart.org/content/100-cc0-metal-and-wood-sfx',license:'CC0 1.0',format:'Original OGG pack',download:'https://opengameart.org/sites/default/files/100-CC0-wood-metal-SFX.zip',file:'metalwood.zip',sha256:'be6eba63b03409ac0c77787a956b1503a7c186403d04aef9725c52644a4b7878',extract:'metalwood'},
];
fs.mkdirSync(cache,{recursive:true});fs.mkdirSync(root,{recursive:true});
for(const source of sources) {
  const file=path.join(cache,source.file);
  if(!fs.existsSync(file)&&process.argv[2]==='--fetch') {
    const response=await fetch(source.download,{signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw Error(`Download ${source.id}: ${response.status}`);
    const data=Buffer.from(await response.arrayBuffer());
    if(sha(data)!==source.sha256)throw Error(`Source changed: ${source.id}`);
    fs.writeFileSync(file,data);
  }
  if(!fs.existsSync(file)||sha(fs.readFileSync(file))!==source.sha256)throw Error(`Missing/changed ${source.file}; run with --fetch`);
  if(source.extract) {
    const result=spawnSync('unzip',['-oq',file,'-d',path.join(cache,source.extract)],{timeout:15000});
    if(result.status!==0)throw Error(String(result.stderr));
  }
}
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'vibe-options-render-'));
process.on('exit',()=>fs.rmSync(scratch,{recursive:true,force:true}));
const decoded=new Map(),sourceFiles={},clips={},recipes={};
function read(file) {
  if(decoded.has(file))return decoded.get(file);
  const full=path.join(cache,file);sourceFiles[file]=sha(fs.readFileSync(full));
  const raw=path.join(scratch,'decode.f32');
  const result=spawnSync('ffmpeg',['-nostdin','-v','error','-threads','1','-y','-i',full,'-ac','1','-ar',String(rate),'-f','f32le',raw],{timeout:20000});
  if(result.status!==0)throw Error(String(result.stderr));
  const bytes=fs.readFileSync(raw),a=new Float32Array(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
  decoded.set(file,a);return a;
}
const swish = n => read(`swishes/swishes/swish-${n}.wav`);
const metal = name => read(`metalwood/${name}.ogg`);
const buffer = seconds => new Float32Array(Math.round(seconds*rate));
function add(a,b,at=0,gain=1,speed=1) {
  const start=Math.round(at*rate);
  for(let i=Math.max(0,-start);start+i<a.length&&i*speed<b.length-1;i++) {
    const p=i*speed,k=Math.floor(p),f=p-k;a[start+i]+=gain*(b[k]*(1-f)+b[k+1]*f);
  }
}
function trim(a) {
  const peak=measure(a).peak,gate=peak*.004;let first=0,last=a.length-1;
  while(first<last&&Math.abs(a[first])<gate)first++;
  while(last>first&&Math.abs(a[last])<gate)last--;
  return a.slice(Math.max(0,first-96),Math.min(a.length,last+960));
}
function band(a,low,high) {
  const out=new Float32Array(a.length),ha=1-Math.exp(-2*Math.PI*high/rate),la=1-Math.exp(-2*Math.PI*low/rate);
  let lp=0,hp=0;for(let i=0;i<a.length;i++){lp+=ha*(a[i]-lp);hp+=la*(lp-hp);out[i]=lp-hp;}return out;
}
function shape(a,attack=.002,tail=.025) {
  const out=new Float32Array(a.length);
  for(let i=0;i<a.length;i++)out[i]=a[i]*Math.min(1,i/(attack*rate),(a.length-1-i)/(tail*rate));
  return out;
}
function seam(a) {
  const n=Math.round(.25*rate),out=a.slice(n);
  for(let i=0;i<n;i++){const f=i/(n-1),k=out.length-n+i;out[k]=a[a.length-n+i]*Math.cos(f*Math.PI/2)+a[i]*Math.sin(f*Math.PI/2);}
  // Rotate the finished period to a quiet, low-slope boundary. This preserves
  // every sample and avoids placing a normal steep metal waveform at the join.
  let cut=1,best=Infinity;
  for(let i=1;i<Math.min(out.length,rate*.125);i++){const score=Math.abs(out[i])+Math.abs(out[i]-out[i-1])*3;if(score<best){cut=i;best=score;}}
  const rotated=new Float32Array(out.length);rotated.set(out.subarray(cut));rotated.set(out.subarray(0,cut),out.length-cut);return rotated;
}
function clean(a,loop) {
  a=loop?seam(a):shape(a);
  // A constant DC correction does not add an artificial room or change timbre.
  const mean=a.reduce((s,x)=>s+x,0)/a.length;
  for(let i=0;i<a.length;i++)a[i]-=mean;
  return loop?a:shape(a);
}
function wav(a) {
  const out=Buffer.alloc(44+a.length*2);out.write('RIFF');out.writeUInt32LE(out.length-8,4);out.write('WAVE',8);out.write('fmt ',12);out.writeUInt32LE(16,16);out.writeUInt16LE(1,20);out.writeUInt16LE(1,22);out.writeUInt32LE(rate,24);out.writeUInt32LE(rate*2,28);out.writeUInt16LE(2,32);out.writeUInt16LE(16,34);out.write('data',36);out.writeUInt32LE(a.length*2,40);
  for(let i=0;i<a.length;i++)out.writeInt16LE(Math.round(Math.max(-1,Math.min(1,a[i]))*32767),44+i*2);return out;
}
function pair(slot,natural,designed,info) {
  const loop=slot.endsWith('Collapse'),arrays=[clean(natural,loop),clean(designed,loop)],measurements=arrays.map(a=>measure(a));
  // Preserve uncompressed natural transients. Both alternatives use the same
  // feasible active-RMS target, limited by the peak of the crestier recording.
  const target=Math.min(.126,...measurements.map(m=>.88*m.activeRms/m.peak));
  for(let i=0;i<2;i++) {
    const kind=i?'designed':'natural',id=`${slot}-${kind}`,a=arrays[i],gain=target/measurements[i].activeRms;
    for(let j=0;j<a.length;j++)a[j]*=gain;
    const bytes=wav(a),file=id+'.wav';fs.writeFileSync(root+file,bytes);
    const metadata=info[kind];clips[id]={url:'/audio/options/'+file,duration:a.length/rate,loop,sha256:sha(bytes),origin:i?'hybrid':'recorded',sources:metadata.sources,description:metadata.description,
      ...(slot.endsWith('Flyby')?{passAtSeconds:measure(a).peakAtSeconds}:{})};
    recipes[id]=metadata.recipe;console.log(`Built ${id}: active RMS ${(20*Math.log10(measure(a).activeRms)).toFixed(2)} dBFS`);
  }
}
const bricks=trim(read('bricks.mp3')),rocks=trim(read('cliff.mp3').slice(0,Math.round(4.2*rate))),slide=read('rockslide.mp3');
const masonry=buffer(1.55);add(masonry,bricks,.005,.35,.75);add(masonry,rocks,.017,.58,.82);add(masonry,band(bricks,80,950),.008,.5,.58);
pair('masonryImpact',bricks,masonry,{
  natural:{sources:['bricks'],description:'Close brick-on-brick crack; source recording with minimal cleanup.',recipe:'Trim cejordi84 Bricks.wav HQ MP3 preview at original pitch; mono/48 kHz, 2 ms edge fade, DC removal and pair loudness match. Source creator already layered two real brick smashes.'},
  designed:{sources:['bricks','rocks'],description:'Brick crack with heavy stone chunks and a short low-mid body.',recipe:'1.55 s: bricks at 5 ms/gain .35/rate .75; first 4.2 s of AlanCat rockfall at 17 ms/.58/.82; 80–950 Hz bricks at 8 ms/.5/.58. No added reverb, delay, noise or oscillator.'},
});
// Preserve a single recorded collapse timeline for the natural alternative.
const naturalSlide=slide.slice(Math.round(.65*rate),Math.round(7.30*rate));
const designedRubble=buffer(6.65);
for(const [t,g,r] of [[-.45,.55,.76],[1.38,.43,.92],[3.47,.57,.68],[5.15,.38,1.05]])add(designedRubble,rocks,t,g,r);
for(const [t,g,r] of [[.35,.16,.85],[1.02,.12,.68],[2.21,.14,.92],[3.04,.18,.65],[4.55,.17,.79],[5.77,.14,.9]])add(designedRubble,bricks,t,g,r);
pair('masonryCollapse',naturalSlide,designedRubble,{
  natural:{sources:['rockslide'],description:'Recorded rock slide with individual chunks and natural gaps.',recipe:'Unpitched 0.65–7.30 s excerpt of 21100495 rock slide; 250 ms seam crossfade gives 6.4 s loop; DC removal and pair level match. No added synthetic sound or room.'},
  designed:{sources:['rocks','bricks'],description:'Dense dry stones tumbling and colliding, with large brick accents.',recipe:'Four AlanCat rockfall layers (first 4.2 s excerpt) at -0.45/1.38/3.47/5.15 s, rates .76/.92/.68/1.05; six brick accents at .35/1.02/2.21/3.04/4.55/5.77 s. 250 ms seam; final 6.4 s. No added reverb, delay, noise or oscillator.'},
});
const designedMetal=buffer(1.15);add(designedMetal,metal('metal_slam_01'),.002,.62,.81);add(designedMetal,metal('metal_sheet_03'),.013,.28,.68);add(designedMetal,band(metal('metal_hit_03'),95,1500),.005,.7,.58);
pair('metalImpact',trim(metal('metal_hit_03')),designedMetal,{
  natural:{sources:['metalwood'],description:'Dry metal strike with the recording’s own short resonance.',recipe:'rubberduck metal_hit_03.ogg, original pitch; trim, mono/48 kHz, DC cleanup, edge fades and pair match only.'},
  designed:{sources:['metalwood'],description:'Heavier metal slam and flexing plate with a compact body.',recipe:'1.15 s: metal_slam_01 at 2 ms/.62/.81; metal_sheet_03 at 13 ms/.28/.68; 95–1500 Hz metal_hit_03 at 5 ms/.7/.58. No added synthetic ringing or room.'},
});
const naturalMetal=buffer(6.65),layeredMetal=buffer(6.65);
for(const [t,g] of [[-.24,.55],[1.05,.72],[2.38,.52],[3.72,.65],[5.14,.64]])add(naturalMetal,metal('metal_falling_01'),t,g,1);
for(const [t,g,r] of [[-.15,.6,.78],[.76,.4,.95],[1.79,.6,.65],[2.7,.48,.9],[3.83,.55,.73],[4.79,.55,.87],[5.8,.43,.71]])add(layeredMetal,metal('metal_falling_02'),t,g,r);
for(const t of [.23,1.45,3.01,4.4,5.61])add(layeredMetal,metal('metal_sheet_06'),t,.15,.71);
pair('metalCollapse',naturalMetal,layeredMetal,{
  natural:{sources:['metalwood'],description:'Unpitched falling metal pieces with sparse clatters.',recipe:'metal_falling_01 at -0.24/1.05/2.38/3.72/5.14 s, original pitch with relative gains .55/.72/.52/.65/.64. Simple recorded-event assembly plus 250 ms loop seam; 6.4 s.'},
  designed:{sources:['metalwood'],description:'Dense, lower metal tumble with intermittent plate flex.',recipe:'Seven metal_falling_02 layers at -0.15/.76/1.79/2.7/3.83/4.79/5.8 s, rates .65–.95; metal_sheet_06 accents at .23/1.45/3.01/4.4/5.61 s at .71 rate. 250 ms loop seam; 6.4 s. No synthetic echo.'},
});
function alignPass(a,pass=.27,duration=.9) {
  const at=measure(a).peakAtSeconds,out=buffer(duration);add(out,a,pass-at);return out;
}
function speed(a,speed) {const out=buffer(a.length/rate/speed);add(out,a,0,1,speed);return out;}
const projectileNatural=alignPass(shape(trim(swish(12))),.23,.58);
const projectileDesigned=buffer(.65);add(projectileDesigned,speed(trim(swish(2)),.82),.17,.85);add(projectileDesigned,band(metal('metal_spring_02'),900,7200),.205,.15,1.9);
pair('projectileFlyby',projectileNatural,alignPass(shape(projectileDesigned,.003,.06),.23,.72),{
  natural:{sources:['swishes'],description:'Very short recorded swish: sharp, close and dry.',recipe:'artisticdude swish-12.wav, original pitch, trimmed and aligned to .23 s active-envelope peak. Recorded hanger/wood Foley; not a recording of a live projectile.'},
  designed:{sources:['swishes','metalwood'],description:'Fast swish with a brief mechanical zing.',recipe:'swish-2 at .82 rate plus 900–7200 Hz metal_spring_02 at 1.9 rate/gain .15; short 60 ms end taper. Shifted to .23 s envelope peak. Source layers only; no synthetic wind or room.'},
});
const debrisNatural=alignPass(speed(trim(swish(7)),.8),.27,.82);
const debrisDesigned=buffer(.85);add(debrisDesigned,speed(trim(swish(9)),.6),.15,.75);add(debrisDesigned,band(bricks,700,6500),.20,.19,1.65);add(debrisDesigned,band(metal('metal_sheet_05'),550,5200),.23,.09,1.12);
pair('debrisFlyby',debrisNatural,alignPass(shape(debrisDesigned,.003,.08),.27,.95),{
  natural:{sources:['swishes'],description:'Rougher recorded object sweep with a broader passing motion.',recipe:'swish-7 at .8 rate; envelope peak shifted to .27 s; mono, DC correction, edge fades and level match. Foley movement proxy, not an actual airborne brick recording.'},
  designed:{sources:['swishes','bricks','metalwood'],description:'Tumbling sweep with granular brick and vibrating shard texture.',recipe:'swish-9 at .6 rate; 700–6500 Hz bricks at 1.65 rate/.19 gain; 550–5200 Hz metal_sheet_05 at 1.12 rate/.09 gain. 80 ms tail taper, peak .27 s. Recorded layers; no reverb or noise bed.'},
});
const massiveNatural=alignPass(speed(trim(swish(3)),.48),.31,1.02);
const massiveDesigned=buffer(1.25);add(massiveDesigned,speed(trim(swish(3)),.33),.07,.7);add(massiveDesigned,band(swish(8),80,1250),.12,1.2,.28);add(massiveDesigned,band(metal('metal_sheet_03'),140,1900),.16,.18,.55);add(massiveDesigned,band(rocks,110,1250),.21,.15,1.8);
pair('massiveFlyby',massiveNatural,alignPass(shape(massiveDesigned,.012,.14),.31,1.30),{
  natural:{sources:['swishes'],description:'Slowed recorded heavy swish, retaining a dry physical sweep.',recipe:'swish-3 at .48 rate; peak aligned to .31 s. The source is swung-object Foley and is explicitly not a meteor recording.'},
  designed:{sources:['swishes','metalwood','rocks'],description:'Broad passing pressure with flexing metal and heavy debris texture.',recipe:'swish-3/.33 rate; 80–1250 Hz swish-8/.28 rate/gain1.2; 140–1900 Hz metal_sheet_03/.55/.18; 110–1250 Hz rocks/1.8/.15. 140 ms tail taper and peak .31 s. All body comes from recordings; no sub oscillator, synthetic noise or reverberation.'},
});
fs.writeFileSync(root+'catalog.json',JSON.stringify({version:1,sampleRate:rate,channels:1,generatorSha256:sha(fs.readFileSync(fileURLToPath(import.meta.url))),clips,sources},null,2)+'\n');
fs.writeFileSync(root+'recipes.json',JSON.stringify(recipes,null,2)+'\n');
fs.writeFileSync(root+'source-files.json',JSON.stringify(sourceFiles,null,2)+'\n');
