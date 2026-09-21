// What the meteor layer drew last frame, per body, for the e2e bridge.
//
// The bridge has no reference to the runtime, only module-level state, so
// the layer publishes here what a driver wants to compare: the drawn
// position against the raw snapshot and the interpolated state, and how old
// the newest sample was. A trace over an impaired link reads as numbers
// instead of a description.

export interface MeteorDrawn {
  bodyId: number;
  /** Where the rock was drawn this frame. */
  position: [number, number, number];
  /** Latest raw snapshot of the body. */
  raw: { position: [number, number, number]; velocity: [number, number, number] };
  /** The interpolated state the layer read, when the runtime had one. */
  rendered: [number, number, number] | null;
  radiusM: number;
  speed: number;
  interpDelayMs: number;
  /** Age of the newest sample, ms, on the server clock. */
  sampleAgeMs: number;
  /** When this body was first drawn, local ms. */
  firstSeenMs: number;
  atMs: number;
}

const drawn = new Map<number, MeteorDrawn>();

export function recordMeteorDrawn(record: MeteorDrawn): void {
  drawn.set(record.bodyId, record);
}

export function forgetMeteorDrawn(bodyId: number): void {
  drawn.delete(bodyId);
}

export function listMeteorDrawn(): MeteorDrawn[] {
  return Array.from(drawn.values());
}

export function clearMeteorForensics(): void {
  drawn.clear();
}
