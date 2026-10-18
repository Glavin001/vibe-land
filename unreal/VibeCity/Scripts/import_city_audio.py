"""Import the web client's destruction audio clips as Unreal SoundWaves.

Run by scripts/unreal/import-city-audio.sh, which converts client/public/audio/destruction/*.{mp3,wav}
to WAV in $VIBE_CITY_AUDIO first. Generated, not committed.

Creates under /Game/VibeCity/Audio:
  <clip id>               one SoundWave per catalog clip, named by its id (e.g. concrete-impact-0)
  SA_VibeCity             spatialized, with no distance attenuation: the client core's gain already
                          carries the web's falloff (client-core audio.rs source_attenuation)
"""

import os

import unreal

ROOT = "/Game/VibeCity/Audio"
src = os.environ["VIBE_CITY_AUDIO"]
tools = unreal.AssetToolsHelpers.get_asset_tools()
assets = unreal.EditorAssetLibrary

tasks = []
for name in sorted(os.listdir(src)):
    if not name.endswith(".wav"):
        continue
    task = unreal.AssetImportTask()
    task.filename = os.path.join(src, name)
    task.destination_path = ROOT
    task.destination_name = name[:-4]
    task.replace_existing = True
    task.automated = True
    task.save = False
    tasks.append(task)
tools.import_asset_tasks(tasks)
imported = [t for t in tasks if unreal.load_asset(f"{ROOT}/{t.destination_name}")]

path = f"{ROOT}/SA_VibeCity"
if assets.does_asset_exist(path):
    assets.delete_asset(path)
attenuation = tools.create_asset("SA_VibeCity", ROOT, unreal.SoundAttenuation, unreal.SoundAttenuationFactory())
settings = attenuation.get_editor_property("attenuation")
settings.set_editor_property("attenuate", False)
settings.set_editor_property("spatialize", True)
attenuation.set_editor_property("attenuation", settings)

saved = assets.save_directory(ROOT, only_if_is_dirty=False, recursive=True)
unreal.log(f"VIBE_AUDIO_IMPORT_OK clips={len(imported)} of {len(tasks)} saved={saved}")
