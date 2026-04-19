import { useState, useCallback, useEffect, useMemo, useRef, type CSSProperties, type ReactNode } from 'react';
import { gameModeLabel, isPracticeMode, type GameMode } from './app/gameMode';
import { isTouchDevice } from './device';
import { buildMatchHref, resolveRequestedMatchId } from './app/matchId';
import type { PlayBenchmarkPageState, PlayWorkerResult } from './benchmark/contracts';
import {
  DEFAULT_INPUT_BINDINGS,
  loadInputBindings,
  resetAllInputBindings,
  saveInputBindings,
  type GamepadBindings,
  type InputBindings,
  type KeyboardBindings,
} from './input/bindings';
import { GameScene } from './scene/GameScene';
import type { CrosshairAimState } from './scene/aimTargeting';
import type { GuestHudMap } from './scene/PracticeGuestPlayer';
import { SplitScreenHud, type SplitScreenHudPlayer } from './scene/SplitScreenHud';
import type { DeviceFamily, InputFamilyMode, InputSample } from './input/types';
import { ControlHintsOverlay } from './ui/ControlHintsOverlay';
import { ControlsSettingsPanel } from './ui/ControlsSettingsPanel';
import { debugStatsToMarkdown, DebugOverlay, type DebugStats } from './ui/DebugOverlay';
import { EnergyBar } from './ui/EnergyBar';
import { MobileHUD } from './ui/MobileHUD';
import { useControlHints } from './ui/useControlHints';
import { useDebugStats } from './ui/useDebugStats';
import { normalizeScenario, type LoadTestScenario } from './loadtest/scenario';
import {
  createVehicleBenchmarkAccumulator,
  sampleVehicleBenchmarkAccumulator,
  type VehicleBenchmarkAccumulator,
} from './benchmark/vehicleAccumulator';
import { createBenchmarkWorldPreset } from './benchmark/worldPresets';
import { DEFAULT_WORLD_DOCUMENT, type WorldDocument } from './world/worldDocument';
import { CalibrationOverlay } from './calibration/CalibrationOverlay';
import { FirstRunPrompt } from './calibration/FirstRunPrompt';
import { CALIBRATION_WORLD_DOCUMENT } from './calibration/calibrationWorld';
import {
  getInputSettings,
  hasStoredInputSettings,
  updateInputSettings,
} from './input/inputSettingsStore';
import {
  PracticeBotRuntime,
  type PracticeBotBehaviorKind,
  type PracticeBotNavDebugConfig,
  type PracticeBotNavTuning,
  type PracticeBotStats,
} from './bots';
import { getSharedPlayerNavigationProfileAsync } from './wasm/sharedPhysics';
import { PracticeBotsPanel } from './ui/PracticeBotsPanel';
import { LocalPlayersPanel } from './ui/LocalPlayersPanel';
import {
  LOCAL_HUMAN_ID_BASE,
  defaultSlotZero,
  nextAvailableSlotId,
  pickDefaultDeviceForNewSlot,
  type LocalPlayerSlot,
} from './app/localPlayers';
import type { LocalDeviceAssignment } from './input/types';
import { updateE2EBridgeAppState } from './e2eBridge';

type AppProps = {
  mode: GameMode;
  worldDocument?: WorldDocument;
  overlay?: ReactNode;
  routeLabel?: string;
  autoConnect?: boolean;
  sessionKey?: number;
};

type BenchmarkConfig = {
  autopilot: boolean;
  autostart: boolean;
  clientIndex: number;
  clientLabel: string;
  scenario: LoadTestScenario;
  durationMs: number;
};

const DEFAULT_PRACTICE_BOT_NAV_TUNING: PracticeBotNavTuning = {
  walkableClimb: 0.35,
  walkableSlopeAngleDegrees: 45,
  cellHeight: 0.0275,
};

declare global {
  interface Window {
    __VIBE_PLAY_BENCHMARK_STATE__?: PlayBenchmarkPageState | null;
    __VIBE_PLAY_BENCHMARK_RESULT__?: PlayWorkerResult | null;
    __VIBE_GET_PLAY_BENCHMARK_RESULT__?: (() => PlayWorkerResult | null) | null;
  }
}

function parseClientIndex(value: string | null): number {
  const parsed = Number.parseInt(value ?? '0', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function parseBenchmarkScenario(raw: string | null, matchId: string): LoadTestScenario {
  if (!raw) {
    return normalizeScenario({
      name: `play-benchmark-${matchId}`,
      matchId,
      durationS: 30,
      botCount: 0,
      transportMix: { websocket: 0, webtransport: 0 },
      spawnPattern: 'clustered',
    });
  }
  try {
    return normalizeScenario({
      ...(JSON.parse(raw) as Partial<LoadTestScenario>),
      matchId,
    });
  } catch {
    return normalizeScenario({
      name: `play-benchmark-${matchId}`,
      matchId,
      durationS: 30,
      botCount: 0,
      transportMix: { websocket: 0, webtransport: 0 },
      spawnPattern: 'clustered',
    });
  }
}

export function App({
  mode,
  worldDocument = DEFAULT_WORLD_DOCUMENT,
  overlay,
  routeLabel,
  autoConnect = false,
  sessionKey = 0,
}: AppProps) {
  const practiceMode = isPracticeMode(mode);
  const modeLabel = gameModeLabel(mode);
  const multiplayerMatchId = resolveRequestedMatchId(window.location.search);
  const benchmarkConfig = useMemo<BenchmarkConfig | null>(() => {
    if (practiceMode) {
      return null;
    }
    const params = new URLSearchParams(window.location.search);
    if (params.get('benchmark') !== '1') {
      return null;
    }
    const clientIndex = parseClientIndex(params.get('clientIndex'));
    const clientLabel = params.get('clientLabel') ?? `play-${clientIndex + 1}`;
    const scenario = parseBenchmarkScenario(params.get('scenario'), multiplayerMatchId);
    return {
      autopilot: params.get('autopilot') === '1',
      autostart: params.get('autostart') === '1',
      clientIndex,
      clientLabel,
      scenario,
      durationMs: Math.max(1, scenario.durationS) * 1000,
    };
  }, [multiplayerMatchId, practiceMode]);
  const benchmarkAutopilot = useMemo(
    () => benchmarkConfig ? {
      enabled: benchmarkConfig.autopilot,
      clientIndex: benchmarkConfig.clientIndex,
      scenario: benchmarkConfig.scenario,
    } : undefined,
    [benchmarkConfig],
  );
  const effectiveAutoConnect = autoConnect || benchmarkConfig?.autostart === true;
  const pathLabel = routeLabel ?? (
    mode === 'multiplayer'
      ? buildMatchHref('/play', multiplayerMatchId)
      : '/practice'
  );
  const [connected, setConnected] = useState(effectiveAutoConnect);
  const [playerId, setPlayerId] = useState(0);
  const [status, setStatus] = useState(
    effectiveAutoConnect
      ? (practiceMode ? 'Starting firing range...' : 'Connecting...')
      : 'Click to join',
  );
  const [copyNotice, setCopyNotice] = useState('');
  const [crosshairState, setCrosshairState] = useState<CrosshairAimState>('idle');
  const [inputFamilyMode, setInputFamilyMode] = useState<InputFamilyMode>('auto');
  const [localPlayers, setLocalPlayers] = useState<LocalPlayerSlot[]>(() => [defaultSlotZero()]);
  const splitScreen = practiceMode && localPlayers.length > 1;
  const practiceGuests = useMemo(
    () => (practiceMode
      ? localPlayers
          .filter((slot) => slot.slotId !== 0)
          .map((slot) => ({
            slotId: slot.slotId,
            humanId: LOCAL_HUMAN_ID_BASE + slot.slotId,
            device: slot.device,
          }))
      : []),
    [practiceMode, localPlayers],
  );
  const handleAddLocalPlayer = useCallback(() => {
    setLocalPlayers((slots) => {
      if (slots.length >= 4) return slots;
      const nextId = nextAvailableSlotId(slots);
      if (nextId == null) return slots;
      const device = pickDefaultDeviceForNewSlot(slots);
      return [...slots, { slotId: nextId, simPlayerId: null, device }];
    });
  }, []);
  const handleRemoveLocalPlayer = useCallback((slotId: number) => {
    setLocalPlayers((slots) => slots.filter((slot) => slot.slotId !== slotId));
  }, []);
  const handleChangeLocalDevice = useCallback((slotId: number, device: LocalDeviceAssignment) => {
    setLocalPlayers((slots) => slots.map((slot) => (slot.slotId === slotId ? { ...slot, device } : slot)));
  }, []);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [localRenderSmoothingEnabled, setLocalRenderSmoothingEnabled] = useState(true);
  const [vehicleSmoothingEnabled, setVehicleSmoothingEnabled] = useState(false);
  const [inputBindings, setInputBindings] = useState<InputBindings>(() => loadInputBindings());
  const {
    visible: debugVisible,
    displayStats,
    updateFrame,
    recordSnapshot,
    getStatsSnapshot,
    getDeepCaptureMarkdown,
    deepCaptureEnabled,
    deepCaptureSampleCount,
    rapierDebugModeBits,
    rapierDebugLabel,
    cycleRapierDebugPreset,
  } = useDebugStats();
  const { displayState: controlHintsState, updateInputFrame, isDesktop } = useControlHints();
  const touchMode = isTouchDevice();
  const renderStatsParentRef = useRef<HTMLDivElement>(null);
  const copyNoticeTimerRef = useRef<number | null>(null);
  const benchmarkStartedAtRef = useRef<string | null>(null);
  const benchmarkDisconnectReasonRef = useRef<string | null>(null);
  const benchmarkResultRef = useRef<PlayWorkerResult | null>(null);
  const vehicleBenchmarkAccumulatorRef = useRef<VehicleBenchmarkAccumulator>(createVehicleBenchmarkAccumulator());
  const autoConnectAttemptedRef = useRef(false);
  const guestHudRef = useRef<GuestHudMap>(new Map());

  // Calibration wizard state (firing range only).
  const [calibrationOpen, setCalibrationOpen] = useState(false);
  const [firstRunPromptVisible, setFirstRunPromptVisible] = useState(false);
  const [calibrationActiveFamily, setCalibrationActiveFamily] = useState<DeviceFamily | null>(null);
  const [calibrationSceneExtras, setCalibrationSceneExtras] = useState<ReactNode>(null);
  const lastKnownFamilyRef = useRef<DeviceFamily | null>(null);
  // In practice mode, once the user has connected at least once, we auto-
  // reconnect after any disconnect (e.g. from swapping worlds when calibration
  // opens/closes). This avoids the player seeing "click to rejoin" mid-wizard.
  const hasEverConnectedRef = useRef(false);

  // While the wizard is open, render a deliberately-empty flat world so
  // drill targets aren't fighting terrain or props for visibility.
  const benchmarkWorldDocument = useMemo(
    () => benchmarkConfig?.scenario.playBenchmark?.worldPreset
      ? createBenchmarkWorldPreset(benchmarkConfig.scenario.playBenchmark.worldPreset, worldDocument)
      : worldDocument,
    [benchmarkConfig, worldDocument],
  );
  const effectiveWorldDocument = calibrationOpen ? CALIBRATION_WORLD_DOCUMENT : benchmarkWorldDocument;

  // E2E bridge: keep App-level state in sync for snapshot reads.
  useEffect(() => {
    updateE2EBridgeAppState({
      route: window.location.pathname,
      mode: practiceMode ? 'practice' : 'multiplayer',
      matchId: multiplayerMatchId,
      connected,
      statusText: status,
      playerId,
      debugOverlayVisible: debugVisible,
    });
  }, [practiceMode, multiplayerMatchId, connected, status, playerId, debugVisible]);

  const practiceBotRuntimeRef = useRef<PracticeBotRuntime | null>(null);
  const practiceBotWorldDocumentRef = useRef<WorldDocument | null>(null);
  const [practiceBotRuntime, setPracticeBotRuntime] = useState<PracticeBotRuntime | null>(null);
  const [practiceBotStats, setPracticeBotStats] = useState<PracticeBotStats | null>(null);
  const [practiceBotNavConfig, setPracticeBotNavConfig] = useState<PracticeBotNavDebugConfig | null>(null);
  const [practiceBotNavTuning, setPracticeBotNavTuning] = useState<PracticeBotNavTuning | null>(DEFAULT_PRACTICE_BOT_NAV_TUNING);
  const [practiceBotDesiredCount, setPracticeBotDesiredCount] = useState(0);
  const [practiceBotDesiredBehavior, setPracticeBotDesiredBehavior] = useState<PracticeBotBehaviorKind>('harass');
  const [practiceBotDesiredMaxSpeed, setPracticeBotDesiredMaxSpeed] = useState(3.0);
  const [practiceBotDebugOverlay, setPracticeBotDebugOverlay] = useState(false);
  const refreshPracticeBotStats = useCallback(() => {
    const runtime = practiceBotRuntimeRef.current;
    setPracticeBotStats(runtime ? runtime.stats() : null);
  }, []);
  const handleSetBotCount = useCallback((count: number) => {
    setPracticeBotDesiredCount(Math.max(0, Math.min(32, Math.floor(count))));
    const runtime = practiceBotRuntimeRef.current;
    if (!runtime) return;
    runtime.setBotCount(count);
    refreshPracticeBotStats();
  }, [refreshPracticeBotStats]);
  const handleClearBots = useCallback(() => {
    setPracticeBotDesiredCount(0);
    practiceBotRuntimeRef.current?.clear();
    refreshPracticeBotStats();
  }, [refreshPracticeBotStats]);
  const handleSetBotBehavior = useCallback((kind: PracticeBotBehaviorKind) => {
    setPracticeBotDesiredBehavior(kind);
    const runtime = practiceBotRuntimeRef.current;
    if (!runtime) return;
    runtime.setBehavior(kind);
    refreshPracticeBotStats();
  }, [refreshPracticeBotStats]);
  const handleSetBotMaxSpeed = useCallback((speed: number) => {
    setPracticeBotDesiredMaxSpeed(Math.max(0.5, Math.min(12, speed)));
    const runtime = practiceBotRuntimeRef.current;
    if (!runtime) return;
    runtime.setMaxSpeed(speed);
    refreshPracticeBotStats();
  }, [refreshPracticeBotStats]);
  const handleUpdateBotNavTuning = useCallback((patch: Partial<PracticeBotNavTuning>) => {
    setPracticeBotNavTuning((current) => {
      const base = current ?? (practiceBotNavConfig
        ? {
            walkableClimb: practiceBotNavConfig.walkableClimb,
            walkableSlopeAngleDegrees: practiceBotNavConfig.walkableSlopeAngleDegrees,
            cellHeight: practiceBotNavConfig.cellHeight,
          }
        : DEFAULT_PRACTICE_BOT_NAV_TUNING);
      return {
        ...base,
        ...patch,
      };
    });
  }, [practiceBotNavConfig]);
  const handleResetBotNavTuning = useCallback(() => {
    setPracticeBotNavTuning(null);
  }, []);
  const handleToggleBotDebugOverlay = useCallback((value: boolean) => {
    setPracticeBotDebugOverlay(value);
  }, []);
  const handleSetBotUseVehicles = useCallback((value: boolean) => {
    const runtime = practiceBotRuntimeRef.current;
    if (!runtime) return;
    runtime.setUseVehicles(value);
    refreshPracticeBotStats();
  }, [refreshPracticeBotStats]);

  useEffect(() => {
    if (!practiceMode) {
      const existing = practiceBotRuntimeRef.current;
      if (existing) {
        existing.clear();
        existing.detach();
      }
      practiceBotRuntimeRef.current = null;
      practiceBotWorldDocumentRef.current = null;
      setPracticeBotRuntime(null);
      setPracticeBotStats(null);
      setPracticeBotNavConfig(null);
      setPracticeBotDebugOverlay(false);
    }
  }, [practiceMode]);

  useEffect(() => () => {
    const existing = practiceBotRuntimeRef.current;
    if (existing) {
      existing.clear();
      existing.detach();
      practiceBotRuntimeRef.current = null;
    }
    practiceBotWorldDocumentRef.current = null;
  }, []);

  useEffect(() => {
    if (!practiceMode) return;
    let cancelled = false;
    const previousRuntime = practiceBotRuntimeRef.current;
    const preserveExistingBots =
      previousRuntime != null && practiceBotWorldDocumentRef.current === effectiveWorldDocument;
    const preservedBots = preserveExistingBots
      ? previousRuntime.captureBotSnapshots()
      : [];
    if (previousRuntime && !preserveExistingBots) {
      previousRuntime.clear();
      previousRuntime.detach();
      practiceBotRuntimeRef.current = null;
      practiceBotWorldDocumentRef.current = null;
      setPracticeBotRuntime(null);
      setPracticeBotStats(null);
      setPracticeBotNavConfig(null);
    }
    const desiredCount = practiceBotDesiredCount;
    const desiredBehavior = practiceBotDesiredBehavior;
    const desiredMaxSpeed = practiceBotDesiredMaxSpeed;
    const navTuning = practiceBotNavTuning;
    const handle = window.setTimeout(() => {
      void (async () => {
        try {
          const sharedProfile = await getSharedPlayerNavigationProfileAsync();
          const runtimeOptions = {
            maxAgentRadius: 0.6,
            navigationProfile: {
              ...sharedProfile,
              walkableClimb: navTuning?.walkableClimb ?? sharedProfile.walkableClimb,
              walkableSlopeAngleDegrees: navTuning?.walkableSlopeAngleDegrees ?? sharedProfile.walkableSlopeAngleDegrees,
            },
            cellHeight: navTuning?.cellHeight,
          };
          const runtime = await PracticeBotRuntime.create(effectiveWorldDocument, runtimeOptions);
          if (cancelled) {
            runtime.clear();
            runtime.detach();
            return;
          }
          runtime.setBehavior(desiredBehavior);
          runtime.setMaxSpeed(desiredMaxSpeed);
          if (preservedBots.length > 0) {
            runtime.restoreBotSnapshots(preservedBots);
          } else {
            runtime.setBotCount(desiredCount);
          }
          const staleRuntime = practiceBotRuntimeRef.current;
          if (staleRuntime && staleRuntime !== runtime) {
            if (preserveExistingBots && staleRuntime === previousRuntime) {
              staleRuntime.detach({ preserveHostBots: true });
            } else {
              staleRuntime.clear();
              staleRuntime.detach();
            }
          }
          practiceBotRuntimeRef.current = runtime;
          practiceBotWorldDocumentRef.current = effectiveWorldDocument;
          setPracticeBotRuntime(runtime);
          setPracticeBotStats(runtime.stats());
          const runtimeNavConfig = runtime.getNavDebugConfig();
          setPracticeBotNavConfig(runtimeNavConfig);
        } catch (error) {
          if (!cancelled) {
            console.error('Failed to initialize practice bots', error);
          }
        }
      })();
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [
    practiceMode,
    effectiveWorldDocument,
    practiceBotNavTuning,
  ]);

  useEffect(() => {
    saveInputBindings(inputBindings);
  }, [inputBindings]);

  const publishBenchmarkState = useCallback((
    modeValue: PlayBenchmarkPageState['mode'],
    overrideStatus?: string,
    result: PlayWorkerResult | null = benchmarkResultRef.current,
  ) => {
    if (!benchmarkConfig) {
      return;
    }
    const stats = getStatsSnapshot();
    window.__VIBE_PLAY_BENCHMARK_STATE__ = {
      mode: modeValue,
      status: overrideStatus ?? status,
      playerId,
      transport: stats.transport,
      disconnectReason: benchmarkDisconnectReasonRef.current,
      result,
    };
    window.__VIBE_PLAY_BENCHMARK_RESULT__ = result;
  }, [benchmarkConfig, getStatsSnapshot, playerId, status]);

  const buildBenchmarkResult = useCallback((
    disconnected: boolean,
    overrideReason?: string,
    finishedAt = new Date().toISOString(),
  ): PlayWorkerResult | null => {
    if (!benchmarkConfig) {
      return null;
    }
    const stats = getStatsSnapshot();
    const snapshotsReceived =
      stats.reliableSnapshotsReceived
      + stats.datagramSnapshotsReceived
      + stats.localSnapshotsReceived
      + stats.directSnapshotsReceived;
    if (benchmarkConfig.scenario.playBenchmark?.mode === 'vehicle_driver') {
      sampleVehicleBenchmarkAccumulator(vehicleBenchmarkAccumulatorRef.current, stats, performance.now());
    }
    const vehicleBenchmark = vehicleBenchmarkAccumulatorRef.current;
    const vehicleMetric = <K extends keyof VehicleBenchmarkAccumulator>(key: K, fallback: number): number => (
      vehicleBenchmark.samples > 0 ? Number(vehicleBenchmark[key]) : fallback
    );
    return {
      kind: 'play',
      clientLabel: benchmarkConfig.clientLabel,
      playBenchmarkMode: benchmarkConfig.scenario.playBenchmark?.mode ?? 'on_foot',
      playBenchmarkWorldPreset: benchmarkConfig.scenario.playBenchmark?.worldPreset ?? 'default',
      playBenchmarkDriverProfile: benchmarkConfig.scenario.playBenchmark?.driverProfile ?? 'mixed',
      transport: stats.transport,
      connected: playerId > 0,
      disconnected,
      startedAt: benchmarkStartedAtRef.current ?? finishedAt,
      finishedAt,
      snapshotsReceived,
      snapshotRate: stats.snapshotsPerSec,
      snapshotSource: stats.lastSnapshotSource,
      pendingInputsPeak5s: stats.pendingInputsPeak5s,
      playerCorrectionPeak5sM: stats.playerCorrectionPeak5sM,
      dynamicCorrectionPeak5sM: stats.dynamicCorrectionPeak5sM,
      vehicleBenchmarkSamples: vehicleBenchmark.samples,
      vehicleMaxSpeedMs: vehicleMetric('maxSpeedMs', Math.max(stats.vehicleLocalSpeedMs, stats.vehicleServerSpeedMs)),
      vehiclePendingInputs: vehicleMetric('vehiclePendingInputs', stats.vehiclePendingInputs),
      vehicleAckSeq: stats.vehicleAckSeq,
      vehicleLatestLocalSeq: stats.vehicleLatestLocalSeq,
      vehicleAckBacklogMs: vehicleMetric('vehicleAckBacklogMs', stats.vehicleAckBacklogMs),
      vehicleResendWindow: stats.vehicleResendWindow,
      vehicleCurrentAuthDeltaM: vehicleMetric('vehicleCurrentAuthDeltaM', stats.vehicleCurrentAuthDeltaM),
      vehicleMeshCurrentAuthDeltaM: vehicleMetric('vehicleMeshCurrentAuthDeltaM', stats.vehicleMeshCurrentAuthDeltaM),
      vehicleExpectedLeadM: stats.vehicleExpectedLeadM,
      vehicleCurrentAuthUnexplainedDeltaM: vehicleMetric('vehicleCurrentAuthUnexplainedDeltaM', stats.vehicleCurrentAuthUnexplainedDeltaM),
      vehicleRestJitterRms5sM: vehicleMetric('vehicleRestJitterRms5sM', stats.vehicleRestJitterRms5sM),
      vehicleStraightJitterRms5sM: vehicleMetric('vehicleStraightJitterRms5sM', stats.vehicleStraightJitterRms5sM),
      vehicleRawHeaveDeltaRms5sM: vehicleMetric('vehicleRawHeaveDeltaRms5sM', stats.vehicleRawHeaveDeltaRms5sM),
      vehicleRawPlanarDeltaRms5sM: vehicleMetric('vehicleRawPlanarDeltaRms5sM', stats.vehicleRawPlanarDeltaRms5sM),
      vehicleRawYawDeltaRms5sRad: vehicleMetric('vehicleRawYawDeltaRms5sRad', stats.vehicleRawYawDeltaRms5sRad),
      vehicleRawPitchDeltaRms5sRad: vehicleMetric('vehicleRawPitchDeltaRms5sRad', stats.vehicleRawPitchDeltaRms5sRad),
      vehicleRawRollDeltaRms5sRad: vehicleMetric('vehicleRawRollDeltaRms5sRad', stats.vehicleRawRollDeltaRms5sRad),
      vehicleResidualPlanarDeltaRms5sM: vehicleMetric('vehicleResidualPlanarDeltaRms5sM', stats.vehicleResidualPlanarDeltaRms5sM),
      vehicleResidualHeaveDeltaRms5sM: vehicleMetric('vehicleResidualHeaveDeltaRms5sM', stats.vehicleResidualHeaveDeltaRms5sM),
      vehicleResidualYawDeltaRms5sRad: vehicleMetric('vehicleResidualYawDeltaRms5sRad', stats.vehicleResidualYawDeltaRms5sRad),
      vehicleWheelContactBitChanges5s: vehicleMetric('vehicleWheelContactBitChanges5s', stats.vehicleWheelContactBitChanges5s),
      vehicleGroundedTransitions5s: vehicleMetric('vehicleGroundedTransitions5s', stats.vehicleGroundedTransitions5s),
      vehicleSuspensionLengthDeltaRms5sM: vehicleMetric('vehicleSuspensionLengthDeltaRms5sM', stats.vehicleSuspensionLengthDeltaRms5sM),
      vehicleSuspensionForceDeltaRms5sN: vehicleMetric('vehicleSuspensionForceDeltaRms5sN', stats.vehicleSuspensionForceDeltaRms5sN),
      vehicleSuspensionLengthSpreadPeak5sM: vehicleMetric('vehicleSuspensionLengthSpreadPeak5sM', stats.vehicleSuspensionLengthSpreadPeak5sM),
      vehicleSuspensionForceSpreadPeak5sN: vehicleMetric('vehicleSuspensionForceSpreadPeak5sN', stats.vehicleSuspensionForceSpreadPeak5sN),
      vehicleWheelContactNormalDeltaRms5sRad: vehicleMetric('vehicleWheelContactNormalDeltaRms5sRad', stats.vehicleWheelContactNormalDeltaRms5sRad),
      vehicleWheelGroundObjectSwitches5s: vehicleMetric('vehicleWheelGroundObjectSwitches5s', stats.vehicleWheelGroundObjectSwitches5s),
      vehicleMeshFrameDeltaRms5sM: vehicleMetric('vehicleMeshFrameDeltaRms5sM', stats.vehicleMeshFrameDeltaRms5sM),
      vehicleCameraFrameDeltaRms5sM: vehicleMetric('vehicleCameraFrameDeltaRms5sM', stats.vehicleCameraFrameDeltaRms5sM),
      vehiclePredictedAuthDeltaRms5sM: vehicleMetric('vehiclePredictedAuthDeltaRms5sM', stats.vehiclePredictedAuthDeltaRms5sM),
      vehiclePredictedAuthDeltaPeak5sM: vehicleMetric('vehiclePredictedAuthDeltaPeak5sM', stats.vehiclePredictedAuthDeltaPeak5sM),
      shotsFired: stats.shotsFired,
      disconnectReason: overrideReason ?? benchmarkDisconnectReasonRef.current,
    };
  }, [benchmarkConfig, getStatsSnapshot, playerId]);

  const finalizeBenchmark = useCallback((modeValue: 'completed' | 'failed', overrideReason?: string) => {
    if (!benchmarkConfig || benchmarkResultRef.current) {
      return;
    }
    const result = buildBenchmarkResult(modeValue === 'failed', overrideReason);
    if (!result) {
      return;
    }
    benchmarkResultRef.current = result;
    publishBenchmarkState(modeValue, overrideReason ?? status, result);
  }, [benchmarkConfig, buildBenchmarkResult, publishBenchmarkState, status]);

  const updateKeyboardBinding = useCallback(<K extends keyof KeyboardBindings>(key: K, value: KeyboardBindings[K]) => {
    setInputBindings((current) => ({
      ...current,
      keyboard: {
        ...current.keyboard,
        [key]: value,
      },
    }));
  }, []);

  const updateGamepadBinding = useCallback(<K extends keyof GamepadBindings>(key: K, value: GamepadBindings[K]) => {
    setInputBindings((current) => ({
      ...current,
      gamepad: {
        ...current.gamepad,
        [key]: value,
      },
    }));
  }, []);

  const resetKeyboardBinding = useCallback((key: keyof KeyboardBindings) => {
    updateKeyboardBinding(key, DEFAULT_INPUT_BINDINGS.keyboard[key]);
  }, [updateKeyboardBinding]);

  const resetGamepadBinding = useCallback((key: keyof GamepadBindings) => {
    updateGamepadBinding(key, DEFAULT_INPUT_BINDINGS.gamepad[key]);
  }, [updateGamepadBinding]);

  const resetBindings = useCallback(() => {
    setInputBindings(resetAllInputBindings());
  }, []);

  const handleInputFrame = useCallback((sample: InputSample) => {
    updateInputFrame(sample);
    if (sample.activeFamily && sample.activeFamily !== lastKnownFamilyRef.current) {
      lastKnownFamilyRef.current = sample.activeFamily;
    }
  }, [updateInputFrame]);

  // First-run prompt: show it only in practice mode, only once per user, and
  // only when no stored input settings exist yet.
  useEffect(() => {
    if (!practiceMode) return;
    const stored = hasStoredInputSettings();
    const settings = getInputSettings();
    if (!stored && !settings.meta.firstRunPromptDismissed) {
      setFirstRunPromptVisible(true);
    }
  }, [practiceMode]);

  const openCalibration = useCallback(() => {
    setFirstRunPromptVisible(false);
    // Snapshot the active family at the moment the wizard opens. If we don't
    // have a known family yet (e.g. player just loaded the page), default to
    // keyboardMouse — the input arbiter will update it if they use a gamepad
    // first.
    setCalibrationActiveFamily(lastKnownFamilyRef.current ?? 'keyboardMouse');
    setCalibrationOpen(true);
  }, []);

  const dismissFirstRunPrompt = useCallback(() => {
    setFirstRunPromptVisible(false);
    updateInputSettings((draft) => {
      draft.meta.firstRunPromptDismissed = true;
      return draft;
    });
  }, []);

  const closeCalibration = useCallback(() => {
    setCalibrationOpen(false);
    setCalibrationSceneExtras(null);
  }, []);

  const handleConnect = useCallback(() => {
    setConnected(true);
    setCrosshairState('idle');
    setStatus(practiceMode ? 'Starting firing range...' : 'Connecting...');
    if (benchmarkConfig) {
      benchmarkStartedAtRef.current = null;
      benchmarkDisconnectReasonRef.current = null;
      benchmarkResultRef.current = null;
      vehicleBenchmarkAccumulatorRef.current = createVehicleBenchmarkAccumulator();
      publishBenchmarkState('running', practiceMode ? 'Starting firing range...' : 'Connecting...', null);
    }
  }, [benchmarkConfig, practiceMode, publishBenchmarkState]);

  const handleWelcome = useCallback((id: number) => {
    setPlayerId(id);
    hasEverConnectedRef.current = true;
    const touchHint = 'Touch: left thumb moves (push past ring to sprint), right thumb swipes look, tap FIRE/JUMP/RUN';
    const desktopHint = 'controls are configurable from the Controls panel';
    setStatus(`${practiceMode ? modeLabel : `Player #${id}`} — ${touchMode ? touchHint : desktopHint}`);
    if (benchmarkConfig && benchmarkStartedAtRef.current == null) {
      benchmarkStartedAtRef.current = new Date().toISOString();
      publishBenchmarkState('running');
    }
  }, [benchmarkConfig, modeLabel, practiceMode, publishBenchmarkState, touchMode]);

  const handleDisconnect = useCallback((reason?: string) => {
    setStatus(`${practiceMode ? `${modeLabel} stopped` : 'Disconnected'} — click to rejoin`);
    setConnected(false);
    setPlayerId(0);
    setCrosshairState('idle');
    if (benchmarkConfig) {
      benchmarkDisconnectReasonRef.current = reason ?? 'connection closed';
      finalizeBenchmark('failed', benchmarkDisconnectReasonRef.current);
    }
  }, [benchmarkConfig, finalizeBenchmark, modeLabel, practiceMode]);

  useEffect(() => {
    if (!effectiveAutoConnect || connected || autoConnectAttemptedRef.current) {
      return;
    }
    autoConnectAttemptedRef.current = true;
    handleConnect();
  }, [connected, effectiveAutoConnect, handleConnect]);

  // Auto-reconnect in practice mode after a disconnect that was triggered by
  // swapping the world document (calibration open/close). Without this the
  // player would have to click "rejoin" every time the wizard toggled.
  useEffect(() => {
    if (!practiceMode || connected) return;
    if (!hasEverConnectedRef.current) return;
    handleConnect();
  }, [practiceMode, connected, handleConnect]);

  useEffect(() => {
    if (!connected || sessionKey === 0) {
      return;
    }
    setCrosshairState('idle');
    setStatus(practiceMode ? 'Starting firing range...' : 'Connecting...');
  }, [connected, practiceMode, sessionKey]);

  useEffect(() => {
    if (!benchmarkConfig) {
      return;
    }
    publishBenchmarkState('idle', status, null);
    const intervalId = window.setInterval(() => {
      if (benchmarkConfig.scenario.playBenchmark?.mode === 'vehicle_driver' && !benchmarkResultRef.current) {
        sampleVehicleBenchmarkAccumulator(vehicleBenchmarkAccumulatorRef.current, getStatsSnapshot(), performance.now());
      }
      if (benchmarkResultRef.current) {
        publishBenchmarkState(
          benchmarkResultRef.current.disconnected ? 'failed' : 'completed',
          status,
          benchmarkResultRef.current,
        );
      } else if (benchmarkStartedAtRef.current) {
        publishBenchmarkState('running');
      } else {
        publishBenchmarkState('idle');
      }
    }, 250);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [benchmarkConfig, getStatsSnapshot, publishBenchmarkState, status]);

  useEffect(() => {
    if (!benchmarkConfig) {
      return;
    }
    window.__VIBE_GET_PLAY_BENCHMARK_RESULT__ = () => (
      benchmarkResultRef.current
      ?? buildBenchmarkResult(
        Boolean(benchmarkDisconnectReasonRef.current),
        benchmarkDisconnectReasonRef.current ?? undefined,
      )
    );
    return () => {
      window.__VIBE_PLAY_BENCHMARK_STATE__ = null;
      window.__VIBE_PLAY_BENCHMARK_RESULT__ = null;
      window.__VIBE_GET_PLAY_BENCHMARK_RESULT__ = null;
    };
  }, [benchmarkConfig, buildBenchmarkResult]);

  useEffect(() => {
    if (!benchmarkConfig || playerId === 0 || benchmarkResultRef.current) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      finalizeBenchmark('completed');
    }, benchmarkConfig.durationMs);
    return () => window.clearTimeout(timeoutId);
  }, [benchmarkConfig, finalizeBenchmark, playerId]);

  useEffect(() => {
    const setTimedCopyNotice = (message: string) => {
      setCopyNotice(message);
      if (copyNoticeTimerRef.current != null) {
        window.clearTimeout(copyNoticeTimerRef.current);
      }
      copyNoticeTimerRef.current = window.setTimeout(() => {
        setCopyNotice('');
        copyNoticeTimerRef.current = null;
      }, 2000);
    };

    const handleCopyDebug = async () => {
      const markdown = debugStatsToMarkdown(getStatsSnapshot(), {
        connected,
        status,
        path: window.location.pathname,
        userAgent: navigator.userAgent,
        renderStatsText: renderStatsParentRef.current?.innerText ?? '',
        localRenderSmoothingEnabled,
        vehicleSmoothingEnabled,
        deepCaptureEnabled,
        deepCaptureReport: getDeepCaptureMarkdown(),
      });
      try {
        await navigator.clipboard.writeText(markdown);
        setTimedCopyNotice('Copied debug markdown');
      } catch {
        setTimedCopyNotice('Clipboard copy failed');
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const isMac = navigator.platform.includes('Mac');
      const modPressed = isMac ? event.metaKey : event.ctrlKey;
      const wantsCopyDebug =
        event.code === 'F4'
        || (modPressed && event.shiftKey && event.code === 'KeyD');
      if (!wantsCopyDebug) return;
      event.preventDefault();
      void handleCopyDebug();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      if (copyNoticeTimerRef.current != null) {
        window.clearTimeout(copyNoticeTimerRef.current);
      }
    };
  }, [connected, deepCaptureEnabled, getDeepCaptureMarkdown, getStatsSnapshot, localRenderSmoothingEnabled, status, vehicleSmoothingEnabled]);

  const crosshairColor =
    crosshairState === 'head'
      ? 'rgba(255, 36, 36, 0.98)'
      : crosshairState === 'body'
        ? 'rgba(255, 92, 92, 0.96)'
        : 'rgba(255, 255, 255, 0.9)';
  const crosshairGlow =
    crosshairState === 'idle'
      ? 'rgba(255, 255, 255, 0.18)'
      : crosshairState === 'head'
        ? 'rgba(255, 48, 48, 0.55)'
        : 'rgba(255, 96, 96, 0.45)';

  // Suppress the click-to-join overlay during auto-reconnect transitions in
  // practice mode so the player doesn't see it flash when the calibration
  // wizard opens or closes (which triggers a brief disconnect + reconnect).
  const clickToJoinVisible = !connected && !(practiceMode && hasEverConnectedRef.current);

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      {clickToJoinVisible && (
        <div
          data-testid="join-overlay"
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 10,
            background: 'rgba(0,0,0,0.8)',
            cursor: 'pointer',
          }}
          onClick={handleConnect}
        >
          <div style={{ textAlign: 'center' }}>
            <h1 style={{ fontSize: 48, marginBottom: 16, fontWeight: 700 }}>vibe-land</h1>
            <p style={{ fontSize: 14, opacity: 0.5, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.18em' }}>
              {pathLabel}
            </p>
            <p style={{ fontSize: 20, opacity: 0.7 }}>
              {practiceMode ? 'Click anywhere to launch the firing range' : 'Click anywhere to join multiplayer'}
            </p>
          </div>
        </div>
      )}
      <div
        data-testid="status-banner"
        style={{
          position: 'absolute',
          top: 8,
          left: 8,
          zIndex: 5,
          background: 'rgba(0,0,0,0.6)',
          padding: '4px 12px',
          borderRadius: 4,
          fontSize: 14,
          pointerEvents: 'none',
        }}
      >
        {status}
      </div>
      <div
        style={{
          position: 'absolute',
          top: 8,
          right: 8,
          zIndex: 12,
          display: 'flex',
          gap: 8,
        }}
      >
        <a href="/" style={navLinkStyle}>
          Home
        </a>
        <a href={practiceMode ? buildMatchHref('/play', multiplayerMatchId) : '/practice'} style={navLinkStyle}>
          {practiceMode ? 'Multiplayer' : 'Firing range'}
        </a>
        <button type="button" onClick={() => setControlsOpen(true)} style={navButtonStyle}>
          Controls
        </button>
        {practiceMode && connected && !splitScreen && (
          <button
            type="button"
            onClick={openCalibration}
            style={calibrateButtonStyle}
          >
            Calibrate
          </button>
        )}
      </div>
      {overlay}
      {copyNotice && (
        <div
          style={{
            position: 'absolute',
            top: 44,
            left: 8,
            zIndex: 6,
            background: 'rgba(0,0,0,0.72)',
            padding: '4px 10px',
            borderRadius: 4,
            fontSize: 13,
            color: '#9ef79e',
            pointerEvents: 'none',
          }}
        >
          {copyNotice}
        </div>
      )}
      {connected && !splitScreen && (
        <div
          style={{
            position: 'absolute',
            left: '50%',
            top: '50%',
            width: 18,
            height: 18,
            transform: 'translate(-50%, -50%)',
            pointerEvents: 'none',
            zIndex: 6,
            filter: `drop-shadow(0 0 6px ${crosshairGlow})`,
          }}
        >
          <div
            style={{
              position: 'absolute',
              left: '50%',
              top: 0,
              width: 2,
              height: '100%',
              transform: 'translateX(-50%)',
              background: crosshairColor,
            }}
          />
          <div
            style={{
              position: 'absolute',
              top: '50%',
              left: 0,
              width: '100%',
              height: 2,
              transform: 'translateY(-50%)',
              background: crosshairColor,
            }}
          />
        </div>
      )}
      <ControlHintsOverlay
        bindings={inputBindings}
        state={controlHintsState}
        visible={connected && isDesktop && !touchMode && !splitScreen}
        inputFamilyMode={inputFamilyMode}
        onInputFamilyModeChange={setInputFamilyMode}
      />
      {connected && touchMode && <MobileHUD />}
      <ControlsSettingsPanel
        open={controlsOpen}
        bindings={inputBindings}
        inputFamilyMode={inputFamilyMode}
        hideFamilyToggle={splitScreen}
        onClose={() => setControlsOpen(false)}
        onInputFamilyModeChange={setInputFamilyMode}
        onKeyboardBindingChange={updateKeyboardBinding}
        onGamepadBindingChange={updateGamepadBinding}
        onKeyboardBindingReset={resetKeyboardBinding}
        onGamepadBindingReset={resetGamepadBinding}
        onResetAll={resetBindings}
      />
      {practiceMode && (
        <FirstRunPrompt
          visible={firstRunPromptVisible && connected}
          onStart={openCalibration}
          onDismiss={dismissFirstRunPrompt}
        />
      )}
      {practiceMode && (
        <CalibrationOverlay
          visible={calibrationOpen}
          activeFamily={calibrationActiveFamily}
          onRequestClose={closeCalibration}
          onRenderSceneExtras={setCalibrationSceneExtras}
        />
      )}
      <LocalPlayersPanel
        visible={practiceMode && connected && !calibrationOpen}
        slots={localPlayers}
        onAddSlot={handleAddLocalPlayer}
        onRemoveSlot={handleRemoveLocalPlayer}
        onChangeDevice={handleChangeLocalDevice}
      />
      <PracticeBotsPanel
        visible={practiceMode && connected && !calibrationOpen}
        stats={practiceBotStats}
        runtime={practiceBotRuntime}
        navConfig={practiceBotNavConfig}
        navTuning={practiceBotNavTuning}
        debugOverlay={practiceBotDebugOverlay}
        onSetBotCount={handleSetBotCount}
        onClear={handleClearBots}
        onSetBehavior={handleSetBotBehavior}
        onSetMaxSpeed={handleSetBotMaxSpeed}
        onUpdateNavTuning={handleUpdateBotNavTuning}
        onResetNavTuning={handleResetBotNavTuning}
        onToggleDebugOverlay={handleToggleBotDebugOverlay}
        onSetUseVehicles={handleSetBotUseVehicles}
      />
      <EnergyBar
        hp={displayStats.hp}
        energy={displayStats.energy}
        visible={connected && !splitScreen}
      />
      {splitScreen && (() => {
        const hudPlayers: SplitScreenHudPlayer[] = localPlayers.map((slot) => (
          slot.slotId === 0
            ? { slotId: 0, humanId: null, label: 'P1' }
            : {
                slotId: slot.slotId,
                humanId: LOCAL_HUMAN_ID_BASE + slot.slotId,
                label: `P${slot.slotId + 1}`,
              }
        ));
        return (
          <SplitScreenHud
            players={hudPlayers}
            primaryHp={displayStats.hp}
            primaryEnergy={displayStats.energy}
            primaryVisible={connected}
            crosshairState={crosshairState}
            guestHudRef={guestHudRef}
          />
        );
      })()}
      <DebugOverlay
        stats={displayStats}
        visible={debugVisible}
        localRenderSmoothingEnabled={localRenderSmoothingEnabled}
        onToggleLocalRenderSmoothing={() => setLocalRenderSmoothingEnabled((enabled) => !enabled)}
        vehicleSmoothingEnabled={vehicleSmoothingEnabled}
        onToggleVehicleSmoothing={() => setVehicleSmoothingEnabled((enabled) => !enabled)}
        rapierDebugLabel={rapierDebugLabel}
        onCycleRapierDebugPreset={() => cycleRapierDebugPreset(false)}
        deepCaptureEnabled={deepCaptureEnabled}
        deepCaptureSampleCount={deepCaptureSampleCount}
      />
      {debugVisible && (
        <div
          ref={renderStatsParentRef}
          style={{
            position: 'absolute',
            right: 8,
            bottom: 8,
            zIndex: 20,
          }}
        />
      )}
      {connected && (
        <GameScene
          key={sessionKey}
          mode={mode}
          worldDocument={effectiveWorldDocument}
          onWelcome={handleWelcome}
          onDisconnect={handleDisconnect}
          onAimStateChange={setCrosshairState}
          playerId={playerId}
          onDebugFrame={updateFrame}
          onInputFrame={handleInputFrame}
          inputFamilyMode={inputFamilyMode}
          inputBindings={inputBindings}
          onSnapshot={recordSnapshot}
          rapierDebugModeBits={rapierDebugModeBits}
          renderStatsParent={renderStatsParentRef}
          showRenderStats={debugVisible}
          showDebugHelpers={debugVisible}
          benchmarkAutopilot={benchmarkAutopilot}
          practiceBots={practiceMode ? practiceBotRuntime : null}
          practiceBotsDebugOverlay={practiceMode && practiceBotDebugOverlay}
          localRenderSmoothingEnabled={localRenderSmoothingEnabled}
          vehicleSmoothingEnabled={vehicleSmoothingEnabled}
          sceneExtras={calibrationSceneExtras}
          practiceGuests={practiceGuests}
          guestHudRef={guestHudRef}
        />
      )}
    </div>
  );
}

const navLinkStyle: CSSProperties = {
  background: 'rgba(0,0,0,0.6)',
  color: '#fff',
  textDecoration: 'none',
  padding: '6px 10px',
  borderRadius: 4,
  fontSize: 13,
};

const navButtonStyle: CSSProperties = {
  ...navLinkStyle,
  border: 'none',
  cursor: 'pointer',
};

const calibrateButtonStyle: CSSProperties = {
  background: 'rgba(149, 233, 255, 0.22)',
  border: '1px solid rgba(149, 233, 255, 0.45)',
  color: '#edf6ff',
  padding: '6px 12px',
  borderRadius: 999,
  fontSize: 13,
  cursor: 'pointer',
  fontWeight: 600,
};
