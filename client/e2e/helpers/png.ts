/**
 * A minimal PNG decoder, so a spec can compare two screenshots by pixel.
 *
 * There is no `pngjs` in this tree and Playwright does not re-export the copy
 * it bundles, so the alternative to ~90 lines of zlib was either a new runtime
 * dependency or comparing the compressed bytes. Compressed bytes are the wrong
 * comparison: two frames that differ by one least-significant bit on a handful
 * of pixels -- which is all float noise in a shader can produce -- deflate to
 * completely different streams, so a byte compare cannot express "the same
 * image" at all.
 *
 * Scope is exactly what Chromium's screenshotter emits: 8 bits per channel,
 * non-interlaced, colour type 2 (RGB) or 6 (RGBA). Anything else throws rather
 * than being decoded approximately.
 */
import zlib from 'zlib';

export interface DecodedPng {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, row-major from the top. */
  data: Buffer;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

export function decodePng(buffer: Buffer): DecodedPng {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a PNG');

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Buffer[] = [];

  for (let offset = 8; offset + 8 <= buffer.length;) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8];
      colorType = body[9];
      if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${bitDepth}`);
      if (colorType !== 2 && colorType !== 6) {
        throw new Error(`unsupported PNG colour type ${colorType}`);
      }
      if (body[12] !== 0) throw new Error('interlaced PNG is not supported');
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length; // length + type + body + CRC
  }

  const channels = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  // Unfiltering is defined against the *reconstructed* previous row, so the
  // previous row has to be kept in filtered-out form rather than read back
  // from `out` (which has been widened to RGBA and would misalign at 3
  // channels).
  let previous = Buffer.alloc(stride);
  let current = Buffer.alloc(stride);

  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart];
    const line = raw.subarray(rowStart + 1, rowStart + 1 + stride);
    for (let x = 0; x < stride; x += 1) {
      const rawByte = line[x];
      const left = x >= channels ? current[x - channels] : 0;
      const up = previous[x];
      const upLeft = x >= channels ? previous[x - channels] : 0;
      let value: number;
      switch (filter) {
        case 0: value = rawByte; break;
        case 1: value = rawByte + left; break;
        case 2: value = rawByte + up; break;
        case 3: value = rawByte + ((left + up) >> 1); break;
        case 4: value = rawByte + paeth(left, up, upLeft); break;
        default: throw new Error(`unknown PNG filter ${filter} on row ${y}`);
      }
      current[x] = value & 0xff;
    }
    for (let x = 0; x < width; x += 1) {
      const src = x * channels;
      const dst = (y * width + x) * 4;
      out[dst] = current[src];
      out[dst + 1] = current[src + 1];
      out[dst + 2] = current[src + 2];
      out[dst + 3] = channels === 4 ? current[src + 3] : 255;
    }
    const swap = previous;
    previous = current;
    current = swap;
  }

  return { width, height, data: out };
}

export interface ImageDiff {
  /** Pixels whose worst channel differs by more than `tolerance`. */
  differing: number;
  totalPixels: number;
  fractionDiffering: number;
  /** Largest single-channel absolute difference anywhere in the image. */
  maxChannelDelta: number;
}

/**
 * Compare two same-size images with a per-channel tolerance.
 *
 * `tolerance` exists because the two frames being compared are not rendered
 * from bit-identical inputs -- the dome sits somewhere different in each, so
 * the sky triangles rasterize to different screen positions and the varying is
 * reconstructed from different vertices. That is allowed to move a channel by
 * a quantisation step; it is not allowed to move the sun.
 */
export function diffImages(a: DecodedPng, b: DecodedPng, tolerance = 2): ImageDiff {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`size mismatch: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  }
  const totalPixels = a.width * a.height;
  let differing = 0;
  let maxChannelDelta = 0;
  for (let i = 0; i < totalPixels; i += 1) {
    const o = i * 4;
    let worst = 0;
    for (let c = 0; c < 3; c += 1) {
      const delta = Math.abs(a.data[o + c] - b.data[o + c]);
      if (delta > worst) worst = delta;
    }
    if (worst > maxChannelDelta) maxChannelDelta = worst;
    if (worst > tolerance) differing += 1;
  }
  return {
    differing,
    totalPixels,
    fractionDiffering: differing / totalPixels,
    maxChannelDelta,
  };
}

/**
 * Luminance-weighted centroid of the brightest pixels, in image coordinates.
 *
 * This is the measurement that actually names the bug. A pixel diff says two
 * frames disagree; it does not say the sun moved, and a reader looking at a
 * failure needs to know which. The disc is `pow(s, 1400)` over a background
 * gradient, so thresholding near the maximum isolates it cleanly, and its
 * centroid is the sun's screen position to sub-pixel precision.
 *
 * Returns null when nothing in the crop is bright enough to be the disc --
 * which is itself the loudest possible symptom, because it means the sun has
 * left the frame entirely.
 */
export function brightCentroid(
  image: DecodedPng,
  thresholdFraction = 0.85,
): { x: number; y: number; weight: number } | null {
  let peak = 0;
  const luminance = new Float32Array(image.width * image.height);
  for (let i = 0; i < luminance.length; i += 1) {
    const o = i * 4;
    const l = 0.2126 * image.data[o] + 0.7152 * image.data[o + 1] + 0.0722 * image.data[o + 2];
    luminance[i] = l;
    if (l > peak) peak = l;
  }
  const cutoff = peak * thresholdFraction;
  let sumX = 0;
  let sumY = 0;
  let sumW = 0;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const l = luminance[y * image.width + x];
      if (l < cutoff) continue;
      sumX += x * l;
      sumY += y * l;
      sumW += l;
    }
  }
  if (sumW <= 0) return null;
  return { x: sumX / sumW, y: sumY / sumW, weight: sumW };
}
