import { useEffect, useRef, useCallback, useState } from 'react';
import { GameSocket } from '../net/gameSocket';
import { SnapshotInterpolator } from '../net/interpolation';
import {
  encodeInputPacket,
  netStateToMeters,
  type InputCmd,
  type NetPlayerState,
  type ServerPacket,
} from '../net/protocol';

export type RemotePlayer = {
  id: number;
  position: [number, number, number];
  yaw: number;
  pitch: number;
  hp: number;
};

export type ConnectionState = {
  socket: GameSocket;
  playerId: number;
  interpolator: SnapshotInterpolator;
  latestServerTick: number;
  remotePlayers: Map<number, RemotePlayer>;
  localPosition: [number, number, number];
  localYaw: number;
  localPitch: number;
};

export function useGameConnection(
  onWelcome: (id: number) => void,
  onDisconnect: () => void,
) {
  const stateRef = useRef<ConnectionState>({
    socket: null!,
    playerId: 0,
    interpolator: new SnapshotInterpolator(),
    latestServerTick: 0,
    remotePlayers: new Map(),
    localPosition: [0, 2, 0],
    localYaw: 0,
    localPitch: 0,
  });

  const [ready, setReady] = useState(false);

  useEffect(() => {
    const state = stateRef.current;
    state.interpolator = new SnapshotInterpolator();
    state.remotePlayers = new Map();

    const socket = new GameSocket({
      onPacket: (packet: ServerPacket) => {
        switch (packet.type) {
          case 'welcome':
            state.playerId = packet.playerId;
            onWelcome(packet.playerId);
            setReady(true);
            break;
          case 'snapshot': {
            state.latestServerTick = packet.serverTick;
            const knownIds = new Set<number>();
            for (const ps of packet.playerStates) {
              knownIds.add(ps.id);
              if (ps.id === state.playerId) {
                const m = netStateToMeters(ps);
                state.localPosition = m.position;
              } else {
                state.interpolator.push(ps.id, {
                  serverTick: packet.serverTick,
                  receivedAtMs: performance.now(),
                  position: netStateToMeters(ps).position,
                  velocity: netStateToMeters(ps).velocity,
                  yaw: netStateToMeters(ps).yaw,
                  pitch: netStateToMeters(ps).pitch,
                  hp: ps.hp,
                  flags: ps.flags,
                });
              }
            }
            // Update remote players from interpolator
            for (const id of knownIds) {
              if (id === state.playerId) continue;
              const pose = state.interpolator.sample(id, state.latestServerTick - 2);
              if (pose) {
                state.remotePlayers.set(id, {
                  id,
                  position: pose.position,
                  yaw: pose.yaw,
                  pitch: pose.pitch,
                  hp: pose.hp,
                });
              }
            }
            // Remove players no longer in snapshot
            for (const id of state.remotePlayers.keys()) {
              if (!knownIds.has(id)) {
                state.remotePlayers.delete(id);
                state.interpolator.remove(id);
              }
            }
            break;
          }
          default:
            break;
        }
      },
      onClose: () => {
        onDisconnect();
      },
    });

    const matchId = 'default';
    const identity = 'player-' + Math.random().toString(36).slice(2, 8);
    const token = 'mvp-token';
    const wsUrl = `ws://${window.location.hostname}:${window.location.port || '3000'}/ws/${matchId}?identity=${identity}&token=${token}`;
    socket.connect(wsUrl);
    state.socket = socket;

    return () => {
      socket.disconnect();
    };
  }, [onWelcome, onDisconnect]);

  const sendInput = useCallback((cmd: InputCmd) => {
    const state = stateRef.current;
    if (state.socket) {
      state.socket.sendInput(cmd);
    }
  }, []);

  return { stateRef, ready, sendInput };
}
