import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { PracticeBotHost } from '../../net/localPracticeClient';
import type { RemotePlayer } from '../../net/netcodeClient';
import {
  type InputCmd,
  type VehicleStateMeters,
} from '../../net/protocol';
import {
  getSharedPlayerNavigationProfile,
  hydrateSharedPlayerNavigationProfileFromLoadedWasm,
} from '../../wasm/sharedPhysics';
import { DEFAULT_PRACTICE_BOT_SPACING_TUNING, PracticeBotRuntime } from './PracticeBotRuntime';
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
  readonly lastInputs = new Map<number, InputCmd[]>();
  readonly maxSpeedOverrides = new Map<number, number | null>();
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

    let localPosition: [number, number, number] = [
      (initialInfo?.position[0] ?? 0) + 1.25,
      playerCenterY(initialInfo?.position[1] ?? 0),
      (initialInfo?.position[2] ?? 0) + 0.75,
    ];
    const getSelf = () => ({
      id: host.playerId,
      position: [localPosition[0], localPosition[1], localPosition[2]] as [number, number, number],
      dead: false,
    });

    runtime.attach(host, getSelf);
    vi.advanceTimersByTime(100);

    let info = runtime.getBotDebugInfos()[0];
    expect(info?.mode).toBe('follow_target');
    expect(info?.targetPlayerId).toBe(host.playerId);
    expect(info?.lastMoveAccepted).toBe(true);
    // rawTarget is the chase-offset movement target, which may be up to
    // chaseOffsetRadiusM away from the real player position.
    const offsetRadius = DEFAULT_PRACTICE_BOT_SPACING_TUNING.chaseOffsetRadiusM + 0.01;
    expect(Math.hypot(
      (info?.rawTarget?.[0] ?? Infinity) - localPosition[0],
      (info?.rawTarget?.[2] ?? Infinity) - localPosition[2],
    )).toBeLessThanOrEqual(offsetRadius);
    expect(info?.targetSnapDistanceM ?? Number.POSITIVE_INFINITY).toBeLessThan(2 + offsetRadius);
    expect(host.sentInputCounts.get(botId) ?? 0).toBeGreaterThan(0);

    localPosition = [
      (initialInfo?.position[0] ?? 0) - 1.5,
      playerCenterY(initialInfo?.position[1] ?? 0),
      (initialInfo?.position[2] ?? 0) - 1.25,
    ];
    vi.advanceTimersByTime(100);

    info = runtime.getBotDebugInfos()[0];
    expect(info?.mode).toBe('follow_target');
    expect(Math.hypot(
      (info?.rawTarget?.[0] ?? Infinity) - localPosition[0],
      (info?.rawTarget?.[2] ?? Infinity) - localPosition[2],
    )).toBeLessThanOrEqual(offsetRadius);

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

    let localPosition: [number, number, number] = [
      (initialInfo?.position[0] ?? 0) + 1,
      playerCenterY(initialInfo?.position[1] ?? 0),
      (initialInfo?.position[2] ?? 0) + 1,
    ];
    const getSelf = () => ({
      id: host.playerId,
      position: [localPosition[0], localPosition[1], localPosition[2]] as [number, number, number],
      dead: false,
    });

    runtime.attach(host, getSelf);
    vi.advanceTimersByTime(100);

    let info = runtime.getBotDebugInfos()[0];
    expect(info?.mode).toBe('follow_target');
    expect(info?.lastMoveAccepted).toBe(true);
    expect(info?.target).not.toBeNull();

    localPosition = [50, 10, 50];
    vi.advanceTimersByTime(100);

    info = runtime.getBotDebugInfos()[0];
    expect(info?.mode).toBe('follow_target');
    expect(info?.rawTarget).toEqual([50, 10, 50]);
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

  describe('setSpacingTuning', () => {
    it('two bots chasing the same player report distinct rawTargets after a tick', () => {
      vi.useFakeTimers();

      const runtime = PracticeBotRuntime.createSync(makeFlatPlatformWorld(), {
        navigationProfile: getSharedPlayerNavigationProfile(),
        maxAgentRadius: 0.6,
      });

      const bot1Id = runtime.spawnBot();
      const bot2Id = runtime.spawnBot();

      const host = new FakePracticeBotHost();
      const centerY = playerCenterY(0);
      host.spawnPositions.set(bot1Id, [0, centerY, 0]);
      host.spawnPositions.set(bot2Id, [0.5, centerY, 0.5]);

      const getSelf = () => ({
        id: host.playerId,
        position: [1, centerY, 1] as [number, number, number],
        dead: false,
      });

      runtime.setSpacingTuning({
        separationWeight: 2.5,
        collisionQueryRange: 4,
        chaseOffsetRadiusM: 1.25,
      });

      runtime.attach(host, getSelf);
      vi.advanceTimersByTime(200);

      const infos = runtime.getBotDebugInfos();
      const info1 = infos.find((i) => i.id === bot1Id);
      const info2 = infos.find((i) => i.id === bot2Id);

      expect(info1?.mode).toBe('follow_target');
      expect(info2?.mode).toBe('follow_target');
      // Different bots should have different movement targets
      expect(info1?.rawTarget).not.toEqual(info2?.rawTarget);

      runtime.clear();
      runtime.detach();
    });

    it('applying setSpacingTuning with zero chaseOffset makes bots target the exact player center', () => {
      vi.useFakeTimers();

      const runtime = PracticeBotRuntime.createSync(makeFlatPlatformWorld(), {
        navigationProfile: getSharedPlayerNavigationProfile(),
        maxAgentRadius: 0.6,
      });

      const botId = runtime.spawnBot();
      const initialInfo = runtime.getBotDebugInfos()[0];

      const host = new FakePracticeBotHost();
      const centerY = playerCenterY(initialInfo?.position[1] ?? 0);
      host.spawnPositions.set(botId, [
        initialInfo?.position[0] ?? 0,
        centerY,
        initialInfo?.position[2] ?? 0,
      ]);

      const playerPos: [number, number, number] = [
        (initialInfo?.position[0] ?? 0) + 1,
        centerY,
        (initialInfo?.position[2] ?? 0) + 1,
      ];
      const getSelf = () => ({ id: host.playerId, position: playerPos, dead: false });

      // Disable chase offset so rawTarget must match the exact player position
      runtime.setSpacingTuning({ ...DEFAULT_PRACTICE_BOT_SPACING_TUNING, chaseOffsetRadiusM: 0 });
      runtime.attach(host, getSelf);
      vi.advanceTimersByTime(100);

      const info = runtime.getBotDebugInfos()[0];
      expect(info?.mode).toBe('follow_target');
      expect(info?.rawTarget?.[0]).toBeCloseTo(playerPos[0], 5);
      expect(info?.rawTarget?.[2]).toBeCloseTo(playerPos[2], 5);

      runtime.clear();
      runtime.detach();
    });
  });
});
