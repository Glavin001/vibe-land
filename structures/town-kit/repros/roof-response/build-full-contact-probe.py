"""Private control: rebuild corrected contact pairs instead of retaining them.

Keeps the production stress implementation, timestep, gravity and destruction.
Reuses private matching compiled topology/stress objects; never edits SDK source.
"""
import json,shlex,shutil,subprocess,hashlib
from pathlib import Path
sdk=Path('/root/workspace/physx-2');kit=Path(__file__).resolve().parents[2];out=kit/'out/roof-full-contact-probe';out.mkdir(exist_ok=False)
src=sdk/'physx/source/gpudestruction/src';shutil.copytree(src,out/'src');cu=out/'src/PxgDestructionRuntime.cu';original=cu.read_text();changed=original.replace('mPreserveContactPairs=d.preserveUnchangedContactPairs;','mPreserveContactPairs=false;');assert changed!=original;cu.write_text(changed)
entry=next(c for c in json.loads((sdk/'out/sdk-release/compile_commands.json').read_text()) if c['file']==str(src/'PxgDestructionRuntime.cu') and 'PhysXDestructionGpuRuntime.dir' in c['command']);cmd=shlex.split(entry['command']);cmd[cmd.index('-c')+1]=str(cu);obj=out/'PxgDestructionRuntime.cu.o';cmd[cmd.index('-o')+1]=str(obj);assert not any(x in cmd for x in ['-MF','-MD','-MT','-MMD']);subprocess.run(cmd,cwd=entry['directory'],check=True)
base=kit/'out/warm-runtime/native-runtime';target=base/'CMakeFiles/PhysXDestructionGpuRuntime.dir';cmd=shlex.split((target/'link.txt').read_text());expanded=[]
for a in cmd:
 expanded.extend(shlex.split((base/a[1:]).read_text()) if a.startswith('@') else [a])
cmd=expanded;cmd[cmd.index('-o')+1]=str(out/'libPhysXDestructionGpuRuntime_64.so');count=0
for i,a in enumerate(cmd):
 if a.endswith('/PxgDestructionRuntime.cu.o'):cmd[i]=str(obj);count+=1
assert count==1;subprocess.run(cmd,cwd=base,check=True)
(out/'receipt.json').write_text(json.dumps({'sdkRevision':subprocess.check_output(['git','rev-parse','HEAD'],cwd=sdk,text=True).strip(),'sourceSha256':hashlib.sha256(original.encode()).hexdigest(),'changedSha256':hashlib.sha256(changed.encode()).hexdigest(),'runtimeSha256':hashlib.sha256((out/'libPhysXDestructionGpuRuntime_64.so').read_bytes()).hexdigest(),'diagnostic':'preserveUnchangedContactPairs=false'},indent=2));print(out)
