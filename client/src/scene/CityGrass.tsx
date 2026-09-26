import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useQualityTier, useShadowsEnabled } from '../app/renderQuality';
import type { CityClient } from '../city/cityClient';
import type { CityManifest } from '../city/manifest';
import { cityGrassPaint, retainSharedCityGrass } from './grass/GrassPaint';
import { GrassLayoutSync, setGrassSyncStatus } from './grass/GrassLayoutSync';
import { GrassField } from './grass/GrassField';
import { grassExclusionsFromManifest } from './grass/grassPlacement';
import { GrassBodyContacts, type GrassActorSource } from './grass/GrassBodyContacts';

/** Only mounts a field when a city manifest exists. Never touches gameplay/physics. */
export function CityGrass({ getCityClient, getInteractionPosition, getActors, getSharedLayoutUrl, windStrengthMps = 8, windDirectionDeg = 45 }: {
  getCityClient: () => CityClient | null;
  getInteractionPosition?: () => readonly [number, number, number] | null;
  getActors?: () => GrassActorSource | null;
  getSharedLayoutUrl?: () => string | null;
  windStrengthMps?: number;
  windDirectionDeg?: number;
}) {
  const quality = useQualityTier();
  const shadows = useShadowsEnabled();
  const scene = useThree(state => state.scene);
  const state = useRef<{ field: GrassField; manifest: CityManifest; contacts: GrassBodyContacts; client: CityClient } | null>(null);
  const shared = useRef<{ url: string | null; sync: GrassLayoutSync | null } | null>(null);
  const disabled = typeof location !== 'undefined' && new URLSearchParams(location.search).get('grass') === 'off';
  const sharedRequested = !!getSharedLayoutUrl;
  useEffect(() => {
    if (!sharedRequested) return;
    const release = retainSharedCityGrass();
    return () => { shared.current?.sync?.dispose(); shared.current = null; release(); setGrassSyncStatus({ state: 'idle', revision: null, message: '' }); };
  }, [sharedRequested]);
  useEffect(() => () => {
    if (state.current) {
      scene.remove(state.current.field.group);
      state.current.field.dispose();
      state.current = null;
    }
  }, [scene]);
  useFrame(({ camera, clock }) => {
    if (getSharedLayoutUrl) {
      const url = getSharedLayoutUrl();
      if (!shared.current || shared.current.url !== url) {
        shared.current?.sync?.dispose();
        const sync = url ? new GrassLayoutSync(cityGrassPaint, url) : null;
        shared.current = { url, sync };
        if (sync) sync.start();
        else {
          cityGrassPaint.clear();
          setGrassSyncStatus({ state: 'error', revision: null, message: 'Shared grass unavailable for this connection' });
        }
      }
    }
    if (disabled) return;
    const client = getCityClient();
    const manifest = client?.manifest.manifest ?? null;
    if (state.current && (state.current.client !== client || state.current.field.quality !== quality)) {
      scene.remove(state.current.field.group);
      state.current.field.dispose();
      state.current = null;
    }
    if (!manifest || !client) return;
    if (!state.current) {
      const field = new GrassField(quality, grassExclusionsFromManifest(manifest));
      scene.add(field.group);
      state.current = { field, manifest, client, contacts: new GrassBodyContacts(client) };
    }
    const field = state.current.field;
    const position = getInteractionPosition?.() ?? null;
    if (field.interaction.begin(clock.elapsedTime, camera.position.x, camera.position.z)) {
      state.current.contacts.update(field.interaction, clock.elapsedTime, camera.position.x, camera.position.z, getActors?.() ?? null, position);
      field.interaction.commit();
    }
    field.setWind(windStrengthMps, windDirectionDeg);
    field.setShadows(shadows);
    field.update(camera, clock.elapsedTime);
    if (getInteractionPosition) {
      if (position) field.shading.uniforms.grassViewer.value.fromArray(position);
      else field.shading.uniforms.grassViewer.value.set(0, 1000, 0);
    }
  });
  return null;
}
