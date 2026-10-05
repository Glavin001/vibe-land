// Build every shader the game can show before play starts, behind the
// loading screen, instead of the first time each thing comes into view.
//
// A renderer compiles a material the first time an object using it is drawn:
// on WebGPU a node build (tens of milliseconds of JavaScript) and a pipeline,
// on WebGL a program link. Things that appear mid-play -- the fleet cars as
// the player nears them, a cannonball, a meteor, dust -- each cost a hitch the
// first time. Here each renderer module registers representative objects
// built by its own construction code (registerShaderWarmup), and once the
// city, its textures and the environment map are in (shader cache keys
// include the scene's lights, environment and fog), they are drawn for a few
// frames in front of the camera, then hidden.
//
// Hidden, not disposed: disposing a material releases its cached shader, the
// very thing this built. graphics/webgpu/shaderBuildMonitor.ts records any
// build after `markShaderWarmupDone()`; the native perf run reports them.

import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import * as THREE from 'three';

import type { CityClient } from '../city/cityClient';
import { markShaderWarmupDone } from '../graphics/webgpu/shaderBuildMonitor';

type WarmupFactory = () => THREE.Object3D[];
const factories: Array<{ name: string; build: WarmupFactory }> = [];

/** Objects whose materials the warmup must build (one per shader variant). */
export function registerShaderWarmup(name: string, build: WarmupFactory): void {
  factories.push({ name, build });
}

export type ShaderWarmupPhase = 'waiting' | 'warming' | 'done';
let phase: ShaderWarmupPhase = 'waiting';
const listeners = new Set<() => void>();
function setPhase(next: ShaderWarmupPhase): void {
  if (phase === next) return;
  phase = next;
  for (const listener of listeners) listener();
}
export function shaderWarmupPhase(): ShaderWarmupPhase {
  return phase;
}
export function useShaderWarmupPhase(): ShaderWarmupPhase {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, shaderWarmupPhase);
}

/** Frames the warmup objects stay drawn: the main pass and the shadow pass both see them. */
const WARMUP_FRAMES = 3;
const AHEAD = new THREE.Vector3();

export function ShaderWarmup({ getCityClient }: { getCityClient: () => CityClient | null }) {
  const scene = useThree((state) => state.scene);
  const state = useRef<{ group: THREE.Group; frames: number } | null>(null);

  useEffect(() => () => {
    if (state.current) scene.remove(state.current.group);
  }, [scene]);

  useFrame(({ camera }) => {
    if (phase === 'done') return;
    if (!state.current) {
      const client = getCityClient();
      const texturesReady = (globalThis as { __VIBE_CITY_TEX_READY__?: boolean }).__VIBE_CITY_TEX_READY__ === true;
      if (!client || client.topology.chunkCount === 0 || !texturesReady || !scene.environment) return;
      const group = new THREE.Group();
      group.name = 'shader warmup';
      for (const factory of factories) {
        try {
          for (const object of factory.build()) group.add(object);
        } catch (error) {
          console.warn(`[warmup] ${factory.name} could not be built`, error);
        }
      }
      // Everything drawn wherever it is: tiny, in front of the camera, and
      // exempt from culling, so the frustum cannot skip a variant.
      group.traverse((object) => {
        object.frustumCulled = false;
      });
      group.scale.setScalar(0.001);
      scene.add(group);
      state.current = { group, frames: 0 };
      setPhase('warming');
    }
    const warm = state.current;
    camera.getWorldDirection(AHEAD);
    warm.group.position.copy(camera.position).addScaledVector(AHEAD, 2);
    warm.frames += 1;
    if (warm.frames > WARMUP_FRAMES) {
      warm.group.visible = false;
      markShaderWarmupDone();
      setPhase('done');
      console.info(`[warmup] shaders built for ${factories.map((f) => f.name).join(', ')}`);
    }
  });

  return null;
}
