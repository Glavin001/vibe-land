import { S3Client } from '@aws-sdk/client-s3';

export const PUBLISHED_PREFIX = 'published/';
// Maximum size for the gzipped world payload accepted by /api/worlds/publish.
// The client compresses world JSON before upload, so 5 MB gzipped leaves room
// for worlds that expand to roughly 30–50 MB of plain JSON.
export const MAX_PUBLISH_BYTES = 5 * 1024 * 1024; // 5 MB
// Maximum size for a screenshot upload. JPEGs rarely exceed a few hundred KB.
export const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024; // 2 MB

type R2Env = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
};

function readR2Env(): R2Env | null {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
    return null;
  }
  return { accountId, accessKeyId, secretAccessKey, bucket };
}

export function isR2Enabled(): boolean {
  return readR2Env() !== null;
}

let cachedClient: S3Client | null = null;
let cachedBucket: string | null = null;

export function getR2Client(): { client: S3Client; bucket: string } | null {
  const env = readR2Env();
  if (!env) {
    cachedClient = null;
    cachedBucket = null;
    return null;
  }
  if (!cachedClient || cachedBucket !== env.bucket) {
    cachedClient = new S3Client({
      region: 'auto',
      endpoint: `https://${env.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: env.accessKeyId,
        secretAccessKey: env.secretAccessKey,
      },
    });
    cachedBucket = env.bucket;
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
