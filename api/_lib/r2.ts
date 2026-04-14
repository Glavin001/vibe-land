import { S3Client } from '@aws-sdk/client-s3';

export const PUBLISHED_PREFIX = 'published/';
// Maximum size for the gzipped world payload accepted by /api/worlds/publish.
// The client compresses world JSON before upload, so 5 MB gzipped leaves room
// for worlds that expand to roughly 30–50 MB of plain JSON.
export const MAX_PUBLISH_BYTES = 5 * 1024 * 1024; // 5 MB
// Maximum size for a screenshot upload. JPEGs rarely exceed a few hundred KB.
export const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024; // 2 MB

type R2Env = {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region: string;
  forcePathStyle: boolean;
};

// Reads the R2 (or any S3-compatible) config from process.env.
//
// Two modes are supported:
//  * Cloudflare R2: set R2_ACCOUNT_ID and the endpoint is derived as
//    https://<account>.r2.cloudflarestorage.com (virtual-host bucket style).
//  * Any S3-compatible server (MinIO, LocalStack, etc.): set R2_ENDPOINT
//    directly. Path-style addressing is enabled automatically so emulators
//    that don't do wildcard DNS (like localhost) keep working.
//
// Either way we also need R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and
// R2_BUCKET. If any of those are missing the feature stays disabled and the
// /api/worlds/config endpoint reports `{ enabled: false }`.
function readR2Env(): R2Env | null {
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET;
  if (!accessKeyId || !secretAccessKey || !bucket) {
    return null;
  }

  const explicitEndpoint = process.env.R2_ENDPOINT?.trim();
  const accountId = process.env.R2_ACCOUNT_ID?.trim();
  let endpoint: string;
  if (explicitEndpoint) {
    endpoint = explicitEndpoint;
  } else if (accountId) {
    endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
  } else {
    return null;
  }

  const region = process.env.R2_REGION?.trim() || 'auto';
  const rawForcePathStyle = process.env.R2_FORCE_PATH_STYLE?.trim().toLowerCase();
  // When targeting a custom endpoint (typically localhost or a private IP)
  // default to path-style addressing so we avoid wildcard-DNS assumptions.
  const forcePathStyle = rawForcePathStyle
    ? rawForcePathStyle === '1' || rawForcePathStyle === 'true' || rawForcePathStyle === 'yes'
    : Boolean(explicitEndpoint);

  return { endpoint, accessKeyId, secretAccessKey, bucket, region, forcePathStyle };
}

export function isR2Enabled(): boolean {
  return readR2Env() !== null;
}

let cachedClient: S3Client | null = null;
let cachedSignature: string | null = null;

export function getR2Client(): { client: S3Client; bucket: string } | null {
  const env = readR2Env();
  if (!env) {
    cachedClient = null;
    cachedSignature = null;
    return null;
  }
  const signature = `${env.endpoint}|${env.region}|${env.forcePathStyle}|${env.accessKeyId}|${env.bucket}`;
  if (!cachedClient || cachedSignature !== signature) {
    cachedClient = new S3Client({
      region: env.region,
      endpoint: env.endpoint,
      forcePathStyle: env.forcePathStyle,
      credentials: {
        accessKeyId: env.accessKeyId,
        secretAccessKey: env.secretAccessKey,
      },
    });
    cachedSignature = signature;
  }
  return { client: cachedClient, bucket: env.bucket };
}

export function buildPublishedKey(id: string): string {
  return `${PUBLISHED_PREFIX}${id}.world.json`;
}

export function buildScreenshotKey(id: string): string {
  return `${PUBLISHED_PREFIX}${id}.screenshot.jpg`;
}

export function extractIdFromKey(key: string): string | null {
  if (!key.startsWith(PUBLISHED_PREFIX)) {
    return null;
  }
  const rest = key.slice(PUBLISHED_PREFIX.length);
  const suffix = '.world.json';
  if (!rest.endsWith(suffix)) {
    return null;
  }
  return rest.slice(0, -suffix.length);
}

const ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
export function isValidWorldId(id: string): boolean {
  return ID_PATTERN.test(id);
}
