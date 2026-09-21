/** Select exact already-reviewed placements; copy numeric records byte-for-byte. */
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {KIT} from '../src/dependencies.mjs';
import {inspectSceneBundle} from '../src/scene-binary.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const input=readFileSync(`${KIT}/out/bayline-civic-town.vlsp`),{header:h,payload}=inspectSceneBundle(input);
const auditRoot=JSON.parse(readFileSync(`${KIT}/out/reviews/building-audit-latest.json`)).root;
const audit=JSON.parse(readFileSync(`${auditRoot}/audit.json`));
if(audit.sceneSha256!==sha(input))throw Error('Audit scene mismatch');
const selected=Array.from({length:36},(_,i)=>i);
for(const i of selected)if(!audit.results.find(r=>r.index===i)?.passed)throw Error(`Placement ${i} has not passed`);
// Original small-town streets and pavements; no civic-only forecourt fragments.
selected.push(64);
const out=structuredClone(h),oldToNew=new Map(),nb=[],bb=[];out.templates=[];out.instances=[];
let nc=0,bc=0,en=0,eb=0;
for(const i of selected){const inst=structuredClone(h.instances[i]),t=h.templates[inst.template];
 if(!oldToNew.has(inst.template)){
  oldToNew.set(inst.template,out.templates.length);out.templates.push({...t,nodeStart:nc,bondStart:bc});
  nb.push(payload.subarray(h.sections.nodes.offset+t.nodeStart*112,h.sections.nodes.offset+(t.nodeStart+t.nodeCount)*112));
  bb.push(payload.subarray(h.sections.bonds.offset+t.bondStart*72,h.sections.bonds.offset+(t.bondStart+t.bondCount)*72));nc+=t.nodeCount;bc+=t.bondCount;
 }
 inst.template=oldToNew.get(inst.template);out.instances.push(inst);en+=t.nodeCount;eb+=t.bondCount;
}
out.key='bayline-proven-36';out.title='Bayline · Garden homes and high street';
out.provenance={...h.provenance,parentSceneSha256:sha(input),selection:selected,buildingAuditSha256:sha(readFileSync(`${auditRoot}/audit.json`))};
const ids=new Set(audit.results.filter(r=>selected.slice(0,36).includes(r.index)).map(r=>r.id));
const m=out.metadata;m.instances=m.instances.filter(r=>ids.has(r.id));
for(const field of ['rooms','entrances'])m[field]=m[field].filter(r=>ids.has(r.instance??r.name.split('/')[0]));
m.route=[];m.composition={buildings:36,buildingFamilies:3,source:'first 36 exact passing placements'};
m.acceptance={readyForRelease:false,note:'All 36 exact buildings passed isolated intact review. Assembled warm-start and destruction checks are separate.'};
const shapes=payload.subarray(h.sections.shapes.offset,h.sections.shapes.offset+h.sections.shapes.bytes);
out.sections={nodes:{offset:0,bytes:nc*112},bonds:{offset:nc*112,bytes:bc*72},shapes:{offset:nc*112+bc*72,bytes:shapes.length}};
const descriptor=Buffer.from(JSON.stringify(out)),numeric=Buffer.concat([...nb,...bb,shapes]),body=Buffer.concat([descriptor,Buffer.alloc((8-descriptor.length%8)%8),numeric]),prefix=Buffer.alloc(64);
prefix.write('VLSP');[1,descriptor.length,112,72,numeric.length,en,eb].forEach((n,i)=>prefix.writeUInt32LE(n,4+i*4));Buffer.from(sha(body),'hex').copy(prefix,32);
const bytes=Buffer.concat([prefix,body]),file=`${KIT}/out/bayline-proven-36.vlsp`;writeFileSync(file,bytes);inspectSceneBundle(bytes);
const report={output:file,buildings:36,structures:37,chunks:en,bonds:eb,bytes:bytes.length,templates:out.templates.length,sceneSha256:sha(bytes),exactOriginalPlacements:selected,individualIntactPassed:true,assembledPassed:false};
mkdirSync(`${KIT}/out/reviews/proven-36`,{recursive:true});writeFileSync(`${KIT}/out/reviews/proven-36/selection.json`,JSON.stringify(report,null,2));console.log(report);
