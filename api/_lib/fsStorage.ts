// Filesystem backend for the world-publishing feature. Stores everything
// under a single root directory, mirroring the R2 key layout so a directory
// tree can be rsync'd into an R2 bucket (or vice versa) without any
// transformation. Great for local dev, persistent-disk Vercel setups and
// self-hosted installs that don't want to run an S3 server.

import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  ScreenshotContent,
  WorldContent,
  WorldMetadata,
  WorldStorage,
  WorldSummary,
} from './storage.js';
import { WriteConflictError } from './storage.js';

const PUBLISHED_SUBDIR = 'published';
const WORLD_SUFFIX = '.world.json';
const META_SUFFIX = '.meta.json';
const SCREENSHOT_SUFFIX = '.screenshot.jpg';

// Reject path-traversal attempts. World ids are generated server-side so
// this is defence-in-depth against anyone sending a crafted /api/worlds/<id>.
function assertSafeId(id: string): void {
  if (id.length === 0 || id.length > 128 || id.includes('/') || id.includes('\\') || id.includes('..')) {
    throw new Error(`Unsafe world id: ${id}`);
  }
}

export class FsWorldStorage implements WorldStorage {
  readonly kind = 'local' as const;

  private constructor(private readonly rootDir: string) {}

  static fromRootDir(rootDir: string): FsWorldStorage {
    // Resolve to an absolute path so relative paths in env vars still work.
    return new FsWorldStorage(path.resolve(rootDir));
  }

  private publishedDir(): string {
    return path.join(this.rootDir, PUBLISHED_SUBDIR);
  }

  private worldPath(id: string): string {
    assertSafeId(id);
    return path.join(this.publishedDir(), `${id}${WORLD_SUFFIX}`);
  }

  private metaPath(id: string): string {
    assertSafeId(id);
    return path.join(this.publishedDir(), `${id}${META_SUFFIX}`);
  }

  private screenshotPath(id: string): string {
    assertSafeId(id);
    return path.join(this.publishedDir(), `${id}${SCREENSHOT_SUFFIX}`);
  }

  async putWorld(id: string, gzippedBytes: Buffer, metadata: WorldMetadata): Promise<void> {
    await fs.mkdir(this.publishedDir(), { recursive: true });
    // flag: 'wx' is the POSIX write-exclusive create flag. fs.writeFile
    // will throw EEXIST if the file already exists, giving us the same
    // write-once semantics the R2 backend has via IfNoneMatch: '*'.
    try {
      await fs.writeFile(this.worldPath(id), gzippedBytes, { flag: 'wx' });
    } catch (err) {
      if ((err as { code?: string }).code === 'EEXIST') {
        throw new WriteConflictError(id);
      }
      throw err;
    }
    // Write metadata as a sidecar file. S3 uses x-amz-meta-* headers for
    // this; the filesystem doesn't have an equivalent so we persist a small
    // JSON companion next to the world payload.
    try {
      await fs.writeFile(this.metaPath(id), JSON.stringify(metadata, null, 2));
    } catch (err) {
      // If metadata write fails after the world succeeded, roll back so
      // the published folder doesn't end up with an unreadable entry.
      await fs.unlink(this.worldPath(id)).catch(() => undefined);
      throw err;
    }
  }

  async hasWorld(id: string): Promise<boolean> {
    try {
      await fs.access(this.worldPath(id));
      return true;
    } catch {
      return false;
    }
  }

  async getWorld(id: string): Promise<WorldContent | null> {
    try {
      const bytes = await fs.readFile(this.worldPath(id));
      return { bytes, contentEncoding: 'gzip' };
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') return null;
      throw err;
    }
  }

  async listWorlds(limit: number): Promise<WorldSummary[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.publishedDir());
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') return [];
      throw err;
    }

    const metaFiles = entries.filter((name) => name.endsWith(META_SUFFIX));
    const summaries = await Promise.all(
      metaFiles.map(async (metaFile): Promise<WorldSummary | null> => {
        const id = metaFile.slice(0, -META_SUFFIX.length);
        try {
          assertSafeId(id);
        } catch {
          return null;
        }
        try {
          const [metaBuf, worldStat] = await Promise.all([
            fs.readFile(this.metaPath(id)),
            fs.stat(this.worldPath(id)),
          ]);
          const meta = JSON.parse(metaBuf.toString('utf-8')) as Partial<WorldMetadata>;
          const name = typeof meta.name === 'string' ? meta.name : 'Untitled World';
          const description = typeof meta.description === 'string' ? meta.description : '';
          const createdAt = typeof meta.createdAt === 'number' ? meta.createdAt : worldStat.mtimeMs;
          const version = typeof meta.version === 'number' ? meta.version : 0;
          return {
            id,
            name,
            description,
            createdAt,
            version,
            size: worldStat.size,
          };
        } catch (err) {
          console.warn('[fsStorage] failed to read world metadata', id, err);
          return null;
        }
      }),
    );

    return summaries
      .filter((entry): entry is WorldSummary => entry !== null)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  async putScreenshot(id: string, bytes: Buffer, _contentType: string): Promise<void> {
    await fs.mkdir(this.publishedDir(), { recursive: true });
    // Screenshots are intentionally overwritable so a user who republishes
    // can update the preview. The publish handler verifies the world
    // exists before calling this.
    await fs.writeFile(this.screenshotPath(id), bytes);
  }

  async getScreenshot(id: string): Promise<ScreenshotContent | null> {
    try {
      const bytes = await fs.readFile(this.screenshotPath(id));
      return { bytes, contentType: 'image/jpeg' };
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') return null;
      throw err;
    }
  }
}
