// The scene's key light: a directional sun whose shadow frustum follows the
// player.
//
// The bug this fixes is easy to miss on the practice map and impossible to miss
// in the city: the old light sat at a fixed [48, 42, 18] aimed at the world
// origin with a +/-90 m orthographic shadow camera. Shadows therefore existed
// only in a bubble around 0,0,0. Walk a city block away and every shadow in the
// world simply stopped -- which is most of why the city read as flat.
//
// Following the camera also lets the frustum shrink. Half the width is four
// times the shadow-map density for the same texel budget, so the shadows that
// are actually on screen get sharper while the ones nobody can see stop being
// paid for. The cost of a moving shadow camera is edge crawl, which
// `snapToStep` below removes by quantising the camera to its own texel grid.

import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';

import {
  DEFAULT_SUN_AZIMUTH_DEG,
  DEFAULT_SUN_ELEVATION_DEG,
  SUN_DISTANCE_M,
  shadowFocusPoint,
  shadowTexelSize,
  snapToStep,
  sunDirection,
  sunIntensityFor,
  skyGradient,
} from '../graphics/sunSky';

type SunLightProps = {
  /** Scene fog colour; the sun is tinted from the same gradient as the sky. */
  fogColor: string;
  sunElevationDeg?: number;
  sunAzimuthDeg?: number;
  castShadow?: boolean;
  /**
   * Half-width of the shadow camera in metres. The frustum is centred a little
   * ahead of the player, so this is roughly "how far away a shadow still
   * renders".
   */
  shadowHalfExtent?: number;
  shadowMapSize?: number;
  /** Multiplier on the physically-derived intensity, for per-scene taste. */
  intensityScale?: number;
};

const FORWARD = new THREE.Vector3();
const FOCUS = new THREE.Vector3();
const RIGHT = new THREE.Vector3();
const UP = new THREE.Vector3();
const LIGHT_Z = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);

export function SunLight({
  fogColor,
  sunElevationDeg = DEFAULT_SUN_ELEVATION_DEG,
  sunAzimuthDeg = DEFAULT_SUN_AZIMUTH_DEG,
  castShadow = true,
  shadowHalfExtent = 48,
  shadowMapSize = 2048,
  intensityScale = 1,
}: SunLightProps) {
  const lightRef = useRef<THREE.DirectionalLight>(null);
  const scene = useThree((state) => state.scene);
  // Built imperatively and parented straight to the scene root: the focus point
  // is computed in world space, so the target must not inherit a transform from
  // whatever group the light happens to be declared in.
  const target = useMemo(() => new THREE.Object3D(), []);

  const direction = useMemo(
    () => sunDirection(sunElevationDeg, sunAzimuthDeg),
    [sunElevationDeg, sunAzimuthDeg],
  );
  const gradient = useMemo(() => skyGradient(fogColor, sunElevationDeg), [fogColor, sunElevationDeg]);
  const intensity = sunIntensityFor(sunElevationDeg) * intensityScale;

  useEffect(() => {
    scene.add(target);
    return () => {
      scene.remove(target);
    };
  }, [scene, target]);

  useEffect(() => {
    const light = lightRef.current;
    if (!light) return;
    light.target = target;
  }, [target]);

  useEffect(() => {
    const light = lightRef.current;
    if (!light) return;
    const camera = light.shadow.camera;
    camera.left = -shadowHalfExtent;
    camera.right = shadowHalfExtent;
    camera.top = shadowHalfExtent;
    camera.bottom = -shadowHalfExtent;
    camera.near = 1;
    // The light rides `SUN_DISTANCE_M` above the focus point, so the far plane
    // has to clear that plus whatever tall geometry stands behind the player --
    // a tower that is outside the far plane stops casting onto the street.
    camera.far = SUN_DISTANCE_M * 2 + shadowHalfExtent * 2;
    camera.updateProjectionMatrix();
    light.shadow.mapSize.set(shadowMapSize, shadowMapSize);
    // The shadow map is allocated at the old size; drop it so three reallocates
    // at the new one on the next frame.
    light.shadow.map?.dispose();
    light.shadow.map = null;
  }, [shadowHalfExtent, shadowMapSize]);

  useFrame(({ camera }) => {
    const light = lightRef.current;
    if (!light) return;

    // Centre the frustum a little ahead of where the player is looking.
    camera.getWorldDirection(FORWARD);
    const led = shadowFocusPoint(camera.position, FORWARD, shadowHalfExtent);
    FOCUS.set(led.x, led.y, led.z);

    // Quantise the focus point on the shadow camera's own axes. Snapping in
    // world axes would still slide the map diagonally; snapping in light space
    // is what actually holds each shadow edge on the same texel between frames.
    // LIGHT_Z is the sun direction; RIGHT and UP span the plane the shadow map
    // is rasterised on, which is the plane that has to stay on a fixed grid.
    const texel = shadowTexelSize(shadowHalfExtent, shadowMapSize);
    LIGHT_Z.set(direction.x, direction.y, direction.z);
    RIGHT.crossVectors(WORLD_UP, LIGHT_Z);
    if (RIGHT.lengthSq() < 1e-6) RIGHT.set(1, 0, 0);
    RIGHT.normalize();
    UP.crossVectors(LIGHT_Z, RIGHT).normalize();
    const depth = FOCUS.dot(LIGHT_Z);
    const x = snapToStep(FOCUS.dot(RIGHT), texel);
    const y = snapToStep(FOCUS.dot(UP), texel);
    FOCUS.copy(LIGHT_Z).multiplyScalar(depth).addScaledVector(RIGHT, x).addScaledVector(UP, y);

    target.position.copy(FOCUS);
    target.updateMatrixWorld();
    light.position.set(
      FOCUS.x + direction.x * SUN_DISTANCE_M,
      FOCUS.y + direction.y * SUN_DISTANCE_M,
      FOCUS.z + direction.z * SUN_DISTANCE_M,
    );
    light.updateMatrixWorld();
  });

  return (
    <>
      <directionalLight
        ref={lightRef}
        castShadow={castShadow}
        color={gradient.sunColor}
        intensity={intensity}
        shadow-bias={-0.0002}
        // Normal bias scales with the texel size: a value tuned for a wide
        // frustum leaves visible peter-panning once the frustum tightens.
        shadow-normalBias={Math.max(0.02, shadowTexelSize(shadowHalfExtent, shadowMapSize) * 1.5)}
      />
    </>
  );
}
