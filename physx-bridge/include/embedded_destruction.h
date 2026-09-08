#pragma once
#include "rust/cxx.h"
#include <cstdint>
#include <functional>
#include <memory>
namespace physx { class PxPhysics; class PxScene; class PxMaterial; class PxShape; class PxActor; }
namespace vibe_land::physx_bridge {
struct FfiPose; struct FfiVec3; struct FfiDestructibleSettings;
struct FfiChunkNodeDesc; struct FfiChunkBondDesc; struct FfiBrokenBondEvent;
struct FfiChunkMigrationEvent; struct FfiIslandBodyEvent; struct FfiChunkBodySnapshot;
struct FfiSupportSet; struct FfiSupportRow; struct FfiBondStressRow; struct FfiDestructionStats;
// Game observation/identity adapter. All physical advancement belongs to PxScene.
class DestructionManager final {
public:
    DestructionManager(physx::PxPhysics&, physx::PxScene&, physx::PxMaterial&, float);
    ~DestructionManager();
    void create_destructible(std::uint32_t, const FfiPose&,
        rust::Slice<const FfiChunkNodeDesc>, rust::Slice<const FfiChunkBondDesc>,
        const FfiDestructibleSettings&, std::uint32_t, std::uint32_t);
    void prepare_scene();
    void clear_destructibles();
    void destruction_tick(float, FfiVec3);
    void queue_chunk_damage(std::uint32_t, std::uint32_t, FfiVec3, FfiVec3);
    std::uint32_t apply_destruction_explosion(FfiVec3, float, float);
    std::uint32_t apply_destruction_blast(FfiVec3, FfiVec3, float, float, float);
    rust::Vec<FfiBrokenBondEvent> take_broken_bonds();
    rust::Vec<FfiChunkMigrationEvent> take_chunk_migrations();
    rust::Vec<FfiIslandBodyEvent> take_island_events();
    rust::Slice<const FfiChunkBodySnapshot> chunk_body_snapshots() const;
    void sleep_chunk_body(std::uint32_t);
    std::uint32_t freeze_chunk_bodies(rust::Slice<const std::uint32_t>);
    std::uint32_t unfreeze_chunk_bodies(rust::Slice<const std::uint32_t>);
    rust::Vec<std::uint32_t> take_frozen_contact_wakes();
    rust::Vec<FfiSupportSet> take_support_sets();
    rust::Vec<FfiSupportRow> take_support_rows();
    rust::Vec<FfiBondStressRow> bond_stress_rows(std::uint32_t) const;
    FfiDestructionStats destruction_stats() const;
    bool validate_destruction_mappings() const;
    std::uint64_t split_count() const;
    bool resim_needed() const { return false; }
    std::uint32_t resim_capture();
    bool resim_restore();
    // Ordinary actors retain application contact callbacks. Native chunks do
    // not export contacts; these compatibility hooks never feed another solver.
    struct Slot;
    struct ContactTarget {
        Slot* slot=nullptr; physx::PxShape* shape=nullptr;
        std::uint32_t structure_id=0, node_index=0, blast_node=0xffffffffu;
        explicit operator bool() const { return false; }
    };
    ContactTarget resolve_contact_target(physx::PxShape*) { return {}; }
    bool target_is_bondless(const ContactTarget&) const { return false; }
    bool queue_contact_at(const ContactTarget&, FfiVec3, FfiVec3, bool);
    void route_contact_shape(physx::PxShape*, FfiVec3, FfiVec3, bool);
    template<class... Args> void note_pair_load(Args&&...) {}
    template<class... Args> void note_contact_pair(Args&&...) {}
    void note_bondless_skipped(std::uint32_t) {}
    bool has_frozen_bodies() const { return false; }
    bool entity_is_frozen(std::uint32_t) const { return false; }
    unsigned pool_parallelism() const { return 1; }
    void run_parallel(std::size_t n, const std::function<void(std::size_t)>& f) {
        for (std::size_t i=0;i<n;++i) f(i);
    }
private:
    struct State;
    std::unique_ptr<State> state_;
};
}
