"""Import the web client's character (Quaternius Universal Animation Library, CC0) for VibeCity.

Run by scripts/unreal/import-characters.sh (a headless commandlet). Generated, not committed: the
input is client/public/models/UAL1_Standard.glb (the web's character, scene/characterAnim/profile.ts)
and this script.

Creates under /Game/VibeCity/Characters:
  UAL1_Standard              the skeletal mesh (and its skeleton, physics asset, materials)
  Anims/<clip>               one animation sequence per glTF animation, named as in the GLB
                             (Idle_Loop, Walk_Loop, Jog_Fwd_Loop, Sprint_Loop, ...)
AVibeRemotePlayers loads them by those paths.
"""

import os

import unreal

ROOT = "/Game/VibeCity/Characters"
STAGE = f"{ROOT}/Import"
ANIMS = f"{ROOT}/Anims"

src = os.environ["VIBE_CHARACTER_GLB"]
assets = unreal.EditorAssetLibrary
registry = unreal.AssetRegistryHelpers.get_asset_registry()

for path in (STAGE, ANIMS):
    if assets.does_directory_exist(path):
        assets.delete_directory(path)
for leftover in (f"{ROOT}/UAL1_Standard",):
    if assets.does_asset_exist(leftover):
        assets.delete_asset(leftover)

task = unreal.AssetImportTask()
task.filename = src
task.destination_path = STAGE
task.replace_existing = True
task.automated = True
task.save = True
unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks([task])

imported = assets.list_assets(STAGE, recursive=True, include_folder=False)
for path in imported:
    data = assets.find_asset_data(path)
    print(f"VIBE_IMPORTED {data.asset_class_path.asset_name} {path}")

mesh = None
moved_anims = 0
for path in imported:
    data = assets.find_asset_data(path)
    kind = str(data.asset_class_path.asset_name)
    name = str(data.asset_name)
    if kind == "SkeletalMesh" and mesh is None:
        mesh = path
        assets.rename_asset(path, f"{ROOT}/UAL1_Standard")
    elif kind == "AnimSequence":
        # Interchange names a clip <mesh name><glTF animation name> (UAL1_StandardIdle_Loop): keep
        # the glTF animation's name.
        clip = name[len("UAL1_Standard"):] if name.startswith("UAL1_Standard") else name
        assets.rename_asset(path, f"{ANIMS}/{clip}")
        moved_anims += 1

assert mesh, "no skeletal mesh was imported"

# UAL2 carries the rest of the web's clips (Melee_Hook among them) for the same skeleton: import only
# its animations, onto UAL1's skeleton.
src2 = os.environ.get("VIBE_CHARACTER_GLB2")
if src2:
    stage2 = f"{ROOT}/Import2"
    if assets.does_directory_exist(stage2):
        assets.delete_directory(stage2)
    skeleton = unreal.load_asset(f"{ROOT}/UAL1_Standard").get_editor_property("skeleton")
    pipeline = unreal.InterchangeGenericAssetsPipeline()
    common = pipeline.get_editor_property("common_skeletal_meshes_and_animations_properties")
    common.set_editor_property("skeleton", skeleton)
    common.set_editor_property("import_only_animations", True)
    params = unreal.ImportAssetParameters()
    params.is_automated = True
    params.override_pipelines.append(unreal.SoftObjectPath(pipeline.get_path_name()))
    source = unreal.InterchangeManager.create_source_data(src2)
    unreal.InterchangeManager.get_interchange_manager_scripted().import_asset(stage2, source, params)
    for path in assets.list_assets(stage2, recursive=True, include_folder=False):
        data = assets.find_asset_data(path)
        if str(data.asset_class_path.asset_name) != "AnimSequence":
            continue
        name = str(data.asset_name)
        clip = name[len("UAL2_Standard"):] if name.startswith("UAL2_Standard") else name
        if not assets.does_asset_exist(f"{ANIMS}/{clip}"):
            assets.rename_asset(path, f"{ANIMS}/{clip}")
            moved_anims += 1
assets.save_directory(ROOT, only_if_is_dirty=False, recursive=True)
print(f"VIBE_IMPORT_OK mesh={ROOT}/UAL1_Standard anims={moved_anims}")
