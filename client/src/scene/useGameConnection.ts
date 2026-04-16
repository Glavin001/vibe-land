import { useEffect, useRef, useCallback, useMemo, useState } from 'react';
import type { GameMode } from '../app/gameMode';
import { isPracticeMode } from '../app/gameMode';
import { resolveRequestedMatchId } from '../app/matchId';
import { resolveMultiplayerBackend } from '../app/runtimeConfig';
import { LocalPracticeClient } from '../net/localPracticeClient';
import { NetcodeClient, type RemotePlayer } from '../net/netcodeClient';
import { PlayerInterpolator, ServerClockEstimator } from '../net/interpolation';
import type {
  BlockEditCmd,
  DynamicBodyStateMeters,
  FireCmd,
  InputCmd,
  NetPlayerState,
  NetVehicleState,
  ServerPacket,
} from '../net/protocol';
import { netPlayerStateToMeters } from '../net/protocol';

export type { RemotePlayer };

export type ConnectionState = {
  socket: unknown;
  playerId: number;
  remoteInterpolator: PlayerInterpolator;
  serverClock: ServerClockEstimator;
  interpolationDelayMs: number;
  dynamicBodyInterpolationDelayMs: number;
  latestServerTick: number;
  remotePlayers: Map<number, RemotePlayer>;
  dynamicBodies: Map<number, DynamicBodyStateMeters>;
  localPosition: [number, number, number];
};

/**
 * Thin React wrapper around NetcodeClient.
 * Handles mount/unmount lifecycle only — all netcode logic lives
 * in NetcodeClient which is framework-agnostic and fully testable.
 */
export function useGameConnection(
  mode: GameMode,
  onWelcome: (id: number) => void,
  onDisconnect: (reason?: string) => void,
  practiceWorldJson?: string,
  onLocalSnapshot?: (ackInputSeq: number, state: NetPlayerState) => void,
  onServerPacket?: (packet: ServerPacket) => void,
  onLocalVehicleSnapshot?: (vehicleState: NetVehicleState, ackInputSeq: number) => void,
) {
  const practiceMode = isPracticeMode(mode);
  const multiplayerBackend = useMemo(() => resolveMultiplayerBackend(), []);
  const multiplayerMatchId = useMemo(() => resolveRequestedMatchId(window.location.search), []);
  const clientRef = useRef<NetcodeClient | LocalPracticeClient | null>(null);

  // Keep callbacks in refs so the NetcodeClient doesn't need to be recreated
  const onWelcomeRef = useRef(onWelcome);
  onWelcomeRef.current = onWelcome;
  const onDisconnectRef = useRef(onDisconnect);
  onDisconnectRef.current = onDisconnect;
  const onLocalSnapshotRef = useRef(onLocalSnapshot);
  onLocalSnapshotRef.current = onLocalSnapshot;
  const onServerPacketRef = useRef(onServerPacket);
  onServerPacketRef.current = onServerPacket;
  const onLocalVehicleSnapshotRef = useRef(onLocalVehicleSnapshot);
  onLocalVehicleSnapshotRef.current = onLocalVehicleSnapshot;


  // Expose ConnectionState-shaped ref for backward compat with GameWorld
  const stateRef = useRef<ConnectionState>({
    socket: null,
    playerId: 0,
    remoteInterpolator: new PlayerInterpolator(),
    serverClock: new ServerClockEstimator(),
    interpolationDelayMs: 100,
    dynamicBodyInterpolationDelayMs: 16,
    latestServerTick: 0,
    remotePlayers: new Map(),
    dynamicBodies: new Map(),
    localPosition: [0, 2, 0],
  });

  const [ready, setReady] = useState(false);

  useEffect(() => {
    let disposed = false;
    setReady(false);
    let pingInterval: ReturnType<typeof setInterval> | null = null;

    const handleWelcome = (id: number) => {
      stateRef.current.playerId = id;
      onWelcomeRef.current(id);
      setReady(true);
    };

    const handleLocalSnapshot = (
      client: NetcodeClient | LocalPracticeClient,
      ackInputSeq: number,
      state: NetPlayerState,
    ) => {
      stateRef.current.localPosition = netPlayerStateToMeters(state).position;
      stateRef.current.latestServerTick = client.latestServerTick;
      stateRef.current.interpolationDelayMs = client.interpolationDelayMs;
      stateRef.current.dynamicBodyInterpolationDelayMs = client.dynamicBodyInterpolationDelayMs;
      onLocalSnapshotRef.current?.(ackInputSeq, state);
      if (practiceMode) {
        onServerPacketRef.current?.({
          type: 'snapshot',
          serverTimeUs: Math.round(client.serverClock.serverNowUs()),
          serverTick: client.latestServerTick,
          ackInputSeq,
          playerStates: [state],
          projectileStates: [],
          dynamicBodyStates: [],
          vehicleStates: [],
        });
      }
    };

    if (practiceMode) {
      void LocalPracticeClient.connect({
        worldJson: practiceWorldJson,
        onDisconnect: (reason) => {
          if (disposed) return;
          onDisconnectRef.current(reason);
        },
        onLocalSnapshot: (ackInputSeq, state) => {
          const client = clientRef.current;
          if (!client || disposed) return;
          handleLocalSnapshot(client, ackInputSeq, state);
        },
        onLocalVehicleSnapshot: (vehicleState, ackInputSeq) => {
          if (disposed) return;
          onLocalVehicleSnapshotRef.current?.(vehicleState, ackInputSeq);
        },
      }).then((client) => {
        if (disposed) {
          client.disconnect();
          return;
        }
        stateRef.current.remoteInterpolator = client.interpolator;
        stateRef.current.serverClock = client.serverClock;
        stateRef.current.interpolationDelayMs = client.interpolationDelayMs;
        stateRef.current.dynamicBodyInterpolationDelayMs = client.dynamicBodyInterpolationDelayMs;
        stateRef.current.remotePlayers = client.remotePlayers;
        stateRef.current.dynamicBodies = client.dynamicBodies;
        clientRef.current = client;
        handleWelcome(client.playerId);
        client.emitCurrentState();
      }).catch((error) => {
        if (disposed) return;
        onDisconnectRef.current(error instanceof Error ? error.message : String(error));
      });
    } else {
      const client = new NetcodeClient({
        onWelcome: (id) => {
          if (disposed) return;
          handleWelcome(id);
        },
        onDisconnect: (reason) => {
          if (disposed) return;
          onDisconnectRef.current(reason);
        },
        onLocalSnapshot: (ackInputSeq, state) => {
          handleLocalSnapshot(client, ackInputSeq, state);
        },
        onLocalVehicleSnapshot: (vehicleState, ackInputSeq) => {
          onLocalVehicleSnapshotRef.current?.(vehicleState, ackInputSeq);
        },
        onWorldPacket: (packet) => {
          onServerPacketRef.current?.(packet);
        },
        onPacket: (packet) => {
          if (packet.type !== 'chunkFull' && packet.type !== 'chunkDiff') {
            onServerPacketRef.current?.(packet);
          }
          stateRef.current.latestServerTick = client.latestServerTick;
          stateRef.current.interpolationDelayMs = client.interpolationDelayMs;
          stateRef.current.dynamicBodyInterpolationDelayMs = client.dynamicBodyInterpolationDelayMs;
        },
      });

      stateRef.current.remoteInterpolator = client.interpolator;
      stateRef.current.serverClock = client.serverClock;
      stateRef.current.dynamicBodyInterpolationDelayMs = client.dynamicBodyInterpolationDelayMs;
      stateRef.current.remotePlayers = client.remotePlayers;
      stateRef.current.dynamicBodies = client.dynamicBodies;
      clientRef.current = client;
      pingInterval = setInterval(() => {
        client.ping();
      }, 2000);

      const identity = 'player-' + Math.random().toString(36).slice(2, 8);
      const token = 'mvp-token';
      const wsUrl = multiplayerBackend.createMatchWebSocketUrl(multiplayerMatchId, identity, token);
      void client.connectWithFallback(multiplayerMatchId, wsUrl, multiplayerBackend.sessionConfigEndpoint);
    }

    return () => {
      disposed = true;
      if (pingInterval) {
        clearInterval(pingInterval);
      }
      clientRef.current?.disconnect();
      clientRef.current = null;
      setReady(false);
    };
  }, [multiplayerBackend, multiplayerMatchId, practiceMode, practiceWorldJson]);

  const sendInputs = useCallback((cmds: InputCmd[]) => {
    clientRef.current?.sendInputs(cmds);
  }, []);

  const sendFire = useCallback((cmd: FireCmd) => {
    clientRef.current?.sendFire(cmd);
  }, []);

  const sendBlockEdit = useCallback((cmd: BlockEditCmd) => {
    clientRef.current?.sendBlockEdit(cmd);
  }, []);

  const sendVehicleEnter = useCallback((vehicleId: number, seat = 0) => {
    clientRef.current?.sendVehicleEnter(vehicleId, seat);
  }, []);

  const sendVehicleExit = useCallback((vehicleId: number) => {
    clientRef.current?.sendVehicleExit(vehicleId);
  }, []);

  return { stateRef, ready, sendInputs, sendFire, sendBlockEdit, sendVehicleEnter, sendVehicleExit, clientRef };
}
