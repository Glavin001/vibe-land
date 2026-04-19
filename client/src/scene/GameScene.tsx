import { StatsGl } from '@react-three/drei';
import { Canvas } from '@react-three/fiber';
import { Suspense, type ReactNode, type RefObject } from 'react';
import type { GameMode } from '../app/gameMode';
import { isTouchDevice } from '../device';
import type { InputBindings } from '../input/bindings';
import { GameWorld } from './GameWorld';
import type { GuestHudMap } from './PracticeGuestPlayer';
import type { InputFamilyMode, InputSample, LocalDeviceAssignment } from '../input/types';
import type { WorldDocument } from '../world/worldDocument';

export interface PracticeGuestSpec {
  slotId: number;
  humanId: number;
  device: LocalDeviceAssignment;
}

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
  showDebugHelpers?: boolean;
  renderStatsParent?: React.RefObject<HTMLElement>;
  worldDocument?: WorldDocument;
  benchmarkAutopilot?: React.ComponentProps<typeof GameWorld>['benchmarkAutopilot'];
  practiceBots?: React.ComponentProps<typeof GameWorld>['practiceBots'];
  practiceBotsDebugOverlay?: boolean;
  localRenderSmoothingEnabled?: boolean;
  vehicleSmoothingEnabled?: boolean;
  sceneExtras?: ReactNode;
  practiceGuests?: PracticeGuestSpec[];
  guestHudRef?: RefObject<GuestHudMap>;
  localSlotZeroDevice?: LocalDeviceAssignment | null;
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
  showDebugHelpers = false,
  renderStatsParent,
  worldDocument,
  benchmarkAutopilot,
  practiceBots,
  practiceBotsDebugOverlay,
  localRenderSmoothingEnabled = true,
  vehicleSmoothingEnabled = false,
  sceneExtras,
  practiceGuests,
  guestHudRef,
  localSlotZeroDevice,
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
          inputBindings={inputBindings}
          onSnapshot={onSnapshot}
          rapierDebugModeBits={rapierDebugModeBits}
          showDebugHelpers={showDebugHelpers}
          benchmarkAutopilot={benchmarkAutopilot}
          practiceBots={practiceBots}
          practiceBotsDebugOverlay={practiceBotsDebugOverlay}
          localRenderSmoothingEnabled={localRenderSmoothingEnabled}
          vehicleSmoothingEnabled={vehicleSmoothingEnabled}
          sceneExtras={sceneExtras}
          practiceGuests={practiceGuests}
          guestHudRef={guestHudRef}
          localSlotZeroDevice={localSlotZeroDevice}
        />
      </Suspense>
    </Canvas>
  );
}
