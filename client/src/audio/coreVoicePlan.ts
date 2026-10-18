// The voice plan from the shared client core (client-core audio.rs `voice_plan`, through
// client-core-wasm), behind `?coreAudio=1`.
import { voice_plan } from '../wasm/core-pkg/vibe_client_core_wasm.js';
import type { VoiceRole } from './destructionMix';
import type { PlannedVoice, VoicePlanner } from './voicePlan';

/** Needs the core's WASM loaded. */
export const coreVoicePlan: VoicePlanner = (e, s) => {
  const plan = voice_plan(e.kind, e.material, e.intensity, e.size, e.seed >>> 0, Boolean(e.protected),
    s.impact, s.detail, s.bass, s.flyby, s.dynamicRange);
  if (!plan) return [];
  const voices: PlannedVoice[] = [];
  for (let i = 0; i < plan.len(); i++) {
    voices.push({ clip: plan.clip(i), level: plan.level(i), rate: plan.rate(i), delay: plan.delay_s(i),
      role: (plan.role(i) || 'impact') as VoiceRole, protected: plan.protected(i) });
  }
  plan.free();
  return voices;
};
