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

  // Player
  playerId: number;
  position: [number, number, number];
  velocity: [number, number, number];
  speedMs: number;
  hp: number;
  energy: number;
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
  playerId: 0,
  position: [0, 0, 0],
  velocity: [0, 0, 0],
  speedMs: 0,
  hp: 100,
  energy: 0,
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
};

function fmt(n: number, decimals = 1): string {
  return n.toFixed(decimals);
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
  const lines = [
    '# vibe-land debug',
    '',
    `- time: ${new Date().toISOString()}`,
    `- path: ${extras.path ?? (typeof window !== 'undefined' ? window.location.pathname : 'unknown')}`,
    `- connected: ${extras.connected == null ? 'unknown' : extras.connected ? 'yes' : 'no'}`,
    `- status: ${extras.status ?? 'unknown'}`,
    `- user-agent: ${extras.userAgent ?? (typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown')}`,
    `- local_render_smoothing: ${extras.localRenderSmoothingEnabled == null ? 'unknown' : extras.localRenderSmoothingEnabled ? 'on' : 'off'}`,
    '',
    '## Rendering',
    `- fps: ${fmt(stats.fps, 0)}`,
    `- frame_ms: ${fmt(stats.frameTimeMs, 2)}`,
    `- draw_calls: ${stats.drawCalls}`,
    `- triangles: ${stats.triangles}`,
    `- geometries: ${stats.geometries}`,
    `- textures: ${stats.textures}`,
    '',
    '## Network',
    `- transport: ${stats.transport}`,
    `- ping_ms: ${fmt(stats.pingMs, 2)}`,
    `- jitter_ms: ${fmt(stats.jitterMs, 2)}`,
    `- server_tick: ${stats.serverTick}`,
    `- interp_delay_ms: ${fmt(stats.interpolationDelayMs, 2)}`,
    `- dyn_interp_delay_ms: ${fmt(stats.dynamicBodyInterpolationDelayMs, 2)}`,
    `- clock_offset_ms: ${fmt(stats.clockOffsetUs / 1000, 2)}`,
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
    `- vehicle_replay_error_m: ${fmt(stats.vehicleReplayErrorM, 3)}`,
    `- vehicle_pos_error_m: ${fmt(stats.vehiclePosErrorM, 3)}`,
    `- vehicle_vel_error_ms: ${fmt(stats.vehicleVelErrorMs, 3)}`,
    `- vehicle_rot_error_rad: ${fmt(stats.vehicleRotErrorRad, 3)}`,
    `- vehicle_corr_age_ms: ${stats.vehicleCorrectionAgeMs >= 0 ? fmt(stats.vehicleCorrectionAgeMs, 2) : 'n/a'}`,
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
    `- energy: ${fmt(stats.energy, 1)}`,
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

  return lines.join('\n');
}

export function DebugOverlay({
  stats,
  visible,
  localRenderSmoothingEnabled = true,
  onToggleLocalRenderSmoothing,
}: {
  stats: DebugStats;
  visible: boolean;
  localRenderSmoothingEnabled?: boolean;
  onToggleLocalRenderSmoothing?: () => void;
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
      </div>

      <Section title="Rendering">
        {`FPS: ${fmt(stats.fps, 0)}  (${fmt(stats.frameTimeMs)}ms)`}
        {`Draw calls: ${stats.drawCalls}  Tris: ${stats.triangles}`}
        {`Geom: ${stats.geometries}  Tex: ${stats.textures}`}
      </Section>

      <Section title="Network">
        {`Transport: ${stats.transport}`}
        {`Ping: ${fmt(stats.pingMs)}ms  Jitter: ±${fmt(stats.jitterMs)}ms`}
        {`Server tick: ${stats.serverTick}`}
        {`Interp delay: ${stats.interpolationDelayMs.toFixed(2)}ms`}
        {`Dyn interp delay: ${stats.dynamicBodyInterpolationDelayMs.toFixed(2)}ms`}
        {`Clock offset: ${fmt(stats.clockOffsetUs / 1000)}ms`}
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
        {`Vehicle pos/vel/rot err: ${fmt(stats.vehiclePosErrorM, 3)}m ${fmt(stats.vehicleVelErrorMs, 3)}m/s ${fmt(stats.vehicleRotErrorRad, 3)}rad`}
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
          {`Steer: ${fmt(stats.vehicleSteering, 3)}  engine: ${fmt(stats.vehicleEngineForce, 0)}  brake: ${fmt(stats.vehicleBrake, 0)}`}
        </Section>
      )}

      <Section title="Player">
        {`ID: ${stats.playerId}  HP: ${stats.hp}  Energy: ${fmt(stats.energy, 1)}`}
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
