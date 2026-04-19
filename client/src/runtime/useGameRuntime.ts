import { useEffect, useRef, useState, useMemo } from 'react';
import { isPracticeMode, type GameMode } from '../app/gameMode';
import { resolveRequestedMatchId } from '../app/matchId';
import { resolveMultiplayerBackend } from '../app/runtimeConfig';
import type { RenderBlock } from '../world/voxelWorld';
import type { DestructibleTuning } from '../physics/destructibleTuning';
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
  destructibleTuning: DestructibleTuning | undefined,
  onWelcome: (id: number) => void,
  onDisconnect: (reason?: string) => void,
  onSnapshot?: () => void,
  localRenderSmoothingEnabled = true,
) {
  const practiceMode = isPracticeMode(mode);
  const multiplayerBackend = useMemo(() => resolveMultiplayerBackend(), []);
  const multiplayerMatchId = useMemo(() => resolveRequestedMatchId(window.location.search), []);
  const runtimeRef = useRef<GameRuntimeClient | null>(null);
  const onWelcomeRef = useRef(onWelcome);
  const onDisconnectRef = useRef(onDisconnect);
  const onSnapshotRef = useRef(onSnapshot);
  const [ready, setReady] = useState(false);
  const [renderBlocks, setRenderBlocks] = useState<RenderBlock[]>([]);

  onWelcomeRef.current = onWelcome;
  onDisconnectRef.current = onDisconnect;
  onSnapshotRef.current = onSnapshot;

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
      onRenderBlocksChanged: (blocks) => {
        if (disposed) {
          return;
        }
        setRenderBlocks(blocks);
      },
    };

    const runtime = practiceMode
      ? new LocalGameRuntime(callbacks, worldJson, destructibleTuning)
      : new MultiplayerGameRuntime(
          callbacks,
          multiplayerBackend,
          multiplayerMatchId,
          predictionWorldJson,
          localRenderSmoothingEnabled,
        );
    runtimeRef.current = runtime;

    void runtime.connect().catch((error) => {
      if (disposed) {
        runtime.disconnect();
        return;
      }
      onDisconnectRef.current(error instanceof Error ? error.message : String(error));
    });

    return () => {
      disposed = true;
      runtime.disconnect();
      if (runtimeRef.current === runtime) {
        runtimeRef.current = null;
      }
      setReady(false);
      setRenderBlocks([]);
    };
  }, [
    localRenderSmoothingEnabled,
    mode,
    multiplayerBackend,
    multiplayerMatchId,
    practiceMode,
    predictionWorldJson,
    destructibleTuning,
    worldJson,
  ]);

  return {
    ready,
    renderBlocks,
    runtimeRef,
  };
}
