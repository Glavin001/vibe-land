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
  clockOffsetUs: number;
  remotePlayers: number;
  snapshotsPerSec: number;
  jitterMs: number;
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
  physicsStepMs: number;

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
  clockOffsetUs: 0,
  remotePlayers: 0,
  snapshotsPerSec: 0,
  jitterMs: 0,
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
  physicsStepMs: 0,
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
    `- clock_offset_ms: ${fmt(stats.clockOffsetUs / 1000, 2)}`,
    `- remote_players: ${stats.remotePlayers}`,
    `- snapshots_per_sec: ${fmt(stats.snapshotsPerSec, 0)}`,
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
    `- physics_step_ms: ${fmt(stats.physicsStepMs, 2)}`,
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

  return lines.join('\n');
}

export function DebugOverlay({ stats, visible }: { stats: DebugStats; visible: boolean }) {
  if (!visible) return null;

  const p = stats.position;
  const v = stats.velocity;

  return (
    <div
      style={{
        position: 'absolute',
        top: 8,
        right: 8,
        zIndex: 20,
        background: 'rgba(0, 0, 0, 0.75)',
        color: '#0f0',
        fontFamily: 'monospace',
        fontSize: 12,
        lineHeight: 1.5,
        padding: '8px 12px',
        borderRadius: 4,
        pointerEvents: 'none',
        whiteSpace: 'pre',
        minWidth: 240,
      }}
    >
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
        {`Clock offset: ${fmt(stats.clockOffsetUs / 1000)}ms`}
        {`Remote players: ${stats.remotePlayers}`}
        {`Snapshots/s: ${fmt(stats.snapshotsPerSec, 0)}`}
        {`Rapier debug: ${stats.rapierDebugLabel}`}
      </Section>

      <Section title="Physics">
        {`Pending inputs: ${stats.pendingInputs}`}
        {`Prediction ticks: ${stats.predictionTicks}`}
        {`Player corr: ${fmt(stats.playerCorrectionMagnitude, 3)}m`}
        {`Vehicle corr: ${fmt(stats.vehicleCorrectionMagnitude, 3)}m`}
        {`Dyn global max: ${fmt(stats.dynamicGlobalMaxCorrectionMagnitude, 3)}m`}
        {`Dyn near max: ${fmt(stats.dynamicNearPlayerMaxCorrectionMagnitude, 3)}m`}
        {`Dyn interact max: ${fmt(stats.dynamicInteractiveMaxCorrectionMagnitude, 3)}m`}
        {`Dyn >25cm: ${stats.dynamicOverThresholdCount}`}
        {`Dynamic bodies: ${stats.dynamicTrackedBodies}  interactive: ${stats.dynamicInteractiveBodies}`}
        {`Physics step: ${fmt(stats.physicsStepMs, 2)}ms`}
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

      <div style={{ color: '#8fd18f', marginTop: 6 }}>
        {`Copy markdown: F4 or ${typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? 'Cmd' : 'Ctrl'}+Shift+D`}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 4 }}>
      <div style={{ color: '#ff0', fontWeight: 'bold' }}>{`— ${title} —`}</div>
      {Array.isArray(children)
        ? children.map((line, i) => <div key={i}>{line}</div>)
        : <div>{children}</div>
      }
    </div>
  );
}
