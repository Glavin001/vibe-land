// R2 / S3-compatible backend for the world-publishing feature. Wraps
// @aws-sdk/client-s3 behind the WorldStorage interface.

import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type {
  ScreenshotContent,
  WorldContent,
  WorldMetadata,
  WorldStorage,
  WorldSummary,
} from './storage.js';
import { WriteConflictError } from './storage.js';

const PUBLISHED_PREFIX = 'published/';
const WORLD_SUFFIX = '.world.json';
const SCREENSHOT_SUFFIX = '.screenshot.jpg';

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
// R2_BUCKET. If any of those are missing the feature stays disabled.
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
  const forcePathStyle = rawForcePathStyle
    ? rawForcePathStyle === '1' || rawForcePathStyle === 'true' || rawForcePathStyle === 'yes'
    : Boolean(explicitEndpoint);

  return { endpoint, accessKeyId, secretAccessKey, bucket, region, forcePathStyle };
}

let cachedClient: S3Client | null = null;
let cachedSignature: string | null = null;

function getR2Client(env: R2Env): S3Client {
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
  return cachedClient;
}

export function getR2WorldStorage(): R2WorldStorage | null {
  const env = readR2Env();
  if (!env) {
    cachedClient = null;
    cachedSignature = null;
    return null;
  }
  return new R2WorldStorage(getR2Client(env), env.bucket);
}

function worldKey(id: string): string {
  return `${PUBLISHED_PREFIX}${id}${WORLD_SUFFIX}`;
}

function screenshotKey(id: string): string {
  return `${PUBLISHED_PREFIX}${id}${SCREENSHOT_SUFFIX}`;
}

function extractIdFromKey(key: string): string | null {
  if (!key.startsWith(PUBLISHED_PREFIX)) return null;
  const rest = key.slice(PUBLISHED_PREFIX.length);
  if (!rest.endsWith(WORLD_SUFFIX)) return null;
  return rest.slice(0, -WORLD_SUFFIX.length);
}

// S3 metadata values must be ASCII. Base64-encode UTF-8 strings so unicode
// names and descriptions round-trip cleanly through `x-amz-meta-*` headers.
function encodeMetaValue(value: string): string {
  return Buffer.from(value, 'utf-8').toString('base64');
}

function decodeMetaValue(value: string): string {
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf-8');
    if (/\uFFFD/.test(decoded)) return value;
    return decoded;
  } catch {
    return value;
  }
}

function isNotFound(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  const statusCode = (err as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode;
  return name === 'NoSuchKey' || name === 'NotFound' || statusCode === 404;
}

export class R2WorldStorage implements WorldStorage {
  readonly kind = 'r2' as const;

  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async putWorld(id: string, gzippedBytes: Buffer, metadata: WorldMetadata): Promise<void> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: worldKey(id),
          Body: gzippedBytes,
          ContentType: 'application/json',
          ContentEncoding: 'gzip',
          // Belt-and-braces write-once guard so a concurrent PUT between our
          // HEAD probe and this call can't overwrite an existing world.
          IfNoneMatch: '*',
          Metadata: {
            name: encodeMetaValue(metadata.name),
            description: encodeMetaValue(metadata.description),
            createdat: metadata.createdAt.toString(),
            version: metadata.version.toString(),
          },
        }),
      );
    } catch (err) {
      const name = (err as { name?: string } | null)?.name;
      if (name === 'PreconditionFailed') {
        throw new WriteConflictError(id);
      }
      throw err;
    }
  }

  async hasWorld(id: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: worldKey(id) }),
      );
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  async getWorld(id: string): Promise<WorldContent | null> {
    let object;
    try {
      object = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: worldKey(id) }),
      );
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
    const body = object.Body;
    if (!body) {
      return null;
    }
    const bytes = Buffer.from(
      await (body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray(),
    );
    const encoding = (object.ContentEncoding ?? '').toLowerCase().includes('gzip')
      ? ('gzip' as const)
      : undefined;
    return { bytes, contentEncoding: encoding };
  }

  async listWorlds(limit: number): Promise<WorldSummary[]> {
    const listResponse = await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: PUBLISHED_PREFIX,
        MaxKeys: limit,
      }),
    );

    const items = (listResponse.Contents ?? [])
      .filter((item) => item.Key && typeof item.Size === 'number')
      .map((item) => ({
        id: extractIdFromKey(item.Key!),
        key: item.Key!,
        size: item.Size ?? 0,
        lastModified: item.LastModified?.getTime() ?? Date.now(),
      }))
      .filter((item): item is { id: string; key: string; size: number; lastModified: number } => item.id !== null);

    const summaries = await Promise.all(
      items.map(async (item) => {
        let name = 'Untitled World';
        let description = '';
        let createdAt = item.lastModified;
        let version = 0;
        try {
          const head = await this.client.send(
            new HeadObjectCommand({ Bucket: this.bucket, Key: item.key }),
          );
          const meta = head.Metadata ?? {};
          if (meta.name) name = decodeMetaValue(meta.name) || name;
          if (meta.description !== undefined) description = decodeMetaValue(meta.description);
          if (meta.createdat) {
            const parsed = Number.parseInt(meta.createdat, 10);
            if (Number.isFinite(parsed)) createdAt = parsed;
          }
          if (meta.version) {
            const parsed = Number.parseInt(meta.version, 10);
            if (Number.isFinite(parsed)) version = parsed;
          }
        } catch (err) {
          console.warn('[r2Storage] failed to HEAD object', item.key, err);
        }
        return {
          id: item.id,
          name,
          description,
          createdAt,
          version,
          size: item.size,
        } satisfies WorldSummary;
      }),
    );

    return summaries.sort((a, b) => b.createdAt - a.createdAt);
  }

  async putScreenshot(id: string, bytes: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: screenshotKey(id),
        Body: bytes,
        ContentType: contentType,
        CacheControl: 'public, max-age=86400, immutable',
      }),
    );
  }

  async getScreenshot(id: string): Promise<ScreenshotContent | null> {
    let object;
    try {
      object = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: screenshotKey(id) }),
      );
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
    const body = object.Body;
    if (!body) return null;
    const bytes = Buffer.from(
      await (body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray(),
    );
    return { bytes, contentType: object.ContentType ?? 'image/jpeg' };
  }
}
