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

// Read-only comparison of public collision shape poses with recorded native
// chunk poses. Contact index stays stable across ownership changes.
#include "extensions/PxShapeExt.h"
#include "extensions/PxMassProperties.h"
#include <fstream>
#include <iomanip>
#include <unordered_map>
#include <unordered_set>
extern "C" unsigned town_kit_collision_snapshot(std::uintptr_t ptr,const char* path,unsigned tick){
 if(!ptr||!path)return 1;
 auto& scene=*reinterpret_cast<physx::PxScene*>(ptr);auto* stage=scene.getDestructionScene();if(!stage)return 2;
 std::ofstream out(path,std::ios::app);if(!out)return 3;out<<std::setprecision(9);
 using namespace physx;
 static std::vector<PxShape*> tracked;
 if(tick==0){
  tracked.clear();std::vector<PxActor*> initial(scene.getNbActors(PxActorTypeFlag::eRIGID_DYNAMIC));
  scene.getActors(PxActorTypeFlag::eRIGID_DYNAMIC,initial.data(),initial.size());
  for(auto* a:initial){auto* body=a->is<PxRigidDynamic>();std::vector<PxShape*> shapes(body->getNbShapes());body->getShapes(shapes.data(),shapes.size());
   for(auto* shape:shapes)if(shape->getSimulationFilterData().word3&0x80000000u)tracked.push_back(shape);
  }
 }
 std::vector<PxActor*> actors;std::unordered_set<PxRigidActor*> seen;
 for(auto* shape:tracked){auto* actor=shape->getActor();if(!actor)return 6;if(seen.insert(actor).second)actors.push_back(actor);}
 auto* cuda=scene.getCudaContextManager();if(!cuda)return 4;
 std::vector<PxRigidDynamicGPUIndex> indices;for(auto* a:actors)indices.push_back(a->is<PxRigidDynamic>()->getGPUIndex());
 std::vector<PxTransform> gpuPoses(actors.size());CUdeviceptr deviceIndices=0,devicePoses=0;
 cuda->acquireContext();
 unsigned error=cuMemAlloc(&deviceIndices,indices.size()*sizeof(indices[0]));
 if(!error)error=cuMemAlloc(&devicePoses,gpuPoses.size()*sizeof(gpuPoses[0]));
 if(!error)error=cuMemcpyHtoD(deviceIndices,indices.data(),indices.size()*sizeof(indices[0]));
 if(!error&&!stage->readRigidBodyData(reinterpret_cast<void*>(devicePoses),reinterpret_cast<const PxRigidDynamicGPUIndex*>(deviceIndices),PxRigidDynamicGPUAPIReadType::eGLOBAL_POSE,indices.size()))error=5;
 if(!error)error=cuCtxSynchronize();
 if(!error)error=cuMemcpyDtoH(gpuPoses.data(),devicePoses,gpuPoses.size()*sizeof(gpuPoses[0]));
 if(deviceIndices)cuMemFree(deviceIndices);
 if(devicePoses)cuMemFree(devicePoses);
 cuda->releaseContext();if(error)return error;
 std::unordered_map<PxRigidDynamicGPUIndex,PxTransform> gpu;for(unsigned i=0;i<indices.size();++i)gpu.emplace(indices[i],gpuPoses[i]);
 out<<"{\"tick\":"<<tick<<",\"shapes\":[";bool comma=false;
 for(auto* shape:tracked){auto* b=shape->getActor()->is<PxRigidDynamic>();
   auto pose=PxShapeExt::getGlobalPose(*shape,*b);auto center=pose.p;auto gpuCenter=(gpu.at(b->getGPUIndex())*shape->getLocalPose()).p;
   const auto bounds=PxShapeExt::getWorldBounds(*shape,*b,1.0f);
   if(comma)out<<",";
   comma=true;
   out<<"["<<stage->getShapeContactIndex(*shape)<<","<<b->getGPUIndex()<<","<<unsigned(b->getRigidBodyFlags().isSet(PxRigidBodyFlag::eKINEMATIC))<<","<<center.x<<","<<center.y<<","<<center.z<<","<<bounds.minimum.x<<","<<bounds.minimum.y<<","<<bounds.minimum.z<<","<<bounds.maximum.x<<","<<bounds.maximum.y<<","<<bounds.maximum.z<<","<<gpuCenter.x<<","<<gpuCenter.y<<","<<gpuCenter.z<<"]";
 }
 out<<"]}\n";return 0;
}

// Explicit diagnostic control, never enabled by default or on the public scene.
// Re-request contact filtering only when an existing shape changes rigid owner.
extern "C" unsigned town_kit_refilter_migrated(std::uintptr_t ptr,unsigned tick){
 using namespace physx;auto& scene=*reinterpret_cast<PxScene*>(ptr);
 static std::vector<PxShape*> shapes;static std::vector<PxRigidActor*> owners;
 if(tick==0){shapes.clear();owners.clear();std::vector<PxActor*> actors(scene.getNbActors(PxActorTypeFlag::eRIGID_DYNAMIC));scene.getActors(PxActorTypeFlag::eRIGID_DYNAMIC,actors.data(),actors.size());
  for(auto* a:actors){auto* b=a->is<PxRigidDynamic>();std::vector<PxShape*> found(b->getNbShapes());b->getShapes(found.data(),found.size());for(auto* s:found)if(s->getSimulationFilterData().word3&0x80000000u){shapes.push_back(s);owners.push_back(b);}}
  return 0;
 }
 unsigned changed=0;
 for(unsigned i=0;i<shapes.size();++i){auto* owner=shapes[i]->getActor();if(owner&&owner!=owners[i]){if(!scene.resetFiltering(*owner,&shapes[i],1))return ~0u;owners[i]=owner;++changed;}}
 return changed;
}

// Diagnostic numerical accuracy control, applied once before intact observation.
extern "C" unsigned town_kit_contact_iterations(std::uintptr_t ptr,unsigned position,unsigned velocity){
 using namespace physx;if(position<1||position>255||velocity<1||velocity>255)return 1;
 auto& scene=*reinterpret_cast<PxScene*>(ptr);std::vector<PxActor*> actors(scene.getNbActors(PxActorTypeFlag::eRIGID_DYNAMIC));scene.getActors(PxActorTypeFlag::eRIGID_DYNAMIC,actors.data(),actors.size());
 for(auto* a:actors)a->is<PxRigidDynamic>()->setSolverIterationCounts(position,velocity);
 return 0;
}

// Last accepted stress evaluation's contact loads, not an injected impact.
extern "C" unsigned town_kit_surface_snapshot(std::uintptr_t ptr,const char* path,unsigned tick,unsigned count){
 using namespace physx;auto& scene=*reinterpret_cast<PxScene*>(ptr);auto* stage=scene.getDestructionScene();auto* cuda=scene.getCudaContextManager();if(!stage||!cuda)return 1;
 const auto view=stage->getDeviceView();if(!view.surfaceLoads)return 2;
 std::vector<PxDestructionSurfaceLoad> loads(count);cuda->acquireContext();unsigned error=0;
 if(view.readyEvent)error=cuEventSynchronize(view.readyEvent);
 if(!error)error=cuMemcpyDtoH(loads.data(),reinterpret_cast<CUdeviceptr>(view.surfaceLoads),count*sizeof(loads[0]));
 cuda->releaseContext();if(error)return error;
 std::ofstream out(path,std::ios::app);if(!out)return 3;out<<std::setprecision(9)<<"{\"tick\":"<<tick<<",\"loads\":[";bool comma=false;
 for(unsigned i=0;i<count;++i){const auto& v=loads[i];if(v.force.magnitudeSquared()<1)continue;if(comma)out<<",";comma=true;out<<"["<<i<<","<<v.force.x<<","<<v.force.y<<","<<v.force.z<<","<<v.torque.x<<","<<v.torque.y<<","<<v.torque.z<<"]";}
 out<<"]}\n";return 0;
}

// Read-only production-setting check, including newly allocated fragments.
extern "C" unsigned town_kit_check_contact_iterations(std::uintptr_t ptr,unsigned position,unsigned velocity){
 using namespace physx;auto& scene=*reinterpret_cast<PxScene*>(ptr);
 std::vector<PxActor*> actors(scene.getNbActors(PxActorTypeFlag::eRIGID_DYNAMIC));
 scene.getActors(PxActorTypeFlag::eRIGID_DYNAMIC,actors.data(),actors.size());
 unsigned mismatches=0;
 for(auto* a:actors){PxU32 p,v;a->is<PxRigidDynamic>()->getSolverIterationCounts(p,v);if(p!=position||v!=velocity)++mismatches;}
 return mismatches;
}

// Chunk shapes captured before impact; their actor pointer follows each split.
static std::vector<physx::PxShape*>& town_kit_chunk_shapes(){static std::vector<physx::PxShape*> shapes;return shapes;}

// Read-only rest-state audit: the terms the GPU sleep check uses (wake counter,
// per-body sleep/freeze thresholds, velocities) for every dynamic actor, so a
// whole island that never sleeps can be traced to the member that keeps it up.
extern "C" unsigned town_kit_sleep_snapshot(std::uintptr_t ptr,const char* path,unsigned tick){
 using namespace physx;if(!ptr||!path)return 1;
 auto& scene=*reinterpret_cast<PxScene*>(ptr);
 std::ofstream out(path,std::ios::app);if(!out)return 3;out<<std::setprecision(9);
 // Stage-split fragments are not in the scene's actor list; reach every body
 // through the chunk shapes, whose actor pointer follows each split.
 static std::vector<PxShape*>& tracked=town_kit_chunk_shapes();
 if(tick==0){
  tracked.clear();std::vector<PxActor*> initial(scene.getNbActors(PxActorTypeFlag::eRIGID_DYNAMIC));
  scene.getActors(PxActorTypeFlag::eRIGID_DYNAMIC,initial.data(),initial.size());
  for(auto* a:initial){auto* body=a->is<PxRigidDynamic>();std::vector<PxShape*> shapes(body->getNbShapes());body->getShapes(shapes.data(),shapes.size());
   for(auto* shape:shapes)if(shape->getSimulationFilterData().word3&0x80000000u)tracked.push_back(shape);
  }
 }
 std::vector<PxRigidActor*> actors;std::unordered_set<PxRigidActor*> seen;
 for(auto* shape:tracked){auto* actor=shape->getActor();if(!actor)return 6;if(seen.insert(actor).second)actors.push_back(actor);}
 out<<"{\"tick\":"<<tick<<",\"bodies\":[";bool comma=false;
 for(auto* a:actors){auto* b=a->is<PxRigidDynamic>();if(!b||!b->userData)continue;
  const auto entity=static_cast<std::uint64_t>(reinterpret_cast<std::uintptr_t>(b->userData))-1u;
  const bool kinematic=b->getRigidBodyFlags().isSet(PxRigidBodyFlag::eKINEMATIC);
  const auto v=b->getLinearVelocity(),w=b->getAngularVelocity(),inertia=b->getMassSpaceInertiaTensor();const auto pose=b->getGlobalPose();
  if(comma)out<<",";comma=true;
  out<<"{\"id\":"<<entity<<",\"gpu\":"<<b->getGPUIndex()<<",\"kinematic\":"<<unsigned(kinematic)<<",\"sleeping\":"<<unsigned(b->isSleeping())
     <<",\"wakeCounter\":"<<b->getWakeCounter()<<",\"sleepThreshold\":"<<b->getSleepThreshold()<<",\"freezeThreshold\":"<<b->getStabilizationThreshold()
     <<",\"mass\":"<<b->getMass()<<",\"inertia\":["<<inertia.x<<","<<inertia.y<<","<<inertia.z<<"],\"shapes\":"<<b->getNbShapes()
     <<",\"v\":["<<v.x<<","<<v.y<<","<<v.z<<"],\"w\":["<<w.x<<","<<w.y<<","<<w.z<<"],\"p\":["<<pose.p.x<<","<<pose.p.y<<","<<pose.p.z<<"],\"q\":["<<pose.q.x<<","<<pose.q.y<<","<<pose.q.z<<","<<pose.q.w<<"]}";
 }
 out<<"]}\n";return 0;
}

// Diagnostic probe, never on the public scene: wake every awake, non-kinematic
// body that reports motion, and list them. A body the CPU calls awake but the
// GPU is not integrating starts moving again only if this re-registers it.
extern "C" unsigned town_kit_wake_probe(std::uintptr_t ptr,const char* path,unsigned tick,float speed){
 using namespace physx;if(!ptr||!path)return 1;
 auto& scene=*reinterpret_cast<PxScene*>(ptr);
 std::ofstream out(path,std::ios::app);if(!out)return 3;out<<std::setprecision(9);
 const auto& shapes=town_kit_chunk_shapes();if(shapes.empty())return 7;
 std::unordered_set<PxRigidActor*> seen;out<<"{\"tick\":"<<tick<<",\"woken\":[";bool comma=false;
 for(auto* shape:shapes){auto* actor=shape->getActor();if(!actor||!seen.insert(actor).second)continue;auto* b=actor->is<PxRigidDynamic>();if(!b||!b->userData)continue;
  if(b->getRigidBodyFlags().isSet(PxRigidBodyFlag::eKINEMATIC)||b->isSleeping())continue;
  if(b->getLinearVelocity().magnitude()<speed&&b->getAngularVelocity().magnitude()<speed*10)continue;
  b->wakeUp();if(comma)out<<",";comma=true;out<<(static_cast<std::uint64_t>(reinterpret_cast<std::uintptr_t>(b->userData))-1u);
 }
 out<<"]}\n";return 0;
}
