import type {
  DynamicEntity,
  StaticProp,
  WorldDocument,
  WorldTerrainTile,
} from '../world/worldDocument';

const MAX_SUMMARY_LENGTH = 500;

/**
 * Compare two WorldDocument snapshots and return a short human-readable string
 * describing what changed. Returns `null` when the documents are equivalent.
 */
export function summarizeWorldDiff(
  before: WorldDocument,
  after: WorldDocument,
): string | null {
  if (before === after) return null;

  const fragments: string[] = [];

  if (before.meta.name !== after.meta.name) {
    fragments.push(`renamed world to "${after.meta.name}"`);
  }
  if (before.meta.description !== after.meta.description) {
    fragments.push('updated description');
  }

  diffEntities('static prop', before.staticProps, after.staticProps, fragments);
  diffEntities('dynamic entity', before.dynamicEntities, after.dynamicEntities, fragments);
  diffTerrain(before, after, fragments);

  if (fragments.length === 0) return null;
  return truncate(fragments.join('; '));
}

function diffEntities<T extends StaticProp | DynamicEntity>(
  label: string,
  before: T[],
  after: T[],
  out: string[],
): void {
  const beforeById = new Map(before.map((e) => [e.id, e]));
  const afterById = new Map(after.map((e) => [e.id, e]));

  const added: T[] = [];
  const removed: T[] = [];
  const modified: T[] = [];

  for (const entity of after) {
    const prev = beforeById.get(entity.id);
    if (!prev) {
      added.push(entity);
    } else if (!shallowEqualEntity(prev, entity)) {
      modified.push(entity);
    }
  }
  for (const entity of before) {
    if (!afterById.has(entity.id)) {
      removed.push(entity);
    }
  }

  if (added.length > 0) {
    out.push(`+${added.length} ${label}${plural(added.length)} (${describeIds(added, 4)})`);
  }
  if (removed.length > 0) {
    out.push(`−${removed.length} ${label}${plural(removed.length)} (${describeIds(removed, 4)})`);
  }
  if (modified.length > 0) {
    out.push(`~${modified.length} ${label}${plural(modified.length)} (${describeIds(modified, 4)})`);
  }
}

function diffTerrain(before: WorldDocument, after: WorldDocument, out: string[]): void {
  const beforeByKey = new Map<string, WorldTerrainTile>();
  for (const tile of before.terrain.tiles) {
    beforeByKey.set(`${tile.tileX}:${tile.tileZ}`, tile);
  }
  const afterByKey = new Map<string, WorldTerrainTile>();
  for (const tile of after.terrain.tiles) {
    afterByKey.set(`${tile.tileX}:${tile.tileZ}`, tile);
  }

  let added = 0;
  let removed = 0;
  let modified = 0;
  for (const [key, tile] of afterByKey) {
    const prev = beforeByKey.get(key);
    if (!prev) {
      added += 1;
    } else if (!heightsEqual(prev.heights, tile.heights)) {
      modified += 1;
    }
  }
  for (const key of beforeByKey.keys()) {
    if (!afterByKey.has(key)) {
      removed += 1;
    }
  }

  if (added > 0) out.push(`+${added} terrain tile${plural(added)}`);
  if (removed > 0) out.push(`−${removed} terrain tile${plural(removed)}`);
  if (modified > 0) out.push(`sculpted ${modified} terrain tile${plural(modified)}`);
}

function describeIds(entities: Array<{ id: number }>, max: number): string {
  if (entities.length <= max) {
    return entities.map((e) => `#${e.id}`).join(', ');
  }
  const shown = entities.slice(0, max).map((e) => `#${e.id}`).join(', ');
  return `${shown}, +${entities.length - max} more`;
}

function plural(n: number): string {
  return n === 1 ? '' : 's';
}

function shallowEqualEntity(a: StaticProp | DynamicEntity, b: StaticProp | DynamicEntity): boolean {
  if (a.id !== b.id) return false;
  if (a.kind !== b.kind) return false;
  if (!vec3Equal(a.position, b.position)) return false;
  if (!quatEqual(a.rotation, b.rotation)) return false;
  const aHalf = (a as StaticProp).halfExtents;
  const bHalf = (b as StaticProp).halfExtents;
  if (aHalf || bHalf) {
    if (!aHalf || !bHalf || !vec3Equal(aHalf, bHalf)) return false;
  }
  const aRadius = (a as DynamicEntity).radius;
  const bRadius = (b as DynamicEntity).radius;
  if (aRadius !== bRadius) return false;
  return true;
}

function vec3Equal(a: readonly number[], b: readonly number[]): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function quatEqual(a: readonly number[], b: readonly number[]): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

function heightsEqual(a: number[], b: number[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function truncate(text: string): string {
  if (text.length <= MAX_SUMMARY_LENGTH) return text;
  return `${text.slice(0, MAX_SUMMARY_LENGTH - 1)}…`;
}
