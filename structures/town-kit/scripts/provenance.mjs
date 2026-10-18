import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {KIT,REPO,AUTHORING} from '../src/dependencies.mjs';
export const sha=data=>createHash('sha256').update(data).digest('hex');
async function files(root,extensions){const out=[];for(const ent of await readdir(root,{withFileTypes:true})){const p=path.join(root,ent.name);if(ent.isDirectory())out.push(...await files(p,extensions));else if(extensions.some(e=>p.endsWith(e)))out.push(p);}return out;}
export async function sourceProvenance(){
 const targets=[...await files(path.join(KIT,'vendor'),['.mjs','.png','LICENSE','README.md']),...await files(path.join(KIT,'scripts'),['.mjs','.py']),path.join(KIT,'native/Cargo.lock'),path.join(KIT,'native/Cargo.toml'),path.join(KIT,'native/build.rs'),...await files(path.join(KIT,'src'),['.mjs']),...await files(path.join(KIT,'native/src'),['.rs','.cpp','.h']),...await files(path.join(KIT,'preview'),['.ts','.html']),...await files(path.join(AUTHORING,'lib'),['.mjs']),path.join(AUTHORING,'../scripts/export-fractured-city.mjs'),...await files(path.join(REPO,'physx-bridge/src'),['.rs','.cc']),...await files(path.join(REPO,'physx-bridge/include'),['.h']),...['city/chunkGeometry.ts','scene/cityMaterialShader.ts','scene/cityTextures.ts','structures/structurePack.ts'].map(p=>path.join(REPO,'client/src',p))];
 const content={};for(const p of targets.sort())content[path.relative(REPO,p)]=sha(await readFile(p));
 const revision=cwd=>execFileSync('git',['rev-parse','HEAD'],{cwd,encoding:'utf8'}).trim();
 return {vibeRevision:revision(REPO),authoringRevision:revision(AUTHORING),files:content,contentHash:sha(JSON.stringify(content))};
}
