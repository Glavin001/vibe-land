// What the city layer drew, sampled for harnesses: Netlab v2's calibration
// compares these chunk poses with the ones its headless client stage computes
// from the same tape (server/src/bin/netlab2/chunks.rs `city_vs_live`).
//
// The layer notes its client, pose tables and frame time every frame (free:
// three references). Composing happens only when a harness asks
// (`__VIBE_E2E__.drawnWorld()`, 10 Hz in the city bench), from the tables the
// GPU reads, with the shader's own composition (cityPoseStore.ts).
//
// The chunks sampled are a deterministic, rotating subset -- every body's
// chunks cannot ride a 10 Hz JSON sample -- biased to what moves: up to
// DEBRIS_SAMPLE chunks drawn on a live or settled island body, and up to
// INTACT_SAMPLE chunks still on their structure's support body (serial 0),
// each a stride through the slots with a phase that advances per sample.

import type { CityClient } from '../city/cityClient';
import type { CityPoseStore } from '../city/cityPoseStore';

export const DEBRIS_SAMPLE = 400;
export const INTACT_SAMPLE = 100;

export interface CityDrawnSample {
  /** The city layer's frame time (performance.now() given to the pose step). */
  atMs: number;
  chunkCount: number;
  /** Sampled slots (global chunk index, manifest order). */
  slots: number[];
  /** Body key each slot's record names (the key its body index was last given). */
  bodies: number[];
  /** x, y, z per slot, metres, as composed. */
  positions: number[];
  /** qx, qy, qz, qw per slot, as composed. */
  rotations: number[];
  /** 1 when the shader draws the chunk (a record, and not below the hide depth). */
  drawn: number[];
}

let last: { client: CityClient; poses: CityPoseStore; atMs: number } | null = null;
let samples = 0;

/** Called by CityChunksLayer every frame after its pose step. */
export function noteCityDrawn(client: CityClient, poses: CityPoseStore, atMs: number): void {
  if (last && last.poses === poses && last.client === client) {
    last.atMs = atMs;
    return;
  }
  last = { client, poses, atMs };
}

/** Forget the layer (unmount). */
export function clearCityDrawn(): void {
  last = null;
}

const round = (value: number, scale: number): number => Math.round(value * scale) / scale;

/** The sample; null before the layer has drawn. */
export function sampleCityDrawn(): CityDrawnSample | null {
  if (!last) return null;
  const { poses, atMs } = last;
  const count = poses.chunkCount;
  const debris: number[] = [];
  const intact: number[] = [];
  for (let slot = 0; slot < count; slot += 1) {
    const index = poses.bodyIndexOfSlot[slot];
    if (index < 0) continue;
    const key = poses.keyOfIndex(index);
    if ((key & 0x0f_ffff) === 0) intact.push(slot);
    else debris.push(slot);
  }
  const pick = (from: number[], cap: number, out: number[]): void => {
    if (from.length === 0) return;
    const stride = Math.max(1, Math.ceil(from.length / cap));
    for (let i = samples % stride; i < from.length; i += stride) out.push(from[i]);
  };
  const slots: number[] = [];
  pick(debris, DEBRIS_SAMPLE, slots);
  pick(intact, INTACT_SAMPLE, slots);
  samples += 1;
  const pose = new Float32Array(7);
  const out: CityDrawnSample = { atMs, chunkCount: count, slots, bodies: [], positions: [], rotations: [], drawn: [] };
  for (const slot of slots) {
    const drawn = poses.chunkWorldPoseInto(slot, pose, 0);
    out.bodies.push(poses.keyOfIndex(poses.bodyIndexOfSlot[slot]));
    out.positions.push(round(pose[0], 1e4), round(pose[1], 1e4), round(pose[2], 1e4));
    out.rotations.push(round(pose[3], 1e5), round(pose[4], 1e5), round(pose[5], 1e5), round(pose[6], 1e5));
    out.drawn.push(drawn ? 1 : 0);
  }
  return out;
}
