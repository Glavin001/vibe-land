import * as T from 'three';
import { createBenchmarkSky } from './foliage-sky';
import { GrassField } from '../src/scene/grass/GrassField';
import { GrassPaint, GRASS_BRUSHES } from '../src/scene/grass/GrassPaint';
import { skyGradient, sunDirection, sunIntensityFor } from '../src/graphics/sunSky';
const button=document.querySelector<HTMLButtonElement>('#run')!;
const status=document.querySelector('#status')!;
const output=document.querySelector('#report')!;
const images=document.querySelector('#images')!;
const frame=()=>new Promise<void>(r=>requestAnimationFrame(()=>r()));
button.onclick=async()=>{
  button.disabled=true;status.textContent='Measuring';images.replaceChildren();output.textContent='';
  const width=640,height=480;
  const renderer=new T.WebGLRenderer({antialias:false});renderer.setSize(width,height);
  renderer.toneMapping=T.ACESFilmicToneMapping;
  const target=new T.WebGLRenderTarget(width,height,{colorSpace:T.SRGBColorSpace});
  const pixels=new Uint8Array(width*height*4);
  const scene=new T.Scene();scene.background=new T.Color(0);
  const gradient=skyGradient('#c3d2e2'),direction=sunDirection();
  const hemi=new T.HemisphereLight(gradient.zenith,gradient.ground,0.25);
  scene.add(hemi,new T.AmbientLight('#fdf6eb',0.12));
  const sun=new T.DirectionalLight(gradient.sunColor,sunIntensityFor());sun.position.set(direction.x,direction.y,direction.z);scene.add(sun);
  const environment=createBenchmarkSky(renderer);scene.environment=environment.texture;
  const camera=new T.PerspectiveCamera(45,width/height,.1,200);
  const report:unknown[]=[];
  const sample=(label:string)=>{
    renderer.setRenderTarget(target);renderer.render(scene,camera);renderer.readRenderTargetPixels(target,0,0,width,height,pixels);
    // Central canopy region; black gaps excluded, same projected framing for both passes.
    let sum=0,count=0;const rgb=[0,0,0];
    for(let y=height*.35|0;y<height*.65;y++)for(let x=width*.3|0;x<width*.7;x++){
      const at=(y*width+x)*4;
      if(pixels[at]+pixels[at+1]+pixels[at+2]<15)continue;
      sum+=pixels[at]*.2126+pixels[at+1]*.7152+pixels[at+2]*.0722;
      for(let c=0;c<3;c++)rgb[c]+=pixels[at+c];count++;
    }
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;canvas.title=label;
    const ctx=canvas.getContext('2d')!,data=ctx.createImageData(width,height);
    for(let y=0;y<height;y++)data.data.set(pixels.subarray(y*width*4,(y+1)*width*4),(height-1-y)*width*4);
    ctx.putImageData(data,0,0);images.append(canvas);
    return {luminance:sum/count,rgb:rgb.map(v=>v/count),pixels:count};
  };
  let field:GrassField|undefined,paint:GrassPaint|undefined;
  try{
    for(const preset of ['corn','vehicle','ferns','dry','wheat'] as const){
      paint=new GrassPaint();paint.paint(0,0,12,preset==='dry'?{...GRASS_BRUSHES.dry,height:2.8}:GRASS_BRUSHES[preset]);
      field=new GrassField('pretty',[],paint);field.setWind(0,0);scene.add(field.group);
      camera.position.set(0,7,17);camera.lookAt(0,preset==='vehicle'?1.5:0.7,0);camera.updateMatrixWorld();
      for(let i=0;i<400;i++){field.update(camera,performance.now()/1000);await frame();if(i>80&&field.stats.pendingPatches===0)break;}
      field.update(camera,performance.now()/1000+1);
      for(const lighting of ['sky','direct','backlit'] as const){
        scene.environment=lighting==='direct'?null:environment.texture;
        camera.position.set(0,7,17);
        if(lighting==='backlit')camera.position.set(-direction.x*22,7,-direction.z*22);
        camera.lookAt(0,preset==='vehicle'?1.5:0.7,0);camera.updateMatrixWorld();
        field.update(camera,performance.now()/1000+1);
        field.shading.uniforms.grassCanopyHandoff.value.set(1000,1001);
        field.canopy.uniforms.foliageHandoff.value.set(1000,1001);
        const near=sample(`${preset} ${lighting} near`);
        field.shading.uniforms.grassCanopyHandoff.value.set(-2,-1);
        field.canopy.uniforms.foliageHandoff.value.set(-2,-1);
        const far=sample(`${preset} ${lighting} distant`);
        report.push({preset,lighting,near,far,ratio:far.luminance/near.luminance});
        output.textContent=JSON.stringify(report,null,2);
        const ratio=far.luminance/near.luminance,tolerance=lighting==='sky'?0.15:0.20;
        if(!Number.isFinite(ratio)||Math.abs(ratio-1)>tolerance)
          throw new Error(`LOD brightness mismatch: ${preset}/${lighting} = ${ratio.toFixed(3)}`);
      }
      scene.remove(field.group);field.dispose();field=undefined;paint.dispose();paint=undefined;
    }
    status.textContent='Complete';
  }catch(e){status.textContent=`Failed: ${String(e)}`;}
  finally {field?.dispose();paint?.dispose();target.dispose();environment.dispose();renderer.dispose();button.disabled=false;}
};
