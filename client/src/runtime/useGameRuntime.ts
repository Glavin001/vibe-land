import { useEffect, useRef, useState, useMemo } from 'react';
import { isPracticeMode, type GameMode } from '../app/gameMode';
import { resolveRequestedMatchId } from '../app/matchId';
import { resolveMultiplayerBackend } from '../app/runtimeConfig';
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
  const multiplayerMatchId = useMemo(() => resolveRequestedMatchId(window.location.search), []);
  const runtimeRef = useRef<GameRuntimeClient | null>(null);
  const onWelcomeRef = useRef(onWelcome);
  const onDisconnectRef = useRef(onDisconnect);
  const onSnapshotRef = useRef(onSnapshot);
  const onDamageEventRef = useRef(onDamageEvent);
  const onShotFiredRef = useRef(onShotFired);
  const [ready, setReady] = useState(false);
  const [renderBlocks, setRenderBlocks] = useState<RenderBlock[]>([]);

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

    const runtime = practiceMode
      ? new LocalGameRuntime(callbacks, worldJson)
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
    worldJson,
  ]);

  return {
    ready,
    renderBlocks,
    runtimeRef,
  };
}
