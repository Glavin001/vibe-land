import { DurableObject } from 'cloudflare:workers';

import { readConfig, type Env, type FleetConfig } from './config';
import {
  VastAuthError,
  VastClient,
  isDeadStatus,
  type Instance,
} from './vast';
import type { FleetRow, HeartbeatBody, JoinResponse, Phase, SessionBlock } from './types';

/**
 * The whole fleet: registry, lifecycle, and the only thing that talks to Vast.
 *
 * One Durable Object owns every rented box rather than one DO per instance.
 * With a handful of boxes the bookkeeping fits comfortably in a single alarm
 * tick, and a single writer removes the "who decides this box is dead" race
 * entirely -- worth more at this scale than per-instance concurrency.
 *
 * Everything lives in SQLite. The DO can be evicted or the Worker redeployed
 * between any two lines here; nothing is held in memory across a tick, so the
 * next alarm resumes from storage with no duplicate rentals.
 */

const TICK_MS = 15_000;
/** Optimistic hold on a slot, covering the gap until the next heartbeat lands. */
const RESERVATION_MS = 60_000;
const INTERNAL_TCP_PORT = 4001;
const INTERNAL_UDP_PORT = 4433;

interface ServerRow extends Record<string, SqlStorageValue> {
  server_do_id: string;
  phase: Phase;
  vast_instance_id: number | null;
  offer_dph: number | null;
  create_intent: number;
  attempt: number;
  tried_machine_ids: string;
  created_at: number;
  boot_started_at: number | null;
  last_heartbeat_at: number | null;
  ip: string | null;
  udp_port: number | null;
  cert_hash_hex: string | null;
  active_matches: number;
  players: number;
  capacity: number;
  session_json: string | null;
  idle_since: number | null;
  reserved_count: number;
  reserved_at: number | null;
  pending_delete: number;
  kill_reason: string | null;
  dead_reason: string | null;
  spent_prior_usd: number;
  pending_offer_id: number | null;
  is_static: number;
}

export class FleetDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS servers (
          server_do_id      TEXT PRIMARY KEY,
          phase             TEXT NOT NULL,
          vast_instance_id  INTEGER,
          offer_dph         REAL,
          create_intent     INTEGER NOT NULL DEFAULT 0,
          attempt           INTEGER NOT NULL DEFAULT 0,
          tried_machine_ids TEXT NOT NULL DEFAULT '[]',
          created_at        INTEGER NOT NULL,
          boot_started_at   INTEGER,
          last_heartbeat_at INTEGER,
          ip                TEXT,
          udp_port          INTEGER,
          cert_hash_hex     TEXT,
          active_matches    INTEGER NOT NULL DEFAULT 0,
          players           INTEGER NOT NULL DEFAULT 0,
          capacity          INTEGER NOT NULL DEFAULT 6,
          session_json      TEXT,
          idle_since        INTEGER,
          reserved_count    INTEGER NOT NULL DEFAULT 0,
          reserved_at       INTEGER,
          pending_delete    INTEGER NOT NULL DEFAULT 0,
          kill_reason       TEXT,
          dead_reason       TEXT,
          spent_prior_usd   REAL NOT NULL DEFAULT 0,
          pending_offer_id  INTEGER,
          -- A box we did not rent: an operator's machine or a dev box. Exempt
          -- from the cost-based kills, since there is no bill to stop.
          is_static         INTEGER NOT NULL DEFAULT 0
        )
      `);
      // Durable Objects outlive deploys, so a table created by an earlier
      // version will not gain columns from the statement above.
      try {
        this.ctx.storage.sql.exec(
          'ALTER TABLE servers ADD COLUMN is_static INTEGER NOT NULL DEFAULT 0',
        );
      } catch {
        /* already present */
      }
    });
  }

  private sql() {
    return this.ctx.storage.sql;
  }

  private rows(): ServerRow[] {
    return this.sql().exec<ServerRow>('SELECT * FROM servers').toArray();
  }

  private row(id: string): ServerRow | null {
    return (
      this.sql().exec<ServerRow>('SELECT * FROM servers WHERE server_do_id = ?', id).toArray()[0] ??
      null
    );
  }

  private update(id: string, patch: Record<string, string | number | null>): void {
    const keys = Object.keys(patch);
    if (keys.length === 0) return;
    const assignments = keys.map((key) => `${key} = ?`).join(', ');
    this.sql().exec(
      `UPDATE servers SET ${assignments} WHERE server_do_id = ?`,
      ...keys.map((key) => patch[key]),
      id,
    );
  }

  private log(event: string, row: Pick<ServerRow, 'server_do_id' | 'phase'>, extra: object = {}) {
    console.log(
      JSON.stringify({ event, server: row.server_do_id, phase: row.phase, ...extra }),
    );
  }

  // ---------------------------------------------------------------- lifecycle

  /**
   * Dollars burned by this row so far, including previous destroyed attempts.
   * Deliberately an over-estimate against Vast's own accounting: it ignores
   * bandwidth and disk, so the cap trips early rather than late.
   */
  private spend(row: ServerRow, now: number): number {
    const running = row.boot_started_at ? Math.max(0, now - row.boot_started_at) : 0;
    return row.spent_prior_usd + ((row.offer_dph ?? 0) * running) / 3_600_000;
  }

  private scheduleNextTick(): void {
    const active = this.sql()
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM servers WHERE phase != 'DEAD'")
      .toArray()[0];
    if ((active?.n ?? 0) > 0) {
      this.ctx.storage.setAlarm(Date.now() + TICK_MS);
    }
  }

  async alarm(): Promise<void> {
    const config = readConfig(this.env);
    const vast = new VastClient(config.vastApiBase, this.env.VAST_API_KEY);
    const now = Date.now();

    for (const row of this.rows()) {
      if (row.phase === 'DEAD') continue;
      try {
        await this.step(row, config, vast, now);
      } catch (error) {
        if (error instanceof VastAuthError) {
          // Balance exhausted or key rotated. Nothing to do but keep the row
          // and retry -- destroying on an auth error would strand the instance.
          this.log('vast_auth_error', row, { error: String(error) });
        } else {
          this.log('tick_error', row, { error: String(error) });
        }
      }
    }
    this.scheduleNextTick();
  }

  private async step(
    row: ServerRow,
    config: FleetConfig,
    vast: VastClient,
    now: number,
  ): Promise<void> {
    // Deletion outranks everything: an instance we have decided to kill is
    // billing by the second until the DELETE lands.
    if (row.pending_delete === 1) {
      await this.stepDelete(row, config, vast, now);
      return;
    }
    switch (row.phase) {
      case 'SEARCHING':
        await this.stepSearching(row, config, vast, now);
        return;
      case 'BOOTING':
        await this.stepBooting(row, config, vast, now);
        return;
      case 'READY':
        this.stepReady(row, config, now);
        return;
    }
  }

  private async stepDelete(
    row: ServerRow,
    config: FleetConfig,
    vast: VastClient,
    now: number,
  ): Promise<void> {
    if (row.vast_instance_id) {
      // Throws on failure, which leaves the row untouched so the next tick
      // retries. An instance is never marked DEAD on an unconfirmed delete.
      await vast.destroyInstance(row.vast_instance_id);
    }

    const spend = this.spend(row, now);
    const reason = row.kill_reason ?? 'unknown';
    const retryable = reason === 'boot_failed' || reason === 'boot_timeout';

    if (retryable && row.attempt < config.maxProvisionAttempts) {
      // A bad host, not a bad plan: forget the instance and shop again.
      this.update(row.server_do_id, {
        phase: 'SEARCHING',
        vast_instance_id: null,
        offer_dph: null,
        pending_offer_id: null,
        create_intent: 0,
        pending_delete: 0,
        kill_reason: null,
        boot_started_at: null,
        last_heartbeat_at: null,
        idle_since: null,
        spent_prior_usd: spend,
      });
      this.log('destroyed_retry', row, { reason, attempt: row.attempt, spendUsd: spend });
      return;
    }

    this.update(row.server_do_id, {
      phase: 'DEAD',
      dead_reason: reason,
      pending_delete: 0,
      spent_prior_usd: spend,
      vast_instance_id: null,
    });
    this.log('destroyed', row, { reason, spendUsd: spend });
  }

  private async stepSearching(
    row: ServerRow,
    config: FleetConfig,
    vast: VastClient,
    now: number,
  ): Promise<void> {
    // Recovery path: the DO may have been evicted between sending the create
    // and recording the id. The label carries our own id, so an instance we are
    // already paying for gets adopted instead of leaked and re-rented.
    if (row.create_intent === 1 && !row.vast_instance_id) {
      const mine = (await vast.listInstances()).find(
        (instance) => instance.label === this.label(row.server_do_id),
      );
      if (mine) {
        this.adopt(row, mine, now);
        return;
      }
      this.update(row.server_do_id, { create_intent: 0 });
      return;
    }

    if (row.attempt >= config.maxProvisionAttempts) {
      this.update(row.server_do_id, { phase: 'DEAD', dead_reason: 'no_capacity' });
      this.log('no_capacity', row, { attempts: row.attempt });
      return;
    }

    if (row.pending_offer_id) {
      const offerId = row.pending_offer_id;
      // Intent is recorded *before* the call so an eviction mid-flight is
      // recoverable above rather than becoming a second rental.
      this.update(row.server_do_id, { create_intent: 1, attempt: row.attempt + 1 });
      try {
        const instanceId = await vast.createInstance(offerId, {
          image: config.serverImage,
          diskGb: config.diskGb,
          label: this.label(row.server_do_id),
          tcpPorts: [INTERNAL_TCP_PORT],
          udpPorts: [INTERNAL_UDP_PORT],
          registryUser: this.env.GHCR_PULL_USER,
          registryToken: this.env.GHCR_PULL_TOKEN,
          env: {
            CONTROL_PLANE_URL: config.controlPlaneUrl,
            SERVER_DO_ID: row.server_do_id,
            HEARTBEAT_TOKEN: this.env.HEARTBEAT_TOKEN,
            MATCHES_PER_BOX: String(config.matchesPerBox),
          },
        });
        this.update(row.server_do_id, {
          phase: 'BOOTING',
          vast_instance_id: instanceId,
          boot_started_at: now,
          pending_offer_id: null,
          create_intent: 0,
        });
        this.log('booting', row, { instanceId, offerId, dph: row.offer_dph });
      } catch (error) {
        // Offers go stale fast; someone else took it. Blacklist and re-shop.
        this.update(row.server_do_id, {
          pending_offer_id: null,
          create_intent: 0,
        });
        this.log('create_failed', row, { offerId, error: String(error) });
      }
      return;
    }

    const tried: number[] = JSON.parse(row.tried_machine_ids);
    const offers = await vast.searchOffers();
    const pick = offers.find((offer) => !tried.includes(offer.machineId));
    if (!pick) {
      // A fruitless search still burns an attempt so "nothing available
      // anywhere" terminates instead of looping until the spend cap.
      this.update(row.server_do_id, { attempt: row.attempt + 1 });
      this.log('no_offers', row, { attempt: row.attempt + 1 });
      return;
    }
    this.update(row.server_do_id, {
      pending_offer_id: pick.id,
      offer_dph: pick.dphTotal,
      tried_machine_ids: JSON.stringify([...tried, pick.machineId]),
    });
    this.log('offer_selected', row, { offerId: pick.id, dph: pick.dphTotal });
  }

  private adopt(row: ServerRow, instance: Instance, now: number): void {
    this.update(row.server_do_id, {
      phase: 'BOOTING',
      vast_instance_id: instance.id,
      boot_started_at: now,
      offer_dph: instance.dphTotal ?? row.offer_dph,
      create_intent: 0,
      pending_offer_id: null,
    });
    this.log('adopted_orphan', row, { instanceId: instance.id });
  }

  private async stepBooting(
    row: ServerRow,
    config: FleetConfig,
    vast: VastClient,
    now: number,
  ): Promise<void> {
    const startedAt = row.boot_started_at ?? now;

    if (now - startedAt > config.bootTimeoutMs) {
      this.markForDelete(row, 'boot_timeout');
      return;
    }
    if (!row.vast_instance_id) return;

    const instance = await vast.getInstance(row.vast_instance_id);
    if (isDeadStatus(instance.actualStatus)) {
      // The container refused to run here -- a missing UDP mapping makes our
      // entrypoint exit nonzero on purpose. Try a different host.
      this.markForDelete(row, 'boot_failed', { status: instance.actualStatus });
      return;
    }
    // Vast reporting "running" is necessary but not sufficient; only a
    // heartbeat proves the game server is actually listening.
  }

  private stepReady(row: ServerRow, config: FleetConfig, now: number): void {
    const since = row.last_heartbeat_at ?? 0;
    if (now - since > config.heartbeatTimeoutMs) {
      this.markForDelete(row, 'heartbeat_lost', { silentMs: now - since });
      return;
    }
    // Idle shutdown and the spend caps exist to stop paying for a rental. A
    // box we did not rent -- a dev machine, or one an operator runs -- costs
    // nothing to leave running, and reaping it strands players: nothing can
    // boot a replacement, so /join has no server to offer and never will.
    // Heartbeat loss still applies: that is liveness, not cost.
    if (row.is_static === 1) return;
    if (row.idle_since !== null && now - row.idle_since > config.idleShutdownMs) {
      this.markForDelete(row, 'idle', { idleMs: now - row.idle_since });
      return;
    }
    // Hard caps run regardless of how healthy the box claims to be: a wedged
    // server that keeps heartbeating with phantom players would otherwise bill
    // until someone noticed.
    const uptime = row.boot_started_at ? now - row.boot_started_at : 0;
    const spend = this.spend(row, now);
    if (uptime > config.maxUptimeMs || spend > config.maxSpendUsd) {
      this.markForDelete(row, 'hard_cap', { uptimeMs: uptime, spendUsd: spend });
    }
  }

  private markForDelete(row: ServerRow, reason: string, extra: object = {}): void {
    this.update(row.server_do_id, { pending_delete: 1, kill_reason: reason });
    this.log('kill_scheduled', row, { reason, ...extra });
  }

  private label(serverDoId: string): string {
    return `vl-${serverDoId}`;
  }

  // --------------------------------------------------------------------- RPC

  /**
   * Find a server with room, or start one.
   *
   * Returns immediately either way; a booting fleet is reported as a pending
   * result with an ETA rather than held open, because a cold start is minutes
   * long and no HTTP request should live that long.
   */
  async join(): Promise<JoinResponse> {
    const config = readConfig(this.env);
    const now = Date.now();

    const ready = this.rows()
      .filter((row) => row.phase === 'READY' && row.pending_delete === 0)
      .sort((a, b) => a.created_at - b.created_at);

    for (const row of ready) {
      // Heartbeats are 30 s apart, so recent joins are counted optimistically
      // to stop a burst of arrivals all landing on the same last free slot.
      const reserved =
        row.reserved_at && now - row.reserved_at < RESERVATION_MS ? row.reserved_count : 0;
      if (row.players + reserved >= config.maxPlayersPerMatch) continue;
      if (!row.ip || !row.udp_port || !row.session_json) continue;

      this.update(row.server_do_id, {
        reserved_count: reserved + 1,
        reserved_at: now,
        idle_since: null,
      });

      const session = JSON.parse(row.session_json) as SessionBlock;
      return {
        ready: true,
        matchId: this.matchId(row.server_do_id),
        url: session.url,
        certHashHex: row.cert_hash_hex ?? '',
        session,
      };
    }

    const booting = this.rows().find(
      (row) => (row.phase === 'SEARCHING' || row.phase === 'BOOTING') && row.pending_delete === 0,
    );
    if (booting) {
      return {
        ready: false,
        phase: booting.phase,
        etaSeconds: this.eta(booting, now, config),
        retryAfterSeconds: 5,
      };
    }

    // One box at a time: a crowd arriving at an empty fleet must not rent five
    // GPUs. The second player through the door waits for the first one's box.
    const serverDoId = crypto.randomUUID();
    this.sql().exec(
      `INSERT INTO servers (server_do_id, phase, created_at, capacity) VALUES (?, 'SEARCHING', ?, ?)`,
      serverDoId,
      now,
      config.matchesPerBox,
    );
    console.log(JSON.stringify({ event: 'provisioning', server: serverDoId }));
    this.ctx.storage.setAlarm(now + 1000);

    return { ready: false, phase: 'SEARCHING', etaSeconds: 300, retryAfterSeconds: 5 };
  }

  private eta(row: ServerRow, now: number, config: FleetConfig): number {
    if (row.phase === 'SEARCHING') return 300;
    const elapsed = row.boot_started_at ? now - row.boot_started_at : 0;
    return Math.max(20, Math.round((config.bootTimeoutMs - elapsed) / 1000));
  }

  /** One match per box keeps the MVP honest; the id is stable for reconnects. */
  private matchId(serverDoId: string): string {
    return `city-${serverDoId.slice(0, 8)}`;
  }

  async heartbeat(body: HeartbeatBody): Promise<{ drain: boolean }> {
    const row = this.row(body.server_do_id);
    if (!row) {
      // An instance we already gave up on. Nothing sensible to do with its
      // report; the alarm has (or will have) destroyed it.
      console.log(JSON.stringify({ event: 'heartbeat_unknown', server: body.server_do_id }));
      return { drain: false };
    }
    const now = Date.now();

    // Idle is measured on players, not matches: a match loop outlives the last
    // player who was in it, so match count never returns to zero.
    const idleSince = body.players > 0 ? null : (row.idle_since ?? now);

    this.update(row.server_do_id, {
      ip: body.ip,
      udp_port: body.udp_port,
      cert_hash_hex: body.cert_hash,
      active_matches: body.active_matches,
      players: body.players,
      capacity: body.capacity,
      session_json: JSON.stringify(body.session),
      last_heartbeat_at: now,
      idle_since: idleSince,
      // A landed heartbeat supersedes optimistic reservations.
      reserved_count: 0,
      reserved_at: null,
    });

    if (row.phase === 'BOOTING') {
      this.update(row.server_do_id, { phase: 'READY' });
      this.log('ready', row, {
        bootMs: row.boot_started_at ? now - row.boot_started_at : null,
        endpoint: `${body.ip}:${body.udp_port}`,
      });
      this.scheduleNextTick();
    }

    return { drain: row.pending_delete === 1 };
  }

  async fleet(): Promise<FleetRow[]> {
    const now = Date.now();
    return this.rows().map((row) => ({
      serverDoId: row.server_do_id,
      phase: row.phase,
      vastInstanceId: row.vast_instance_id,
      dph: row.offer_dph,
      uptimeSeconds: row.boot_started_at ? Math.round((now - row.boot_started_at) / 1000) : 0,
      spendUsd: Number(this.spend(row, now).toFixed(4)),
      activeMatches: row.active_matches,
      players: row.players,
      capacity: row.capacity,
      heartbeatAgeSeconds: row.last_heartbeat_at
        ? Math.round((now - row.last_heartbeat_at) / 1000)
        : null,
      attempt: row.attempt,
      ip: row.ip,
      udpPort: row.udp_port,
      pendingDelete: row.pending_delete === 1,
      deadReason: row.dead_reason,
    }));
  }

  async kill(serverDoId: string): Promise<{ ok: boolean }> {
    const row = this.row(serverDoId);
    if (!row || row.phase === 'DEAD') return { ok: false };
    this.markForDelete(row, 'admin_kill');
    this.ctx.storage.setAlarm(Date.now() + 1000);
    return { ok: true };
  }

  /**
   * Register a box we did not rent -- the dev machine, or a hand-run server.
   * It follows the same heartbeat and idle rules but is never destroyed
   * through Vast, so the full flow can be exercised with no marketplace.
   */
  async registerStatic(serverDoId: string): Promise<{ serverDoId: string }> {
    const now = Date.now();
    const config = readConfig(this.env);
    if (!this.row(serverDoId)) {
      this.sql().exec(
        `INSERT INTO servers (server_do_id, phase, created_at, boot_started_at, capacity, is_static)
         VALUES (?, 'BOOTING', ?, ?, ?, 1)`,
        serverDoId,
        now,
        now,
        config.matchesPerBox,
      );
      console.log(JSON.stringify({ event: 'static_registered', server: serverDoId }));
    }
    this.ctx.storage.setAlarm(now + 1000);
    return { serverDoId };
  }
}
