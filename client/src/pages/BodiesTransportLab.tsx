import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';

import { RbwtState, type RbwtSnapshot } from '../bodies/rbwt';
import {
  connectBodyTransport,
  loadBodyLabConfig,
  type BodyConnection,
  type BodyLabConfig,
  type BodyMotionMode,
  type BodyTransportMode,
} from '../bodies/transports';

declare global {
  interface Window {
    __RBWT_BODIES__?: {
      snapshot(): RbwtSnapshot;
      disconnect(): Promise<void>;
    };
  }
}

interface DisplayMetrics {
  mbps: number;
  datagramsPerSecond: number;
  bodyUpdatesPerSecond: number;
  lossPercent: number;
  latencyP50: number | null;
  latencyP95: number | null;
}

const EMPTY_METRICS: DisplayMetrics = {
  mbps: 0,
  datagramsPerSecond: 0,
  bodyUpdatesPerSecond: 0,
  lossPercent: 0,
  latencyP50: null,
  latencyP95: null,
};

export function BodiesTransportLabPage() {
  const initial = useMemo(() => loadBodyLabConfig(window.location.search), []);
  const noCanvas = useMemo(
    () => new URLSearchParams(window.location.search).get('norender') === '1',
    [],
  );
  const [config, setConfig] = useState(initial);
  const [engine, setEngine] = useState(() => new RbwtState(initial.bodies));
  const [connection, setConnection] = useState<BodyConnection | null>(null);
  const [status, setStatus] = useState('Ready');
  const [paused, setPaused] = useState(
    () => new URLSearchParams(window.location.search).get('pause') === '1',
  );
  const [metrics, setMetrics] = useState(EMPTY_METRICS);
  const [version, setVersion] = useState(0);
  const autostarted = useRef(false);

  const disconnect = useCallback(async () => {
    await connection?.close().catch(() => undefined);
    engine.connected = false;
    setConnection(null);
    setStatus('Disconnected');
  }, [connection, engine]);

  const connect = useCallback(async () => {
    await connection?.close().catch(() => undefined);
    const nextEngine = new RbwtState(config.bodies);
    nextEngine.transport = config.transport;
    setEngine(nextEngine);
    setStatus(`Connecting through ${config.transport === 'moq' ? 'Cloudflare MoQ' : 'direct WebTransport'}…`);
    try {
      const nextConnection = await connectBodyTransport(
        config,
        (bytes, receiveWallUs) => { nextEngine.apply(bytes, receiveWallUs); },
        ({ rttMs, offsetUs }) => {
          nextEngine.clockRttMs = rttMs;
          nextEngine.clockOffsetUs = offsetUs;
        },
        (reason) => {
          nextEngine.connected = false;
          setStatus(reason);
          setConnection(null);
        },
      );
      await nextConnection.setMotionMode(config.motion).catch(async (error) => {
        await nextConnection.close().catch(() => undefined);
        throw error;
      });
      nextEngine.connected = true;
      setConnection(nextConnection);
      setStatus(
        `Live — ${config.transport === 'moq' ? `${config.shards} MoQ tracks` : 'direct'} · `
        + `${config.bodies.toLocaleString()} bodies · ${motionLabel(config.motion)}`,
      );
    } catch (error) {
      nextEngine.connected = false;
      setStatus(`Connection failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [config, connection]);

  const replayMotion = useCallback(async () => {
    try {
      if (!connection) throw new Error('connect before resetting bodies');
      setStatus('Resetting the shared body timeline…');
      await connection.resetMotion();
      setStatus(`Live — ${motionLabel(config.motion)} restarted in sync`);
    } catch (error) {
      setStatus(`Reset failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [config, connection]);

  const changeMotion = useCallback(async (motion: BodyMotionMode) => {
    patchConfig(setConfig, { motion });
    if (!connection) return;
    try {
      setStatus(`Switching every viewer to ${motionLabel(motion)}…`);
      await connection.setMotionMode(motion);
      setStatus(`Live — every viewer switched to ${motionLabel(motion)} at phase zero`);
    } catch (error) {
      setStatus(`Mode change failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [connection]);

  useEffect(() => {
    if (initial.autostart && !autostarted.current) {
      autostarted.current = true;
      void connect();
    }
  }, [connect, initial.autostart]);

  useEffect(() => {
    let previous = engine.snapshot();
    let previousAt = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now();
      const current = engine.snapshot();
      const seconds = Math.max(0.001, (now - previousAt) / 1000);
      const datagrams = current.datagrams - previous.datagrams;
      const missing = current.missingPackets - previous.missingPackets;
      const span = datagrams + missing;
      const latency = [...current.latencyValues].sort((a, b) => a - b);
      setMetrics({
        mbps: (current.receivedBytes - previous.receivedBytes) * 8 / seconds / 1_000_000,
        datagramsPerSecond: datagrams / seconds,
        bodyUpdatesPerSecond: (current.bodyUpdates - previous.bodyUpdates) / seconds,
        lossPercent: span > 0 ? missing * 100 / span : 0,
        latencyP50: percentile(latency, 0.5),
        latencyP95: percentile(latency, 0.95),
      });
      previous = current;
      previousAt = now;
      setVersion((value) => value + 1);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [engine]);

  useEffect(() => {
    window.__RBWT_BODIES__ = {
      snapshot: () => engine.snapshot(),
      disconnect,
    };
    return () => { delete window.__RBWT_BODIES__; };
  }, [disconnect, engine]);

  useEffect(() => () => { void connection?.close(); }, [connection]);

  const snapshot = engine.snapshot();
  void version;
  return (
    <main style={styles.root}>
      {!noCanvas && (
        <Canvas
          camera={{ position: [28, 24, 34], fov: 52, far: 600 }}
          dpr={[1, 2]}
          frameloop={paused ? 'demand' : 'always'}
        >
          <color attach="background" args={['#070a0f']} />
          <fogExp2 attach="fog" args={['#070a0f', 0.012]} />
          <ambientLight intensity={1.3} />
          <hemisphereLight args={['#9edcff', '#151b27', 2.2]} />
          <directionalLight position={[20, 32, 12]} intensity={3} />
          <BodyInstances key={engine.bodies} engine={engine} paused={paused} />
          <mesh rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[240, 240]} />
            <meshStandardMaterial color="#0b1119" roughness={0.92} metalness={0.05} />
          </mesh>
          <gridHelper args={[240, 120, '#23516a', '#172331']} position={[0, 0.012, 0]} />
          <OrbitControls target={[0, 7, 0]} enableDamping minDistance={3} maxDistance={180} />
        </Canvas>
      )}

      <section style={styles.panel}>
        <div style={styles.header}>
          <div style={styles.eyebrow}>RBWT TRANSPORT LAB</div>
          <h1 style={{ margin: 0, fontSize: 18 }}>Direct WebTransport / Cloudflare MoQ</h1>
          <div style={{ color: snapshot.connected ? '#4ee3a1' : '#8c9caf', marginTop: 6 }}>{status}</div>
        </div>

        <div style={styles.controls}>
          <Field label="Transport">
            <select value={config.transport} disabled={Boolean(connection)}
              onChange={(event) => patchConfig(setConfig, { transport: event.target.value as BodyTransportMode })}>
              <option value="direct">Direct WT</option>
              <option value="moq">Cloudflare MoQ</option>
            </select>
          </Field>
          <Field label="Motion">
            <select value={config.motion}
              onChange={(event) => void changeMotion(event.target.value as BodyMotionMode)}>
              <option value="wave">Traveling wave (sync test)</option>
              <option value="formation">Rigid formation orbit</option>
              <option value="collapse">High collapse</option>
            </select>
          </Field>
          <Field label="Bodies">
            <select value={config.bodies} disabled={Boolean(connection)}
              onChange={(event) => patchConfig(setConfig, { bodies: Number(event.target.value) })}>
              {[1000, 5000, 10000, 25000, 50000].map((value) => <option key={value}>{value}</option>)}
            </select>
          </Field>
          <Field label="Hz">
            <select value={config.hz} disabled={Boolean(connection)}
              onChange={(event) => patchConfig(setConfig, { hz: Number(event.target.value) })}>
              {[10, 20, 30, 60, 120].map((value) => <option key={value}>{value}</option>)}
            </select>
          </Field>
          <Field label="Mbps cap">
            <input value={config.mbps ?? ''} placeholder="none" disabled={Boolean(connection)}
              onChange={(event) => patchConfig(setConfig, {
                mbps: event.target.value ? Number(event.target.value) : null,
              })} />
          </Field>
          {config.transport === 'moq' && (
            <>
              <Field label="Shards">
                <input type="number" min={1} max={16} value={config.shards} disabled={Boolean(connection)}
                  onChange={(event) => patchConfig(setConfig, { shards: Number(event.target.value) })} />
              </Field>
              <Field label="Namespace">
                <input value={config.namespace} disabled={Boolean(connection)}
                  onChange={(event) => patchConfig(setConfig, { namespace: event.target.value })} />
              </Field>
              <Field label="Relay">
                <input value={config.relay} disabled={Boolean(connection)}
                  onChange={(event) => patchConfig(setConfig, { relay: event.target.value })} />
              </Field>
              <Field label="Token">
                <input type="password" value={config.token} disabled={Boolean(connection)}
                  onChange={(event) => patchConfig(setConfig, { token: event.target.value })} />
              </Field>
              <Field label="Relay cert hash">
                <input value={config.moqCertHash} placeholder="local relay only" disabled={Boolean(connection)}
                  onChange={(event) => patchConfig(setConfig, { moqCertHash: event.target.value })} />
              </Field>
            </>
          )}
          {config.transport === 'direct' && (
            <>
              <Field label="Direct endpoint">
                <input value={config.directUrl} disabled={Boolean(connection)}
                  onChange={(event) => patchConfig(setConfig, { directUrl: event.target.value })} />
              </Field>
              <Field label="Cert hash">
                <input type="password" value={config.directCertHash} disabled={Boolean(connection)}
                  onChange={(event) => patchConfig(setConfig, { directCertHash: event.target.value })} />
              </Field>
            </>
          )}
          <div style={styles.actions}>
            <button type="button" onClick={() => void connect()} disabled={Boolean(connection)}>Connect</button>
            <button type="button" onClick={() => void replayMotion()} disabled={!connection}>Reset bodies</button>
            <button type="button" onClick={() => setPaused((value) => !value)} disabled={!connection}>
              {paused ? 'Resume render' : 'Pause render'}
            </button>
            <button type="button" onClick={() => void disconnect()} disabled={!connection}>Disconnect</button>
          </div>
          {config.transport === 'moq' && (
            <small style={{ color: '#8c9caf', gridColumn: '1 / -1' }}>
              Body count, rate, budget, and shards must match the publisher launch configuration.
            </small>
          )}
        </div>

        <div style={styles.metrics}>
          <Metric label="Receive" value={`${metrics.mbps.toFixed(2)} Mbps`} />
          <Metric label="Datagrams" value={`${metrics.datagramsPerSecond.toFixed(0)} /s`} />
          <Metric label="Body updates" value={`${metrics.bodyUpdatesPerSecond.toFixed(0)} /s`} />
          <Metric label="Loss" value={`${metrics.lossPercent.toFixed(2)}%`} />
          <Metric label="Timeline" value={`frame ${snapshot.latestFrame}`} />
          <Metric label="Visible" value={`${snapshot.visibleBodies.toLocaleString()} / ${snapshot.bodies.toLocaleString()}`} />
          <Metric label="One-way p50/p95" value={formatLatency(metrics.latencyP50, metrics.latencyP95)} />
          <Metric label="RTT" value={snapshot.clockRttMs == null ? 'unavailable' : `${snapshot.clockRttMs.toFixed(1)} ms`} />
          <Metric label="Render" value={`${snapshot.fps.toFixed(0)} FPS · ${snapshot.frameMs.toFixed(1)} ms`} />
          <Metric label="Max datagram" value={connection?.maxDatagramSize ? `${connection.maxDatagramSize} B` : '—'} />
          <Metric label="Trace samples" value={String(snapshot.traces.length)} />
          <Metric label="Rendered updates" value={snapshot.renderedUpdates.toLocaleString()} />
        </div>
      </section>
    </main>
  );
}

function BodyInstances({ engine, paused }: { engine: RbwtState; paused: boolean }) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const matrix = useMemo(() => new THREE.Matrix4(), []);
  const position = useMemo(() => new THREE.Vector3(), []);
  const rotation = useMemo(() => new THREE.Quaternion(), []);
  const scale = useMemo(() => new THREE.Vector3(1, 1, 1), []);
  const started = useRef(performance.now());
  const frames = useRef(0);
  const previous = useRef(performance.now());

  useEffect(() => {
    if (!mesh.current) return;
    scale.setScalar(0);
    matrix.compose(position.set(0, 0, 0), rotation.identity(), scale);
    for (let id = 0; id < engine.bodies; id += 1) {
      mesh.current.setMatrixAt(id, matrix);
      mesh.current.setColorAt(id, new THREE.Color('#4ee3a1'));
    }
    mesh.current.instanceMatrix.needsUpdate = true;
    if (mesh.current.instanceColor) mesh.current.instanceColor.needsUpdate = true;
    scale.setScalar(1);
  }, [engine, matrix, position, rotation, scale]);

  useFrame(() => {
    const now = performance.now();
    engine.frameMs += ((now - previous.current) - engine.frameMs) * 0.12;
    previous.current = now;
    frames.current += 1;
    if (now - started.current >= 500) {
      engine.fps = frames.current * 1000 / (now - started.current);
      frames.current = 0;
      started.current = now;
    }
    if (paused || !mesh.current || engine.dirtyQueue.length === 0) return;
    for (const id of engine.dirtyQueue) {
      position.fromArray(engine.positions, id * 3);
      rotation.fromArray(engine.rotations, id * 4);
      matrix.compose(position, rotation, scale);
      mesh.current.setMatrixAt(id, matrix);
      const stale = now - engine.lastUpdate[id] > 500;
      mesh.current.setColorAt(id, new THREE.Color(stale ? '#ff6478' : engine.flags[id] & 1 ? '#4c91ff' : '#4ee3a1'));
      engine.dirty[id] = 0;
      engine.renderedUpdates += 1;
    }
    engine.dirtyQueue.length = 0;
    mesh.current.instanceMatrix.needsUpdate = true;
    if (mesh.current.instanceColor) mesh.current.instanceColor.needsUpdate = true;
  });

  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, engine.bodies]} frustumCulled={false}>
      <boxGeometry args={[0.72, 0.72, 0.72]} />
      <meshStandardMaterial
        vertexColors
        roughness={0.48}
        metalness={0.08}
        emissive="#102535"
        emissiveIntensity={0.65}
      />
    </instancedMesh>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label style={styles.field}><span>{label}</span>{children}</label>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><div style={styles.metricLabel}>{label}</div><div style={{ fontSize: 14 }}>{value}</div></div>;
}

function patchConfig(
  setConfig: React.Dispatch<React.SetStateAction<BodyLabConfig>>,
  patch: Partial<BodyLabConfig>,
) {
  setConfig((current) => ({ ...current, ...patch }));
}

function motionLabel(mode: BodyMotionMode): string {
  if (mode === 'wave') return 'traveling wave';
  if (mode === 'formation') return 'rigid formation orbit';
  return 'high collapse';
}

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  return values[Math.min(values.length - 1, Math.floor(values.length * fraction))];
}

function formatLatency(p50: number | null, p95: number | null): string {
  return p50 === null || p95 === null ? 'clock unavailable' : `${p50.toFixed(1)} / ${p95.toFixed(1)} ms`;
}

const styles: Record<string, React.CSSProperties> = {
  root: { width: '100vw', height: '100vh', background: '#070a0f', color: '#edf4ff', fontFamily: 'monospace' },
  panel: {
    position: 'fixed', left: 16, top: 16, zIndex: 10, width: 500, maxHeight: 'calc(100vh - 32px)',
    overflow: 'auto', background: 'rgba(13,18,26,.94)', border: '1px solid #263142', borderRadius: 10,
  },
  header: { padding: 16, borderBottom: '1px solid #263142' },
  eyebrow: { color: '#62e6ff', fontSize: 10, letterSpacing: '.15em', marginBottom: 5 },
  controls: { padding: 14, display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 9, borderBottom: '1px solid #263142' },
  field: { display: 'grid', gap: 4, color: '#8c9caf', fontSize: 10 },
  actions: { gridColumn: '1 / -1', display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 },
  metrics: { padding: 14, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 },
  metricLabel: { color: '#8c9caf', fontSize: 9, textTransform: 'uppercase', letterSpacing: '.08em' },
};
