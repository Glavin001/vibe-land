// A 3D grid stored as a 2D atlas of z-slices.
//
// WebGL2 has no compute and no way to render every layer of a 3D texture in
// one draw, so the fluid's fields live in 2D textures with the slices tiled
// side by side: one fullscreen quad per pass updates the whole volume. The
// price is addressing -- a 3D sample is two bilinear taps on neighbouring
// slices, blended -- and this module is that addressing, in TypeScript for
// the CPU side (occupancy upload, tests) and as a GLSL preamble for the
// shaders, so the two can never disagree.

export interface AtlasLayout {
  nx: number;
  ny: number;
  nz: number;
  /** Slices per atlas row. */
  tilesX: number;
  tilesY: number;
  width: number;
  height: number;
}

export function atlasLayout(nx: number, ny: number, nz: number): AtlasLayout {
  // As square an atlas as the slice count allows.
  let tilesX = Math.ceil(Math.sqrt(nz));
  while (nz % tilesX !== 0) tilesX += 1;
  const tilesY = nz / tilesX;
  return { nx, ny, nz, tilesX, tilesY, width: nx * tilesX, height: ny * tilesY };
}

/** Atlas pixel of a cell. */
export function atlasPixel(layout: AtlasLayout, x: number, y: number, z: number): [number, number] {
  return [(z % layout.tilesX) * layout.nx + x, Math.floor(z / layout.tilesX) * layout.ny + y];
}

/** Cell of an atlas pixel. */
export function atlasCell(layout: AtlasLayout, px: number, py: number): [number, number, number] {
  const tx = Math.floor(px / layout.nx);
  const ty = Math.floor(py / layout.ny);
  return [px - tx * layout.nx, py - ty * layout.ny, ty * layout.tilesX + tx];
}

/** Linear index into a CPU-side atlas array, row-major by atlas pixel. */
export function atlasIndex(layout: AtlasLayout, x: number, y: number, z: number): number {
  const [px, py] = atlasPixel(layout, x, y, z);
  return py * layout.width + px;
}

/**
 * The GLSL the passes share. Cells are integer (x, y, z); `uvw` is continuous
 * in cell units with the cell centre at +0.5, matching a 3D texture's
 * convention so the raymarcher can think in [0, n).
 */
export function atlasGlsl(layout: AtlasLayout): string {
  return /* glsl */ `
const ivec3 GRID = ivec3(${layout.nx}, ${layout.ny}, ${layout.nz});
const vec3 GRIDF = vec3(${layout.nx}.0, ${layout.ny}.0, ${layout.nz}.0);
const int TILES_X = ${layout.tilesX};
const vec2 ATLAS = vec2(${layout.width}.0, ${layout.height}.0);

ivec3 cellOfFrag(vec2 frag) {
  ivec2 p = ivec2(frag);
  int tx = p.x / GRID.x;
  int ty = p.y / GRID.y;
  return ivec3(p.x - tx * GRID.x, p.y - ty * GRID.y, ty * TILES_X + tx);
}
ivec2 pixelOfCell(ivec3 c) {
  return ivec2((c.z % TILES_X) * GRID.x + c.x, (c.z / TILES_X) * GRID.y + c.y);
}
ivec3 clampCell(ivec3 c) { return clamp(c, ivec3(0), GRID - 1); }
vec4 cellFetch(sampler2D t, ivec3 c) { return texelFetch(t, pixelOfCell(clampCell(c)), 0); }
bool inGrid(ivec3 c) { return all(greaterThanEqual(c, ivec3(0))) && all(lessThan(c, GRID)); }

// Trilinear at a continuous cell coordinate: two bilinear taps on the
// slices either side, each clamped half a texel inside its tile so nothing
// bleeds from the neighbouring slice.
vec4 atlasSample(sampler2D t, vec3 uvw) {
  float z = clamp(uvw.z - 0.5, 0.0, GRIDF.z - 1.0);
  float z0 = floor(z);
  float f = z - z0;
  float z1 = min(z0 + 1.0, GRIDF.z - 1.0);
  vec2 xy = clamp(uvw.xy, vec2(0.5), GRIDF.xy - 0.5);
  vec2 o0 = vec2(mod(z0, float(TILES_X)) * GRIDF.x, floor(z0 / float(TILES_X)) * GRIDF.y);
  vec2 o1 = vec2(mod(z1, float(TILES_X)) * GRIDF.x, floor(z1 / float(TILES_X)) * GRIDF.y);
  vec4 s0 = texture(t, (o0 + xy) / ATLAS);
  vec4 s1 = texture(t, (o1 + xy) / ATLAS);
  return mix(s0, s1, f);
}
`;
}
