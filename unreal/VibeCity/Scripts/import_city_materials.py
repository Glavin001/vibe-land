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
    mel.connect_material_property(tinted, "", unreal.MaterialProperty.MP_BASE_COLOR)

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
    mel.connect_material_property(arm, "G", unreal.MaterialProperty.MP_ROUGHNESS)
    mel.connect_material_property(arm, "B", unreal.MaterialProperty.MP_METALLIC)
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
