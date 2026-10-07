// Camera poses aimed at the city's Matter materials (graphics/matter): for
// each material wearing a look, two close views of one of its chunks from
// opposite sides (one is usually inside the room). From the e2e bridge's
// cityMaterials(), so a new pack moves the poses with it. Shared by the web
// (e2e/matter-look.mjs) and native (client/native/matter-look.mjs) captures.

/** The city is drawable and its materials are published. */
export function matterReady(e2e) {
  return (e2e?.snapshot()?.city?.chunksTotal ?? 0) > 0 && (e2e.cityMaterials?.().length ?? 0) > 0;
}

export function matterPoses(materials, { distance = 1.2, rise = 0.55 } = {}) {
  const poses = [];
  for (const m of materials) {
    if (!m.look || m.samples.length === 0) continue;
    // The middle sample: away from the ends of whatever it is part of.
    const [x, y, z] = m.samples[Math.floor(m.samples.length / 2)];
    const d = distance / Math.SQRT2;
    // The whole run of it from the front (props face -z), then two close views.
    const centre = [0, 1, 2].map((k) => m.samples.reduce((sum, p) => sum + p[k], 0) / m.samples.length);
    poses.push({
      name: `${m.look}--${m.name}--front`.replace(/[^a-z0-9-]+/gi, '_'),
      position: [centre[0], centre[1] + 1.1, centre[2] - 2.6],
      lookAt: centre,
    });
    for (const [side, sx, sz] of [['a', 1, -1], ['b', -1, -1]]) {
      poses.push({
        name: `${m.look}--${m.name}--${side}`.replace(/[^a-z0-9-]+/gi, '_'),
        position: [x + sx * d, y + rise, z + sz * d],
        lookAt: [x, y, z],
      });
    }
  }
  return poses;
}
