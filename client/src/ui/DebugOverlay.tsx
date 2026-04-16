export type DebugStats = {
  // Rendering
  fps: number;
  frameTimeMs: number;
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;

  // Network
  transport: string;
  pingMs: number;
  serverTick: number;
  interpolationDelayMs: number;
  dynamicBodyInterpolationDelayMs: number;
  clockOffsetUs: number;
  remotePlayers: number;
  snapshotsPerSec: number;
  jitterMs: number;
  lastSnapshotGapMs: number;
  snapshotGapP95Ms: number;
  snapshotGapMaxMs: number;
  lastSnapshotSource: string;
  staleSnapshotsDropped: number;
  reliableSnapshotsReceived: number;
  datagramSnapshotsReceived: number;
  localSnapshotsReceived: number;
  directSnapshotsReceived: number;
  rapierDebugLabel: string;
  rapierDebugModeBits: number;

  // Physics / Prediction
  pendingInputs: number;
  predictionTicks: number;
  playerCorrectionMagnitude: number;
  vehicleCorrectionMagnitude: number;
  dynamicGlobalMaxCorrectionMagnitude: number;
  dynamicNearPlayerMaxCorrectionMagnitude: number;
  dynamicInteractiveMaxCorrectionMagnitude: number;
  dynamicOverThresholdCount: number;
  dynamicTrackedBodies: number;
  dynamicInteractiveBodies: number;
  lastDynamicShotBodyId: number;
  lastDynamicShotAgeMs: number;
  lastShotPredictedBodyId: number;
  lastShotProxyHitBodyId: number;
  lastShotProxyHitToi: number;
  lastShotBlockedByBlocker: boolean;
  lastShotLocalPredictedDeltaM: number;
  lastShotDynamicSampleAgeMs: number;
  lastShotPredictedBodyRecentInteraction: boolean;
  lastShotBlockerDistance: number;
  lastShotRenderedBodyId: number;
  lastShotRenderedBodyToi: number;
  lastShotRenderProxyDeltaM: number;
  lastShotRenderedBodyProxyPresent: boolean;
  lastShotRenderedBodyProxyToi: number;
  lastShotRenderedBodyProxyCenterDeltaM: number;
  lastShotNearestProxyBodyId: number;
  lastShotNearestProxyBodyToi: number;
  lastShotNearestProxyBodyMissDistanceM: number;
  lastShotNearestProxyBodyRadiusM: number;
  lastShotNearestRenderedBodyId: number;
  lastShotNearestRenderedBodyToi: number;
  lastShotNearestRenderedBodyMissDistanceM: number;
  lastShotNearestRenderedBodyRadiusM: number;
  lastShotServerResolution: number;
  lastShotServerDynamicBodyId: number;
  lastShotServerDynamicHitToiM: number;
  lastShotServerDynamicImpulseMag: number;
  playerCorrectionPeak5sM: number;
  vehicleCorrectionPeak5sM: number;
  dynamicCorrectionPeak5sM: number;
  pendingInputsPeak5s: number;
  vehiclePendingInputs: number;
  vehicleAckSeq: number;
  vehicleLatestLocalSeq: number;
  vehiclePendingInputsAgeMs: number;
  vehicleAckBacklogMs: number;
  vehicleResendWindow: number;
  vehicleReplayErrorM: number;
  vehiclePosErrorM: number;
  vehicleVelErrorMs: number;
  vehicleRotErrorRad: number;
  vehicleCorrectionAgeMs: number;
  physicsStepMs: number;
  shotsFired: number;
  shotsPending: number;
  shotAuthoritativeMoves: number;
  shotMismatches: number;
  lastShotOutcome: string;
  lastShotOutcomeAgeMs: number;
  recentEvents: string[];

  // Local vehicle debug
  vehicleDebugId: number;
  vehicleDriverConfirmed: boolean;
  vehicleLocalSpeedMs: number;
  vehicleServerSpeedMs: number;
  vehiclePosDeltaM: number;
  vehicleGroundedWheels: number;
  vehicleSteering: number;
  vehicleEngineForce: number;
  vehicleBrake: number;
  vehicleMeshDeltaM: number;
  vehicleMeshRotDeltaRad: number;
  vehiclePredictedFrameDeltaM: number;
  vehiclePredictedPlanarDeltaM: number;
  vehiclePredictedHeaveDeltaM: number;
  vehiclePredictedYawDeltaRad: number;
  vehiclePredictedPitchDeltaRad: number;
  vehiclePredictedRollDeltaRad: number;
  vehiclePredictedResidualDeltaM: number;
  vehiclePredictedResidualPlanarDeltaM: number;
  vehiclePredictedResidualHeaveDeltaM: number;
  vehiclePredictedResidualYawDeltaRad: number;
  vehiclePredictedResidualPitchDeltaRad: number;
  vehiclePredictedResidualRollDeltaRad: number;
  vehicleMeshFrameDeltaM: number;
  vehicleMeshFrameRotDeltaRad: number;
  vehicleCameraFrameDeltaM: number;
  vehicleCameraFrameRotDeltaRad: number;
  vehicleMeshDeltaRms5sM: number;
  vehicleMeshDeltaPeak5sM: number;
  vehicleRestJitterRms5sM: number;
  vehicleStraightJitterRms5sM: number;
  vehicleRawHeaveDeltaRms5sM: number;
  vehicleRawHeaveDeltaPeak5sM: number;
  vehicleRawPlanarDeltaRms5sM: number;
  vehicleRawPlanarDeltaPeak5sM: number;
  vehicleRawYawDeltaRms5sRad: number;
  vehicleRawYawDeltaPeak5sRad: number;
  vehicleRawPitchDeltaRms5sRad: number;
  vehicleRawPitchDeltaPeak5sRad: number;
  vehicleRawRollDeltaRms5sRad: number;
  vehicleRawRollDeltaPeak5sRad: number;
  vehicleResidualDeltaRms5sM: number;
  vehicleResidualDeltaPeak5sM: number;
  vehicleResidualPlanarDeltaRms5sM: number;
  vehicleResidualPlanarDeltaPeak5sM: number;
  vehicleResidualHeaveDeltaRms5sM: number;
  vehicleResidualHeaveDeltaPeak5sM: number;
  vehicleResidualYawDeltaRms5sRad: number;
  vehicleResidualYawDeltaPeak5sRad: number;
  vehicleResidualPitchDeltaRms5sRad: number;
  vehicleResidualPitchDeltaPeak5sRad: number;
  vehicleResidualRollDeltaRms5sRad: number;
  vehicleResidualRollDeltaPeak5sRad: number;
  vehicleRawRestHeaveDeltaRms5sM: number;
  vehicleRawStraightHeaveDeltaRms5sM: number;
  vehicleWheelContactBits: number;
  vehicleWheelContactBitChanges5s: number;
  vehicleWheelContactNormals: Array<[number, number, number]>;
  vehicleWheelContactNormalDeltaRms5sRad: number;
  vehicleWheelGroundObjectIds: [number, number, number, number];
  vehicleWheelGroundObjectSwitches5s: number;
  vehicleSuspensionLengths: [number, number, number, number];
  vehicleSuspensionForces: [number, number, number, number];
  vehicleSuspensionRelativeVelocities: [number, number, number, number];
  vehicleSuspensionLengthSpreadM: number;
  vehicleSuspensionLengthSpreadPeak5sM: number;
  vehicleSuspensionLengthDeltaRms5sM: number;
  vehicleSuspensionForceSpreadN: number;
  vehicleSuspensionForceSpreadPeak5sN: number;
  vehicleSuspensionForceDeltaRms5sN: number;
  vehicleMeshFrameDeltaRms5sM: number;
  vehicleMeshFrameDeltaPeak5sM: number;
  vehicleMeshFrameRotDeltaRms5sRad: number;
  vehicleMeshFrameRotDeltaPeak5sRad: number;
  vehicleCameraFrameDeltaRms5sM: number;
  vehicleCameraFrameDeltaPeak5sM: number;
  vehicleCameraFrameRotDeltaRms5sRad: number;
  vehicleCameraFrameRotDeltaPeak5sRad: number;
  vehicleGroundedTransitions5s: number;
  vehicleGroundedMin5s: number;
  vehicleGroundedMax5s: number;
  vehicleLatestAuthDeltaM: number;
  vehicleSampledAuthDeltaM: number;
  vehicleMeshAuthDeltaM: number;
  vehicleLatestVsSampledAuthDeltaM: number;
  vehicleCurrentAuthDeltaM: number;
  vehicleMeshCurrentAuthDeltaM: number;
  vehicleExpectedLeadM: number;
  vehicleCurrentAuthUnexplainedDeltaM: number;
  vehicleCurrentAuthPlanarDeltaM: number;
  vehicleCurrentAuthVerticalDeltaM: number;
  vehicleAuthObservedAgeMs: number;
  vehicleAuthSampleOffsetMs: number;
  vehicleAuthSampleServerDeltaMs: number;
  vehicleAuthCurrentOffsetMs: number;
  vehiclePredictedAuthDeltaRms5sM: number;
  vehiclePredictedAuthDeltaPeak5sM: number;

  // Player
  playerId: number;
  position: [number, number, number];
  velocity: [number, number, number];
  speedMs: number;
  hp: number;
  onGround: boolean;
  inVehicle: boolean;
  dead: boolean;

  // System
  heapUsedMb: number;
  heapTotalMb: number;
};

export const DEFAULT_STATS: DebugStats = {
  fps: 0,
  frameTimeMs: 0,
  drawCalls: 0,
  triangles: 0,
  geometries: 0,
  textures: 0,
  transport: 'connecting',
  pingMs: 0,
  serverTick: 0,
  interpolationDelayMs: 0,
  dynamicBodyInterpolationDelayMs: 0,
  clockOffsetUs: 0,
  remotePlayers: 0,
  snapshotsPerSec: 0,
  jitterMs: 0,
  lastSnapshotGapMs: 0,
  snapshotGapP95Ms: 0,
  snapshotGapMaxMs: 0,
  lastSnapshotSource: 'none',
  staleSnapshotsDropped: 0,
  reliableSnapshotsReceived: 0,
  datagramSnapshotsReceived: 0,
  localSnapshotsReceived: 0,
  directSnapshotsReceived: 0,
  rapierDebugLabel: 'off',
  rapierDebugModeBits: 0,
  pendingInputs: 0,
  predictionTicks: 0,
  playerCorrectionMagnitude: 0,
  vehicleCorrectionMagnitude: 0,
  dynamicGlobalMaxCorrectionMagnitude: 0,
  dynamicNearPlayerMaxCorrectionMagnitude: 0,
  dynamicInteractiveMaxCorrectionMagnitude: 0,
  dynamicOverThresholdCount: 0,
  dynamicTrackedBodies: 0,
  dynamicInteractiveBodies: 0,
  lastDynamicShotBodyId: 0,
  lastDynamicShotAgeMs: -1,
  lastShotPredictedBodyId: 0,
  lastShotProxyHitBodyId: 0,
  lastShotProxyHitToi: -1,
  lastShotBlockedByBlocker: false,
  lastShotLocalPredictedDeltaM: -1,
  lastShotDynamicSampleAgeMs: -1,
  lastShotPredictedBodyRecentInteraction: false,
  lastShotBlockerDistance: -1,
  lastShotRenderedBodyId: 0,
  lastShotRenderedBodyToi: -1,
  lastShotRenderProxyDeltaM: -1,
  lastShotRenderedBodyProxyPresent: false,
  lastShotRenderedBodyProxyToi: -1,
  lastShotRenderedBodyProxyCenterDeltaM: -1,
  lastShotNearestProxyBodyId: 0,
  lastShotNearestProxyBodyToi: -1,
  lastShotNearestProxyBodyMissDistanceM: -1,
  lastShotNearestProxyBodyRadiusM: -1,
  lastShotNearestRenderedBodyId: 0,
  lastShotNearestRenderedBodyToi: -1,
  lastShotNearestRenderedBodyMissDistanceM: -1,
  lastShotNearestRenderedBodyRadiusM: -1,
  lastShotServerResolution: 0,
  lastShotServerDynamicBodyId: 0,
  lastShotServerDynamicHitToiM: -1,
  lastShotServerDynamicImpulseMag: -1,
  playerCorrectionPeak5sM: 0,
  vehicleCorrectionPeak5sM: 0,
  dynamicCorrectionPeak5sM: 0,
  pendingInputsPeak5s: 0,
  vehiclePendingInputs: 0,
  vehicleAckSeq: 0,
  vehicleLatestLocalSeq: 0,
  vehiclePendingInputsAgeMs: 0,
  vehicleAckBacklogMs: 0,
  vehicleResendWindow: 0,
  vehicleReplayErrorM: 0,
  vehiclePosErrorM: 0,
  vehicleVelErrorMs: 0,
  vehicleRotErrorRad: 0,
  vehicleCorrectionAgeMs: -1,
  physicsStepMs: 0,
  shotsFired: 0,
  shotsPending: 0,
  shotAuthoritativeMoves: 0,
  shotMismatches: 0,
  lastShotOutcome: 'none',
  lastShotOutcomeAgeMs: -1,
  recentEvents: [],
  vehicleDebugId: 0,
  vehicleDriverConfirmed: false,
  vehicleLocalSpeedMs: 0,
  vehicleServerSpeedMs: 0,
  vehiclePosDeltaM: 0,
  vehicleGroundedWheels: 0,
  vehicleSteering: 0,
  vehicleEngineForce: 0,
  vehicleBrake: 0,
  vehicleMeshDeltaM: 0,
  vehicleMeshRotDeltaRad: 0,
  vehiclePredictedFrameDeltaM: 0,
  vehiclePredictedPlanarDeltaM: 0,
  vehiclePredictedHeaveDeltaM: 0,
  vehiclePredictedYawDeltaRad: 0,
  vehiclePredictedPitchDeltaRad: 0,
  vehiclePredictedRollDeltaRad: 0,
  vehiclePredictedResidualDeltaM: 0,
  vehiclePredictedResidualPlanarDeltaM: 0,
  vehiclePredictedResidualHeaveDeltaM: 0,
  vehiclePredictedResidualYawDeltaRad: 0,
  vehiclePredictedResidualPitchDeltaRad: 0,
  vehiclePredictedResidualRollDeltaRad: 0,
  vehicleMeshFrameDeltaM: 0,
  vehicleMeshFrameRotDeltaRad: 0,
  vehicleCameraFrameDeltaM: 0,
  vehicleCameraFrameRotDeltaRad: 0,
  vehicleMeshDeltaRms5sM: 0,
  vehicleMeshDeltaPeak5sM: 0,
  vehicleRestJitterRms5sM: 0,
  vehicleStraightJitterRms5sM: 0,
  vehicleRawHeaveDeltaRms5sM: 0,
  vehicleRawHeaveDeltaPeak5sM: 0,
  vehicleRawPlanarDeltaRms5sM: 0,
  vehicleRawPlanarDeltaPeak5sM: 0,
  vehicleRawYawDeltaRms5sRad: 0,
  vehicleRawYawDeltaPeak5sRad: 0,
  vehicleRawPitchDeltaRms5sRad: 0,
  vehicleRawPitchDeltaPeak5sRad: 0,
  vehicleRawRollDeltaRms5sRad: 0,
  vehicleRawRollDeltaPeak5sRad: 0,
  vehicleResidualDeltaRms5sM: 0,
  vehicleResidualDeltaPeak5sM: 0,
  vehicleResidualPlanarDeltaRms5sM: 0,
  vehicleResidualPlanarDeltaPeak5sM: 0,
  vehicleResidualHeaveDeltaRms5sM: 0,
  vehicleResidualHeaveDeltaPeak5sM: 0,
  vehicleResidualYawDeltaRms5sRad: 0,
  vehicleResidualYawDeltaPeak5sRad: 0,
  vehicleResidualPitchDeltaRms5sRad: 0,
  vehicleResidualPitchDeltaPeak5sRad: 0,
  vehicleResidualRollDeltaRms5sRad: 0,
  vehicleResidualRollDeltaPeak5sRad: 0,
  vehicleRawRestHeaveDeltaRms5sM: 0,
  vehicleRawStraightHeaveDeltaRms5sM: 0,
  vehicleWheelContactBits: 0,
  vehicleWheelContactBitChanges5s: 0,
  vehicleWheelContactNormals: [],
  vehicleWheelContactNormalDeltaRms5sRad: 0,
  vehicleWheelGroundObjectIds: [0, 0, 0, 0],
  vehicleWheelGroundObjectSwitches5s: 0,
  vehicleSuspensionLengths: [0, 0, 0, 0],
  vehicleSuspensionForces: [0, 0, 0, 0],
  vehicleSuspensionRelativeVelocities: [0, 0, 0, 0],
  vehicleSuspensionLengthSpreadM: 0,
  vehicleSuspensionLengthSpreadPeak5sM: 0,
  vehicleSuspensionLengthDeltaRms5sM: 0,
  vehicleSuspensionForceSpreadN: 0,
  vehicleSuspensionForceSpreadPeak5sN: 0,
  vehicleSuspensionForceDeltaRms5sN: 0,
  vehicleMeshFrameDeltaRms5sM: 0,
  vehicleMeshFrameDeltaPeak5sM: 0,
  vehicleMeshFrameRotDeltaRms5sRad: 0,
  vehicleMeshFrameRotDeltaPeak5sRad: 0,
  vehicleCameraFrameDeltaRms5sM: 0,
  vehicleCameraFrameDeltaPeak5sM: 0,
  vehicleCameraFrameRotDeltaRms5sRad: 0,
  vehicleCameraFrameRotDeltaPeak5sRad: 0,
  vehicleGroundedTransitions5s: 0,
  vehicleGroundedMin5s: 0,
  vehicleGroundedMax5s: 0,
  vehicleLatestAuthDeltaM: 0,
  vehicleSampledAuthDeltaM: 0,
  vehicleMeshAuthDeltaM: 0,
  vehicleLatestVsSampledAuthDeltaM: 0,
  vehicleCurrentAuthDeltaM: 0,
  vehicleMeshCurrentAuthDeltaM: 0,
  vehicleExpectedLeadM: 0,
  vehicleCurrentAuthUnexplainedDeltaM: 0,
  vehicleCurrentAuthPlanarDeltaM: 0,
  vehicleCurrentAuthVerticalDeltaM: 0,
  vehicleAuthObservedAgeMs: -1,
  vehicleAuthSampleOffsetMs: -1,
  vehicleAuthSampleServerDeltaMs: -1,
  vehicleAuthCurrentOffsetMs: -1,
  vehiclePredictedAuthDeltaRms5sM: 0,
  vehiclePredictedAuthDeltaPeak5sM: 0,
  playerId: 0,
  position: [0, 0, 0],
  velocity: [0, 0, 0],
  speedMs: 0,
  hp: 100,
  onGround: false,
  inVehicle: false,
  dead: false,
  heapUsedMb: -1,
  heapTotalMb: -1,
};

type DebugMarkdownExtras = {
  connected?: boolean;
  status?: string;
  path?: string;
  userAgent?: string;
  renderStatsText?: string;
  localRenderSmoothingEnabled?: boolean;
  vehicleSmoothingEnabled?: boolean;
  deepCaptureEnabled?: boolean;
  deepCaptureReport?: string | null;
};

function fmt(n: number, decimals = 1): string {
  return n.toFixed(decimals);
}

function fmtBits(bits: number): string {
  return `0b${bits.toString(2).padStart(4, '0')}`;
}

function fmtTuple(values: readonly number[], decimals = 3): string {
  return `[${values.map((value) => fmt(value, decimals)).join(', ')}]`;
}

function fmtVec3Tuple(values: Array<[number, number, number]>, decimals = 2): string {
  if (values.length === 0) return '[]';
  return `[${values.map((value) => fmtTuple(value, decimals)).join(', ')}]`;
}

function fmtFlags(onGround: boolean, inVehicle: boolean, dead: boolean): string {
  const parts: string[] = [];
  if (onGround) parts.push('ground');
  if (inVehicle) parts.push('vehicle');
  if (dead) parts.push('DEAD');
  return parts.length > 0 ? parts.join(' | ') : 'airborne';
}

export function debugStatsToMarkdown(stats: DebugStats, extras: DebugMarkdownExtras = {}): string {
  const p = stats.position;
  const v = stats.velocity;
  const localTransport = stats.transport === 'local';
  const lines = [
    '# vibe-land debug',
    '',
    `- time: ${new Date().toISOString()}`,
    `- path: ${extras.path ?? (typeof window !== 'undefined' ? window.location.pathname : 'unknown')}`,
    `- connected: ${extras.connected == null ? 'unknown' : extras.connected ? 'yes' : 'no'}`,
    `- status: ${extras.status ?? 'unknown'}`,
    `- user-agent: ${extras.userAgent ?? (typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown')}`,
    `- local_render_smoothing: ${extras.localRenderSmoothingEnabled == null ? 'unknown' : extras.localRenderSmoothingEnabled ? 'on' : 'off'}`,
    `- vehicle_smoothing: ${extras.vehicleSmoothingEnabled == null ? 'unknown' : extras.vehicleSmoothingEnabled ? 'on' : 'off'}`,
    '',
    '## Rendering',
    `- fps: ${fmt(stats.fps, 0)}`,
    `- frame_ms: ${fmt(stats.frameTimeMs, 2)}`,
    `- draw_calls: ${stats.drawCalls}`,
    `- triangles: ${stats.triangles}`,
    `- geometries: ${stats.geometries}`,
    `- textures: ${stats.textures}`,
    '',
    `## ${localTransport ? 'Local Runtime' : 'Network'}`,
    `- transport: ${stats.transport}`,
    ...(localTransport
      ? [
          '- runtime: browser_local_rust',
          `- local_tick: ${stats.serverTick}`,
        ]
      : [
          `- ping_ms: ${fmt(stats.pingMs, 2)}`,
          `- jitter_ms: ${fmt(stats.jitterMs, 2)}`,
          `- server_tick: ${stats.serverTick}`,
          `- interp_delay_ms: ${fmt(stats.interpolationDelayMs, 2)}`,
          `- dyn_interp_delay_ms: ${fmt(stats.dynamicBodyInterpolationDelayMs, 2)}`,
          `- clock_offset_ms: ${fmt(stats.clockOffsetUs / 1000, 2)}`,
        ]),
    `- remote_players: ${stats.remotePlayers}`,
    `- snapshots_per_sec: ${fmt(stats.snapshotsPerSec, 0)}`,
    `- snapshot_gap_ms: ${fmt(stats.lastSnapshotGapMs, 2)}`,
    `- snapshot_gap_p95_ms: ${fmt(stats.snapshotGapP95Ms, 2)}`,
    `- snapshot_gap_max_ms: ${fmt(stats.snapshotGapMaxMs, 2)}`,
    `- snapshot_source_last: ${stats.lastSnapshotSource}`,
    `- stale_snapshots_dropped: ${stats.staleSnapshotsDropped}`,
    `- snapshot_src_counts: rel=${stats.reliableSnapshotsReceived} dgram=${stats.datagramSnapshotsReceived} local=${stats.localSnapshotsReceived} direct=${stats.directSnapshotsReceived}`,
    `- rapier_debug: ${stats.rapierDebugLabel} (${stats.rapierDebugModeBits})`,
    '',
    '## Physics',
    `- pending_inputs: ${stats.pendingInputs}`,
    `- prediction_ticks: ${stats.predictionTicks}`,
    `- player_corr_m: ${fmt(stats.playerCorrectionMagnitude, 3)}`,
    `- vehicle_corr_m: ${fmt(stats.vehicleCorrectionMagnitude, 3)}`,
    `- dyn_global_max_corr_m: ${fmt(stats.dynamicGlobalMaxCorrectionMagnitude, 3)}`,
    `- dyn_near_max_corr_m: ${fmt(stats.dynamicNearPlayerMaxCorrectionMagnitude, 3)}`,
    `- dyn_interact_max_corr_m: ${fmt(stats.dynamicInteractiveMaxCorrectionMagnitude, 3)}`,
    `- dyn_over_25cm_count: ${stats.dynamicOverThresholdCount}`,
    `- dyn_tracked_bodies: ${stats.dynamicTrackedBodies}`,
    `- dyn_interactive_bodies: ${stats.dynamicInteractiveBodies}`,
    `- dyn_last_shot_body_id: ${stats.lastDynamicShotBodyId}`,
    `- dyn_last_shot_age_ms: ${stats.lastDynamicShotAgeMs >= 0 ? fmt(stats.lastDynamicShotAgeMs, 2) : 'n/a'}`,
    `- vehicle_pending_inputs: ${stats.vehiclePendingInputs}`,
    `- vehicle_ack_seq: ${stats.vehicleAckSeq}`,
    `- vehicle_latest_local_seq: ${stats.vehicleLatestLocalSeq}`,
    `- vehicle_pending_inputs_age_ms: ${fmt(stats.vehiclePendingInputsAgeMs, 2)}`,
    `- vehicle_ack_backlog_ms: ${fmt(stats.vehicleAckBacklogMs, 2)}`,
    `- vehicle_resend_window: ${fmt(stats.vehicleResendWindow, 0)}`,
    `- vehicle_replay_error_m: ${fmt(stats.vehicleReplayErrorM, 3)}`,
    `- vehicle_pos_error_m: ${fmt(stats.vehiclePosErrorM, 3)}`,
    `- vehicle_vel_error_ms: ${fmt(stats.vehicleVelErrorMs, 3)}`,
    `- vehicle_rot_error_rad: ${fmt(stats.vehicleRotErrorRad, 3)}`,
    `- vehicle_corr_age_ms: ${stats.vehicleCorrectionAgeMs >= 0 ? fmt(stats.vehicleCorrectionAgeMs, 2) : 'n/a'}`,
    `- vehicle_mesh_delta_m: ${fmt(stats.vehicleMeshDeltaM, 3)}`,
    `- vehicle_mesh_rot_delta_rad: ${fmt(stats.vehicleMeshRotDeltaRad, 3)}`,
    `- vehicle_predicted_frame_delta_m: ${fmt(stats.vehiclePredictedFrameDeltaM, 3)}`,
    `- vehicle_predicted_planar_delta_m: ${fmt(stats.vehiclePredictedPlanarDeltaM, 3)}`,
    `- vehicle_predicted_heave_delta_m: ${fmt(stats.vehiclePredictedHeaveDeltaM, 3)}`,
    `- vehicle_predicted_yaw_delta_rad: ${fmt(stats.vehiclePredictedYawDeltaRad, 3)}`,
    `- vehicle_predicted_pitch_delta_rad: ${fmt(stats.vehiclePredictedPitchDeltaRad, 3)}`,
    `- vehicle_predicted_roll_delta_rad: ${fmt(stats.vehiclePredictedRollDeltaRad, 3)}`,
    `- vehicle_predicted_residual_delta_m: ${fmt(stats.vehiclePredictedResidualDeltaM, 3)}`,
    `- vehicle_predicted_residual_planar_delta_m: ${fmt(stats.vehiclePredictedResidualPlanarDeltaM, 3)}`,
    `- vehicle_predicted_residual_heave_delta_m: ${fmt(stats.vehiclePredictedResidualHeaveDeltaM, 3)}`,
    `- vehicle_predicted_residual_yaw_delta_rad: ${fmt(stats.vehiclePredictedResidualYawDeltaRad, 3)}`,
    `- vehicle_predicted_residual_pitch_delta_rad: ${fmt(stats.vehiclePredictedResidualPitchDeltaRad, 3)}`,
    `- vehicle_predicted_residual_roll_delta_rad: ${fmt(stats.vehiclePredictedResidualRollDeltaRad, 3)}`,
    `- vehicle_mesh_frame_delta_m: ${fmt(stats.vehicleMeshFrameDeltaM, 3)}`,
    `- vehicle_mesh_frame_rot_delta_rad: ${fmt(stats.vehicleMeshFrameRotDeltaRad, 3)}`,
    `- vehicle_camera_frame_delta_m: ${fmt(stats.vehicleCameraFrameDeltaM, 3)}`,
    `- vehicle_camera_frame_rot_delta_rad: ${fmt(stats.vehicleCameraFrameRotDeltaRad, 3)}`,
    `- vehicle_mesh_delta_rms_5s_m: ${fmt(stats.vehicleMeshDeltaRms5sM, 3)}`,
    `- vehicle_mesh_delta_peak_5s_m: ${fmt(stats.vehicleMeshDeltaPeak5sM, 3)}`,
    `- vehicle_rest_jitter_rms_5s_m: ${fmt(stats.vehicleRestJitterRms5sM, 3)}`,
    `- vehicle_straight_jitter_rms_5s_m: ${fmt(stats.vehicleStraightJitterRms5sM, 3)}`,
    `- vehicle_raw_heave_delta_rms_5s_m: ${fmt(stats.vehicleRawHeaveDeltaRms5sM, 3)}`,
    `- vehicle_raw_heave_delta_peak_5s_m: ${fmt(stats.vehicleRawHeaveDeltaPeak5sM, 3)}`,
    `- vehicle_raw_planar_delta_rms_5s_m: ${fmt(stats.vehicleRawPlanarDeltaRms5sM, 3)}`,
    `- vehicle_raw_planar_delta_peak_5s_m: ${fmt(stats.vehicleRawPlanarDeltaPeak5sM, 3)}`,
    `- vehicle_raw_yaw_delta_rms_5s_rad: ${fmt(stats.vehicleRawYawDeltaRms5sRad, 3)}`,
    `- vehicle_raw_yaw_delta_peak_5s_rad: ${fmt(stats.vehicleRawYawDeltaPeak5sRad, 3)}`,
    `- vehicle_raw_pitch_delta_rms_5s_rad: ${fmt(stats.vehicleRawPitchDeltaRms5sRad, 3)}`,
    `- vehicle_raw_pitch_delta_peak_5s_rad: ${fmt(stats.vehicleRawPitchDeltaPeak5sRad, 3)}`,
    `- vehicle_raw_roll_delta_rms_5s_rad: ${fmt(stats.vehicleRawRollDeltaRms5sRad, 3)}`,
    `- vehicle_raw_roll_delta_peak_5s_rad: ${fmt(stats.vehicleRawRollDeltaPeak5sRad, 3)}`,
    `- vehicle_residual_delta_rms_5s_m: ${fmt(stats.vehicleResidualDeltaRms5sM, 3)}`,
    `- vehicle_residual_delta_peak_5s_m: ${fmt(stats.vehicleResidualDeltaPeak5sM, 3)}`,
    `- vehicle_residual_planar_delta_rms_5s_m: ${fmt(stats.vehicleResidualPlanarDeltaRms5sM, 3)}`,
    `- vehicle_residual_planar_delta_peak_5s_m: ${fmt(stats.vehicleResidualPlanarDeltaPeak5sM, 3)}`,
    `- vehicle_residual_heave_delta_rms_5s_m: ${fmt(stats.vehicleResidualHeaveDeltaRms5sM, 3)}`,
    `- vehicle_residual_heave_delta_peak_5s_m: ${fmt(stats.vehicleResidualHeaveDeltaPeak5sM, 3)}`,
    `- vehicle_residual_yaw_delta_rms_5s_rad: ${fmt(stats.vehicleResidualYawDeltaRms5sRad, 3)}`,
    `- vehicle_residual_yaw_delta_peak_5s_rad: ${fmt(stats.vehicleResidualYawDeltaPeak5sRad, 3)}`,
    `- vehicle_residual_pitch_delta_rms_5s_rad: ${fmt(stats.vehicleResidualPitchDeltaRms5sRad, 3)}`,
    `- vehicle_residual_pitch_delta_peak_5s_rad: ${fmt(stats.vehicleResidualPitchDeltaPeak5sRad, 3)}`,
    `- vehicle_residual_roll_delta_rms_5s_rad: ${fmt(stats.vehicleResidualRollDeltaRms5sRad, 3)}`,
    `- vehicle_residual_roll_delta_peak_5s_rad: ${fmt(stats.vehicleResidualRollDeltaPeak5sRad, 3)}`,
    `- vehicle_raw_rest_heave_delta_rms_5s_m: ${fmt(stats.vehicleRawRestHeaveDeltaRms5sM, 3)}`,
    `- vehicle_raw_straight_heave_delta_rms_5s_m: ${fmt(stats.vehicleRawStraightHeaveDeltaRms5sM, 3)}`,
    `- vehicle_wheel_contact_bits: ${fmtBits(stats.vehicleWheelContactBits)}`,
    `- vehicle_wheel_contact_bit_changes_5s: ${fmt(stats.vehicleWheelContactBitChanges5s, 0)}`,
    `- vehicle_wheel_contact_normals: ${fmtVec3Tuple(stats.vehicleWheelContactNormals, 2)}`,
    `- vehicle_wheel_contact_normal_delta_rms_5s_rad: ${fmt(stats.vehicleWheelContactNormalDeltaRms5sRad, 3)}`,
    `- vehicle_wheel_ground_object_ids: ${fmtTuple(stats.vehicleWheelGroundObjectIds, 0)}`,
    `- vehicle_wheel_ground_object_switches_5s: ${fmt(stats.vehicleWheelGroundObjectSwitches5s, 0)}`,
    `- vehicle_suspension_lengths_m: ${fmtTuple(stats.vehicleSuspensionLengths, 3)}`,
    `- vehicle_suspension_forces_n: ${fmtTuple(stats.vehicleSuspensionForces, 1)}`,
    `- vehicle_suspension_relative_velocities_ms: ${fmtTuple(stats.vehicleSuspensionRelativeVelocities, 3)}`,
    `- vehicle_suspension_length_spread_m: ${fmt(stats.vehicleSuspensionLengthSpreadM, 3)}`,
    `- vehicle_suspension_length_spread_peak_5s_m: ${fmt(stats.vehicleSuspensionLengthSpreadPeak5sM, 3)}`,
    `- vehicle_suspension_length_delta_rms_5s_m: ${fmt(stats.vehicleSuspensionLengthDeltaRms5sM, 3)}`,
    `- vehicle_suspension_force_spread_n: ${fmt(stats.vehicleSuspensionForceSpreadN, 1)}`,
    `- vehicle_suspension_force_spread_peak_5s_n: ${fmt(stats.vehicleSuspensionForceSpreadPeak5sN, 1)}`,
    `- vehicle_suspension_force_delta_rms_5s_n: ${fmt(stats.vehicleSuspensionForceDeltaRms5sN, 1)}`,
    `- vehicle_mesh_frame_delta_rms_5s_m: ${fmt(stats.vehicleMeshFrameDeltaRms5sM, 3)}`,
    `- vehicle_mesh_frame_delta_peak_5s_m: ${fmt(stats.vehicleMeshFrameDeltaPeak5sM, 3)}`,
    `- vehicle_mesh_frame_rot_delta_rms_5s_rad: ${fmt(stats.vehicleMeshFrameRotDeltaRms5sRad, 3)}`,
    `- vehicle_mesh_frame_rot_delta_peak_5s_rad: ${fmt(stats.vehicleMeshFrameRotDeltaPeak5sRad, 3)}`,
    `- vehicle_camera_frame_delta_rms_5s_m: ${fmt(stats.vehicleCameraFrameDeltaRms5sM, 3)}`,
    `- vehicle_camera_frame_delta_peak_5s_m: ${fmt(stats.vehicleCameraFrameDeltaPeak5sM, 3)}`,
    `- vehicle_camera_frame_rot_delta_rms_5s_rad: ${fmt(stats.vehicleCameraFrameRotDeltaRms5sRad, 3)}`,
    `- vehicle_camera_frame_rot_delta_peak_5s_rad: ${fmt(stats.vehicleCameraFrameRotDeltaPeak5sRad, 3)}`,
    `- vehicle_grounded_transitions_5s: ${stats.vehicleGroundedTransitions5s}`,
    `- vehicle_grounded_min_5s: ${fmt(stats.vehicleGroundedMin5s, 0)}`,
    `- vehicle_grounded_max_5s: ${fmt(stats.vehicleGroundedMax5s, 0)}`,
    `- vehicle_latest_auth_delta_m: ${fmt(stats.vehicleLatestAuthDeltaM, 3)}`,
    `- vehicle_sampled_auth_delta_m: ${fmt(stats.vehicleSampledAuthDeltaM, 3)}`,
    `- vehicle_mesh_auth_delta_m: ${fmt(stats.vehicleMeshAuthDeltaM, 3)}`,
    `- vehicle_latest_vs_sampled_auth_delta_m: ${fmt(stats.vehicleLatestVsSampledAuthDeltaM, 3)}`,
    `- vehicle_current_auth_delta_m: ${fmt(stats.vehicleCurrentAuthDeltaM, 3)}`,
    `- vehicle_mesh_current_auth_delta_m: ${fmt(stats.vehicleMeshCurrentAuthDeltaM, 3)}`,
    `- vehicle_expected_lead_m: ${fmt(stats.vehicleExpectedLeadM, 3)}`,
    `- vehicle_current_auth_unexplained_delta_m: ${fmt(stats.vehicleCurrentAuthUnexplainedDeltaM, 3)}`,
    `- vehicle_current_auth_planar_delta_m: ${fmt(stats.vehicleCurrentAuthPlanarDeltaM, 3)}`,
    `- vehicle_current_auth_vertical_delta_m: ${fmt(stats.vehicleCurrentAuthVerticalDeltaM, 3)}`,
    `- vehicle_auth_observed_age_ms: ${stats.vehicleAuthObservedAgeMs >= 0 ? fmt(stats.vehicleAuthObservedAgeMs, 2) : 'n/a'}`,
    `- vehicle_auth_sample_offset_ms: ${stats.vehicleAuthSampleOffsetMs >= 0 ? fmt(stats.vehicleAuthSampleOffsetMs, 2) : 'n/a'}`,
    `- vehicle_auth_sample_server_delta_ms: ${stats.vehicleAuthSampleServerDeltaMs >= 0 ? fmt(stats.vehicleAuthSampleServerDeltaMs, 2) : 'n/a'}`,
    `- vehicle_auth_current_offset_ms: ${stats.vehicleAuthCurrentOffsetMs >= 0 ? fmt(stats.vehicleAuthCurrentOffsetMs, 2) : 'n/a'}`,
    `- vehicle_predicted_auth_delta_rms_5s_m: ${fmt(stats.vehiclePredictedAuthDeltaRms5sM, 3)}`,
    `- vehicle_predicted_auth_delta_peak_5s_m: ${fmt(stats.vehiclePredictedAuthDeltaPeak5sM, 3)}`,
    `- player_corr_peak_5s_m: ${fmt(stats.playerCorrectionPeak5sM, 3)}`,
    `- vehicle_corr_peak_5s_m: ${fmt(stats.vehicleCorrectionPeak5sM, 3)}`,
    `- dyn_corr_peak_5s_m: ${fmt(stats.dynamicCorrectionPeak5sM, 3)}`,
    `- pending_inputs_peak_5s: ${fmt(stats.pendingInputsPeak5s, 0)}`,
    `- physics_step_ms: ${fmt(stats.physicsStepMs, 2)}`,
    '',
    '## Shots',
    `- shots_fired: ${stats.shotsFired}`,
    `- shots_pending: ${stats.shotsPending}`,
    `- shot_auth_moves: ${stats.shotAuthoritativeMoves}`,
    `- shot_mismatches: ${stats.shotMismatches}`,
    `- last_shot_outcome_age_ms: ${stats.lastShotOutcomeAgeMs >= 0 ? fmt(stats.lastShotOutcomeAgeMs, 2) : 'n/a'}`,
    `- last_shot_outcome: ${stats.lastShotOutcome}`,
    `- last_shot_predicted_body_id: ${stats.lastShotPredictedBodyId}`,
    `- last_shot_proxy_hit_body_id: ${stats.lastShotProxyHitBodyId}`,
    `- last_shot_proxy_hit_toi: ${stats.lastShotProxyHitToi >= 0 ? fmt(stats.lastShotProxyHitToi, 2) : 'n/a'}`,
    `- last_shot_blocked_by_blocker: ${stats.lastShotBlockedByBlocker ? 'yes' : 'no'}`,
    `- last_shot_local_pred_delta_m: ${stats.lastShotLocalPredictedDeltaM >= 0 ? fmt(stats.lastShotLocalPredictedDeltaM, 3) : 'n/a'}`,
    `- last_shot_dynamic_sample_age_ms: ${stats.lastShotDynamicSampleAgeMs >= 0 ? fmt(stats.lastShotDynamicSampleAgeMs, 2) : 'n/a'}`,
    `- last_shot_predicted_body_recent_interaction: ${stats.lastShotPredictedBodyRecentInteraction ? 'yes' : 'no'}`,
    `- last_shot_blocker_distance: ${stats.lastShotBlockerDistance >= 0 ? fmt(stats.lastShotBlockerDistance, 2) : 'n/a'}`,
    `- last_shot_rendered_body_id: ${stats.lastShotRenderedBodyId}`,
    `- last_shot_rendered_body_toi: ${stats.lastShotRenderedBodyToi >= 0 ? fmt(stats.lastShotRenderedBodyToi, 2) : 'n/a'}`,
    `- last_shot_render_proxy_delta_m: ${stats.lastShotRenderProxyDeltaM >= 0 ? fmt(stats.lastShotRenderProxyDeltaM, 3) : 'n/a'}`,
    `- last_shot_rendered_body_proxy_present: ${stats.lastShotRenderedBodyProxyPresent ? 'yes' : 'no'}`,
    `- last_shot_rendered_body_proxy_toi: ${stats.lastShotRenderedBodyProxyToi >= 0 ? fmt(stats.lastShotRenderedBodyProxyToi, 2) : 'n/a'}`,
    `- last_shot_rendered_body_proxy_center_delta_m: ${stats.lastShotRenderedBodyProxyCenterDeltaM >= 0 ? fmt(stats.lastShotRenderedBodyProxyCenterDeltaM, 3) : 'n/a'}`,
    `- last_shot_nearest_proxy_body_id: ${stats.lastShotNearestProxyBodyId}`,
    `- last_shot_nearest_proxy_body_toi: ${stats.lastShotNearestProxyBodyToi >= 0 ? fmt(stats.lastShotNearestProxyBodyToi, 2) : 'n/a'}`,
    `- last_shot_nearest_proxy_body_miss_distance_m: ${stats.lastShotNearestProxyBodyMissDistanceM >= 0 ? fmt(stats.lastShotNearestProxyBodyMissDistanceM, 3) : 'n/a'}`,
    `- last_shot_nearest_proxy_body_radius_m: ${stats.lastShotNearestProxyBodyRadiusM >= 0 ? fmt(stats.lastShotNearestProxyBodyRadiusM, 3) : 'n/a'}`,
    `- last_shot_nearest_rendered_body_id: ${stats.lastShotNearestRenderedBodyId}`,
    `- last_shot_nearest_rendered_body_toi: ${stats.lastShotNearestRenderedBodyToi >= 0 ? fmt(stats.lastShotNearestRenderedBodyToi, 2) : 'n/a'}`,
    `- last_shot_nearest_rendered_body_miss_distance_m: ${stats.lastShotNearestRenderedBodyMissDistanceM >= 0 ? fmt(stats.lastShotNearestRenderedBodyMissDistanceM, 3) : 'n/a'}`,
    `- last_shot_nearest_rendered_body_radius_m: ${stats.lastShotNearestRenderedBodyRadiusM >= 0 ? fmt(stats.lastShotNearestRenderedBodyRadiusM, 3) : 'n/a'}`,
    `- last_shot_server_resolution: ${stats.lastShotServerResolution}`,
    `- last_shot_server_dynamic_body_id: ${stats.lastShotServerDynamicBodyId}`,
    `- last_shot_server_dynamic_hit_toi_m: ${stats.lastShotServerDynamicHitToiM >= 0 ? fmt(stats.lastShotServerDynamicHitToiM, 2) : 'n/a'}`,
    `- last_shot_server_dynamic_impulse_mag: ${stats.lastShotServerDynamicImpulseMag >= 0 ? fmt(stats.lastShotServerDynamicImpulseMag, 2) : 'n/a'}`,
    '',
    '## Vehicle',
    `- vehicle_id: ${stats.vehicleDebugId}`,
    `- vehicle_driver_confirmed: ${stats.vehicleDriverConfirmed ? 'yes' : 'no'}`,
    `- vehicle_local_speed_ms: ${fmt(stats.vehicleLocalSpeedMs, 3)}`,
    `- vehicle_server_speed_ms: ${fmt(stats.vehicleServerSpeedMs, 3)}`,
    `- vehicle_pos_delta_m: ${fmt(stats.vehiclePosDeltaM, 3)}`,
    `- vehicle_grounded_wheels: ${stats.vehicleGroundedWheels}`,
    `- vehicle_steering: ${fmt(stats.vehicleSteering, 3)}`,
    `- vehicle_engine_force: ${fmt(stats.vehicleEngineForce, 0)}`,
    `- vehicle_brake: ${fmt(stats.vehicleBrake, 0)}`,
    '',
    '## Player',
    `- player_id: ${stats.playerId}`,
    `- hp: ${stats.hp}`,
    `- status_flags: ${fmtFlags(stats.onGround, stats.inVehicle, stats.dead)}`,
    `- pos_m: [${fmt(p[0], 3)}, ${fmt(p[1], 3)}, ${fmt(p[2], 3)}]`,
    `- vel_mps: [${fmt(v[0], 3)}, ${fmt(v[1], 3)}, ${fmt(v[2], 3)}]`,
    `- speed_mps: ${fmt(stats.speedMs, 3)}`,
  ];

  if (stats.heapUsedMb >= 0) {
    lines.push('', '## System', `- heap_mb: ${fmt(stats.heapUsedMb, 2)} / ${fmt(stats.heapTotalMb, 2)}`);
  }

  const renderStatsText = extras.renderStatsText?.trim();
  if (renderStatsText) {
    lines.push('', '## Render Stats', '```text', renderStatsText, '```');
  }

  if (stats.recentEvents.length > 0) {
    lines.push('', '## Recent Events', '```text', ...stats.recentEvents, '```');
  }

  if (extras.deepCaptureEnabled != null) {
    lines.push('', '## Deep Capture', `- enabled: ${extras.deepCaptureEnabled ? 'yes' : 'no'}`);
  }

  if (extras.deepCaptureReport) {
    lines.push('', extras.deepCaptureReport);
  }

  return lines.join('\n');
}

export function DebugOverlay({
  stats,
  visible,
  localRenderSmoothingEnabled = true,
  onToggleLocalRenderSmoothing,
  vehicleSmoothingEnabled = false,
  onToggleVehicleSmoothing,
  deepCaptureEnabled = false,
  deepCaptureSampleCount = 0,
}: {
  stats: DebugStats;
  visible: boolean;
  localRenderSmoothingEnabled?: boolean;
  onToggleLocalRenderSmoothing?: () => void;
  vehicleSmoothingEnabled?: boolean;
  onToggleVehicleSmoothing?: () => void;
  deepCaptureEnabled?: boolean;
  deepCaptureSampleCount?: number;
}) {
  if (!visible) return null;

  const p = stats.position;
  const v = stats.velocity;
  const smoothingAccent = localRenderSmoothingEnabled ? '#98ffbc' : '#d8dee6';
  const smoothingBackground = localRenderSmoothingEnabled
    ? 'linear-gradient(180deg, rgba(18, 54, 31, 0.72), rgba(9, 28, 17, 0.78))'
    : 'linear-gradient(180deg, rgba(36, 40, 46, 0.72), rgba(18, 21, 26, 0.78))';
  const smoothingBorder = localRenderSmoothingEnabled
    ? 'rgba(118, 255, 170, 0.28)'
    : 'rgba(228, 234, 241, 0.18)';
  const vehicleSmoothingAccent = vehicleSmoothingEnabled ? '#98ffbc' : '#d8dee6';
  const vehicleSmoothingBackground = vehicleSmoothingEnabled
    ? 'linear-gradient(180deg, rgba(18, 54, 31, 0.72), rgba(9, 28, 17, 0.78))'
    : 'linear-gradient(180deg, rgba(36, 40, 46, 0.72), rgba(18, 21, 26, 0.78))';
  const vehicleSmoothingBorder = vehicleSmoothingEnabled
    ? 'rgba(118, 255, 170, 0.28)'
    : 'rgba(228, 234, 241, 0.18)';

  return (
    <div
      style={{
        position: 'absolute',
        top: 8,
        right: 8,
        zIndex: 20,
        background: 'linear-gradient(180deg, rgba(7, 18, 14, 0.96), rgba(3, 10, 8, 0.9))',
        border: '1px solid rgba(154, 211, 176, 0.16)',
        boxShadow: '0 18px 44px rgba(0, 0, 0, 0.42)',
        backdropFilter: 'blur(10px)',
        color: '#d8f3de',
        fontFamily: 'monospace',
        fontSize: 12,
        lineHeight: 1.45,
        padding: '10px 12px 12px',
        borderRadius: 12,
        pointerEvents: 'auto',
        minWidth: 272,
        maxWidth: 'min(420px, calc((100vw - 16px) / 2.2))',
        maxHeight: 'calc(100vh - 16px)',
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
        wordBreak: 'break-word',
        boxSizing: 'border-box',
        overflowY: 'auto',
        overflowX: 'hidden',
        overscrollBehavior: 'contain',
      }}
    >
      <div
        style={{
          display: 'grid',
          gap: 10,
          marginBottom: 10,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <div>
            <div
              style={{
                color: '#87b89a',
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
                marginBottom: 2,
              }}
            >
              Debug Overlay
            </div>
            <div style={{ color: '#f2fff5', fontSize: 14, fontWeight: 700 }}>
              Runtime Diagnostics
            </div>
          </div>
          <div
            style={{
              color: '#7fa18b',
              fontSize: 10,
              textAlign: 'right',
              lineHeight: 1.35,
            }}
          >
            <div>F3 show / hide</div>
            <div>F4 copy report</div>
            <div>F7 deep capture</div>
          </div>
        </div>

        <div
          style={{
            display: 'grid',
            gap: 8,
            padding: '10px 12px',
            borderRadius: 10,
            background: smoothingBackground,
            border: `1px solid ${smoothingBorder}`,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10,
              flexWrap: 'wrap',
            }}
          >
            <div>
              <div
                style={{
                  color: '#f0fff4',
                  fontSize: 13,
                  fontWeight: 700,
                  marginBottom: 2,
                }}
              >
                Local Render Smoothing
              </div>
              <div style={{ color: '#94b69f', fontSize: 11 }}>
                Toggle interpolated local player and camera presentation.
              </div>
            </div>
            <button
              type="button"
              aria-pressed={localRenderSmoothingEnabled}
              onClick={onToggleLocalRenderSmoothing}
              style={{
                background: localRenderSmoothingEnabled ? 'rgba(137, 255, 186, 0.18)' : 'rgba(255, 255, 255, 0.08)',
                border: `1px solid ${localRenderSmoothingEnabled ? 'rgba(137, 255, 186, 0.48)' : 'rgba(255, 255, 255, 0.2)'}`,
                color: smoothingAccent,
                borderRadius: 999,
                cursor: onToggleLocalRenderSmoothing ? 'pointer' : 'default',
                font: 'inherit',
                fontWeight: 700,
                letterSpacing: '0.03em',
                padding: '6px 12px',
                boxShadow: localRenderSmoothingEnabled ? 'inset 0 0 0 1px rgba(137, 255, 186, 0.08)' : 'none',
              }}
            >
              {`Local Smooth ${localRenderSmoothingEnabled ? 'ON' : 'OFF'}`}
            </button>
          </div>
          <div style={{ color: '#a9cab2', fontSize: 11, lineHeight: 1.35 }}>
            {localRenderSmoothingEnabled
              ? 'High-refresh monitors render the local pose between 60Hz simulation steps.'
              : 'Uses the raw 60Hz local pose so you can compare against the smoothed path.'}
          </div>
        </div>
        <div
          style={{
            display: 'grid',
            gap: 8,
            padding: '10px 12px',
            borderRadius: 10,
            background: vehicleSmoothingBackground,
            border: `1px solid ${vehicleSmoothingBorder}`,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10,
              flexWrap: 'wrap',
            }}
          >
            <div>
              <div
                style={{
                  color: '#f0fff4',
                  fontSize: 13,
                  fontWeight: 700,
                  marginBottom: 2,
                }}
              >
                Vehicle Smoothing
              </div>
              <div style={{ color: '#94b69f', fontSize: 11 }}>
                Toggle local driven vehicle mesh and chase camera smoothing.
              </div>
            </div>
            <button
              type="button"
              aria-pressed={vehicleSmoothingEnabled}
              onClick={onToggleVehicleSmoothing}
              style={{
                background: vehicleSmoothingEnabled ? 'rgba(137, 255, 186, 0.18)' : 'rgba(255, 255, 255, 0.08)',
                border: `1px solid ${vehicleSmoothingEnabled ? 'rgba(137, 255, 186, 0.48)' : 'rgba(255, 255, 255, 0.2)'}`,
                color: vehicleSmoothingAccent,
                borderRadius: 999,
                cursor: onToggleVehicleSmoothing ? 'pointer' : 'default',
                font: 'inherit',
                fontWeight: 700,
                letterSpacing: '0.03em',
                padding: '6px 12px',
                boxShadow: vehicleSmoothingEnabled ? 'inset 0 0 0 1px rgba(137, 255, 186, 0.08)' : 'none',
              }}
            >
              {`Vehicle Smooth ${vehicleSmoothingEnabled ? 'ON' : 'OFF'}`}
            </button>
          </div>
          <div style={{ color: '#a9cab2', fontSize: 11, lineHeight: 1.35 }}>
            {vehicleSmoothingEnabled
              ? 'Renders the driven vehicle and chase camera from the filtered visual pose.'
              : 'Uses the raw local vehicle pose so you can verify whether the filter is causing the wobble.'}
          </div>
        </div>
      </div>

      <Section title="Rendering">
        {`FPS: ${fmt(stats.fps, 0)}  (${fmt(stats.frameTimeMs)}ms)`}
        {`Draw calls: ${stats.drawCalls}  Tris: ${stats.triangles}`}
        {`Geom: ${stats.geometries}  Tex: ${stats.textures}`}
      </Section>

      <Section title={stats.transport === 'local' ? 'Local Runtime' : 'Network'}>
        {`Transport: ${stats.transport}`}
        {stats.transport === 'local'
          ? 'Runtime: browser-local Rust simulation'
          : `Ping: ${fmt(stats.pingMs)}ms  Jitter: ±${fmt(stats.jitterMs)}ms`}
        {`${stats.transport === 'local' ? 'Local tick' : 'Server tick'}: ${stats.serverTick}`}
        {stats.transport === 'local'
          ? 'Interpolation: bypassed for local runtime'
          : `Interp delay: ${stats.interpolationDelayMs.toFixed(2)}ms`}
        {stats.transport === 'local'
          ? 'Dyn interp: bypassed for local runtime'
          : `Dyn interp delay: ${stats.dynamicBodyInterpolationDelayMs.toFixed(2)}ms`}
        {stats.transport === 'local'
          ? 'Clock offset: n/a (same process)'
          : `Clock offset: ${fmt(stats.clockOffsetUs / 1000)}ms`}
        {`Remote players: ${stats.remotePlayers}`}
        {`Snapshots/s: ${fmt(stats.snapshotsPerSec, 0)}`}
        {`Snapshot gap: ${fmt(stats.lastSnapshotGapMs)}ms  p95 ${fmt(stats.snapshotGapP95Ms)}ms  max ${fmt(stats.snapshotGapMaxMs)}ms`}
        {`Snapshot src: ${stats.lastSnapshotSource}  stale drops: ${stats.staleSnapshotsDropped}`}
        {`Snapshot counts rel/dgram: ${stats.reliableSnapshotsReceived}/${stats.datagramSnapshotsReceived}`}
        {`Rapier debug: ${stats.rapierDebugLabel}`}
      </Section>

      <Section title="Physics">
        {`Pending inputs: ${stats.pendingInputs}`}
        {`Pending peak 5s: ${fmt(stats.pendingInputsPeak5s, 0)}`}
        {`Prediction ticks: ${stats.predictionTicks}`}
        {`Player corr: ${fmt(stats.playerCorrectionMagnitude, 3)}m`}
        {`Vehicle corr: ${fmt(stats.vehicleCorrectionMagnitude, 3)}m`}
        {`Dyn global max: ${fmt(stats.dynamicGlobalMaxCorrectionMagnitude, 3)}m`}
        {`Dyn near max: ${fmt(stats.dynamicNearPlayerMaxCorrectionMagnitude, 3)}m`}
        {`Dyn interact max: ${fmt(stats.dynamicInteractiveMaxCorrectionMagnitude, 3)}m`}
        {`Correction peaks 5s P/V/D: ${fmt(stats.playerCorrectionPeak5sM, 3)}/${fmt(stats.vehicleCorrectionPeak5sM, 3)}/${fmt(stats.dynamicCorrectionPeak5sM, 3)}`}
        {`Dyn >25cm: ${stats.dynamicOverThresholdCount}`}
        {`Dynamic bodies: ${stats.dynamicTrackedBodies}  interactive: ${stats.dynamicInteractiveBodies}`}
        {`Dyn shot: ${stats.lastDynamicShotBodyId || '—'}  age: ${stats.lastDynamicShotAgeMs >= 0 ? fmt(stats.lastDynamicShotAgeMs, 0) : 'n/a'}ms`}
        {`Vehicle pend/ack: ${stats.vehiclePendingInputs}/${stats.vehicleAckSeq}  replay ${fmt(stats.vehicleReplayErrorM, 3)}m`}
        {`Vehicle latest seq/backlog/resend: ${stats.vehicleLatestLocalSeq}  ${fmt(stats.vehicleAckBacklogMs, 1)}ms  win ${fmt(stats.vehicleResendWindow, 0)}`}
        {`Vehicle pending age: ${fmt(stats.vehiclePendingInputsAgeMs, 1)}ms  corr age: ${stats.vehicleCorrectionAgeMs >= 0 ? fmt(stats.vehicleCorrectionAgeMs, 1) : 'n/a'}ms`}
        {`Vehicle pos/vel/rot err: ${fmt(stats.vehiclePosErrorM, 3)}m ${fmt(stats.vehicleVelErrorMs, 3)}m/s ${fmt(stats.vehicleRotErrorRad, 3)}rad`}
        {`Vehicle mesh delta/rot: ${fmt(stats.vehicleMeshDeltaM, 3)}m ${fmt(stats.vehicleMeshRotDeltaRad, 3)}rad`}
        {`Vehicle pred frame/planar/heave/yaw: ${fmt(stats.vehiclePredictedFrameDeltaM, 3)}/${fmt(stats.vehiclePredictedPlanarDeltaM, 3)}/${fmt(stats.vehiclePredictedHeaveDeltaM, 3)}m ${fmt(stats.vehiclePredictedYawDeltaRad, 3)}rad`}
        {`Vehicle residual frame/planar/heave: ${fmt(stats.vehiclePredictedResidualDeltaM, 3)}/${fmt(stats.vehiclePredictedResidualPlanarDeltaM, 3)}/${fmt(stats.vehiclePredictedResidualHeaveDeltaM, 3)}m`}
        {`Vehicle mesh/camera frame delta: ${fmt(stats.vehicleMeshFrameDeltaM, 3)}/${fmt(stats.vehicleCameraFrameDeltaM, 3)}m`}
        {`Vehicle mesh rms/peak 5s: ${fmt(stats.vehicleMeshDeltaRms5sM, 3)}/${fmt(stats.vehicleMeshDeltaPeak5sM, 3)}m`}
        {`Vehicle mesh frame rms/peak 5s: ${fmt(stats.vehicleMeshFrameDeltaRms5sM, 3)}/${fmt(stats.vehicleMeshFrameDeltaPeak5sM, 3)}m`}
        {`Vehicle mesh frame rot rms/peak 5s: ${fmt(stats.vehicleMeshFrameRotDeltaRms5sRad, 3)}/${fmt(stats.vehicleMeshFrameRotDeltaPeak5sRad, 3)}rad`}
        {`Vehicle camera frame rms/peak 5s: ${fmt(stats.vehicleCameraFrameDeltaRms5sM, 3)}/${fmt(stats.vehicleCameraFrameDeltaPeak5sM, 3)}m`}
        {`Vehicle rest/straight jitter rms: ${fmt(stats.vehicleRestJitterRms5sM, 3)}/${fmt(stats.vehicleStraightJitterRms5sM, 3)}m`}
        {`Vehicle raw planar/heave rms: ${fmt(stats.vehicleRawPlanarDeltaRms5sM, 3)}/${fmt(stats.vehicleRawHeaveDeltaRms5sM, 3)}m`}
        {`Vehicle raw yaw/pitch/roll rms: ${fmt(stats.vehicleRawYawDeltaRms5sRad, 3)}/${fmt(stats.vehicleRawPitchDeltaRms5sRad, 3)}/${fmt(stats.vehicleRawRollDeltaRms5sRad, 3)}rad`}
        {`Vehicle residual planar/heave rms: ${fmt(stats.vehicleResidualPlanarDeltaRms5sM, 3)}/${fmt(stats.vehicleResidualHeaveDeltaRms5sM, 3)}m`}
        {`Wheel bits/changes 5s: ${fmtBits(stats.vehicleWheelContactBits)} / ${fmt(stats.vehicleWheelContactBitChanges5s, 0)}`}
        {`Susp spread len/force: ${fmt(stats.vehicleSuspensionLengthSpreadM, 3)}m / ${fmt(stats.vehicleSuspensionForceSpreadN, 1)}N`}
        {`Susp delta len/force rms: ${fmt(stats.vehicleSuspensionLengthDeltaRms5sM, 3)}m / ${fmt(stats.vehicleSuspensionForceDeltaRms5sN, 1)}N`}
        {`Vehicle pred/auth rms/peak 5s: ${fmt(stats.vehiclePredictedAuthDeltaRms5sM, 3)}/${fmt(stats.vehiclePredictedAuthDeltaPeak5sM, 3)}m`}
        {`Vehicle current auth delta: ${fmt(stats.vehicleCurrentAuthDeltaM, 3)}m  mesh/current ${fmt(stats.vehicleMeshCurrentAuthDeltaM, 3)}m`}
        {`Vehicle expected lead/unexplained: ${fmt(stats.vehicleExpectedLeadM, 3)}/${fmt(stats.vehicleCurrentAuthUnexplainedDeltaM, 3)}m`}
        {`Vehicle grounded min/max/transitions 5s: ${fmt(stats.vehicleGroundedMin5s, 0)}/${fmt(stats.vehicleGroundedMax5s, 0)}/${stats.vehicleGroundedTransitions5s}`}
        {`Physics step: ${fmt(stats.physicsStepMs, 2)}ms`}
      </Section>

      <Section title="Shots">
        {`Shots fired/pending: ${stats.shotsFired}/${stats.shotsPending}`}
        {`Auth moves/mismatches: ${stats.shotAuthoritativeMoves}/${stats.shotMismatches}`}
        {`Last shot: ${stats.lastShotOutcome}`}
        {`Pred/proxy/render body: ${stats.lastShotPredictedBodyId}/${stats.lastShotProxyHitBodyId}/${stats.lastShotRenderedBodyId}`}
        {`Proxy toi/blocker/render toi: ${stats.lastShotProxyHitToi >= 0 ? fmt(stats.lastShotProxyHitToi, 2) : 'n/a'} / ${stats.lastShotBlockerDistance >= 0 ? fmt(stats.lastShotBlockerDistance, 2) : 'n/a'} / ${stats.lastShotRenderedBodyToi >= 0 ? fmt(stats.lastShotRenderedBodyToi, 2) : 'n/a'}`}
        {`Local predicted delta: ${stats.lastShotLocalPredictedDeltaM >= 0 ? fmt(stats.lastShotLocalPredictedDeltaM, 3) : 'n/a'}m  dyn age: ${stats.lastShotDynamicSampleAgeMs >= 0 ? fmt(stats.lastShotDynamicSampleAgeMs, 1) : 'n/a'}ms  recent interact: ${stats.lastShotPredictedBodyRecentInteraction ? 'yes' : 'no'}`}
        {`Blocked by blocker: ${stats.lastShotBlockedByBlocker ? 'yes' : 'no'}  render-proxy delta: ${stats.lastShotRenderProxyDeltaM >= 0 ? fmt(stats.lastShotRenderProxyDeltaM, 3) : 'n/a'}m`}
        {`Rendered body in proxy: ${stats.lastShotRenderedBodyProxyPresent ? 'yes' : 'no'}  proxy toi: ${stats.lastShotRenderedBodyProxyToi >= 0 ? fmt(stats.lastShotRenderedBodyProxyToi, 2) : 'n/a'}  center delta: ${stats.lastShotRenderedBodyProxyCenterDeltaM >= 0 ? fmt(stats.lastShotRenderedBodyProxyCenterDeltaM, 3) : 'n/a'}m`}
        {`Nearest proxy body: ${stats.lastShotNearestProxyBodyId || '—'} @ ${stats.lastShotNearestProxyBodyToi >= 0 ? fmt(stats.lastShotNearestProxyBodyToi, 2) : 'n/a'}  miss/radius: ${stats.lastShotNearestProxyBodyMissDistanceM >= 0 ? fmt(stats.lastShotNearestProxyBodyMissDistanceM, 3) : 'n/a'}/${stats.lastShotNearestProxyBodyRadiusM >= 0 ? fmt(stats.lastShotNearestProxyBodyRadiusM, 3) : 'n/a'}m`}
        {`Nearest render body: ${stats.lastShotNearestRenderedBodyId || '—'} @ ${stats.lastShotNearestRenderedBodyToi >= 0 ? fmt(stats.lastShotNearestRenderedBodyToi, 2) : 'n/a'}  miss/radius: ${stats.lastShotNearestRenderedBodyMissDistanceM >= 0 ? fmt(stats.lastShotNearestRenderedBodyMissDistanceM, 3) : 'n/a'}/${stats.lastShotNearestRenderedBodyRadiusM >= 0 ? fmt(stats.lastShotNearestRenderedBodyRadiusM, 3) : 'n/a'}m`}
        {`Server resolution/body: ${stats.lastShotServerResolution}/${stats.lastShotServerDynamicBodyId || '—'}  toi/impulse: ${stats.lastShotServerDynamicHitToiM >= 0 ? fmt(stats.lastShotServerDynamicHitToiM, 2) : 'n/a'} / ${stats.lastShotServerDynamicImpulseMag >= 0 ? fmt(stats.lastShotServerDynamicImpulseMag, 2) : 'n/a'}`}
      </Section>

      {(stats.vehicleDebugId !== 0 || stats.inVehicle) && (
        <Section title="Vehicle">
          {`ID: ${stats.vehicleDebugId || '—'}  confirmed: ${stats.vehicleDriverConfirmed ? 'yes' : 'no'}`}
          {`Local/server speed: ${fmt(stats.vehicleLocalSpeedMs, 2)} / ${fmt(stats.vehicleServerSpeedMs, 2)} m/s`}
          {`Pos delta: ${fmt(stats.vehiclePosDeltaM, 3)}m  wheels: ${stats.vehicleGroundedWheels}/4`}
          {`Pred/latest/sample auth: ${fmt(stats.vehicleLatestAuthDeltaM, 3)} / ${fmt(stats.vehicleSampledAuthDeltaM, 3)} / ${fmt(stats.vehicleLatestVsSampledAuthDeltaM, 3)}m`}
          {`Pred/current auth: ${fmt(stats.vehicleCurrentAuthDeltaM, 3)}m  mesh/current ${fmt(stats.vehicleMeshCurrentAuthDeltaM, 3)}m`}
          {`Expected lead/unexplained: ${fmt(stats.vehicleExpectedLeadM, 3)} / ${fmt(stats.vehicleCurrentAuthUnexplainedDeltaM, 3)}m`}
          {`Current auth planar/vertical: ${fmt(stats.vehicleCurrentAuthPlanarDeltaM, 3)} / ${fmt(stats.vehicleCurrentAuthVerticalDeltaM, 3)}m`}
          {`Mesh/auth delta: ${fmt(stats.vehicleMeshAuthDeltaM, 3)}m  auth age/sample/current: ${stats.vehicleAuthObservedAgeMs >= 0 ? fmt(stats.vehicleAuthObservedAgeMs, 1) : 'n/a'} / ${stats.vehicleAuthSampleOffsetMs >= 0 ? fmt(stats.vehicleAuthSampleOffsetMs, 1) : 'n/a'} / ${stats.vehicleAuthCurrentOffsetMs >= 0 ? fmt(stats.vehicleAuthCurrentOffsetMs, 1) : 'n/a'}ms`}
          {`Pred frame/planar/heave/yaw: ${fmt(stats.vehiclePredictedFrameDeltaM, 3)}/${fmt(stats.vehiclePredictedPlanarDeltaM, 3)}/${fmt(stats.vehiclePredictedHeaveDeltaM, 3)}m ${fmt(stats.vehiclePredictedYawDeltaRad, 3)}rad`}
          {`Residual frame/planar/heave: ${fmt(stats.vehiclePredictedResidualDeltaM, 3)}/${fmt(stats.vehiclePredictedResidualPlanarDeltaM, 3)}/${fmt(stats.vehiclePredictedResidualHeaveDeltaM, 3)}m`}
          {`Mesh offset/frame rms: ${fmt(stats.vehicleMeshDeltaRms5sM, 3)}/${fmt(stats.vehicleMeshFrameDeltaRms5sM, 3)}m`}
          {`Camera frame rms/peak: ${fmt(stats.vehicleCameraFrameDeltaRms5sM, 3)}/${fmt(stats.vehicleCameraFrameDeltaPeak5sM, 3)}m`}
          {`Raw planar/heave rest/straight rms: ${fmt(stats.vehicleRawPlanarDeltaRms5sM, 3)}/${fmt(stats.vehicleRawRestHeaveDeltaRms5sM, 3)}/${fmt(stats.vehicleRawStraightHeaveDeltaRms5sM, 3)}m`}
          {`Residual planar/heave/yaw rms: ${fmt(stats.vehicleResidualPlanarDeltaRms5sM, 3)}/${fmt(stats.vehicleResidualHeaveDeltaRms5sM, 3)}m ${fmt(stats.vehicleResidualYawDeltaRms5sRad, 3)}rad`}
          {`Raw yaw/pitch/roll peak: ${fmt(stats.vehicleRawYawDeltaPeak5sRad, 3)}/${fmt(stats.vehicleRawPitchDeltaPeak5sRad, 3)}/${fmt(stats.vehicleRawRollDeltaPeak5sRad, 3)}rad`}
          {`Wheel bits/changes 5s: ${fmtBits(stats.vehicleWheelContactBits)} / ${fmt(stats.vehicleWheelContactBitChanges5s, 0)}`}
          {`Susp len spread/delta: ${fmt(stats.vehicleSuspensionLengthSpreadM, 3)} / ${fmt(stats.vehicleSuspensionLengthDeltaRms5sM, 3)}m`}
          {`Susp force spread/delta: ${fmt(stats.vehicleSuspensionForceSpreadN, 1)} / ${fmt(stats.vehicleSuspensionForceDeltaRms5sN, 1)}N`}
          {`Grounded min/max/transitions 5s: ${fmt(stats.vehicleGroundedMin5s, 0)}/${fmt(stats.vehicleGroundedMax5s, 0)}/${stats.vehicleGroundedTransitions5s}`}
          {`Steer: ${fmt(stats.vehicleSteering, 3)}  engine: ${fmt(stats.vehicleEngineForce, 0)}  brake: ${fmt(stats.vehicleBrake, 0)}`}
        </Section>
      )}

      <Section title="Player">
        {`ID: ${stats.playerId}  HP: ${stats.hp}`}
        {`Status: ${fmtFlags(stats.onGround, stats.inVehicle, stats.dead)}`}
        {`Pos: ${fmt(p[0], 2)}, ${fmt(p[1], 2)}, ${fmt(p[2], 2)}`}
        {`Vel: ${fmt(v[0], 2)}, ${fmt(v[1], 2)}, ${fmt(v[2], 2)}`}
        {`Speed: ${fmt(stats.speedMs, 2)} m/s`}
      </Section>

      {stats.heapUsedMb >= 0 && (
        <Section title="System">
          {`Heap: ${fmt(stats.heapUsedMb)} / ${fmt(stats.heapTotalMb)} MB`}
        </Section>
      )}

      {stats.recentEvents.length > 0 && (
        <Section title="Events">
          {stats.recentEvents.join('\n')}
        </Section>
      )}

      <div
        style={{
          color: '#7ca88a',
          marginTop: 8,
          paddingTop: 8,
          borderTop: '1px solid rgba(150, 209, 171, 0.1)',
          fontSize: 11,
        }}
      >
        {`Copy markdown: F4 or ${typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? 'Cmd' : 'Ctrl'}+Shift+D`}
        {'\n'}
        {`Deep capture: ${deepCaptureEnabled ? `ON (${deepCaptureSampleCount} samples)` : 'OFF'}  Toggle: F7`}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const lines = Array.isArray(children) ? children : [children];
  return (
    <section
      style={{
        marginBottom: 8,
        padding: '9px 10px',
        borderRadius: 8,
        background: 'rgba(10, 21, 16, 0.52)',
        border: '1px solid rgba(139, 192, 159, 0.1)',
      }}
    >
      <div
        style={{
          color: '#f3da7b',
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          marginBottom: 5,
        }}
      >
        {title}
      </div>
      <div style={{ display: 'grid', gap: 2 }}>
        {lines.map((line, i) => (
          <div
            key={i}
            style={{
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
              color: '#d5eddc',
            }}
          >
            {line}
          </div>
        ))}
      </div>
    </section>
  );
}
