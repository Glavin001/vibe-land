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
//
// ## Upload model
//
// The world builder uploads two blobs per publish: the gzipped world JSON
// and a JPEG screenshot. Rather than streaming both bodies through the
// serverless function, the publish handler calls `reserveUpload()` which
// returns **upload instructions** the client then executes directly:
//
//   * R2 backend returns two presigned PUT URLs. The client PUTs both blobs
//     straight to R2. No bytes touch the Vercel function on the write path.
//     Bucket-level Write-Once semantics via IfNoneMatch:'*' + a 60-second
//     URL expiry keep the server in control of what can be uploaded.
//
//   * Filesystem backend returns two function-local PUT URLs pointing at
//     /api/worlds/<id>/upload?target=world|screenshot. The client still
//     streams through the function, but reserveUpload reserves the id
//     upfront (by writing a reservation sidecar) so each upload can be
//     validated against the reservation and cannot overwrite an existing
//     world or screenshot.
//
// Both backends enforce:
//   * a 60-second expiry
//   * a max Content-Length (5 MB world, 2 MB screenshot)
//   * write-once per key (IfNoneMatch for R2, wx flag for the filesystem)

import { FsWorldStorage } from './fsStorage.js';
import { getR2WorldStorage } from './r2Storage.js';

// Maximum size for the gzipped world payload accepted by /api/worlds/publish.
// The client compresses world JSON before upload, so 5 MB gzipped leaves
// room for worlds that expand to roughly 30–50 MB of plain JSON.
export const MAX_PUBLISH_BYTES = 5 * 1024 * 1024;
// Maximum size for a screenshot upload.
export const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;
// Upload URLs (both presigned R2 PUTs and filesystem direct-upload URLs)
// expire this many seconds after reservation. 60s is plenty of time for the
// client to PUT a few MB even on slow connections, and short enough that a
// leaked URL or a cancelled publish can't be replayed much later.
export const UPLOAD_EXPIRY_SECONDS = 60;

const ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
export function isValidWorldId(id: string): boolean {
  return ID_PATTERN.test(id);
}

export type WorldMetadata = {
  name: string;
  description: string;
  version: number;
  createdAt: number;
  // If this world was derived from (edited from) another published world,
  // parentId points at the source. Null for original creations. This lets
  // you trace the full ancestry / fork tree across all published worlds.
  parentId: string | null;
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

// Shape of a single upload target returned from `reserveUpload`. The client
// must PUT to `url` with the exact `headers` map for the upload to be
// accepted by the backend. For R2 the URL is a fully-qualified presigned
// URL; for the filesystem backend it's a relative path handled by the
// direct-upload endpoint.
export type UploadTarget = {
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
  contentLength: number;
};

export type UploadInstructions = {
  mode: 'presigned' | 'direct';
  world: UploadTarget;
  screenshot: UploadTarget;
};

export type ReserveUploadParams = {
  name: string;
  description: string;
  version: number;
  worldContentLength: number;
  screenshotContentLength: number;
  parentId: string | null;
};

export type Reservation = {
  id: string;
  createdAt: number;
  // Unix-ms timestamp at which the upload URLs expire.
  expiresAt: number;
  instructions: UploadInstructions;
};

export interface WorldStorage {
  readonly kind: StorageKind;

  /**
   * Reserves a fresh world id and returns upload instructions the client
   * uses to PUT the world and screenshot bodies directly. Implementations
   * MUST verify that nothing already exists at the reserved id and reject
   * attempts to overwrite it. Expiry and per-backend details are documented
   * at the top of this file.
   */
  reserveUpload(params: ReserveUploadParams): Promise<Reservation>;

  hasWorld(id: string): Promise<boolean>;

  getWorld(id: string): Promise<WorldContent | null>;

  listWorlds(limit: number): Promise<WorldSummary[]>;

  getScreenshot(id: string): Promise<ScreenshotContent | null>;
}

export class WriteConflictError extends Error {
  constructor(id: string) {
    super(`World with id ${id} already exists.`);
    this.name = 'WriteConflictError';
  }
}

export class AllocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AllocationError';
  }
}

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

// Optional public CDN base URL for reading published assets. When set, the
// client fetches world JSON and screenshots directly from the CDN instead of
// going through the serverless function. The URL should map 1:1 to the R2
// bucket key space — e.g. https://vibe-land-worlds.example.com corresponds
// to the bucket root, so published/<id>.world.json is reachable at
// https://vibe-land-worlds.example.com/published/<id>.world.json.
//
// Typical setup: Cloudflare R2 custom domain or a Cache Rule in front of the
// R2 public bucket URL.
export function getPublicBaseUrl(): string | null {
  const raw = process.env.R2_PUBLIC_URL?.trim();
  if (!raw) return null;
  // Strip trailing slash for consistent URL building.
  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
}
