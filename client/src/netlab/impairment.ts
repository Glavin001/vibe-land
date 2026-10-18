/**
 * In-process network impairment for netlab runs.
 *
 * Activated by query params: `?netlab=1&impair=<profile>&impairSeed=<n>`.
 * This is the seeded, deterministic impairment mode: packets are delayed or
 * dropped in the JS callback path, *after* QUIC has already delivered them, so
 * it reproduces exactly but cannot model congestion-control response. The
 * netem mode (scripts/netem.sh) covers that; both read the same profile table.
 */

import type { LinkProfile } from '../loadtest/scenario';
import profilesJson from '../../netlab/netemProfiles.json';

export interface NetlabImpairmentProfile {
  delayMs: number;
  jitterMs: number;
  lossPct: number;
  reorderPct?: number;
  rateMbit?: number;
  limitPkts?: number;
  gemodelPct?: { p: number; r: number };
}

export interface ResolvedNetlabImpairment {
  name: string;
  seed: number;
  link: LinkProfile;
}

const PROFILES: Record<string, NetlabImpairmentProfile> = profilesJson.profiles;

export function getNetlabProfile(name: string): NetlabImpairmentProfile | null {
  return PROFILES[name] ?? null;
}

/**
 * Resolve the impairment requested by the page URL, or null.
 *
 * Requires the explicit `netlab=1` opt-in so a stray `?impair=` can never
 * degrade a real session, in dev or prod alike.
 */
export function resolveNetlabImpairment(search: string): ResolvedNetlabImpairment | null {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return null;
  }
  if (params.get('netlab') !== '1') return null;
  const name = params.get('impair');
  if (!name) return null;
  const profile = PROFILES[name];
  if (!profile) {
    console.warn(`[netlab] unknown impairment profile '${name}' — running unimpaired`);
    return null;
  }
  const seedRaw = Number(params.get('impairSeed'));
  const seed = Number.isFinite(seedRaw) ? Math.floor(seedRaw) : 42;
  return {
    name,
    seed,
    link: {
      latencyMs: profile.delayMs,
      jitterMs: profile.jitterMs,
      packetLossRate: profile.lossPct / 100,
    },
  };
}
