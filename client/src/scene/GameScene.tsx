import { StatsGl } from '@react-three/drei';
import { Canvas } from '@react-three/fiber';
import { Suspense } from 'react';
import { GameWorld } from './GameWorld';
import type { InputFamilyMode, InputSample } from '../input/types';

type GameSceneProps = {
  onWelcome: (id: number) => void;
  onDisconnect: () => void;
  onAimStateChange?: React.ComponentProps<typeof GameWorld>['onAimStateChange'];
  playerId: number;
  onDebugFrame?: GameWorldDebugFrame;
  onInputFrame?: (sample: InputSample) => void;
  inputFamilyMode?: InputFamilyMode;
  onSnapshot?: () => void;
  showRenderStats?: boolean;
  renderStatsParent?: React.RefObject<HTMLElement>;
};

type GameWorldDebugFrame = React.ComponentProps<typeof GameWorld>['onDebugFrame'];

export function GameScene({
  onWelcome,
  onDisconnect,
  onAimStateChange,
  onDebugFrame,
  onInputFrame,
  inputFamilyMode,
  onSnapshot,
  showRenderStats,
  renderStatsParent,
}: GameSceneProps) {
  return (
    <Canvas
      style={{ width: '100%', height: '100%' }}
      camera={{ fov: 75, near: 0.1, far: 500, position: [0, 5, 10] }}
      onPointerDown={(e) => {
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
          onWelcome={onWelcome}
          onDisconnect={onDisconnect}
          onAimStateChange={onAimStateChange}
          onDebugFrame={onDebugFrame}
          onInputFrame={onInputFrame}
          inputFamilyMode={inputFamilyMode}
          onSnapshot={onSnapshot}
        />
      </Suspense>
    </Canvas>
  );
}
