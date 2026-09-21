import {readFile,writeFile,mkdir,readdir,access,cp} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {KIT} from '../src/dependencies.mjs';
import {sha} from './provenance.mjs';
/** Copy only locked cached packages/index entries. Never writes to the shared cache. */
export async function prepareNativeCache({workspace='native',cacheDirectory='cargo-home'}={}){
 const home=path.join(KIT,'out',cacheDirectory),lock=await readFile(path.join(KIT,workspace,'Cargo.lock'),'utf8'),hash=sha(lock);
 try{if((await readFile(path.join(home,'source-lock.sha256'),'utf8'))===hash)return home;}catch{}
 await mkdir(home,{recursive:true});
 const sourceRoot=process.env.TOWN_KIT_CARGO_SOURCE_ROOT??path.join(process.env.CARGO_HOME??path.join(os.homedir(),'.cargo'),'registry/src');
 const registryRoot=path.dirname(sourceRoot),indices=await readdir(path.join(registryRoot,'index'));
 const copy=async(source,destination)=>{try{await access(source);}catch{return false;}await mkdir(path.dirname(destination),{recursive:true});await cp(source,destination,{recursive:true,preserveTimestamps:true});return true;};
 const packages=lock.split('[[package]]').filter(b=>b.includes('source = "registry+')).map(b=>({name:/\nname = "([^"]+)"/.exec(b)?.[1],version:/\nversion = "([^"]+)"/.exec(b)?.[1]}));
 for(const registry of indices){
  await copy(path.join(registryRoot,'index',registry,'config.json'),path.join(home,'registry/index',registry,'config.json'));
  for(const {name,version}of packages){
   if(!name||!version)throw Error('Invalid locked Cargo package');
   const lower=name.toLowerCase(),key=lower.length<3?`${lower.length}/${lower}`:lower.length===3?`3/${lower[0]}/${lower}`:`${lower.slice(0,2)}/${lower.slice(2,4)}/${lower}`;
   await copy(path.join(registryRoot,'index',registry,'.cache',key),path.join(home,'registry/index',registry,'.cache',key));
   await copy(path.join(registryRoot,'cache',registry,`${name}-${version}.crate`),path.join(home,'registry/cache',registry,`${name}-${version}.crate`));
   await copy(path.join(sourceRoot,registry,`${name}-${version}`),path.join(home,'registry/src',registry,`${name}-${version}`));
  }
 }
 await writeFile(path.join(home,'config.toml'),'[net]\noffline = true\n[registries.crates-io]\nprotocol = "sparse"\n');
 await writeFile(path.join(home,'source-lock.sha256'),hash);return home;
}
