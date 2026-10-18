import {gzipSync} from 'node:zlib';
import {sourceProvenance} from './provenance.mjs';
import { mkdir,writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { KIT,REPO,AUTHORING } from '../src/dependencies.mjs';
import { buildVictorianCorner } from '../src/victorian.mjs';
import { buildProp,PROP_TYPES } from '../src/props.mjs';
import { validate } from '../src/validate.mjs';
const args=process.argv.slice(2),has=k=>args.includes(`--${k}`),value=(k,d)=>{const i=args.indexOf(`--${k}`);return i<0?d:args[i+1];};
const prop=value('prop',null),options={storeys:Number(value('storeys',3)),mirrored:has('mirror'),palette:value('palette','sage'),furnished:!has('empty'),fence:!has('no-fence'),seed:Number(value('seed',20260920))};
const assets=has('props')?PROP_TYPES.map(p=>[p,buildProp(p)]):prop?[[prop,buildProp(prop)]]:[[value('name','victorian-corner'),buildVictorianCorner(options)]];
await mkdir(path.join(KIT,'out'),{recursive:true});
let failed=false;
for(const [name,{pack,metadata}] of assets){
 if(!/^[a-z0-9-]+$/.test(name))throw Error('Asset name must be a lowercase slug');
 const report=validate(pack),json=JSON.stringify(pack);metadata.validation=report;metadata.assetSha256=createHash('sha256').update(json).digest('hex');
 metadata.provenance=await sourceProvenance();
 const revisionDir=path.join(KIT,'out/revisions',metadata.assetSha256);await mkdir(revisionDir,{recursive:true});await writeFile(path.join(revisionDir,'asset.json.gz'),gzipSync(json,{level:3}));await writeFile(path.join(revisionDir,'asset.meta.json'),JSON.stringify(metadata,null,2));
 await writeFile(path.join(KIT,'out',`${name}.json`),json);await writeFile(path.join(KIT,'out',`${name}.meta.json`),JSON.stringify(metadata,null,2));
 console.log(name,JSON.stringify(report,null,2));if(!report.passed)failed=true;
}
if(failed)process.exitCode=1;
