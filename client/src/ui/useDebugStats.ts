import { useEffect, useRef, useState, useCallback } from 'react';
import type { DebugStats } from './DebugOverlay';
import { DEFAULT_STATS } from './DebugOverlay';

const FPS_SAMPLE_COUNT = 60;
const OVERLAY_UPDATE_INTERVAL_MS = 100; // 10Hz UI refresh

export function useDebugStats() {
  const [visible, setVisible] = useState(false);
  const [displayStats, setDisplayStats] = useState<DebugStats>({ ...DEFAULT_STATS });
  const statsRef = useRef<DebugStats>({ ...DEFAULT_STATS });
  const frameTimes = useRef<number[]>([]);
  const snapshotTimestamps = useRef<number[]>([]);
  const lastUiUpdate = useRef(0);
  const visibleRef = useRef(false);

  // F3 toggle
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'F3') {
        e.preventDefault();
        setVisible((v) => {
          visibleRef.current = !v;
          return !v;
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const recordSnapshot = useCallback(() => {
    snapshotTimestamps.current.push(performance.now());
  }, []);

  const updateFrame = useCallback((
    frameTimeMs: number,
    rendererInfo: { render: { calls: number; triangles: number }; memory: { geometries: number; textures: number } },
    network: { pingMs: number; serverTick: number; interpolationDelayMs: number; clockOffsetUs: number; remotePlayers: number },
    physics: { pendingInputs: number; predictionTicks: number; correctionMagnitude: number; physicsStepMs: number },
    position: [number, number, number],
  ) => {
    // Rolling FPS
    const times = frameTimes.current;
    times.push(frameTimeMs);
    if (times.length > FPS_SAMPLE_COUNT) times.shift();
    const avgMs = times.reduce((a, b) => a + b, 0) / times.length;

    // Snapshot rate
    const now = performance.now();
    const snaps = snapshotTimestamps.current;
    while (snaps.length > 0 && snaps[0] < now - 1000) snaps.shift();
    const snapshotsPerSec = snaps.length;

    const s = statsRef.current;
    s.fps = avgMs > 0 ? 1000 / avgMs : 0;
    s.frameTimeMs = frameTimeMs;
    s.drawCalls = rendererInfo.render.calls;
    s.triangles = rendererInfo.render.triangles;
    s.geometries = rendererInfo.memory.geometries;
    s.textures = rendererInfo.memory.textures;
    s.pingMs = network.pingMs;
    s.serverTick = network.serverTick;
    s.interpolationDelayMs = network.interpolationDelayMs;
    s.clockOffsetUs = network.clockOffsetUs;
    s.remotePlayers = network.remotePlayers;
    s.snapshotsPerSec = snapshotsPerSec;
    s.pendingInputs = physics.pendingInputs;
    s.predictionTicks = physics.predictionTicks;
    s.correctionMagnitude = physics.correctionMagnitude;
    s.physicsStepMs = physics.physicsStepMs;
    s.position = position;

    // Throttled React state update for overlay rendering (10Hz)
    if (visibleRef.current && now - lastUiUpdate.current >= OVERLAY_UPDATE_INTERVAL_MS) {
      lastUiUpdate.current = now;
      setDisplayStats({ ...s });
    }
  }, []);

  return { visible, displayStats, updateFrame, recordSnapshot };
}
