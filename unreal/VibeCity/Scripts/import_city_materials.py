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
  Materials/M_VibeCityChunkHD                         2K Poly Haven sources (with --hd)

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
hd_dir = os.environ.get("VIBE_CITY_HD_TEXTURES", "")
if hd_dir:
    hd_albedo = import_layers("albedo", srgb=True, directory=hd_dir, ext="jpg", suffix="HD")
    hd_normal = import_layers("normal", srgb=False, directory=hd_dir, ext="jpg", suffix="HD",
                              compression=unreal.TextureCompressionSettings.TC_NORMALMAP)
    hd_arm = import_layers("arm", srgb=False, directory=hd_dir, ext="jpg", suffix="HD",
                           compression=unreal.TextureCompressionSettings.TC_MASKS)
    hd_chunk_material(
        texture_array("T_CityAlbedoHDArray", hd_albedo, srgb=True),
        texture_array("T_CityNormalHDArray", hd_normal, srgb=False, compression=unreal.TextureCompressionSettings.TC_NORMALMAP),
        texture_array("T_CityARMHDArray", hd_arm, srgb=False, compression=unreal.TextureCompressionSettings.TC_MASKS),
    )
saved = assets.save_directory(ROOT, only_if_is_dirty=False, recursive=True)
unreal.log(f"VIBE_IMPORT_OK layers={len(layered)} saved={saved} chunk={chunk.get_path_name()} glass={glass.get_path_name()}")
