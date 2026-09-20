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
  const gov = useRef({
    frameEma: 0,
    cpuEma: 0,
    gpuEma: 0,
    dustEma: 0,
    pacingMin: Infinity,
    pacingFrames: 0,
    period: 0,
    sinceAdjust: 0,
    // The recovery probe: how long to hold before trying a rung back, and
    // the rung on trial. A trial that overruns is undone and the hold doubles.
    probeHoldFrames: 180,
    heldFrames: 0,
    trial: null as null | { undo: () => void; framesLeft: number },
  });
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
  // The GPU governor.
  //
  // Over budget is decided from the WALL CLOCK: the frame's own pacing is
  // longer than the display period, and the CPU is spending a large share of
  // that waiting (offFrame), which is what GPU-bound looks like. The per-pass
  // GPU timers are NOT used for that decision: on the reporter's M3 they
  // summed to 26-52 ms inside 12 ms frames, so ANGLE's Metal queries report
  // something wider than the pass. They are still the only thing that says
  // WHICH pass is heavy, and that is all they decide here: whether a trim
  // comes out of the dust stage (samples to half, fluid balanced -> fast ->
  // off, samples to a quarter) or out of pixels (dpr, 8% a step, floor 0.6).
  //
  // Recovery cannot read headroom off a vsync-locked frame, so it probes:
  // after a hold, one rung is given back on trial; if the frame overruns
  // within a second the rung is taken away again and the hold doubles (to a
  // cap of half a minute); if it holds, the trial sticks and the hold resets.
  useFrame(() => {
    const g = gov.current;
    if (!dynamicResolutionEnabled()) {
      if (scaleRef.current !== 1) apply(1);
      if (governorFluidCap() !== 'balanced') setGovernorFluidCap('balanced');
      if (governorSampleScale() !== 1) setGovernorSampleScale(1);
      renderStats.gpuBudgetMs = 0;
      return;
    }
    const frame = renderStats.frameTotalMs;
    const cpu = renderStats.cpuFrameMs;
    if (frame > 0) {
      g.frameEma = g.frameEma > 0 ? g.frameEma * 0.9 + frame * 0.1 : frame;
      g.cpuEma = g.cpuEma > 0 ? g.cpuEma * 0.9 + cpu * 0.1 : cpu;
      if (frame < g.pacingMin) g.pacingMin = frame;
      g.pacingFrames += 1;
    }
    const gpu = renderStats.gpuFrameMs;
    if (gpu > 0) g.gpuEma = g.gpuEma > 0 ? g.gpuEma * 0.9 + gpu * 0.1 : gpu;
    g.dustEma = g.dustEma > 0 ? g.dustEma * 0.9 + renderStats.gpuDustMs * 0.1 : renderStats.gpuDustMs;
    if (g.pacingFrames >= 120) {
      // Quantise to the refresh rates that exist, and keep the FASTEST period
      // ever seen: a window whose shortest frame is 12 ms is a loaded 120 Hz
      // display, not a 60 Hz one, and relaxing the budget on it mid-storm is
      // exactly backwards. Until anything fast has been seen, assume 60.
      let seen = 0;
      if (g.pacingMin < 9.5) seen = 8.33;
      else if (g.pacingMin < 17.5) seen = 16.67;
      if (seen > 0 && (g.period === 0 || seen < g.period)) g.period = seen;
      else if (g.period === 0) g.period = 16.67;
      g.pacingMin = Infinity;
      g.pacingFrames = 0;
    }
    const period = g.period || 8.33;
    renderStats.gpuBudgetMs = period;
    const gpuBound = g.frameEma - g.cpuEma > g.frameEma * 0.4;
    const overBudget = g.frameEma > period * 1.15 && gpuBound;
    const dustHeavy = g.gpuEma > 0 && g.dustEma > g.gpuEma * 0.35;

    // A rung on trial: undo it the moment the frame overruns, else let it stick.
    if (g.trial) {
      g.trial.framesLeft -= 1;
      if (overBudget) {
        g.trial.undo();
        g.trial = null;
        g.probeHoldFrames = Math.min(1800, g.probeHoldFrames * 2);
        g.heldFrames = 0;
        return;
      }
      if (g.trial.framesLeft <= 0) {
        g.trial = null;
        g.probeHoldFrames = 180;
        g.heldFrames = 0;
      }
      return;
    }

    g.sinceAdjust += 1;
    if (g.sinceAdjust < 20 || g.frameEma <= 0) return;
    g.sinceAdjust = 0;

    if (overBudget) {
      g.heldFrames = 0;
      const scale = governorSampleScale();
      const cap = governorFluidCap();
      if (dustHeavy && scale > 0.5) setGovernorSampleScale(0.5);
      else if (dustHeavy && cap === 'balanced') setGovernorFluidCap('fast');
      else if (dustHeavy && cap === 'fast') setGovernorFluidCap('off');
      else if (dustHeavy && scale > 0.25) setGovernorSampleScale(0.25);
      else if (scaleRef.current > 0.6) apply(Math.max(0.6, scaleRef.current * 0.92));
      return;
    }

    // Under budget (or CPU-bound, where pixels are free): probe a rung back.
    g.heldFrames += 20;
    if (g.heldFrames < g.probeHoldFrames) return;
    g.heldFrames = 0;
    const scale = governorSampleScale();
    const cap = governorFluidCap();
    const before = scaleRef.current;
    if (before < 1) {
      apply(Math.min(1, before * 1.08));
      g.trial = { undo: () => apply(before), framesLeft: 60 };
    } else if (scale < 0.5) {
      setGovernorSampleScale(0.5);
      g.trial = { undo: () => setGovernorSampleScale(0.25), framesLeft: 60 };
    } else if (cap === 'off') {
      setGovernorFluidCap('fast');
      g.trial = { undo: () => setGovernorFluidCap('off'), framesLeft: 60 };
    } else if (cap === 'fast') {
      setGovernorFluidCap('balanced');
      g.trial = { undo: () => setGovernorFluidCap('fast'), framesLeft: 60 };
    } else if (scale < 1) {
      setGovernorSampleScale(1);
      g.trial = { undo: () => setGovernorSampleScale(0.5), framesLeft: 60 };
    }
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
