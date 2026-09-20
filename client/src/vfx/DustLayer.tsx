// The destruction dust, mounted in the game world beside the city layer.
//
// Each frame it drains the dust sources the city client extracted from the
// topology stream, turns them into parcels through the policy, and hands the
// parcels to whichever renderer the quality settings picked: the volumetric
// pass registered with the frame pipeline, or the in-scene sprites. Both
// read the same store; only the drawing differs.

import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';

import type { DustMode } from '../app/renderQuality';
import type { CityClient } from '../city/cityClient';
import { DustPolicy, paletteFromAppearance } from '../city/dustPolicy';
import { DUST_TICK_CAP_OVERRIDE, dustEnabled } from '../city/dustSettings';
import { renderStats } from '../city/renderStats';
import { registerPipelineStage } from '../graphics/framePipelineStages';
import { lookTuning, subscribeLookTuning } from '../graphics/lookTuning';
import {
  DEFAULT_SUN_AZIMUTH_DEG,
  DEFAULT_SUN_ELEVATION_DEG,
  skyGradient,
  sunDirection,
  sunIntensityFor,
} from '../graphics/sunSky';
import { windVectorFromSettings } from '../graphics/weatherPresets';
import { DustSprites } from './DustSprites';
import { dustParcels } from './dustParcelStore';
import { DustVolumeRenderer, type DustLighting } from './DustVolumeRenderer';

type DustLayerProps = {
  getCityClient: () => CityClient | null;
  mode: DustMode;
  fogColor: string;
  windStrengthMps: number;
  windDirectionDeg: number;
  sunElevationDeg?: number;
  sunAzimuthDeg?: number;
};

export function DustLayer({
  getCityClient,
  mode,
  fogColor,
  windStrengthMps,
  windDirectionDeg,
  sunElevationDeg = DEFAULT_SUN_ELEVATION_DEG,
  sunAzimuthDeg = DEFAULT_SUN_AZIMUTH_DEG,
}: DustLayerProps) {
  const gl = useThree((state) => state.gl);
  const policyRef = useRef<{ client: CityClient; policy: DustPolicy } | null>(null);
  // The volumetric renderer bakes a 3D texture; a GL that cannot render to
  // one says so after the first layer, and the layer falls back to sprites.
  const [volumeFailed, setVolumeFailed] = useState(false);
  const highp = gl.capabilities.precision === 'highp';
  const volumetric = mode === 'volumetric' && highp && !volumeFailed;

  const lighting = useMemo<DustLighting>(() => {
    const dir = sunDirection(sunElevationDeg, sunAzimuthDeg);
    const gradient = skyGradient(fogColor, sunElevationDeg);
    return {
      sunDir: new THREE.Vector3(dir.x, dir.y, dir.z),
      sunColor: new THREE.Color(gradient.sunColor).convertSRGBToLinear().multiplyScalar(sunIntensityFor(sunElevationDeg)),
      skyColor: new THREE.Color(gradient.horizon).convertSRGBToLinear(),
      groundColor: new THREE.Color(gradient.ground).convertSRGBToLinear(),
    };
  }, [fogColor, sunElevationDeg, sunAzimuthDeg]);

  const wind = useMemo(
    () => windVectorFromSettings(windStrengthMps, windDirectionDeg),
    [windStrengthMps, windDirectionDeg],
  );

  const volume = useMemo(
    () => (volumetric ? new DustVolumeRenderer(dustParcels, sunElevationDeg, sunAzimuthDeg) : null),
    [volumetric, sunElevationDeg, sunAzimuthDeg],
  );

  useEffect(() => {
    if (!volume) return;
    const unregister = registerPipelineStage(volume);
    return () => {
      unregister();
      volume.dispose();
    };
  }, [volume]);

  useEffect(() => {
    volume?.setLighting(lighting);
  }, [volume, lighting]);

  useEffect(() => {
    volume?.setWind(wind.x, wind.z);
  }, [volume, wind]);

  useEffect(() => {
    if (!volume) return;
    const apply = () => {
      const live = lookTuning();
      volume.tuning.density = live.dustDensity;
      volume.tuning.size = live.dustSize;
      volume.tuning.lifetime = live.dustLifetime;
      volume.tuning.extinction = live.dustExtinction;
      volume.tuning.phaseG = live.dustPhaseG;
      volume.tuning.sunBoost = live.dustSunBoost;
      volume.applyTuning();
      volume.setLighting(lighting);
    };
    apply();
    return subscribeLookTuning(apply);
  }, [volume, lighting]);

  useFrame(() => {
    const client = getCityClient();
    if (!client) return;
    // The policy is per client: a new match (new client) starts clean.
    if (policyRef.current?.client !== client) {
      dustParcels.clear();
      const appearance = client.manifest.manifest.materialAppearance;
      policyRef.current = {
        client,
        policy: new DustPolicy(
          dustParcels,
          (material) => paletteFromAppearance(appearance, material),
          DUST_TICK_CAP_OVERRIDE ? { parcelsPerTickCap: DUST_TICK_CAP_OVERRIDE } : {},
        ),
      };
    }
    const { policy } = policyRef.current;
    const started = performance.now();
    if (mode === 'off' || !dustEnabled()) {
      // Keep the queue from filling while nothing draws.
      client.drainDustSources(() => {});
      renderStats.dustEmitMs = 0;
      return;
    }
    client.drainDustSources((source) => policy.emit(source));
    policy.tick(started);
    renderStats.dustEmitted = policy.stats.emitted;
    renderStats.dustDropped = policy.stats.droppedByTickCap + policy.stats.droppedByPalette
      + client.dustQueueDropped();
    renderStats.dustEmitMs = performance.now() - started;
    if (volume?.bake.failed && !volumeFailed) setVolumeFailed(true);
  });

  if (mode === 'off') return null;
  if (volumetric) return null;
  return (
    <DustSprites
      store={dustParcels}
      lighting={lighting}
      wind={wind}
    />
  );
}
