import { useEffect, useRef, useState, useMemo } from 'react';
import { isPracticeMode, type GameMode } from '../app/gameMode';
import { defaultMatchIdForPath, resolveRequestedMatchId } from '../app/matchId';
import { backendFromOrigin, resolveMultiplayerBackend } from '../app/runtimeConfig';
import { joinServer, resolveControlPlane, toSessionConfig, type JoinProgress } from '../app/join';
import type { DamageEventPacket, ShotFiredPacket } from '../net/protocol';
import type { RenderBlock } from '../world/voxelWorld';
import {
  LocalGameRuntime,
  MultiplayerGameRuntime,
  type GameRuntimeCallbacks,
  type GameRuntimeClient,
} from './gameRuntime';

export function useGameRuntime(
  mode: GameMode,
  worldJson: string,
  predictionWorldJson: string,
  onWelcome: (id: number) => void,
  onDisconnect: (reason?: string) => void,
  onSnapshot?: () => void,
  localRenderSmoothingEnabled = true,
  onDamageEvent?: (packet: DamageEventPacket) => void,
  onShotFired?: (packet: ShotFiredPacket) => void,
) {
  const practiceMode = isPracticeMode(mode);
  const multiplayerBackend = useMemo(() => resolveMultiplayerBackend(), []);
  const multiplayerMatchId = useMemo(
    () =>
      resolveRequestedMatchId(
        window.location.search,
        defaultMatchIdForPath(window.location.pathname),
      ),
    [],
  );
  // Null unless a control plane is configured, in which case the server to
  // play on is discovered at connect time instead of being baked into the build.
  const controlPlane = useMemo(() => resolveControlPlane(window.location.search), []);
  const runtimeRef = useRef<GameRuntimeClient | null>(null);
  const onWelcomeRef = useRef(onWelcome);
  const onDisconnectRef = useRef(onDisconnect);
  const onSnapshotRef = useRef(onSnapshot);
  const onDamageEventRef = useRef(onDamageEvent);
  const onShotFiredRef = useRef(onShotFired);
  const [ready, setReady] = useState(false);
  const [renderBlocks, setRenderBlocks] = useState<RenderBlock[]>([]);
  const [joinProgress, setJoinProgress] = useState<JoinProgress | null>(null);

  onWelcomeRef.current = onWelcome;
  onDisconnectRef.current = onDisconnect;
  onSnapshotRef.current = onSnapshot;
  onDamageEventRef.current = onDamageEvent;
  onShotFiredRef.current = onShotFired;

  useEffect(() => {
    let disposed = false;
    setReady(false);
    setRenderBlocks([]);

    const callbacks: GameRuntimeCallbacks = {
      onWelcome: (id) => {
        if (disposed) {
          return;
        }
        onWelcomeRef.current(id);
        setReady(true);
      },
      onDisconnect: (reason) => {
        if (disposed) {
          return;
        }
        onDisconnectRef.current(reason);
      },
      onSnapshot: () => onSnapshotRef.current?.(),
      onDamageEvent: (packet) => onDamageEventRef.current?.(packet),
      onRenderBlocksChanged: (blocks) => {
        if (disposed) {
          return;
        }
        setRenderBlocks(blocks);
      },
      onShotFired: (packet) => {
        if (disposed) {
          return;
        }
        onShotFiredRef.current?.(packet);
      },
    };

    // Renting and booting a GPU box takes minutes, so the abort controller
    // matters: unmounting mid-wait must stop the polling loop.
    const joinAbort = new AbortController();

    const buildRuntime = async (): Promise<GameRuntimeClient> => {
      if (practiceMode) {
        return new LocalGameRuntime(callbacks, worldJson);
      }
      if (!controlPlane) {
        return new MultiplayerGameRuntime(
          callbacks,
          multiplayerBackend,
          multiplayerMatchId,
          predictionWorldJson,
          localRenderSmoothingEnabled,
        );
      }

      setJoinProgress({ phase: 'SEARCHING', etaSeconds: 300, attempt: 0 });
      const joined = await joinServer(controlPlane, {
        signal: joinAbort.signal,
        onProgress: (progress) => {
          if (!disposed) setJoinProgress(progress);
        },
      });
      if (!disposed) setJoinProgress(null);

      const sessionConfig = toSessionConfig(joined);
      return new MultiplayerGameRuntime(
        callbacks,
        backendFromOrigin(new URL(sessionConfig.url).origin),
        joined.matchId,
        predictionWorldJson,
        localRenderSmoothingEnabled,
        { sessionConfig },
      );
    };

    let runtime: GameRuntimeClient | null = null;
    void buildRuntime()
      .then(async (built) => {
        runtime = built;
        if (disposed) {
          built.disconnect();
          return;
        }
        runtimeRef.current = built;
        await built.connect();
      })
      .catch((error) => {
        if (disposed) {
          runtime?.disconnect();
          return;
        }
        onDisconnectRef.current(error instanceof Error ? error.message : String(error));
      });

    return () => {
      disposed = true;
      joinAbort.abort();
      runtime?.disconnect();
      if (runtime && runtimeRef.current === runtime) {
        runtimeRef.current = null;
      }
      setReady(false);
      setRenderBlocks([]);
    };
  }, [
    controlPlane,
    localRenderSmoothingEnabled,
    mode,
    multiplayerBackend,
    multiplayerMatchId,
    practiceMode,
    predictionWorldJson,
    worldJson,
  ]);

  return {
    ready,
    renderBlocks,
    runtimeRef,
    /** Non-null while waiting for the control plane to produce a server. */
    joinProgress,
  };
}
