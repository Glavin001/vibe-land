// The meteors, mounted in the game world beside the dust.
//
// Each launch the server announced gets a burning rock: the cratered basalt
// from meteorRock with its embers and a light, positioned either from the
// streamed dynamic body when the snapshot carries it (inside 80 m of the
// viewer) or from the arc the launch packet described (everywhere else), and a
// fire volume drawn by MeteorFireStage through the frame pipeline. The arc and
// the body agree to within quantisation until the rock hits something, so the
// handover is invisible; after impact only the body knows where the rock went.

import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';

import { renderStats } from '../city/renderStats';
import { registerPipelineStage } from '../graphics/framePipelineStages';
import type { GameRuntimeClient } from '../runtime/gameRuntime';
import { MeteorFireStage, type MeteorFireInstance } from './MeteorFireStage';
import {
  meteorFlights,
  meteorPositionAt,
  meteorVelocityAt,
  recordMeteorDrawn,
  type MeteorFlight,
} from './meteorFlights';
import {
  buildMeteorEmbers,
  buildMeteorGeometry,
  buildMeteorMaterial,
  layoutEmbers,
  type MeteorEmbers,
  type MeteorSurfaceUniforms,
} from './meteorRock';

type MeteorLayerProps = {
  getRuntime: () => GameRuntimeClient | null;
};

/**
 * Point lights are a per-material shader cost, and changing how many are
 * visible recompiles every material in the scene, so a fixed pool sits in
 * the scene, visible, from mount -- at zero intensity until a meteor borrows
 * one -- and the first rock does not arrive with a compile hitch.
 */
const LIGHT_POOL = 2;

/**
 * A moving body whose newest sample is older than this has left the
 * streaming range. Hot bodies are sent every tick the budget allows; a
 * quarter second is many missed sends, not one.
 */
const STALE_SAMPLE_MS = 250;

interface LiveMeteor {
  flight: MeteorFlight;
  group: THREE.Group;
  rock: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
  surface: MeteorSurfaceUniforms;
  embers: MeteorEmbers;
  /** Tumble, only while the arc is predicted; the body brings its own pose. */
  spin: THREE.Quaternion;
  spinAxis: THREE.Vector3;
  /** Air speed last frame, m/s, for the fire to fade after impact. */
  airSpeed: number;
  /** When the rock last moved fast enough to burn, local ms. */
  lastBurningMs: number;
  intensity: number;
  fire: MeteorFireInstance;
  distanceSq: number;
}

const scratchPos: [number, number, number] = [0, 0, 0];
const scratchVel: [number, number, number] = [0, 0, 0];
const scratchDir = new THREE.Vector3();
const scratchAxis = new THREE.Vector3();
const scratchSpin = new THREE.Quaternion();
const scratchInverse = new THREE.Quaternion();
const BUOYANCY = new THREE.Vector3(0, 3, 0);

export function MeteorLayer({ getRuntime }: MeteorLayerProps) {
  const groupRef = useRef<THREE.Group>(null);
  const live = useRef(new Map<number, LiveMeteor>());
  const geometry = useMemo(() => buildMeteorGeometry(42, 24), []);
  const stage = useMemo(() => new MeteorFireStage(), []);
  const lights = useMemo(
    () => Array.from({ length: LIGHT_POOL }, () => {
      return new THREE.PointLight(0xff641a, 0, 1, 2);
    }),
    [],
  );

  useEffect(() => {
    const unregister = registerPipelineStage(stage);
    return () => {
      unregister();
      stage.dispose();
    };
  }, [stage]);

  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    for (const light of lights) group.add(light);
    return () => {
      for (const light of lights) group.remove(light);
    };
  }, [lights]);

  useEffect(() => {
    const meteors = live.current;
    return () => {
      for (const meteor of meteors.values()) retire(meteor);
      meteors.clear();
      geometry.dispose();
    };
  }, [geometry]);

  useFrame(({ camera }, dt) => {
    const group = groupRef.current;
    if (!group) return;
    const nowMs = performance.now();
    const runtime = getRuntime();
    const flights = meteorFlights(nowMs);
    const meteors = live.current;
    const step = Math.min(0.1, Math.max(0, dt));

    // The arc is evaluated at the SERVER time the body interpolator renders
    // at, in that time base, with no mapping through the local clock: the
    // launch stamp and the snapshot stamps are the same tick clock, so the
    // two coincide by construction when the body appears. Mapping the launch
    // onto performance.now() through the clock estimator's offset put the
    // arc tens of milliseconds ahead on a jittery link -- 7 m at 147 m/s --
    // so the rock visibly jumped back when the body took over.
    const lagMs = runtime?.state?.dynamicBodyInterpolationDelayMs ?? 0;
    const renderServerUs = runtime?.getDynamicBodyRenderTimeUs() ?? null;

    const seen = new Set<number>();
    for (const flight of flights) {
      seen.add(flight.bodyId);
      let meteor = meteors.get(flight.bodyId);
      if (!meteor || meteor.flight !== flight) {
        if (meteor) retire(meteor);
        meteor = spawn(flight, geometry);
        group.add(meteor.group);
        meteors.set(flight.bodyId, meteor);
      }

      const raw = runtime?.state?.dynamicBodies.get(flight.bodyId) ?? null;
      // A body the snapshot has stopped carrying stays in the map with its
      // last state. If it was moving when last seen and nothing has arrived
      // since, it has left the streaming range, and drawing it where it was
      // is a rock hanging in the air. A resting body is refreshed rarely on
      // purpose and is genuinely where it was.
      const sampleAgeMs = raw ? runtime!.getDynamicBodyObservedAgeMs(flight.bodyId) ?? 0 : 0;
      const rawSpeed = raw ? Math.hypot(raw.velocity[0], raw.velocity[1], raw.velocity[2]) : 0;
      const stale = raw !== null && sampleAgeMs > STALE_SAMPLE_MS && rawSpeed > 2;
      const streamed = raw && !stale ? runtime!.getRenderedDynamicBodyState(flight.bodyId) ?? raw : null;
      const forensics = {
        raw: raw ? { position: raw.position, velocity: raw.velocity } : null,
        rendered: streamed ? streamed.position : null,
        interpDelayMs: lagMs,
      };
      let position: ArrayLike<number>;
      let velocity: ArrayLike<number>;
      let source: 'arc' | 'body' | 'hold' = 'arc';
      const arcT = renderServerUs !== null
        ? (renderServerUs - flight.serverLaunchTimeUs) / 1e6
        : (nowMs - lagMs - flight.launchedAtLocalMs) / 1000;
      const arcAt = meteorPositionAt(flight, arcT, [0, 0, 0]);
      if (streamed) {
        source = 'body';
        flight.lastStreamedAtMs = nowMs;
        position = streamed.position;
        velocity = streamed.velocity;
        meteor.group.quaternion.set(
          streamed.quaternion[0],
          streamed.quaternion[1],
          streamed.quaternion[2],
          streamed.quaternion[3],
        );
      } else if (flight.lastStreamedAtMs > 0) {
        source = 'hold';
        // The body was real and now is not: retired at its TTL, bounced out
        // of the snapshot's range, or the viewer walked away from it. The
        // arc knows nothing about where it went after impact -- falling back
        // to it would teleport the rock to the aimed point and leave it
        // hanging there -- so it stays where it was last seen, cold, until
        // the store forgets it.
        scratchPos[0] = meteor.group.position.x;
        scratchPos[1] = meteor.group.position.y;
        scratchPos[2] = meteor.group.position.z;
        position = scratchPos;
        scratchVel[0] = 0; scratchVel[1] = 0; scratchVel[2] = 0;
        velocity = scratchVel;
        meteor.lastBurningMs = Math.min(meteor.lastBurningMs, nowMs - 3000);
      } else {
        const t = arcT;
        if (t < 0) {
          // Announced but not yet launched on this clock: keep it off-screen
          // rather than at the start point for a frame.
          meteor.group.visible = false;
          meteor.intensity = 0;
          recordMeteorDrawn(flight.bodyId, { position: arcAt, source: 'hidden', arc: arcAt, ...forensics, atMs: nowMs });
          continue;
        }
        position = meteorPositionAt(flight, t, scratchPos);
        velocity = meteorVelocityAt(flight, t, scratchVel);
        // Tumbling, slowly, the way the studio's rock does.
        scratchSpin.setFromAxisAngle(meteor.spinAxis, step * 0.45);
        meteor.spin.multiply(scratchSpin);
        meteor.group.quaternion.copy(meteor.spin);
      }
      meteor.group.visible = true;
      meteor.group.position.set(position[0], position[1], position[2]);
      meteor.group.updateMatrixWorld(true);
      recordMeteorDrawn(flight.bodyId, {
        position: [position[0], position[1], position[2]],
        source,
        arc: arcAt,
        ...forensics,
        atMs: nowMs,
      });

      const airSpeed = Math.hypot(velocity[0], velocity[1], velocity[2]);
      meteor.airSpeed = airSpeed;
      if (airSpeed > 12) meteor.lastBurningMs = nowMs;
      // Burning while it flies; on the ground the fire dies over a few
      // seconds and the fissures cool after it.
      const sinceBurning = (nowMs - meteor.lastBurningMs) / 1000;
      const target = airSpeed > 12 ? 1 : Math.max(0, 1 - sinceBurning / 3);
      meteor.intensity += (target - meteor.intensity) * Math.min(1, step * 6);
      meteor.surface.uTime.value += step;
      meteor.surface.uGlow.value = 0.25 + 0.55 * meteor.intensity;

      // Flames point against the motion, lifted by buoyancy.
      scratchDir.set(-velocity[0], -velocity[1], -velocity[2]).add(BUOYANCY);
      if (scratchDir.lengthSq() < 1e-4) scratchDir.set(0, 1, 0);
      scratchDir.normalize();
      // The embers live in the group's frame; the direction goes with them.
      scratchAxis.copy(scratchDir).applyQuaternion(scratchInverse.copy(meteor.group.quaternion).invert());
      layoutEmbers(meteor.embers, scratchAxis, meteor.surface.uTime.value, stage.trail, stage.turbulence);
      meteor.embers.material.uniforms.uTime.value = meteor.surface.uTime.value;
      meteor.embers.material.uniforms.uAmount.value = 0.65 * meteor.intensity;
      meteor.embers.points.visible = meteor.intensity > 0.02;

      meteor.fire.center.copy(meteor.group.position);
      meteor.fire.direction.copy(scratchDir);
      meteor.fire.radiusM = flight.radiusM;
      meteor.fire.airSpeed = airSpeed;
      meteor.fire.intensity = meteor.intensity;
      meteor.fire.inverseRock.copy(meteor.rock.matrixWorld).invert();
      meteor.distanceSq = camera.position.distanceToSquared(meteor.group.position);
    }

    for (const [bodyId, meteor] of meteors) {
      if (seen.has(bodyId)) continue;
      retire(meteor);
      meteors.delete(bodyId);
    }

    // Fire for the nearest few, lights for the nearest couple.
    const visible = Array.from(meteors.values())
      .filter((meteor) => meteor.group.visible && meteor.intensity > 0.01)
      .sort((a, b) => a.distanceSq - b.distanceSq);
    stage.setInstances(visible.map((meteor) => meteor.fire));
    lights.forEach((light, index) => {
      const meteor = visible[index];
      if (!meteor) {
        light.intensity = 0;
        return;
      }
      const r = meteor.flight.radiusM;
      light.position.copy(meteor.fire.direction).multiplyScalar(1.65 * r).add(meteor.group.position);
      light.distance = 14 * r;
      light.intensity = (2.8 + Math.sin(meteor.surface.uTime.value * 7) * 0.3) * meteor.intensity * r * r;
    });
    renderStats.meteorsLive = visible.length;
    if (visible.length === 0) renderStats.meteorFireMs = 0;
  });

  return <group ref={groupRef} name="meteors" />;
}

function spawn(flight: MeteorFlight, geometry: THREE.BufferGeometry): LiveMeteor {
  const { material, uniforms } = buildMeteorMaterial();
  uniforms.uSeed.value = 42 + flight.seed * 7.3;
  const rock = new THREE.Mesh(geometry, material);
  rock.castShadow = true;
  rock.receiveShadow = true;
  // The lab's rock sits in the group with its own slight lean; the tumble
  // is applied to the group so the fire's hollow follows the mesh.
  rock.rotation.z = 0.18;
  const embers = buildMeteorEmbers();
  const group = new THREE.Group();
  group.scale.setScalar(flight.radiusM);
  group.add(rock);
  group.add(embers.points);
  group.visible = false;
  const spinAxis = new THREE.Vector3(
    Math.sin(flight.seed * 12.9898),
    0.6,
    Math.cos(flight.seed * 78.233),
  ).normalize();
  const fire: MeteorFireInstance = {
    center: new THREE.Vector3(),
    direction: new THREE.Vector3(0, 1, 0),
    radiusM: flight.radiusM,
    airSpeed: 0,
    inverseRock: new THREE.Matrix4(),
    seed: 42 + flight.seed * 7.3,
    intensity: 0,
  };
  return {
    flight,
    group,
    rock,
    material,
    surface: uniforms,
    embers,
    spin: new THREE.Quaternion(),
    spinAxis,
    airSpeed: 0,
    lastBurningMs: performance.now(),
    intensity: 0,
    fire,
    distanceSq: Infinity,
  };
}

function retire(meteor: LiveMeteor): void {
  meteor.group.removeFromParent();
  meteor.material.dispose();
  meteor.embers.dispose();
}
