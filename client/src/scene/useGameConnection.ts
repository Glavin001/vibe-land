import { useEffect, useRef, useCallback, useState } from 'react';
import { GameSocket } from '../net/gameSocket';
import { PlayerInterpolator, ServerClockEstimator } from '../net/interpolation';
import {
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
  socket: GameSocket | null;
  playerId: number;
  remoteInterpolator: PlayerInterpolator;
  serverClock: ServerClockEstimator;
  interpolationDelayMs: number;
  latestServerTick: number;
  remotePlayers: Map<number, RemotePlayer>;
  localPosition: [number, number, number];
};

export function useGameConnection(
  onWelcome: (id: number) => void,
  onDisconnect: () => void,
  onLocalSnapshot?: (ackInputSeq: number, state: NetPlayerState) => void,
) {
  const stateRef = useRef<ConnectionState>({
    socket: null,
    playerId: 0,
    remoteInterpolator: new PlayerInterpolator(),
    serverClock: new ServerClockEstimator(),
    interpolationDelayMs: 100,
    latestServerTick: 0,
    remotePlayers: new Map(),
    localPosition: [0, 2, 0],
  });

  const onWelcomeRef = useRef(onWelcome);
  onWelcomeRef.current = onWelcome;
  const onDisconnectRef = useRef(onDisconnect);
  onDisconnectRef.current = onDisconnect;
  const onLocalSnapshotRef = useRef(onLocalSnapshot);
  onLocalSnapshotRef.current = onLocalSnapshot;
  const snapshotCadenceRef = useRef({
    windowStartedAt: 0,
    ackAtWindowStart: 0,
    lastSnapshotAt: 0,
    snapshots: 0,
    maxGapMs: 0,
  });

  const [ready, setReady] = useState(false);

  useEffect(() => {
    const state = stateRef.current;
    state.remoteInterpolator = new PlayerInterpolator();
    state.serverClock = new ServerClockEstimator();
    state.interpolationDelayMs = 100;
    state.remotePlayers = new Map();
    state.playerId = 0;

    const socket = new GameSocket({
      onPacket: (packet: ServerPacket) => {
        switch (packet.type) {
          case 'welcome':
            state.playerId = packet.playerId;
            state.interpolationDelayMs = packet.interpolationDelayMs;
            state.serverClock.observe(packet.serverTimeUs, performance.now() * 1000);
            console.log('[game] Welcome! playerId =', packet.playerId);
            onWelcomeRef.current(packet.playerId);
            setReady(true);
            break;
          case 'snapshot': {
            state.latestServerTick = packet.serverTick;
            state.serverClock.observe(packet.serverTimeUs, performance.now() * 1000);
            const knownIds = new Set<number>();
            for (const ps of packet.playerStates) {
              knownIds.add(ps.id);
              if (ps.id === state.playerId) {
                const now = performance.now();
                const cadence = snapshotCadenceRef.current;
                if (cadence.windowStartedAt === 0) {
                  cadence.windowStartedAt = now;
                  cadence.ackAtWindowStart = packet.ackInputSeq;
                }
                if (cadence.lastSnapshotAt !== 0) {
                  cadence.maxGapMs = Math.max(cadence.maxGapMs, now - cadence.lastSnapshotAt);
                }
                cadence.lastSnapshotAt = now;
                cadence.snapshots += 1;
                if (packet.ackInputSeq > 0 && now - cadence.windowStartedAt >= 1000) {
                  // #region agent log
                  fetch('http://127.0.0.1:7573/ingest/57b4fbd5-6dde-4eb5-b85a-6674ac4543c0',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'83ac5f'},body:JSON.stringify({sessionId:'83ac5f',runId:'cadence-pre',hypothesisId:'H27',location:'client/src/scene/useGameConnection.ts:93',message:'client snapshot cadence summary',data:{elapsedMs:now-cadence.windowStartedAt,snapshots:cadence.snapshots,ackStart:cadence.ackAtWindowStart,ackEnd:packet.ackInputSeq,ackAdvance:packet.ackInputSeq-cadence.ackAtWindowStart,maxGapMs:cadence.maxGapMs,serverTick:packet.serverTick},timestamp:Date.now()})}).catch(()=>{});
                  // #endregion
                  cadence.windowStartedAt = now;
                  cadence.ackAtWindowStart = packet.ackInputSeq;
                  cadence.snapshots = 0;
                  cadence.maxGapMs = 0;
                }
                if (onLocalSnapshotRef.current) {
                  onLocalSnapshotRef.current(packet.ackInputSeq, ps);
                } else {
                  const m = netStateToMeters(ps);
                  state.localPosition = m.position;
                }
              } else {
                const m = netStateToMeters(ps);
                state.remoteInterpolator.push(ps.id, {
                  serverTimeUs: packet.serverTimeUs,
                  position: m.position,
                  velocity: m.velocity,
                  yaw: m.yaw,
                  pitch: m.pitch,
                  flags: ps.flags,
                });
                state.remotePlayers.set(ps.id, {
                  id: ps.id,
                  position: m.position,
                  yaw: m.yaw,
                  pitch: m.pitch,
                  hp: 100,
                });
              }
            }
            // Remove disconnected players
            for (const id of state.remotePlayers.keys()) {
              if (!knownIds.has(id)) {
                state.remotePlayers.delete(id);
                state.remoteInterpolator.remove(id);
              }
            }
            state.remoteInterpolator.retainOnly(knownIds);
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

  const sendInputs = useCallback((cmds: InputCmd[]) => {
    const state = stateRef.current;
    if (state.socket) {
      state.socket.sendInputs(cmds);
    }
  }, []);

  return { stateRef, ready, sendInputs };
}
