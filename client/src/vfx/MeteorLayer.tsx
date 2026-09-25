// The meteors, mounted in the game world beside the dust.
//
// Each launch the server announced gets a burning rock: the cratered basalt
// from meteorRock with its embers and a light, and a fire volume drawn by
// MeteorFireStage through the frame pipeline. Where it is drawn -- on the arc
// the launch packet described until a streamed snapshot shows contact, then
// from the streamed body -- is decided by `placeMeteor` (meteorPlacement.ts),
// which the tape tools call too.

import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';

import { renderStats } from '../city/renderStats';
import { registerPipelineStage } from '../graphics/framePipelineStages';
import type { DynamicBodySample } from '../net/interpolation';
import type { DynamicBodyStateMeters } from '../net/protocol';
import { MeteorFireStage, type MeteorFireInstance } from './MeteorFireStage';
import { meteorFlights, recordMeteorDrawn, type MeteorFlight } from './meteorFlights';
import { METEOR_TICK_US, placeMeteorInFrame } from './meteorPlacement';
import {
  buildMeteorEmbers,
  buildMeteorGeometry,
  buildMeteorMaterial,
  layoutEmbers,
  type MeteorEmbers,
  type MeteorSurfaceUniforms,
} from './meteorRock';

/**
 * Where the streamed meteor bodies come from: the live game runtime, or the
 * netcode client /cityreplay runs on a tape.
 */
export type MeteorBodySource = {
  state: {
    dynamicBodies: Map<number, DynamicBodyStateMeters>;
    dynamicBodyInterpolationDelayMs: number;
  };
  getDynamicBodyRenderTimeUs(): number;
  getDynamicBodyObservedAgeMs(id: number): number | null;
  getRenderedDynamicBodyState(id: number): DynamicBodyStateMeters | null;
  /** The body's buffered snapshots, oldest first. */
  getDynamicBodySamples(id: number): readonly DynamicBodySample[];
  /** Server ticks of snapshots since the body was last in one. */
  getDynamicBodyTicksSinceSeen(id: number): number | null;
  /** The lead a free-falling body is drawn at past the render time, us (net/bodyLead.ts). */
  getDynamicBodyLeadHorizonUs?(): number;
};

type MeteorLayerProps = {
  getRuntime: () => MeteorBodySource | null;
  /**
   * The clock flights are registered on, ms; `performance.now()` unless
   * given. The replay runs meteors on the tape's clock, so they pause, slow
   * down and speed up with it.
   */
  getNowMs?: () => number;
};

/**
 * Point lights are a per-material shader cost, and changing how many are
 * visible recompiles every material in the scene, so a fixed pool sits in
 * the scene, visible, from mount -- at zero intensity until a meteor borrows
 * one -- and the first rock does not arrive with a compile hitch.
 */
const LIGHT_POOL = 2;

const TICK_US = METEOR_TICK_US;

interface LiveMeteor {
  flight: MeteorFlight;
  group: THREE.Group;
  rock: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
  surface: MeteorSurfaceUniforms;
  embers: MeteorEmbers;
  /** Air speed last frame, m/s, for the fire to fade after impact. */
  airSpeed: number;
  /** When the rock last moved fast enough to burn, local ms. */
  lastBurningMs: number;
  intensity: number;
  fire: MeteorFireInstance;
  distanceSq: number;
}

const scratchDir = new THREE.Vector3();
const scratchAxis = new THREE.Vector3();
const scratchInverse = new THREE.Quaternion();
const BUOYANCY = new THREE.Vector3(0, 3, 0);

export function MeteorLayer({ getRuntime, getNowMs }: MeteorLayerProps) {
  const groupRef = useRef<THREE.Group>(null);
  const live = useRef(new Map<number, LiveMeteor>());
  const lastNowMs = useRef<number | null>(null);
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
    const nowMs = getNowMs ? getNowMs() : performance.now();
    const runtime = getRuntime();
    const meteors = live.current;
    // On a given clock the animation steps with it: still while it is paused.
    const clockDt = getNowMs ? (nowMs - (lastNowMs.current ?? nowMs)) / 1000 : dt;
    lastNowMs.current = nowMs;
    const step = Math.min(0.1, Math.max(0, clockDt));

    // The arc is evaluated at the SERVER time the body interpolator renders
    // at, in that time base, with no mapping through the local clock: the
    // launch stamp and the snapshot stamps are the same tick clock.
    const lagMs = runtime?.state?.dynamicBodyInterpolationDelayMs ?? 0;
    const renderServerUs = runtime?.getDynamicBodyRenderTimeUs() ?? null;
    const flights = meteorFlights(nowMs, renderServerUs);

    const seen = new Set<number>();
    for (const flight of flights) {
      seen.add(flight.bodyId);
      let meteor = meteors.get(flight.bodyId);
      if (!meteor || meteor.flight !== flight) {
        if (meteor) retire(meteor);
        meteor = spawn(flight, geometry, nowMs);
        group.add(meteor.group);
        meteors.set(flight.bodyId, meteor);
      }

      const raw = runtime?.state?.dynamicBodies.get(flight.bodyId) ?? null;
      // Where it is drawn (meteorPlacement.ts, shared with Netlab v2).
      const placed = placeMeteorInFrame(flight, runtime, { renderServerUs, lagMs, nowMs, tickUs: TICK_US });
      const forensics = {
        raw: raw ? { position: raw.position, velocity: raw.velocity } : null,
        rendered: placed.source === 'body' ? placed.position : null,
        interpDelayMs: lagMs,
      };
      if (placed.source === 'hidden') {
        // Announced but not yet launched on this clock, or its body has left
        // the stream: keep it off-screen rather than where it no longer is.
        meteor.group.visible = false;
        meteor.intensity = 0;
        recordMeteorDrawn(flight.bodyId, { position: placed.arc, source: 'hidden', arc: placed.arc, ...forensics, atMs: nowMs });
        continue;
      }
      const { position, velocity } = placed;
      if (placed.source === 'body') {
        flight.lastStreamedAtMs = nowMs;
      }
      // From the body, or the arc's tumble (meteorPlacement.ts `arcTumble`),
      // which meets the body's orientation at the planned landing.
      const q = placed.quaternion ?? [0, 0, 0, 1];
      meteor.group.quaternion.set(q[0], q[1], q[2], q[3]);
      meteor.group.visible = true;
      meteor.group.position.set(position[0], position[1], position[2]);
      meteor.group.updateMatrixWorld(true);
      recordMeteorDrawn(flight.bodyId, {
        position: [position[0], position[1], position[2]],
        source: placed.source,
        arc: placed.arc,
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

function spawn(flight: MeteorFlight, geometry: THREE.BufferGeometry, nowMs: number): LiveMeteor {
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
    airSpeed: 0,
    lastBurningMs: nowMs,
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
