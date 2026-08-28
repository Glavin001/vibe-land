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

import { lookTuning, subscribeLookTuning } from './lookTuning';

import { DEFAULT_SUN_AZIMUTH_DEG, DEFAULT_SUN_ELEVATION_DEG, skyGradient, sunDirection } from './sunSky';

// `vDir` is the view ray, derived from where the camera actually is rather than
// from where the dome is. The distinction is the whole reason this is not
// `normalize(position)`: an object-space direction is the correct view ray only
// while the camera sits exactly at the dome's centre, and it never quite does.
// The recentre below runs in a `useFrame` that r3f schedules BEFORE the one
// that writes the camera -- children subscribe before parents and both are
// priority 0 -- so the dome is always one frame behind. On a small sphere an
// offset of `d` metres rotates the sampled sky by roughly `d` radians; at
// walking speed that threw the sun disc, which is only about 1.8 degrees wide,
// a couple of its own diameters every frame and snapped it back the instant the
// player stood still. That was the reported "jittery sun".
//
// Taking the camera-to-surface vector instead makes the sky a pure function of
// direction, so where the dome sits stops being able to affect it at all -- the
// recentre becomes a coverage detail rather than a correctness requirement.
// `cameraPosition` is a built-in uniform three injects into every
// ShaderMaterial prefix; this is a ShaderMaterial, not a RawShaderMaterial, so
// it is present. In the PMREM bake the generator never moves its camera, so
// `cameraPosition` is the origin and this reduces to the untransformed vertex
// position -- the baked environment map is byte-identical to before.
const VERTEX_SHADER = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vDir = worldPosition.xyz - cameraPosition;
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
  /**
   * Bake the sky into a PMREM and bind it as `scene.environment`.
   *
   * Separate from `showDome` because they cost completely different things: the
   * dome is a shader over sky pixels, the environment is an extra cubemap tap
   * and a chunk of IBL maths on EVERY Standard-material pixel in the scene. A
   * frame that is fill-bound needs to be able to price them apart.
   */
  bindEnvironment?: boolean;
  /** Skylight multiplier; 0 disables IBL entirely. */
  intensity?: number;
};

export function SkyEnvironment({
  fogColor,
  sunElevationDeg = DEFAULT_SUN_ELEVATION_DEG,
  sunAzimuthDeg = DEFAULT_SUN_AZIMUTH_DEG,
  showDome = true,
  bindEnvironment = true,
  intensity = 1,
}: SkyEnvironmentProps) {
  const gl = useThree((state) => state.gl);
  const scene = useThree((state) => state.scene);

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        // The dome is a background, not geometry: it must never occlude or be
        // occluded. (It is not "parented to the camera" in any sense that the
        // shading depends on -- see VERTEX_SHADER. It is merely kept around the
        // camera so that it covers the screen.)
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
    scene.environment = bindEnvironment ? target.texture : null;
    // R3F's <color attach="background"> still owns the background; only the
    // lighting is taken over here.
    return () => {
      if (scene.environment === target.texture) scene.environment = null;
      target.dispose();
      pmrem.dispose();
      bakeGeometry.dispose();
      bakeMaterial.dispose();
    };
  }, [gl, scene, material, gradient, intensity, bindEnvironment]);

  useEffect(() => {
    const apply = () => {
      scene.environmentIntensity = Math.max(0, intensity * lookTuning().envIntensity);
    };
    apply();
    return subscribeLookTuning(apply);
  }, [scene, intensity]);

  // Keep the dome around the camera. A sphere that rides along is always
  // "infinitely far" without needing a radius that fights the 200 m far plane
  // the rest of the scene is tuned for.
  //
  // This is a COVERAGE job only, which is why it is allowed to run a frame
  // behind the camera write: the shading no longer reads the dome's position
  // (see VERTEX_SHADER), so all a stale centre can cost is the dome failing to
  // enclose the camera. It only has to be closer to the camera than the sphere
  // is wide, which is what the radius is sized for.
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
