"""Run unchanged frozen SDK assertions with a private TWSTATE v3 parser adapter.

Version 3 adds only a u32 rendering group after each pose's sleeping byte.
No physical checks, tolerances or golden fixtures are modified.
"""
import hashlib, importlib.util, json, sys
from pathlib import Path
sdk=Path('/root/workspace/physx-2')
kit=Path(__file__).resolve().parents[1]
capture=Path(sys.argv[1]).resolve()
root=capture/'verifier-compatibility';root.mkdir(exist_ok=True)
source=sdk/'tools/scripts'
verifier=(source/'verify-native-penetration.py').read_text()
parser=(source/'analyze-native-motion.py').read_text()
assert 'assert version == 2 and fps == 60' in parser
assert "read('B')\n                    positions[identity]" in parser
adapted=parser.replace('assert version == 2 and fps == 60','assert version in (2, 3) and fps == 60').replace("read('B')\n                    positions[identity]", "read('B')\n                    if version == 3: read('I')  # Rendering group, not a physical pose field.\n                    positions[identity]")
(root/'verify-native-penetration.py').write_text(verifier)
(root/'analyze-native-motion.py').write_text(adapted)
sha=lambda s:hashlib.sha256(s.encode()).hexdigest()
record={'originalVerifierSha256':sha(verifier),'originalParserSha256':sha(parser),'adapterParserSha256':sha(adapted),'goldenUnchanged':True,'physicsAssertionsUnchanged':True}
spec=importlib.util.spec_from_file_location('kit_penetration',root/'verify-native-penetration.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
try:
 result=module.verify(capture,sdk/'tools/profiles/wall-penetration-quality.json')
 record['frozenPassed']=True
except AssertionError as error:
 record['frozenPassed']=False;record['frozenFailure']=str(error)
 # Keep the failed frozen gate explicit, even if physical quality passes.
 result=module.verify(capture)
record['physicalQuality']=result
(capture/'compatibility-quality.json').write_text(json.dumps(record,indent=2)+'\n')
print(json.dumps(record,indent=2))
if not record['frozenPassed']:sys.exit(1)
