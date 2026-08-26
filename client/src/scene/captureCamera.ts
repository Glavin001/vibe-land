// A camera the harness can park, for capture and perceptual comparison.
//
// Every look-at-it decision in this project -- fog density, AO strength,
// texture grain -- has to be judged from the SAME viewpoint across candidates,
// and until now there was no way to get one. The player camera is the only
// camera, its spawn moves tens of metres between sessions, and downtown is a
// 21 m grid with no gaps worth standing in: walking to a vantage reliably ends
// up inside a building photographing an unlit interior. Several sweeps were
// thrown away to that before this existed.
//
// Deliberately camera-only. It does not move the player, touch input, or tell
// the server anything -- so hitscan, streaming and the area of interest all
// carry on from wherever the player actually stands, and a capture cannot
// accidentally measure a different part of the city than the one being
// simulated. That also means it is safe to leave installed: nothing reads it
// unless a harness sets it.

import * as THREE from 'three';

export type CapturePose = {
  position: [number, number, number];
  lookAt: [number, number, number];
};

let pose: CapturePose | null = null;

export function setCapturePose(next: CapturePose | null): void {
  pose = next;
}

export function capturePose(): CapturePose | null {
  return pose;
}

/** Apply the parked pose, if one is set. Returns whether it took over. */
export function applyCapturePose(camera: THREE.Camera): boolean {
  if (!pose) return false;
  camera.position.set(pose.position[0], pose.position[1], pose.position[2]);
  camera.lookAt(pose.lookAt[0], pose.lookAt[1], pose.lookAt[2]);
  return true;
}
