import { useEffect, useRef, useCallback, useState } from 'react';
import { NetcodeClient, type RemotePlayer } from '../net/netcodeClient';
import { PlayerInterpolator, ServerClockEstimator } from '../net/interpolation';
import type {
  BlockEditCmd,
  DynamicBodyStateMeters,
  InputCmd,
  NetPlayerState,
  NetVehicleState,
  ServerPacket,
} from '../net/protocol';

export type { RemotePlayer };

export type ConnectionState = {
  socket: unknown;
  playerId: number;
  remoteInterpolator: PlayerInterpolator;
  serverClock: ServerClockEstimator;
  interpolationDelayMs: number;
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
  onWelcome: (id: number) => void,
  onDisconnect: () => void,
  onLocalSnapshot?: (ackInputSeq: number, state: NetPlayerState) => void,
  onServerPacket?: (packet: ServerPacket) => void,
  onLocalVehicleSnapshot?: (vehicleState: NetVehicleState, ackInputSeq: number) => void,
) {
  const clientRef = useRef<NetcodeClient | null>(null);

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
    latestServerTick: 0,
    remotePlayers: new Map(),
    dynamicBodies: new Map(),
    localPosition: [0, 2, 0],
  });

  const [ready, setReady] = useState(false);

  useEffect(() => {
    const client = new NetcodeClient({
      onWelcome: (id) => {
        stateRef.current.playerId = id;
        onWelcomeRef.current(id);
        setReady(true);
      },
      onDisconnect: () => onDisconnectRef.current(),
      onLocalSnapshot: (ackInputSeq, state) => {
        onLocalSnapshotRef.current?.(ackInputSeq, state);
      },
      onLocalVehicleSnapshot: (vehicleState, ackInputSeq) => {
        onLocalVehicleSnapshotRef.current?.(vehicleState, ackInputSeq);
      },
      onWorldPacket: (packet) => {
        onServerPacketRef.current?.(packet);
      },
      onPacket: (packet) => {
        onServerPacketRef.current?.(packet);
        // Sync ConnectionState ref for GameWorld backward compat
        stateRef.current.latestServerTick = client.latestServerTick;
        stateRef.current.interpolationDelayMs = client.interpolationDelayMs;
      },
    });

    // Wire the ConnectionState ref to point at client internals
    stateRef.current.remoteInterpolator = client.interpolator;
    stateRef.current.serverClock = client.serverClock;
    stateRef.current.remotePlayers = client.remotePlayers;
    stateRef.current.dynamicBodies = client.dynamicBodies;

    clientRef.current = client;

    // Periodic ping for RTT measurement
    const pingInterval = setInterval(() => {
      client.ping();
    }, 2000);

    const matchId = 'default';
    const identity = 'player-' + Math.random().toString(36).slice(2, 8);
    const token = 'mvp-token';
    const wsUrl = `ws://${window.location.hostname}:${window.location.port || '5183'}/ws/${matchId}?identity=${identity}&token=${token}`;
    console.log('[game] Connecting to', wsUrl);
    client.connect(wsUrl);

    return () => {
      clearInterval(pingInterval);
      client.disconnect();
      clientRef.current = null;
    };
  }, []);

  const sendInputs = useCallback((cmds: InputCmd[]) => {
    clientRef.current?.sendInputs(cmds);
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

  return { stateRef, ready, sendInputs, sendBlockEdit, sendVehicleEnter, sendVehicleExit, clientRef };
}
