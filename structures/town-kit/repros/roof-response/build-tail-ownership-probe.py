"""Private fix candidate: consume final-pass ownership at the next broad phase.

The final allowed correction may split bodies without another collide pass.
Those installed generations must reach the following ordinary collide pass.
No shared headers, sources, archives, libraries or running services are changed.
"""
import difflib,hashlib,json,shlex,shutil,subprocess
from pathlib import Path
sdk=Path('/root/workspace/physx-2');kit=Path(__file__).resolve().parents[2];out=kit/'out/roof-tail-ownership-probe';out.mkdir(exist_ok=False)
source=sdk/'physx/source/gpusimulationcontroller/src/PxgSimulationController.cpp';before=source.read_text();after=before.replace('''        static_cast<PxgAABBManager&>(aabbManager).setNativeOwnershipView(
            isDestructionCorrecting() ? mDestruction->collisionOwnershipView() : PxgDestructionOwnershipView{});''','''        // Final-pass splits do not schedule another correction. Their generation
        // survives until prepareFrame(0), after the next ordinary collision pass.
        // Consume it there too, before new-owner contact pairs and bounds are read.
        const auto ownership=mDestruction ? mDestruction->collisionOwnershipView() : PxgDestructionOwnershipView{};
        const bool nativeOwnershipPending=ownership.generation!=0;
        static_cast<PxgAABBManager&>(aabbManager).setNativeOwnershipView(ownership);''')
assert after!=before
# All three consumers must agree on the pending publication, including its event.
after=after.replace('if(isDestructionCorrecting() && mCudaContextManager->getCudaContext()->streamWaitEvent(', 'if(nativeOwnershipPending && mCudaContextManager->getCudaContext()->streamWaitEvent(')
after=after.replace('refreshReboundShapeBounds(npStream,isDestructionCorrecting())','refreshReboundShapeBounds(npStream,isDestructionCorrecting() || nativeOwnershipPending)')
patched=out/source.name;patched.write_text(after);(out/'probe.patch').write_text(''.join(difflib.unified_diff(before.splitlines(True),after.splitlines(True),fromfile=str(source),tofile=str(patched))))
entry=next(c for c in json.loads((sdk/'out/sdk-release/compile_commands.json').read_text()) if c['file']==str(source));cmd=shlex.split(entry['command']);old_object=(Path(entry['directory'])/cmd[cmd.index('-o')+1]).resolve();obj=out/(source.name+'.o');cmd[cmd.index('-o')+1]=str(obj);cmd[cmd.index('-c')+1]=str(patched);assert not any(x in cmd for x in ['-MF','-MD','-MT','-MMD']);subprocess.run(cmd,cwd=entry['directory'],check=True)
original_archive=sdk/'physx/bin/linux.x86_64/release/libPhysXSimulationControllerGpu_static_64.a'
assert original_archive.exists(),original_archive
archive=out/original_archive.name;shutil.copyfile(original_archive,archive);subprocess.run(['ar','r',str(archive),str(obj)],check=True)
link=sdk/'out/sdk-release/sdk_gpu_source_bin/CMakeFiles/PhysXGpu.dir/link.txt';cmd=shlex.split(link.read_text());cmd[cmd.index('-o')+1]=str(out/'libPhysXGpuActivity_64.so');count=0
for i,a in enumerate(cmd):
 if a==str(original_archive):cmd[i]=str(archive);count+=1
 elif not a.startswith('-') and (Path(entry['directory'])/a).resolve()==old_object:cmd[i]=str(obj);count+=1
assert count==2,count;subprocess.run(cmd,cwd=entry['directory'],check=True)
(out/'receipt.json').write_text(json.dumps({'sdkRevision':subprocess.check_output(['git','rev-parse','HEAD'],cwd=sdk,text=True).strip(),'sourceSha256':hashlib.sha256(before.encode()).hexdigest(),'patchedSourceSha256':hashlib.sha256(after.encode()).hexdigest(),'librarySha256':hashlib.sha256((out/'libPhysXGpuActivity_64.so').read_bytes()).hexdigest()},indent=2));print(out)
