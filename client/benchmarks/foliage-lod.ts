import * as T from 'three';
import { createBenchmarkSky } from './foliage-sky';
import { GrassField } from '../src/scene/grass/GrassField';
import { GrassPaint, GRASS_BRUSHES } from '../src/scene/grass/GrassPaint';
const status = document.querySelector('#status')!;
const output = document.querySelector('#report')!;
const button = document.querySelector<HTMLButtonElement>('#run')!;
const frame = () => new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
const median = (a:number[]) => a.length ? [...a].sort((a,b)=>a-b)[Math.floor(a.length/2)] : null;
button.onclick = async () => {
  button.disabled=true; output.textContent='';
  const renderer = new T.WebGLRenderer({antialias:true}); renderer.setSize(1920,1080);
  // Keep the measured canvas in view when the report grows. Offscreen canvases
  // may be throttled by the browser and their GPU timers invalidated.
  output.before(renderer.domElement);
  const timingOnly=new URLSearchParams(location.search).has('timingOnly');
  const environment=new URLSearchParams(location.search).has('sky')?createBenchmarkSky(renderer):null;
  const gl=renderer.getContext() as WebGL2RenderingContext;
  const timer=gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const debug=gl.getExtension('WEBGL_debug_renderer_info');
  const report:{device:unknown;skyLighting:boolean;timingOnly:boolean;cases:unknown[];coverage:unknown[];contacts:unknown[];geometriesAfterDisposal?:number}={device:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):'unavailable',skyLighting:!!environment,timingOnly,cases:[],coverage:[],contacts:[]};
  const scene=new T.Scene();scene.background=new T.Color('#a8b5ba');scene.environment=environment?.texture??null;
  scene.add(new T.HemisphereLight('#ffffff','#526141',2));
  const sun=new T.DirectionalLight('#fff5d7',2);sun.position.set(30,50,20);scene.add(sun);
  const camera=new T.PerspectiveCamera(55,1920/1080,0.1,600);
  const target=new T.WebGLRenderTarget(1920,1080);
  const pixels=new Uint8Array(1920*1080*4);
  const person=new T.Mesh(new T.BoxGeometry(0.8,1.6,0.5),new T.MeshBasicMaterial({color:0xff0000}));
  person.position.set(0,0.8,-5);scene.add(person);
  let field:GrassField|undefined;
  const redPixels=()=>{
    renderer.setRenderTarget(target);renderer.render(scene,camera);renderer.readRenderTargetPixels(target,0,0,1920,1080,pixels);renderer.setRenderTarget(null);
    let red=0;for(let i=0;i<pixels.length;i+=4)if(pixels[i]>180&&pixels[i+1]<60&&pixels[i+2]<60)red++;
    return red;
  };
  try {
    for(const preset of ['vehicle','corn','wheat'] as const) for(const quality of ['fast','pretty'] as const) {
      const paint=new GrassPaint();paint.paint(0,0,24,GRASS_BRUSHES[preset]);
      field=new GrassField(quality,[],paint);scene.add(field.group);
      for(const distance of [12,35,110]) {
        status.textContent=`Measuring ${preset} / ${quality} / ${distance} m`;
        camera.position.set(0,1.4,distance);camera.lookAt(0,1.4,0);camera.updateMatrixWorld();
        for(let i=0;i<600;i++){
          field.update(camera,performance.now()/1000);renderer.render(scene,camera);await frame();
          if(i>=100&&field.stats.pendingPatches===0)break;
        }
        const gpu:number[]=[],cpu:number[]=[],update:number[]=[],queries:{q:WebGLQuery;on:boolean;pair:number}[]=[],pairs=new Map<number,{on?:number;off?:number}>();
        const drain=()=>{while(queries.length&&gl.getQueryParameter(queries[0].q,gl.QUERY_RESULT_AVAILABLE)){
          const {q,on,pair}=queries.shift()!;if(!gl.getParameter(timer.GPU_DISJOINT_EXT)){
            const result=pairs.get(pair)??{};result[on?'on':'off']=gl.getQueryParameter(q,gl.QUERY_RESULT)/1e6;pairs.set(pair,result);
          }gl.deleteQuery(q);
        }};
        for(let i=0;i<48;i++){
          const start=performance.now();field.update(camera,start/1000);update.push(performance.now()-start);
          const costs:number[]=[];
          for(const on of i%2?[true,false]:[false,true]){
            field.group.visible=on;const q=timer?gl.createQuery():null;
            if(q)gl.beginQuery(timer.TIME_ELAPSED_EXT,q);
            const before=performance.now();renderer.render(scene,camera);costs[on?1:0]=performance.now()-before;
            if(q){gl.endQuery(timer.TIME_ELAPSED_EXT);queries.push({q,on,pair:i});}

          }
          cpu.push(costs[1]-costs[0]);if(timer)drain();await frame();
        }
        for(let i=0;queries.length&&i<120;i++){await frame();drain();}
        for(const q of queries)gl.deleteQuery(q.q);
        for(const pair of pairs.values())if(pair.on!==undefined&&pair.off!==undefined)gpu.push(pair.on-pair.off);
        field.group.visible=true;renderer.render(scene,camera);
        if(!timingOnly){
        field.group.visible=false;const exposed=redPixels();field.group.visible=true;const hidden=redPixels();
        report.coverage.push({preset,quality,distance,exposed,hidden,hiddenFraction:exposed?1-hidden/exposed:null});
        if(!exposed || (preset!=='wheat' && hidden/exposed>0.2))throw new Error(`Concealment regression: ${preset}/${quality}/${distance}`);
        }
        report.cases.push({preset,quality,distance,gpuMedianMs:median(gpu),gpuSamples:gpu.length,renderCpuMedianMs:median(cpu),updateCpuMedianMs:median(update),...field.stats});
        output.textContent=JSON.stringify(report,null,2);
      }
      if(!timingOnly&&preset==='vehicle') {
        camera.position.set(0,1.4,35);camera.lookAt(0,1.4,0);camera.updateMatrixWorld();
        const now=performance.now()/1000;
        field.interaction.begin(now,0,0);
        for(const x of [-6,6])for(const z of [-18,-6,6,18])
          field.interaction.stamp({x,z,radiusX:8,radiusZ:8,shape:'box',pressure:1,hold:4});
        field.interaction.commit();
        field.update(camera,now+0.1);field.group.visible=true;
        const visible=redPixels();report.contacts.push({quality,flattenedVisiblePixels:visible});
        if(visible<400)throw new Error(`Flattened canopy still hides target: ${quality}`);
      }
      scene.remove(field.group);field.dispose();field=undefined;paint.dispose();
    }
    person.geometry.dispose();person.material.dispose();scene.remove(person);target.dispose();renderer.render(scene,camera);
    report.geometriesAfterDisposal=renderer.info.memory.geometries;
    output.textContent=JSON.stringify(report,null,2);status.textContent='Complete';
  } catch(error){output.textContent=JSON.stringify(report,null,2);status.textContent=`Failed: ${String(error)}`;}
  finally {field?.dispose();environment?.dispose();renderer.dispose();renderer.domElement.remove();button.disabled=false;}
};
