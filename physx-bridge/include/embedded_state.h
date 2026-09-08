#pragma once
#include "vibe-land-physx-bridge/src/lib.rs.h"
#include "embedded_destruction.h"
#include "PxPhysicsAPI.h"
#include "PxDestructionScene.h"
#include "cuda.h"
#include <map>
#include <set>
#include <vector>
#include <stdexcept>
namespace vibe_land::physx_bridge {
inline void native_require(bool ok, const char* message) { if (!ok) throw std::runtime_error(message); }
inline physx::PxVec3 native_px(FfiVec3 v) { return {v.x,v.y,v.z}; }
inline FfiVec3 native_ffi(physx::PxVec3 v) { return {v.x,v.y,v.z}; }
inline FfiQuat native_ffi(physx::PxQuat q) { return {q.x,q.y,q.z,q.w}; }
inline std::uint32_t native_entity(std::uint32_t structure, std::uint32_t serial) {
    native_require(structure<64 && serial<(1u<<22), "embedded network identity exhausted");
    return 0x80000000u | (structure<<22) | serial;
}
struct DestructionManager::State {
    physx::PxPhysics& physics;
    physx::PxScene& scene;
    physx::PxMaterial& material;
    bool configured=false;
    std::uint32_t iterations=0;
    std::uint64_t splits=0, observedFrame=0, corrections=0;
    physx::PxDestructionStageStatus last{};
    struct Chunk {
        physx::PxShape* shape;
        std::uint32_t structure, authored, serial=0;
    };
    struct Body {
        physx::PxRigidDynamic* actor;
        std::uint32_t structure, serial;
        std::vector<std::uint32_t> chunks;
    };
    std::vector<Chunk> chunks;
    std::vector<physx::PxRigidDynamic*> parents;
    std::vector<physx::PxDestructionStressChunk> nodes;
    std::vector<physx::PxDestructionChunkMassProperties> properties;
    std::vector<physx::PxDestructionStressBond> bonds;
    std::vector<std::pair<std::uint32_t,std::uint32_t>> bondIds;
    std::vector<physx::PxDestructionStressCluster> clusters;
    std::vector<physx::PxDestructionMaterial> materials;
    std::vector<float> health;
    std::map<std::uint32_t,std::uint32_t> nextSerial;
    // Root+generation tracks GPU identity, never recycled actor addresses.
    std::map<std::pair<std::uint32_t,std::uint64_t>,Body> bodies;
    rust::Vec<FfiBrokenBondEvent> broken;
    rust::Vec<FfiChunkMigrationEvent> migrations;
    rust::Vec<FfiIslandBodyEvent> events;
    mutable std::vector<FfiChunkBodySnapshot> snapshots;
    State(physx::PxPhysics& p,physx::PxScene& s,physx::PxMaterial& m):physics(p),scene(s),material(m) {}
    void observe_topology();
    void refresh_snapshots() const;
};
// Explicit CPU gameplay observations only; never used to decide fracture.
struct NativeReadback {
    physx::PxCudaContextManager& cuda;
    NativeReadback(physx::PxScene& scene, CUevent ready):cuda(*scene.getCudaContextManager()) {
        cuda.acquireContext();
        if (ready && cuEventSynchronize(ready)!=CUDA_SUCCESS) {
            cuda.releaseContext(); throw std::runtime_error("embedded observation event failed");
        }
    }
    ~NativeReadback() { cuda.releaseContext(); }
    template<class T> std::vector<T> read(const T* ptr, std::size_t count) const {
        std::vector<T> out(count);
        native_require(!count || (ptr && cuMemcpyDtoH(out.data(),reinterpret_cast<CUdeviceptr>(ptr),count*sizeof(T))==CUDA_SUCCESS),
            "embedded observation readback failed");
        return out;
    }
};
}
