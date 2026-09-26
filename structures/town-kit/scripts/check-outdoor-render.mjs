import {build} from '../../../client/node_modules/esbuild/lib/main.js';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../../',import.meta.url)),out=fileURLToPath(new URL('../out/outdoor-render.test.mjs',import.meta.url));
await build({entryPoints:[fileURLToPath(new URL('../tests/outdoor-render.test.ts',import.meta.url))],outfile:out,bundle:true,platform:'node',format:'esm',alias:{three:root+'client/node_modules/three/build/three.module.js'}});
const result=spawnSync(process.execPath,['--test',out],{stdio:'inherit'});process.exitCode=result.status??1;
