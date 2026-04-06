import { useEffect, useRef, useCallback, useState } from 'react';
import { GameSocket } from '../net/gameSocket';
import { SnapshotInterpolator } from '../net/interpolation';
import {
  netStateToMeters,
  type InputCmd,
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
  socket: GameSocket | null;
  playerId: number;
  interpolator: SnapshotInterpolator;
  latestServerTick: number;
  remotePlayers: Map<number, RemotePlayer>;
  localPosition: [number, number, number];
};

export function useGameConnection(
  onWelcome: (id: number) => void,
  onDisconnect: () => void,
) {
  const stateRef = useRef<ConnectionState>({
    socket: null,
    playerId: 0,
    interpolator: new SnapshotInterpolator(),
    latestServerTick: 0,
    remotePlayers: new Map(),
    localPosition: [0, 2, 0],
  });

  const onWelcomeRef = useRef(onWelcome);
  onWelcomeRef.current = onWelcome;
  const onDisconnectRef = useRef(onDisconnect);
  onDisconnectRef.current = onDisconnect;

  const [ready, setReady] = useState(false);

  useEffect(() => {
    const state = stateRef.current;
    state.interpolator = new SnapshotInterpolator();
    state.remotePlayers = new Map();
    state.playerId = 0;

    const socket = new GameSocket({
      onPacket: (packet: ServerPacket) => {
        switch (packet.type) {
          case 'welcome':
            state.playerId = packet.playerId;
            console.log('[game] Welcome! playerId =', packet.playerId);
            onWelcomeRef.current(packet.playerId);
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
                const m = netStateToMeters(ps);
                state.interpolator.push(ps.id, {
                  serverTick: packet.serverTick,
                  receivedAtMs: performance.now(),
                  position: m.position,
                  velocity: m.velocity,
                  yaw: m.yaw,
                  pitch: m.pitch,
                  hp: ps.hp,
                  flags: ps.flags,
                });
                state.remotePlayers.set(ps.id, {
                  id: ps.id,
                  position: m.position,
                  yaw: m.yaw,
                  pitch: m.pitch,
                  hp: ps.hp,
                });
              }
            }
            // Remove disconnected players
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
        onDisconnectRef.current();
      },
    });

    const matchId = 'default';
    const identity = 'player-' + Math.random().toString(36).slice(2, 8);
    const token = 'mvp-token';
    const wsUrl = `ws://${window.location.hostname}:${window.location.port || '3000'}/ws/${matchId}?identity=${identity}&token=${token}`;
    console.log('[game] Connecting to', wsUrl);
    socket.connect(wsUrl);
    state.socket = socket;

    return () => {
      socket.disconnect();
      state.socket = null;
    };
  }, []);

  const sendInput = useCallback((cmd: InputCmd) => {
    const state = stateRef.current;
    if (state.socket) {
      state.socket.sendInput(cmd);
    }
  }, []);

  return { stateRef, ready, sendInput };
}
