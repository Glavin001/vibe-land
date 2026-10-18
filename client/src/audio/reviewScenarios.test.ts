import { describe, expect, it } from 'vitest';
import { MATERIALS } from './model';
import { createReviewScenario, REVIEW_SCENARIOS, ReviewTransport, sampleReviewEmitters, parseReviewSettings, createMaterialAudition } from './reviewScenarios';
import { DEFAULT_AUDIO } from './settings';

describe('repeatable audio review sequences', () => {
  it('rebuilds exactly the same performance from a seed', () => {
    const a = createReviewScenario('hero', 421);
    expect(createReviewScenario('hero', 421)).toEqual(a);
    expect(createReviewScenario('hero', 422).events).not.toEqual(a.events);
    for (const meta of REVIEW_SCENARIOS) {
      const scene = createReviewScenario(meta.id, 421);
      expect(new Set(scene.events.map(e => e.id)).size).toBe(scene.events.length);
      expect(scene.events.every((e, i) => e.atMs >= 0 && e.atMs < scene.durationMs && (!i || e.atMs >= scene.events[i - 1].atMs))).toBe(true);
    }
  });
  it('auditions every material and protects close danger during a collapse', () => {
    expect(new Set(createReviewScenario('materials').events.map(e => e.material))).toEqual(new Set(MATERIALS));
    const hero = createReviewScenario('hero');
    expect(hero.events.some(e => e.kind === 'collapse')).toBe(true);
    expect(hero.events.some(e => e.kind === 'flyby' && e.protected)).toBe(true);
    expect(createReviewScenario('stress').events).toHaveLength(10_000);
    expect(createReviewScenario('stress').events.some(e => e.kind === 'flyby' && e.protected)).toBe(true);
  });
  it('gives every authored flyby a coherent world trajectory and closest-pass distance',()=>{
    const listener=[0,1.7,0];
    for(const meta of REVIEW_SCENARIOS){
      for(const event of createReviewScenario(meta.id).events.filter(e=>e.kind==='flyby')){
        expect(event.velocity).toBeDefined();
        expect(event.velocity!.every(Number.isFinite)).toBe(true);
        expect(Math.hypot(...event.velocity!)).toBeGreaterThan(14);
        const offset=event.position.map((p,i)=>p-listener[i]);
        expect(event.missDistance).toBeCloseTo(Math.hypot(...offset));
        expect(offset.reduce((sum,p,i)=>sum+p*event.velocity![i],0)).toBeCloseTo(0,5);
      }
    }
  });
  it('places cannonball and meteor/debris passes on their continuous flight paths',()=>{
    for(const id of ['hero','cannonball'] as const){
      const scenario=createReviewScenario(id);
      for(const event of scenario.events.filter(e=>e.kind==='flyby')){
        const emitter=sampleReviewEmitters(scenario,event.atMs).find(e=>e.material===event.material&&e.kind==='air');
        expect(emitter).toBeDefined();
        event.position.forEach((value,i)=>expect(value).toBeCloseTo(emitter!.position[i]));
        event.velocity!.forEach((value,i)=>expect(value).toBeCloseTo(emitter!.velocity![i]));
      }
    }
  });
  it('puts the listener inside a sustained heavy collapse before the settling tail', () => {
    expect(REVIEW_SCENARIOS[0].id).toBe('interior');
    const scene = createReviewScenario('interior', 421);
    expect(createReviewScenario('interior', 421)).toEqual(scene);
    expect(createReviewScenario('interior', 422).events).not.toEqual(scene.events);
    const heavy = scene.events.filter(e => e.size >= 6 && e.intensity >= .65);
    expect(new Set(heavy.map(e => e.material))).toEqual(new Set(['concrete', 'stone', 'metal']));
    expect(heavy.some(e => e.position[1] > 6)).toBe(true);
    expect(heavy.some(e => e.position[0] < -2)).toBe(true);
    expect(heavy.some(e => e.position[0] > 2)).toBe(true);
    expect(heavy.every(e => Math.hypot(e.position[0], e.position[2]) <= 10)).toBe(true);
    for (let second = 1; second < 11; second++) {
      expect(heavy.some(e => e.atMs >= second * 1000 && e.atMs < (second + 1) * 1000)).toBe(true);
    }
    expect(scene.events.filter(e => e.atMs >= 12500).every(e => e.intensity < .3 && e.size < 1)).toBe(true);
    expect(scene.events.some(e => e.kind === 'flyby' && e.protected)).toBe(true);
    expect(sampleReviewEmitters(scene, 6000).length).toBeGreaterThanOrEqual(2);
    expect(sampleReviewEmitters(scene, 12500)).toEqual([]);
    expect(scene.durationMs).toBeGreaterThanOrEqual(15000);
  });
  it('isolates object scale in small and heavy material auditions', () => {
    for (const material of MATERIALS) {
      const small = createMaterialAudition(material, 'small', 421, 900);
      const heavy = createMaterialAudition(material, 'heavy', 421, 900);
      expect(heavy.size).toBeGreaterThan(small.size * 10);
      expect(heavy.intensity).toBe(small.intensity);
      expect(heavy.position).toEqual(small.position);
      expect(heavy.seed).toBe(small.seed);
      expect(heavy.material).toBe(material);
      expect(heavy.atMs).toBe(900);
    }
  });
  it('emits each event once, handles pause and replays after seeking', () => {
    const scene = createReviewScenario('mailbox');
    const clock = new ReviewTransport(scene);
    expect(clock.advance(0)).toEqual([]);
    const first = clock.advance(1000);
    expect(first.length).toBeGreaterThan(0);
    expect(clock.advance(1000)).toEqual([]);
    expect(clock.advance(2000).every(e => !first.some(f => f.id === e.id))).toBe(true);
    clock.seek(0);
    expect(clock.advance(1000)).toEqual(first);
    clock.seek(1000);
    expect(clock.advance(1000)).toEqual([]);
    expect(clock.advance(scene.durationMs)).toEqual(scene.events.filter(e => e.atMs > 1000));
  });
  it('samples smooth moving emitters only within their active interval', () => {
    const scene = createReviewScenario('cannonball');
    expect(sampleReviewEmitters(scene, -1)).toEqual([]);
    expect(sampleReviewEmitters(scene, scene.durationMs + 1)).toEqual([]);
    const source = scene.emitters[0];
    const start = sampleReviewEmitters(scene, source.startMs).find(e => e.id === source.id)!;
    const mid = sampleReviewEmitters(scene, (source.startMs + source.endMs) / 2).find(e => e.id === source.id)!;
    expect(start.position).toEqual(source.from);
    expect(mid.position[0]).toBeCloseTo((source.from[0] + source.to[0]) / 2);
    expect(mid.position[2]).toBeCloseTo((source.from[2] + source.to[2]) / 2);
    expect(mid.velocity?.[0]).toBeCloseTo((source.to[0] - source.from[0]) * 1000 / (source.endMs - source.startMs));
    expect(mid.velocity?.[2]).toBeCloseTo((source.to[2] - source.from[2]) * 1000 / (source.endMs - source.startMs));
    expect(sampleReviewEmitters(scene, source.endMs).some(e => e.id === source.id)).toBe(false);
  });
  it('imports only a compatible review report or settings snapshot', () => {
    expect(parseReviewSettings(JSON.stringify({ type: 'vibe-audio-review', version: 1, settings: DEFAULT_AUDIO }))).toEqual(DEFAULT_AUDIO);
    expect(() => parseReviewSettings('{')).toThrow();
    expect(() => parseReviewSettings(JSON.stringify({ type: 'unknown', settings: DEFAULT_AUDIO }))).toThrow();
    expect(() => parseReviewSettings(JSON.stringify({ type: 'vibe-audio-review', version: 2, settings: DEFAULT_AUDIO }))).toThrow();
    expect(() => parseReviewSettings(JSON.stringify({ type: 'vibe-audio-review', version: 1, settings: { master: 'loud' } }))).toThrow();
  });
});
