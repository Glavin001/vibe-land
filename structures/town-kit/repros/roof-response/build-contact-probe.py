"""Private SDK contact invalidation probe. Never writes the shared SDK build.

Reuses matching existing SDK objects, compiling only AABBManager with a diagnostic
host refilter request for migrated shapes. This is not a production patch.
"""
import difflib,hashlib,json,shlex,shutil,subprocess
from pathlib import Path
sdk=Path('/root/workspace/physx-2');kit=Path(__file__).resolve().parents[2]
out=kit/'out/roof-contact-probe';out.mkdir(exist_ok=False)
source=sdk/'physx/source/gpubroadphase/src/PxgAABBManager.cpp'
before=source.read_text();after=before.replace('''    if(!deviceOwnerTransaction) {
        mRefilterHandleMap.growAndSet(index);
        mRefilterPending = true;
        mChangedHandleMap.growAndSet(index);
        ++mHostRefilterRequests;
        mGroups[index] = group;''','''    mRefilterHandleMap.growAndSet(index);
    mRefilterPending = true;
    mChangedHandleMap.growAndSet(index);
    ++mHostRefilterRequests;
    if(!deviceOwnerTransaction) {
        mGroups[index] = group;''')
assert after!=before
patched=out/source.name;patched.write_text(after)
(out/'probe.patch').write_text(''.join(difflib.unified_diff(before.splitlines(True),after.splitlines(True),fromfile=str(source),tofile=str(patched))))
commands=json.loads((sdk/'out/sdk-release/compile_commands.json').read_text());entry=next(c for c in commands if c['file']==str(source));args=shlex.split(entry['command']);old_object=Path(entry['directory'])/args[args.index('-o')+1];obj=out/(source.name+'.o');args[args.index('-o')+1]=str(obj);args[args.index('-c')+1]=str(patched)
assert not any(a in args for a in ['-MF','-MT','-MD','-MMD']),args
subprocess.run(args,cwd=entry['directory'],check=True)
original_archive=sdk/'physx/bin/linux.x86_64/release/libPhysXBroadphaseGpu_static_64.a';archive=out/original_archive.name;shutil.copyfile(original_archive,archive);subprocess.run(['ar','r',str(archive),str(obj)],check=True)
link=sdk/'out/sdk-release/sdk_gpu_source_bin/CMakeFiles/PhysXGpu.dir/link.txt';args=shlex.split(link.read_text());args[args.index('-o')+1]=str(out/'libPhysXGpuActivity_64.so');replaced=0
for i,a in enumerate(args):
 if a==str(original_archive):args[i]=str(archive);replaced+=1
 elif not a.startswith('-') and (Path(entry['directory'])/a).resolve()==old_object.resolve():args[i]=str(obj);replaced+=1
assert replaced==2,replaced
subprocess.run(args,cwd=entry['directory'],check=True)
(out/'receipt.json').write_text(json.dumps({'sdkRevision':subprocess.check_output(['git','rev-parse','HEAD'],cwd=sdk,text=True).strip(),'sourceSha256':hashlib.sha256(before.encode()).hexdigest(),'patchSha256':hashlib.sha256(after.encode()).hexdigest(),'librarySha256':hashlib.sha256((out/'libPhysXGpuActivity_64.so').read_bytes()).hexdigest()},indent=2))
print(out)
