// The web's modules from the shared client core (client-core via client-core-wasm, the Rust the
// Unreal client links), each behind a flag. Every flag is on by default: each module matched the
// TypeScript it replaces in a parity test and ran a 5-minute soak with all of them on
// (scripts/web-core-soak.mjs). `?name=0` on the page URL, or its VITE_ variable set to 0 at build
// time, puts that module back on its TypeScript.

/** A shared-core flag: on unless `?<urlName>=0` or `envValue` is '0'. */
export function coreFlag(urlName: string, envValue: string | undefined): boolean {
  if (envValue === '0') return false;
  try {
    return new URLSearchParams(globalThis.location?.search ?? '').get(urlName) !== '0';
  } catch {
    return true;
  }
}

/** Grass patches from the core (scene/grass/coreGrass.ts); off with `?coreGrass=0` or `VITE_CORE_GRASS=0`. */
export function coreGrassEnabled(): boolean {
  return coreFlag('coreGrass', import.meta.env?.VITE_CORE_GRASS);
}
