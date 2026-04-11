import { Canvas } from '@react-three/fiber';
import { Suspense } from 'react';
import { GameWorld } from './GameWorld';

type GameSceneProps = {
  onWelcome: (id: number) => void;
  onDisconnect: () => void;
  onAimStateChange?: React.ComponentProps<typeof GameWorld>['onAimStateChange'];
  playerId: number;
  onDebugFrame?: GameWorldDebugFrame;
  onSnapshot?: () => void;
};

type GameWorldDebugFrame = React.ComponentProps<typeof GameWorld>['onDebugFrame'];

export function GameScene({ onWelcome, onDisconnect, onAimStateChange, onDebugFrame, onSnapshot }: GameSceneProps) {
  return (
    <Canvas
      style={{ width: '100%', height: '100%' }}
      camera={{ fov: 75, near: 0.1, far: 500, position: [0, 5, 10] }}
      onPointerDown={(e) => {
        (e.target as HTMLCanvasElement).requestPointerLock();
      }}
    >
      <Suspense fallback={null}>
        <GameWorld
          onWelcome={onWelcome}
          onDisconnect={onDisconnect}
          onAimStateChange={onAimStateChange}
          onDebugFrame={onDebugFrame}
          onSnapshot={onSnapshot}
        />
      </Suspense>
    </Canvas>
  );
}
