// Linked-channel lookahead limiter. The same gain is applied to every speaker
// so a loud impact does not pull the spatial image toward a different channel.
class DestructionLimiter extends AudioWorkletProcessor {
  constructor(){super();this.delay=256;this.buffers=Array.from({length:8},()=>new Float32Array(this.delay));this.index=0;this.gain=1;this.hold=0;this.meterFrames=0;this.peak=0;this.reduction=0;this.squares=0;this.samples=0;}
  process(inputs,outputs){
    const input=inputs[0], output=outputs[0];if(!output?.length)return true;
    for(let i=0;i<output[0].length;i++){
      let peak=0;for(let c=0;c<output.length;c++)peak=Math.max(peak,Math.abs(input[c]?.[i]??0));
      const target=peak>.89?.89/peak:1;
      if(target<this.gain)this.gain=target;
      // Equal peaks must refresh the hold too: otherwise the gain starts
      // recovering while an equally loud delayed sample is still in flight.
      if(target<1)this.hold=this.delay+96;
      else if(this.hold>0)this.hold--;else this.gain+=(1-this.gain)*.00022;
      this.reduction=Math.max(this.reduction,1-this.gain);
      for(let c=0;c<output.length;c++){
        const delayed=this.buffers[c][this.index];this.buffers[c][this.index]=input[c]?.[i]??0;
        const v=delayed*this.gain;output[c][i]=Math.max(-.92,Math.min(.92,v));this.peak=Math.max(this.peak,Math.abs(output[c][i]));this.squares+=output[c][i]**2;this.samples++;
      }
      this.index=(this.index+1)%this.delay;
    }
    this.meterFrames+=output[0].length;
    if(this.meterFrames>=8192){this.port.postMessage({peak:this.peak,reduction:this.reduction,rms:Math.sqrt(this.squares/Math.max(1,this.samples))});this.meterFrames=0;this.peak=0;this.reduction=0;this.squares=0;this.samples=0;}
    return true;
  }
}
registerProcessor('destruction-limiter',DestructionLimiter);
