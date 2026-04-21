import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { PracticeBotHost } from '../../net/localPracticeClient';
import type { RemotePlayer } from '../../net/netcodeClient';
import type { FireCmd, InputCmd, VehicleStateMeters } from '../../net/protocol';
import {
  getSharedPlayerNavigationProfile,
  hydrateSharedPlayerNavigationProfileFromLoadedWasm,
} from '../../wasm/sharedPhysics';
import { PracticeBotRuntime } from './PracticeBotRuntime';
import { initWasmForTests } from '../../wasm/testInit';
import { identityQuaternion, type WorldDocument } from '../../world/worldDocument';

beforeAll(() => {
  initWasmForTests();
  hydrateSharedPlayerNavigationProfileFromLoadedWasm();
});

function makeFlatPlatformWorld(): WorldDocument {
  return {
    version: 2,
    meta: {
      name: 'Flat Platform',
      description: 'Minimal walkable world for async practice bot runtime tests.',
    },
    terrain: {
      tileGridSize: 2,
      tileHalfExtentM: 1,
      tiles: [],
    },
    staticProps: [{
      id: 1,
      kind: 'cuboid',
      position: [0, -0.25, 0],
      rotation: identityQuaternion(),
      halfExtents: [3, 0.25, 3],
    }],
    dynamicEntities: [],
  };
}

class FakePracticeBotHost implements PracticeBotHost {
  readonly remotePlayers = new Map<number, RemotePlayer>();
  readonly vehicles = new Map<number, VehicleStateMeters>();
  readonly spawnPositions = new Map<number, [number, number, number]>();
  readonly sentInputCounts = new Map<number, number>();
  readonly sentFires = new Map<number, FireCmd[]>();
  readonly lastInputs = new Map<number, InputCmd[]>();
  readonly maxSpeedOverrides = new Map<number, number | null>();
  /** Optional stubbed ray hit (toi in meters). Null means "no hit". */
  castSceneRayResult: { toi: number } | null = null;
  castSceneRayCalls = 0;
  connectCalls = 0;
  disconnectCalls = 0;
  playerId = 1;
  localPlayerHp = 100;
  localPlayerFlags = 0;

  connectBot(botId: number): boolean {
    this.connectCalls += 1;
    const spawn = this.spawnPositions.get(botId) ?? [0, 0, 0];
    this.remotePlayers.set(botId, {
      id: botId,
      position: [spawn[0], spawn[1], spawn[2]],
      yaw: 0,
      pitch: 0,
      hp: 100,
      flags: 0,
    });
    return true;
  }

  disconnectBot(botId: number): boolean {
    this.disconnectCalls += 1;
    return this.remotePlayers.delete(botId);
  }

  setBotMaxSpeed(_botId: number, _maxSpeedMps: number | null): boolean {
    this.maxSpeedOverrides.set(_botId, _maxSpeedMps);
    return true;
  }

  sendBotInputs(botId: number, cmds: InputCmd[]): void {
    this.sentInputCounts.set(botId, (this.sentInputCounts.get(botId) ?? 0) + cmds.length);
    this.lastInputs.set(botId, cmds);
  }

  sendBotMelee(): void {
    /* noop */
  }

  sendBotVehicleEnter(): void {
    /* noop */
  }

  sendBotVehicleExit(): void {
    /* noop */
  }

  sendBotFire(botId: number, cmd: FireCmd): void {
    const list = this.sentFires.get(botId) ?? [];
    list.push({ ...cmd, dir: [cmd.dir[0], cmd.dir[1], cmd.dir[2]] });
    this.sentFires.set(botId, list);
  }

  castSceneRay(): { toi: number } | null {
    this.castSceneRayCalls += 1;
    return this.castSceneRayResult;
  }
}

function playerCenterY(groundY: number): number {
  return groundY + getSharedPlayerNavigationProfile().walkableHeight * 0.5;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('PracticeBotRuntime.create', () => {
  it('builds a crowd from the shared navigation profile', async () => {
    const runtime = await PracticeBotRuntime.create(makeFlatPlatformWorld(), {
      maxAgentRadius: 0.6,
    });
    expect(runtime.stats().navTriangles).toBeGreaterThan(0);
    expect(runtime.crowd.nav.navigationProfile.walkableClimb).toBeCloseTo(0.55, 5);

    runtime.spawnBot();
    expect(runtime.count).toBe(1);

    runtime.clear();
    runtime.detach();
  });

  it('tracks the local player on flat ground and updates the chase target when the player moves', () => {
    vi.useFakeTimers();

    const runtime = PracticeBotRuntime.createSync(makeFlatPlatformWorld(), {
      navigationProfile: getSharedPlayerNavigationProfile(),
      maxAgentRadius: 0.6,
    });

    const botId = runtime.spawnBot();
    const initialInfo = runtime.getBotDebugInfos()[0];
    expect(initialInfo?.id).toBe(botId);

    const host = new FakePracticeBotHost();
    host.spawnPositions.set(botId, [
      initialInfo?.position[0] ?? 0,
      playerCenterY(initialInfo?.position[1] ?? 0),
      initialInfo?.position[2] ?? 0,
    ]);

    // Place the player 5 m in +Z from the bot — outside the default melee
    // range (2 m) so the behavior issues a real move target rather than
    // entering the melee-only branch (target = null).
    let localPosition: [number, number, number] = [
      (initialInfo?.position[0] ?? 0),
      playerCenterY(initialInfo?.position[1] ?? 0),
      (initialInfo?.position[2] ?? 0) + 5,
    ];
    const getSelf = () => ({
      id: host.playerId,
      position: [localPosition[0], localPosition[1], localPosition[2]] as [number, number, number],
      dead: false,
    });

    runtime.attach(host, getSelf);
    // Advance past the default standAndShootTicks (18 ticks ≈ 300 ms at 60 Hz)
    // so the bot exits the "stand and shoot" acquisition phase and enters the
    // normal follow_target movement loop before we sample the debug state.
    vi.advanceTimersByTime(500);

    let info = runtime.getBotDebugInfos()[0];
    expect(info?.mode).toBe('follow_target');
    expect(info?.targetPlayerId).toBe(host.playerId);
    expect(info?.lastMoveAccepted).toBe(true);
    // rawTarget is the orbit/approach point computed by harassNearest, not the
    // raw player position — just verify it is non-null.
    expect(info?.rawTarget).not.toBeNull();
    expect(info?.targetSnapDistanceM ?? Number.POSITIVE_INFINITY).toBeLessThan(2);
    expect(host.sentInputCounts.get(botId) ?? 0).toBeGreaterThan(0);

    localPosition = [
      (initialInfo?.position[0] ?? 0),
      playerCenterY(initialInfo?.position[1] ?? 0),
      (initialInfo?.position[2] ?? 0) - 5,
    ];
    vi.advanceTimersByTime(100);

    info = runtime.getBotDebugInfos()[0];
    expect(info?.mode).toBe('follow_target');
    expect(info?.rawTarget).not.toBeNull();

    runtime.clear();
    runtime.detach();
  });

  it('clears practice max-speed overrides so bots use shared human movement tuning', () => {
    vi.useFakeTimers();

    const runtime = PracticeBotRuntime.createSync(makeFlatPlatformWorld(), {
      navigationProfile: getSharedPlayerNavigationProfile(),
      maxAgentRadius: 0.6,
    });

    const botId = runtime.spawnBot();
    const initialInfo = runtime.getBotDebugInfos()[0];
    expect(initialInfo?.id).toBe(botId);

    const host = new FakePracticeBotHost();
    host.spawnPositions.set(botId, [
      initialInfo?.position[0] ?? 0,
      playerCenterY(initialInfo?.position[1] ?? 0),
      initialInfo?.position[2] ?? 0,
    ]);
    const getSelf = () => ({
      id: host.playerId,
      position: [0, playerCenterY(initialInfo?.position[1] ?? 0), 0] as [number, number, number],
      dead: false,
    });

    runtime.attach(host, getSelf);

    expect(host.maxSpeedOverrides.get(botId)).toBeNull();

    runtime.clear();
    runtime.detach();
  });

  it('clears stale snapped targets when the player moves somewhere unsnappable', () => {
    vi.useFakeTimers();

    const runtime = PracticeBotRuntime.createSync(makeFlatPlatformWorld(), {
      navigationProfile: getSharedPlayerNavigationProfile(),
      maxAgentRadius: 0.6,
    });

    const botId = runtime.spawnBot();
    const initialInfo = runtime.getBotDebugInfos()[0];
    expect(initialInfo?.id).toBe(botId);

    const host = new FakePracticeBotHost();
    host.spawnPositions.set(botId, [
      initialInfo?.position[0] ?? 0,
      playerCenterY(initialInfo?.position[1] ?? 0),
      initialInfo?.position[2] ?? 0,
    ]);

    // Place the player 5 m in +X from the bot — outside the default melee
    // range (2 m) and within the acquire range (40 m).
    let localPosition: [number, number, number] = [
      (initialInfo?.position[0] ?? 0) + 5,
      playerCenterY(initialInfo?.position[1] ?? 0),
      (initialInfo?.position[2] ?? 0),
    ];
    const getSelf = () => ({
      id: host.playerId,
      position: [localPosition[0], localPosition[1], localPosition[2]] as [number, number, number],
      dead: false,
    });

    runtime.attach(host, getSelf);
    // Advance past the default standAndShootTicks (18 ticks ≈ 300 ms at 60 Hz)
    // so the bot exits "stand and shoot" mode before we sample the debug state.
    vi.advanceTimersByTime(500);

    let info = runtime.getBotDebugInfos()[0];
    expect(info?.mode).toBe('follow_target');
    expect(info?.lastMoveAccepted).toBe(true);
    expect(info?.target).not.toBeNull();

    // Move the player far outside the nav mesh (still within acquire range at
    // 30 m < 40 m) so the orbit-point target the bot computes falls well
    // outside the nav-mesh snap radius and is therefore rejected.
    localPosition = [
      (initialInfo?.position[0] ?? 0) + 30,
      playerCenterY(initialInfo?.position[1] ?? 0),
      (initialInfo?.position[2] ?? 0),
    ];
    vi.advanceTimersByTime(100);

    info = runtime.getBotDebugInfos()[0];
    expect(info?.mode).toBe('follow_target');
    // rawTarget is the orbit approach point (not the raw player position) —
    // it is non-null even though the nav-mesh snap failed.
    expect(info?.rawTarget).not.toBeNull();
    expect(info?.lastMoveAccepted).toBe(false);
    expect(info?.target).toBeNull();

    runtime.clear();
    runtime.detach();
  });

  it('reanchors hold behavior to the authoritative bot spawn reported by the host', () => {
    vi.useFakeTimers();

    const runtime = PracticeBotRuntime.createSync(makeFlatPlatformWorld(), {
      navigationProfile: getSharedPlayerNavigationProfile(),
      initialBehavior: 'hold',
      maxAgentRadius: 0.6,
    });

    const botId = runtime.spawnBot();
    const initialInfo = runtime.getBotDebugInfos()[0];
    expect(initialInfo?.id).toBe(botId);

    const host = new FakePracticeBotHost();
    const authoritativeGroundX = (initialInfo?.position[0] ?? 0) + 2.5;
    const authoritativeGroundZ = (initialInfo?.position[2] ?? 0) - 1.75;
    host.spawnPositions.set(botId, [
      authoritativeGroundX,
      playerCenterY(initialInfo?.position[1] ?? 0),
      authoritativeGroundZ,
    ]);

    const getSelf = () => ({
      id: host.playerId,
      position: [0, playerCenterY(initialInfo?.position[1] ?? 0), 0] as [number, number, number],
      dead: false,
    });

    runtime.attach(host, getSelf);
    vi.advanceTimersByTime(100);

    const info = runtime.getBotDebugInfos()[0];
    expect(info?.mode).toBe('hold_anchor');
    expect(info?.rawTarget?.[0]).toBeCloseTo(authoritativeGroundX, 5);
    expect(info?.rawTarget?.[2]).toBeCloseTo(authoritativeGroundZ, 5);

    runtime.clear();
    runtime.detach();
  });

  it('preserves host bots across same-world runtime rebuilds', () => {
    vi.useFakeTimers();

    const world = makeFlatPlatformWorld();
    const runtime = PracticeBotRuntime.createSync(world, {
      navigationProfile: getSharedPlayerNavigationProfile(),
      maxAgentRadius: 0.6,
    });

    const botId = runtime.spawnBot();
    const initialInfo = runtime.getBotDebugInfos()[0];
    expect(initialInfo?.id).toBe(botId);

    const host = new FakePracticeBotHost();
    host.spawnPositions.set(botId, [
      initialInfo?.position[0] ?? 0,
      playerCenterY(initialInfo?.position[1] ?? 0),
      initialInfo?.position[2] ?? 0,
    ]);

    const getSelf = () => ({
      id: host.playerId,
      position: [2, playerCenterY(initialInfo?.position[1] ?? 0), 2] as [number, number, number],
      dead: false,
    });

    runtime.attach(host, getSelf);
    vi.advanceTimersByTime(100);

    expect(host.connectCalls).toBe(1);
    expect(host.disconnectCalls).toBe(0);
    expect(host.remotePlayers.has(botId)).toBe(true);

    const snapshots = runtime.captureBotSnapshots();
    runtime.detach({ preserveHostBots: true });

    expect(host.connectCalls).toBe(1);
    expect(host.disconnectCalls).toBe(0);
    expect(host.remotePlayers.has(botId)).toBe(true);

    const rebuilt = PracticeBotRuntime.createSync(world, {
      navigationProfile: getSharedPlayerNavigationProfile(),
      maxAgentRadius: 0.6,
      cellHeight: 0.02,
    });
    rebuilt.restoreBotSnapshots(snapshots);
    rebuilt.attach(host, getSelf);
    vi.advanceTimersByTime(100);

    const rebuiltInfo = rebuilt.getBotDebugInfos()[0];
    expect(rebuiltInfo?.id).toBe(botId);
    expect(host.connectCalls).toBe(1);
    expect(host.disconnectCalls).toBe(0);
    expect(host.remotePlayers.has(botId)).toBe(true);

    rebuilt.clear();
    rebuilt.detach();
    expect(host.disconnectCalls).toBe(1);
  });

  it('emits FireCmd packets through the host while the local player is in range and not occluded', () => {
    vi.useFakeTimers();

    const runtime = PracticeBotRuntime.createSync(makeFlatPlatformWorld(), {
      navigationProfile: getSharedPlayerNavigationProfile(),
      maxAgentRadius: 0.6,
    });

    const botId = runtime.spawnBot();
    const initialInfo = runtime.getBotDebugInfos()[0];
    expect(initialInfo?.id).toBe(botId);

    const host = new FakePracticeBotHost();
    host.spawnPositions.set(botId, [
      initialInfo?.position[0] ?? 0,
      playerCenterY(initialInfo?.position[1] ?? 0),
      initialInfo?.position[2] ?? 0,
    ]);
    // Clear line of sight (no wall between bot and player).
    host.castSceneRayResult = null;

    // Place the local player ~8 m away so we're outside the min-range
    // guard but well inside the harass fire window.
    const localPosition: [number, number, number] = [
      (initialInfo?.position[0] ?? 0) + 8,
      playerCenterY(initialInfo?.position[1] ?? 0),
      initialInfo?.position[2] ?? 0,
    ];
    const getSelf = () => ({
      id: host.playerId,
      position: [localPosition[0], localPosition[1], localPosition[2]] as [number, number, number],
      dead: false,
    });

    runtime.attach(host, getSelf);

    // Run ~1 second of simulated ticks. At 60 Hz the brain needs ~12
    // ticks to finish its aim prep, then fires are rate-limited to
    // roughly every 108 ms (server cooldown + local slack).
    vi.advanceTimersByTime(1000);

    const fires = host.sentFires.get(botId) ?? [];
    expect(fires.length).toBeGreaterThan(0);
    expect(fires.length).toBeLessThanOrEqual(10);
    for (const fire of fires) {
      expect(fire.weapon).toBe(1);
      const magnitude = Math.hypot(fire.dir[0], fire.dir[1], fire.dir[2]);
      expect(magnitude).toBeCloseTo(1, 1);
    }

    const debugInfo = runtime.getBotDebugInfos()[0];
    expect(debugInfo?.shotsFired).toBe(fires.length);

    runtime.clear();
    runtime.detach();
  });

  it('publishes a visible shot event when a bot fires', () => {
    vi.useFakeTimers();

    const runtime = PracticeBotRuntime.createSync(makeFlatPlatformWorld(), {
      navigationProfile: getSharedPlayerNavigationProfile(),
      maxAgentRadius: 0.6,
    });

    const botId = runtime.spawnBot();
    const initialInfo = runtime.getBotDebugInfos()[0];
    expect(initialInfo?.id).toBe(botId);

    const host = new FakePracticeBotHost();
    host.spawnPositions.set(botId, [
      initialInfo?.position[0] ?? 0,
      playerCenterY(initialInfo?.position[1] ?? 0),
      initialInfo?.position[2] ?? 0,
    ]);
    host.castSceneRayResult = null;

    const localPosition: [number, number, number] = [
      (initialInfo?.position[0] ?? 0) + 8,
      playerCenterY(initialInfo?.position[1] ?? 0),
      initialInfo?.position[2] ?? 0,
    ];
    const getSelf = () => ({
      id: host.playerId,
      position: [localPosition[0], localPosition[1], localPosition[2]] as [number, number, number],
      dead: false,
    });

    const shots: Array<{ shooterId: number; origin: [number, number, number]; end: [number, number, number]; kind: string }> = [];
    const unsubscribe = runtime.onShotVisual((shot) => {
      shots.push(shot);
    });

    runtime.attach(host, getSelf);
    vi.advanceTimersByTime(1000);

    expect(shots.length).toBeGreaterThan(0);
    expect(shots[0]?.shooterId).toBe(botId);
    expect(shots[0]?.kind).toBe('body');
    expect(shots[0]?.origin[0]).toBeCloseTo(initialInfo?.position[0] ?? 0, 1);
    expect(shots[0]?.origin[2]).toBeCloseTo(initialInfo?.position[2] ?? 0, 1);
    expect(shots[0]?.end[0]).toBeGreaterThan(shots[0]?.origin[0] ?? 0);

    unsubscribe();
    runtime.clear();
    runtime.detach();
  });

  it('suppresses FireCmd packets when castSceneRay reports a blocking wall in front of the bot', () => {
    vi.useFakeTimers();

    const runtime = PracticeBotRuntime.createSync(makeFlatPlatformWorld(), {
      navigationProfile: getSharedPlayerNavigationProfile(),
      maxAgentRadius: 0.6,
    });

    const botId = runtime.spawnBot();
    const initialInfo = runtime.getBotDebugInfos()[0];

    const host = new FakePracticeBotHost();
    host.spawnPositions.set(botId, [
      initialInfo?.position[0] ?? 0,
      playerCenterY(initialInfo?.position[1] ?? 0),
      initialInfo?.position[2] ?? 0,
    ]);
    // Fake wall at 2 m in front of the bot.
    host.castSceneRayResult = { toi: 2 };

    const localPosition: [number, number, number] = [
      (initialInfo?.position[0] ?? 0) + 12,
      playerCenterY(initialInfo?.position[1] ?? 0),
      initialInfo?.position[2] ?? 0,
    ];
    const getSelf = () => ({
      id: host.playerId,
      position: [localPosition[0], localPosition[1], localPosition[2]] as [number, number, number],
      dead: false,
    });

    runtime.attach(host, getSelf);
    vi.advanceTimersByTime(1000);

    const fires = host.sentFires.get(botId) ?? [];
    expect(fires.length).toBe(0);
    expect(host.castSceneRayCalls).toBeGreaterThan(0);

    runtime.clear();
    runtime.detach();
  });

  it('suppresses FireCmd packets when shooting is disabled', () => {
    vi.useFakeTimers();

    const runtime = PracticeBotRuntime.createSync(makeFlatPlatformWorld(), {
      navigationProfile: getSharedPlayerNavigationProfile(),
      maxAgentRadius: 0.6,
      enableShooting: false,
    });

    const botId = runtime.spawnBot();
    const initialInfo = runtime.getBotDebugInfos()[0];

    const host = new FakePracticeBotHost();
    host.spawnPositions.set(botId, [
      initialInfo?.position[0] ?? 0,
      playerCenterY(initialInfo?.position[1] ?? 0),
      initialInfo?.position[2] ?? 0,
    ]);
    host.castSceneRayResult = null;

    const localPosition: [number, number, number] = [
      (initialInfo?.position[0] ?? 0) + 8,
      playerCenterY(initialInfo?.position[1] ?? 0),
      initialInfo?.position[2] ?? 0,
    ];
    const getSelf = () => ({
      id: host.playerId,
      position: [localPosition[0], localPosition[1], localPosition[2]] as [number, number, number],
      dead: false,
    });

    runtime.attach(host, getSelf);
    vi.advanceTimersByTime(1000);

    expect(runtime.stats().enableShooting).toBe(false);
    expect(host.sentFires.get(botId) ?? []).toHaveLength(0);

    runtime.clear();
    runtime.detach();
  });
});
