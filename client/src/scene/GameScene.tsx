import { StatsGl } from '@react-three/drei';
import { Canvas, useThree } from '@react-three/fiber';
import { Suspense, useEffect, type ReactNode } from 'react';
import type { GameMode } from '../app/gameMode';
import {
  antialiasEnabled,
  flatToneMapping,
  maxDpr,
  onRenderQualityChange,
} from '../app/renderQuality';
import { isTouchDevice } from '../device';
import type { InputBindings } from '../input/bindings';
import { FrameClock } from './FrameClock';
import { GameWorld } from './GameWorld';
import type { InputFamilyMode, InputSample } from '../input/types';
import type { WorldDocument } from '../world/worldDocument';
import type { WeatherPreset } from '../graphics/weatherPresets';

type GameSceneProps = {
  mode: GameMode;
  onWelcome: (id: number) => void;
  onDisconnect: (reason?: string) => void;
  onAimStateChange?: React.ComponentProps<typeof GameWorld>['onAimStateChange'];
  onScopeActiveChange?: React.ComponentProps<typeof GameWorld>['onScopeActiveChange'];
  playerId: number;
  onDebugFrame?: GameWorldDebugFrame;
  onInputFrame?: (sample: InputSample) => void;
  inputFamilyMode?: InputFamilyMode;
  inputBindings: InputBindings;
  onSnapshot?: () => void;
  rapierDebugModeBits?: number;
  showRenderStats?: boolean;
  showDebugHelpers?: boolean;
  showPlayerIdLabels?: boolean;
  renderStatsParent?: React.RefObject<HTMLElement>;
  worldDocument?: WorldDocument;
  benchmarkAutopilot?: React.ComponentProps<typeof GameWorld>['benchmarkAutopilot'];
  practiceBots?: React.ComponentProps<typeof GameWorld>['practiceBots'];
  practiceBotsDebugOverlay?: boolean;
  practiceBotsDebugLabels?: boolean;
  localRenderSmoothingEnabled?: boolean;
  vehicleSmoothingEnabled?: boolean;
  cosmeticDeathPhysicsEnabled?: boolean;
  fogEnabled?: boolean;
  fogDensity?: number;
  fogColor?: string;
  weather?: WeatherPreset;
  windStrengthMps?: number;
  windDirectionDeg?: number;
  intensity?: number;
  damageFeedback?: React.ComponentProps<typeof GameWorld>['damageFeedback'];
  sceneExtras?: ReactNode;
};

type GameWorldDebugFrame = React.ComponentProps<typeof GameWorld>['onDebugFrame'];

/**
 * Applies dpr changes from the quality tier to the live renderer.
 *
 * Lives inside the Canvas because setDpr comes from the R3F store. Unlike
 * antialias/tonemapping, pixel ratio is a plain resize -- flipping the tier
 * mid-game moves the fps immediately, which is the whole point of the toggle
 * as a measurement instrument.
 */
function DprController(): null {
  const setDpr = useThree((state) => state.setDpr);
  useEffect(
    () =>
      onRenderQualityChange(() => {
        setDpr(Math.min(window.devicePixelRatio, maxDpr()));
      }),
    [setDpr],
  );
  return null;
}

export function GameScene({
  mode,
  onWelcome,
  onDisconnect,
  onAimStateChange,
  onScopeActiveChange,
  onDebugFrame,
  onInputFrame,
  inputFamilyMode,
  inputBindings,
  onSnapshot,
  rapierDebugModeBits = 0,
  showRenderStats,
  showDebugHelpers = false,
  showPlayerIdLabels = false,
  renderStatsParent,
  worldDocument,
  benchmarkAutopilot,
  practiceBots,
  practiceBotsDebugOverlay,
  practiceBotsDebugLabels,
  localRenderSmoothingEnabled = true,
  vehicleSmoothingEnabled = false,
  cosmeticDeathPhysicsEnabled = true,
  fogEnabled,
  fogDensity,
  fogColor,
  weather,
  windStrengthMps,
  windDirectionDeg,
  intensity,
  damageFeedback,
  sceneExtras,
}: GameSceneProps) {
  const touchMode = isTouchDevice();
  return (
    <Canvas
      style={{ width: '100%', height: '100%', touchAction: 'none' }}
      shadows
      // Pixel budget and context flags come from the quality tier. dpr is the
      // multiplier on every fill cost in the scene: R3F's default of 2 on a 3x
      // phone renders ~2.3 MP. antialias and flat (tonemapping) are
      // context-creation-time -- read once here, a tier change applies them on
      // the next reload; DprController below handles dpr live.
      dpr={[1, maxDpr()]}
      flat={flatToneMapping()}
      gl={{ antialias: antialiasEnabled(), powerPreference: 'high-performance' }}
      camera={{ fov: 75, near: 0.1, far: 200, position: [0, 5, 10] }}
      data-testid="game-canvas"
      onPointerDown={(e) => {
        if (touchMode) return;
        (e.target as HTMLCanvasElement).requestPointerLock();
      }}
    >
      <DprController />
      <FrameClock />
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
          onScopeActiveChange={onScopeActiveChange}
          onDebugFrame={onDebugFrame}
          onInputFrame={onInputFrame}
          inputFamilyMode={inputFamilyMode}
          inputBindings={inputBindings}
          onSnapshot={onSnapshot}
          rapierDebugModeBits={rapierDebugModeBits}
          showDebugHelpers={showDebugHelpers}
          showPlayerIdLabels={showPlayerIdLabels}
          benchmarkAutopilot={benchmarkAutopilot}
          practiceBots={practiceBots}
          practiceBotsDebugOverlay={practiceBotsDebugOverlay}
          practiceBotsDebugLabels={practiceBotsDebugLabels}
          localRenderSmoothingEnabled={localRenderSmoothingEnabled}
          vehicleSmoothingEnabled={vehicleSmoothingEnabled}
          cosmeticDeathPhysicsEnabled={cosmeticDeathPhysicsEnabled}
          fogEnabled={fogEnabled}
          fogDensity={fogDensity}
          fogColor={fogColor}
          weather={weather}
          windStrengthMps={windStrengthMps}
          windDirectionDeg={windDirectionDeg}
          intensity={intensity}
          damageFeedback={damageFeedback}
          sceneExtras={sceneExtras}
        />
      </Suspense>
    </Canvas>
  );
}
