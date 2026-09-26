import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PerspectiveCamera } from 'three';
import type { SoundEvent } from './model';

const harness = vi.hoisted(() => ({
  now: 1000,
  enabled: true,
  playing: true,
  frame: null as (() => void) | null,
  cleanup: null as (() => void) | null,
  camera: null as unknown,
  flights: [] as Array<{ bodyId: number; radiusM: number }>,
  drawn: new Map<number, { source: string; position: [number, number, number]; raw: { velocity: [number, number, number] } }>(),
  removeLifecycle: vi.fn(),
  engine: {
    context: { state: 'running' },
    setListener: vi.fn(),
    stop: vi.fn(),
    emit: vi.fn<(event: SoundEvent) => void>(),
    continuous: vi.fn(),
    update: vi.fn(),
  },
}));
vi.mock('react', () => ({
  useRef: <T,>(value: T) => ({ current: value }),
  useEffect: (effect: () => (() => void)) => { harness.cleanup = effect(); },
}));
vi.mock('@react-three/fiber', () => ({
  useFrame: (frame: () => void) => { harness.frame = frame; },
  useThree: () => ({ camera: harness.camera }),
}));
vi.mock('./engine', () => ({ destructionAudio: () => harness.engine, installAudioLifecycle: () => harness.removeLifecycle }));
vi.mock('./settings', () => ({ audioSettings: () => ({ enabled: harness.enabled }) }));
vi.mock('../vfx/meteorFlights', () => ({ currentMeteorFlights: () => harness.flights, meteorDrawn: (id: number) => harness.drawn.get(id) }));

import { GameAudioLayer } from './GameAudioLayer';
import { contactEntityId, drainAudioContacts, ingestAudioContacts, resetAudioContacts } from './contactStream';
import { CityImpactAudioQueue } from './cityImpactSources';
import { DustImpactDetector } from '../city/dustImpacts';
import { DustSourceQueue } from '../city/destructionEvents';

type LayerProps = Parameters<typeof GameAudioLayer>[0];
type World = NonNullable<ReturnType<LayerProps['getRuntime']>>;
type City = NonNullable<ReturnType<LayerProps['getCityClient']>>;
type Body = World['state']['dynamicBodies'] extends Map<number, infer Value> ? Value : never;
type Vehicle = NonNullable<World['vehicles']> extends Map<number, infer Value> ? Value : never;

function world(): World {
  const bodies = new Map<number, Body>();
  return { state: { dynamicBodies: bodies, dynamicBodyInterpolationDelayMs: 70 }, vehicles: new Map(), getRenderedDynamicBodyState: id => bodies.get(id) ?? null };
}
function body(velocity: [number, number, number]): Body {
  return { id: 7, position: [10, 0, -10], velocity, halfExtents: [.5, .5, .5] } as Body;
}
function vehicle(velocity: [number, number, number]): Vehicle {
  return { id: 7, position: [10, 0, -10], linearVelocity: velocity } as Vehicle;
}
function contact(tick: number, a: number, b = 0x10000001, kind = 0): Uint8Array {
  const data = new Uint8Array(60), v = new DataView(data.buffer);
  data[0] = 131; data[1] = 1; data[2] = 1; v.setUint32(4, tick, true);
  v.setUint32(8, a, true); v.setUint32(12, b, true); data[16] = kind;
  [10, 0, -10, 0, 1, 0, 16, 3, .75, 1].forEach((value, index) => v.setFloat32(20 + index * 4, value, true));
  return data;
}
function fakeCity() {
  const key = 0x80000001;
  const city = {
    manifest: { manifest: { materialAppearance: [{ name: 'concrete' }, { name: 'oak wood' }], structures: [{ structureId: 0, chunks: [{ material: 1 }] }] } },
    topology: { body: (id: number) => id === key ? { structureId: 0, chunkSlots: [3] } : undefined, chunkNode: () => 0 },
    observeAudio: vi.fn(),
    drainAudioSources: vi.fn(),
    ledgerEpoch: () => 1,
    audioTickRate: () => 60,
    presentedTick: () => 54,
  };
  return { key, city: city as unknown as City, observe: city.observeAudio, drain: city.drainAudioSources };
}
function mount(w: World | null = world(), city: City | null = null, clock?: () => number): void {
  GameAudioLayer({ getRuntime: () => w, getCityClient: () => city, isPlaying: () => harness.playing, getNowMs: clock });
}
function frame(at = harness.now): void { harness.now = at; harness.frame!(); }
function emitted(): SoundEvent[] { return harness.engine.emit.mock.calls.map(([event]) => event); }

beforeEach(() => {
  vi.clearAllMocks(); resetAudioContacts();
  harness.now = 1000; harness.enabled = true; harness.playing = true; harness.frame = null; harness.cleanup = null;
  harness.engine.context.state = 'running'; harness.camera = new PerspectiveCamera(); harness.flights = []; harness.drawn.clear();
  vi.stubGlobal('document', { hidden: false });
  vi.spyOn(performance, 'now').mockImplementation(() => harness.now);
});
afterEach(() => { harness.cleanup?.(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('game audio integration', () => {
  it('keeps a city closest pass on its future presentation clock exactly once',()=>{
    const {city,key,observe}=fakeCity();mount(world(),city);frame();
    const motion=observe.mock.calls.at(-1)![1];
    motion(key,{structureId:0,chunkSlots:[3]},60,-8,1,0,160,0,0,1000,3,1100);
    harness.now=1050;
    motion(key,{structureId:0,chunkSlots:[3]},66,8,1,0,160,0,0,1000,3,1200);
    expect(emitted()).toEqual([expect.objectContaining({kind:'flyby',atMs:1150,position:[0,1,0],velocity:[160,0,0],material:'wood',size:3})]);
  });
  it('hears city impacts beyond the flyby budget with physical weight, true material and presentation time',()=>{
    const {city,observe,drain}=fakeCity(),queue=new CityImpactAudioQueue(),detector=new DustImpactDetector(),dust=new DustSourceQueue(1);
    drain.mockImplementation(visit=>queue.drain(visit));
    mount(world(),city);frame();
    const motion=observe.mock.calls.at(-1)![1];
    // Saturate the independent 256-body near-miss tracker. The impact source
    // below arrives from the detector that already sees every city body.
    for(let i=0;i<300;i++)motion(0x80000000+i,{structureId:0,chunkSlots:[3]},60,4,4,0,0,-6,0,1000,3,1100);
    const observer=(source:Parameters<CityImpactAudioQueue['noteImpact']>[0],evidence:Parameters<CityImpactAudioQueue['noteImpact']>[1])=>queue.noteImpact(source,evidence,60,1);
    detector.noteVelocity(0x80000300,0,60,4,4,0,0,-6,0,1000,3,1100,dust,observer);
    detector.noteVelocity(0x80000300,0,63,4,3.7,0,0,0,0,1000,3,1150,dust,observer);
    frame(1050);
    expect(emitted()).toEqual([expect.objectContaining({kind:'impact',material:'wood',size:3,atMs:1150,protected:true})]);
    expect(emitted()[0].intensity).toBeGreaterThan(.8);
    const nextMotion=observe.mock.calls.at(-1)![1];
    for(let i=0;i<300;i++)nextMotion(0x80000000+i,{structureId:0,chunkSlots:[3]},63,4,3.7,0,0,0,0,1000,3,1150);
    expect(emitted()).toHaveLength(1); // City motion may add flybys, never a second impact.
  });

  it.each([true,false])('suppresses a city velocity impact only for its matching authoritative body (%s)',matching=>{
    const {city,key,drain}=fakeCity();
    drain.mockImplementation(visit=>visit({kind:'impact',structureId:0,simTick:60,ordinal:7,x:10,y:0,z:-10,nx:0,ny:1,nz:0,vx:0,vy:0,vz:0,magnitude:1.5,count:1,material:0,atMs:1100},
      {entityId:key,material:1,mass:1000,size:3,intensity:.86,energy:18000}));
    ingestAudioContacts(contact(60,matching?key:key+1),1000);
    mount(world(),city);frame();
    expect(emitted().filter(e=>e.id.startsWith('break:'))).toHaveLength(matching?0:1);
    expect(emitted().filter(e=>e.id.startsWith('contact:'))).toHaveLength(1);
  });

  it('uses namespaced vehicle contacts without suppressing a dynamic body with the same user ID', () => {
    const w = world(); w.state.dynamicBodies.set(7, body([10, 0, 0])); w.vehicles!.set(7, vehicle([10, 0, 0]));
    mount(w); frame();
    w.state.dynamicBodies.set(7, body([0, 0, 0])); w.vehicles!.set(7, vehicle([0, 0, 0]));
    ingestAudioContacts(contact(6, contactEntityId('vehicle', 7)), 1050); frame(1050);
    const events = emitted();
    expect(events.find(e => e.id.startsWith('contact:'))).toMatchObject({ kind: 'impact', material: 'metal', atMs: 1120 });
    expect(events.some(e => e.id.startsWith('vehicle:7:'))).toBe(false);
    expect(events.some(e => e.id.startsWith('body:7:impact:'))).toBe(true);
  });

  it('drains replay arrivals on the tape clock and schedules against presented simulation time', () => {
    const { city, key } = fakeCity(); harness.now = 5000;
    ingestAudioContacts(contact(60, key), 100000);
    mount(world(), city, () => 100000); frame();
    expect(emitted()).toEqual([expect.objectContaining({ material: 'wood', atMs: 5100, kind: 'impact' })]);
    expect(drainAudioContacts(100000)).toEqual([]);
  });

  it.each(['paused', 'disabled', 'hidden', 'suspended'] as const)('discards incoming contacts while %s and does not burst on return', condition => {
    const { city, observe, drain } = fakeCity();
    if (condition === 'paused') harness.playing = false;
    if (condition === 'disabled') harness.enabled = false;
    if (condition === 'hidden') Object.assign(document, { hidden: true });
    if (condition === 'suspended') harness.engine.context.state = 'suspended';
    ingestAudioContacts(contact(60, contactEntityId('vehicle', 7)), 1000);
    mount(world(), city); frame();
    expect(observe.mock.calls.at(-1)?.[0]).toBe(false);
    expect(drain).not.toHaveBeenCalled();
    expect(harness.engine.emit).not.toHaveBeenCalled();
    expect(harness.engine.continuous).not.toHaveBeenCalled();
    harness.playing = true; harness.enabled = true; Object.assign(document, { hidden: false }); harness.engine.context.state = 'running';
    frame(1050);
    expect(emitted()).toEqual([]);
  });

  it.each([['arc', false], ['body', true]] as const)('a slowing meteor rendered from %s has impact permission %s', (source, shouldImpact) => {
    harness.flights = [{ bodyId: 9, radiusM: 1 }];
    harness.drawn.set(9, { source, position: [10, 0, -10], raw: { velocity: [40, 0, 0] } });
    mount(); frame();
    harness.drawn.set(9, { source, position: [10.1, 0, -10], raw: { velocity: [0, 0, 0] } });
    frame(1050);
    expect(emitted().some(e => e.kind === 'impact' || e.kind === 'collapse')).toBe(shouldImpact);
  });

  it('treats a confirmed high-speed meteor contact as a protected stone collapse', () => {
    harness.flights = [{ bodyId: 9, radiusM: 1 }];
    ingestAudioContacts(contact(6, contactEntityId('dynamic', 9)), 1000);
    mount(); frame();
    expect(emitted()).toEqual([expect.objectContaining({ kind: 'collapse', material: 'stone', protected: true })]);
  });

  it('keeps scrape emitter identity stable when contact actor order reverses', () => {
    const w = world(); w.vehicles!.set(7, vehicle([0, 0, 0]));
    const id = contactEntityId('vehicle', 7);
    mount(w); ingestAudioContacts(contact(3, id, 0x10000001, 1), 1000); frame();
    ingestAudioContacts(contact(6, 0x10000001, id, 1), 1050); frame(1050);
    const calls = harness.engine.continuous.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0]).toMatchObject({ material: 'metal', kind: 'scrape' });
    expect(calls[0][0].id).toBe(calls[1][0].id);
  });

  it('resets motion history and pending contacts when the replay clock rewinds', () => {
    const w = world(); let tapeTime = 20000;
    w.state.dynamicBodies.set(7, body([10, 0, 0]));
    mount(w, null, () => tapeTime); frame();
    ingestAudioContacts(contact(60, contactEntityId('dynamic', 7)), 20000);
    w.state.dynamicBodies.set(7, body([0, 0, 0])); tapeTime = 19000;
    frame(1050);
    expect(emitted()).toEqual([]);
    expect(drainAudioContacts(20000)).toEqual([]);
  });

  it('clears authoritative contacts and removes lifecycle listeners when unmounted', () => {
    const { city, observe } = fakeCity(); mount(world(), city); frame();
    ingestAudioContacts(contact(60, 1), 1000);
    harness.cleanup!(); harness.cleanup = null;
    expect(observe).toHaveBeenLastCalledWith(false);
    expect(harness.removeLifecycle).toHaveBeenCalledTimes(1);
    expect(drainAudioContacts(1000)).toEqual([]);
  });
});
