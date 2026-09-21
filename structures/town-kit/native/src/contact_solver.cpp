#include "PxPhysicsAPI.h"
#include <cstdint>
#include <vector>

struct TownKitContactSettings {
    std::uint32_t actors, positionMin, positionMax, velocityMin, velocityMax, shapes;
    float contactMin, contactMax;
};
// Called once, before the first simulation step, on the harness-owned scene.
// Released native destruction bodies inherit these physical actor settings.
extern "C" std::uint32_t town_kit_contact_settings(
    std::uintptr_t sceneAddress, std::uint32_t position, std::uint32_t velocity, float contactOffset,
    TownKitContactSettings* result) {
    if (!sceneAddress || !result || position > 255 || velocity > 255) return 0;
    auto& scene = *reinterpret_cast<physx::PxScene*>(sceneAddress);
    const auto flags = physx::PxActorTypeFlag::eRIGID_DYNAMIC | physx::PxActorTypeFlag::eRIGID_STATIC;
    std::vector<physx::PxActor*> actors(scene.getNbActors(flags));
    scene.getActors(flags, actors.data(), static_cast<physx::PxU32>(actors.size()));
    *result = {0, 255, 0, 255, 0, 0, 1000.0f, 0.0f};
    for (auto* actor : actors) {
        auto* rigid=static_cast<physx::PxRigidActor*>(actor);
        std::vector<physx::PxShape*> shapes(rigid->getNbShapes());rigid->getShapes(shapes.data(),static_cast<physx::PxU32>(shapes.size()));
        for(auto* shape:shapes){
            if(contactOffset>0.0f){if(contactOffset<=shape->getRestOffset())return 0;shape->setContactOffset(contactOffset);}
            result->shapes++;result->contactMin=physx::PxMin(result->contactMin,shape->getContactOffset());result->contactMax=physx::PxMax(result->contactMax,shape->getContactOffset());
        }
        auto* body = actor->is<physx::PxRigidDynamic>();if(!body)continue;
        result->actors++;
        if (position) body->setSolverIterationCounts(position, velocity);
        physx::PxU32 p=0,v=0; body->getSolverIterationCounts(p,v);
        result->positionMin = physx::PxMin(result->positionMin,p);
        result->positionMax = physx::PxMax(result->positionMax,p);
        result->velocityMin = physx::PxMin(result->velocityMin,v);
        result->velocityMax = physx::PxMax(result->velocityMax,v);
    }
    return actors.empty() ? 0 : 1;
}
