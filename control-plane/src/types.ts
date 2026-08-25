/**
 * Wire contracts shared between the Worker, the game server, and the browser.
 *
 * Certificate hashes are lowercase hex everywhere in this system. The Rust
 * server emits hex from `/session-config`, and the browser converts hex to
 * bytes for `serverCertificateHashes`. Base64 shows up in the WebTransport
 * literature but never crosses our wire.
 */

/** Lifecycle of one rented box. Only a heartbeat promotes BOOTING to READY. */
export type Phase = 'SEARCHING' | 'BOOTING' | 'READY' | 'DEAD';

/** Connect metadata relayed from the game server to the browser. */
export interface SessionBlock {
  url: string;
  sim_hz: number;
  snapshot_hz: number;
  interpolation_delay_ms: number;
  protocol_version: number;
  physics_backend: number;
  client_movement_mode: number;
  city_manifest_hash?: string;
}

/** POST /servers/heartbeat -- must match `HeartbeatBody` in server/src/heartbeat.rs. */
export interface HeartbeatBody {
  server_do_id: string;
  ip: string;
  udp_port: number;
  cert_hash: string;
  active_matches: number;
  players: number;
  capacity: number;
  session: SessionBlock;
}

export interface JoinReady {
  ready: true;
  matchId: string;
  url: string;
  certHashHex: string;
  session: SessionBlock;
}

export interface JoinPending {
  ready: false;
  phase: Phase | 'NONE';
  etaSeconds: number;
  retryAfterSeconds: number;
  reason?: string;
}

export type JoinResponse = JoinReady | JoinPending;

export interface FleetRow {
  serverDoId: string;
  phase: Phase;
  vastInstanceId: number | null;
  dph: number | null;
  uptimeSeconds: number;
  spendUsd: number;
  activeMatches: number;
  players: number;
  capacity: number;
  heartbeatAgeSeconds: number | null;
  attempt: number;
  ip: string | null;
  udpPort: number | null;
  pendingDelete: boolean;
  deadReason: string | null;
}
