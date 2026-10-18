import { afterEach, describe, expect, it, vi } from 'vitest';
import { PaletteBank, referenceGain } from './paletteBank';
import type { PaletteCatalog, PaletteClip } from './soundPalette';

const naturalId='masonryImpact-natural',designedId='masonryImpact-designed';
const clip=(id:string):PaletteClip=>({url:`/audio/options/${id}.wav`,duration:1,loop:false,sha256:'fixture',origin:'recorded',sources:['fixture']});
const catalog=():PaletteCatalog=>({clips:{[naturalId]:clip(naturalId),[designedId]:clip(designedId)},sources:[]});
const json=(value:unknown)=>new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}});
const bytes=()=>new Response(new Uint8Array([1,2,3,4]),{status:200});
function audio(samples:Float32Array,sampleRate=1000) {
  return {sampleRate,length:samples.length,duration:samples.length/sampleRate,numberOfChannels:1,getChannelData:vi.fn(()=>samples)} as unknown as AudioBuffer;
}
function context() {
  const decoded=audio(new Float32Array(1000).fill(.1));
  const decodeAudioData=vi.fn(async(_bytes:ArrayBuffer)=>decoded);
  return {ctx:{decodeAudioData} as unknown as BaseAudioContext,decodeAudioData,decoded};
}
afterEach(()=>vi.unstubAllGlobals());

describe('optional palette loading',()=>{
  it('does no I/O until requested, and metadata requests never preload audio',async()=>{
    const fetch=vi.fn(async()=>json(catalog()));vi.stubGlobal('fetch',fetch);
    const {ctx,decodeAudioData}=context(),bank=new PaletteBank(ctx);
    expect(fetch).not.toHaveBeenCalled();expect(bank.get(naturalId)).toBeUndefined();expect(bank.clip(naturalId)).toBeUndefined();
    const [a,b]=await Promise.all([bank.metadata(),bank.metadata()]);
    expect(a).toBe(b);expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toMatch(/^\/audio\/options\/catalog\.json\?v=/);
    expect(decodeAudioData).not.toHaveBeenCalled();expect(bank.clip(naturalId)?.url).toBe(clip(naturalId).url);
    expect(await bank.metadata()).toBe(a);expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('deduplicates concurrent loads per clip and shares the catalog across different clips',async()=>{
    let resolveCatalog!:(response:Response)=>void;
    const heldCatalog=new Promise<Response>(resolve=>{resolveCatalog=resolve;});
    const fetch=vi.fn((url:string)=>url.includes('catalog.json')?heldCatalog:Promise.resolve(bytes()));
    vi.stubGlobal('fetch',fetch);
    const {ctx,decodeAudioData,decoded}=context(),bank=new PaletteBank(ctx);
    const a=bank.load('masonryImpact','natural'),b=bank.load('masonryImpact','natural'),c=bank.load('masonryImpact','designed');
    expect(fetch).toHaveBeenCalledTimes(1);expect(decodeAudioData).not.toHaveBeenCalled();
    resolveCatalog(json(catalog()));
    expect(await Promise.all([a,b,c])).toEqual([decoded,decoded,decoded]);
    expect(fetch).toHaveBeenCalledTimes(3);expect(decodeAudioData).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.filter(([url])=>url.includes(naturalId))).toHaveLength(1);
    expect(bank.get(naturalId)).toBe(decoded);expect(bank.get(designedId)).toBe(decoded);
    expect(await bank.load('masonryImpact','natural')).toBe(decoded);
    expect(fetch).toHaveBeenCalledTimes(3);expect(decodeAudioData).toHaveBeenCalledTimes(2);
  });

  it('reports an audio download failure, retries it, and clears the failure only on success',async()=>{
    const fetch=vi.fn().mockResolvedValueOnce(json(catalog())).mockResolvedValueOnce(new Response('',{status:503})).mockResolvedValueOnce(bytes());
    vi.stubGlobal('fetch',fetch);
    const {ctx,decodeAudioData,decoded}=context(),bank=new PaletteBank(ctx);
    await expect(bank.load('masonryImpact','natural')).rejects.toThrow(`Could not load ${naturalId}`);
    expect(bank.failures.get(naturalId)).toContain(`Could not load ${naturalId}`);
    expect(bank.get(naturalId)).toBeUndefined();expect(decodeAudioData).not.toHaveBeenCalled();
    expect(await bank.load('masonryImpact','natural')).toBe(decoded);
    expect(bank.failures.has(naturalId)).toBe(false);expect(fetch).toHaveBeenCalledTimes(3);
    expect(decodeAudioData).toHaveBeenCalledTimes(1);
  });

  it('allows a failed decode to be retried without poisoning other clips or refetching metadata',async()=>{
    const fetch=vi.fn(async(url:string)=>url.includes('catalog.json')?json(catalog()):bytes());vi.stubGlobal('fetch',fetch);
    const {ctx,decodeAudioData,decoded}=context(),bank=new PaletteBank(ctx);
    decodeAudioData.mockRejectedValueOnce(new Error('Unsupported audio data'));
    await expect(bank.load('masonryImpact','natural')).rejects.toThrow('Unsupported audio data');
    expect(bank.failures.get(naturalId)).toContain('Unsupported audio data');
    expect(await bank.load('masonryImpact','designed')).toBe(decoded);
    expect(bank.failures.has(naturalId)).toBe(true);expect(bank.failures.has(designedId)).toBe(false);
    expect(await bank.load('masonryImpact','natural')).toBe(decoded);
    expect(bank.failures.size).toBe(0);expect(fetch).toHaveBeenCalledTimes(4);
    expect(fetch.mock.calls.filter(([url])=>url.includes('catalog.json'))).toHaveLength(1);
  });

  it('retries the catalog after a failed request and reports that failure on the requested choice',async()=>{
    const fetch=vi.fn().mockResolvedValueOnce(new Response('',{status:503})).mockResolvedValueOnce(json(catalog())).mockResolvedValueOnce(bytes());
    vi.stubGlobal('fetch',fetch);
    const {ctx,decoded}=context(),bank=new PaletteBank(ctx);
    await expect(bank.load('masonryImpact','natural')).rejects.toThrow('catalog is unavailable');
    expect(bank.catalog).toBeNull();expect(bank.failures.get(naturalId)).toContain('catalog is unavailable');
    expect(await bank.load('masonryImpact','natural')).toBe(decoded);
    expect(bank.failures.size).toBe(0);expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls.filter(([url])=>String(url).includes('catalog.json'))).toHaveLength(2);
  });

  it('can recover from invalid catalog JSON structure',async()=>{
    const fetch=vi.fn().mockResolvedValueOnce(json({sources:[]})).mockResolvedValueOnce(json(catalog()));vi.stubGlobal('fetch',fetch);
    const bank=new PaletteBank(context().ctx);
    await expect(bank.metadata()).rejects.toThrow('Invalid sound options catalog');
    expect(bank.catalog).toBeNull();expect((await bank.metadata()).clips[naturalId]).toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['absent',undefined],
    ['foreign URL',{...clip(naturalId),url:'https://unrelated.invalid/sound.wav'}],
    ['overlong',{...clip(naturalId),duration:11}],
  ] as const)('rejects a %s option before downloading or decoding it',async(_case,badClip)=>{
    const data=catalog();if(badClip)data.clips[naturalId]=badClip;else delete data.clips[naturalId];
    const fetch=vi.fn(async()=>json(data));vi.stubGlobal('fetch',fetch);
    const {ctx,decodeAudioData}=context(),bank=new PaletteBank(ctx);
    await expect(bank.load('masonryImpact','natural')).rejects.toThrow(`Sound option unavailable: ${naturalId}`);
    expect(bank.failures.has(naturalId)).toBe(true);expect(fetch).toHaveBeenCalledTimes(1);expect(decodeAudioData).not.toHaveBeenCalled();
  });

  it('leaves original recordings in the base bank without making optional requests',async()=>{
    const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
    await expect(new PaletteBank(context().ctx).load('masonryImpact','original')).rejects.toThrow('base bank');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('audition reference level',()=>{
  it('matches sustained recordings with different amplitudes to the same RMS',()=>{
    for(const amplitude of [.055,.22,.88]) {
      const signal=Float32Array.from({length:1000},(_,i)=>i%2?amplitude:-amplitude);
      const gain=referenceGain(audio(signal));
      expect(gain*amplitude).toBeCloseTo(.11,6);
    }
  });

  it('uses the loudest sliding 400 ms window, without quiet padding lowering the reference',()=>{
    const signal=new Float32Array(5000);
    for(let i=1219;i<1619;i++)signal[i]=i%2?.2:-.2;
    expect(referenceGain(audio(signal))).toBeCloseTo(.55,6);
    expect(referenceGain(audio(new Float32Array(400).fill(.2)))).toBeCloseTo(.55,6);
  });

  it('measures the entire clip when it is shorter than 400 ms',()=>{
    expect(referenceGain(audio(new Float32Array(75).fill(.2)))).toBeCloseTo(.55,6);
  });

  it('preserves a sharp transient by honoring the peak ceiling before the RMS target',()=>{
    const signal=new Float32Array(1000);signal[517]=1;
    const gain=referenceGain(audio(signal));
    expect(gain).toBeCloseTo(.85,8);expect(signal[517]*gain).toBeLessThanOrEqual(.85);
  });

  it('bounds quiet-clip boosts and handles silence and empty buffers without infinities',()=>{
    expect(referenceGain(audio(new Float32Array(1000).fill(.001)))).toBe(4);
    expect(referenceGain(audio(new Float32Array(1000)))).toBe(1);
    expect(referenceGain(audio(new Float32Array()))).toBe(1);
  });

  it('caches measurement per decoded buffer so repeated auditions do not rescan PCM',()=>{
    const a=audio(new Float32Array(1000).fill(.1)),b=audio(new Float32Array(1000).fill(.2));
    expect(referenceGain(a)).toBeCloseTo(1.1,6);expect(referenceGain(a)).toBeCloseTo(1.1,6);
    expect(a.getChannelData).toHaveBeenCalledTimes(1);
    expect(referenceGain(b)).toBeCloseTo(.55,6);expect(b.getChannelData).toHaveBeenCalledTimes(1);
  });
});
