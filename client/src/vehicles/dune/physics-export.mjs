import {parameterKey} from './model-pipeline.mjs';
export function physicsBundle(collision,visual){
 if(!collision||!visual||visual.quality==='live'||visual.quality==='preview'||parameterKey(collision.parameters)!==parameterKey(visual.parameters))throw Error('Physics and visual configurations must match');
 if(collision.report.penetratingPairs||collision.report.components!==1)throw Error('Only validated collider assemblies can be exported');
 if(collision.options?.fidelity==='simple'&&(!collision.report.nativePrimitiveAudit||collision.report.nativePrimitiveAudit.primitivePenetratingPairs))throw Error('Simple primitive contacts must be finalized before export');
 const visuals=new Map(visual.parts.map(p=>[p.id,p]));
 return {...collision,format:'dune-buggy-physics',visualAsset:(visual.parameters.vehicle&&visual.parameters.vehicle!=='buggy'?visual.parameters.vehicle:'dune-buggy')+'.glb',parts:collision.parts.map(part=>{const v=visuals.get(part.id);if(!v)throw Error(`Visual part missing: ${part.id}`);const mapping=id=>{const mesh=visuals.get(id);if(!mesh)throw Error(`Visual part missing: ${id}`);return {nodeName:mesh.id+'__'+mesh.name,partId:mesh.id,localTranslation:mesh.center.map((x,k)=>x-part.position[k]),localRotation:[0,0,0,1]}};return {...part,visual:mapping(part.id),visuals:(part.visualIds??[part.id]).map(mapping)}})};
}
