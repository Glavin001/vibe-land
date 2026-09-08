#include "embedded_state.h"
#include <algorithm>
using namespace physx;
namespace vibe_land::physx_bridge {
void DestructionManager::State::observe_topology() {
    const auto view=scene.getDestructionScene()->getDeviceView();
    NativeReadback read(scene,view.readyEvent);
    const auto& changes=view.committedChanges;
    native_require(changes.status,"native committed-change publication missing");
    const auto status=read.read(changes.status,1).front();
    native_require(!status.error && status.frame==last.frame,"invalid or stale committed changes");
    native_require(status.chunkCount<=changes.chunkCapacity && status.bondCount<=changes.bondCapacity,"committed changes overflow");
    native_require(observedFrame || status.fullSnapshot,"missing initial committed snapshot");
    const auto changed=read.read(changes.chunks,status.chunkCount);
    const auto brokenIndices=read.read(changes.brokenBonds,status.bondCount);
    observedChunks=status.chunkCount;observedBonds=status.bondCount;stressIslandCount=status.stressIslandCount;
    observationBytes=sizeof(status)+changed.size()*sizeof(changed[0])+brokenIndices.size()*sizeof(brokenIndices[0]);
    using Key=std::pair<std::uint32_t,std::uint64_t>;
    std::map<Key,std::vector<std::uint32_t>> groups;
    std::set<Key> affected;
    std::uint32_t previous=PX_INVALID_U32;
    for(const auto& row:changed) {
        native_require(row.chunk<chunks.size() && row.root<chunks.size() && row.active,"invalid native changed chunk");
        native_require(previous==PX_INVALID_U32 || previous<row.chunk,"duplicate/unordered native changed chunk");previous=row.chunk;
        auto& chunk=chunks[row.chunk];
        if(chunk.root!=PX_INVALID_U32)affected.emplace(chunk.root,chunk.generation);
        groups[{row.root,row.generation}].push_back(row.chunk);
    }
    decltype(bodies) next;
    for(auto& group:groups) {
        const auto key=group.first;
        auto* actor=chunks[group.second.front()].shape->getActor()->is<PxRigidDynamic>();
        native_require(actor,"committed chunk lacks native actor");
        const bool supported=actor->getRigidBodyFlags().isSet(PxRigidBodyFlag::eKINEMATIC);
        const auto structure=chunks[group.second.front()].structure;
        auto old=bodies.find(key);
        std::uint32_t serial=old==bodies.end()?0:old->second.serial;
        bool promoted=false;
        if(!supported && !serial){serial=nextSerial.at(structure)++;promoted=true;++splits;}
        // Membership changes alter the COM coordinate frame used by the wire.
        // Republish that group's definition, preserving its stable identity.
        promoted|=!supported && old!=bodies.end() && old->second.chunks!=group.second;
        const auto entity=native_entity(structure,serial);
        actor->userData=reinterpret_cast<void*>(std::uintptr_t(entity)+1);
        FfiIslandBodyEvent event{};
        if(promoted) {
            const auto pose=actor->getGlobalPose();
            event.structure_id=structure;event.island_id=serial;event.kind=0;event.mass=actor->getMass();
            event.position=native_ffi(pose.transform(actor->getCMassLocalPose().p));
            event.rotation=native_ffi(pose.q);event.linear_velocity=native_ffi(actor->getLinearVelocity());
            event.angular_velocity=native_ffi(actor->getAngularVelocity());
        }
        for(auto id:group.second) {
            auto& chunk=chunks[id];
            native_require(chunk.structure==structure && chunk.shape->getActor()==actor,"GPU ownership and CPU collision mirror disagree");
            const auto packed=(structure<<16)|chunk.authored;
            if(chunk.serial!=serial) migrations.push_back({structure,packed,chunk.serial,serial});
            const bool queryChanged=chunk.root==PX_INVALID_U32 || chunk.serial!=serial;
            chunk.serial=serial;chunk.root=key.first;chunk.generation=key.second;
            // Query identities are observations, not simulation filtering edits.
            // Refiltering here would invalidate the engine's reused contact pairs.
            if(queryChanged){auto filter=chunk.shape->getQueryFilterData();filter.word1=entity;chunk.shape->setQueryFilterData(filter);}
            if(promoted) event.chunk_ids.push_back(packed);
        }
        if(promoted) events.push_back(std::move(event));
        next.emplace(key,Body{actor,structure,serial,std::move(group.second)});
    }
    // Only affected old groups retire. Unrelated topology and sleeping groups
    // remain in place; GPU publication supplied the complete changed membership.
    for(const auto& key:affected) {
        const auto old=bodies.find(key);native_require(old!=bodies.end(),"missing old committed group");
        if(old->second.serial && !next.count(key)) {
            FfiIslandBodyEvent event{};event.structure_id=old->second.structure;event.island_id=old->second.serial;event.kind=1;
            events.push_back(std::move(event));
        }
        bodies.erase(old);
    }
    bodies.merge(next);
    native_require(next.empty() && bodies.size()==status.clusterCount,"committed GPU/CPU group count mismatch");
    previous=PX_INVALID_U32;
    for(const auto index:brokenIndices) {
        native_require(index<bondIds.size() && (previous==PX_INVALID_U32 || previous<index),"invalid duplicate/unordered broken bond");previous=index;
        const auto id=bondIds[index];broken.push_back({id.first,(id.first<<20)|id.second});
    }
    brokenCount+=std::uint32_t(brokenIndices.size());

}
void DestructionManager::State::refresh_snapshots() const {
    snapshots.clear();snapshots.reserve(bodies.size());
    for(const auto& entry:bodies) {
        const auto& b=entry.second;auto& actor=*b.actor;
        if(actor.getRigidBodyFlags().isSet(PxRigidBodyFlag::eKINEMATIC))continue;
        const auto pose=actor.getGlobalPose();
        FfiChunkBodySnapshot snap{};
        snap.entity_id=native_entity(b.structure,b.serial);snap.structure_id=b.structure;snap.island_id=b.serial;
        snap.position=native_ffi(pose.transform(actor.getCMassLocalPose().p));snap.rotation=native_ffi(pose.q);
        snap.linear_velocity=native_ffi(actor.getLinearVelocity());snap.angular_velocity=native_ffi(actor.getAngularVelocity());
        snap.sleeping=actor.isSleeping();snap.node_count=std::uint32_t(b.chunks.size());snapshots.push_back(snap);
    }
}
rust::Slice<const FfiChunkBodySnapshot> DestructionManager::chunk_body_snapshots() const {
    const auto& out=state_->snapshots;return {out.data(),out.size()};
}
rust::Vec<FfiBrokenBondEvent> DestructionManager::take_broken_bonds() {auto out=std::move(state_->broken);state_->broken={};return out;}
rust::Vec<FfiChunkMigrationEvent> DestructionManager::take_chunk_migrations() {auto out=std::move(state_->migrations);state_->migrations={};return out;}
rust::Vec<FfiIslandBodyEvent> DestructionManager::take_island_events() {auto out=std::move(state_->events);state_->events={};return out;}
void DestructionManager::sleep_chunk_body(std::uint32_t entity) {
    for(auto& entry:state_->bodies) {
        auto& b=entry.second;
        if(native_entity(b.structure,b.serial)==entity && !b.actor->getRigidBodyFlags().isSet(PxRigidBodyFlag::eKINEMATIC)) b.actor->putToSleep();
    }
}
std::uint32_t DestructionManager::freeze_chunk_bodies(rust::Slice<const std::uint32_t> ids) {
    native_require(ids.empty(),"artificial freezing is disabled in native destruction; use ordinary sleep");return 0;
}
std::uint32_t DestructionManager::unfreeze_chunk_bodies(rust::Slice<const std::uint32_t>) {return 0;}
rust::Vec<std::uint32_t> DestructionManager::take_frozen_contact_wakes() {return {};}
rust::Vec<FfiSupportSet> DestructionManager::take_support_sets() {return {};}
rust::Vec<FfiSupportRow> DestructionManager::take_support_rows() {return {};}
rust::Vec<FfiBondStressRow> DestructionManager::bond_stress_rows(std::uint32_t structure) const {
    auto& s=*state_;rust::Vec<FfiBondStressRow> out;if(!s.configured)return out;
    const auto view=s.scene.getDestructionScene()->getDeviceView();NativeReadback read(s.scene,view.readyEvent);
    const auto verdicts=read.read(view.bondVerdicts,s.bonds.size());
    for(std::size_t i=0;i<s.bonds.size();++i) if(s.bondIds[i].first==structure) {
        const auto& b=s.bonds[i];const auto& v=verdicts[i];const auto& m=s.materials[b.material];
        FfiBondStressRow row{};row.bond_index=s.bondIds[i].second;row.node0=s.chunks[b.chunk0].authored;row.node1=s.chunks[b.chunk1].authored;
        row.material=b.material-s.nodes[b.chunk0].material;row.area=b.area;
        row.compression=std::max(0.f,-v.stressNormal);row.tension=std::max(0.f,v.stressNormal);row.shear=v.stressShear;
        const float tension=m.tensionElasticLimit<0?m.compressionElasticLimit:m.tensionElasticLimit;
        const float shear=m.shearElasticLimit<0?m.compressionElasticLimit:m.shearElasticLimit;
        row.utilisation=std::max({row.compression/m.compressionElasticLimit,row.tension/tension,row.shear/shear});out.push_back(row);
    }return out;
}
FfiDestructionStats DestructionManager::destruction_stats() const {
    const auto& s=*state_;FfiDestructionStats out{};out.structures=s.nextSerial.size();out.gpu_stress_structures=out.structures;
    out.chunk_bodies=s.snapshots.size();for(const auto& b:s.snapshots)out.awake_chunk_bodies+=!b.sleeping;
    out.sleeping_chunk_bodies=out.chunk_bodies-out.awake_chunk_bodies;
    out.solver_island_count=s.stressIslandCount;
    out.contacts_processed=s.last.normalContacts;out.broken_bonds=s.brokenCount;
    auto count=[&](const char* name,double value){FfiNamedSpan span{};span.name=rust::String(name);span.value=value;span.kind=2;out.extra_spans.push_back(std::move(span));};
    count("native_corrections_total",s.corrections);count("native_clusters",s.bodies.size());
    count("native_embedded",1);count("native_correction_passes",s.last.correctionPasses);count("native_stress_passes",s.last.stressPasses);
    count("native_topology_observed_chunks",s.observedChunks);count("native_topology_observed_bonds",s.observedBonds);count("native_topology_observation_bytes",s.observationBytes);
    count("native_chunks",s.chunks.size());count("native_bonds",s.bonds.size());count("native_stress_iterations",s.last.iterations);
    return out;
}
std::uint64_t DestructionManager::split_count() const {return state_->splits;}
bool DestructionManager::validate_destruction_mappings() const {
    const auto& s=*state_;if(!s.configured || !s.observedFrame)return true;
    // Explicit heavy audit. The benchmark calls this outside its timer; normal
    // gameplay publication never reads these whole-world arrays.
    const auto view=s.scene.getDestructionScene()->getDeviceView();NativeReadback read(s.scene,view.readyEvent);
    const auto& topology=view.acceptedTopology;const auto status=read.read(topology.status,1).front();
    const auto roots=read.read(topology.chunkCluster,s.chunks.size());const auto slots=read.read(topology.clusterSlots,s.chunks.size());
    const auto generations=read.read(topology.slotGenerations,topology.slotCapacity);const auto health=read.read(view.bondHealth,s.bonds.size());
    if(status.clusterCount!=s.bodies.size() || std::count_if(health.begin(),health.end(),[](float v){return v<=0;})!=s.brokenCount)return false;
    std::size_t seen=0;
    for(const auto& item:s.bodies)for(auto id:item.second.chunks) {
        if(id>=s.chunks.size() || roots[id]!=item.first.first || slots[roots[id]]>=generations.size()
            || generations[slots[roots[id]]]!=item.first.second || s.chunks[id].shape->getActor()!=item.second.actor
            || s.chunks[id].serial!=item.second.serial)return false;
        ++seen;
    }
    if(seen!=s.chunks.size())return false;
    return true;
}
}
