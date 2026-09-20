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
//   /cityreplay?cam=x,y,z,tx,ty,tz  starting camera pose (default: the spawn side)
//   /cityreplay?loop=1              start over when the tape ends
//   /cityreplay?auto=1              run the replay bisect on load and send it
//
// The strip in the bar is the recording machine's frame time along the tape
// (the tape carries it); its red buttons are the worst moments -- one click
// seeks there.
//
// The camera follows the one the tape recorded until you drag or press a
// movement key; CAM: RECORDED re-attaches. Free flight: drag to look, WASD/QE
// to fly, shift for speed; the pose is written back to the URL as you move,
// so a view can be shared and a sweep re-run from it. The governor is off on
// this page -- a bench shows raw cost -- so its trims never hide a hot spot.
// Space plays/pauses, arrows scrub 5 s, R rewinds.

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
import { setGovernorPaused, useDustFluid, useDustMode } from '../app/renderQuality';
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
      /** Jump to a tape time; backwards rewinds first. */
      seek: (ms: number) => Promise<void>;
      setSpeed: (speed: number) => void;
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

/**
 * A free camera: drag to look, WASD to move, Q/E down/up, Shift to go fast,
 * wheel to change speed. Starts at the pose from the URL and writes its pose
 * back there (throttled), so a view can be shared and a sweep re-run from it.
 */
function ReplayCamera({
  pose,
  follow,
  tape,
  timeMs,
  onDetach,
}: {
  pose: ReturnType<typeof parseCamera>;
  /** Follow the camera the tape recorded; any drag or key hands control to you. */
  follow: boolean;
  tape: CityTape | null;
  timeMs: () => number;
  onDetach: () => void;
}) {
  const camera = useThree((state) => state.camera);
  const gl = useThree((state) => state.gl);
  const keys = useRef(new Set<string>());
  const look = useRef({ yaw: 0, pitch: 0, dragging: false, lastX: 0, lastY: 0 });
  const speed = useRef(25);
  const lastUrlWrite = useRef(0);
  const frameCursor = useRef(0);
  const syncLook = () => {
    const euler = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
    look.current.yaw = euler.y;
    look.current.pitch = euler.x;
  };
  useEffect(() => {
    camera.position.set(...pose.position);
    camera.lookAt(new THREE.Vector3(...pose.target));
    syncLook();
    camera.updateProjectionMatrix();
  }, [camera, pose]);
  useEffect(() => {
    const el = gl.domElement;
    const typing = (event: Event) => {
      const target = event.target;
      return target instanceof HTMLElement && !!target.closest('input, textarea, select');
    };
    const onDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      onDetach();
      look.current.dragging = true;
      look.current.lastX = event.clientX;
      look.current.lastY = event.clientY;
      el.setPointerCapture(event.pointerId);
    };
    const onMove = (event: PointerEvent) => {
      if (!look.current.dragging) return;
      const dx = event.clientX - look.current.lastX;
      const dy = event.clientY - look.current.lastY;
      look.current.lastX = event.clientX;
      look.current.lastY = event.clientY;
      look.current.yaw -= dx * 0.0035;
      look.current.pitch = Math.max(-1.5, Math.min(1.5, look.current.pitch - dy * 0.0035));
    };
    const onUp = () => { look.current.dragging = false; };
    const onKey = (down: boolean) => (event: KeyboardEvent) => {
      if (typing(event)) return;
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight'].includes(event.code)) {
        if (down) {
          keys.current.add(event.code);
          if (event.code !== 'ShiftLeft' && event.code !== 'ShiftRight') onDetach();
        } else {
          keys.current.delete(event.code);
        }
        event.preventDefault();
      }
    };
    const onWheel = (event: WheelEvent) => {
      speed.current = Math.max(2, Math.min(200, speed.current * (event.deltaY > 0 ? 0.8 : 1.25)));
    };
    const keyDown = onKey(true);
    const keyUp = onKey(false);
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('wheel', onWheel, { passive: true });
    window.addEventListener('keydown', keyDown);
    window.addEventListener('keyup', keyUp);
    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', keyDown);
      window.removeEventListener('keyup', keyUp);
    };
  }, [gl, onDetach]);
  useFrame((_, dt) => {
    const frames = tape?.frames;
    if (follow && frames && frames.times.length > 0) {
      // The recorded pose at the tape's clock: walk the frame list from the
      // last cursor (it only ever moves a few entries per frame), and hold the
      // free camera's look angles in step so a detach continues from here.
      const t = timeMs();
      let i = frameCursor.current;
      if (i >= frames.times.length || frames.times[i] > t) i = 0;
      while (i + 1 < frames.times.length && frames.times[i + 1] <= t) i += 1;
      frameCursor.current = i;
      const c = frames.camera;
      camera.position.set(c[i * 7], c[i * 7 + 1], c[i * 7 + 2]);
      camera.quaternion.set(c[i * 7 + 3], c[i * 7 + 4], c[i * 7 + 5], c[i * 7 + 6]);
      syncLook();
      return;
    }
    const step = Math.min(0.1, dt);
    const k = keys.current;
    const fast = k.has('ShiftLeft') || k.has('ShiftRight') ? 4 : 1;
    const move = new THREE.Vector3(
      (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0),
      (k.has('KeyE') ? 1 : 0) - (k.has('KeyQ') ? 1 : 0),
      (k.has('KeyS') ? 1 : 0) - (k.has('KeyW') ? 1 : 0),
    );
    camera.quaternion.setFromEuler(new THREE.Euler(look.current.pitch, look.current.yaw, 0, 'YXZ'));
    if (move.lengthSq() > 0) {
      move.normalize().multiplyScalar(speed.current * fast * step);
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
      camera.position.addScaledVector(right, move.x);
      camera.position.y += move.y;
      camera.position.addScaledVector(forward, -move.z);
      const now = performance.now();
      if (now - lastUrlWrite.current > 500) {
        lastUrlWrite.current = now;
        const at = new THREE.Vector3(0, 0, -10).applyQuaternion(camera.quaternion).add(camera.position);
        const cam = [...camera.position.toArray(), ...at.toArray()].map((v) => v.toFixed(1)).join(',');
        const url = new URL(window.location.href);
        url.searchParams.set('cam', cam);
        window.history.replaceState(null, '', url.toString());
      }
    }
  });
  return null;
}

/**
 * The recording machine's frame time along the tape, as a strip: green under
 * the 120 Hz budget, through amber, to red above 25 ms. Click to seek. The
 * hot spots are the three worst half-seconds, as buttons.
 */
function FrameStrip({ tape, timeMs, onSeek }: { tape: CityTape; timeMs: number; onSeek: (ms: number) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frames = tape.frames;
  const duration = tape.header.durationMs;
  const buckets = useMemo(() => {
    if (!frames || frames.times.length === 0) return null;
    const bucketMs = 500;
    const n = Math.ceil(duration / bucketMs);
    const sum = new Float64Array(n);
    const count = new Uint32Array(n);
    const awake = new Uint32Array(n);
    for (let i = 0; i < frames.times.length; i += 1) {
      const b = Math.min(n - 1, Math.floor(frames.times[i] / bucketMs));
      sum[b] += frames.frameMs[i];
      count[b] += 1;
      awake[b] = Math.max(awake[b], frames.awake[i]);
    }
    const mean = Array.from(sum, (v, i) => (count[i] ? v / count[i] : 0));
    const hot = mean
      .map((ms, i) => ({ ms, at: i * bucketMs, awake: awake[i] }))
      .sort((a, b) => b.ms - a.ms)
      .filter((entry, index, all) => all.findIndex((other) => Math.abs(other.at - entry.at) < 3000) === index)
      .slice(0, 3);
    return { bucketMs, mean, hot };
  }, [frames, duration]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !buckets) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);
    const n = buckets.mean.length;
    for (let i = 0; i < n; i += 1) {
      const ms = buckets.mean[i];
      const t = Math.min(1, Math.max(0, (ms - 8.33) / (25 - 8.33)));
      const hue = 120 * (1 - t);
      ctx.fillStyle = ms > 0 ? `hsl(${hue}, 80%, 45%)` : '#333';
      const x = (i / n) * width;
      const h = Math.max(2, Math.min(height, (ms / 40) * height));
      ctx.fillRect(x, height - h, Math.max(1, width / n - 1), h);
    }
    ctx.fillStyle = '#fff';
    const px = (timeMs / duration) * width;
    ctx.fillRect(px - 1, 0, 2, height);
  }, [buckets, timeMs, duration]);
  if (!buckets) return <span style={{ color: '#999' }}>no frame times on this tape</span>;
  return (
    <>
      <canvas
        ref={canvasRef}
        width={320}
        height={28}
        style={{ width: 320, height: 28, background: '#111', cursor: 'pointer' }}
        title="Frame time on the recording machine; click to seek"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          onSeek(((event.clientX - rect.left) / rect.width) * duration);
        }}
      />
      {buckets.hot.map((spot) => (
        <button
          key={spot.at}
          type="button"
          style={{ font: 'inherit', padding: '2px 6px', background: '#3a1a1a', color: '#fdd', border: '1px solid #844' }}
          title={`${Math.round(spot.awake)} chunks awake`}
          onClick={() => onSeek(Math.max(0, spot.at - 1000))}
        >
          {(spot.at / 1000).toFixed(1)}s · {spot.ms.toFixed(0)} ms
        </button>
      ))}
    </>
  );
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
  // Follow the recorded camera until the user takes the controls. Tapes cut
  // before the camera was recorded have no pose to follow.
  const [followCamera, setFollowCamera] = useState(true);
  const detach = useMemo(() => () => setFollowCamera(false), []);
  const [sweepText, setSweepText] = useState<string | null>(null);
  const autoRan = useRef(false);
  const fog = useFogSettings();
  const dustMode = useDustMode();
  const dustFluid = useDustFluid();
  const pose = useMemo(parseCamera, []);

  // A bench shows raw cost: the governor would otherwise trim dust and
  // resolution until the frame fits and the hot spots read 120 Hz.
  useEffect(() => {
    setGovernorPaused(true);
    return () => setGovernorPaused(false);
  }, []);

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
          seek: async (ms) => {
            const current = playerRef.current;
            if (!current) return;
            const wasPlaying = current.playing();
            const speed = current.speed;
            let target = current;
            if (ms < current.timeMs()) {
              target = await mount();
              target.speed = speed;
              target.pause();
            }
            target.fastForward(ms);
            if (wasPlaying) target.play();
            else target.pause();
          },
          setSpeed: (speed) => {
            const current = playerRef.current;
            if (!current) return;
            const wasPlaying = current.playing();
            current.pause();
            current.speed = speed;
            if (wasPlaying) current.play();
          },
        };
        setStatus('');
        if (params.get('auto') === '1' && !autoRan.current) {
          // Unattended: the bisect on this tape's worst window, sent when done.
          autoRan.current = true;
          setSweep('running');
          setStatus('auto: running the replay bisect…');
          try {
            const report = await runReplaySweep();
            const text = formatPerfSweep(report);
            setSweepText(text);
            notePerfSweep(report, text);
            await sendDebugReport(tape.header.matchId);
            setSweep('sent');
            setStatus('auto: bisect sent');
          } catch (error) {
            setSweep('failed');
            setStatus(`auto: bisect failed: ${String(error)}`);
          }
        }
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

  // Space play/pause, arrows 5 s, R rewind -- unless typing in a control.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.closest('input, textarea, select, button')) return;
      const replay = window.__VIBE_REPLAY__;
      const current = playerRef.current;
      if (!replay || !current) return;
      if (event.code === 'Space') {
        event.preventDefault();
        if (current.playing()) current.pause(); else current.play();
      } else if (event.code === 'ArrowLeft') {
        event.preventDefault();
        void replay.seek(Math.max(0, current.timeMs() - 5000));
      } else if (event.code === 'ArrowRight') {
        event.preventDefault();
        void replay.seek(current.timeMs() + 5000);
      } else if (event.code === 'KeyR') {
        void replay.seek(0);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
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
    color: '#ddd', font: '12px ui-monospace, monospace', display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', zIndex: 10,
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
        <ReplayCamera
          pose={pose}
          follow={followCamera && !!tape?.frames && tape.frames.camera.some((v) => v !== 0)}
          tape={tape}
          timeMs={() => playerRef.current?.timeMs() ?? 0}
          onDetach={detach}
        />
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
            <button type="button" style={button} title="Rewind (R)" onClick={() => void window.__VIBE_REPLAY__?.seek(0)}>⏮</button>
            <button type="button" style={button} title="Back 5 s (←)" onClick={() => void window.__VIBE_REPLAY__?.seek(Math.max(0, (playerRef.current?.timeMs() ?? 0) - 5000))}>−5s</button>
            <button type="button" style={{ ...button, minWidth: 64 }} title="Play / pause (space)" onClick={() => (clock.playing ? player.pause() : player.play())}>
              {clock.playing ? '❚❚ PAUSE' : '▶ PLAY'}
            </button>
            <button type="button" style={button} title="Forward 5 s (→)" onClick={() => void window.__VIBE_REPLAY__?.seek((playerRef.current?.timeMs() ?? 0) + 5000)}>+5s</button>
            <input
              type="range"
              min={0}
              max={Math.round(player.durationMs())}
              value={Math.round(Math.min(clock.t, player.durationMs()))}
              onChange={(event) => void window.__VIBE_REPLAY__?.seek(Number(event.target.value))}
              style={{ width: 220 }}
              title="Scrub"
            />
            <span style={{ minWidth: 110 }}>
              {(Math.min(clock.t, player.durationMs()) / 1000).toFixed(1)} / {(player.durationMs() / 1000).toFixed(1)} s{player.ended() ? ' · ended' : ''}
            </span>
            <select
              style={button}
              defaultValue="1"
              title="Playback speed"
              onChange={(event) => window.__VIBE_REPLAY__?.setSpeed(Number(event.target.value))}
            >
              <option value="0.25">0.25×</option>
              <option value="0.5">0.5×</option>
              <option value="1">1×</option>
              <option value="2">2×</option>
            </select>
            <label>
              <input type="checkbox" defaultChecked={player.loop} onChange={(event) => { player.loop = event.target.checked; }} /> loop
            </label>
            <FrameStrip tape={tape!} timeMs={Math.min(clock.t, player.durationMs())} onSeek={(ms) => void window.__VIBE_REPLAY__?.seek(ms)} />
            <button
              type="button"
              style={{ ...button, background: followCamera ? '#1a3a1a' : '#222' }}
              title="Follow the camera the tape recorded; drag or WASD to take over"
              onClick={() => setFollowCamera((value) => !value)}
            >
              {followCamera ? 'CAM: RECORDED' : 'CAM: FREE'}
            </button>
            <span style={{ color: '#999', whiteSpace: 'nowrap' }} title="drag to look · WASD/QE to fly · shift fast · wheel speed · space play · ←/→ 5 s · R rewind">? controls</span>
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
