// One expensive object kept aside while it is not in use, for reuse by the
// next user that asks for the same key; anything else disposes it.
//
// DustLayer parks its volumetric renderer here while the render governor's
// sprite rung has the dust drawn as sprites: dropping the renderer there and
// building a new one when the governor's recovery probe gives the rung back
// rebaked its noise field and recompiled its programs mid-storm.

export interface Parkable {
  /** Back in use: drop whatever a fresh instance would not have. */
  resume(): void;
  dispose(): void;
}

export class ParkingSlot<T extends Parkable> {
  private parked: { item: T; key: string } | null = null;

  /** Keep `item` under `key`, disposing whatever was parked before. */
  park(item: T, key: string): void {
    if (this.parked && this.parked.item !== item) this.parked.item.dispose();
    this.parked = { item, key };
  }

  /** The parked item, resumed, if it was parked under `key`; a mismatch is disposed. */
  take(key: string): T | null {
    const parked = this.parked;
    if (!parked) return null;
    this.parked = null;
    if (parked.key !== key) {
      parked.item.dispose();
      return null;
    }
    parked.item.resume();
    return parked.item;
  }

  /** Dispose whatever is parked. */
  clear(): void {
    this.parked?.item.dispose();
    this.parked = null;
  }

  get occupied(): boolean {
    return this.parked !== null;
  }
}
