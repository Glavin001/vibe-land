// Named places for films (client/native/film): a scene's buildings, parking
// spots, streets and districts, from the .meta.json its builder writes
// (structures/vibe-town/build-town.mjs). Anywhere a film wants a point it
// can name a place instead: place('car-5'), place('elm-park/house-26'),
// place('house', { nearest: [-51, 16] }).

/** Each scene's meta, relative to the bundle dir the native scripts run in (client/dist-native). */
export const SCENE_META = {
  town: '../../structures/vibe-town/out/vibe-town.meta.json',
};

/** The scene's places, or [] when it names none (or the file cannot be read). */
export async function loadPlaces(scene) {
  const file = SCENE_META[scene];
  if (!file) return [];
  try {
    const meta = JSON.parse(await (await fetch(`file://${file}`)).text());
    return meta.places ?? [];
  } catch (error) {
    console.error(`[film] no places for ${scene} (${file}): ${error?.message ?? error}`);
    return [];
  }
}

/**
 * Where a camera looks at a place: a building's middle (half its top), a
 * car's body, a street's or district's centre at ground level.
 */
function aimOf(p) {
  if (p.kind === 'car') return [p.position[0], 0.9, p.position[2]];
  if (p.top != null) return [p.position[0], p.top / 2, p.position[2]];
  return [...p.position];
}

/** A resolver over the scene's places: place(idOrKind, { nearest: [x, z] }). */
export function placeResolver(list) {
  const all = list.map((p) => ({ ...p, aim: aimOf(p) }));
  const byId = new Map(all.map((p) => [p.id, p]));
  const isBuilding = (p) => p.top != null;
  function place(query, { nearest } = {}) {
    if (byId.has(query) && !nearest) return byId.get(query);
    const matches = all.filter((p) => p.kind === query || (query === 'building' && isBuilding(p))
      || p.id === query || p.id.endsWith(`/${query}`) || p.district === query);
    if (!matches.length) {
      const hint = all.length ? `kinds: ${[...new Set(all.map((p) => p.kind))].join(', ')}; ids like ${all.slice(0, 3).map((p) => p.id).join(', ')}` : 'this scene names no places';
      throw new Error(`no place '${query}' (${hint})`);
    }
    if (!nearest) {
      if (matches.length > 1) throw new Error(`'${query}' names ${matches.length} places: add { nearest: [x, z] } or use an id (${matches.slice(0, 4).map((p) => p.id).join(', ')}, ...)`);
      return matches[0];
    }
    const d = (p) => Math.hypot(p.position[0] - nearest[0], p.position[2] - nearest[1]);
    return matches.reduce((a, b) => (d(b) < d(a) ? b : a));
  }
  place.all = all;
  return place;
}

/** A point: a vector as given, or a place (or its id) as where to look at it. */
export function point(v, place) {
  if (Array.isArray(v)) return [...v];
  if (typeof v === 'string') return [...place(v).aim];
  if (v && v.offsetOf !== undefined) return point(v.offsetOf, place).map((c, k) => c + (v.by[k] ?? 0));
  if (v && Array.isArray(v.aim)) return [...v.aim];
  if (v && Array.isArray(v.position)) return [...v.position];
  throw new Error(`not a point: ${JSON.stringify(v)}`);
}

/** A point `by` metres from a point, place or place id: offset('car-5', [0, 2, -6]). */
export const offset = (v, by) => ({ offsetOf: v, by });
