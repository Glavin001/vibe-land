import { StatsGl } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Suspense, useEffect, useRef, type ReactNode } from 'react';
import type { GameMode } from '../app/gameMode';
import { renderStats } from '../city/renderStats';
import {
  antialiasEnabled,
  dynamicResolutionEnabled,
  governorFluidCap,
  governorSampleScale,
  setGovernorFluidCap,
  setGovernorSampleScale,
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
  aerialMode?: boolean;
  aerialSpeed?: number;
  aerialDropRequest?: number;
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
  const scaleRef = useRef(1);
  const gpuEmaRef = useRef(0);
  const frameMinRef = useRef({ min: Infinity, frames: 0, period: 0 });
  const sinceAdjustRef = useRef(0);
  const dustEmaRef = useRef(0);
  const dustHeadroom = useRef(0);
  const apply = (scale: number) => {
    scaleRef.current = scale;
    renderStats.dprScale = scale;
    setDpr(Math.min(window.devicePixelRatio, maxDpr()) * scale);
  };
  useEffect(
    () =>
      onRenderQualityChange(() => {
        if (!dynamicResolutionEnabled()) scaleRef.current = 1;
        apply(scaleRef.current);
      }),
    [setDpr],
  );
  // The dynamic-resolution loop.
  //
  // The GPU number is the sum of the per-pass timer queries -- the renderer's
  // own cost -- and the display period is read off the frame pacing: the
  // shortest frame over a window is the vsync interval whenever the GPU is
  // comfortably under it. The budget is 85% of that period. Every 20 frames
  // the scale moves towards sqrt(budget / gpu) (pixels go as the square), at
  // most 8% a step, and only grows back once there is a fifth of headroom, so
  // it settles rather than hunts. Floor 0.6: below that the tier's look is gone.
  useFrame(() => {
    if (!dynamicResolutionEnabled()) {
      if (scaleRef.current !== 1) apply(1);
      renderStats.gpuBudgetMs = 0;
      return;
    }
    const gpu = renderStats.gpuFrameMs;
    if (gpu > 0) gpuEmaRef.current = gpuEmaRef.current > 0 ? gpuEmaRef.current * 0.95 + gpu * 0.05 : gpu;
    const pacing = frameMinRef.current;
    const frame = renderStats.frameTotalMs;
    if (frame > 0 && frame < pacing.min) pacing.min = frame;
    pacing.frames += 1;
    if (pacing.frames >= 120) {
      // Quantise to the refresh rates that exist; a GPU-bound window says
      // nothing about the display and keeps the last estimate.
      if (pacing.min < 9.5) pacing.period = 8.33;
      else if (pacing.min < 17.5 && gpuEmaRef.current < 12) pacing.period = 16.67;
      else if (pacing.period === 0) pacing.period = 16.67;
      pacing.min = Infinity;
      pacing.frames = 0;
    }
    const period = pacing.period || 8.33;
    const budget = period * 0.85;
    renderStats.gpuBudgetMs = budget;
    const dust = renderStats.gpuDustMs;
    dustEmaRef.current = dustEmaRef.current > 0 ? dustEmaRef.current * 0.9 + dust * 0.1 : dust;
    sinceAdjustRef.current += 1;
    if (sinceAdjustRef.current < 20 || gpuEmaRef.current <= 0) return;
    sinceAdjustRef.current = 0;
    const ema = gpuEmaRef.current;
    // The dust stage first. Its fluid is a dozen dependent passes per step
    // and its volume a sample budget; neither follows the canvas size, and on
    // the reporter's M3 they were 10-129 ms of a frame -- so while the frame
    // is over budget and dust is a third or more of it, the governor takes
    // from dust: samples to half, then the fluid a rung, then samples to a
    // quarter. It gives back one rung at a time, slowly, once the frame has
    // held a fifth of headroom for two seconds.
    const dustHeavy = ema > budget && dustEmaRef.current > budget * 0.35;
    if (dustHeavy) {
      const scale = governorSampleScale();
      const cap = governorFluidCap();
      if (scale > 0.5) setGovernorSampleScale(0.5);
      else if (cap === 'balanced') setGovernorFluidCap('fast');
      else if (cap === 'fast') setGovernorFluidCap('off');
      else if (scale > 0.25) setGovernorSampleScale(0.25);
      dustHeadroom.current = 0;
      return;
    }
    if (ema < budget * 0.8) {
      dustHeadroom.current += 1;
      // 20 frames per evaluation: six evaluations is two seconds at 60 Hz.
      if (dustHeadroom.current >= 6 && scaleRef.current >= 0.999) {
        dustHeadroom.current = 0;
        const scale = governorSampleScale();
        const cap = governorFluidCap();
        if (scale < 0.5) setGovernorSampleScale(0.5);
        else if (cap === 'off') setGovernorFluidCap('fast');
        else if (cap === 'fast') setGovernorFluidCap('balanced');
        else if (scale < 1) setGovernorSampleScale(1);
        return;
      }
    } else {
      dustHeadroom.current = 0;
    }
    let next = scaleRef.current;
    if (ema > budget) next = scaleRef.current * Math.max(0.92, Math.sqrt(budget / ema));
    else if (ema < budget * 0.8) next = scaleRef.current * Math.min(1.08, Math.sqrt(budget / ema));
    next = Math.min(1, Math.max(0.6, next));
    if (Math.abs(next - scaleRef.current) > 0.005) apply(next);
  });
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
  aerialMode,
  aerialSpeed,
  aerialDropRequest,
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
          aerialMode={aerialMode}
          aerialSpeed={aerialSpeed}
          aerialDropRequest={aerialDropRequest}
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
