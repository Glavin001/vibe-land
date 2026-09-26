import * as T from 'three';
import { GrassField } from '../src/scene/grass/GrassField';
import { GrassPaint, GRASS_BRUSHES } from '../src/scene/grass/GrassPaint';
import { createBenchmarkSky } from './foliage-sky';
const button=document.querySelector<HTMLButtonElement>('#run')!,status=document.querySelector('#status')!,output=document.querySelector('#report')!;
const frame=()=>new Promise<void>(r=>requestAnimationFrame(()=>r()));
const summary=(a:number[])=>{const sorted=[...a].sort((a,b)=>a-b);return {median:sorted[Math.floor(sorted.length*.5)]??0,p95:sorted[Math.floor(sorted.length*.95)]??0,max:sorted[sorted.length-1]??0};};
button.onclick=async()=>{
  button.disabled=true;output.textContent='';
  const renderer=new T.WebGLRenderer({antialias:true});renderer.setSize(1920,1080);output.before(renderer.domElement);
  const gl=renderer.getContext() as WebGL2RenderingContext,timer=gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const scene=new T.Scene();scene.background=new T.Color('#b7c7d3');const sky=createBenchmarkSky(renderer);scene.environment=sky.texture;
  scene.add(new T.HemisphereLight('#ffffff','#526141',2));const sun=new T.DirectionalLight('#fff5d7',2);sun.position.set(30,50,20);scene.add(sun);
  const camera=new T.PerspectiveCamera(55,16/9,.1,500),report:unknown[]=[];
  let field:GrassField|undefined,paint:GrassPaint|undefined;
  try {
    for(const quality of ['fast','pretty'] as const){
      paint=new GrassPaint();let n=0;
      for(const x of [-32,0,32])for(const z of [-32,0,32])paint.paint(x,z,24,[GRASS_BRUSHES.vehicle,GRASS_BRUSHES.corn,GRASS_BRUSHES.ferns][n++%3]);
      field=new GrassField(quality,[],paint);scene.add(field.group);
      let tick=0;
      for(const phase of ['cold','travel','contacts'] as const){
        status.textContent=`${quality}: ${phase}`;
        const update:number[]=[],contacts:number[]=[],render:number[]=[],intervals:number[]=[],resident:number[]=[],gpu:number[]=[];
        const queries:WebGLQuery[]=[];
        const drain=()=>{while(queries.length&&gl.getQueryParameter(queries[0],gl.QUERY_RESULT_AVAILABLE)){
          const q=queries.shift()!;if(!gl.getParameter(timer.GPU_DISJOINT_EXT))gpu.push(gl.getQueryParameter(q,gl.QUERY_RESULT)/1e6);gl.deleteQuery(q);
        }};
        let previous=performance.now();
        for(let i=0;i<240;i++,tick++){
          const time=tick/120;
          if(phase==='travel')camera.position.set(-36+i*.3,2,8*Math.sin(i/240*Math.PI*2));
          else camera.position.set(0,2,14);
          camera.lookAt(camera.position.x+2,1,camera.position.z-12);camera.updateMatrixWorld();
          const start=performance.now();
          if(phase==='contacts'&&field.interaction.begin(time,camera.position.x,camera.position.z)){
            // Many independent bodies; production caps stamp count/cell visits.
            for(let body=0;body<256;body++)field.interaction.stamp({x:(body%16-8)*2.5+Math.sin(time)*2,z:(Math.floor(body/16)-8)*2.5,radiusX:1.1,radiusZ:.7,pressure:.9,hold:.2,damage:.3});
            field.interaction.commit();contacts.push(performance.now()-start);
          }
          const before=performance.now();field.setShadows(false);field.update(camera,time);update.push(performance.now()-before);
          const q=timer?gl.createQuery():null;if(q)gl.beginQuery(timer.TIME_ELAPSED_EXT,q);
          const draw=performance.now();renderer.render(scene,camera);render.push(performance.now()-draw);
          if(q){gl.endQuery(timer.TIME_ELAPSED_EXT);queries.push(q);}if(timer)drain();
          resident.push(field.stats.instanceBytes+field.stats.canopyBytes);
          await frame();const now=performance.now();intervals.push(now-previous);previous=now;
        }
        for(let i=0;queries.length&&i<120;i++){await frame();drain();}for(const q of queries)gl.deleteQuery(q);
        const buffers=new Set<T.BufferAttribute>();
        field.group.traverse(object=>{if(object instanceof T.Mesh){const g=object.geometry;if(g.index)buffers.add(g.index);for(const a of Object.values(g.attributes))buffers.add(a as T.BufferAttribute);}});
        report.push({quality,phase,frames:240,updateMs:summary(update),contactTickMs:summary(contacts),renderSubmitMs:summary(render),frameIntervalMs:summary(intervals),gpuMs:gpu.length?summary(gpu):null,gpuSamples:gpu.length,residentBufferBytes:[...buffers].reduce((sum,a)=>sum+a.array.byteLength,0),peakInstanceBytes:Math.max(...resident),...field.stats,pressedCells:field.interaction.activeCells,historyBytes:field.interaction.historyBytes});
        output.textContent=JSON.stringify(report,null,2);
      }
      scene.remove(field.group);field.dispose();field=undefined;paint.dispose();paint=undefined;renderer.render(scene,camera);
      report.push({quality,geometriesAfterDisposal:renderer.info.memory.geometries});
      if(renderer.info.memory.geometries!==0)throw new Error('Geometry leak after disposal');
    }
    output.textContent=JSON.stringify(report,null,2);status.textContent='Complete';
  }catch(error){status.textContent=`Failed: ${String(error)}`;}
  finally{field?.dispose();paint?.dispose();sky.dispose();renderer.dispose();renderer.domElement.remove();button.disabled=false;}
};
