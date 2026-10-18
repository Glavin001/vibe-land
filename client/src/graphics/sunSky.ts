// Shared sun/sky description: one source of truth for the sun direction, the
// procedural sky gradient that feeds image-based lighting, and the shadow
// frustum math that keeps the sun's shadow map centred on the player.
//
// Before this module the scene had three independent, silently disagreeing
// suns: the drei <Sky> dome drew its disc at [120, 28, 40], the shadow-casting
// directional light sat at [48, 42, 18], and a fill light faked bounce from
// [-28, 20, -32]. Shading therefore never lined up with the sky the player was
// looking at. Everything here is pure math so it can be unit-tested without a
// WebGL context; the components in `SkyEnvironment.tsx` and `scene/SunLight.tsx`
// consume it.

export type Vec3 = { x: number; y: number; z: number };

/**
 * Default sun angles. Chosen to reproduce the previous shadow light's
 * direction ([48, 42, 18] normalised) so the change in look comes from the new
 * ambient/IBL terms rather than from the scene's key light swinging across the
 * sky.
 */
export const DEFAULT_SUN_ELEVATION_DEG = 39.3;
export const DEFAULT_SUN_AZIMUTH_DEG = 69.4;

/** How far along the sun direction the light and the sky disc are placed. */
export const SUN_DISTANCE_M = 120;

const DEG = Math.PI / 180;

/**
 * Unit vector pointing from the world origin toward the sun.
 *
 * Azimuth is measured the same way the weather wind direction is (0 = +Z,
 * 90 = +X) so a future "sun follows the storm" tie-in doesn't need a second
 * convention.
 */
export function sunDirection(
  elevationDeg = DEFAULT_SUN_ELEVATION_DEG,
  azimuthDeg = DEFAULT_SUN_AZIMUTH_DEG,
): Vec3 {
  const el = elevationDeg * DEG;
  const az = azimuthDeg * DEG;
  const cosEl = Math.cos(el);
  return { x: cosEl * Math.sin(az), y: Math.sin(el), z: cosEl * Math.cos(az) };
}

/** Sun direction scaled out to `SUN_DISTANCE_M`, as an R3F position triple. */
export function sunPosition(
  elevationDeg = DEFAULT_SUN_ELEVATION_DEG,
  azimuthDeg = DEFAULT_SUN_AZIMUTH_DEG,
  distance = SUN_DISTANCE_M,
): [number, number, number] {
  const d = sunDirection(elevationDeg, azimuthDeg);
  return [d.x * distance, d.y * distance, d.z * distance];
}

// ---------------------------------------------------------------------------
// Sky colours
// ---------------------------------------------------------------------------

export type SkyGradient = {
  /** Straight up. */
  zenith: string;
  /** At the horizon line — where the scene's fog also converges. */
  horizon: string;
  /** The hemisphere below the horizon: light bounced back off the ground. */
  ground: string;
  /** Colour of the direct sun, warmed as it drops toward the horizon. */
  sunColor: string;
};

type Rgb = { r: number; g: number; b: number };

function hexToRgb(hex: string): Rgb {
  const cleaned = hex.trim().replace('#', '');
  const full =
    cleaned.length === 3
      ? cleaned
          .split('')
          .map((c) => c + c)
          .join('')
      : cleaned;
  const n = Number.parseInt(full, 16);
  if (!Number.isFinite(n) || full.length !== 6) return { r: 1, g: 1, b: 1 };
  return { r: ((n >> 16) & 0xff) / 255, g: ((n >> 8) & 0xff) / 255, b: (n & 0xff) / 255 };
}

function rgbToHex({ r, g, b }: Rgb): string {
  const channel = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  const k = Math.min(1, Math.max(0, t));
  return { r: a.r + (b.r - a.r) * k, g: a.g + (b.g - a.g) * k, b: a.b + (b.b - a.b) * k };
}

function scaleRgb(c: Rgb, k: number): Rgb {
  return { r: c.r * k, g: c.g * k, b: c.b * k };
}

/** Clear-day reference gradient, before the weather tint is applied. */
const CLEAR_ZENITH = hexToRgb('#4a7fd0');
const CLEAR_HORIZON = hexToRgb('#c3d2e2');
const SUN_HIGH = hexToRgb('#fff4e2');
const SUN_LOW = hexToRgb('#ffb46b');

/**
 * Sky gradient for the current weather and sun height.
 *
 * The horizon is pulled most of the way to the scene's fog colour and the
 * zenith only part of the way: that is what makes a dust storm light the world
 * with brown skylight instead of the blue skylight of a clear day, while the
 * sky overhead still reads as sky. Because the same gradient is both drawn and
 * baked into the environment map, the ambient term can never drift away from
 * the visible sky again.
 */
export function skyGradient(fogColor: string, sunElevationDeg = DEFAULT_SUN_ELEVATION_DEG): SkyGradient {
  const fog = hexToRgb(fogColor);
  // 0 at the horizon, 1 for a high sun. Low sun = warmer, dimmer skylight.
  const height = Math.min(1, Math.max(0, sunElevationDeg / 60));
  const horizon = mixRgb(CLEAR_HORIZON, fog, 0.8);
  const zenith = mixRgb(mixRgb(CLEAR_ZENITH, fog, 0.35), horizon, (1 - height) * 0.45);
  // Ground bounce: the fog colour, darkened. Concrete and dirt return a small
  // fraction of what lands on them, and an over-bright lower hemisphere is what
  // makes IBL-lit scenes look like they are floating in a lightbox.
  const ground = scaleRgb(mixRgb(fog, { r: 0.35, g: 0.33, b: 0.3 }, 0.55), 0.75);
  return {
    zenith: rgbToHex(zenith),
    horizon: rgbToHex(horizon),
    ground: rgbToHex(ground),
    sunColor: rgbToHex(mixRgb(SUN_LOW, SUN_HIGH, height)),
  };
}

/**
 * Direct-sun intensity multiplier for the sun's height.
 *
 * A sun near the horizon travels through more atmosphere, so it delivers less
 * energy — and with the sky IBL now carrying the fill, the key light has to
 * carry the contrast rather than every surface being lit to the same value.
 */
export function sunIntensityFor(sunElevationDeg = DEFAULT_SUN_ELEVATION_DEG): number {
  const height = Math.min(1, Math.max(0, sunElevationDeg / 60));
  return 1.8 + 1.5 * height;
}

// ---------------------------------------------------------------------------
// Shadow frustum
// ---------------------------------------------------------------------------

/**
 * World size of one shadow-map texel for an orthographic shadow camera.
 * `halfExtent` is half the camera's width in metres.
 */
export function shadowTexelSize(halfExtent: number, mapSize: number): number {
  return (halfExtent * 2) / mapSize;
}

/**
 * Snap a world coordinate to a multiple of `step`.
 *
 * The shadow camera follows the player, and a shadow camera that slides
 * continuously re-rasterises every edge a fraction of a texel differently each
 * frame — which the eye reads as shadow edges crawling and boiling. Snapping
 * the camera to the shadow-map texel grid makes the rasterisation identical
 * frame to frame while the player walks.
 */
export function snapToStep(value: number, step: number): number {
  if (!(step > 0)) return value;
  return Math.round(value / step) * step;
}

/**
 * Where to centre the shadow camera for a player at `focus` looking along
 * `viewDirection`.
 *
 * Pushed ahead of the player, because they look forward: the shadows that
 * matter are the ones in front of them, not the half of the frustum spent
 * behind their back. Only the horizontal part of the view direction is used --
 * leaning the frustum up at the sky would waste it on empty air. The result is
 * still unsnapped; `scene/SunLight.tsx` quantises it on the shadow camera's own
 * axes, which is the only basis where snapping actually holds an edge still.
 */
export function shadowFocusPoint(focus: Vec3, viewDirection: Vec3, halfExtent: number): Vec3 {
  const len = Math.hypot(viewDirection.x, viewDirection.z);
  const lead = halfExtent * 0.35;
  const ox = len > 1e-4 ? (viewDirection.x / len) * lead : 0;
  const oz = len > 1e-4 ? (viewDirection.z / len) * lead : 0;
  return { x: focus.x + ox, y: focus.y, z: focus.z + oz };
}
