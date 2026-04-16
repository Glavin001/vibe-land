import { tool } from 'ai';
import { z } from 'zod';
import { getTerrainTileCenter, getTerrainTile, sampleTerrainHeightAtWorldPosition } from '../world/worldDocument';
import type { WorldAccessors } from './worldToolHelpers';
import type { CaptureFunction, ResolvedCaptureConfig } from '../scene/SceneCaptureController';

const captureSchema = z.object({
  preset: z
    .enum(['birds_eye', 'isometric'])
    .optional()
    .describe(
      'Quick camera preset. "birds_eye" = orthographic top-down (pair with tileX/tileZ). "isometric" = classic 45° diagonal orthographic overview.',
    ),
  tileX: z
    .number()
    .int()
    .optional()
    .describe('Terrain tile grid X to center on. Used with tileZ to auto-target the tile center.'),
  tileZ: z
    .number()
    .int()
    .optional()
    .describe('Terrain tile grid Z to center on. Used with tileX to auto-target the tile center.'),
  target: z
    .object({ x: z.number(), y: z.number(), z: z.number() })
    .optional()
    .describe('World-space look-at point. Overridden by tileX/tileZ when both are provided.'),
  position: z
    .object({ x: z.number(), y: z.number(), z: z.number() })
    .optional()
    .describe(
      'Explicit camera world position. When provided, distance/elevationDeg/azimuthDeg are ignored.',
    ),
  distance: z
    .number()
    .positive()
    .optional()
    .describe('Spherical: distance from target in meters. Default varies by camera type and orthoWidth.'),
  elevationDeg: z
    .number()
    .min(0)
    .max(90)
    .optional()
    .describe('Spherical: 0 = horizontal look, 90 = straight down. Default 45.'),
  azimuthDeg: z
    .number()
    .min(0)
    .max(360)
    .optional()
    .describe('Spherical: compass bearing in degrees. 0 = +Z axis (south), 90 = +X axis (east). Default 135.'),
  type: z
    .enum(['perspective', 'orthographic'])
    .optional()
    .describe('Camera projection type. Default "orthographic" (no perspective distortion, good for measurements).'),
  fov: z
    .number()
    .min(10)
    .max(160)
    .optional()
    .describe('Perspective field-of-view in degrees. Default 55. Only used when type="perspective".'),
  orthoWidth: z
    .number()
    .positive()
    .optional()
    .describe(
      'Orthographic view width in world meters. Controls zoom level. Auto-fitted to tile when tileX/tileZ are set.',
    ),
  width: z
    .number()
    .int()
    .min(64)
    .max(2048)
    .optional()
    .describe('Output image width in pixels. Default 1024.'),
  height: z
    .number()
    .int()
    .min(64)
    .max(2048)
    .optional()
    .describe('Output image height in pixels. Default 768.'),
});

type CaptureInput = z.infer<typeof captureSchema>;

function sphericalToPosition(
  target: [number, number, number],
  distance: number,
  elevationDeg: number,
  azimuthDeg: number,
): [number, number, number] {
  const elevRad = (elevationDeg * Math.PI) / 180;
  const azimRad = (azimuthDeg * Math.PI) / 180;
  const horizontalRadius = distance * Math.cos(elevRad);
  const dx = horizontalRadius * Math.sin(azimRad);
  const dy = distance * Math.sin(elevRad);
  const dz = horizontalRadius * Math.cos(azimRad);
  return [target[0] + dx, target[1] + dy, target[2] + dz];
}

function resolveConfig(
  input: CaptureInput,
  target: [number, number, number],
  tileWidth: number | undefined,
): ResolvedCaptureConfig {
  const outputWidth = input.width ?? 1024;
  const outputHeight = input.height ?? 768;
  const cameraType = input.type ?? 'orthographic';
  const fov = input.fov ?? 55;

  // Orthographic width: prefer explicit, then auto-fit to tile, then default
  const autoOrthoWidth = tileWidth
    ? input.preset === 'birds_eye'
      ? tileWidth * 1.15
      : tileWidth * Math.SQRT2 * 1.15
    : 180;
  const orthoWidth = input.orthoWidth ?? autoOrthoWidth;

  // Preset overrides for elevation/azimuth
  const elevationDeg =
    input.elevationDeg ?? (input.preset === 'birds_eye' ? 90 : 45);
  const azimuthDeg =
    input.azimuthDeg ?? (input.preset === 'isometric' ? 45 : 135);

  // Distance: explicit, or default scaled to orthoWidth for ortho (enough altitude for far plane)
  const distance =
    input.distance ?? (cameraType === 'orthographic' ? orthoWidth * 1.5 : 120);

  // Camera position
  const position: [number, number, number] = input.position
    ? [input.position.x, input.position.y, input.position.z]
    : sphericalToPosition(target, distance, elevationDeg, azimuthDeg);

  return { position, target, type: cameraType, fov, orthoWidth, width: outputWidth, height: outputHeight };
}

export type ScreenshotToolResult = {
  ok: boolean;
  message: string;
  width?: number;
  height?: number;
  capturedImageDataUrl?: string; // stripped by useGodModeChat before storing in history
};

/**
 * Creates the capture_screenshot tool. Requires:
 * - getCapture: getter that returns the CaptureFunction from SceneCaptureController (via ref)
 * - accessors: WorldAccessors for tile resolution (getWorld())
 */
export function createCaptureScreenshotTool(
  getCapture: () => CaptureFunction | null | undefined,
  accessors: WorldAccessors,
) {
  return tool({
    description:
      'Take an offscreen screenshot of the 3D world from a configurable camera viewpoint. ' +
      'The captured PNG image is attached directly to the tool result so you can see it immediately and reason about it. ' +
      'Use preset="birds_eye" with tileX/tileZ for a top-down tile view. ' +
      'Use preset="isometric" for a 45° diagonal overview. ' +
      'Orthographic cameras (the default) show measurements without perspective distortion. ' +
      'Chain calls to visually verify edits: screenshot → inspect → edit → screenshot again.',
    inputSchema: captureSchema,
    async execute(input): Promise<ScreenshotToolResult> {
      const capture = getCapture();
      if (!capture) {
        return { ok: false, message: 'Screenshot capture is not available — the 3D scene may not be loaded yet.' };
      }

      // Validate tile exists before computing its center
      let target: [number, number, number] = input.target
        ? [input.target.x, input.target.y, input.target.z]
        : [0, 0, 0];
      let tileWidth: number | undefined;

      if (input.tileX !== undefined && input.tileZ !== undefined) {
        const world = accessors.getWorld();
        const tile = getTerrainTile(world, input.tileX, input.tileZ);
        if (!tile) {
          return {
            ok: false,
            message: `Tile (${input.tileX}, ${input.tileZ}) does not exist in the world. Use ctx.listTerrainTiles() to see available tiles.`,
          };
        }
        const [cx, cz] = getTerrainTileCenter(world, input.tileX, input.tileZ);
        const cy = sampleTerrainHeightAtWorldPosition(world, cx, cz);
        target = [cx, cy, cz];
        tileWidth = world.terrain.tileHalfExtentM * 2;
      }

      try {
        const resolved = resolveConfig(input, target, tileWidth);
        const capturedImageDataUrl = await capture(resolved);
        return {
          ok: true,
          message: `Screenshot captured: ${resolved.width}×${resolved.height}px, ${resolved.type} camera, orthoWidth=${resolved.orthoWidth.toFixed(1)}m.`,
          width: resolved.width,
          height: resolved.height,
          capturedImageDataUrl,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, message: `Capture failed: ${msg}` };
      }
    },
  });
}
