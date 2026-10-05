// TSL names the webgpu build's three (0.182) exports and the repo's typings
// (@types/three 0.170) lack. A module file, so this augments three/tsl.
export {};

declare module 'three/tsl' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const normalViewGeometry: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const struct: (layout: Record<string, string>, name?: string) => (...members: any[]) => any;
}
