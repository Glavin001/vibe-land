// The meteors, mounted in the game world beside the dust.
//
// A meteor is a rigid body like the cannonball, born far out and streamed to
// every client from the tick it exists (an important body; see
// `DYNAMIC_BODY_KIND_METEOR`). This layer draws a burning rock -- the
// cratered basalt from meteorRock with its embers and a light, and a fire
// volume through MeteorFireStage -- on every dynamic body of that kind, at
// the same rendered state the cannonball's mesh uses. Nothing here predicts,
// holds or guesses: the body is the truth, and when it is gone, so is the
// rock.

import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';

import { renderStats } from '../city/renderStats';
import { registerPipelineStage } from '../graphics/framePipelineStages';
import { DYNAMIC_BODY_KIND_METEOR } from '../net/sharedConstants';
import type { GameRuntimeClient } from '../runtime/gameRuntime';
import { MeteorFireStage, type MeteorFireInstance } from './MeteorFireStage';
import { forgetMeteorDrawn, recordMeteorDrawn } from './meteorForensics';
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
 * The server's projectile ids are a ring: a new rock can arrive through an
 * id whose old rock is still in the map for a frame. A body that moves this
 * far in one frame is a different rock, and its burn state starts over.
 */
const REUSE_JUMP_M = 100;

interface LiveMeteor {
  bodyId: number;
  radiusM: number;
  group: THREE.Group;
  rock: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
  surface: MeteorSurfaceUniforms;
  embers: MeteorEmbers;
  /** When the rock last moved fast enough to burn, local ms. */
  lastBurningMs: number;
  intensity: number;
  fire: MeteorFireInstance;
  distanceSq: number;
  firstSeenMs: number;
  lastPosition: THREE.Vector3;
}

const scratchDir = new THREE.Vector3();
const scratchAxis = new THREE.Vector3();
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
    const meteors = live.current;
    const step = Math.min(0.1, Math.max(0, dt));
    const bodies = runtime?.state?.dynamicBodies;
    const lagMs = runtime?.state?.dynamicBodyInterpolationDelayMs ?? 0;

    const seen = new Set<number>();
    if (bodies && runtime) {
      for (const [bodyId, raw] of bodies) {
        if (raw.kind !== DYNAMIC_BODY_KIND_METEOR) continue;
        seen.add(bodyId);
        let meteor = meteors.get(bodyId);
        if (!meteor) {
          meteor = spawn(bodyId, raw.halfExtents[0], geometry, nowMs);
          group.add(meteor.group);
          meteors.set(bodyId, meteor);
        }
        // The same source the cannonball's mesh draws from: the interpolated
        // sample, or the local proxy for the moment after a shot touched it.
        const rendered = runtime.getRenderedDynamicBodyState(bodyId);
        const body = rendered ?? raw;
        const position = body.position;
        const velocity = body.velocity;
        if (meteor.lastPosition.distanceTo(
          scratchDir.set(position[0], position[1], position[2]),
        ) > REUSE_JUMP_M) {
          // A new rock through an old id.
          meteor.lastBurningMs = nowMs;
          meteor.intensity = 0;
          meteor.firstSeenMs = nowMs;
        }
        meteor.lastPosition.set(position[0], position[1], position[2]);
        meteor.group.visible = true;
        meteor.group.position.set(position[0], position[1], position[2]);
        meteor.group.quaternion.set(
          body.quaternion[0],
          body.quaternion[1],
          body.quaternion[2],
          body.quaternion[3],
        );
        meteor.group.updateMatrixWorld(true);

        const airSpeed = Math.hypot(velocity[0], velocity[1], velocity[2]);
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
        meteor.fire.airSpeed = airSpeed;
        meteor.fire.intensity = meteor.intensity;
        meteor.fire.inverseRock.copy(meteor.rock.matrixWorld).invert();
        meteor.distanceSq = camera.position.distanceToSquared(meteor.group.position);

        recordMeteorDrawn({
          bodyId,
          position: [position[0], position[1], position[2]],
          raw: { position: raw.position, velocity: raw.velocity },
          rendered: rendered ? rendered.position : null,
          radiusM: meteor.radiusM,
          speed: airSpeed,
          interpDelayMs: lagMs,
          sampleAgeMs: runtime.getDynamicBodyObservedAgeMs(bodyId) ?? 0,
          firstSeenMs: meteor.firstSeenMs,
          atMs: nowMs,
        });
      }
    }

    // A body the runtime no longer carries was retired on the server.
    for (const [bodyId, meteor] of meteors) {
      if (seen.has(bodyId)) continue;
      retire(meteor);
      forgetMeteorDrawn(bodyId);
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
      const r = meteor.radiusM;
      light.position.copy(meteor.fire.direction).multiplyScalar(1.65 * r).add(meteor.group.position);
      light.distance = 14 * r;
      light.intensity = (2.8 + Math.sin(meteor.surface.uTime.value * 7) * 0.3) * meteor.intensity * r * r;
    });
    renderStats.meteorsLive = visible.length;
    if (visible.length === 0) renderStats.meteorFireMs = 0;
  });

  return <group ref={groupRef} name="meteors" />;
}

function spawn(bodyId: number, radiusM: number, geometry: THREE.BufferGeometry, nowMs: number): LiveMeteor {
  const { material, uniforms } = buildMeteorMaterial();
  // Seeded by the body id so two rocks in the air are not the same rock.
  const seed = 42 + (bodyId % 97) * 7.3;
  uniforms.uSeed.value = seed;
  const rock = new THREE.Mesh(geometry, material);
  rock.castShadow = true;
  rock.receiveShadow = true;
  // The lab's rock sits in the group with its own slight lean; the body's
  // pose goes on the group so the fire's hollow follows the mesh.
  rock.rotation.z = 0.18;
  const embers = buildMeteorEmbers();
  const group = new THREE.Group();
  group.scale.setScalar(radiusM);
  group.add(rock);
  group.add(embers.points);
  group.visible = false;
  const fire: MeteorFireInstance = {
    center: new THREE.Vector3(),
    direction: new THREE.Vector3(0, 1, 0),
    radiusM,
    airSpeed: 0,
    inverseRock: new THREE.Matrix4(),
    seed,
    intensity: 0,
  };
  return {
    bodyId,
    radiusM,
    group,
    rock,
    material,
    surface: uniforms,
    embers,
    lastBurningMs: nowMs,
    intensity: 0,
    fire,
    distanceSq: Infinity,
    firstSeenMs: nowMs,
    lastPosition: new THREE.Vector3(Infinity, Infinity, Infinity),
  };
}

function retire(meteor: LiveMeteor): void {
  meteor.group.removeFromParent();
  meteor.material.dispose();
  meteor.embers.dispose();
}
