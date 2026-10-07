#!/usr/bin/env python3
"""DIAGNOSTIC PACK, NOT SHIPPED. The high-fidelity lab pack with only the
heel-joint material's limits x100, for the at-rest regression arm: with the
heels unable to fail, the veneer house must stand at rest under every
high-fidelity flag (sections, crush, the impact solve). It isolates the heel
joints' at-rest failure under section bending (2026-10-07: 30/30 heels break
at rest, and with crush on the falling roof brings the whole house down).

    scripts/hifi/diag-strongheel.py [SRC.json] [OUT_DIR]   (writes vehicle-lab-crush-strongheel.{json,meta.json})
    scripts/hifi/testbed.sh high LABEL rest VIBE_TESTBED_SCENE_BONDS=1 VIBE_CITY_SCENE=OUT/...json VIBE_TESTBED_META=OUT/...meta.json
"""
import json, os, shutil, sys
root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
src = sys.argv[1] if len(sys.argv) > 1 else f'{root}/target/fidelity/high/structures/vehicle-lab/out/vehicle-lab-crush.json'
out = sys.argv[2] if len(sys.argv) > 2 else f'{root}/target/hifi-logs/diag'
os.makedirs(out, exist_ok=True)
pack = json.load(open(src))
for m in pack['defaults']['solver']['materials']:
    if m['name'] == 'heel-joint':
        for k in ('compressionElastic', 'compressionFatal', 'tensionElastic', 'tensionFatal', 'shearElastic', 'shearFatal'):
            m[k] *= 100
json.dump(pack, open(f'{out}/vehicle-lab-crush-strongheel.json', 'w'))
shutil.copy(src.replace('.json', '.meta.json'), f'{out}/vehicle-lab-crush-strongheel.meta.json')
print(f'{out}/vehicle-lab-crush-strongheel.json (diagnostic, not shipped)')
