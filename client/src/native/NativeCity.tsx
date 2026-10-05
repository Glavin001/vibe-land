// The /city scene for the native app: the same GameWorld the web client
// mounts inside its Canvas, minus the DOM HUD (mystral has no DOM; the
// native HUD is drawn separately).

import { Suspense } from 'react';

import { loadInputBindings } from '../input/bindings';
import { FrameClock } from '../scene/FrameClock';
import { GameWorld } from '../scene/GameWorld';
import { CITY_WORLD_DOCUMENT } from '../world/cityWorld';
import { NativeCrosshair } from './NativeCrosshair';
import { NativeFpsCounter } from './NativeFpsCounter';
import { NativeLoadingScreen } from './NativeLoadingScreen';
import { NativeOverlay } from './NativeOverlay';
import { NativeWeaponHud } from './NativeWeaponHud';

const inputBindings = loadInputBindings();

export function NativeCity({ matchId = 'city-default' }: { matchId?: string }) {
  return (
    <>
      <FrameClock />
      <NativeOverlay>
        <NativeCrosshair />
        <NativeFpsCounter />
        <NativeWeaponHud />
        <NativeLoadingScreen />
      </NativeOverlay>
      <Suspense fallback={null}>
        <GameWorld
          mode="multiplayer"
          matchId={matchId}
          worldDocument={CITY_WORLD_DOCUMENT}
          inputBindings={inputBindings}
          onWelcome={(id) => console.log(`[native] joined as player ${id}`)}
          onDisconnect={(reason) => console.warn(`[native] disconnected: ${reason ?? 'unknown'}`)}
        />
      </Suspense>
    </>
  );
}
