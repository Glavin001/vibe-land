// Failure forensics only: does not configure, repair or mutate the scene.
#include "PxPhysicsAPI.h"
#include "PxDestructionScene.h"
#include "cudamanager/PxCudaContextManager.h"
#include <cuda.h>
#include <cstdint>
#include <vector>
#include <cmath>
extern "C" unsigned town_kit_impact_diagnostics(std::uintptr_t ptr,std::uint64_t* out){
 if(!ptr||!out)return 1;
 auto& scene=*reinterpret_cast<physx::PxScene*>(ptr);
 auto* stage=scene.getDestructionScene();auto* cuda=scene.getCudaContextManager();if(!stage||!cuda)return 2;
 cuda->acquireContext();unsigned error=0;
 const auto view=stage->getDeviceView();
 if(view.readyEvent)error=cuEventSynchronize(view.readyEvent);
 physx::PxDestructionStressTopologyStatus status{};
 if(!error&&view.stressTopology)error=cuMemcpyDtoH(&status,reinterpret_cast<CUdeviceptr>(view.stressTopology),sizeof(status));
 if(!error){out[0]=status.error;out[1]=status.initialized;out[2]=status.generation;out[3]=status.solvedGeneration;out[4]=status.rebuilds;out[5]=status.islandCount;out[6]=status.activeBondCount;out[7]=status.activeNodeCount;}
 cuda->releaseContext();return error;
}
