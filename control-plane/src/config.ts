/** Worker bindings and the parsed, typed view of its vars. */

export interface Env {
  FLEET: DurableObjectNamespace;

  // vars
  SERVER_IMAGE: string;
  VAST_API_BASE: string;
  MATCHES_PER_BOX: string;
  MAX_PLAYERS_PER_MATCH: string;
  IDLE_SHUTDOWN_MIN: string;
  MAX_INSTANCE_UPTIME_H: string;
  MAX_INSTANCE_SPEND_USD: string;
  BOOT_TIMEOUT_MIN: string;
  HEARTBEAT_TIMEOUT_SEC: string;
  MAX_PROVISION_ATTEMPTS: string;
  INSTANCE_DISK_GB: string;
  CONTROL_PLANE_URL: string;

  // secrets
  VAST_API_KEY: string;
  HEARTBEAT_TOKEN: string;
  ADMIN_TOKEN: string;
  GHCR_PULL_USER?: string;
  GHCR_PULL_TOKEN?: string;
}

export interface FleetConfig {
  serverImage: string;
  vastApiBase: string;
  matchesPerBox: number;
  maxPlayersPerMatch: number;
  idleShutdownMs: number;
  maxUptimeMs: number;
  maxSpendUsd: number;
  bootTimeoutMs: number;
  heartbeatTimeoutMs: number;
  maxProvisionAttempts: number;
  diskGb: number;
  controlPlaneUrl: string;
}

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function readConfig(env: Env): FleetConfig {
  return {
    serverImage: env.SERVER_IMAGE,
    vastApiBase: (env.VAST_API_BASE || 'https://console.vast.ai').replace(/\/+$/, ''),
    matchesPerBox: num(env.MATCHES_PER_BOX, 6),
    maxPlayersPerMatch: num(env.MAX_PLAYERS_PER_MATCH, 16),
    idleShutdownMs: num(env.IDLE_SHUTDOWN_MIN, 10) * 60_000,
    maxUptimeMs: num(env.MAX_INSTANCE_UPTIME_H, 6) * 3_600_000,
    maxSpendUsd: num(env.MAX_INSTANCE_SPEND_USD, 5),
    bootTimeoutMs: num(env.BOOT_TIMEOUT_MIN, 7) * 60_000,
    heartbeatTimeoutMs: num(env.HEARTBEAT_TIMEOUT_SEC, 90) * 1000,
    maxProvisionAttempts: num(env.MAX_PROVISION_ATTEMPTS, 5),
    diskGb: num(env.INSTANCE_DISK_GB, 30),
    controlPlaneUrl: (env.CONTROL_PLANE_URL || '').replace(/\/+$/, ''),
  };
}

/**
 * Length-independent comparison. Bearer tokens here guard the ability to spend
 * money, so avoid leaking their length or a common prefix through timing.
 */
export function safeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  // Compare a fixed-size digest so differing lengths cost the same as differing
  // bytes; a raw length check would short-circuit and leak.
  let diff = left.length ^ right.length;
  const max = Math.max(left.length, right.length);
  for (let i = 0; i < max; i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get('Authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : null;
}
