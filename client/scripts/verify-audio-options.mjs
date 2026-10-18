import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../public/audio/options/', import.meta.url));
const slots = ['masonryImpact','masonryCollapse','metalImpact','metalCollapse','projectileFlyby','debrisFlyby','massiveFlyby'];
export const db = x => 20 * Math.log10(Math.max(1e-12, x));
export function measure(a, rate = 48000) {
  let peak = 0, sum = 0, squares = 0;
  const frames = [], n = Math.round(rate * .02);
  for (let base = 0; base < a.length; base += n) {
    let energy = 0; const count = Math.min(n, a.length - base);
    for (let j = 0; j < count; j++) { const x = a[base+j]; peak = Math.max(peak,Math.abs(x)); sum += x; squares += x*x; energy += x*x; }
    frames.push({ rms: Math.sqrt(energy / count), energy, count, center: (base + count/2) / rate });
  }
  const loudest = frames.reduce((a,b) => a.rms > b.rms ? a : b), gate = Math.max(.003,loudest.rms * .125);
  const active = frames.filter(f => f.rms >= gate);
  const activeRms = Math.sqrt(active.reduce((s,f) => s+f.energy,0) / active.reduce((s,f) => s+f.count,0));
  return { peak, rms: Math.sqrt(squares/a.length), activeRms, dc: sum/a.length, peakAtSeconds: loudest.center,
    edgeJump: Math.abs(a[0]-a[a.length-1]), activeSeconds: active.reduce((s,f)=>s+f.count,0)/rate };
}
function wav(bytes) {
  assert.equal(bytes.toString('ascii',0,4),'RIFF'); assert.equal(bytes.toString('ascii',8,12),'WAVE');
  let rate,channels,bits,format,a;
  for(let at=12;at+8<=bytes.length;) {
    const id=bytes.toString('ascii',at,at+4),n=bytes.readUInt32LE(at+4),start=at+8;
    assert.ok(start+n<=bytes.length,'Truncated WAV');
    if(id==='fmt ') { format=bytes.readUInt16LE(start);channels=bytes.readUInt16LE(start+2);rate=bytes.readUInt32LE(start+4);bits=bytes.readUInt16LE(start+14); }
    if(id==='data') { a=new Float32Array(n/2); for(let i=0;i<a.length;i++)a[i]=bytes.readInt16LE(start+i*2)/32768; }
    at=start+n+(n%2);
  }
  assert.equal(format,1);assert.equal(bits,16);assert.equal(channels,1);assert.equal(rate,48000);assert.ok(a?.length);
  return a;
}
export function verify() {
  // Calibration catches regressions in the loudness matcher itself.
  const tone=Float32Array.from({length:48000},(_,i)=>.2*Math.sin(2*Math.PI*1000*i/48000));
  assert.ok(Math.abs(measure(tone).activeRms-Math.SQRT1_2*.2)<1e-6);
  const catalog=JSON.parse(fs.readFileSync(root+'catalog.json','utf8'));
  const expected=slots.flatMap(s=>[s+'-natural',s+'-designed']);
  assert.deepEqual(Object.keys(catalog.clips).sort(),expected.sort());
  const sources=new Set(catalog.sources.map(s=>s.id)), hashes=new Set(),report={ clips:{},transferBytes:0,decodedBytes:0 };
  for(const [id,c] of Object.entries(catalog.clips)) {
    assert.ok(c.url.startsWith('/audio/options/')&&!c.url.includes('..'));
    assert.ok(['recorded','hybrid','synth'].includes(c.origin));assert.ok(c.sources.length>0);
    c.sources.forEach(s=>assert.ok(sources.has(s),`${id}: unknown source ${s}`));
    const bytes=fs.readFileSync(root+c.url.split('/').at(-1)),hash=createHash('sha256').update(bytes).digest('hex');
    assert.equal(hash,c.sha256,`${id}: checksum`);assert.ok(!hashes.has(hash),`${id}: duplicate audio`);hashes.add(hash);
    const a=wav(bytes),m=measure(a),duration=a.length/48000;
    assert.ok(Math.abs(duration-c.duration)<1/48000,`${id}: duration`);
    assert.ok(m.peak<=.881&&m.peak>.05,`${id}: headroom/silence`);
    assert.ok(Math.abs(m.dc)<.003,`${id}: DC`);
    assert.ok(m.activeRms>.035&&m.activeRms<.17,`${id}: active level`);
    assert.equal(c.loop,id.includes('Collapse'));
    if(c.loop) {assert.ok(duration>=5&&duration<=9);assert.ok(m.edgeJump<.04,`${id}: loop edge jump`);}
    else {assert.ok(duration>.1&&duration<4);assert.ok(Math.abs(a[0])<.002&&Math.abs(a.at(-1))<.002,`${id}: boundary click`);}
    if(id.includes('Flyby')) {
      assert.ok(c.passAtSeconds>=.18&&c.passAtSeconds<=.36,`${id}: pass location`);
      assert.ok(Math.abs(m.peakAtSeconds-c.passAtSeconds)<=.021,`${id}: peak/pass alignment`);
    }
    report.clips[id]={duration,origin:c.origin,peakDb:db(m.peak),rmsDb:db(m.rms),activeRmsDb:db(m.activeRms),activeSeconds:m.activeSeconds,dc:m.dc,edgeJump:m.edgeJump,...(c.passAtSeconds?{passAtSeconds:c.passAtSeconds}:{})};
    report.transferBytes+=bytes.length;report.decodedBytes+=a.length*4;
  }
  for(const slot of slots)assert.ok(Math.abs(report.clips[slot+'-natural'].activeRmsDb-report.clips[slot+'-designed'].activeRmsDb)<.3,`${slot}: comparison loudness mismatch`);
  assert.ok(report.transferBytes<10*1024*1024,'Download budget');assert.ok(report.decodedBytes<32*1024*1024,'Decoded budget');
  if(process.argv.includes('--report'))fs.writeFileSync(root+'quality-report.json',JSON.stringify(report,null,2)+'\n');
  console.log(`PASS: 14 unique options; ${(report.transferBytes/1048576).toFixed(2)} MiB transfer; ${(report.decodedBytes/1048576).toFixed(2)} MiB decoded; seven loudness-matched pairs.`);
  return report;
}
if(process.argv[1]===fileURLToPath(import.meta.url))verify();
