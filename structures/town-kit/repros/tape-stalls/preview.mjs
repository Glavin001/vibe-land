import {createServer} from '../../../../client/node_modules/vite/dist/node/index.js';
import configFactory from '../../../../client/vite.config.ts';
const config=configFactory({command:'serve',mode:'development'});
config.root=new URL('../../../../client/',import.meta.url).pathname;
config.cacheDir=new URL('../../out/reviews/tape-stalls/vite-cache/',import.meta.url).pathname;
config.configFile=false;
config.server={...config.server,host:'127.0.0.1',port:6187,strictPort:true,https:undefined};
config.server.proxy['/city-manifest']={target:'http://127.0.0.1:4017'};
const server=await createServer(config);await server.listen();server.printUrls();
