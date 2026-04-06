/**
 * SpacetimeDB control-plane module.
 *
 * This intentionally does NOT simulate per-frame FPS physics.
 * It handles:
 * - anonymous player profile bootstrap
 * - live sessions / presence
 * - match metadata and roster
 * - team score and killfeed persistence
 *
 * The authoritative Rust + Rapier gameplay server should call into this module via reducers or
 * server-side integration code for trusted match events.
 */

import { reducer, table, lifecycleReducer, senderOnly, t } from 'spacetimedb/server';

export const session = table(
  {
    name: 'session',
    public: false,
    primaryKey: ['connection_id'],
    indexes: [
      { name: 'byIdentity', columns: ['identity'] },
      { name: 'byMatch', columns: ['current_match_id'] },
    ],
  },
  {
    connection_id: t.connectionId(),
    identity: t.identity(),
    current_match_id: t.option(t.u64()),
    connected_at: t.timestamp(),
    last_seen_at: t.timestamp(),
  },
);

export const player_profile = table(
  {
    name: 'player_profile',
    public: true,
    primaryKey: ['identity'],
  },
  {
    identity: t.identity(),
    display_name: t.string(),
    created_at: t.timestamp(),
    last_seen_at: t.timestamp(),
  },
);

export const match = table(
  {
    name: 'match',
    public: true,
    primaryKey: ['id'],
    indexes: [{ name: 'byState', columns: ['state'] }],
  },
  {
    id: t.u64(),
    state: t.string(),
    map_name: t.string(),
    created_at: t.timestamp(),
  },
);

export const match_roster = table(
  {
    name: 'match_roster',
    public: true,
    primaryKey: ['id'],
    indexes: [
      { name: 'byMatch', columns: ['match_id'] },
      { name: 'byIdentity', columns: ['identity'] },
      { name: 'byMatchIdentity', columns: ['match_id', 'identity'] },
    ],
  },
  {
    id: t.u64(),
    match_id: t.u64(),
    identity: t.identity(),
    team: t.u8(),
    joined_at: t.timestamp(),
  },
);

export const team_score = table(
  {
    name: 'team_score',
    public: true,
    primaryKey: ['id'],
    indexes: [{ name: 'byMatchAndTeam', columns: ['match_id', 'team'] }],
  },
  {
    id: t.u64(),
    match_id: t.u64(),
    team: t.u8(),
    score: t.u32(),
  },
);

export const killfeed = table(
  {
    name: 'killfeed',
    public: true,
    primaryKey: ['id'],
    indexes: [{ name: 'byMatchAndTime', columns: ['match_id', 'at'] }],
  },
  {
    id: t.u64(),
    match_id: t.u64(),
    attacker: t.identity(),
    victim: t.identity(),
    weapon: t.string(),
    at: t.timestamp(),
  },
);

export const on_client_connected = lifecycleReducer.clientConnected((ctx) => {
  const existingProfile = ctx.db.player_profile.identity.find(ctx.sender);
  if (!existingProfile) {
    const short = ctx.sender.toHexString().slice(0, 8);
    ctx.db.player_profile.insert({
      identity: ctx.sender,
      display_name: `Guest-${short}`,
      created_at: ctx.timestamp,
      last_seen_at: ctx.timestamp,
    });
  } else {
    existingProfile.last_seen_at = ctx.timestamp;
    ctx.db.player_profile.identity.update(existingProfile);
  }

  ctx.db.session.insert({
    connection_id: ctx.connectionId!,
    identity: ctx.sender,
    current_match_id: null,
    connected_at: ctx.timestamp,
    last_seen_at: ctx.timestamp,
  });
});

export const on_client_disconnected = lifecycleReducer.clientDisconnected((ctx) => {
  const sessionRow = ctx.db.session.connection_id.find(ctx.connectionId!);
  if (!sessionRow) return;

  const profile = ctx.db.player_profile.identity.find(sessionRow.identity);
  if (profile) {
    profile.last_seen_at = ctx.timestamp;
    ctx.db.player_profile.identity.update(profile);
  }

  ctx.db.session.connection_id.delete(ctx.connectionId!);
});

export const create_match = reducer(
  { map_name: t.string() },
  (ctx, input) => {
    const id = ctx.db.match.id.next();
    ctx.db.match.insert({
      id,
      state: 'lobby',
      map_name: input.map_name,
      created_at: ctx.timestamp,
    });

    ctx.db.team_score.insert({ id: ctx.db.team_score.id.next(), match_id: id, team: 0, score: 0 });
    ctx.db.team_score.insert({ id: ctx.db.team_score.id.next(), match_id: id, team: 1, score: 0 });
    return { match_id: id };
  },
);

export const join_match = reducer(
  { match_id: t.u64(), team: t.u8() },
  (ctx, input) => {
    const matchRow = ctx.db.match.id.find(input.match_id);
    if (!matchRow) throw new Error('match not found');

    for (const existing of ctx.db.match_roster.byIdentity.filter(ctx.sender)) {
      ctx.db.match_roster.id.delete(existing.id);
    }

    ctx.db.match_roster.insert({
      id: ctx.db.match_roster.id.next(),
      match_id: input.match_id,
      identity: ctx.sender,
      team: input.team,
      joined_at: ctx.timestamp,
    });

    const sessionRow = ctx.db.session.connection_id.find(ctx.connectionId!);
    if (sessionRow) {
      sessionRow.current_match_id = input.match_id;
      sessionRow.last_seen_at = ctx.timestamp;
      ctx.db.session.connection_id.update(sessionRow);
    }
  },
);

export const set_display_name = reducer(
  { display_name: t.string() },
  (ctx, input) => {
    const name = input.display_name.trim();
    if (name.length < 3 || name.length > 24) {
      throw new Error('display name must be 3..24 chars');
    }
    const profile = ctx.db.player_profile.identity.find(ctx.sender);
    if (!profile) throw new Error('profile missing');
    profile.display_name = name;
    profile.last_seen_at = ctx.timestamp;
    ctx.db.player_profile.identity.update(profile);
  },
);

// Restrict these reducers to a trusted gameplay bridge identity once you wire in service auth.
export const start_match = reducer(
  { match_id: t.u64() },
  (ctx, input) => {
    const row = ctx.db.match.id.find(input.match_id);
    if (!row) throw new Error('match not found');
    row.state = 'running';
    ctx.db.match.id.update(row);
  },
);

export const record_kill = reducer(
  { match_id: t.u64(), attacker: t.identity(), victim: t.identity(), weapon: t.string(), attacker_team: t.u8() },
  (ctx, input) => {
    ctx.db.killfeed.insert({
      id: ctx.db.killfeed.id.next(),
      match_id: input.match_id,
      attacker: input.attacker,
      victim: input.victim,
      weapon: input.weapon,
      at: ctx.timestamp,
    });

    const scoreRow = Array.from(ctx.db.team_score.byMatchAndTeam.filter([input.match_id, input.attacker_team]))[0];
    if (scoreRow) {
      scoreRow.score += 1;
      ctx.db.team_score.id.update(scoreRow);
    }
  },
);
