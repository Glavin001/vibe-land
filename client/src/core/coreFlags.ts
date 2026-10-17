// Flags for modules of the shared client core the web uses outside clientCore.ts's own installs
// (which load the WASM up front). Each reads `?name=1` or its VITE_ variable.
function flag(urlName: string, envValue: string | undefined): boolean {
  if (envValue === '1') return true;
  try {
    return new URLSearchParams(globalThis.location?.search ?? '').get(urlName) === '1';
  } catch {
    return false;
  }
}

/** `?coreGrass=1` (or `VITE_CORE_GRASS=1`): grass patches from the core (scene/grass/coreGrass.ts). */
export function coreGrassEnabled(): boolean {
  return flag('coreGrass', import.meta.env?.VITE_CORE_GRASS);
}
