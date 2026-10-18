import { closestPass, distance, MATERIALS, seedRandom, type AcousticMaterial, type ContinuousSound, type SoundEvent, type Vec3 } from './model';
import { sanitizeSettings, type AudioSettings } from './settings';

export type ReviewScenarioId = 'interior' | 'hero' | 'mailbox' | 'cannonball' | 'materials' | 'scrape' | 'vehicle' | 'stress';
export const REVIEW_SCENARIOS: readonly { id: ReviewScenarioId; title: string; subtitle: string; listenFor: string; durationMs: number }[] = [
  { id: 'interior', title: 'Inside the collapse', subtitle: 'Overhead slabs · heavy debris', listenFor: 'Stand inside a building as the floors give way around you. Heavy concrete, stone, and steel should hold their weight through sustained rubble, then yield to quiet settling. Compare Close and Distant from the same seed.', durationMs: 16000 },
  { id: 'hero', title: 'The close call', subtitle: 'Meteor · building · aftermath', listenFor: 'Follow the meteor overhead, the nearby slab, then the last stones settling. The close pass should remain clear through the collapse.', durationMs: 13000 },
  { id: 'mailbox', title: 'Small things matter', subtitle: 'Hollow metal · loose parts', listenFor: 'A short body resonance, a loose panel, and progressively lighter rattles. Small interactions should retain their character.', durationMs: 5500 },
  { id: 'cannonball', title: 'Missed by inches', subtitle: 'Fast approach · near miss', listenFor: 'Track the ball from front right to rear left. Its closest pass should feel distinct from the distant shot and landing.', durationMs: 6000 },
  { id: 'materials', title: 'Material palette', subtitle: 'Seven surfaces · identical scale', listenFor: 'Compare contact and break texture across seven materials. Every pair uses the same intensity, scale, and distance.', durationMs: 14500 },
  { id: 'scrape', title: 'Weight in motion', subtitle: 'Sliding · rolling · settling', listenFor: 'Rough contact evolves as a slab slides and slows, then gives way to individual stones. Listen for smooth changes without repeated attacks.', durationMs: 10500 },
  { id: 'vehicle', title: 'The buggy', subtitle: 'Approach · chassis · panels', listenFor: 'Follow the vehicle across the scene, into an impact, then hear the chassis, sheet metal, and glass separate.', durationMs: 10000 },
  { id: 'stress', title: 'Ten thousand contacts', subtitle: 'Dense debris · protected danger', listenFor: 'A synthetic 10,000-event workload. The nearby flybys should survive the two spatially separate collapses and the voice budget should remain bounded.', durationMs: 12500 },
];
export interface ReviewEmitter extends Omit<ContinuousSound, 'position'> {
  startMs: number;
  endMs: number;
  from: Vec3;
  to: Vec3;
  endIntensity?: number;
  endSpeed?: number;
}
export interface ReviewMarker { atMs: number; label: string; }
export interface ReviewScenario {
  id: ReviewScenarioId;
  seed: number;
  durationMs: number;
  events: SoundEvent[];
  emitters: ReviewEmitter[];
  markers: ReviewMarker[];
}

/** Scripted listening fixtures. This is deliberately independent of a server
 * or physics simulation so a mix comparison replays identical input. */
export function createReviewScenario(id: ReviewScenarioId, seed = 2026): ReviewScenario {
  const meta = REVIEW_SCENARIOS.find(s => s.id === id) ?? REVIEW_SCENARIOS[0];
  const random = seedRandom(seed), events: SoundEvent[] = [], emitters: ReviewEmitter[] = [], markers: ReviewMarker[] = [];
  const closeListener:Vec3=[0,1.7,0];
  const add = (atMs: number, kind: SoundEvent['kind'], material: AcousticMaterial, position: Vec3, intensity: number, size: number, protectedSound = false) => {
    const event:SoundEvent={ id: `${id}-${events.length}`, atMs, kind, material, position, intensity, size, seed: Math.floor(random() * 2147483647), protected: protectedSound };
    events.push(event);return event;
  };
  // A continuous approach and its one-shot pass describe the same trajectory,
  // rather than separate authored positions that jump at the near-miss beat.
  const flight=(emitter:Omit<ReviewEmitter,'speed'|'endSpeed'>,intensity:number,size:number)=>{
    const velocity=emitter.to.map((v,i)=>(v-emitter.from[i])*1000/(emitter.endMs-emitter.startMs)) as unknown as Vec3;
    const speed=Math.hypot(...velocity);emitters.push({...emitter,speed,endSpeed:speed});
    const pass=closestPass(emitter.from,emitter.to,closeListener,closeListener);
    const event=add(emitter.startMs+pass.fraction*(emitter.endMs-emitter.startMs),'flyby',emitter.material,pass.position,intensity,size,true);
    event.velocity=velocity;event.missDistance=pass.distance;
  };
  const debrisPass=(atMs:number,material:AcousticMaterial,position:Vec3,intensity:number,size:number,direction:Vec3,speed:number)=>{
    const offset=position.map((p,i)=>p-closeListener[i]);
    const distanceSquared=offset.reduce((sum,p)=>sum+p*p,0);
    const projection=offset.reduce((sum,p,i)=>sum+p*direction[i],0)/Math.max(1e-9,distanceSquared);
    const tangent=direction.map((v,i)=>v-offset[i]*projection),length=Math.hypot(...tangent);
    const event=add(atMs,'flyby',material,position,intensity,size,true);
    event.velocity=tangent.map(v=>v*speed/length) as unknown as Vec3;
    event.missDistance=distance(position,closeListener);
  };
  const debris = (count: number, start: number, span: number, material: AcousticMaterial, center: Vec3, radius: number, strength = .6) => {
    for (let i = 0; i < count; i++) {
      const t = random(), angle = random() * Math.PI * 2, r = Math.sqrt(random()) * radius;
      add(start + t * span, 'impact', material, [center[0] + Math.cos(angle) * r, .15 + random() * 1.2, center[2] + Math.sin(angle) * r], .08 + strength * (1 - t) * (.3 + random() * .7), .1 + random() * (1 - t) * 3);
    }
  };
  const marker = (atMs: number, label: string) => markers.push({ atMs, label });
  if (id === 'interior') {
    marker(350, 'Ceiling cracks'); marker(1100, 'Floors give way'); marker(4100, 'Around you'); marker(7900, 'Last slabs'); marker(11600, 'Settling');
    add(350, 'fracture', 'concrete', [1, 9, -2], .86, 12);
    add(690, 'fracture', 'metal', [-3, 6, -3], .76, 9);
    // Successive floors fail above the listener. The surrounding debris uses
    // ordinary unprotected events so this exercises real crowd selection.
    for (let i = 0; i < 13; i++) {
      const t = 1100 + i * 760, angle = i * 2.399963, radius = 3 + random() * 4;
      const x = Math.cos(angle) * radius, z = Math.sin(angle) * radius;
      const material: AcousticMaterial = i % 4 === 2 ? 'stone' : i % 4 === 3 ? 'metal' : 'concrete';
      add(t, i % 3 === 0 ? 'collapse' : 'fracture', material, [x, 6 + random() * 5, z], .79 + random() * .2, 10 + random() * 18);
      add(t + 330, 'impact', material, [x * .85, .3, z * .85], .78 + random() * .19, 8 + random() * 14);
    }
    emitters.push({ id: 'interior-slabs-left', kind: 'scrape', material: 'concrete', from: [-5, 1, -4], to: [-2, .2, 4], startMs: 1400, endMs: 11400, intensity: .72, endIntensity: .24, speed: 12, endSpeed: 2 });
    emitters.push({ id: 'interior-stone-right', kind: 'roll', material: 'stone', from: [5, 2, -3], to: [3, .2, 5], startMs: 2200, endMs: 11800, intensity: .63, endIntensity: .16, speed: 10, endSpeed: 1 });
    emitters.push({ id: 'interior-steel', kind: 'scrape', material: 'metal', from: [-4, 5, 2], to: [-6, .2, 3], startMs: 1700, endMs: 6300, intensity: .58, endIntensity: .16, speed: 6, endSpeed: .4 });
    emitters.push({ id: 'interior-slabs-rear', kind: 'scrape', material: 'concrete', from: [3, 1, 6], to: [-1, .2, 4], startMs: 4200, endMs: 11000, intensity: .62, endIntensity: .18, speed: 8, endSpeed: 1 });
    // Maintain dense medium rubble throughout the collapse rather than fading
    // every contact immediately after the first hit. The authored tail below
    // has its own smaller scale and lower intensity.
    for (let i = 0; i < 720; i++) {
      const t = 1450 + random() * 9600, angle = random() * Math.PI * 2, radius = 2 + random() * 7;
      const material: AcousticMaterial = i % 9 === 0 ? 'metal' : i % 3 === 0 ? 'stone' : 'concrete';
      add(t, i % 7 === 0 ? 'fracture' : 'impact', material, [Math.cos(angle) * radius, i % 7 === 0 ? 3 + random() * 5 : .15 + random() * 1.2, Math.sin(angle) * radius], .26 + random() * .42, .8 + random() * 4.2);
    }
    debrisPass(3700,'concrete',[-1.1,2.2,.5],.94,2.5,[1,-.3,1],46);
    debrisPass(7500,'metal',[1.3,2.5,-.6],.92,1.5,[-1,-.2,-1],64);
    for (let i = 0; i < 80; i++) {
      const fraction = random(), t = 11500 + fraction * 3500, angle = random() * Math.PI * 2;
      add(t, 'impact', i % 3 === 0 ? 'stone' : 'concrete', [Math.cos(angle) * (2 + random() * 5), .1, Math.sin(angle) * (2 + random() * 5)], .07 + .19 * (1 - fraction), .08 + .6 * (1 - fraction));
    }
  } else if (id === 'hero') {
    flight({ id: 'meteor-approach', kind: 'air', material: 'stone', from: [-38, 45, 48], to: [11, 0, -14], startMs: 150, endMs: 2400, intensity: .2, endIntensity: .95 },.72,3);
    marker(0, 'Approach'); marker(2400, 'Impact'); marker(4100, 'Close debris'); marker(8500, 'Aftermath');
    add(2400, 'collapse', 'earth', [11, .2, -14], 1, 30);
    add(2680, 'fracture', 'concrete', [15, 8, -18], .9, 14);
    add(2920, 'fracture', 'glass', [13, 6, -15], .7, 3);
    add(3300, 'collapse', 'concrete', [17, 5, -17], .95, 20);
    add(3700, 'fracture', 'metal', [16, 4, -12], .65, 5);
    flight({ id: 'near-slab', kind: 'air', material: 'concrete', from: [14, 8, -16], to: [-9, .3, 9], startMs: 3650, endMs: 4550, intensity: .35, endIntensity: .2 },.97,2);
    add(4570, 'impact', 'concrete', [-9, .2, 9], .83, 6);
    debris(220, 2850, 6500, 'concrete', [15, .2, -16], 13, .62);
    debris(48, 3300, 3000, 'glass', [12, .2, -12], 7, .3);
    add(10100, 'impact', 'stone', [3, .1, -3], .22, .2);
    add(10940, 'impact', 'stone', [3.1, .1, -3], .11, .12);
  } else if (id === 'mailbox') {
    marker(500, 'Contact'); marker(900, 'Loose panel'); marker(2200, 'Settling');
    add(500, 'impact', 'sheet', [2.8, 1.2, -3.5], .63, .8);
    add(580, 'impact', 'metal', [2.8, .5, -3.5], .26, .4);
    add(910, 'fracture', 'sheet', [2.7, .7, -3.4], .42, .7);
    [1250, 1560, 1800, 2230, 2790, 3480].forEach((t, i) => add(t, 'impact', 'sheet', [2.8 + i * .07, .1, -3.3], .28 / (1 + i * .35), .35));
  } else if (id === 'cannonball') {
    marker(250, 'Distant shot'); marker(1200, 'Near miss'); marker(2050, 'Landing');
    add(250, 'shot', 'metal', [35, 2, -40], .95, 5);
    flight({ id: 'ball-flight', kind: 'air', material: 'metal', from: [28, 3.6, -28], to: [-28, .5, 30], startMs: 350, endMs: 2000, intensity: .4, endIntensity: .4 },.98,.5);
    add(2050, 'impact', 'concrete', [-28, .2, 30], .86, 7);
    debris(28, 2250, 2200, 'stone', [-27, .2, 30], 5, .5);
  } else if (id === 'materials') {
    MATERIALS.forEach((material, i) => {
      const t = 450 + i * 1900;
      marker(t, material === 'sheet' ? 'Sheet metal' : material[0].toUpperCase() + material.slice(1));
      add(t, 'impact', material, [0, 1, -6], .64, 1.5);
      add(t + 850, 'fracture', material, [0, 1, -6], .64, 1.5);
    });
  } else if (id === 'scrape') {
    marker(400, 'Slab lands'); marker(850, 'Sliding'); marker(4700, 'Rolling'); marker(8500, 'Settling');
    add(400, 'impact', 'concrete', [-9, .4, -8], .74, 8);
    emitters.push({ id: 'slab-slide', kind: 'scrape', material: 'concrete', from: [-9, .2, -8], to: [4, .2, -3], startMs: 700, endMs: 5800, intensity: .9, endIntensity: .05, speed: 13, endSpeed: .4 });
    emitters.push({ id: 'stone-roll', kind: 'roll', material: 'stone', from: [-3, .15, -4], to: [5, .15, 1], startMs: 4500, endMs: 8800, intensity: .62, endIntensity: .025, speed: 8, endSpeed: .2 });
    [1300, 2350, 3500, 4950, 5550, 6400, 7450, 8580].forEach((t, i) => add(t, 'impact', 'stone', [-5 + i, .2, -5 + i * .6], .38 - i * .035, 1.5 - i * .15));
  } else if (id === 'vehicle') {
    marker(0, 'Approach'); marker(3200, 'Chassis'); marker(4300, 'Loose parts'); marker(7000, 'Aftermath');
    emitters.push({ id: 'buggy-engine', kind: 'engine', material: 'metal', from: [-32, .8, -8], to: [7, .8, -5], startMs: 0, endMs: 3200, intensity: .5, endIntensity: .75, speed: 16, endSpeed: 8 });
    add(3210, 'impact', 'metal', [7, .8, -5], .86, 10);
    add(3270, 'fracture', 'concrete', [9, 1, -5], .74, 5);
    add(3330, 'fracture', 'glass', [7, 1.5, -5], .7, .8);
    add(3410, 'fracture', 'sheet', [7, .5, -5], .83, 2);
    emitters.push({ id: 'chassis-slide', kind: 'scrape', material: 'metal', from: [7, .2, -5], to: [11, .2, -4], startMs: 3330, endMs: 5200, intensity: .75, endIntensity: .05, speed: 7, endSpeed: .3 });
    debris(65, 3530, 4100, 'sheet', [9, .2, -4], 5, .45);
    debris(30, 3600, 2100, 'glass', [8, .2, -5], 4, .22);
  } else {
    marker(400, 'Left collapse'); marker(1400, 'Right collapse'); marker(3800, 'Close pass'); marker(7100, 'Second pass'); marker(10500, 'Tail');
    add(400, 'collapse', 'concrete', [-28, 6, -24], .94, 25);
    add(1400, 'collapse', 'concrete', [28, 6, -24], .94, 25);
    debrisPass(3800,'metal',[-1.2,1.8,0],.95,.5,[0,0,1],95);
    debrisPass(7100,'concrete',[1.2,2.1,0],.95,1,[0,-.2,-1],50);
    debris(4998, 450, 10000, 'concrete', [-28, .2, -24], 14, .8);
    debris(4998, 1450, 9000, 'stone', [28, .2, -24], 14, .8);
  }
  events.sort((a, b) => a.atMs - b.atMs);
  return { id: meta.id, seed, durationMs: meta.durationMs, events, emitters, markers };
}

/** Monotonic cursor keeps the 10,000-contact fixture O(new events) per frame. */
export class ReviewTransport {
  private cursor = 0;
  constructor(readonly scenario: ReviewScenario) {}
  seek(elapsedMs: number): void {
    this.cursor = 0;
    if (elapsedMs <= 0) return;
    while (this.cursor < this.scenario.events.length && this.scenario.events[this.cursor].atMs <= elapsedMs) this.cursor++;
  }
  advance(elapsedMs: number): SoundEvent[] {
    const start = this.cursor;
    while (this.cursor < this.scenario.events.length && this.scenario.events[this.cursor].atMs <= elapsedMs) this.cursor++;
    return this.scenario.events.slice(start, this.cursor);
  }
}
export function sampleReviewEmitters(scenario: ReviewScenario, elapsedMs: number): ContinuousSound[] {
  return scenario.emitters.filter(e => elapsedMs >= e.startMs && elapsedMs < e.endMs).map(e => {
    const t = (elapsedMs - e.startMs) / (e.endMs - e.startMs);
    const mix = (a: number, b: number) => a + (b - a) * t;
    const velocity = e.to.map((value, index) => (value - e.from[index]) * 1000 / (e.endMs - e.startMs)) as unknown as Vec3;
    return { id: e.id, kind: e.kind, material: e.material, position: [mix(e.from[0], e.to[0]), mix(e.from[1], e.to[1]), mix(e.from[2], e.to[2])] as Vec3, intensity: mix(e.intensity, e.endIntensity ?? e.intensity), speed: mix(e.speed, e.endSpeed ?? e.speed), velocity, occlusion: e.occlusion };
  });
}

export function parseReviewSettings(text: string): AudioSettings {
  const data: unknown = JSON.parse(text);
  if (!data || typeof data !== 'object') throw new Error('Choose a sound-review JSON file.');
  const raw = data as { type?: string; version?: number; settings?: unknown };
  if (raw.type !== 'vibe-audio-review' || raw.version !== 1 || !raw.settings || typeof raw.settings !== 'object' || Array.isArray(raw.settings)) throw new Error('This is not a supported sound-review file.');
  const settings = raw.settings as Record<string, unknown>;
  for (const key of ['master', 'impact', 'detail', 'bass', 'space', 'flyby', 'ringing', 'maxVoices']) {
    if (typeof settings[key] !== 'number' || !Number.isFinite(settings[key])) throw new Error('The review file contains invalid sound settings.');
  }
  if (typeof settings.enabled !== 'boolean' || !['headphones', 'stereo', 'surround51', 'surround71'].includes(String(settings.output)) || !['cinematic', 'natural', 'clarity'].includes(String(settings.preset)) || !['cinematic', 'balanced', 'night'].includes(String(settings.dynamicRange))) throw new Error('The review file contains invalid sound settings.');
  return sanitizeSettings(settings as Partial<AudioSettings>);
}


export type ReviewImpactScale = 'small' | 'heavy';
/** Compare scale alone: same material, seed, intensity and placement. */
export function createMaterialAudition(material: AcousticMaterial, scale: ReviewImpactScale, seed: number, atMs: number): SoundEvent {
  return {
    id: `audition-${material}-${scale}-${atMs}`, kind: 'impact', material,
    position: [0, 1, -6], intensity: .72, size: scale === 'heavy' ? 18 : .3,
    seed, atMs, protected: true,
  };
}
