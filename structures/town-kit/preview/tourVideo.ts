type Caption={title:string;subtitle:string};
type FilmOptions={canvas:HTMLCanvasElement;duration:number;render:(seconds:number)=>Caption;progress:(message:string)=>void};

/** Records real rendered simulation playback, including chapter captions. */
export async function recordTour({canvas,duration,render,progress}:FilmOptions){
 const output=document.createElement('canvas');output.width=1280;output.height=720;
 const context=output.getContext('2d')!,stream=output.captureStream(30);
 const mime=['video/webm;codecs=vp9','video/webm;codecs=vp8','video/webm'].find(t=>MediaRecorder.isTypeSupported(t));
 if(!mime)throw Error('This browser cannot record WebM video.');
 const recorder=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:8_000_000}),parts:BlobPart[]=[];
 recorder.ondataavailable=e=>{if(e.data.size)parts.push(e.data);};
 const stopped=new Promise<void>((resolve,reject)=>{recorder.onstop=()=>resolve();recorder.onerror=()=>reject(Error('Video encoder failed'));});
 recorder.start(1000);
 try{
  const start=performance.now();let previousSecond=-1;
  await new Promise<void>((resolve,reject)=>{
   const frame=()=>{try{
    const time=Math.min(duration,(performance.now()-start)/1000),caption=render(time);
    context.fillStyle='#101b18';context.fillRect(0,0,1280,720);
    const fit=Math.min(1280/canvas.width,720/canvas.height),w=canvas.width*fit,h=canvas.height*fit;
    context.drawImage(canvas,(1280-w)/2,(720-h)/2,w,h);
    const shade=context.createLinearGradient(0,540,0,720);shade.addColorStop(0,'#10211d00');shade.addColorStop(1,'#10211df5');context.fillStyle=shade;context.fillRect(0,540,1280,180);
    context.fillStyle='#efeada';context.font='30px Georgia';context.fillText(caption.title,40,634,1180);
    context.font='16px system-ui';context.fillStyle='#d8e7d7';context.fillText(caption.subtitle,40,669,1180);
    context.font='12px system-ui';context.fillStyle='#b4c8ba';context.fillText('BAYLINE  /  Native stress-solver recording  /  Cannonball demolition',40,698);
    context.fillStyle='#bfd2a3';context.fillRect(0,716,1280*time/duration,4);
    const second=Math.floor(time);if(second!==previousSecond){previousSecond=second;progress(`Recording ${second} / ${Math.ceil(duration)} seconds…`);}
    if(time>=duration)resolve();else requestAnimationFrame(frame);
   }catch(error){reject(error);}};requestAnimationFrame(frame);
  });
 }finally{recorder.stop();await stopped;stream.getTracks().forEach(t=>t.stop());}
 progress('Saving the film…');
 const response=await fetch('/api/video/gardens-market',{method:'POST',headers:{'Content-Type':'video/webm'},body:new Blob(parts,{type:'video/webm'})});
 const result=await response.json();if(!response.ok)throw Error(result.error??'Could not save the film');
 return result as {file:string;url:string;bytes:number};
}
