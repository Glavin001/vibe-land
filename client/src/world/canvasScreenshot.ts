// Captures a downsized JPEG screenshot of an HTMLCanvasElement (typically the
// R3F canvas). The source canvas MUST be created with
// `preserveDrawingBuffer: true`, otherwise the pixel buffer will be cleared
// between the last render and the capture and toDataURL returns a blank frame.

const DEFAULT_MAX_WIDTH = 960;
const DEFAULT_MAX_HEIGHT = 540;
const DEFAULT_QUALITY = 0.85;

export type ScreenshotOptions = {
  maxWidth?: number;
  maxHeight?: number;
  quality?: number;
};

export type CapturedScreenshot = {
  blob: Blob;
  dataUrl: string;
  width: number;
  height: number;
};

export async function captureCanvasScreenshot(
  source: HTMLCanvasElement,
  options: ScreenshotOptions = {},
): Promise<CapturedScreenshot> {
  const maxWidth = options.maxWidth ?? DEFAULT_MAX_WIDTH;
  const maxHeight = options.maxHeight ?? DEFAULT_MAX_HEIGHT;
  const quality = options.quality ?? DEFAULT_QUALITY;

  const srcWidth = source.width;
  const srcHeight = source.height;
  if (srcWidth === 0 || srcHeight === 0) {
    throw new Error('Canvas has zero dimensions; nothing to capture.');
  }

  const aspect = srcWidth / srcHeight;
  let width = Math.min(srcWidth, maxWidth);
  let height = Math.round(width / aspect);
  if (height > maxHeight) {
    height = maxHeight;
    width = Math.round(height * aspect);
  }
  // Guarantee an even integer size; some encoders are picky.
  width = Math.max(2, Math.round(width));
  height = Math.max(2, Math.round(height));

  const dest = document.createElement('canvas');
  dest.width = width;
  dest.height = height;
  const ctx = dest.getContext('2d');
  if (!ctx) {
    throw new Error('Failed to get 2D context for screenshot resize.');
  }
  // Paint a background so transparency (if any) becomes opaque JPEG pixels.
  ctx.fillStyle = '#04070d';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(source, 0, 0, width, height);

  const blob = await new Promise<Blob | null>((resolve) => {
    dest.toBlob((result) => resolve(result), 'image/jpeg', quality);
  });
  if (!blob) {
    throw new Error('toBlob returned null; screenshot encode failed.');
  }
  const dataUrl = dest.toDataURL('image/jpeg', quality);
  return { blob, dataUrl, width, height };
}
