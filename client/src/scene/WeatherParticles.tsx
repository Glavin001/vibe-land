// GPU particle volume that re-skins the fog boundary as an atmospheric
// phenomenon (dust / snow). A single THREE.Points + ShaderMaterial; the
// vertex shader wraps each particle modulo a box around the camera so CPU
// work per frame is just a couple uniform writes regardless of particle
// count. See `client/src/graphics/weatherPresets.ts` for tuning.

import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import {
  WEATHER_PRESETS,
  windVectorFromSettings,
  type WeatherPreset,
} from '../graphics/weatherPresets';

type WeatherParticlesProps = {
  weather: WeatherPreset;
  windStrengthMps: number;
  windDirectionDeg: number;
  fogColor: string;
  fogDensity: number;
};

const VERTEX_SHADER = /* glsl */ `
  attribute float aSeed;

  uniform float uTime;
  uniform vec3 uCameraPos;
  uniform float uBoxSize;
  uniform vec3 uWind;
  uniform float uFallSpeed;
  uniform float uTumbleHz;
  uniform float uTumbleAmp;
  uniform float uSize;
  uniform float uFogDensity;

  varying float vFogFactor;
  varying float vEdgeFade;

  void main() {
    vec3 drift = uWind * uTime + vec3(0.0, -uFallSpeed * uTime, 0.0);
    float phase = uTime * 6.2831853 * uTumbleHz + aSeed * 12.566;
    vec3 tumble = vec3(cos(phase), 0.0, sin(phase * 0.71)) * uTumbleAmp;
    vec3 rawWorld = position + drift + tumble;

    vec3 diff = rawWorld - uCameraPos;
    vec3 wrapped = mod(diff + uBoxSize * 0.5, uBoxSize) - uBoxSize * 0.5;
    vec3 worldPos = uCameraPos + wrapped;

    vec4 mvPosition = modelViewMatrix * vec4(worldPos, 1.0);
    gl_Position = projectionMatrix * mvPosition;

    float dist = max(-mvPosition.z, 0.1);
    gl_PointSize = max(uSize / dist, 1.0);

    float fogDepth = length(mvPosition.xyz);
    vFogFactor = clamp(1.0 - exp(-uFogDensity * uFogDensity * fogDepth * fogDepth), 0.0, 1.0);

    float edgeDist = length(wrapped) / (uBoxSize * 0.5);
    vEdgeFade = 1.0 - smoothstep(0.75, 1.0, edgeDist);
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  precision highp float;

  uniform vec3 uColor;
  uniform vec3 uFogColor;

  varying float vFogFactor;
  varying float vEdgeFade;

  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float r = length(uv) * 2.0;
    float alpha = 1.0 - smoothstep(0.35, 1.0, r);
    alpha *= vEdgeFade * (1.0 - vFogFactor);
    if (alpha <= 0.005) discard;

    vec3 color = mix(uColor, uFogColor, vFogFactor * 0.6);
    gl_FragColor = vec4(color * alpha, alpha);
  }
`;

function buildGeometry(count: number, boxSizeM: number): THREE.BufferGeometry {
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  const half = boxSizeM * 0.5;
  for (let i = 0; i < count; i++) {
    positions[i * 3 + 0] = (Math.random() - 0.5) * boxSizeM;
    positions[i * 3 + 1] = (Math.random() - 0.5) * boxSizeM;
    positions[i * 3 + 2] = (Math.random() - 0.5) * boxSizeM;
    seeds[i] = Math.random();
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
  // Bounding sphere centred on origin; the vertex shader re-centres on the
  // camera, so we use a huge sphere to opt out of frustum culling.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), half * 8);
  return geometry;
}

export function WeatherParticles({
  weather,
  windStrengthMps,
  windDirectionDeg,
  fogColor,
  fogDensity,
}: WeatherParticlesProps) {
  const pointsRef = useRef<THREE.Points>(null);
  const timeRef = useRef(0);

  const preset = WEATHER_PRESETS[weather];

  const geometry = useMemo(
    () => buildGeometry(preset.particleCount, preset.boxSizeM),
    [preset.particleCount, preset.boxSizeM],
  );

  const material = useMemo(() => {
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uCameraPos: { value: new THREE.Vector3() },
        uBoxSize: { value: preset.boxSizeM },
        uWind: { value: new THREE.Vector3() },
        uFallSpeed: { value: preset.fallSpeedMps },
        uTumbleHz: { value: preset.tumbleHz },
        uTumbleAmp: { value: preset.tumbleAmplitudeM },
        uSize: { value: preset.particleSizePx },
        uFogDensity: { value: fogDensity },
        uColor: { value: new THREE.Color(preset.particleColor) },
        uFogColor: { value: new THREE.Color(fogColor) },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      blending:
        preset.particleBlending === 'additive'
          ? THREE.AdditiveBlending
          : THREE.NormalBlending,
    });
    return mat;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weather]);

  // Keep uniforms in sync with live config changes without rebuilding the
  // material (cheap path — only geometry + blending need a full rebuild).
  useEffect(() => {
    const u = material.uniforms;
    u.uFallSpeed.value = preset.fallSpeedMps;
    u.uTumbleHz.value = preset.tumbleHz;
    u.uTumbleAmp.value = preset.tumbleAmplitudeM;
    u.uSize.value = preset.particleSizePx;
    u.uBoxSize.value = preset.boxSizeM;
    (u.uColor.value as THREE.Color).set(preset.particleColor);
  }, [material, preset]);

  useEffect(() => {
    (material.uniforms.uFogColor.value as THREE.Color).set(fogColor);
  }, [material, fogColor]);

  useEffect(() => {
    material.uniforms.uFogDensity.value = fogDensity;
  }, [material, fogDensity]);

  // Scale the world wind by the preset's windFollow so heavy dust drifts less
  // than light snow without the caller having to know the preset.
  const windScale = preset.windFollow;

  useEffect(() => () => {
    geometry.dispose();
  }, [geometry]);

  useEffect(() => () => {
    material.dispose();
  }, [material]);

  useFrame((state, delta) => {
    if (!pointsRef.current) return;
    // Cap delta so tab-switch pauses don't teleport every particle a million
    // metres downwind on resume.
    const dt = Math.min(delta, 0.1);
    timeRef.current += dt;
    const u = material.uniforms;
    u.uTime.value = timeRef.current;
    (u.uCameraPos.value as THREE.Vector3).copy(state.camera.position);
    const wind = windVectorFromSettings(windStrengthMps, windDirectionDeg);
    (u.uWind.value as THREE.Vector3).set(
      wind.x * windScale,
      wind.y * windScale,
      wind.z * windScale,
    );
  });

  if (preset.particleCount <= 0) return null;

  return (
    <points
      ref={pointsRef}
      geometry={geometry}
      material={material}
      frustumCulled={false}
      renderOrder={2}
    />
  );
}
