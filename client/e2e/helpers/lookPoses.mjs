// Named camera poses for comparing how the city LOOKS across renderers: the
// web client on WebGL (the reference), the same client on WebGPU, and the
// native app (e2e/look-capture.mjs, client/native/look-capture.mjs).
//
// Computed from the city's own structure list (the e2e bridge's
// cityStructures()) and the fleet's parking spots, so a new scene pack moves
// the poses with it. Each is { name, position, lookAt } for the bridge's
// setCapturePose, which parks the camera only.

/** The capture is drawable: city streamed, concrete textures uploaded. */
export function lookReady(e2e) {
  return (e2e?.snapshot()?.city?.chunksTotal ?? 0) > 0
    && (e2e.cityStructures?.().length ?? 0) > 0
    && globalThis.__VIBE_CITY_TEX_READY__ === true;
}

export function lookPoses(structures) {
  const centre = [0, 1, 2].map((i) => structures.reduce((sum, s) => sum + s.position[i], 0) / structures.length);
  const tallest = structures.reduce((best, s) => (s.top > best.top ? s : best), structures[0]);
  // Outward from the city centre through the tallest building.
  let out = [tallest.position[0] - centre[0], tallest.position[2] - centre[2]];
  const len = Math.hypot(out[0], out[1]) || 1;
  out = [out[0] / len, out[1] / len];
  const fromTallest = (metres, eye) => [tallest.position[0] + out[0] * metres, eye, tallest.position[2] + out[1] * metres];
  return [
    // The whole city from a high corner: overall tone, fog, sky.
    { name: 'overview', position: [centre[0] + 95, 38, centre[2] + 95], lookAt: [centre[0], 4, centre[2]] },
    // The tallest building's facade at street level, sky behind.
    { name: 'facade', position: fromTallest(34, 1.7), lookAt: [tallest.position[0], tallest.top * 0.5, tallest.position[2]] },
    // The same wall up close: texture detail, tiling, normals.
    { name: 'closeup', position: fromTallest(12, 1.7), lookAt: [tallest.position[0], 3, tallest.position[2]] },
    // The monster truck's parking spot (city_fleet.rs DEFAULT_FLEET): a car, ground and grass.
    { name: 'car', position: [71, 2.2, 15], lookAt: [63, 0.8, 8] },
    // From outside the ring at eye height: horizon, sky, terrain.
    { name: 'skyline', position: [centre[0] - 95, 1.7, centre[2] - 30], lookAt: [centre[0], 9, centre[2]] },
  ];
}
