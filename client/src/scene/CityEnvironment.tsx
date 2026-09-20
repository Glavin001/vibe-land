// The city's light, air and sky: one component, one set of decisions.
//
// GameWorld renders this for the game and /cityreplay renders it for the
// render bench, so a measurement taken on the replay page is a measurement
// of what the game draws. Everything that decides how the scene is lit or
// fogged, which passes exist and what the shadow map costs lives here and
// nowhere else; the two pages differ only in where their CityClient comes
// from and what moves the camera.

import { useEffect, useMemo, useState } from 'react';
import { FramePipeline } from '../graphics/FramePipeline';
import { SkyEnvironment } from '../graphics/SkyEnvironment';
import { skyGradient } from '../graphics/sunSky';
import { SunLight } from './SunLight';
import { WeatherParticles } from './WeatherParticles';
import { DEFAULT_FOG_SETTINGS } from '../graphics/fogSettings';
import { WEATHER_PRESETS, type WeatherPreset } from '../graphics/weatherPresets';
import { onShotModeChange, shotMode } from '../city/shotMode';
import {
  useAmbientOcclusionEnabled,
  useDustMode,
  useQualityTier,
  useShadowsEnabled,
  useShadowMapSizeOverride,
  useSkyDomeEnabled,
  useSkyIblEnabled,
} from '../app/renderQuality';

export interface CityEnvironmentProps {
  fogEnabled?: boolean;
  fogDensity?: number;
  fogColor?: string;
  weather?: WeatherPreset;
  windStrengthMps?: number;
  windDirectionDeg?: number;
  intensity?: number;
  /** Ground-level fog hides the skyline from a distant inspection camera. */
  aerialMode?: boolean;
}

/** The fog colour the scene resolves to; the dust and the terrain read it too. */
export function resolveFogColor(fogColor: string | undefined, weather: WeatherPreset): string {
  return fogColor ?? WEATHER_PRESETS[weather].fogColor;
}

/**
 * Whether the frame goes through the offscreen pipeline this frame: SSAO and
 * the volumetric dust each need the scene's depth, which only exists off the
 * canvas, and the meteor's fire is a pipeline stage, so choosing that shot
 * brings the pipeline up before the first rock is in the air.
 */
export function useFramePipelineOn(): boolean {
  const ambientOcclusionOn = useAmbientOcclusionEnabled();
  const dustMode = useDustMode();
  const [meteorShot, setMeteorShot] = useState(() => shotMode() === 'meteor');
  useEffect(() => onShotModeChange(() => setMeteorShot(shotMode() === 'meteor')), []);
  return ambientOcclusionOn || dustMode === 'volumetric' || meteorShot;
}

export function CityEnvironment({
  fogEnabled = true,
  fogDensity = DEFAULT_FOG_SETTINGS.density,
  fogColor,
  weather = DEFAULT_FOG_SETTINGS.weather,
  windStrengthMps = DEFAULT_FOG_SETTINGS.windStrengthMps,
  windDirectionDeg = DEFAULT_FOG_SETTINGS.windDirectionDeg,
  intensity = DEFAULT_FOG_SETTINGS.intensity,
  aerialMode = false,
}: CityEnvironmentProps) {
  const resolvedFogColor = resolveFogColor(fogColor, weather);
  const skyLightGradient = useMemo(() => skyGradient(resolvedFogColor), [resolvedFogColor]);
  const effectiveFogDensity = (aerialMode ? Math.min(fogDensity, 0.001) : fogDensity) * intensity;
  const qualityIsPretty = useQualityTier() === 'pretty';
  const shadowsOn = useShadowsEnabled();
  const ambientOcclusionOn = useAmbientOcclusionEnabled();
  const framePipelineOn = useFramePipelineOn();
  const skyDomeOn = useSkyDomeEnabled();
  const skyIblOn = useSkyIblEnabled();
  const shadowMapTexels = useShadowMapSizeOverride();
  const weatherOn = qualityIsPretty;

  return (
    <>
      <color attach="background" args={[resolvedFogColor]} />
      {fogEnabled && <fogExp2 attach="fog" args={[resolvedFogColor, effectiveFogDensity]} />}
      {/*
        FAST-tier cuts, all fill/shader costs on a phone: weather particles are
        transparent overdraw, the drei Sky runs an atmospheric shader over every
        sky pixel (the plain background colour + fog above still give a
        horizon), and the second directional light makes every Standard-material
        pixel in the scene more expensive. The shadow light stays -- shadows
        have their own toggle.
      */}
      {fogEnabled && weatherOn && (
        <WeatherParticles
          weather={weather}
          windStrengthMps={windStrengthMps}
          windDirectionDeg={windDirectionDeg}
          fogColor={resolvedFogColor}
          fogDensity={effectiveFogDensity}
          intensity={intensity}
        />
      )}
      {/*
        Sky, skylight and sun all come from one description of the sky (see
        `graphics/sunSky.ts`). The drei <Sky> dome that used to live here drew
        its sun at [120, 28, 40] while the shadow light sat at [48, 42, 18] and
        a blue fill light faked bounce from the opposite corner: three suns that
        never agreed, over an `ambientLight` + `hemisphereLight` pair that lit
        every surface in the world to the same value no matter which way it
        faced. The environment map replaces that flat fill with real directional
        skylight, so the remaining ambient is only a floor that keeps deep
        interiors from going to pure black.
      */}
      <SkyEnvironment
        fogColor={resolvedFogColor}
        showDome={skyDomeOn}
        bindEnvironment={skyIblOn}
        intensity={qualityIsPretty ? 1 : 0.85}
      />
      <SunLight
        fogColor={resolvedFogColor}
        castShadow={shadowsOn}
        shadowHalfExtent={qualityIsPretty ? 48 : 60}
        shadowMapSize={shadowMapTexels ?? (qualityIsPretty ? 2048 : 1024)}
      />
      {/*
        On FAST the city is Lambert with no environment map, and a vertical
        wall facing away from the sun gets only half the hemisphere (and the
        dark ground half at that) -- measured 86 vs PRETTY's 121 mean luminance
        on the same shaded face. The ambient floor is orientation-independent,
        which is exactly what those faces are missing; PRETTY keeps the small
        floor because its skylight comes from the environment map.
      */}
      <ambientLight intensity={qualityIsPretty ? 0.12 : 0.55} color={0xfdf6eb} />
      {/*
        The environment map only reaches Standard/Physical materials. FAST-tier
        city chunks shade as Lambert, so a hemisphere light stands in for the
        skylight there -- tinted from the same gradient, so the two tiers differ
        in fidelity rather than in colour. On PRETTY it stays as a small floor
        under the IBL.
      */}
      <hemisphereLight
        args={[skyLightGradient.zenith, skyLightGradient.ground, qualityIsPretty ? 0.25 : 1.15]}
      />
      {framePipelineOn && <FramePipeline ao={ambientOcclusionOn} />}
    </>
  );
}
