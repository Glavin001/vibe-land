// Storage abstraction for the world-publishing feature.
//
// The handlers under api/worlds/* only talk to this file. At runtime the
// factory picks the active backend based on environment variables:
//
//   * WORLDS_STORAGE_DIR=/some/path  -> filesystem backend (takes precedence
//                                       when set; useful for local dev and
//                                       for deployments that just want a
//                                       persistent disk instead of S3).
//   * R2_ENDPOINT / R2_ACCOUNT_ID    -> R2 (or any S3-compatible) backend.
//
// If neither is configured the feature is disabled; /api/worlds/config will
// report { enabled: false } and the client UI stays hidden.

// Maximum size for the gzipped world payload accepted by /api/worlds/publish.
// The client compresses world JSON before upload, so 5 MB gzipped leaves
// room for worlds that expand to roughly 30–50 MB of plain JSON.
export const MAX_PUBLISH_BYTES = 5 * 1024 * 1024;
// Maximum size for a screenshot upload.
export const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;

const ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
export function isValidWorldId(id: string): boolean {
  return ID_PATTERN.test(id);
}

export type WorldMetadata = {
  name: string;
  description: string;
  version: number;
  createdAt: number;
};

export type WorldSummary = WorldMetadata & {
  id: string;
  // Size of the stored (gzipped) world payload in bytes.
  size: number;
};

export type WorldContent = {
  // Raw bytes as persisted. When `contentEncoding === 'gzip'` the bytes are
  // gzipped and the caller is expected to decompress before handing them
  // back to the client.
  bytes: Buffer;
  contentEncoding?: 'gzip';
};

export type ScreenshotContent = {
  bytes: Buffer;
  contentType: string;
};

export type StorageKind = 'r2' | 'local';

export interface WorldStorage {
  readonly kind: StorageKind;

  /**
   * Writes a new world. Must reject with `WriteConflictError` if a world
   * already exists at the given id – implementations are write-once per id.
   */
  putWorld(id: string, gzippedBytes: Buffer, metadata: WorldMetadata): Promise<void>;

  /**
   * Returns true if a world with the given id already exists.
   * Used by the publish handler to avoid uuid collisions on PUT.
   */
  hasWorld(id: string): Promise<boolean>;

  getWorld(id: string): Promise<WorldContent | null>;

  listWorlds(limit: number): Promise<WorldSummary[]>;

  /**
   * Writes (or overwrites) the screenshot for an existing world. The caller
   * is responsible for verifying the world exists first.
   */
  putScreenshot(id: string, bytes: Buffer, contentType: string): Promise<void>;

  getScreenshot(id: string): Promise<ScreenshotContent | null>;
}

export class WriteConflictError extends Error {
  constructor(id: string) {
    super(`World with id ${id} already exists.`);
    this.name = 'WriteConflictError';
  }
}

import { FsWorldStorage } from './fsStorage.js';
import { getR2WorldStorage } from './r2Storage.js';

// Re-evaluated on every call so hot-reloading and tests that mutate
// process.env between requests always see the latest config.
export function getWorldStorage(): WorldStorage | null {
  const localDir = process.env.WORLDS_STORAGE_DIR?.trim();
  if (localDir) {
    return FsWorldStorage.fromRootDir(localDir);
  }
  return getR2WorldStorage();
}

export function isStorageEnabled(): boolean {
  return getWorldStorage() !== null;
}
