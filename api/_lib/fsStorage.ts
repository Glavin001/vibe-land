// Filesystem backend for the world-publishing feature. Stores everything
// under a single root directory, mirroring the R2 key layout so a directory
// tree can be rsync'd into an R2 bucket (or vice versa) without any
// transformation. Great for local dev, persistent-disk Vercel setups and
// self-hosted installs that don't want to run an S3 server.
//
// Unlike the R2 backend, the filesystem backend still streams bodies
// through the serverless function – it has no way to generate "direct"
// upload URLs. `reserveUpload` therefore writes a short-lived reservation
// sidecar and returns function-local URLs pointing at the direct-upload
// endpoint. The reservation is consumed once both uploads have landed or
// left behind as an orphan if the client never completes the flow.

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  AllocationError,
  MAX_PUBLISH_BYTES,
  MAX_SCREENSHOT_BYTES,
  UPLOAD_EXPIRY_SECONDS,
  WriteConflictError,
  type Reservation,
  type ReserveUploadParams,
  type ScreenshotContent,
  type WorldContent,
  type WorldMetadata,
  type WorldStorage,
  type WorldSummary,
} from './storage.js';

const PUBLISHED_SUBDIR = 'published';
const WORLD_SUFFIX = '.world.json';
const META_SUFFIX = '.meta.json';
const RESERVATION_SUFFIX = '.reservation.json';
const SCREENSHOT_SUFFIX = '.screenshot.jpg';

// Reject path-traversal attempts. World ids are generated server-side so
// this is defence-in-depth against anyone sending a crafted /api/worlds/<id>.
function assertSafeId(id: string): void {
  if (id.length === 0 || id.length > 128 || id.includes('/') || id.includes('\\') || id.includes('..')) {
    throw new Error(`Unsafe world id: ${id}`);
  }
}

type ReservationFile = {
  expiresAt: number;
  worldContentLength: number;
  screenshotContentLength: number;
};

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

  private reservationPath(id: string): string {
    assertSafeId(id);
    return path.join(this.publishedDir(), `${id}${RESERVATION_SUFFIX}`);
  }

  private screenshotPath(id: string): string {
    assertSafeId(id);
    return path.join(this.publishedDir(), `${id}${SCREENSHOT_SUFFIX}`);
  }

  async reserveUpload(params: ReserveUploadParams): Promise<Reservation> {
    if (params.worldContentLength <= 0 || params.worldContentLength > MAX_PUBLISH_BYTES) {
      throw new AllocationError(`worldContentLength out of range (1..${MAX_PUBLISH_BYTES})`);
    }
    if (params.screenshotContentLength <= 0 || params.screenshotContentLength > MAX_SCREENSHOT_BYTES) {
      throw new AllocationError(`screenshotContentLength out of range (1..${MAX_SCREENSHOT_BYTES})`);
    }

    await fs.mkdir(this.publishedDir(), { recursive: true });

    const id = await this.allocateId();
    const createdAt = Date.now();
    const expiresAt = createdAt + UPLOAD_EXPIRY_SECONDS * 1000;

    const metadata: WorldMetadata = {
      name: params.name,
      description: params.description,
      version: params.version,
      createdAt,
    };

    // Write the meta sidecar first. listWorlds() doesn't surface entries
    // without a matching world file so leaving a meta-only sidecar around
    // from a cancelled publish doesn't leak into the gallery.
    try {
      await fs.writeFile(
        this.metaPath(id),
        JSON.stringify(metadata, null, 2),
        { flag: 'wx' },
      );
    } catch (err) {
      if ((err as { code?: string }).code === 'EEXIST') {
        throw new WriteConflictError(id);
      }
      throw err;
    }

    const reservation: ReservationFile = {
      expiresAt,
      worldContentLength: params.worldContentLength,
      screenshotContentLength: params.screenshotContentLength,
    };
    await fs.writeFile(
      this.reservationPath(id),
      JSON.stringify(reservation, null, 2),
      { flag: 'wx' },
    );

    return {
      id,
      createdAt,
      expiresAt,
      instructions: {
        mode: 'direct',
        world: {
          url: `/api/worlds/${encodeURIComponent(id)}/upload?target=world`,
          method: 'PUT',
          contentLength: params.worldContentLength,
          headers: {
            'Content-Type': 'application/json',
            'Content-Encoding': 'gzip',
          },
        },
        screenshot: {
          url: `/api/worlds/${encodeURIComponent(id)}/upload?target=screenshot`,
          method: 'PUT',
          contentLength: params.screenshotContentLength,
          headers: {
            'Content-Type': 'image/jpeg',
          },
        },
      },
    };
  }

  private async allocateId(): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const candidate = randomUUID();
      // Reject ids that already have any trace: a meta sidecar (reserved
      // or committed), a reservation, or either body file.
      const [meta, reservation, world, screenshot] = await Promise.all([
        this.exists(this.metaPath(candidate)),
        this.exists(this.reservationPath(candidate)),
        this.exists(this.worldPath(candidate)),
        this.exists(this.screenshotPath(candidate)),
      ]);
      if (!meta && !reservation && !world && !screenshot) {
        return candidate;
      }
    }
    throw new AllocationError('Failed to allocate a unique world id after 8 attempts.');
  }

  private async exists(p: string): Promise<boolean> {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Direct-upload endpoint uses this to persist the world payload. Verifies
   * the id was reserved via reserveUpload(), the reservation hasn't
   * expired, and that no world is already stored at that id.
   */
  async commitWorldUpload(id: string, bytes: Buffer): Promise<void> {
    const reservation = await this.readLiveReservation(id);
    if (bytes.length !== reservation.worldContentLength) {
      throw new Error(
        `World upload size ${bytes.length} does not match reserved ${reservation.worldContentLength}`,
      );
    }
    try {
      await fs.writeFile(this.worldPath(id), bytes, { flag: 'wx' });
    } catch (err) {
      if ((err as { code?: string }).code === 'EEXIST') {
        throw new WriteConflictError(id);
      }
      throw err;
    }
    await this.cleanupReservationIfComplete(id);
  }

  async commitScreenshotUpload(id: string, bytes: Buffer): Promise<void> {
    const reservation = await this.readLiveReservation(id);
    if (bytes.length !== reservation.screenshotContentLength) {
      throw new Error(
        `Screenshot upload size ${bytes.length} does not match reserved ${reservation.screenshotContentLength}`,
      );
    }
    try {
      await fs.writeFile(this.screenshotPath(id), bytes, { flag: 'wx' });
    } catch (err) {
      if ((err as { code?: string }).code === 'EEXIST') {
        throw new WriteConflictError(id);
      }
      throw err;
    }
    await this.cleanupReservationIfComplete(id);
  }

  private async readLiveReservation(id: string): Promise<ReservationFile> {
    let buf: Buffer;
    try {
      buf = await fs.readFile(this.reservationPath(id));
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') {
        throw new Error(`No active reservation for id ${id}`);
      }
      throw err;
    }
    const parsed = JSON.parse(buf.toString('utf-8')) as Partial<ReservationFile>;
    if (
      typeof parsed.expiresAt !== 'number'
      || typeof parsed.worldContentLength !== 'number'
      || typeof parsed.screenshotContentLength !== 'number'
    ) {
      throw new Error(`Malformed reservation file for id ${id}`);
    }
    if (parsed.expiresAt < Date.now()) {
      throw new Error(`Reservation for id ${id} has expired`);
    }
    return parsed as ReservationFile;
  }

  private async cleanupReservationIfComplete(id: string): Promise<void> {
    const [world, screenshot] = await Promise.all([
      this.exists(this.worldPath(id)),
      this.exists(this.screenshotPath(id)),
    ]);
    if (world && screenshot) {
      await fs.unlink(this.reservationPath(id)).catch(() => undefined);
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
          // Meta file exists but world hasn't landed yet – typical of an
          // in-flight or abandoned reservation. Silently skip it.
          if ((err as { code?: string }).code === 'ENOENT') return null;
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
