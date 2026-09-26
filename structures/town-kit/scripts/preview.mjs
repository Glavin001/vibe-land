import path from 'node:path';
import {mkdir,writeFile,readFile,unlink} from 'node:fs/promises';
import { fileURLToPath,pathToFileURL } from 'node:url';
import {cannonApi} from './cannon.mjs';
import {previewOutput} from './preview-output.mjs';
import {videoOutput} from './video-output.mjs';
const kit=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),repo=path.resolve(kit,'../..');
const {createServer}=await import(pathToFileURL(path.join(repo,'client/node_modules/vite/dist/node/index.js')));
const server=await createServer({configFile:false,root:path.join(kit,'preview'),cacheDir:path.join(kit,'out/.vite'),publicDir:path.join(repo,'client/public'),
 resolve:{alias:[{find:/^three$/,replacement:path.join(repo,'client/node_modules/three/build/three.module.js')},{find:'three/',replacement:path.join(repo,'client/node_modules/three/')},{find:'@game',replacement:path.join(repo,'client/src')} ]},
 define:{__SCENES_DIR__:JSON.stringify(path.join(kit,'out')),__CLIENT_BUILD__:JSON.stringify('town-kit-independent')},
 server:{host:'127.0.0.1',port:Number(process.env.TOWN_KIT_PORT??6174),strictPort:true,fs:{allow:[repo]},watch:{ignored:['**/native/target/**','**/out/reviews/**']},headers:{'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'}},
 plugins:[{name:'town-kit-output',configureServer(s){s.middlewares.use('/api/cannon',cannonApi(kit));s.middlewares.use('/api/video',videoOutput(path.join(kit,'out')));s.middlewares.use('/kit',previewOutput(path.join(kit,'out')));}}]});
await server.listen();server.printUrls();
const ownership=path.join(kit,'out/preview-service.json');await mkdir(path.dirname(ownership),{recursive:true});
await writeFile(ownership,JSON.stringify({pid:process.pid,kit,port:server.config.server.port,startedAt:new Date().toISOString()},null,2));
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,async()=>{
 await server.close();try{if(JSON.parse(await readFile(ownership,'utf8')).pid===process.pid)await unlink(ownership);}catch{}process.exit(0);
});
