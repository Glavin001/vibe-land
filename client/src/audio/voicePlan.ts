// engine.ts `play`'s recipe for one event with the original palette, as a pure plan: which clips,
// how loud before distance (the voice's intensity), at what rate, how long after the event's
// arrival, in which role. The shared client core has the same recipe (client-core audio.rs
// `voice_plan`, the Unreal client's); `?coreAudio=1` plays the core's (coreVoicePlan.ts), and
// voicePlan.core.test.ts holds the two equal.
import { clamp, seedRandom, type SoundEvent } from './model';
import { eventMix, type VoiceRole } from './destructionMix';
import type { AudioSettings } from './settings';

export interface PlannedVoice {
  clip: string;
  level: number;
  rate: number;
  /** Seconds after the event's arrival. */
  delay: number;
  role: VoiceRole;
  protected: boolean;
}

export type VoicePlanner = (e: SoundEvent, s: AudioSettings) => PlannedVoice[];

export const planEventVoices: VoicePlanner = (e, s) => {
  const r = seedRandom(e.seed), intensity = clamp(e.intensity), mix = eventMix(e, s);
  const rate = clamp(1.04 - Math.log1p(Math.max(0, e.size)) * .065 + (r() - .5) * .13, .57, 1.2);
  const variant = Math.floor(r() * 5);
  const protectedSound = Boolean(e.protected) || e.kind === 'flyby';
  if (e.kind === 'flyby') {
    return [{ clip: 'flyby-' + variant % 4, level: (.15 + intensity * .85) * s.flyby, rate: clamp(rate * 1.2, .8, 1.5), delay: 0, role: 'threat', protected: true }];
  }
  const plan: PlannedVoice[] = [];
  const hit = e.kind === 'shot' ? `shot-${e.size <= .2 ? 'rifle' : 'cannon'}-${variant % 3}`
    : e.kind === 'collapse' ? 'collapse-' + variant % 4
    : `${e.material}-${e.kind === 'fracture' ? 'fracture-' + variant % 3 : 'impact-' + variant}`;
  plan.push({ clip: hit, level: mix.hit, rate, delay: 0, role: 'impact', protected: protectedSound });
  if (mix.body > .01 && e.kind !== 'shot') {
    plan.push({ clip: `heavy-${e.material}`, level: mix.body, rate: clamp(rate, .68, 1.1), delay: .009, role: 'body', protected: protectedSound });
  }
  if (intensity > .4 && e.kind !== 'shot') {
    plan.push({ clip: `${e.material}-fracture-${(variant + 1) % 3}`, level: mix.detail, rate: rate * 1.11, delay: .025, role: 'detail', protected: false });
  }
  return plan;
};

let planner: VoicePlanner = planEventVoices;

/** The planner `engine.ts` plays (the core's under `?coreAudio=1`, installed by coreVoicePlan.ts). */
export function voicePlanner(): VoicePlanner {
  return planner;
}

export function provideVoicePlanner(next: VoicePlanner): void {
  planner = next;
}
