import hashlib,json,shlex,shutil,subprocess
from pathlib import Path
sdk=Path('/root/workspace/physx-gpu-activity/physx')
out=Path('/tmp/physx-query-baseline');out.mkdir(exist_ok=True)
source=sdk/'source/physx/src/NpDirectGPUAPI.cpp'
s=source.read_text();a=s.index('        const PxTransform body2World = poses[i] * core.getBody2Actor();');b=s.index('\n    }\n    return true;',a)
s=s[:a]+'''        core.getCore().body2World = poses[i] * core.getBody2Actor();
        core.setLinearVelocityInternal(linear[i]);
        core.setAngularVelocityInternal(angular[i]);
        body.getShapeManager().markActorForSQUpdate(mNpScene.getSQAPI(), body);'''+s[b:]
blob=subprocess.check_output(['git','hash-object','--stdin'],input=s.encode()).decode().strip()
assert blob.startswith('e18255b'), 'Reconstructed source differs from original SDK patch'
cpp=out/'NpDirectGPUAPI.cpp';cpp.write_text(s)
obj=out/'NpDirectGPUAPI.cpp.o'
c=next(r for r in json.loads((sdk/'compiler/gpu-activity-release/compile_commands.json').read_text()) if r['file']==str(source))
cmd=shlex.split(c['command']);cmd[cmd.index('-o')+1]=str(obj);cmd[cmd.index('-c')+1]=str(cpp)
cmd.insert(1,'-ffile-prefix-map='+str(cpp)+'='+str(source))
subprocess.run(cmd,cwd=c['directory'],check=True)
libs=out/'bin/linux.x86_64/release';libs.mkdir(parents=True,exist_ok=True)
(out/'include').symlink_to(sdk/'include',target_is_directory=True)
manifest=json.loads(Path('/root/workspace/vibe-land-4/bench-results/simulation-frontier/direct-contact-preparation/baseline-sdk-manifest.json').read_text())
for name in manifest['libraries']:
 p=libs/name
 if name=='libPhysX_static_64.a':shutil.copyfile(sdk/'bin/linux.x86_64/release'/name,p)
 else:p.symlink_to(sdk/'bin/linux.x86_64/release'/name)
archive=libs/'libPhysX_static_64.a'
subprocess.run(['ar','rD',str(archive),str(obj)],check=True)
subprocess.run(['ar','sD',str(archive)],check=True)
hashes={name:hashlib.sha256((libs/name).read_bytes()).hexdigest() for name in manifest['libraries']}
assert hashes==manifest['libraries'], 'Baseline SDK binary reconstruction was not byte-identical'
(out/'gpu-activity-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print('Reconstructed baseline SDK: all library hashes exactly match the pre-change manifest',flush=True)
