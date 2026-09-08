#include "embedded_state.h"
#include "extensions/PxMassProperties.h"
#include <algorithm>
#include <cmath>
#include <numeric>
using namespace physx;
namespace vibe_land::physx_bridge {
DestructionManager::DestructionManager(PxPhysics& p,PxScene& s,PxMaterial& m,float)
    :state_(new State(p,s,m)) {
    native_require(!s.getFlags().isSet(PxSceneFlag::eENABLE_DIRECT_GPU_API),
        "embedded gameplay requires ordinary actor access; disable Direct GPU API");
    native_require(s.getDestructionScene(), "PhysX embedded destruction runtime unavailable");
}
DestructionManager::~DestructionManager() { clear_destructibles(); }
void DestructionManager::clear_destructibles() {
    auto& s=*state_;
    native_require(s.scene.getDestructionScene()->clearStress(), "cannot clear active native destruction");
    // The scene owns fragments; clearStress destroys them. Original parents and
    // our geometry references remain ours, including parents whose shapes moved.
    for(auto* p:s.parents) p->release();
    for(auto& c:s.chunks) if(c.shape) c.shape->release();
    auto& p=s.physics;auto& scene=s.scene;auto& m=s.material;
    state_.reset(new State(p,scene,m));
}
void DestructionManager::create_destructible(std::uint32_t structure,const FfiPose& pose,
    rust::Slice<const FfiChunkNodeDesc> nodes,rust::Slice<const FfiChunkBondDesc> bonds,
    const FfiDestructibleSettings& settings,std::uint32_t group,std::uint32_t mask) {
    auto& s=*state_;
    native_require(!s.configured,"runtime asset insertion requires a native topology transaction; rebuild the city first");
    native_require(structure<64 && !s.nextSerial.count(structure),"duplicate or invalid structure identity");
    native_require(nodes.size()>0 && nodes.size()<=65536 && settings.materials.size()>0,"invalid embedded asset");
    const auto base=static_cast<PxU32>(s.nodes.size()),materialBase=static_cast<PxU32>(s.materials.size());
    for(const auto& m:settings.materials) {
        PxDestructionMaterial out;
        // Preserve the existing bridge contract: resolved runtime strengths are Pa.
        out.compressionElasticLimit=m.compression_elastic;
        out.compressionFatalLimit=m.compression_fatal;
        out.tensionElasticLimit=m.tension_elastic<0?-1:m.tension_elastic;
        out.tensionFatalLimit=m.tension_fatal<0?-1:m.tension_fatal;
        out.shearElasticLimit=m.shear_elastic<0?-1:m.shear_elastic;
        out.shearFatalLimit=m.shear_fatal<0?-1:m.shear_fatal;
        out.residualAreaFraction=m.residual_area_fraction;
        s.materials.push_back(out);
    }
    std::vector<PxU32> roots(nodes.size());std::iota(roots.begin(),roots.end(),0);
    auto root=[&](PxU32 v){while(roots[v]!=v){roots[v]=roots[roots[v]];v=roots[v];}return v;};
    for(const auto& b:bonds) {
        native_require(b.node0<nodes.size() && b.node1<nodes.size() && b.node0!=b.node1 &&
            b.material<settings.materials.size() && b.area>0 && b.bond_index<(1u<<20),"invalid authored bond");
        const auto a=root(b.node0),c=root(b.node1);roots[std::max(a,c)]=std::min(a,c);
    }
    std::map<PxU32,std::vector<PxU32>> components;
    for(PxU32 i=0;i<nodes.size();++i) components[root(i)].push_back(i);
    std::vector<PxU32> owners(nodes.size());
    s.nextSerial[structure]=1;
    double dynamicMass=0,dynamicVolume=0;
    for(const auto& n:nodes) if(n.mass>0 && n.volume>0){dynamicMass+=n.mass;dynamicVolume+=n.volume;}
    native_require(dynamicVolume>0,"asset needs authored physical density for supported chunks");
    const float density=static_cast<float>(dynamicMass/dynamicVolume);
    for(const auto& component:components) {
        auto* actor=s.physics.createRigidDynamic(PxTransform(native_px(pose.position),
            PxQuat(pose.rotation.x,pose.rotation.y,pose.rotation.z,pose.rotation.w)));
        native_require(actor,"native parent allocation failed");
        s.parents.push_back(actor);
        const PxU32 cluster=static_cast<PxU32>(s.clusters.size());
        bool supported=false;std::vector<float> masses;
        for(auto i:component.second) {
            const auto& n=nodes[i];native_require(n.node_index==i && n.volume>0,"nodes must have contiguous authored identities and positive volume");
            PxShape* shape=nullptr;
            if(n.geom_kind==0) shape=s.physics.createShape(PxBoxGeometry(native_px(n.half_extents)),s.material,true);
            else if(n.geom_kind==1) {
                std::vector<PxVec3> points;for(const auto& p:n.convex_points)points.push_back(native_px(p));
                PxConvexMeshDesc desc;desc.points.count=PxU32(points.size());desc.points.stride=sizeof(PxVec3);desc.points.data=points.data();
                desc.flags=PxConvexFlag::eCOMPUTE_CONVEX;desc.vertexLimit=64;
                PxCookingParams params(s.physics.getTolerancesScale());params.buildGPUData=true;
                auto* mesh=PxCreateConvexMesh(params,desc,s.physics.getPhysicsInsertionCallback());
                native_require(mesh,"native convex cooking failed");
                shape=s.physics.createShape(PxConvexMeshGeometry(mesh),s.material,true);mesh->release();
            }
            native_require(shape,"invalid or failed chunk geometry");
            shape->setLocalPose(PxTransform(native_px(n.centroid)));
            shape->setSimulationFilterData(PxFilterData(group,mask,native_entity(structure,0),1u<<31));
            shape->setQueryFilterData(PxFilterData(group,native_entity(structure,0),0,0));
            native_require(actor->attachShape(*shape),"persistent shape attach failed");
            owners[i]=cluster;supported|=n.mass==0;
            const float mass=n.mass>0?n.mass:density*n.volume;masses.push_back(mass);
            PxMassProperties props(shape->getGeometry());props=props*(mass/props.mass);
            const auto center=native_px(n.centroid)+props.centerOfMass;
            PxDestructionChunkMassProperties p{};p.mass=mass;p.supported=n.mass==0;
            for(unsigned k=0;k<3;++k){p.center[k]=center[k];p.inertia[k]=props.inertiaTensor[k][k];}
            p.inertia[3]=props.inertiaTensor[1][0];p.inertia[4]=props.inertiaTensor[2][0];p.inertia[5]=props.inertiaTensor[2][1];
            // Store in authored order even when graph components are interleaved.
            if(s.chunks.size()<base+nodes.size()) {s.chunks.resize(base+nodes.size());s.nodes.resize(base+nodes.size());s.properties.resize(base+nodes.size());}
            s.chunks[base+i]={shape,structure,i,0};s.properties[base+i]=p;
            const float scalar=(props.inertiaTensor[0][0]+props.inertiaTensor[1][1]+props.inertiaTensor[2][2])/3;
            s.nodes[base+i]={center,n.mass,n.mass>0?scalar:0,cluster,PX_INVALID_U32,n.volume,materialBase};
        }
        native_require(PxRigidBodyExt::setMassAndUpdateInertia(*actor,masses.data(),PxU32(masses.size())),"parent mass/inertia failed");
        actor->setRigidBodyFlag(PxRigidBodyFlag::eKINEMATIC,supported);
        actor->setLinearDamping(settings.linear_damping);actor->setAngularDamping(settings.angular_damping);
        actor->userData=reinterpret_cast<void*>(std::uintptr_t(native_entity(structure,0))+1);
        s.scene.addActor(*actor);s.clusters.push_back({actor->getGPUIndex(),actor->getCMassLocalPose().p});
    }
    const auto bondBase=s.bonds.size(); double logWeight=0;
    for(const auto& b:bonds) {
        const auto normal=native_px(b.normal)*(b.node0<b.node1?1.f:-1.f);
        native_require(normal.isFinite() && normal.magnitudeSquared()>1e-8f,"invalid bond normal");
        const auto distance=(s.nodes[base+b.node0].position-s.nodes[base+b.node1].position).magnitude();
        const float modulus=settings.materials[b.material].elastic_modulus;
        const float weight=std::sqrt((modulus>0?modulus/30e9f:1.f)*std::max(b.area,1e-4f)/std::max(distance,.05f));
        logWeight+=std::log(weight);
        s.bonds.push_back({base+std::min(b.node0,b.node1),base+std::max(b.node0,b.node1),native_px(b.centroid),normal.getNormalized(),b.area,1,weight,materialBase+b.material});
        s.bondIds.emplace_back(structure,b.bond_index);
    }
    if(!bonds.empty()) {
        const float mean=std::exp(float(logWeight/bonds.size()));
        for(auto i=bondBase;i<s.bonds.size();++i)s.bonds[i].complianceScale/=mean;
    }
    s.iterations=std::max(s.iterations,settings.max_solver_iterations_per_frame);
}
void DestructionManager::prepare_scene() {
    auto& s=*state_;if(s.configured || s.nodes.empty())return;
    auto* api=s.scene.getDestructionScene();
    for(PxU32 i=0;i<s.nodes.size();++i) {
        s.nodes[i].contactIndex=api->getShapeContactIndex(*s.chunks[i].shape);
        native_require(s.nodes[i].contactIndex!=PX_INVALID_U32,"chunk contact identity not allocated before first step");
    }
    for(PxU32 i=0;i<s.parents.size();++i) s.clusters[i].body=s.parents[i]->getGPUIndex();
    PxDestructionStressDesc desc;desc.chunks=s.nodes.data();desc.chunkCount=PxU32(s.nodes.size());
    desc.bonds=s.bonds.data();desc.bondCount=PxU32(s.bonds.size());desc.clusters=s.clusters.data();desc.clusterCount=PxU32(s.clusters.size());
    desc.chunkMassProperties=s.properties.data();desc.materials=s.materials.data();desc.materialCount=PxU32(s.materials.size());
    desc.maxIterations=s.iterations;desc.tolerance=1e-5f;desc.internalCorrectionLimit=1;desc.preserveUnchangedContactPairs=true;
    native_require(api->configureStress(desc),"native destruction configuration failed");
    s.configured=true;s.health.assign(s.bonds.size(),1);
    std::fprintf(stderr,"[embedded-destruction] chunks=%zu bonds=%zu initial_clusters=%zu direct_gpu=0 native_sleep=1 correction_limit=1 max_stress_passes=2 iterations=%u\n",s.nodes.size(),s.bonds.size(),s.clusters.size(),s.iterations);
}
void DestructionManager::destruction_tick(float,FfiVec3) {
    auto& s=*state_;if(!s.configured)return;
    s.last=s.scene.getDestructionScene()->getLastStatus();
    native_require(!s.last.error,"native destruction step incomplete; refusing gameplay publication");
    if(s.last.frame==s.observedFrame)return;
    if(!s.observedFrame || s.last.brokenBonds) s.observe_topology();
    s.corrections+=s.last.correctionPasses;
    s.observedFrame=s.last.frame;s.refresh_snapshots();
}
void DestructionManager::queue_chunk_damage(std::uint32_t,std::uint32_t,FfiVec3,FfiVec3) { throw std::runtime_error("native destruction requires a physical contact; synthetic chunk loads are not implemented"); }
std::uint32_t DestructionManager::apply_destruction_explosion(FfiVec3,float,float) {throw std::runtime_error("native explosion commands are not implemented");}
std::uint32_t DestructionManager::apply_destruction_blast(FfiVec3,FfiVec3,float,float,float) {throw std::runtime_error("native blast commands are not implemented; use physical projectiles");}
bool DestructionManager::queue_contact_at(const ContactTarget&,FfiVec3,FfiVec3,bool) {return false;}
void DestructionManager::route_contact_shape(PxShape*,FfiVec3,FfiVec3,bool) {}
std::uint32_t DestructionManager::resim_capture() {throw std::runtime_error("native correction is owned by PxScene");}
bool DestructionManager::resim_restore() {throw std::runtime_error("native correction is owned by PxScene");}
}
