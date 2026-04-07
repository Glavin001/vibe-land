import { Canvas } from '@react-three/fiber';
import { Suspense, useCallback, useRef, useState } from 'react';
import { detectTouchControls } from '../device';
import {
  BTN_BACK,
  BTN_FORWARD,
  BTN_LEFT,
  BTN_RIGHT,
} from '../net/protocol';
import { GameWorld } from './GameWorld';
import { MobileControls } from './MobileControls';

type GameSceneProps = {
  onWelcome: (id: number) => void;
  onDisconnect: () => void;
  playerId: number;
};

export function GameScene({ onWelcome, onDisconnect }: GameSceneProps) {
  const [touchMode] = useState(detectTouchControls);
  const inputButtonsRef = useRef(0);
  const yawRef = useRef(0);
  const pitchRef = useRef(0);

  const applyLookDelta = useCallback((dx: number, dy: number) => {
    yawRef.current -= dx * 0.003;
    pitchRef.current = Math.max(
      -Math.PI / 2 + 0.01,
      Math.min(Math.PI / 2 - 0.01, pitchRef.current - dy * 0.003),
    );
  }, []);

  const setMoveButtons = useCallback((buttons: number) => {
    const moveMask = BTN_FORWARD | BTN_BACK | BTN_LEFT | BTN_RIGHT;
    inputButtonsRef.current = (inputButtonsRef.current & ~moveMask) | buttons;
  }, []);

  const setActionButton = useCallback((mask: number, active: boolean) => {
    if (active) {
      inputButtonsRef.current |= mask;
      return;
    }
    inputButtonsRef.current &= ~mask;
  }, []);

  return (
    <div style={{
      position: 'absolute',
      inset: 0,
      touchAction: touchMode ? 'none' : 'auto',
    }}>
      <Canvas
        style={{ display: 'block', width: '100%', height: '100%' }}
        dpr={[1, 2]}
        camera={{ fov: 75, near: 0.1, far: 500, position: [0, 5, 10] }}
        onPointerDown={(e) => {
          if (touchMode || e.pointerType === 'touch') return;
          (e.target as HTMLCanvasElement).requestPointerLock();
        }}
      >
        <Suspense fallback={null}>
          <GameWorld
            onWelcome={onWelcome}
            onDisconnect={onDisconnect}
            inputButtonsRef={inputButtonsRef}
            yawRef={yawRef}
            pitchRef={pitchRef}
            applyLookDelta={applyLookDelta}
          />
        </Suspense>
      </Canvas>
      {touchMode && (
        <MobileControls
          onLookDelta={applyLookDelta}
          onMoveButtonsChange={setMoveButtons}
          onActionButtonChange={setActionButton}
        />
      )}
    </div>
  );
}
