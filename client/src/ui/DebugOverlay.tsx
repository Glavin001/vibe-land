export type DebugStats = {
  // Rendering
  fps: number;
  frameTimeMs: number;
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;

  // Network
  pingMs: number;
  serverTick: number;
  interpolationDelayMs: number;
  clockOffsetUs: number;
  remotePlayers: number;
  snapshotsPerSec: number;

  // Physics / Prediction
  pendingInputs: number;
  predictionTicks: number;
  correctionMagnitude: number;
  physicsStepMs: number;

  // Player
  position: [number, number, number];
};

export const DEFAULT_STATS: DebugStats = {
  fps: 0,
  frameTimeMs: 0,
  drawCalls: 0,
  triangles: 0,
  geometries: 0,
  textures: 0,
  pingMs: 0,
  serverTick: 0,
  interpolationDelayMs: 0,
  clockOffsetUs: 0,
  remotePlayers: 0,
  snapshotsPerSec: 0,
  pendingInputs: 0,
  predictionTicks: 0,
  correctionMagnitude: 0,
  physicsStepMs: 0,
  position: [0, 0, 0],
};

function fmt(n: number, decimals = 1): string {
  return n.toFixed(decimals);
}

export function DebugOverlay({ stats, visible }: { stats: DebugStats; visible: boolean }) {
  if (!visible) return null;

  const p = stats.position;

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
        minWidth: 220,
      }}
    >
      <Section title="Rendering">
        {`FPS: ${fmt(stats.fps, 0)}  (${fmt(stats.frameTimeMs)}ms)`}
        {`Draw calls: ${stats.drawCalls}  Tris: ${stats.triangles}`}
        {`Geom: ${stats.geometries}  Tex: ${stats.textures}`}
      </Section>

      <Section title="Network">
        {`Ping: ${fmt(stats.pingMs)}ms`}
        {`Server tick: ${stats.serverTick}`}
        {`Interp delay: ${stats.interpolationDelayMs.toFixed(2)}ms`}
        {`Clock offset: ${fmt(stats.clockOffsetUs / 1000)}ms`}
        {`Remote players: ${stats.remotePlayers}`}
        {`Snapshots/s: ${fmt(stats.snapshotsPerSec, 0)}`}
      </Section>

      <Section title="Physics">
        {`Pending inputs: ${stats.pendingInputs}`}
        {`Prediction ticks: ${stats.predictionTicks}`}
        {`Correction: ${fmt(stats.correctionMagnitude, 3)}m`}
        {`Physics step: ${fmt(stats.physicsStepMs, 2)}ms`}
      </Section>

      <Section title="Player">
        {`Pos: ${fmt(p[0], 2)}, ${fmt(p[1], 2)}, ${fmt(p[2], 2)}`}
      </Section>
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
