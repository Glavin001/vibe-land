import { ClampToEdgeWrapping, DataTexture, LinearFilter, RGBAFormat, Vector4 } from 'three';

export interface GrassContact {
  x: number; z: number;
  /** Half-width/length of the footprint, in its local X/Z axes. */
  radiusX: number; radiusZ: number;
  yaw?: number;
  shape?: 'ellipse' | 'box';
  pressure?: number;
  /** Seconds before recovery starts; resting objects refresh this hold. */
  hold?: number;
  /** Lasting crease, independent of temporary contact pressure (0–1). */
  damage?: number;
  /** Previous position makes fast vehicles leave a continuous swept track. */
  fromX?: number; fromZ?: number;
}

/** A scrolling 64 m interaction field, independent of the blade count.
 * 128² cells, one bilinear vertex sample, no per-blade collisions or simulations. */
export class GrassInteraction {
  readonly size = 128;
  readonly span = 64;
  readonly texel = this.span / this.size;
  readonly data = new Uint8Array(this.size * this.size * 4);
  readonly texture = new DataTexture(this.data, this.size, this.size, RGBAFormat);
  private readonly previousData = new Uint8Array(this.data.length);
  readonly previousTexture = new DataTexture(this.previousData, this.size, this.size, RGBAFormat);
  private scrolled = true;
  private committedAt = -1;
  readonly bounds = new Vector4(-32, -32, 64, 64);
  readonly pressure = new Float32Array(this.size * this.size);
  private readonly dx = new Float32Array(this.pressure.length);
  private readonly dz = new Float32Array(this.pressure.length);
  private readonly hold = new Float32Array(this.pressure.length);
  private readonly scratch = new Float32Array(this.pressure.length);
  readonly damage = new Float32Array(this.pressure.length);
  // Packed 8 m history tiles. Bounded to 256 KiB plus map overhead; local cosmetic
  // history survives camera travel, but never becomes authoritative gameplay state.
  private readonly history = new Map<string, { data: Uint8Array; time: number }>();
  readonly canopies = new Float32Array(8);
  canopyCount = 0;
  readonly impulses = new Float32Array(8);
  impulseCount = 0;
  private lastTime = -1;
  private stampCount = 0;
  private visits = 0;
  private dirty = true;
  activeCells = 0;
  readonly maxStamps = 192;
  readonly maxCellVisits = 32_768;
  get hasBudget(): boolean { return this.stampCount < this.maxStamps && this.visits < this.maxCellVisits; }

  constructor() {
    this.texture.name = 'Grass contact and recovery field';
    this.texture.minFilter = this.texture.magFilter = LinearFilter;
    this.texture.wrapS = this.texture.wrapT = ClampToEdgeWrapping;
    this.texture.generateMipmaps = false;
    this.previousTexture.minFilter = this.previousTexture.magFilter = LinearFilter;
    this.previousTexture.wrapS = this.previousTexture.wrapT = ClampToEdgeWrapping;
    this.previousTexture.generateMipmaps = false;
    this.commit();
  }

  /** Begin a 20 Hz update. Returns false between ticks. */
  begin(time: number, cameraX: number, cameraZ: number): boolean {
    if (this.lastTime >= 0 && time - this.lastTime < 0.05) return false;
    const dt = this.lastTime < 0 ? 0 : Math.max(0, time - this.lastTime);
    this.lastTime = time;
    this.stampCount = this.visits = this.canopyCount = 0;
    for (let i = this.impulseCount-1; i >= 0; i--) {
      if (time-this.impulses[i*4+2] > 1.6) {
        this.impulses.copyWithin(i*4, (i+1)*4, this.impulseCount*4);
        this.impulseCount--;
      }
    }
    this.scroll(Math.floor(cameraX / 8) * 8 - 32, Math.floor(cameraZ / 8) * 8 - 32);
    const decay = Math.exp(-dt / 1.8);
    const damageDecay = Math.exp(-dt / 180);
    for (let i = 0; i < this.pressure.length; i++) {
      if (this.damage[i] > 0) {
        this.damage[i] *= damageDecay;
        if (this.damage[i] < 0.003) this.damage[i] = 0;
        this.dirty = true;
      }
      if (this.pressure[i] === 0) {
        if (this.damage[i] === 0 && (this.dx[i] !== 0 || this.dz[i] !== 0)) {
          this.dx[i] = this.dz[i] = 0; this.dirty = true;
        }
        continue;
      }
      const held = this.hold[i];
      this.hold[i] = Math.max(0, held - dt);
      if (held < dt) {
        const falloff = held > 0 ? Math.exp(-(dt - held) / 1.8) : decay;
        this.pressure[i] *= falloff;
        if (this.damage[i] === 0) { this.dx[i] *= falloff; this.dz[i] *= falloff; }
        if (this.pressure[i] < 0.003) {
          this.pressure[i] = 0;
          if (this.damage[i] === 0) this.dx[i] = this.dz[i] = 0;
        }
        this.dirty = true;
      }
    }
    return true;
  }

  private scroll(x: number, z: number): void {
    const sx = Math.round((x - this.bounds.x) / this.texel);
    const sz = Math.round((z - this.bounds.y) / this.texel);
    if (!sx && !sz) return;
    this.scrolled = true;
    this.archive();
    for (const channel of [this.pressure, this.dx, this.dz, this.hold, this.damage]) {
      this.scratch.set(channel);
      channel.fill(0);
      if (Math.abs(sx) < this.size && Math.abs(sz) < this.size) {
        for (let row = Math.max(0, -sz); row < Math.min(this.size, this.size - sz); row++) {
          const start = Math.max(0, -sx), end = Math.min(this.size, this.size - sx);
          channel.set(this.scratch.subarray((row + sz) * this.size + start + sx,
            (row + sz) * this.size + end + sx), row * this.size + start);
        }
      }
    }
    this.bounds.set(x, z, this.span, this.span);
    // Restore only entering cells; overlapping cells already contain current state.
    for (let tz = 0; tz < 8; tz++) for (let tx = 0; tx < 8; tx++) {
      const tile = this.history.get(`${x/8+tx},${z/8+tz}`);
      if (!tile) continue;
      const decay = Math.exp(-(this.lastTime-tile.time)/180);
      for (let rz = 0; rz < 16; rz++) for (let rx = 0; rx < 16; rx++) {
        const ix = tx*16+rx, iz = tz*16+rz;
        if (ix+sx >= 0 && ix+sx < this.size && iz+sz >= 0 && iz+sz < this.size) continue;
        const i = iz*this.size+ix, j = (rz*16+rx)*4;
        if (!tile.data[j]) continue;
        this.damage[i] = tile.data[j]/255*decay;
        this.dx[i] = (tile.data[j+1]-128)/127;
        this.dz[i] = (tile.data[j+2]-128)/127;
      }
    }
    this.dirty = true;
  }

  /** Keep only the two closest canopy bodies. Grass shorter than the body is unaffected. */
  canopy(x: number, y: number, z: number, radius: number): void {
    if (![x,y,z,radius].every(Number.isFinite) || radius <= 0) return;
    const distance = (x-this.bounds.x-32)**2+(z-this.bounds.y-32)**2;
    if (distance > 16*16) return;
    let slot = this.canopyCount;
    if (slot >= 2) {
      const d0 = (this.canopies[0]-this.bounds.x-32)**2+(this.canopies[2]-this.bounds.y-32)**2;
      const d1 = (this.canopies[4]-this.bounds.x-32)**2+(this.canopies[6]-this.bounds.y-32)**2;
      slot = d0 > d1 ? 0 : 1;
      if (distance >= Math.max(d0,d1)) return;
    } else this.canopyCount++;
    this.canopies.set([x,y,z,Math.min(3,radius)], slot*4);
  }

  /** At most two one-shot radial wind waves; no particle or physics allocation. */
  impulse(x: number, z: number, time: number, strength: number): void {
    if (![x,z,time,strength].every(Number.isFinite) || strength <= 0
      || Math.hypot(x-this.bounds.x-32,z-this.bounds.y-32) > 24) return;
    const slot = this.impulseCount < 2 ? this.impulseCount++ : (this.impulses[2] < this.impulses[6] ? 0 : 1);
    this.impulses.set([x,z,time,Math.min(1,strength)],slot*4);
  }

  private archive(): void {
    for (let tz = 0; tz < 8; tz++) for (let tx = 0; tx < 8; tx++) {
      const key = `${this.bounds.x/8+tx},${this.bounds.y/8+tz}`;
      let data: Uint8Array | undefined;
      for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
        const i = (tz*16+z)*this.size+tx*16+x;
        if (this.damage[i] < 0.004) continue;
        data ??= new Uint8Array(16*16*4);
        const j = (z*16+x)*4;
        data[j] = Math.round(this.damage[i]*255);
        data[j+1] = Math.round(128+this.dx[i]*127);
        data[j+2] = Math.round(128+this.dz[i]*127);
      }
      this.history.delete(key);
      if (data) this.history.set(key, { data, time: this.lastTime });
    }
    while (this.history.size > 256) this.history.delete(this.history.keys().next().value!);
  }

  get historyBytes(): number { return this.history.size * 1024; }

  stamp(contact: GrassContact): boolean {
    if (!this.hasBudget) return false;
    const { x, z } = contact;
    if (![x, z, contact.radiusX, contact.radiusZ, contact.yaw ?? 0, contact.pressure ?? 1,
      contact.hold ?? 0.2, contact.damage ?? 0, contact.fromX ?? x, contact.fromZ ?? z].every(Number.isFinite)) return false;
    const rx = Math.max(0.25, Math.min(8, contact.radiusX));
    const rz = Math.max(0.25, Math.min(8, contact.radiusZ));
    const fx = contact.fromX ?? x, fz = contact.fromZ ?? z;
    const distance = Math.hypot(x - fx, z - fz);
    const reach = Math.hypot(rx, rz);
    if (Math.max(x, fx)+reach < this.bounds.x || Math.min(x, fx)-reach > this.bounds.x+this.span
      || Math.max(z, fz)+reach < this.bounds.y || Math.min(z, fz)-reach > this.bounds.y+this.span) return false;
    // Teleports must not mow a line through the entire map.
    const steps = distance < 12 ? Math.min(20, Math.ceil(distance / (Math.min(rx, rz) * 0.7))) : 0;
    for (let step = 0; step <= steps; step++) {
      if (!this.hasBudget) break;
      this.stampCount++;
      const t = steps ? step / steps : 1;
      this.ellipse(fx + (x - fx) * t, fz + (z - fz) * t, rx, rz,
        contact.yaw ?? 0, Math.max(0, Math.min(1, contact.pressure ?? 1)), Math.max(0, Math.min(8, contact.hold ?? 0.2)), contact.shape === 'box',
        distance > 0.01 && distance < 12 ? (x-fx)/distance : 0,
        distance > 0.01 && distance < 12 ? (z-fz)/distance : 0,
        Math.max(0, Math.min(1, contact.damage ?? 0)));
    }
    return true;
  }

  private ellipse(x: number, z: number, rx: number, rz: number, yaw: number, pressure: number, hold: number, box: boolean, travelX: number, travelZ: number, damage: number): void {
    const reach = Math.hypot(rx, rz) + this.texel;
    const minX = Math.max(0, Math.floor((x - reach - this.bounds.x) / this.texel));
    const maxX = Math.min(this.size - 1, Math.ceil((x + reach - this.bounds.x) / this.texel));
    const minZ = Math.max(0, Math.floor((z - reach - this.bounds.y) / this.texel));
    const maxZ = Math.min(this.size - 1, Math.ceil((z + reach - this.bounds.y) / this.texel));
    const c = Math.cos(yaw), s = Math.sin(yaw);
    for (let iz = minZ; iz <= maxZ; iz++) for (let ix = minX; ix <= maxX; ix++) {
      if (++this.visits > this.maxCellVisits) return;
      const dx = this.bounds.x + (ix + 0.5) * this.texel - x;
      const dz = this.bounds.y + (iz + 0.5) * this.texel - z;
      const localX = dx * c - dz * s, localZ = dx * s + dz * c;
      // Box contacts retain pressure in the corners under a slab. A fixed
      // half-metre edge avoids a huge soft region under large debris pieces.
      const edge = box ? Math.min(1, (rx-Math.abs(localX))/this.texel, (rz-Math.abs(localZ))/this.texel)
        : Math.min(1, (1-Math.hypot(localX/rx, localZ/rz))*3);
      if (edge <= 0) continue;
      const weight = pressure * edge * edge * (3 - 2 * edge);
      const i = iz * this.size + ix;
      if (weight * damage > this.damage[i]) { this.damage[i] = weight * damage; this.dirty = true; }
      if (weight >= this.pressure[i]) {
        this.pressure[i] = weight;
        const length = Math.max(0.2, Math.hypot(dx, dz));
        // Motion combs the trail; stationary feet/slabs spread it radially.
        const vx = dx / length * 0.35 + travelX, vz = dz / length * 0.35 + travelZ;
        const norm = Math.max(0.01, Math.hypot(vx, vz));
        this.dx[i] = vx / norm * weight;
        this.dz[i] = vz / norm * weight;
        this.hold[i] = hold;
        this.dirty = true;
      } else if (weight > 0.5) {
        // A stationary stone keeps the bed compressed even between scan cycles.
        this.hold[i] = Math.max(this.hold[i], hold);
      }
    }
  }

  blendAt(time: number): number { return Math.max(0, Math.min(1, (time-this.committedAt)/0.05)); }

  commit(): void {
    if (!this.dirty) return;
    this.previousData.set(this.data);
    this.committedAt = this.lastTime;
    this.activeCells = 0;
    for (let i = 0; i < this.pressure.length; i++) {
      this.data[i * 4] = Math.round(this.pressure[i] * 255);
      this.data[i * 4 + 1] = Math.round(128 + this.dx[i] * 127);
      this.data[i * 4 + 2] = Math.round(128 + this.dz[i] * 127);
      this.data[i * 4 + 3] = Math.round(this.damage[i] * 255);
      if (this.pressure[i] > 0.01) this.activeCells++;
    }
    if (this.scrolled) { this.previousData.set(this.data); this.scrolled = false; }
    this.previousTexture.needsUpdate = true;
    this.texture.needsUpdate = true;
    this.dirty = false;
  }

  sample(x: number, z: number): number {
    const ix = Math.floor((x - this.bounds.x) / this.texel), iz = Math.floor((z - this.bounds.y) / this.texel);
    return ix >= 0 && iz >= 0 && ix < this.size && iz < this.size ? this.pressure[iz * this.size + ix] : 0;
  }

  clear(): void {
    this.pressure.fill(0); this.dx.fill(0); this.dz.fill(0); this.hold.fill(0); this.damage.fill(0); this.history.clear(); this.canopyCount = this.impulseCount = 0;
    this.scrolled = true; this.dirty = true; this.commit();
  }
  dispose(): void { this.texture.dispose(); this.previousTexture.dispose(); }
}
