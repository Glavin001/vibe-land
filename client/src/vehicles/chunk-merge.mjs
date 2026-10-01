/** Minimum stress-chunk mass.
 *
 * Every physics part is a node of the native stress solve. A very light part
 * on stiff steel bonds (a 0.11 kg pivot bolt, 0.8 kg mounts, 0.09 kg light
 * bar cells) is a very high-frequency mode of that system, and with its short
 * centre-to-centre distances and small contact patches it drove a fleet car's
 * solve to need hundreds of iterations and still stall just above tolerance
 * in float. Vehicle lab, monster truck on the rough course at 64 iterations,
 * 2026-10-01: 0% of solves converged; with every chunk at least 1 kg and the
 * geometric spread removed, 70%, the rest ~2 iterations short. The city's
 * buildings, whose chunks are tonnes, converge in under 10.
 *
 * Physically a fastener or a lens is not a fracture piece of its own: it
 * comes away with the part it is bolted to. So a part lighter than
 * MIN_CHUNK_KG joins the neighbour it shares the most bonded area with,
 * among neighbours the rig moves the same way (same corner, role and
 * component), so posing and the solver's rigid chunks stay consistent.
 * Functional anchors (chassis, engine, driveline) never move into others.
 */
export const MIN_CHUNK_KG = 1.0;

const motionKey = m => m ? JSON.stringify([m.corner ?? null, m.role ?? null, m.component ?? null]) : 'body';
const identity = r => !r || (r[0] === 0 && r[1] === 0 && r[2] === 0 && r[3] === 1);

/** Merge `src` into `dst` in place: shapes, visuals and bounds re-based on dst. */
function absorb(dst, src) {
  if (!identity(dst.rotation) || !identity(src.rotation)) throw Error(`Cannot merge rotated parts ${src.id} into ${dst.id}`);
  const off = src.position.map((x, k) => x - dst.position[k]);
  const shift = p => p.map((x, k) => x + off[k]);
  dst.shapes = [...dst.shapes, ...src.shapes.map(s => ({ ...s, position: shift(s.position) }))];
  dst.visualIds = [...(dst.visualIds ?? [dst.id]), ...(src.visualIds ?? [src.id])];
  dst.sourcePartIds = [...(dst.sourcePartIds ?? []), ...(src.sourcePartIds ?? [])];
  if (dst.visuals && src.visuals) dst.visuals = [...dst.visuals, ...src.visuals.map(v => ({ ...v, localTranslation: shift(v.localTranslation) }))];
  if (Number.isFinite(dst.volumeM3) && Number.isFinite(src.volumeM3)) dst.volumeM3 += src.volumeM3;
  if (Number.isFinite(dst.massKg) && Number.isFinite(src.massKg)) dst.massKg += src.massKg;
  if (dst.bounds && src.bounds) dst.bounds = { min: dst.bounds.min.map((x, k) => Math.min(x, src.bounds.min[k])), max: dst.bounds.max.map((x, k) => Math.max(x, src.bounds.max[k])) };
}

/**
 * Merge every part lighter than `minKg` into its best-bonded same-motion
 * neighbour, lightest first, until none can move. Mutates `parts` and
 * `bonds` (bond ends renamed; bonds inside one part dropped). `massOf(part)`
 * gives a part's authored mass. Returns what moved where, and the light parts
 * that had no same-motion neighbour.
 */
export function mergeLightChunks(parts, bonds, massOf, minKg = MIN_CHUNK_KG) {
  const merged = [], stuck = new Set();
  for (;;) {
    const byId = new Map(parts.map(p => [p.id, p]));
    const light = parts.filter(p => !p.functionality && !stuck.has(p.id) && massOf(p) < minKg).sort((a, b) => massOf(a) - massOf(b));
    if (!light.length) break;
    const src = light[0];
    const shared = new Map();
    for (const b of bonds) {
      const other = b.a === src.id ? b.b : b.b === src.id ? b.a : null;
      if (!other || other === src.id) continue;
      const o = byId.get(other);
      if (!o || motionKey(o.motion) !== motionKey(src.motion)) continue;
      shared.set(other, (shared.get(other) ?? 0) + b.area);
    }
    if (!shared.size) { stuck.add(src.id); continue; }
    const into = [...shared].sort((x, y) => y[1] - x[1])[0][0];
    const kg = massOf(src);
    absorb(byId.get(into), src);
    for (const b of bonds) { if (b.a === src.id) b.a = into; if (b.b === src.id) b.b = into; }
    bonds.splice(0, bonds.length, ...bonds.filter(b => b.a !== b.b));
    parts.splice(parts.indexOf(src), 1);
    merged.push({ part: src.id, name: src.name, kg, into, intoName: byId.get(into).name });
  }
  return { merged, unmerged: [...stuck].map(id => parts.find(p => p.id === id)).filter(Boolean).map(p => ({ part: p.id, name: p.name, kg: massOf(p) })) };
}
