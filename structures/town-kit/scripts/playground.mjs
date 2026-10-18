// A dedicated instance of the real city stack. Ctrl-C stops only this instance.
import {spawn} from 'node:child_process';
import {mkdir,writeFile,open} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import net from 'node:net';
import dgram from 'node:dgram';
import {PLAYGROUND_CANNON,PLAYGROUND_STRESS} from '../src/playground-config.mjs';
const repo=fileURLToPath(new URL('../../../',import.meta.url));
const town=process.argv.includes('--gardens-market');
const out=path.join(repo,'structures/town-kit/out',town?'gardens-market-live':'playground');
const asset=town?path.join(repo,'structures/town-kit/out/bayline-town-with-gardens-and-market'):path.join(out,'town-kit-playground');
const port=Number(process.env.TOWN_KIT_PORT??6180),http=port+1,wt=port+2;
if(!Number.isInteger(port)||port<1024||wt>65535)throw Error('TOWN_KIT_PORT must be an integer from 1024 to 65533.');
const children=[];let closing=false;
function stop(code=0){if(closing)return;closing=true;for(const child of children){try{process.kill(-child.pid,'SIGTERM');}catch{}}process.exit(code);}
process.on('SIGINT',()=>stop());process.on('SIGTERM',()=>stop());
async function run(command,args,options={}){
 const child=spawn(command,args,{cwd:repo,stdio:'inherit',...options});
 await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error(`${command} exited ${code}`)));});
}
await mkdir(out,{recursive:true});
// Refuse occupied ports instead of joining or stopping another local stack.
for(const p of [port,http])await new Promise((resolve,reject)=>{const probe=net.createServer();probe.once('error',reject);probe.listen(p,'127.0.0.1',()=>probe.close(resolve));});
await new Promise((resolve,reject)=>{const probe=dgram.createSocket('udp4');probe.once('error',reject);probe.bind(wt,'127.0.0.1',()=>probe.close(resolve));});
await run(process.execPath,[path.join(repo,`structures/town-kit/scripts/build-${town?'gardens-market':'playground'}.mjs`)]);
const env={...process.env,CARGO_TARGET_DIR:path.join(repo,'target/town-kit-live')};
if(!process.argv.includes('--no-build'))await run('cargo',['build','--locked','--release','-p','web-fps-server','--features','native-destruction','--bin','web-fps-server'],{env});
async function service(name,command,args,serviceEnv,cwd=repo){
 if(name==='server'){delete serviceEnv.WT_CERT_PEM;delete serviceEnv.WT_KEY_PEM;delete serviceEnv.WT_PUBLIC_URL;}
 const log=await open(path.join(out,`${name}.log`),'w');
 const child=spawn(command,args,{cwd,env:serviceEnv,detached:true,stdio:['ignore',log.fd,log.fd]});
 children.push(child);await log.close();child.on('error',e=>{console.error(e);stop(1);});child.on('exit',code=>{if(!closing){console.error(`${name} exited ${code}; see ${out}/${name}.log`);stop(1);}});return child;
}
const server=await service('server','bash',[path.join(repo,'scripts/perf/gpu-run.sh'),'town-kit-live',path.join(env.CARGO_TARGET_DIR,'release/web-fps-server')],{
 ...env,BIND_ADDR:`127.0.0.1:${http}`,SERVER_PORT:String(http),WT_BIND_ADDR:`127.0.0.1:${wt}`,WT_HOST:'127.0.0.1',WT_PUBLIC_URL:'',WEB_BIND_ADDR:'',WT_CERT_PEM:'',WT_KEY_PEM:'',
 VIBE_PHYSICS_BACKEND:'physx_gpu',VIBE_CITY_SCENE:asset+'.json',VIBE_CITY_VISUALS:asset+'.visuals.json',VIBE_CITY_GRID:'1',VIBE_CITY_VARIED_HEIGHTS:'0',VIBE_CITY_VEHICLES:'0',
 VIBE_CITY_SPAWN_X:town?'-45':'-26',VIBE_CITY_SPAWN_Z:town?'0':'-40',VIBE_CITY_BALL_MASS_KG:String(town?2000:PLAYGROUND_CANNON.massKg),VIBE_CITY_BALL_SPEED_MS:String(town?35:PLAYGROUND_CANNON.speedMps),VIBE_CITY_BALL_TTL_TICKS:String(PLAYGROUND_CANNON.ttlTicks),
 VIBE_CITY_FREEZE:'0',VIBE_CITY_NATIVE_SETTLE_TICKS:'0',VIBE_CITY_NATIVE_SETTLE_FREEZE:'0',VIBE_CITY_NATIVE_STRESS_TOLERANCE:String(PLAYGROUND_STRESS.tolerance),VIBE_CITY_NATIVE_STRESS_ITERATIONS:String(PLAYGROUND_STRESS.iterations),
 CUMETAL_CACHE_DIR:path.join(repo,'target/cumetal-cache'),RUST_LOG:process.env.RUST_LOG??'info',
});
console.log('Waiting for the town-kit server (and the shared GPU lock)…');
while(!closing){try{const r=await fetch(`http://127.0.0.1:${http}/healthz`);if(r.ok)break;}catch{}await new Promise(r=>setTimeout(r,1000));}
const client=await service('client',process.execPath,[path.join(repo,'client/node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--strictPort'],{
 ...env,CLIENT_PORT:String(port),SERVER_PORT:String(http),SERVER_HOST:'127.0.0.1',WT_CERT_PEM:'',WT_KEY_PEM:'',VITE_MULTIPLAYER_HTTP_ORIGIN:'',VITE_CONTROL_PLANE_URL:'',VITE_TOWN_KIT_SCENE:town?'bayline-town-with-gardens-and-market':'',TOWN_KIT_LIVE_RELOAD:process.env.TOWN_KIT_LIVE_RELOAD??'0',
},path.join(repo,'client'));
const url=`http://127.0.0.1:${port}/${town?'city':'town-kit'}?portal=true`;
await writeFile(path.join(out,'service.json'),JSON.stringify({pid:process.pid,serverPid:server.pid,clientPid:client.pid,url,httpPort:http,wtPort:wt},null,2));
console.log(`Town-kit playground: ${url}\nLogs: ${out}\nCtrl-C stops this playground.`);
