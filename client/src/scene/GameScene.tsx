import { StatsGl } from '@react-three/drei';
import { Canvas } from '@react-three/fiber';
import { Suspense, type ReactNode } from 'react';
import type { GameMode } from '../app/gameMode';
import { isTouchDevice } from '../device';
import type { InputBindings } from '../input/bindings';
import { requestPointerLockSafe } from '../input/pointerLock';
import { GameWorld } from './GameWorld';
import type { InputFamilyMode, InputSample } from '../input/types';
import type { WorldDocument } from '../world/worldDocument';

type GameSceneProps = {
  mode: GameMode;
  onWelcome: (id: number) => void;
  onDisconnect: (reason?: string) => void;
  onAimStateChange?: React.ComponentProps<typeof GameWorld>['onAimStateChange'];
  playerId: number;
  onDebugFrame?: GameWorldDebugFrame;
  onInputFrame?: (sample: InputSample) => void;
  inputFamilyMode?: InputFamilyMode;
  inputBindings: InputBindings;
  onSnapshot?: () => void;
  rapierDebugModeBits?: number;
  showRenderStats?: boolean;
  renderStatsParent?: React.RefObject<HTMLElement>;
  worldDocument?: WorldDocument;
  benchmarkAutopilot?: React.ComponentProps<typeof GameWorld>['benchmarkAutopilot'];
  localRenderSmoothingEnabled?: boolean;
  vehicleSmoothingEnabled?: boolean;
  sceneExtras?: ReactNode;
};

type GameWorldDebugFrame = React.ComponentProps<typeof GameWorld>['onDebugFrame'];

export function GameScene({
  mode,
  onWelcome,
  onDisconnect,
  onAimStateChange,
  onDebugFrame,
  onInputFrame,
  inputFamilyMode,
  inputBindings,
  onSnapshot,
  rapierDebugModeBits = 0,
  showRenderStats,
  renderStatsParent,
  worldDocument,
  benchmarkAutopilot,
  localRenderSmoothingEnabled = true,
  vehicleSmoothingEnabled = false,
  sceneExtras,
}: GameSceneProps) {
  const touchMode = isTouchDevice();
  return (
    <Canvas
      style={{ width: '100%', height: '100%', touchAction: 'none' }}
      shadows
      camera={{ fov: 75, near: 0.1, far: 500, position: [0, 5, 10] }}
      data-testid="game-canvas"
      onPointerDown={(e) => {
        if (touchMode) return;
        requestPointerLockSafe(e.target as HTMLCanvasElement);
      }}
    >
      <Suspense fallback={null}>
        {showRenderStats && (
          <StatsGl
            parent={renderStatsParent}
            trackGPU
            horizontal={false}
          />
        )}
        <GameWorld
          mode={mode}
          worldDocument={worldDocument}
          onWelcome={onWelcome}
          onDisconnect={onDisconnect}
          onAimStateChange={onAimStateChange}
          onDebugFrame={onDebugFrame}
          onInputFrame={onInputFrame}
          inputFamilyMode={inputFamilyMode}
          inputBindings={inputBindings}
          onSnapshot={onSnapshot}
          rapierDebugModeBits={rapierDebugModeBits}
          benchmarkAutopilot={benchmarkAutopilot}
          localRenderSmoothingEnabled={localRenderSmoothingEnabled}
          vehicleSmoothingEnabled={vehicleSmoothingEnabled}
          sceneExtras={sceneExtras}
        />
      </Suspense>
    </Canvas>
  );
}
