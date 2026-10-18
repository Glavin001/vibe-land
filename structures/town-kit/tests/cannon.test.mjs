import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cannonShot,cannonApi} from '../scripts/cannon.mjs';
import {Readable,Writable} from 'node:stream';

const input={asset:'tree-shade-0',from:[0,1,-6],to:[0,2.5,0],mass:100,speed:15};
test('physical ball mass, launch position and gravity-compensated aim agree',()=>{
 const shot=cannonShot(input),time=6/(shot.direction[2]*shot.speed);
 assert.ok(Math.abs(shot.momentum/shot.speed-input.mass)<1e-9);
 assert.ok(Math.abs(shot.radius**3*4/3*Math.PI*7850-input.mass)<1e-8);
 assert.ok(Math.abs(input.from[1]+shot.direction[1]*shot.speed*time-.5*9.81*time*time-input.to[1])<1e-9);
 for(let i=0;i<3;i++)assert.ok(Math.abs(shot.from[i]-shot.direction[i]*(shot.radius+.05)-input.from[i])<1e-9);
});
test('invalid assets, vectors, excessive forces and unreachable targets are rejected',()=>{
 for(const patch of [{asset:'../../file'},{asset:'bayline-outdoor-town'},{from:[NaN,1,0]},{mass:0},{mass:5001},{speed:Infinity},{speed:61},{speed:30},{to:[0,99,0]},{from:[0,-1,-6]},{to:[0,30,0],speed:5}])assert.throws(()=>cannonShot({...input,...patch}));
});
test('cannon API rejects cross-origin requests and malformed input before native launch',async()=>{
 const handler=cannonApi('/unused');
 async function request(headers,body='{}',url='/jobs',method='POST'){
  const req=Readable.from([body]);Object.assign(req,{headers:{host:'127.0.0.1:6174','content-type':'application/json',...headers},method,url});
  let output='';const res=new Writable({write(c,_,done){output+=c;done();}});res.setHeader=()=>{};
  await handler(req,res);return {status:res.statusCode,body:JSON.parse(output)};
 }
 assert.equal((await request({origin:'https://elsewhere.example'})).status,403);
 assert.equal((await request({'sec-fetch-site':'cross-site'})).status,403);
 assert.equal((await request({'content-type':'text/plain'})).status,415);
 assert.equal((await request({},'{invalid')).status,400);
 assert.equal((await request({},'x'.repeat(4097))).status,413);
 assert.equal((await request({},'{}')).status,400);
 assert.equal((await request({},'', '/jobs/aaaaaaaa','GET')).status,404);
});
