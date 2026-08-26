// Procedural sky: one shader that is both the dome the player sees and the
// source of the scene's image-based lighting.
//
// What this replaces: a flat `ambientLight` plus a `hemisphereLight` lit every
// surface in the world by the same two constants regardless of which way it
// faced or what was above it. That is why untextured geometry read as cardboard
// -- an inside corner, the underside of a slab and an open roof all received
// identical fill. Baking the sky into a PMREM environment map gives every
// MeshStandardMaterial a directional skylight term instead: surfaces facing up
// catch bright sky, surfaces facing down catch dim ground bounce, and the
// gradient between them is what makes shapes readable without a texture.
//
// The dome and the environment map are generated from the same material, so
// the light in the scene can never disagree with the sky behind it -- including
// under weather, where the horizon is pulled toward the storm's fog colour.

import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';

import { DEFAULT_SUN_AZIMUTH_DEG, DEFAULT_SUN_ELEVATION_DEG, skyGradient, sunDirection } from './sunSky';

const VERTEX_SHADER = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// The two chunk includes at the end of main() are load-bearing. A raw
// ShaderMaterial gets three's tone-mapping and output-encoding *helpers* in its
// prefix (so including the `_pars_` chunks as well fails to compile with
// "function already has a body") but not the steps that call them. Without
// them the dome writes linear radiance straight into an sRGB canvas and renders
// far too dark -- while the SSAO composite path, which does its own encode,
// renders the same sky correctly. That two-brightnesses-for-one-sky mismatch is
// how this was caught; the measured sky luminance of the two paths now agrees
// to within 7%.
//
// The environment bake needs the opposite -- image-based lighting integrates
// raw radiance, and a tone-mapped sky would feed the scene a dimmed, rolled-off
// skylight. PMREMGenerator already renders with tone mapping off and into a
// linear target, so both steps self-disable there; SKY_LINEAR_OUTPUT on the
// bake copy makes that independent of three's internals rather than a
// coincidence to be re-derived later.
const FRAGMENT_SHADER = /* glsl */ `
  varying vec3 vDir;
  uniform vec3 uSunDir;
  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uGround;
  uniform vec3 uSunColor;
  uniform float uSunDisc;

  void main() {
    vec3 d = normalize(vDir);
    // pow() below 1 keeps the horizon band tight: a linear ramp puts the
    // brightest part of the sky halfway up, which reads as an overcast dome
    // rather than a horizon.
    float up = clamp(d.y, 0.0, 1.0);
    vec3 col = mix(uHorizon, uZenith, pow(up, 0.55));
    // Below the horizon fades to ground bounce rather than cutting hard: the
    // PMREM bake integrates this hemisphere into the downward-facing fill.
    col = mix(col, uGround, smoothstep(0.0, -0.18, d.y));

    float s = max(dot(d, uSunDir), 0.0);
    col += uSunColor * pow(s, 1400.0) * 26.0 * uSunDisc; // disc
    col += uSunColor * pow(s, 9.0) * 0.16;               // forward-scatter glow
    gl_FragColor = vec4(col, 1.0);
    #ifndef SKY_LINEAR_OUTPUT
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    #endif
  }
`;

type SkyEnvironmentProps = {
  /** Scene fog/background colour; tints the horizon and the skylight. */
  fogColor: string;
  sunElevationDeg?: number;
  sunAzimuthDeg?: number;
  /**
   * Draw the visible dome. The environment map is baked either way -- IBL is
   * cheap (one prefiltered cube, sampled per pixel like any other env map)
   * while the dome is a full-screen shader over every sky pixel, so the FAST
   * tier keeps the lighting and drops the dome.
   */
  showDome?: boolean;
  /** Skylight multiplier; 0 disables IBL entirely. */
  intensity?: number;
};

export function SkyEnvironment({
  fogColor,
  sunElevationDeg = DEFAULT_SUN_ELEVATION_DEG,
  sunAzimuthDeg = DEFAULT_SUN_AZIMUTH_DEG,
  showDome = true,
  intensity = 1,
}: SkyEnvironmentProps) {
  const gl = useThree((state) => state.gl);
  const scene = useThree((state) => state.scene);

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        // The dome is a unit sphere parented to the camera position, so it must
        // never occlude or be occluded -- it is a background, not geometry.
        depthTest: false,
        fog: false,
        uniforms: {
          uSunDir: { value: new THREE.Vector3(0, 1, 0) },
          uZenith: { value: new THREE.Color() },
          uHorizon: { value: new THREE.Color() },
          uGround: { value: new THREE.Color() },
          uSunColor: { value: new THREE.Color() },
          uSunDisc: { value: 1 },
        },
        vertexShader: VERTEX_SHADER,
        fragmentShader: FRAGMENT_SHADER,
      }),
    [],
  );

  const geometry = useMemo(() => new THREE.SphereGeometry(1, 32, 16), []);

  useEffect(() => {
    return () => {
      material.dispose();
      geometry.dispose();
    };
  }, [material, geometry]);

  // Push the current sky description into the shader. Colours are authored in
  // sRGB (they come from the same table as the CSS fog colour) and converted
  // once here, because the shader writes straight to a linear buffer.
  const gradient = useMemo(() => skyGradient(fogColor, sunElevationDeg), [fogColor, sunElevationDeg]);
  useEffect(() => {
    const dir = sunDirection(sunElevationDeg, sunAzimuthDeg);
    material.uniforms.uSunDir.value.set(dir.x, dir.y, dir.z);
    material.uniforms.uZenith.value.set(gradient.zenith).convertSRGBToLinear();
    material.uniforms.uHorizon.value.set(gradient.horizon).convertSRGBToLinear();
    material.uniforms.uGround.value.set(gradient.ground).convertSRGBToLinear();
    material.uniforms.uSunColor.value.set(gradient.sunColor).convertSRGBToLinear();
  }, [material, gradient, sunElevationDeg, sunAzimuthDeg]);

  // Bake the environment map. Runs only when the sky itself changes (weather,
  // sun angle) -- never per frame.
  useEffect(() => {
    if (intensity <= 0) {
      scene.environment = null;
      return;
    }
    const pmrem = new THREE.PMREMGenerator(gl);
    const bakeScene = new THREE.Scene();
    // The sun disc is a 26x spike over a few pixels. Left in the bake it would
    // alias into a blotch of ambient in one direction; the directional light
    // already carries the sun, so the bake keeps only sky and glow.
    // clone() deep-copies the uniforms, so the bake gets its own copy of the
    // current sky values and the dome keeps its sun disc.
    const bakeMaterial = material.clone();
    bakeMaterial.uniforms.uSunDisc.value = 0;
    bakeMaterial.defines = { SKY_LINEAR_OUTPUT: '' };
    bakeMaterial.depthTest = true;
    const bakeGeometry = new THREE.SphereGeometry(100, 32, 16);
    bakeScene.add(new THREE.Mesh(bakeGeometry, bakeMaterial));

    const target = pmrem.fromScene(bakeScene, 0.02);
    scene.environment = target.texture;
    // R3F's <color attach="background"> still owns the background; only the
    // lighting is taken over here.
    return () => {
      if (scene.environment === target.texture) scene.environment = null;
      target.dispose();
      pmrem.dispose();
      bakeGeometry.dispose();
      bakeMaterial.dispose();
    };
  }, [gl, scene, material, gradient, intensity]);

  useEffect(() => {
    scene.environmentIntensity = Math.max(0, intensity);
  }, [scene, intensity]);

  // Keep the dome centred on the camera: a unit sphere that rides along is
  // always "infinitely far" without needing a radius that fights the 200 m far
  // plane the rest of the scene is tuned for.
  const domeRef = useMemo(() => ({ current: null as THREE.Mesh | null }), []);
  useFrame(({ camera }) => {
    const dome = domeRef.current;
    if (dome) dome.position.copy(camera.position);
  });

  if (!showDome) return null;
  return (
    <mesh
      ref={(node) => {
        domeRef.current = node;
      }}
      geometry={geometry}
      material={material}
      frustumCulled={false}
      renderOrder={-1000}
    />
  );
}
