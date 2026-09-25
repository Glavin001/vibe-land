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

import {
  dustModePreferred,
  governorDustSprites,
  governorSampleScale,
  onRenderQualityChange,
  type DustFluid,
  type DustMode,
} from '../app/renderQuality';
import type { CityClient } from '../city/cityClient';
import type { DustSource } from '../city/destructionEvents';
import type { AtlasLayout } from './fluid/fluidAtlas';
import type { BrickFrame } from './fluid/fluidColliders';
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
import { DustClearance } from './dustClearance';
import { DustOccupancy } from './dustOccupancy';
import { DustMovers } from './dustMovers';
import { clearDustShots } from './dustShots';
import { drainDebugDustSources } from './dustDebug';
import { dustParcels } from './dustParcelStore';
import { DustVolumeRenderer, type DustLighting } from './DustVolumeRenderer';
import { ParkingSlot } from './parkingSlot';
import { voxelizeStaticChunks } from './fluid/fluidColliders';

type DustLayerProps = {
  getCityClient: () => CityClient | null;
  /** Game dynamic bodies (the cannonball) this frame, for the movers. */
  getDynamicBodies?: () => Iterable<{ id: number; position: ArrayLike<number>; velocity: ArrayLike<number>; halfExtents: ArrayLike<number> }> | null;
  mode: DustMode;
  fluid: DustFluid;
  fogColor: string;
  windStrengthMps: number;
  windDirectionDeg: number;
  sunElevationDeg?: number;
  sunAzimuthDeg?: number;
};

/**
 * The volumetric renderer, kept while the render governor's sprite rung has
 * the dust drawn as sprites. Disposing it there and building a new one when
 * the governor's recovery probe gave the rung back rebaked the noise field
 * and recompiled every dust and fluid program mid-storm: 20-120 ms hitches,
 * once per rung change. Keyed by the sun it was baked for.
 */
const parkedVolume = new ParkingSlot<DustVolumeRenderer>();
const volumeKey = (elevationDeg: number, azimuthDeg: number) => `${elevationDeg}:${azimuthDeg}`;

export function DustLayer({
  getCityClient,
  getDynamicBodies,
  mode,
  fluid,
  fogColor,
  windStrengthMps,
  windDirectionDeg,
  sunElevationDeg = DEFAULT_SUN_ELEVATION_DEG,
  sunAzimuthDeg = DEFAULT_SUN_AZIMUTH_DEG,
}: DustLayerProps) {
  const gl = useThree((state) => state.gl);
  const policyRef = useRef<{
    client: CityClient;
    policy: DustPolicy;
    colliders: (frame: BrickFrame, layout: AtlasLayout, out: Uint8Array) => number;
    occupancy: DustOccupancy;
    movers: DustMovers;
  } | null>(null);
  const lastFrameMs = useRef(0);
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

  // Declared before the volume's effect so that on unmount its cleanup runs
  // first (React runs them in order) and the volume's cleanup disposes.
  const unmountingRef = useRef(false);
  useEffect(() => {
    unmountingRef.current = false;
    return () => {
      unmountingRef.current = true;
      parkedVolume.clear();
    };
  }, []);

  const volume = useMemo(
    () => (volumetric
      ? parkedVolume.take(volumeKey(sunElevationDeg, sunAzimuthDeg))
        ?? new DustVolumeRenderer(dustParcels, sunElevationDeg, sunAzimuthDeg)
      : null),
    [volumetric, sunElevationDeg, sunAzimuthDeg],
  );

  useEffect(() => {
    if (!volume) return;
    const unregister = registerPipelineStage(volume);
    return () => {
      unregister();
      // Only the governor's sprite rung parks it; any other reason to drop
      // the volumetric renderer (the player's setting, the tier, the sun, the
      // layer going away) disposes it as before.
      if (!unmountingRef.current && governorDustSprites() && dustModePreferred() === 'volumetric') {
        parkedVolume.park(volume, volumeKey(sunElevationDeg, sunAzimuthDeg));
      } else {
        volume.dispose();
      }
    };
  }, [volume]);

  useEffect(() => {
    volume?.setLighting(lighting);
  }, [volume, lighting]);

  useEffect(() => {
    if (!volume) return;
    const apply = () => {
      const bricks = Math.max(1, Math.min(4, Math.round(lookTuning().dustFluidBricks)));
      volume.setFluidQuality(fluid, bricks);
    };
    apply();
    return subscribeLookTuning(apply);
  }, [volume, fluid]);

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
      volume.tuning.budget = live.dustBudgetM * 1e6 * governorSampleScale();
      volume.applyTuning();
      volume.setLighting(lighting);
    };
    apply();
    const unsubscribeTuning = subscribeLookTuning(apply);
    const unsubscribeQuality = onRenderQualityChange(apply);
    return () => {
      unsubscribeTuning();
      unsubscribeQuality();
    };
  }, [volume, lighting]);

  useFrame(({ camera }) => {
    const client = getCityClient();
    if (!client) return;
    // The policy is per client: a new match (new client) starts clean.
    if (policyRef.current?.client !== client) {
      dustParcels.clear();
      for (const brick of volume?.fluids ?? []) brick.retire();
      const manifest = client.manifest.manifest;
      const appearance = manifest.materialAppearance;
      const byId = new Map(manifest.structures.map((s) => [s.structureId, s]));
      clearDustShots();
      policyRef.current?.occupancy.dispose();
      const clearance = new DustClearance(client.topology, manifest);
      const occupancy = new DustOccupancy(clearance);
      const policy = new DustPolicy(
        dustParcels,
        (material) => paletteFromAppearance(appearance, material),
        DUST_TICK_CAP_OVERRIDE ? { parcelsPerTickCap: DUST_TICK_CAP_OVERRIDE } : {},
      );
      policy.clearanceOf = (x, y, z, out) => clearance.clearanceAt(x, y, z, out);
      policyRef.current = {
        client,
        colliders: (frame, layout, out) =>
          voxelizeStaticChunks(client.topology, manifest, frame, layout, out, byId),
        policy,
        occupancy,
        movers: new DustMovers(),
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
    if (volume && volume.colliders !== policyRef.current.colliders) {
      volume.colliders = policyRef.current.colliders;
      volume.occupancy = policyRef.current.occupancy;
    }
    if (volume && volume.occupancy) {
      volume.occupancy.update(camera.position, client.topology.brokenBondCount(), started);
    }
    const emit = (source: DustSource) => {
      policy.emit(source);
      volume?.considerSource(source, started, gl);
    };
    client.drainDustSources(emit);
    drainDebugDustSources(emit);
    policy.tick(started);
    // Moving bodies push the dust: the bricks take them as velocity sources,
    // the parcels get shoved, and big fast ones leave a wake.
    const dt = lastFrameMs.current > 0 ? Math.min(0.1, (started - lastFrameMs.current) / 1000) : 1 / 60;
    lastFrameMs.current = started;
    const { movers } = policyRef.current;
    movers.update(client, camera.position.x, camera.position.y, camera.position.z, started, getDynamicBodies?.() ?? undefined);
    movers.pushParcels(dustParcels, dt);
    movers.emitWakes(policy, started);
    if (volume) for (const brick of volume.fluids) brick.setMovers(movers.movers);
    renderStats.dustMovers = movers.movers.length;
    renderStats.dustEmitted = policy.stats.emitted;
    renderStats.dustDropped = policy.stats.droppedByTickCap + policy.stats.droppedByPalette
      + client.dustQueueDropped();
    renderStats.dustEmitMs = performance.now() - started;
    if (volume?.bake.failed && !volumeFailed) setVolumeFailed(true);
    renderStats.dustOccupancyMs = policyRef.current.occupancy.lastBuildCostMs;
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
