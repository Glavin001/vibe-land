"""Build VibeCity's city materials from the web client's texture sheets and the material catalog.

Run by scripts/unreal/import-city-materials.sh (a headless commandlet), which first cuts the web's
array sheets (client/public/textures/city) into per-layer PNGs in $VIBE_CITY_TEXTURES. Generated,
not committed: the inputs are (the sheets, shared/assets/materials/catalog.json, this script).

Creates under /Game/VibeCity:
  Textures/Layers/T_CityAlbedo_NN, T_CitySurface_NN   one per catalog layer, as imported
  Textures/T_CityAlbedoArray, T_CitySurfaceArray      Texture2DArrays, slice = catalog layer
  Materials/M_VibeCityChunk                           opaque PBR, samples both arrays
  Materials/M_VibeCityChunkFlat                       the same without the normal map
  Materials/M_VibeCityGlass                           translucent glass
  Materials/M_VibeCityDust                            dust puffs
  Materials/M_VibeCityDustVolume                      dust parcels (instanced spheres)
  Materials/M_VibeCityMeteor, ...MeteorTrail, ...Cannonball  meteor, its fire trail, cannonball
  Materials/M_VibeCityGrass                           meadow blades
  Materials/M_VibeCityWeather, ...WeatherAdditive     dust- and snow-storm particles
  Materials/M_VibeCityCanopy                          distant foliage canopy cards
  Materials/M_VibeCityBattery                         energy batteries (gold, glowing)
  Materials/M_VibeCityChunkHD                         2K Poly Haven sources (with --hd)
  Materials/M_VibeCityGroundHD                        the ground: grass and mud layers, dirt patches (with --hd)

M_VibeCityChunk reads what the client core puts on every chunk vertex:
  UV0 = texture coordinates in tiles of the face's material (core geometry.rs `tile_uvs`)
  UV1 = (catalog layer, metalness)
  vertex colour = an albedo multiplier (white on chunks; the web's canopy tint on the ground)
and decodes the surface sheet the way the web shader does (client/scripts/build-city-textures.py):
RG = tangent-space normal XY (OpenGL convention; Unreal's is DirectX, so green flips), B = roughness,
A = ambient occlusion. The albedo sheet's alpha is height, unused here.
"""

import json
import os

import unreal

ROOT = "/Game/VibeCity"
LAYERS = f"{ROOT}/Textures/Layers"
TEXTURES = f"{ROOT}/Textures"
MATERIALS = f"{ROOT}/Materials"

src = os.environ["VIBE_CITY_TEXTURES"]
catalog = json.load(open(os.environ["VIBE_MATERIAL_CATALOG"]))
layered = [m for m in catalog["materials"] if m.get("layer") is not None]
for index, m in enumerate(layered):
    assert m["layer"] == index, f"catalog layer order: {m['id']}"

tools = unreal.AssetToolsHelpers.get_asset_tools()
assets = unreal.EditorAssetLibrary
mel = unreal.MaterialEditingLibrary


def import_layers(kind: str, srgb: bool, directory: str = None, ext: str = "png", suffix: str = "", compression=None) -> list:
    tasks = []
    for m in layered:
        task = unreal.AssetImportTask()
        task.filename = os.path.join(directory or src, f"{kind}_{m['layer']:02d}.{ext}")
        task.destination_path = LAYERS
        task.destination_name = f"T_City{kind.capitalize()}{suffix}_{m['layer']:02d}"
        task.replace_existing = True
        task.automated = True
        task.save = False
        tasks.append(task)
    tools.import_asset_tasks(tasks)
    textures = []
    for task, m in zip(tasks, layered):
        texture = unreal.load_asset(f"{LAYERS}/{task.destination_name}")
        assert texture, f"import failed: {task.filename}"
        texture.set_editor_property("srgb", srgb)
        if compression is not None:
            texture.set_editor_property("compression_settings", compression)
        elif not srgb:
            texture.set_editor_property("compression_settings", unreal.TextureCompressionSettings.TC_VECTOR_DISPLACEMENTMAP)
        textures.append(texture)
    return textures


def texture_array(name: str, textures: list, srgb: bool, compression=None):
    path = f"{TEXTURES}/{name}"
    array = unreal.load_asset(path) if assets.does_asset_exist(path) else None
    if array is None:
        array = tools.create_asset(name, TEXTURES, unreal.Texture2DArray, unreal.Texture2DArrayFactory())
    array.set_editor_property("srgb", srgb)
    if compression is not None:
        array.set_editor_property("compression_settings", compression)
    elif not srgb:
        array.set_editor_property("compression_settings", unreal.TextureCompressionSettings.TC_VECTOR_DISPLACEMENTMAP)
    # Setting SourceTextures through the editor-property path runs PostEditChangeProperty, which
    # rebuilds the array's source from them (UTexture2DArray::UpdateSourceFromSourceTextures).
    array.set_editor_property("source_textures", textures)
    return array


def fresh_material(name: str):
    path = f"{MATERIALS}/{name}"
    # Recreate rather than clear: DeleteAllMaterialExpressions asserts (!IsRooted) on a material a
    # commandlet loaded.
    if assets.does_asset_exist(path):
        assets.delete_asset(path)
    return tools.create_asset(name, MATERIALS, unreal.Material, unreal.MaterialFactoryNew())


def expr(material, cls, x, y):
    return mel.create_material_expression(material, cls, x, y)


def mask(material, channels: str, x, y):
    """A ComponentMask passing exactly `channels` (the node's defaults pass R and G)."""
    e = expr(material, unreal.MaterialExpressionComponentMask, x, y)
    for c in "rgba":
        e.set_editor_property(c, c in channels)
    return e


def chunk_material(albedo_array, surface_array, name="M_VibeCityChunk", normal_map=True):
    m = fresh_material(name)
    uv0 = expr(m, unreal.MaterialExpressionTextureCoordinate, -1400, 0)
    uv1 = expr(m, unreal.MaterialExpressionTextureCoordinate, -1400, 200)
    uv1.set_editor_property("coordinate_index", 1)
    layer = mask(m, "r", -1200, 200)
    mel.connect_material_expressions(uv1, "", layer, "")
    metal = mask(m, "g", -1200, 320)
    mel.connect_material_expressions(uv1, "", metal, "")
    uvw = expr(m, unreal.MaterialExpressionAppendVector, -1000, 100)
    mel.connect_material_expressions(uv0, "", uvw, "A")
    mel.connect_material_expressions(layer, "", uvw, "B")

    albedo = expr(m, unreal.MaterialExpressionTextureSample, -800, -100)
    albedo.set_editor_property("texture", albedo_array)
    albedo.set_editor_property("sampler_type", unreal.MaterialSamplerType.SAMPLERTYPE_COLOR)
    mel.connect_material_expressions(uvw, "", albedo, "UVs")
    # × vertex colour: white on chunks; on the ground, the web's canopy tint (groundNodes.ts, core
    # grass.rs ground_tint) over the ochre grass photograph.
    tint = expr(m, unreal.MaterialExpressionVertexColor, -700, -350)
    tinted = expr(m, unreal.MaterialExpressionMultiply, -350, -250)
    mel.connect_material_expressions(albedo, "RGB", tinted, "A")
    mel.connect_material_expressions(tint, "", tinted, "B")
    mel.connect_material_property(tinted, "", unreal.MaterialProperty.MP_BASE_COLOR)

    surface = expr(m, unreal.MaterialExpressionTextureSample, -800, 200)
    surface.set_editor_property("texture", surface_array)
    surface.set_editor_property("sampler_type", unreal.MaterialSamplerType.SAMPLERTYPE_LINEAR_COLOR)
    mel.connect_material_expressions(uvw, "", surface, "UVs")
    mel.connect_material_property(surface, "B", unreal.MaterialProperty.MP_ROUGHNESS)
    mel.connect_material_property(surface, "A", unreal.MaterialProperty.MP_AMBIENT_OCCLUSION)
    mel.connect_material_expressions(metal, "", m_metal := expr(m, unreal.MaterialExpressionSaturate, -600, 420), "")
    mel.connect_material_property(m_metal, "", unreal.MaterialProperty.MP_METALLIC)

    # Normal: xy = (r, g) * 2 - 1 with green flipped (OpenGL -> DirectX), z = sqrt(1 - x^2 - y^2).
    rg = mask(m, "rg", -600, 200)
    mel.connect_material_expressions(surface, "RGB", rg, "")
    scale = expr(m, unreal.MaterialExpressionMultiply, -450, 200)
    two_neg = expr(m, unreal.MaterialExpressionConstant2Vector, -600, 300)
    two_neg.set_editor_property("r", 2.0)
    two_neg.set_editor_property("g", -2.0)
    mel.connect_material_expressions(rg, "", scale, "A")
    mel.connect_material_expressions(two_neg, "", scale, "B")
    bias = expr(m, unreal.MaterialExpressionAdd, -300, 200)
    offset = expr(m, unreal.MaterialExpressionConstant2Vector, -450, 300)
    offset.set_editor_property("r", -1.0)
    offset.set_editor_property("g", 1.0)
    mel.connect_material_expressions(scale, "", bias, "A")
    mel.connect_material_expressions(offset, "", bias, "B")
    derive_z = expr(m, unreal.MaterialExpressionDeriveNormalZ, -150, 200)
    mel.connect_material_expressions(bias, "", derive_z, "")
    if normal_map:
        mel.connect_material_property(derive_z, "", unreal.MaterialProperty.MP_NORMAL)

    m.set_editor_property("two_sided", False)
    mel.recompile_material(m)
    return m


def weathering(m, albedo, roughness, x, y):
    """Weathering on a chunk surface, keyed to the surface itself so it stays on a chunk that breaks
    away: its height in the intact city and interior flag (UV2, metres) and its texture coordinates
    (UV0, box-projected tiles, continuous across a wall's chunks); faces the break exposed
    (interior) are fresh and get none. The art-standard layers of a grime pass:
      - large-scale colour variation (smooth noise over a few tiles, x0.9..1.1), breaking up tiling;
      - a splash and rising-damp band up to ~1.2 m above the ground, darker and rougher, its top edge
        broken by noise;
      - rain streaks on walls: noise stretched 16x vertically, darkening where it is high.
    Returns (albedo, roughness) nodes."""
    def mul(a, b, dx, dy):
        e = expr(m, unreal.MaterialExpressionMultiply, x + dx, y + dy)
        mel.connect_material_expressions(a, "", e, "A")
        mel.connect_material_expressions(b, "", e, "B")
        return e

    def add(a, b, dx, dy):
        e = expr(m, unreal.MaterialExpressionAdd, x + dx, y + dy)
        mel.connect_material_expressions(a, "", e, "A")
        mel.connect_material_expressions(b, "", e, "B")
        return e

    def const(v, dx, dy):
        e = expr(m, unreal.MaterialExpressionConstant, x + dx, y + dy)
        e.set_editor_property("r", v)
        return e

    def lerp(a, b, t, dx, dy):
        e = expr(m, unreal.MaterialExpressionLinearInterpolate, x + dx, y + dy)
        mel.connect_material_expressions(a, "", e, "A")
        mel.connect_material_expressions(b, "", e, "B")
        mel.connect_material_expressions(t, "", e, "Alpha")
        return e

    def noise(position, scale, levels, dx, dy):
        n = expr(m, unreal.MaterialExpressionNoise, x + dx, y + dy)
        n.set_editor_property("scale", scale)
        n.set_editor_property("levels", levels)
        n.set_editor_property("turbulence", False)
        n.set_editor_property("output_min", 0.0)
        n.set_editor_property("output_max", 1.0)
        mel.connect_material_expressions(position, "", n, "Position")
        return n

    uv0 = expr(m, unreal.MaterialExpressionTextureCoordinate, x - 1400, y)
    uv2 = expr(m, unreal.MaterialExpressionTextureCoordinate, x - 1400, y + 120)
    uv2.set_editor_property("coordinate_index", 2)
    height = mask(m, "r", x - 1250, y + 120)
    mel.connect_material_expressions(uv2, "", height, "")
    interior = mask(m, "g", x - 1250, y + 220)
    mel.connect_material_expressions(uv2, "", interior, "")
    # (u, v, 0) in tiles: v runs down a wall.
    rest = expr(m, unreal.MaterialExpressionAppendVector, x - 1100, y + 40)
    mel.connect_material_expressions(uv0, "", rest, "A")
    mel.connect_material_expressions(const(0.0, -1250, 60), "", rest, "B")

    # Colour variation: x (0.9 + 0.2 n).
    macro = noise(rest, 0.3, 3, -900, -200)
    vary = add(mul(macro, const(0.2, -800, -120), -700, -180), const(0.9, -700, -100), -600, -180)

    # Splash band: (1 - smoothstep(0, 1.2 m, z + 0.6 (n - 0.5))) x 0.35 darker.
    edge = noise(rest, 1.5, 2, -900, 100)
    ragged = add(height, mul(add(edge, const(-0.5, -800, 200), -700, 160), const(0.6, -700, 240), -600, 180), -500, 140)
    band_step = expr(m, unreal.MaterialExpressionSmoothStep, x - 400, y + 140)
    band_step.set_editor_property("const_min", 0.0)
    band_step.set_editor_property("const_max", 1.2)
    mel.connect_material_expressions(ragged, "", band_step, "Value")
    band = expr(m, unreal.MaterialExpressionOneMinus, x - 300, y + 140)
    mel.connect_material_expressions(band_step, "", band, "")

    # Streaks: v (down the wall) squashed 16x, so features run 16x taller than wide.
    squash = expr(m, unreal.MaterialExpressionConstant3Vector, x - 1100, y + 320)
    squash.set_editor_property("constant", unreal.LinearColor(1.0, 1.0 / 16.0, 1.0, 0.0))
    streak_n = noise(mul(rest, squash, -950, 320), 3.0, 2, -800, 320)
    streak = expr(m, unreal.MaterialExpressionSaturate, x - 500, y + 320)
    mel.connect_material_expressions(mul(add(streak_n, const(-0.6, -700, 400), -600, 340), const(3.0, -600, 420), -550, 360), "", streak, "")
    normal = expr(m, unreal.MaterialExpressionVertexNormalWS, x - 700, y + 480)
    nz = mask(m, "b", x - 600, y + 480)
    mel.connect_material_expressions(normal, "", nz, "")
    abs_nz = expr(m, unreal.MaterialExpressionAbs, x - 520, y + 480)
    mel.connect_material_expressions(nz, "", abs_nz, "")
    wall = expr(m, unreal.MaterialExpressionOneMinus, x - 440, y + 480)
    mel.connect_material_expressions(abs_nz, "", wall, "")
    streaks = mul(streak, wall, -380, 400)

    # Grime amount (none on interior faces): band 0.35 + streaks 0.18 of darkening.
    outside = expr(m, unreal.MaterialExpressionOneMinus, x - 1100, y + 220)
    mel.connect_material_expressions(interior, "", outside, "")
    dark = mul(add(mul(band, const(0.35, -250, 200), -200, 160), mul(streaks, const(0.18, -250, 420), -200, 380), -120, 240), outside, -40, 240)
    shade = expr(m, unreal.MaterialExpressionOneMinus, x + 40, y + 240)
    mel.connect_material_expressions(dark, "", shade, "")
    variation = lerp(const(1.0, -300, -260), vary, outside, -200, -200)
    out_albedo = mul(mul(albedo, variation, 0, -100), shade, 120, 0)
    out_rough = lerp(roughness, const(1.0, 0, 380), mul(band, mul(const(0.5, -100, 460), outside, 0, 440), 60, 420), 160, 360)
    return out_albedo, out_rough


def hd_chunk_material(albedo_array, normal_array, arm_array):
    """The chunk material on 2K Poly Haven sources: albedo, a DirectX normal map, and AO/roughness/
    metalness from the ARM map. UV0 must already be in tiles of the hd source (the renderer scales
    the core's tile UVs by metres_per_tile / hd_metres_per_tile)."""
    m = fresh_material("M_VibeCityChunkHD")
    uv0 = expr(m, unreal.MaterialExpressionTextureCoordinate, -1400, 0)
    uv1 = expr(m, unreal.MaterialExpressionTextureCoordinate, -1400, 200)
    uv1.set_editor_property("coordinate_index", 1)
    layer = mask(m, "r", -1200, 200)
    mel.connect_material_expressions(uv1, "", layer, "")
    uvw = expr(m, unreal.MaterialExpressionAppendVector, -1000, 100)
    mel.connect_material_expressions(uv0, "", uvw, "A")
    mel.connect_material_expressions(layer, "", uvw, "B")

    albedo = expr(m, unreal.MaterialExpressionTextureSample, -700, -200)
    albedo.set_editor_property("texture", albedo_array)
    albedo.set_editor_property("sampler_type", unreal.MaterialSamplerType.SAMPLERTYPE_COLOR)
    mel.connect_material_expressions(uvw, "", albedo, "UVs")
    # × vertex colour: white on chunks; on the ground, the web's canopy tint (groundNodes.ts, core
    # grass.rs ground_tint) over the ochre grass photograph.
    tint = expr(m, unreal.MaterialExpressionVertexColor, -700, -350)
    tinted = expr(m, unreal.MaterialExpressionMultiply, -350, -250)
    mel.connect_material_expressions(albedo, "RGB", tinted, "A")
    mel.connect_material_expressions(tint, "", tinted, "B")

    normal = expr(m, unreal.MaterialExpressionTextureSample, -700, 50)
    normal.set_editor_property("texture", normal_array)
    normal.set_editor_property("sampler_type", unreal.MaterialSamplerType.SAMPLERTYPE_NORMAL)
    mel.connect_material_expressions(uvw, "", normal, "UVs")
    mel.connect_material_property(normal, "RGB", unreal.MaterialProperty.MP_NORMAL)

    arm = expr(m, unreal.MaterialExpressionTextureSample, -700, 300)
    arm.set_editor_property("texture", arm_array)
    arm.set_editor_property("sampler_type", unreal.MaterialSamplerType.SAMPLERTYPE_MASKS)
    mel.connect_material_expressions(uvw, "", arm, "UVs")
    mel.connect_material_property(arm, "R", unreal.MaterialProperty.MP_AMBIENT_OCCLUSION)
    mel.connect_material_property(arm, "B", unreal.MaterialProperty.MP_METALLIC)
    rough = mask(m, "g", -500, 300)
    mel.connect_material_expressions(arm, "RGB", rough, "")
    weathered, weathered_rough = weathering(m, tinted, rough, 0, 700)
    mel.connect_material_property(weathered, "", unreal.MaterialProperty.MP_BASE_COLOR)
    mel.connect_material_property(weathered_rough, "", unreal.MaterialProperty.MP_ROUGHNESS)
    mel.recompile_material(m)
    return m


# groundNodes.ts (hero) and cityHeroNodes.ts macroField, per pixel: the macro noise (client-core
# ground.rs, a texture the renderer creates) read in three rotated bands; dirt where it is high,
# or where the meadow is thin (vertex colour A); and the field's own albedo variation.
GROUND_FIELD = """
float2 m0 = P / Size;
float a = Texture2DSample(Noise, NoiseSampler, m0).r;
float2 m1 = P / (Size * 0.37);
float c1 = cos(0.71), s1 = sin(0.71);
float b = Texture2DSample(Noise, NoiseSampler, float2(m1.x * c1 - m1.y * s1, m1.x * s1 + m1.y * c1) + float2(0.17, 0.61)).r;
float2 m2 = P / (Size * 0.145);
float c2 = cos(-0.43), s2 = sin(-0.43);
float c = Texture2DSample(Noise, NoiseSampler, float2(m2.x * c2 - m2.y * s2, m2.x * s2 + m2.y * c2) + float2(0.73, 0.29)).r;
return (a + b * Mid + c * Small) / max(Mid + Small + 1.0, 1e-4);
"""


def hd_ground_material(albedo_array, normal_array, arm_array):
    """The ground (client/src/scene/groundNodes.ts on 2K sources): the grass and mud layers
    (LayerA/LayerB, tiled at MetresA/MetresB by world position), blended by dirt = the web's macro
    field patches (DirtStart..DirtEnd at 0.31 x position) or the meadow's thin cover (vertex colour
    A); grass tinted by the canopy colour (vertex colour RGB); the field's albedo and warmth
    variation (MacroAlbedo, MacroTemp). Texture parameter MacroNoise: client-core's macro noise."""
    m = fresh_material("M_VibeCityGroundHD")

    def scalar(n, v, x, y):
        s = expr(m, unreal.MaterialExpressionScalarParameter, x, y)
        s.set_editor_property("parameter_name", n)
        s.set_editor_property("default_value", v)
        return s
    world = expr(m, unreal.MaterialExpressionWorldPosition, -2400, 0)
    # Server metres on the ground: x = -Y / 100, z = X / 100.
    xy = mask(m, "rg", -2250, 0)
    mel.connect_material_expressions(world, "", xy, "")
    swizzle = expr(m, unreal.MaterialExpressionMultiply, -2100, 0)
    to_server = expr(m, unreal.MaterialExpressionConstant2Vector, -2250, 100)
    to_server.set_editor_property("r", -0.01)
    to_server.set_editor_property("g", 0.01)
    # (X, Y) * (-0.01, 0.01) = (-X/100, Y/100); swap to (x, z) = (-Y/100, X/100) with a mask pair.
    mel.connect_material_expressions(xy, "", swizzle, "A")
    mel.connect_material_expressions(to_server, "", swizzle, "B")
    gx = mask(m, "g", -1950, -50)
    gz = mask(m, "r", -1950, 50)
    mel.connect_material_expressions(swizzle, "", gx, "")
    mel.connect_material_expressions(swizzle, "", gz, "")
    neg = expr(m, unreal.MaterialExpressionMultiply, -1800, -50)
    neg.set_editor_property("const_b", -1.0)
    mel.connect_material_expressions(gx, "", neg, "A")
    negz = expr(m, unreal.MaterialExpressionMultiply, -1800, 50)
    negz.set_editor_property("const_b", -1.0)
    mel.connect_material_expressions(gz, "", negz, "A")
    pos = expr(m, unreal.MaterialExpressionAppendVector, -1650, 0)
    mel.connect_material_expressions(neg, "", pos, "A")   # x = -Y/100 (gx = Y/100)
    mel.connect_material_expressions(negz, "", pos, "B")  # z = X/100 (gz = -X/100)

    def layer_uvw(metres_name, metres_default, layer_name, layer_default, y):
        metres = scalar(metres_name, metres_default, -1650, y)
        uv = expr(m, unreal.MaterialExpressionDivide, -1450, y)
        mel.connect_material_expressions(pos, "", uv, "A")
        mel.connect_material_expressions(metres, "", uv, "B")
        layer = scalar(layer_name, layer_default, -1450, y + 80)
        uvw = expr(m, unreal.MaterialExpressionAppendVector, -1250, y)
        mel.connect_material_expressions(uv, "", uvw, "A")
        mel.connect_material_expressions(layer, "", uvw, "B")
        return uvw
    uvw_a = layer_uvw("MetresA", 4.0, "LayerA", 10.0, -400)
    uvw_b = layer_uvw("MetresB", 2.6, "LayerB", 11.0, -200)

    def sample(array, kind, uvw, x, y):
        s = expr(m, unreal.MaterialExpressionTextureSample, x, y)
        s.set_editor_property("texture", array)
        s.set_editor_property("sampler_type", kind)
        mel.connect_material_expressions(uvw, "", s, "UVs")
        return s
    color = unreal.MaterialSamplerType.SAMPLERTYPE_COLOR
    normal = unreal.MaterialSamplerType.SAMPLERTYPE_NORMAL
    masks = unreal.MaterialSamplerType.SAMPLERTYPE_MASKS
    alb_a, alb_b = sample(albedo_array, color, uvw_a, -1000, -700), sample(albedo_array, color, uvw_b, -1000, -500)
    nrm_a, nrm_b = sample(normal_array, normal, uvw_a, -1000, -300), sample(normal_array, normal, uvw_b, -1000, -100)
    arm_a, arm_b = sample(arm_array, masks, uvw_a, -1000, 100), sample(arm_array, masks, uvw_b, -1000, 300)

    noise = expr(m, unreal.MaterialExpressionTextureObjectParameter, -1650, 500)
    noise.set_editor_property("parameter_name", "MacroNoise")
    noise.set_editor_property("texture", unreal.load_asset("/Engine/EngineResources/DefaultTexture.DefaultTexture"))
    size = scalar("MacroSize", 9.0, -1650, 650)
    mid = scalar("MacroMid", 0.42, -1650, 720)
    small = scalar("MacroSmall", 0.2, -1650, 790)

    def field(p, y):
        f = custom(m, GROUND_FIELD, ["P", "Size", "Mid", "Small", "Noise"], unreal.CustomMaterialOutputType.CMOT_FLOAT1, -1200, y)
        for src, pin in [(p, "P"), (size, "Size"), (mid, "Mid"), (small, "Small"), (noise, "Noise")]:
            mel.connect_material_expressions(src, "", f, pin)
        return f
    scaled = expr(m, unreal.MaterialExpressionMultiply, -1450, 550)
    scaled.set_editor_property("const_b", 0.31)
    mel.connect_material_expressions(pos, "", scaled, "A")
    patch = field(scaled, 550)
    macro = field(pos, 750)

    start = scalar("DirtStart", 0.56, -1000, 500)
    end = scalar("DirtEnd", 0.72, -1000, 570)
    smooth = expr(m, unreal.MaterialExpressionSmoothStep, -850, 520)
    mel.connect_material_expressions(start, "", smooth, "Min")
    mel.connect_material_expressions(end, "", smooth, "Max")
    mel.connect_material_expressions(patch, "", smooth, "Value")
    vc = expr(m, unreal.MaterialExpressionVertexColor, -1000, 650)
    dirt = expr(m, unreal.MaterialExpressionMax, -700, 560)
    mel.connect_material_expressions(smooth, "", dirt, "A")
    mel.connect_material_expressions(vc, "A", dirt, "B")

    def lerp(a, a_pin, b, b_pin, x, y):
        e = expr(m, unreal.MaterialExpressionLinearInterpolate, x, y)
        mel.connect_material_expressions(a, a_pin, e, "A")
        mel.connect_material_expressions(b, b_pin, e, "B")
        mel.connect_material_expressions(dirt, "", e, "Alpha")
        return e
    albedo = lerp(alb_a, "RGB", alb_b, "RGB", -550, -600)
    # Canopy tint, fading to none where the ground is dirt: mix(canopy, 1, dirt).
    one = expr(m, unreal.MaterialExpressionConstant3Vector, -700, -800)
    one.set_editor_property("constant", unreal.LinearColor(1, 1, 1, 1))
    tint = lerp(vc, "", one, "", -550, -800)
    tinted = expr(m, unreal.MaterialExpressionMultiply, -400, -700)
    mel.connect_material_expressions(albedo, "", tinted, "A")
    mel.connect_material_expressions(tint, "", tinted, "B")
    # The field's variation: exp2((2·macro − 1)·MacroAlbedo) × mix(cool, warm, macro).
    signed = expr(m, unreal.MaterialExpressionMultiply, -1000, 850)
    signed.set_editor_property("const_b", 2.0)
    mel.connect_material_expressions(macro, "", signed, "A")
    signed1 = expr(m, unreal.MaterialExpressionSubtract, -880, 850)
    signed1.set_editor_property("const_b", 1.0)
    mel.connect_material_expressions(signed, "", signed1, "A")
    amount = scalar("MacroAlbedo", 0.16, -880, 950)
    power = expr(m, unreal.MaterialExpressionMultiply, -750, 880)
    mel.connect_material_expressions(signed1, "", power, "A")
    mel.connect_material_expressions(amount, "", power, "B")
    gain = custom(m, "return exp2(X);", ["X"], unreal.CustomMaterialOutputType.CMOT_FLOAT1, -620, 880)
    mel.connect_material_expressions(power, "", gain, "X")
    temp = scalar("MacroTemp", 0.03, -880, 1050)
    warmth = custom(m, "return lerp(float3(1.0 - T * 0.65, 1.0, T + 1.0), float3(T + 1.0, 1.0, 1.0 - T * 0.72), M);",
                    ["T", "M"], unreal.CustomMaterialOutputType.CMOT_FLOAT3, -620, 1000)
    mel.connect_material_expressions(temp, "", warmth, "T")
    mel.connect_material_expressions(macro, "", warmth, "M")
    varied = expr(m, unreal.MaterialExpressionMultiply, -450, 900)
    mel.connect_material_expressions(gain, "", varied, "A")
    mel.connect_material_expressions(warmth, "", varied, "B")
    # cityTone 0.88 (cityMaterialShader.ts) scales the photograph.
    tone = expr(m, unreal.MaterialExpressionMultiply, -300, -500)
    tone.set_editor_property("const_b", 0.88)
    mel.connect_material_expressions(tinted, "", tone, "A")
    base = expr(m, unreal.MaterialExpressionMultiply, -150, -400)
    mel.connect_material_expressions(tone, "", base, "A")
    mel.connect_material_expressions(varied, "", base, "B")
    mel.connect_material_property(base, "", unreal.MaterialProperty.MP_BASE_COLOR)
    mel.connect_material_property(lerp(nrm_a, "RGB", nrm_b, "RGB", -550, -200), "", unreal.MaterialProperty.MP_NORMAL)
    arm = lerp(arm_a, "RGB", arm_b, "RGB", -550, 150)
    for ch, prop in (("r", unreal.MaterialProperty.MP_AMBIENT_OCCLUSION), ("g", unreal.MaterialProperty.MP_ROUGHNESS)):
        c = mask(m, ch, -350, 150 if ch == "r" else 250)
        mel.connect_material_expressions(arm, "", c, "")
        mel.connect_material_property(c, "", prop)
    mel.recompile_material(m)
    return m


def projectile_materials():
    """The meteor, its fire trail, and the cannonball.

    M_VibeCityMeteor: basalt (near-black, mottled) with glowing ridged cracks (1 - |noise|, sharpened)
    and a hot rim toward the silhouette; scalar Glow scales the emission.
    M_VibeCityMeteorTrail: additive and unlit, for a sphere stretched behind the meteor: emission
    peaks where the view meets the surface head-on, fades from Head (vector, world) out to Length
    (scalar, cm), and flickers with drifting noise; vector Color.
    M_VibeCityCannonball: forged iron, dark and metallic, its roughness mottled."""
    def mul(m, a, b, x, y):
        e = expr(m, unreal.MaterialExpressionMultiply, x, y)
        mel.connect_material_expressions(a, "", e, "A")
        mel.connect_material_expressions(b, "", e, "B")
        return e

    def add(m, a, b, x, y):
        e = expr(m, unreal.MaterialExpressionAdd, x, y)
        mel.connect_material_expressions(a, "", e, "A")
        mel.connect_material_expressions(b, "", e, "B")
        return e

    def const(m, v, x, y):
        e = expr(m, unreal.MaterialExpressionConstant, x, y)
        e.set_editor_property("r", v)
        return e

    def noise(m, position, scale, levels, x, y, lo=0.0, hi=1.0):
        n = expr(m, unreal.MaterialExpressionNoise, x, y)
        n.set_editor_property("scale", scale)
        n.set_editor_property("levels", levels)
        n.set_editor_property("output_min", lo)
        n.set_editor_property("output_max", hi)
        if position is not None:
            mel.connect_material_expressions(position, "", n, "Position")
        return n

    def facing(m, x, y):
        normal = expr(m, unreal.MaterialExpressionVertexNormalWS, x - 300, y)
        view = expr(m, unreal.MaterialExpressionCameraVectorWS, x - 300, y + 100)
        dot = expr(m, unreal.MaterialExpressionDotProduct, x - 150, y + 40)
        mel.connect_material_expressions(normal, "", dot, "A")
        mel.connect_material_expressions(view, "", dot, "B")
        sat = expr(m, unreal.MaterialExpressionSaturate, x, y + 40)
        mel.connect_material_expressions(dot, "", sat, "")
        return sat

    # Meteor.
    m = fresh_material("M_VibeCityMeteor")
    world = expr(m, unreal.MaterialExpressionWorldPosition, -1400, 0)
    mottle = noise(m, world, 0.03, 3, -1200, -200)
    stone = expr(m, unreal.MaterialExpressionConstant3Vector, -1200, -350)
    stone.set_editor_property("constant", unreal.LinearColor(0.045, 0.04, 0.038, 0.0))
    basalt = mul(m, stone, add(m, mul(m, mottle, const(m, 0.6, -1050, -150), -950, -200), const(m, 0.4, -950, -100), -850, -200), -700, -300)
    mel.connect_material_property(basalt, "", unreal.MaterialProperty.MP_BASE_COLOR)
    cracks_raw = noise(m, world, 0.05, 4, -1200, 100, -1.0, 1.0)
    absn = expr(m, unreal.MaterialExpressionAbs, -1050, 100)
    mel.connect_material_expressions(cracks_raw, "", absn, "")
    ridge = expr(m, unreal.MaterialExpressionOneMinus, -950, 100)
    mel.connect_material_expressions(absn, "", ridge, "")
    sharp = expr(m, unreal.MaterialExpressionPower, -850, 100)
    sharp.set_editor_property("const_exponent", 12.0)
    mel.connect_material_expressions(ridge, "", sharp, "Base")
    rim = expr(m, unreal.MaterialExpressionOneMinus, -850, 300)
    mel.connect_material_expressions(facing(m, -950, 260), "", rim, "")
    rim3 = expr(m, unreal.MaterialExpressionPower, -750, 300)
    rim3.set_editor_property("const_exponent", 3.0)
    mel.connect_material_expressions(rim, "", rim3, "Base")
    heat = add(m, mul(m, sharp, const(m, 30.0, -750, 160), -650, 120), mul(m, rim3, const(m, 6.0, -650, 360), -550, 320), -450, 200)
    ember = expr(m, unreal.MaterialExpressionConstant3Vector, -450, 0)
    ember.set_editor_property("constant", unreal.LinearColor(1.0, 0.32, 0.06, 0.0))
    glow = expr(m, unreal.MaterialExpressionScalarParameter, -450, 400)
    glow.set_editor_property("parameter_name", "Glow")
    glow.set_editor_property("default_value", 1.0)
    emissive = mul(m, mul(m, ember, heat, -300, 100), glow, -150, 150)
    mel.connect_material_property(emissive, "", unreal.MaterialProperty.MP_EMISSIVE_COLOR)
    mel.connect_material_property(const(m, 0.9, -150, 300), "", unreal.MaterialProperty.MP_ROUGHNESS)
    mel.recompile_material(m)

    # Trail.
    t = fresh_material("M_VibeCityMeteorTrail")
    t.set_editor_property("blend_mode", unreal.BlendMode.BLEND_ADDITIVE)
    t.set_editor_property("shading_model", unreal.MaterialShadingModel.MSM_UNLIT)
    color = expr(t, unreal.MaterialExpressionVectorParameter, -900, -300)
    color.set_editor_property("parameter_name", "Color")
    color.set_editor_property("default_value", unreal.LinearColor(1.0, 0.35, 0.08, 1.0))
    head = expr(t, unreal.MaterialExpressionVectorParameter, -1300, 100)
    head.set_editor_property("parameter_name", "Head")
    length = expr(t, unreal.MaterialExpressionScalarParameter, -1300, 250)
    length.set_editor_property("parameter_name", "Length")
    length.set_editor_property("default_value", 1000.0)
    tworld = expr(t, unreal.MaterialExpressionWorldPosition, -1300, 0)
    dist = expr(t, unreal.MaterialExpressionDistance, -1100, 60)
    mel.connect_material_expressions(tworld, "", dist, "A")
    mel.connect_material_expressions(head, "", dist, "B")
    frac = expr(t, unreal.MaterialExpressionDivide, -950, 100)
    mel.connect_material_expressions(dist, "", frac, "A")
    mel.connect_material_expressions(length, "", frac, "B")
    along = expr(t, unreal.MaterialExpressionOneMinus, -820, 100)
    sat = expr(t, unreal.MaterialExpressionSaturate, -940, 180)
    mel.connect_material_expressions(frac, "", sat, "")
    mel.connect_material_expressions(sat, "", along, "")
    fade = expr(t, unreal.MaterialExpressionPower, -700, 100)
    fade.set_editor_property("const_exponent", 2.0)
    mel.connect_material_expressions(along, "", fade, "Base")
    core = expr(t, unreal.MaterialExpressionPower, -700, 260)
    core.set_editor_property("const_exponent", 2.5)
    mel.connect_material_expressions(facing(t, -800, 220), "", core, "Base")
    ttime = expr(t, unreal.MaterialExpressionTime, -1300, 400)
    rush = expr(t, unreal.MaterialExpressionConstant3Vector, -1300, 480)
    rush.set_editor_property("constant", unreal.LinearColor(0.0, 0.0, 600.0, 0.0))
    flickpos = add(t, tworld, mul(t, ttime, rush, -1150, 440), -1000, 420)
    flicker = noise(t, flickpos, 0.01, 2, -850, 420, 0.4, 1.2)
    bright = mul(t, mul(t, mul(t, fade, core, -550, 160), flicker, -420, 200), const(t, 18.0, -420, 320), -300, 220)
    temission = mul(t, color, bright, -150, 0)
    mel.connect_material_property(temission, "", unreal.MaterialProperty.MP_EMISSIVE_COLOR)
    mel.recompile_material(t)

    # Cannonball.
    c = fresh_material("M_VibeCityCannonball")
    cworld = expr(c, unreal.MaterialExpressionWorldPosition, -900, 0)
    iron = expr(c, unreal.MaterialExpressionConstant3Vector, -500, -200)
    iron.set_editor_property("constant", unreal.LinearColor(0.035, 0.034, 0.033, 0.0))
    mel.connect_material_property(iron, "", unreal.MaterialProperty.MP_BASE_COLOR)
    mel.connect_material_property(const(c, 1.0, -500, -60), "", unreal.MaterialProperty.MP_METALLIC)
    rough = add(c, mul(c, noise(c, cworld, 0.2, 3, -700, 60), const(c, 0.3, -600, 160), -500, 80), const(c, 0.35, -500, 180), -350, 100)
    mel.connect_material_property(rough, "", unreal.MaterialProperty.MP_ROUGHNESS)
    mel.recompile_material(c)


def dust_volume_material():
    """Dust parcels (client-core dust.rs, the web's dust policy): one instance of a sphere per
    parcel, stretched to its cloud's box, translucent and lit as a volume. Per-instance custom data:
    0-2 colour (linear), 3 density D (the web's sprite density), 4 erosion (how much of the cloud
    the noise has eaten by now), 5 seed, 6 fade (in, then thinning out over its life). The surface billows (smooth 3D noise pushes it along its normal, scaled by the instance's
    radius), the density is thinned by drifting noise and eroded over its life, the edge softens
    toward the silhouette, the underside is darker (lit from above), and it fades into the city."""
    m = fresh_material("M_VibeCityDustVolume")
    m.set_editor_property("blend_mode", unreal.BlendMode.BLEND_TRANSLUCENT)
    m.set_editor_property("translucency_lighting_mode", unreal.TranslucencyLightingMode.TLM_VOLUMETRIC_NON_DIRECTIONAL)
    m.set_editor_property("used_with_instanced_static_meshes", True)
    data = []
    for i in range(6):
        c = expr(m, unreal.MaterialExpressionPerInstanceCustomData, -1600, -400 + i * 110)
        c.set_editor_property("data_index", i)
        data.append(c)

    def mul(a, b, x, y):
        e = expr(m, unreal.MaterialExpressionMultiply, x, y)
        mel.connect_material_expressions(a, "", e, "A")
        mel.connect_material_expressions(b, "", e, "B")
        return e

    def add(a, b, x, y):
        e = expr(m, unreal.MaterialExpressionAdd, x, y)
        mel.connect_material_expressions(a, "", e, "A")
        mel.connect_material_expressions(b, "", e, "B")
        return e

    def const(v, x, y):
        e = expr(m, unreal.MaterialExpressionConstant, x, y)
        e.set_editor_property("r", v)
        return e

    def noise(position, scale, levels, x, y):
        n = expr(m, unreal.MaterialExpressionNoise, x, y)
        n.set_editor_property("scale", scale)
        n.set_editor_property("levels", levels)
        n.set_editor_property("turbulence", False)
        n.set_editor_property("output_min", 0.0)
        n.set_editor_property("output_max", 1.0)
        mel.connect_material_expressions(position, "", n, "Position")
        return n

    # A position that drifts up slowly and differs per parcel (the seed).
    world = expr(m, unreal.MaterialExpressionWorldPosition, -1600, 300)
    time = expr(m, unreal.MaterialExpressionTime, -1600, 400)
    drift = expr(m, unreal.MaterialExpressionConstant3Vector, -1600, 480)
    drift.set_editor_property("constant", unreal.LinearColor(4.0, 7.0, 25.0, 0.0))
    moved = add(world, mul(time, drift, -1400, 420), -1250, 340)
    seeded = add(moved, mul(data[5], const(997.0, -1500, 560), -1350, 540), -1100, 400)

    # Billows: the surface pushed along its normal by smooth noise, up to +-15% of the radius (more
    # breaks the engine sphere's facets into spikes).
    radius = expr(m, unreal.MaterialExpressionObjectRadius, -1100, 700)
    lumps = noise(seeded, 0.003, 2, -900, 600)
    centred = add(lumps, const(-0.5, -900, 760), -700, 640)
    push = mul(mul(centred, radius, -550, 660), const(0.3, -550, 760), -400, 680)
    normal = expr(m, unreal.MaterialExpressionVertexNormalWS, -400, 800)
    wpo = mul(normal, push, -250, 720)
    mel.connect_material_property(wpo, "", unreal.MaterialProperty.MP_WORLD_POSITION_OFFSET)

    # Colour, darker underneath: rgb * (0.55 + 0.45 * (n.z * 0.5 + 0.5)).
    rg = expr(m, unreal.MaterialExpressionAppendVector, -1350, -380)
    mel.connect_material_expressions(data[0], "", rg, "A")
    mel.connect_material_expressions(data[1], "", rg, "B")
    rgb = expr(m, unreal.MaterialExpressionAppendVector, -1200, -350)
    mel.connect_material_expressions(rg, "", rgb, "A")
    mel.connect_material_expressions(data[2], "", rgb, "B")
    pixel_normal = expr(m, unreal.MaterialExpressionVertexNormalWS, -1350, -200)
    up = expr(m, unreal.MaterialExpressionComponentMask, -1200, -200)
    up.set_editor_property("r", False)
    up.set_editor_property("g", False)
    up.set_editor_property("b", True)
    mel.connect_material_expressions(pixel_normal, "", up, "")
    lit = add(mul(add(mul(up, const(0.5, -1050, -120), -950, -180), const(0.5, -950, -100), -850, -180), const(0.65, -850, -100), -750, -180), const(0.4, -750, -100), -650, -180)
    color = mul(rgb, lit, -500, -300)
    mel.connect_material_property(color, "", unreal.MaterialProperty.MP_BASE_COLOR)

    # Density, the web's sprite (DustSprites.tsx) on the sphere: r is the distance from the cloud's
    # centre seen in projection (sqrt(1 - (N.V)^2)), disc = 1 - smoothstep(0.25, 1, r),
    # dens = max(0, disc * (n * 1.6 - 0.3) - erosion * n) for wispy noise n, and the opacity is
    # (1 - exp(-dens * D * 0.9)) * fade, D and fade per parcel.
    view = expr(m, unreal.MaterialExpressionCameraVectorWS, -1100, 60)
    dot = expr(m, unreal.MaterialExpressionDotProduct, -950, 20)
    mel.connect_material_expressions(pixel_normal, "", dot, "A")
    mel.connect_material_expressions(view, "", dot, "B")
    r2 = expr(m, unreal.MaterialExpressionOneMinus, -700, 20)
    mel.connect_material_expressions(mul(dot, dot, -820, 20), "", r2, "")
    r2sat = expr(m, unreal.MaterialExpressionSaturate, -620, 20)
    mel.connect_material_expressions(r2, "", r2sat, "")
    r = expr(m, unreal.MaterialExpressionSquareRoot, -540, 20)
    mel.connect_material_expressions(r2sat, "", r, "")
    step = expr(m, unreal.MaterialExpressionSmoothStep, -460, 20)
    step.set_editor_property("const_min", 0.25)
    step.set_editor_property("const_max", 1.0)
    mel.connect_material_expressions(r, "", step, "Value")
    disc = expr(m, unreal.MaterialExpressionOneMinus, -380, 20)
    mel.connect_material_expressions(step, "", disc, "")
    wisps = noise(seeded, 0.012, 4, -900, 200)
    body = add(mul(wisps, const(1.6, -800, 300), -700, 240), const(-0.3, -700, 320), -600, 260)
    eaten = mul(data[4], wisps, -600, 380)
    dens_raw = expr(m, unreal.MaterialExpressionSubtract, -480, 260)
    mel.connect_material_expressions(mul(disc, body, -380, 200), "", dens_raw, "A")
    mel.connect_material_expressions(eaten, "", dens_raw, "B")
    dens = expr(m, unreal.MaterialExpressionMax, -380, 300)
    mel.connect_material_expressions(dens_raw, "", dens, "A")
    mel.connect_material_expressions(const(0.0, -480, 360), "", dens, "B")
    depth = mul(mul(dens, data[3], -300, 300), const(-0.9, -300, 380), -220, 320)
    transmit = expr(m, unreal.MaterialExpressionPower, -140, 320)
    mel.connect_material_expressions(const(2.718281828, -220, 400), "", transmit, "Base")
    mel.connect_material_expressions(depth, "", transmit, "Exp")
    absorbed = expr(m, unreal.MaterialExpressionOneMinus, -60, 320)
    mel.connect_material_expressions(transmit, "", absorbed, "")
    life = expr(m, unreal.MaterialExpressionPerInstanceCustomData, -200, 460)
    life.set_editor_property("data_index", 6)
    density = mul(absorbed, life, -100, 140)
    fade = expr(m, unreal.MaterialExpressionDepthFade, -60, 120)
    fade.set_editor_property("fade_distance_default", 200.0)
    mel.connect_material_expressions(density, "", fade, "Opacity")
    mel.connect_material_property(fade, "", unreal.MaterialProperty.MP_OPACITY)
    mel.connect_material_property(const(1.0, -60, 300), "", unreal.MaterialProperty.MP_ROUGHNESS)
    mel.recompile_material(m)
    return m


def dust_material():
    """Dust puffs (client-core effects.rs VlDust): a soft round sprite, lit as a volume, in the
    puff's Color at the puff's Opacity (both set per puff by the renderer as it grows and fades)."""
    m = fresh_material("M_VibeCityDust")
    m.set_editor_property("blend_mode", unreal.BlendMode.BLEND_TRANSLUCENT)
    m.set_editor_property("translucency_lighting_mode", unreal.TranslucencyLightingMode.TLM_VOLUMETRIC_NON_DIRECTIONAL)
    m.set_editor_property("two_sided", True)
    color = expr(m, unreal.MaterialExpressionVectorParameter, -700, -100)
    color.set_editor_property("parameter_name", "Color")
    color.set_editor_property("default_value", unreal.LinearColor(0.55, 0.53, 0.5, 1.0))
    mel.connect_material_property(color, "", unreal.MaterialProperty.MP_BASE_COLOR)
    # Soft disc: 1 at the centre, 0 at the edge of the sprite.
    uv = expr(m, unreal.MaterialExpressionTextureCoordinate, -1300, 150)
    centre = expr(m, unreal.MaterialExpressionConstant2Vector, -1300, 250)
    centre.set_editor_property("r", 0.5)
    centre.set_editor_property("g", 0.5)
    dist = expr(m, unreal.MaterialExpressionDistance, -1150, 180)
    mel.connect_material_expressions(uv, "", dist, "A")
    mel.connect_material_expressions(centre, "", dist, "B")
    twice = expr(m, unreal.MaterialExpressionMultiply, -1000, 180)
    twice.set_editor_property("const_b", 2.0)
    mel.connect_material_expressions(dist, "", twice, "A")
    inv = expr(m, unreal.MaterialExpressionOneMinus, -880, 180)
    mel.connect_material_expressions(twice, "", inv, "")
    sat = expr(m, unreal.MaterialExpressionSaturate, -780, 180)
    mel.connect_material_expressions(inv, "", sat, "")
    radial = expr(m, unreal.MaterialExpressionPower, -680, 150)
    radial.set_editor_property("const_exponent", 1.6)
    mel.connect_material_expressions(sat, "", radial, "Base")
    opacity = expr(m, unreal.MaterialExpressionScalarParameter, -700, 300)
    opacity.set_editor_property("parameter_name", "Opacity")
    opacity.set_editor_property("default_value", 0.6)
    mul = expr(m, unreal.MaterialExpressionMultiply, -450, 200)
    mel.connect_material_expressions(radial, "", mul, "A")
    mel.connect_material_expressions(opacity, "", mul, "B")
    fade = expr(m, unreal.MaterialExpressionDepthFade, -250, 200)
    fade.set_editor_property("fade_distance_default", 150.0)
    mel.connect_material_expressions(mul, "", fade, "Opacity")
    mel.connect_material_property(fade, "", unreal.MaterialProperty.MP_OPACITY)
    rough = expr(m, unreal.MaterialExpressionConstant, -700, 450)
    rough.set_editor_property("r", 1.0)
    mel.connect_material_property(rough, "", unreal.MaterialProperty.MP_ROUGHNESS)
    mel.recompile_material(m)
    return m


def grass_material():
    """Meadow blades (client-core grass.rs): coloured by vertex colour (RGB, linear),
    with a gentle wind sway that bends tips (vertex colour A = height fraction) and not roots."""
    m = fresh_material("M_VibeCityGrass")
    # One-sided: the renderer emits both faces of a blade with the same up-leaning normal, so a
    # blade seen from behind is lit like its front (a two-sided material would flip it downward).
    m.set_editor_property("two_sided", False)
    vc = expr(m, unreal.MaterialExpressionVertexColor, -900, 0)
    # VertexColor's colour output is the unnamed first pin ("RGB" names nothing and leaves base
    # colour unconnected).
    mel.connect_material_property(vc, "", unreal.MaterialProperty.MP_BASE_COLOR)
    rough = expr(m, unreal.MaterialExpressionConstant, -900, 200)
    rough.set_editor_property("r", 0.85)
    mel.connect_material_property(rough, "", unreal.MaterialProperty.MP_ROUGHNESS)
    # Sway: tip offset along +X and +Y = sin(time * 1.6 + world phase) * 8 cm * tip^2.
    time = expr(m, unreal.MaterialExpressionTime, -1300, 400)
    world = expr(m, unreal.MaterialExpressionWorldPosition, -1300, 500)
    wx = mask(m, "r", -1150, 500)
    mel.connect_material_expressions(world, "", wx, "")
    phase = expr(m, unreal.MaterialExpressionMultiply, -1000, 500)
    phase.set_editor_property("const_b", 0.004)
    mel.connect_material_expressions(wx, "", phase, "A")
    speed = expr(m, unreal.MaterialExpressionMultiply, -1150, 400)
    speed.set_editor_property("const_b", 1.6)
    mel.connect_material_expressions(time, "", speed, "A")
    arg = expr(m, unreal.MaterialExpressionAdd, -850, 450)
    mel.connect_material_expressions(speed, "", arg, "A")
    mel.connect_material_expressions(phase, "", arg, "B")
    wave = expr(m, unreal.MaterialExpressionSine, -720, 450)
    mel.connect_material_expressions(arg, "", wave, "")
    tip2 = expr(m, unreal.MaterialExpressionMultiply, -720, 650)
    mel.connect_material_expressions(vc, "A", tip2, "A")
    mel.connect_material_expressions(vc, "A", tip2, "B")
    amp = expr(m, unreal.MaterialExpressionMultiply, -580, 550)
    mel.connect_material_expressions(wave, "", amp, "A")
    mel.connect_material_expressions(tip2, "", amp, "B")
    scale = expr(m, unreal.MaterialExpressionConstant3Vector, -580, 700)
    scale.set_editor_property("constant", unreal.LinearColor(8.0, 5.0, 0.0, 0.0))
    offset = expr(m, unreal.MaterialExpressionMultiply, -420, 600)
    mel.connect_material_expressions(amp, "", offset, "A")
    mel.connect_material_expressions(scale, "", offset, "B")
    mel.connect_material_property(offset, "", unreal.MaterialProperty.MP_WORLD_POSITION_OFFSET)
    mel.recompile_material(m)
    return m


# client/src/scene/WeatherParticles.tsx's vertex shader, in Unreal space (cm, Z up): each quad's
# four corners sit at its particle's base position; drift with the wind and fall, tumble, wrap
# inside a box centred on the camera, then spread the corners facing the camera.
WEATHER_WPO = """
float3 drift = Wind * Time + float3(0.0, 0.0, -Fall * Time);
float phase = Time * 6.2831853 * TumbleHz + Seed * 12.566;
float3 tumble = float3(cos(phase), sin(phase * 0.71), 0.0) * TumbleCm;
float3 d = Base + drift + tumble - Cam;
float3 w = d - BoxCm * floor((d + BoxCm * 0.5) / BoxCm);
float3 f = normalize(w + float3(0.0, 0.0, 0.001));
float3 r = normalize(cross(float3(0.0, 0.0, 1.0), f) + float3(0.0001, 0.0, 0.0));
float3 u = cross(f, r);
float2 c = Corner - 0.5;
return Cam + w + (r * c.x - u * c.y) * SizeCm - Base;
"""
# Its fragment shader's soft disc, and the fade toward the box's edge.
WEATHER_OPACITY = """
float disc = 1.0 - smoothstep(0.35, 1.0, length(Corner - 0.5) * 2.0);
float edge = 1.0 - smoothstep(0.75, 1.0, length(P - Cam) / (BoxCm * 0.5));
return disc * edge;
"""


def custom(m, code, inputs, output, x, y):
    e = expr(m, unreal.MaterialExpressionCustom, x, y)
    e.set_editor_property("code", code)
    e.set_editor_property("output_type", output)
    pins = []
    for n in inputs:
        pin = unreal.CustomInput()
        pin.set_editor_property("input_name", n)
        pins.append(pin)
    e.set_editor_property("inputs", pins)
    return e


def weather_material(name, additive):
    """Weather particles (client-core weather.rs presets, AVibeCityWeather): lit as a volume like
    dust, in the preset's Color; parameters BoxCm, Wind (cm/s), Fall (cm/s), TumbleHz, TumbleCm,
    SizeCm set by the renderer. UV0 = quad corner, UV1.x = per-particle seed."""
    m = fresh_material(name)
    m.set_editor_property("blend_mode", unreal.BlendMode.BLEND_ADDITIVE if additive else unreal.BlendMode.BLEND_TRANSLUCENT)
    m.set_editor_property("translucency_lighting_mode", unreal.TranslucencyLightingMode.TLM_VOLUMETRIC_NON_DIRECTIONAL)
    m.set_editor_property("two_sided", True)

    def scalar(n, v, x, y):
        s = expr(m, unreal.MaterialExpressionScalarParameter, x, y)
        s.set_editor_property("parameter_name", n)
        s.set_editor_property("default_value", v)
        return s
    color = expr(m, unreal.MaterialExpressionVectorParameter, -600, -200)
    color.set_editor_property("parameter_name", "Color")
    color.set_editor_property("default_value", unreal.LinearColor(1.0, 1.0, 1.0, 1.0))
    mel.connect_material_property(color, "", unreal.MaterialProperty.MP_BASE_COLOR)
    rough = expr(m, unreal.MaterialExpressionConstant, -600, -50)
    rough.set_editor_property("r", 1.0)
    mel.connect_material_property(rough, "", unreal.MaterialProperty.MP_ROUGHNESS)

    corner = expr(m, unreal.MaterialExpressionTextureCoordinate, -1400, 0)
    seed_uv = expr(m, unreal.MaterialExpressionTextureCoordinate, -1400, 100)
    seed_uv.set_editor_property("coordinate_index", 1)
    seed = mask(m, "r", -1250, 100)
    mel.connect_material_expressions(seed_uv, "", seed, "")
    base = expr(m, unreal.MaterialExpressionWorldPosition, -1400, 200)
    cam = expr(m, unreal.MaterialExpressionCameraPositionWS, -1400, 300)
    time = expr(m, unreal.MaterialExpressionTime, -1400, 400)
    box = scalar("BoxCm", 6000.0, -1400, 500)
    wind = expr(m, unreal.MaterialExpressionVectorParameter, -1400, 600)
    wind.set_editor_property("parameter_name", "Wind")
    wind.set_editor_property("default_value", unreal.LinearColor(0.0, 0.0, 0.0, 0.0))
    wind3 = mask(m, "rgb", -1250, 600)
    mel.connect_material_expressions(wind, "", wind3, "")
    fall = scalar("Fall", 0.0, -1400, 700)
    hz = scalar("TumbleHz", 0.0, -1400, 800)
    amp = scalar("TumbleCm", 0.0, -1400, 900)
    size = scalar("SizeCm", 5.0, -1400, 1000)
    wpo = custom(m, WEATHER_WPO, ["Base", "Cam", "Time", "Seed", "Corner", "BoxCm", "Wind", "Fall", "TumbleHz", "TumbleCm", "SizeCm"],
                 unreal.CustomMaterialOutputType.CMOT_FLOAT3, -900, 400)
    for src, pin in [(base, "Base"), (cam, "Cam"), (time, "Time"), (seed, "Seed"), (corner, "Corner"), (box, "BoxCm"),
                     (wind3, "Wind"), (fall, "Fall"), (hz, "TumbleHz"), (amp, "TumbleCm"), (size, "SizeCm")]:
        mel.connect_material_expressions(src, "", wpo, pin)
    mel.connect_material_property(wpo, "", unreal.MaterialProperty.MP_WORLD_POSITION_OFFSET)
    pixel = expr(m, unreal.MaterialExpressionWorldPosition, -900, 100)
    opacity = custom(m, WEATHER_OPACITY, ["P", "Cam", "BoxCm", "Corner"], unreal.CustomMaterialOutputType.CMOT_FLOAT1, -600, 150)
    for src, pin in [(pixel, "P"), (cam, "Cam"), (box, "BoxCm"), (corner, "Corner")]:
        mel.connect_material_expressions(src, "", opacity, pin)
    mel.connect_material_property(opacity, "", unreal.MaterialProperty.MP_OPACITY)
    mel.recompile_material(m)
    return m


def canopy_material():
    """The distant foliage canopy (FoliageCanopy.ts): cards coloured by vertex colour (linear), two
    sided, dithered in between 22 and 36 m from the camera as the web hands off from the blades
    (foliageLod.ts FOLIAGE_HANDOFF pretty)."""
    m = fresh_material("M_VibeCityCanopy")
    m.set_editor_property("blend_mode", unreal.BlendMode.BLEND_MASKED)
    m.set_editor_property("two_sided", True)
    vc = expr(m, unreal.MaterialExpressionVertexColor, -800, -100)
    mel.connect_material_property(vc, "", unreal.MaterialProperty.MP_BASE_COLOR)
    rough = expr(m, unreal.MaterialExpressionConstant, -800, 100)
    rough.set_editor_property("r", 0.85)
    mel.connect_material_property(rough, "", unreal.MaterialProperty.MP_ROUGHNESS)
    # FoliageCanopy.ts: the same handoff and the same interleaved-gradient dither per pixel.
    handoff = custom(m, """
float handoff = smoothstep(2200.0, 3600.0, distance(Cam, P));
float2 px = Parameters.SvPosition.xy;
float dither = frac(52.9829189 * frac(dot(px, float2(0.06711056, 0.00583715))));
return dither < handoff ? 1.0 : 0.0;
""", ["Cam", "P"], unreal.CustomMaterialOutputType.CMOT_FLOAT1, -800, 250)
    mel.connect_material_expressions(expr(m, unreal.MaterialExpressionCameraPositionWS, -1100, 250), "", handoff, "Cam")
    mel.connect_material_expressions(expr(m, unreal.MaterialExpressionWorldPosition, -1100, 350), "", handoff, "P")
    mel.connect_material_property(handoff, "", unreal.MaterialProperty.MP_OPACITY_MASK)
    mel.recompile_material(m)
    return m


def battery_material():
    """Energy batteries (netEntityRenderers.ts BatteriesRenderer): gold metal, glowing by Glow."""
    m = fresh_material("M_VibeCityBattery")
    gold = expr(m, unreal.MaterialExpressionConstant3Vector, -600, -100)
    gold.set_editor_property("constant", unreal.LinearColor(1.0, 0.68, 0.0, 1.0))  # #ffd700, linear
    mel.connect_material_property(gold, "", unreal.MaterialProperty.MP_BASE_COLOR)
    metal = expr(m, unreal.MaterialExpressionConstant, -600, 50)
    metal.set_editor_property("r", 0.65)
    mel.connect_material_property(metal, "", unreal.MaterialProperty.MP_METALLIC)
    rough = expr(m, unreal.MaterialExpressionConstant, -600, 150)
    rough.set_editor_property("r", 0.25)
    mel.connect_material_property(rough, "", unreal.MaterialProperty.MP_ROUGHNESS)
    glow = expr(m, unreal.MaterialExpressionScalarParameter, -600, 250)
    glow.set_editor_property("parameter_name", "Glow")
    glow.set_editor_property("default_value", 4.0)
    warm = expr(m, unreal.MaterialExpressionConstant3Vector, -600, 350)
    warm.set_editor_property("constant", unreal.LinearColor(1.0, 0.6, 0.0, 1.0))  # #ffcc00, linear
    emissive = expr(m, unreal.MaterialExpressionMultiply, -350, 300)
    mel.connect_material_expressions(glow, "", emissive, "A")
    mel.connect_material_expressions(warm, "", emissive, "B")
    mel.connect_material_property(emissive, "", unreal.MaterialProperty.MP_EMISSIVE_COLOR)
    mel.recompile_material(m)
    return m


def glass_material():
    m = fresh_material("M_VibeCityGlass")
    m.set_editor_property("blend_mode", unreal.BlendMode.BLEND_TRANSLUCENT)
    m.set_editor_property("translucency_lighting_mode", unreal.TranslucencyLightingMode.TLM_SURFACE)
    glass = next(e for e in catalog["materials"] if e["id"] == "glass")
    hex_ = glass["baseColor"].lstrip("#")
    rgb = [int(hex_[i:i + 2], 16) / 255.0 for i in (0, 2, 4)]
    color = expr(m, unreal.MaterialExpressionVectorParameter, -600, 0)
    color.set_editor_property("parameter_name", "Color")
    color.set_editor_property("default_value", unreal.LinearColor(*[c ** 2.2 for c in rgb], 1.0))
    mel.connect_material_property(color, "", unreal.MaterialProperty.MP_BASE_COLOR)
    rough = expr(m, unreal.MaterialExpressionConstant, -600, 200)
    rough.set_editor_property("r", glass["roughness"])
    mel.connect_material_property(rough, "", unreal.MaterialProperty.MP_ROUGHNESS)
    # The scene packs author glazing at opacity 0.55 (minas-tirith.json, house-1story.json).
    opacity = expr(m, unreal.MaterialExpressionScalarParameter, -600, 300)
    opacity.set_editor_property("parameter_name", "Opacity")
    opacity.set_editor_property("default_value", 0.55)
    mel.connect_material_property(opacity, "", unreal.MaterialProperty.MP_OPACITY)
    spec = expr(m, unreal.MaterialExpressionConstant, -600, 400)
    spec.set_editor_property("r", 1.0)
    mel.connect_material_property(spec, "", unreal.MaterialProperty.MP_SPECULAR)
    mel.recompile_material(m)
    return m


only = os.environ.get("VIBE_MATERIALS_ONLY", "")
if only == "battery":
    battery_material()
    saved = assets.save_directory(MATERIALS, only_if_is_dirty=False, recursive=True)
    unreal.log(f"VIBE_IMPORT_OK battery saved={saved}")
    raise SystemExit(0)
if only == "chunkhd":
    # Rebuilds M_VibeCityChunkHD on the HD arrays a full --hd import made.
    hd_chunk_material(*(unreal.load_asset(f"{TEXTURES}/{n}") for n in ("T_CityAlbedoHDArray", "T_CityNormalHDArray", "T_CityARMHDArray")))
    saved = assets.save_directory(MATERIALS, only_if_is_dirty=False, recursive=True)
    unreal.log(f"VIBE_IMPORT_OK chunkhd saved={saved}")
    raise SystemExit(0)
if only == "projectiles":
    projectile_materials()
    saved = assets.save_directory(MATERIALS, only_if_is_dirty=False, recursive=True)
    unreal.log(f"VIBE_IMPORT_OK projectiles saved={saved}")
    raise SystemExit(0)
if only == "dustvolume":
    dust_volume_material()
    saved = assets.save_directory(MATERIALS, only_if_is_dirty=False, recursive=True)
    unreal.log(f"VIBE_IMPORT_OK dustvolume saved={saved}")
    raise SystemExit(0)
if only == "canopy":
    canopy_material()
    saved = assets.save_directory(MATERIALS, only_if_is_dirty=False, recursive=True)
    unreal.log(f"VIBE_IMPORT_OK canopy saved={saved}")
    raise SystemExit(0)
if only == "weather":
    # Just the weather materials (no textures needed).
    weather_material("M_VibeCityWeather", additive=False)
    weather_material("M_VibeCityWeatherAdditive", additive=True)
    saved = assets.save_directory(MATERIALS, only_if_is_dirty=False, recursive=True)
    unreal.log(f"VIBE_IMPORT_OK weather saved={saved}")
    raise SystemExit(0)

albedo_layers = import_layers("albedo", srgb=True)
surface_layers = import_layers("surface", srgb=False)
albedo_array = texture_array("T_CityAlbedoArray", albedo_layers, srgb=True)
surface_array = texture_array("T_CitySurfaceArray", surface_layers, srgb=False)
chunk = chunk_material(albedo_array, surface_array)
# The same without the normal map: a cheaper fallback, and a diagnostic for the tangent basis.
chunk_material(albedo_array, surface_array, "M_VibeCityChunkFlat", normal_map=False)
glass = glass_material()
dust_material()
dust_volume_material()
projectile_materials()
grass_material()
weather_material("M_VibeCityWeather", additive=False)
weather_material("M_VibeCityWeatherAdditive", additive=True)
canopy_material()
battery_material()
hd_dir = os.environ.get("VIBE_CITY_HD_TEXTURES", "")
if hd_dir:
    hd_albedo = import_layers("albedo", srgb=True, directory=hd_dir, ext="jpg", suffix="HD")
    hd_normal = import_layers("normal", srgb=False, directory=hd_dir, ext="jpg", suffix="HD",
                              compression=unreal.TextureCompressionSettings.TC_NORMALMAP)
    hd_arm = import_layers("arm", srgb=False, directory=hd_dir, ext="jpg", suffix="HD",
                           compression=unreal.TextureCompressionSettings.TC_MASKS)
    hd_arrays = (
        texture_array("T_CityAlbedoHDArray", hd_albedo, srgb=True),
        texture_array("T_CityNormalHDArray", hd_normal, srgb=False, compression=unreal.TextureCompressionSettings.TC_NORMALMAP),
        texture_array("T_CityARMHDArray", hd_arm, srgb=False, compression=unreal.TextureCompressionSettings.TC_MASKS),
    )
    hd_chunk_material(*hd_arrays)
    hd_ground_material(*hd_arrays)
saved = assets.save_directory(ROOT, only_if_is_dirty=False, recursive=True)
unreal.log(f"VIBE_IMPORT_OK layers={len(layered)} saved={saved} chunk={chunk.get_path_name()} glass={glass.get_path_name()}")
