// /cityreplay: the render bench that draws what the game draws.
//
// A tape recorded on /city (RECORD TAPE in the panel) is played into a real
// CityClient under the real renderer -- the same Canvas props, the same
// RenderGovernor, the same CityEnvironment, chunk, dust and meteor layers,
// the same stats panel -- with no server, no netcode and no physics. The
// scene is deterministic, so REPLAY PERF BISECT can rewind the tape for every
// configuration and measure the same seconds of the same storm each time.
//
//   /cityreplay                     the last tape recorded in this browser
//   /cityreplay?tape=<name>         a named one
//   /cityreplay?cam=x,y,z,tx,ty,tz  camera pose (default: from the spawn side)
//   /cityreplay?loop=1              start over when the tape ends
//
// The camera is fixed: what moves is the city.

import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { FrameClock } from '../scene/FrameClock';
import { RenderGovernor, sceneCanvasProps } from '../scene/RenderGovernor';
import { CityEnvironment, resolveFogColor } from '../scene/CityEnvironment';
import { WorldTerrain } from '../scene/WorldTerrain';
import { CityChunksLayer } from '../scene/CityChunksLayer';
import { DustLayer } from '../vfx/DustLayer';
import { MeteorLayer } from '../vfx/MeteorLayer';
import { CityStatsOverlay } from '../city/CityStatsOverlay';
import { useFogSettings } from '../graphics/fogSettings';
import { useDustFluid, useDustMode } from '../app/renderQuality';
import { DEFAULT_WORLD_DOCUMENT } from '../world/worldDocument';
import { decodeCityTape, listCityTapes, loadCityTape, type CityTape } from '../city/cityTape';
import { createReplayPlayer, loadReplayAssets, type ReplayPlayer } from '../city/cityReplay';
import { formatPerfSweep, runReplaySweep } from '../city/perfSweep';
import { notePerfSweep, sendDebugReport } from '../city/debugReport';

declare global {
  interface Window {
    /** For the replay sweep and harnesses: rewind, and read the tape clock. */
    __VIBE_REPLAY__?: {
      ready: () => boolean;
      timeMs: () => number;
      durationMs: () => number;
      rewind: () => Promise<void>;
      play: () => void;
      pause: () => void;
    };
  }
}

function parseCamera(): { position: [number, number, number]; target: [number, number, number] } {
  const raw = new URLSearchParams(window.location.search).get('cam');
  const parts = raw ? raw.split(',').map(Number) : [];
  if (parts.length === 6 && parts.every(Number.isFinite)) {
    return { position: [parts[0], parts[1], parts[2]], target: [parts[3], parts[4], parts[5]] };
  }
  // The spawn side of the town, a little raised, facing the centre: the rig
  // the storm bench measures from.
  return { position: [0, 14, 140], target: [0, 6, 0] };
}

function ReplayCamera({ pose }: { pose: ReturnType<typeof parseCamera> }) {
  const camera = useThree((state) => state.camera);
  useEffect(() => {
    camera.position.set(...pose.position);
    camera.lookAt(new THREE.Vector3(...pose.target));
    camera.updateProjectionMatrix();
  }, [camera, pose]);
  return null;
}

/** Dispatches the tape every frame, ahead of the city layer (negative priority). */
function ReplayTicker({ playerRef }: { playerRef: React.MutableRefObject<ReplayPlayer | null> }) {
  useFrame(() => {
    playerRef.current?.tick();
  }, -50);
  return null;
}

export function CityReplayPage() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const [tape, setTape] = useState<CityTape | null>(null);
  const [tapes, setTapes] = useState<string[]>([]);
  const [status, setStatus] = useState('loading tape…');
  const [player, setPlayer] = useState<ReplayPlayer | null>(null);
  const playerRef = useRef<ReplayPlayer | null>(null);
  const [clock, setClock] = useState({ t: 0, playing: false });
  const [sweep, setSweep] = useState<'idle' | 'running' | 'sent' | 'failed'>('idle');
  const [sweepText, setSweepText] = useState<string | null>(null);
  const fog = useFogSettings();
  const dustMode = useDustMode();
  const dustFluid = useDustFluid();
  const pose = useMemo(parseCamera, []);

  useEffect(() => {
    void listCityTapes().then(setTapes).catch(() => {});
    void loadCityTape(params.get('tape') ?? 'last')
      .then((loaded) => {
        if (!loaded) setStatus('no tape in this browser — press RECORD TAPE on /city first, or drop a .vltape here');
        else setTape(loaded);
      })
      .catch((error) => setStatus(`tape unreadable: ${String(error)}`));
  }, [params]);

  // The tape into a player: assets once, a fresh client per rewind.
  useEffect(() => {
    if (!tape) return;
    let cancelled = false;
    setStatus(`fetching manifest ${tape.header.manifestHash.slice(0, 8)}…`);
    void loadReplayAssets(tape)
      .then(async (assets) => {
        if (cancelled) return;
        const mount = async () => {
          const next = await createReplayPlayer(tape, assets);
          next.loop = params.get('loop') === '1';
          playerRef.current = next;
          setPlayer(next);
          next.play();
          return next;
        };
        await mount();
        window.__VIBE_REPLAY__ = {
          ready: () => playerRef.current !== null,
          timeMs: () => playerRef.current?.timeMs() ?? 0,
          durationMs: () => playerRef.current?.durationMs() ?? 0,
          rewind: async () => {
            await mount();
          },
          play: () => playerRef.current?.play(),
          pause: () => playerRef.current?.pause(),
        };
        setStatus('');
      })
      .catch((error) => setStatus(`replay failed: ${String(error)}`));
    return () => {
      cancelled = true;
      delete window.__VIBE_REPLAY__;
    };
  }, [tape, params]);

  useEffect(() => {
    const tick = window.setInterval(() => {
      const current = playerRef.current;
      if (current) setClock({ t: current.timeMs(), playing: current.playing() });
    }, 250);
    return () => window.clearInterval(tick);
  }, []);

  const onDrop = async (event: React.DragEvent) => {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (!file) return;
    try {
      setTape(decodeCityTape(new Uint8Array(await file.arrayBuffer())));
    } catch (error) {
      setStatus(`not a tape: ${String(error)}`);
    }
  };

  const bar: React.CSSProperties = {
    position: 'fixed', left: 0, right: 0, bottom: 0, padding: '6px 10px', background: 'rgba(0,0,0,0.6)',
    color: '#ddd', font: '12px ui-monospace, monospace', display: 'flex', gap: 12, alignItems: 'center', zIndex: 10,
  };
  const button: React.CSSProperties = { font: 'inherit', padding: '2px 8px', background: '#222', color: '#eee', border: '1px solid #555' };

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: '#000' }}
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
    >
      <Canvas {...sceneCanvasProps()} style={{ width: '100%', height: '100%' }} data-testid="replay-canvas">
        <RenderGovernor />
        <FrameClock />
        <ReplayCamera pose={pose} />
        <ReplayTicker playerRef={playerRef} />
        <CityEnvironment
          fogEnabled={fog.enabled}
          fogDensity={fog.density}
          fogColor={fog.color ?? undefined}
          weather={fog.weather}
          windStrengthMps={fog.windStrengthMps}
          windDirectionDeg={fog.windDirectionDeg}
          intensity={fog.intensity}
        />
        <WorldTerrain world={DEFAULT_WORLD_DOCUMENT} />
        <CityChunksLayer getCityClient={() => playerRef.current?.client ?? null} />
        <MeteorLayer getRuntime={() => null} />
        <DustLayer
          getCityClient={() => playerRef.current?.client ?? null}
          getDynamicBodies={() => null}
          mode={dustMode}
          fluid={dustFluid}
          fogColor={resolveFogColor(fog.color ?? undefined, fog.weather)}
          windStrengthMps={fog.windStrengthMps}
          windDirectionDeg={fog.windDirectionDeg}
        />
      </Canvas>
      {tape && (
        <CityStatsOverlay
          matchId={tape.header.matchId}
          statsBaseUrl=""
          getCityStats={() => window.__VIBE_E2E__?.snapshot().city ?? null}
          transport="replay"
          pingMs={0}
        />
      )}
      {sweepText && (
        <pre
          style={{ position: 'fixed', top: 8, right: 8, maxWidth: '60vw', maxHeight: '80vh', overflow: 'auto', margin: 0,
            padding: 10, background: 'rgba(0,0,0,0.8)', color: '#ddd', font: '11px ui-monospace, monospace', zIndex: 11 }}
          onClick={() => setSweepText(null)}
          title="click to dismiss"
        >
          {sweepText}
        </pre>
      )}
      <div style={bar}>
        <strong>/cityreplay</strong>
        {status && <span style={{ color: '#f9c' }}>{status}</span>}
        {tape && (
          <span>
            {tape.header.capturedAt.slice(0, 19)} · {Math.round(tape.header.durationMs / 1000)} s ·{' '}
            {(tape.header.bytes / 1e6).toFixed(1)} MB · {tape.header.packets} packets
          </span>
        )}
        {player && (
          <>
            <span>{(Math.min(clock.t, player.durationMs()) / 1000).toFixed(1)} / {(player.durationMs() / 1000).toFixed(1)} s{player.ended() ? ' · ended' : ''}</span>
            <button type="button" style={button} onClick={() => (clock.playing ? player.pause() : player.play())}>
              {clock.playing ? 'PAUSE' : 'PLAY'}
            </button>
            <button type="button" style={button} onClick={() => void window.__VIBE_REPLAY__?.rewind()}>
              REWIND
            </button>
            <label>
              <input type="checkbox" defaultChecked={player.loop} onChange={(event) => { player.loop = event.target.checked; }} /> loop
            </label>
            <button
              type="button"
              style={button}
              disabled={sweep === 'running'}
              title="Plays the tape once to find its worst 8 s, then rewinds it for every configuration and measures those same seconds each time; ~4 min; shows the table and sends it to the server"
              onClick={() => {
                setSweep('running');
                setSweepText(null);
                void runReplaySweep()
                  .then(async (report) => {
                    const text = formatPerfSweep(report);
                    setSweepText(text);
                    notePerfSweep(report, text);
                    try {
                      await sendDebugReport(tape?.header.matchId ?? 'city-default');
                      setSweep('sent');
                    } catch {
                      setSweep('failed');
                    }
                  })
                  .catch(() => setSweep('failed'));
              }}
            >
              {sweep === 'running' ? 'MEASURING… (~4 min)' : sweep === 'sent' ? 'REPLAY PERF BISECT (SENT)' : 'REPLAY PERF BISECT'}
            </button>
          </>
        )}
        {tapes.length > 0 && (
          <select
            style={{ ...button, marginLeft: 'auto' }}
            value={params.get('tape') ?? 'last'}
            onChange={(event) => { window.location.search = `?tape=${encodeURIComponent(event.target.value)}`; }}
          >
            <option value="last">last tape</option>
            {tapes.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        )}
      </div>
    </div>
  );
}
