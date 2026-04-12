import { StatsGl } from '@react-three/drei';
import { Canvas } from '@react-three/fiber';
import { Suspense } from 'react';
import type { GameMode } from '../app/gameMode';
import { isTouchDevice } from '../device';
import { GameWorld } from './GameWorld';
import type { InputFamilyMode, InputSample } from '../input/types';
import type { WorldDocument } from '../world/worldDocument';

type GameSceneProps = {
  mode: GameMode;
  onWelcome: (id: number) => void;
  onDisconnect: () => void;
  onAimStateChange?: React.ComponentProps<typeof GameWorld>['onAimStateChange'];
  playerId: number;
  onDebugFrame?: GameWorldDebugFrame;
  onInputFrame?: (sample: InputSample) => void;
  inputFamilyMode?: InputFamilyMode;
  onSnapshot?: () => void;
  rapierDebugModeBits?: number;
  showRenderStats?: boolean;
  renderStatsParent?: React.RefObject<HTMLElement>;
  worldDocument?: WorldDocument;
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
  onSnapshot,
  rapierDebugModeBits = 0,
  showRenderStats,
  renderStatsParent,
  worldDocument,
}: GameSceneProps) {
  const touchMode = isTouchDevice();
  return (
    <Canvas
      style={{ width: '100%', height: '100%', touchAction: 'none' }}
      shadows
      camera={{ fov: 75, near: 0.1, far: 500, position: [0, 5, 10] }}
      onPointerDown={(e) => {
        if (touchMode) return;
        (e.target as HTMLCanvasElement).requestPointerLock();
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
          onSnapshot={onSnapshot}
          rapierDebugModeBits={rapierDebugModeBits}
        />
      </Suspense>
    </Canvas>
  );
}
