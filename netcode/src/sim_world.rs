use nalgebra::{
    vector, DMatrix, Isometry3, Point3, Quaternion, Translation3, UnitQuaternion, Vector3,
};
use rapier3d::control::{
    CharacterAutostep, CharacterCollision, CharacterLength, KinematicCharacterController,
};
use rapier3d::parry::query::details::ShapeCastOptions;
use rapier3d::prelude::*;

use crate::movement::{MoveConfig, Vec3d};

const STATIC_WORLD_GROUP: Group = Group::GROUP_1;
const PUSHABLE_DYNAMIC_GROUP: Group = Group::GROUP_2;
const PLAYER_GROUP: Group = Group::GROUP_3;

#[derive(Clone, Debug)]
pub struct DynamicBodyContact {
    pub body_id: u32,
    pub mass: f32,
    pub center: [f32; 3],
    pub contact_point: [f32; 3],
    pub aabb_max_y: f32,
    pub horizontal_distance_sq: f32,
    pub linvel: [f32; 3],
}

pub struct PlayerQueryContext<'a> {
    sim: &'a SimWorld,
    collider_handle: ColliderHandle,
    static_pipeline: QueryPipeline<'a>,
    support_pipeline: QueryPipeline<'a>,
    dynamic_pipeline: QueryPipeline<'a>,
}

impl<'a> PlayerQueryContext<'a> {
    fn new(sim: &'a SimWorld, collider_handle: ColliderHandle) -> Self {
        let dispatcher = sim.narrow_phase.query_dispatcher();
        let static_pipeline = sim.broad_phase.as_query_pipeline(
            dispatcher,
            &sim.rigid_bodies,
            &sim.colliders,
            SimWorld::player_static_filter(collider_handle),
        );
        let support_pipeline = sim.broad_phase.as_query_pipeline(
            dispatcher,
            &sim.rigid_bodies,
            &sim.colliders,
            SimWorld::player_support_filter(collider_handle),
        );
        let dynamic_pipeline = sim.broad_phase.as_query_pipeline(
            dispatcher,
            &sim.rigid_bodies,
            &sim.colliders,
            SimWorld::player_dynamic_filter(collider_handle),
        );

        Self {
            sim,
            collider_handle,
            static_pipeline,
            support_pipeline,
            dynamic_pipeline,
        }
    }

    pub fn move_character_horizontal(
        &self,
        position: &mut Vec3d,
        velocity: &mut Vec3d,
        on_ground: &mut bool,
        dt: f32,
    ) {
        self.sim.move_character_with_query_pipeline(
            self.collider_handle,
            position,
            velocity,
            on_ground,
            dt,
            &self.static_pipeline,
            None,
        );
    }

    pub fn move_character_support(
        &self,
        position: &mut Vec3d,
        velocity: &mut Vec3d,
        on_ground: &mut bool,
        dt: f32,
        collisions_out: Option<&mut Vec<CharacterCollision>>,
    ) {
        self.sim.move_character_with_query_pipeline(
            self.collider_handle,
            position,
            velocity,
            on_ground,
            dt,
            &self.support_pipeline,
            collisions_out,
        );
    }

    pub fn intersect_pushable_dynamic_bodies(
        &self,
        position: &Vec3d,
        contacts_out: &mut Vec<DynamicBodyContact>,
    ) {
        self.sim.intersect_pushable_dynamic_bodies_with_pipeline(
            self.collider_handle,
            position,
            &self.dynamic_pipeline,
            contacts_out,
        );
    }

    pub fn probe_dynamic_support(
        &self,
        position: &Vec3d,
        max_probe_distance: f32,
    ) -> Option<DynamicBodyContact> {
        self.sim.probe_dynamic_support_with_pipeline(
            self.collider_handle,
            position,
            max_probe_distance,
            &self.dynamic_pipeline,
        )
    }
}

/// Core collision world + KCC simulation shared between server (native) and
/// client (WASM).  Owns the Rapier collision primitives but does NOT own a
/// `PhysicsPipeline` — dynamic rigid-body simulation is server-only.
pub struct SimWorld {
    pub config: MoveConfig,

    // Collision world — pub so the server can layer a PhysicsPipeline on top.
    pub rigid_bodies: RigidBodySet,
    pub colliders: ColliderSet,
    pub integration_parameters: IntegrationParameters,
    pub island_manager: IslandManager,
    pub broad_phase: BroadPhaseBvh,
    pub narrow_phase: NarrowPhase,

    controller: KinematicCharacterController,
    pub modified_colliders: Vec<ColliderHandle>,
    removed_colliders: Vec<ColliderHandle>,
}

impl SimWorld {
    fn player_static_filter(collider_handle: ColliderHandle) -> QueryFilter<'static> {
        QueryFilter::exclude_kinematic()
            .exclude_sensors()
            .exclude_collider(collider_handle)
            .groups(Self::player_obstacle_groups())
    }

    fn player_support_filter(collider_handle: ColliderHandle) -> QueryFilter<'static> {
        QueryFilter::exclude_kinematic()
            .exclude_sensors()
            .exclude_collider(collider_handle)
            .groups(InteractionGroups::new(
                STATIC_WORLD_GROUP | PUSHABLE_DYNAMIC_GROUP,
                STATIC_WORLD_GROUP | PUSHABLE_DYNAMIC_GROUP,
            ))
    }

    fn player_dynamic_filter(collider_handle: ColliderHandle) -> QueryFilter<'static> {
        QueryFilter::only_dynamic()
            .exclude_sensors()
            .exclude_collider(collider_handle)
            .groups(Self::player_dynamic_groups())
    }

    pub fn new(config: MoveConfig) -> Self {
        let mut controller = KinematicCharacterController::default();
        controller.offset = CharacterLength::Absolute(config.collision_offset);
        controller.autostep = Some(CharacterAutostep {
            max_height: CharacterLength::Absolute(config.max_step_height),
            min_width: CharacterLength::Absolute(config.min_step_width),
            include_dynamic_bodies: false,
        });
        controller.snap_to_ground = Some(CharacterLength::Absolute(config.snap_to_ground));
        controller.max_slope_climb_angle = config.max_slope_radians;
        controller.min_slope_slide_angle = config.min_slide_radians;

        let mut sim = Self {
            config,
            rigid_bodies: RigidBodySet::new(),
            colliders: ColliderSet::new(),
            integration_parameters: IntegrationParameters::default(),
            island_manager: IslandManager::new(),
            broad_phase: BroadPhaseBvh::new(),
            narrow_phase: NarrowPhase::new(),
            controller,
            modified_colliders: Vec::new(),
            removed_colliders: Vec::new(),
        };

        sim.integration_parameters.dt = 1.0 / 60.0;
        sim.integration_parameters.num_solver_iterations = 2;
        sim
    }

    // ── Collider management ──────────────────────────

    pub fn add_static_cuboid(
        &mut self,
        center: Vector3<f32>,
        half_extents: Vector3<f32>,
        user_data: u128,
    ) -> ColliderHandle {
        self.colliders.insert(
            ColliderBuilder::cuboid(half_extents.x, half_extents.y, half_extents.z)
                .translation(center)
                .collision_groups(InteractionGroups::new(STATIC_WORLD_GROUP, Group::all()))
                .user_data(user_data)
                .build(),
        )
    }

    pub fn add_static_cuboid_rotated(
        &mut self,
        center: Vector3<f32>,
        rotation: [f32; 4],
        half_extents: Vector3<f32>,
        user_data: u128,
    ) -> ColliderHandle {
        let orientation = UnitQuaternion::from_quaternion(Quaternion::new(
            rotation[3],
            rotation[0],
            rotation[1],
            rotation[2],
        ));
        self.colliders.insert(
            ColliderBuilder::cuboid(half_extents.x, half_extents.y, half_extents.z)
                .position(Isometry3::from_parts(
                    Translation3::from(center),
                    orientation,
                ))
                .collision_groups(InteractionGroups::new(STATIC_WORLD_GROUP, Group::all()))
                .user_data(user_data)
                .build(),
        )
    }

    pub fn add_static_heightfield(
        &mut self,
        center: Vector3<f32>,
        heights: DMatrix<f32>,
        scale: Vector3<f32>,
        user_data: u128,
    ) -> ColliderHandle {
        self.colliders.insert(
            ColliderBuilder::heightfield(heights, scale)
                .translation(center)
                .collision_groups(InteractionGroups::new(STATIC_WORLD_GROUP, Group::all()))
                .user_data(user_data)
                .build(),
        )
    }

    pub fn add_static_trimesh(
        &mut self,
        vertices: Vec<Point3<f32>>,
        indices: Vec<[u32; 3]>,
        user_data: u128,
    ) -> ColliderHandle {
        self.colliders.insert(
            ColliderBuilder::trimesh(vertices, indices)
                .expect("terrain trimesh should be valid")
                .collision_groups(InteractionGroups::new(STATIC_WORLD_GROUP, Group::all()))
                .user_data(user_data)
                .build(),
        )
    }

    pub fn remove_collider(&mut self, handle: ColliderHandle) {
        self.colliders.remove(
            handle,
            &mut self.island_manager,
            &mut self.rigid_bodies,
            true,
        );
    }

    pub fn collider_user_data(&self, handle: ColliderHandle) -> Option<u128> {
        self.colliders.get(handle).map(|c| c.user_data)
    }

    /// Flush pending collider changes into the broad-phase BVH.
    pub fn sync_broad_phase(&mut self) {
        if self.modified_colliders.is_empty() && self.removed_colliders.is_empty() {
            return;
        }
        let mut events = Vec::new();
        self.broad_phase.update(
            &self.integration_parameters,
            &self.colliders,
            &self.rigid_bodies,
            &self.modified_colliders,
            &self.removed_colliders,
            &mut events,
        );
        self.modified_colliders.clear();
        self.removed_colliders.clear();
    }

    /// Bootstrap the broad-phase BVH with all current colliders.  Call once
    /// after bulk seeding, before the first tick.
    pub fn rebuild_broad_phase(&mut self) {
        self.modified_colliders.clear();
        self.removed_colliders.clear();
        for (handle, _) in self.colliders.iter() {
            self.modified_colliders.push(handle);
        }
        self.sync_broad_phase();
    }

    // ── Player capsule management ────────────────────

    /// Create a kinematic player capsule collider at `position`.
    pub fn create_player_collider(&mut self, position: Vec3d, player_id: u32) -> ColliderHandle {
        let collider = ColliderBuilder::capsule_y(
            self.config.capsule_half_segment,
            self.config.capsule_radius,
        )
        .translation(vector![
            position.x as f32,
            position.y as f32,
            position.z as f32
        ])
        .friction(0.0)
        .active_collision_types(
            ActiveCollisionTypes::default() | ActiveCollisionTypes::KINEMATIC_FIXED,
        )
        .collision_groups(InteractionGroups::new(
            PLAYER_GROUP,
            STATIC_WORLD_GROUP | PUSHABLE_DYNAMIC_GROUP | PLAYER_GROUP,
        ))
        .user_data(player_id as u128)
        .build();
        self.colliders.insert(collider)
    }

    pub fn remove_player_collider(&mut self, handle: ColliderHandle) {
        self.removed_colliders.push(handle);
        self.colliders.remove(
            handle,
            &mut self.island_manager,
            &mut self.rigid_bodies,
            true,
        );
    }

    // ── KCC movement ─────────────────────────────────

    pub fn player_query_context(&self, collider_handle: ColliderHandle) -> PlayerQueryContext<'_> {
        PlayerQueryContext::new(self, collider_handle)
    }

    /// Run the Rapier KCC for one tick given the current velocity.
    ///
    /// The caller is responsible for computing velocity (friction, acceleration,
    /// gravity, jump) before calling this.  This function:
    /// 1. Computes desired displacement = `velocity * dt`
    /// 2. Runs Rapier's KCC to obtain the collision-corrected translation
    /// 3. Updates `position`, `velocity.x/z`, `velocity.y` (zeroed if grounded)
    /// 4. Returns full collision list for impulse solving
    pub fn move_character(
        &self,
        collider_handle: ColliderHandle,
        position: &mut Vec3d,
        velocity: &mut Vec3d,
        on_ground: &mut bool,
        dt: f32,
    ) -> Vec<CharacterCollision> {
        let filter = QueryFilter::default()
            .exclude_collider(collider_handle)
            .groups(Self::player_obstacle_groups());
        self.move_character_with_filter(collider_handle, position, velocity, on_ground, dt, filter)
    }

    /// Horizontal locomotion only treats the static world group as blocking.
    ///
    /// Dynamic props remain simulated and can be pushed separately, but they
    /// do not participate in the hot locomotion obstacle query.
    pub fn move_character_horizontal(
        &self,
        collider_handle: ColliderHandle,
        position: &mut Vec3d,
        velocity: &mut Vec3d,
        on_ground: &mut bool,
        dt: f32,
    ) -> Vec<CharacterCollision> {
        let filter = Self::player_static_filter(collider_handle);
        self.move_character_with_filter(collider_handle, position, velocity, on_ground, dt, filter)
    }

    /// Vertical/support motion includes dynamic bodies so characters can land
    /// on and stand stably atop dynamic props when Rapier determines the
    /// configuration is supported.
    pub fn move_character_support(
        &self,
        collider_handle: ColliderHandle,
        position: &mut Vec3d,
        velocity: &mut Vec3d,
        on_ground: &mut bool,
        dt: f32,
    ) -> Vec<CharacterCollision> {
        let filter = Self::player_support_filter(collider_handle);
        self.move_character_with_filter(collider_handle, position, velocity, on_ground, dt, filter)
    }

    pub fn move_character_with_filter(
        &self,
        collider_handle: ColliderHandle,
        position: &mut Vec3d,
        velocity: &mut Vec3d,
        on_ground: &mut bool,
        dt: f32,
        filter: QueryFilter,
    ) -> Vec<CharacterCollision> {
        let query_pipeline = self.broad_phase.as_query_pipeline(
            self.narrow_phase.query_dispatcher(),
            &self.rigid_bodies,
            &self.colliders,
            filter,
        );
        let mut collisions = Vec::new();
        self.move_character_with_query_pipeline(
            collider_handle,
            position,
            velocity,
            on_ground,
            dt,
            &query_pipeline,
            Some(&mut collisions),
        );
        collisions
    }

    fn move_character_with_query_pipeline(
        &self,
        collider_handle: ColliderHandle,
        position: &mut Vec3d,
        velocity: &mut Vec3d,
        on_ground: &mut bool,
        dt: f32,
        query_pipeline: &QueryPipeline<'_>,
        collisions_out: Option<&mut Vec<CharacterCollision>>,
    ) {
        let dt64 = dt as f64;

        let desired = *velocity * dt64;
        let desired_translation_f32 = vector![desired.x as f32, desired.y as f32, desired.z as f32];
        let position_f32 = vector![position.x as f32, position.y as f32, position.z as f32];

        let collider = self
            .colliders
            .get(collider_handle)
            .expect("missing player collider");
        let character_shape = collider.shape();
        let character_pos = Isometry3::translation(position_f32.x, position_f32.y, position_f32.z);
        let corrected = if let Some(collisions) = collisions_out {
            collisions.clear();
            self.controller.move_shape(
                dt,
                query_pipeline,
                character_shape,
                &character_pos,
                desired_translation_f32,
                |collision| collisions.push(collision),
            )
        } else {
            self.controller.move_shape(
                dt,
                query_pipeline,
                character_shape,
                &character_pos,
                desired_translation_f32,
                |_| {},
            )
        };

        let ct = corrected.translation;
        position.x += ct.x as f64;
        position.y += ct.y as f64;
        position.z += ct.z as f64;

        *on_ground = corrected.grounded;
        if *on_ground && velocity.y < 0.0 {
            velocity.y = 0.0;
        }

        velocity.x = ct.x as f64 / dt64;
        velocity.z = ct.z as f64 / dt64;
    }

    pub fn player_obstacle_groups() -> InteractionGroups {
        InteractionGroups::new(STATIC_WORLD_GROUP, STATIC_WORLD_GROUP)
    }

    pub fn player_dynamic_groups() -> InteractionGroups {
        InteractionGroups::new(PUSHABLE_DYNAMIC_GROUP, PUSHABLE_DYNAMIC_GROUP)
    }

    pub fn intersect_pushable_dynamic_bodies(
        &self,
        collider_handle: ColliderHandle,
        position: &Vec3d,
    ) -> Vec<DynamicBodyContact> {
        let query_pipeline = self.broad_phase.as_query_pipeline(
            self.narrow_phase.query_dispatcher(),
            &self.rigid_bodies,
            &self.colliders,
            Self::player_dynamic_filter(collider_handle),
        );
        let mut contacts = Vec::new();
        self.intersect_pushable_dynamic_bodies_with_pipeline(
            collider_handle,
            position,
            &query_pipeline,
            &mut contacts,
        );
        contacts
    }

    fn intersect_pushable_dynamic_bodies_with_pipeline(
        &self,
        collider_handle: ColliderHandle,
        position: &Vec3d,
        query_pipeline: &QueryPipeline<'_>,
        contacts_out: &mut Vec<DynamicBodyContact>,
    ) {
        let Some(character_collider) = self.colliders.get(collider_handle) else {
            contacts_out.clear();
            return;
        };
        let character_shape = character_collider.shape();
        let character_pos =
            Isometry3::translation(position.x as f32, position.y as f32, position.z as f32);
        let player_center = vector![position.x as f32, position.y as f32, position.z as f32];
        contacts_out.clear();
        for (_handle, collider) in query_pipeline.intersect_shape(character_pos, character_shape) {
            let Some(contact) = self.dynamic_contact_from_collider(collider, &player_center) else {
                continue;
            };
            contacts_out.push(contact);
        }
        contacts_out.sort_by(|a, b| {
            a.horizontal_distance_sq
                .total_cmp(&b.horizontal_distance_sq)
        });
    }

    pub fn probe_dynamic_support(
        &self,
        collider_handle: ColliderHandle,
        position: &Vec3d,
        max_probe_distance: f32,
    ) -> Option<DynamicBodyContact> {
        let query_pipeline = self.broad_phase.as_query_pipeline(
            self.narrow_phase.query_dispatcher(),
            &self.rigid_bodies,
            &self.colliders,
            Self::player_dynamic_filter(collider_handle),
        );
        self.probe_dynamic_support_with_pipeline(
            collider_handle,
            position,
            max_probe_distance,
            &query_pipeline,
        )
    }

    fn probe_dynamic_support_with_pipeline(
        &self,
        collider_handle: ColliderHandle,
        position: &Vec3d,
        max_probe_distance: f32,
        query_pipeline: &QueryPipeline<'_>,
    ) -> Option<DynamicBodyContact> {
        let character_collider = self.colliders.get(collider_handle)?;
        let character_shape = character_collider.shape();
        let character_pos =
            Isometry3::translation(position.x as f32, position.y as f32, position.z as f32);
        let options = ShapeCastOptions {
            max_time_of_impact: 1.0,
            target_distance: 0.0,
            stop_at_penetration: true,
            compute_impact_geometry_on_penetration: false,
        };
        let downward = vector![0.0, -max_probe_distance, 0.0];
        let (handle, _hit) =
            query_pipeline.cast_shape(&character_pos, &downward, character_shape, options)?;
        let collider = self.colliders.get(handle)?;
        self.dynamic_contact_from_collider(
            collider,
            &vector![position.x as f32, position.y as f32, position.z as f32],
        )
    }

    pub fn is_pushable_dynamic_collider(&self, handle: ColliderHandle) -> bool {
        self.colliders
            .get(handle)
            .filter(|collider| {
                collider
                    .collision_groups()
                    .memberships
                    .contains(PUSHABLE_DYNAMIC_GROUP)
            })
            .and_then(|collider| collider.parent())
            .and_then(|parent| self.rigid_bodies.get(parent))
            .map(|body| body.body_type().is_dynamic())
            .unwrap_or(false)
    }

    fn dynamic_contact_from_collider(
        &self,
        collider: &Collider,
        player_center: &Vector3<f32>,
    ) -> Option<DynamicBodyContact> {
        let body_id = collider.user_data as u32;
        let parent = collider.parent().and_then(|p| self.rigid_bodies.get(p))?;
        let center = *parent.center_of_mass();
        let dx = center.x - player_center.x;
        let dz = center.z - player_center.z;
        let aabb = collider.compute_aabb();
        Some(DynamicBodyContact {
            body_id,
            mass: parent.mass(),
            center: [center.x, center.y, center.z],
            contact_point: [center.x, center.y, center.z],
            aabb_max_y: aabb.maxs.y,
            horizontal_distance_sq: dx * dx + dz * dz,
            linvel: [parent.linvel().x, parent.linvel().y, parent.linvel().z],
        })
    }

    /// Update the collider position to match the player's current position.
    /// Call after `move_character` to keep the collider in sync.
    pub fn sync_player_collider(&mut self, handle: ColliderHandle, position: &Vec3d) {
        let pos_f32 = vector![position.x as f32, position.y as f32, position.z as f32];
        if let Some(collider) = self.colliders.get_mut(handle) {
            collider.set_translation(pos_f32);
        }
    }

    // ── Dynamic body impulses ─────────────────────────

    /// Apply physics-correct impulses from KCC collisions to dynamic bodies.
    pub fn solve_character_collision_impulses(
        &mut self,
        collider_handle: ColliderHandle,
        character_mass: f32,
        collisions: &[CharacterCollision],
        dt: f32,
    ) {
        let character_shape = self
            .colliders
            .get(collider_handle)
            .map(|c| c.shape().clone_dyn())
            .expect("missing player collider");
        let filter = QueryFilter::default().exclude_collider(collider_handle);
        let mut query_pipeline = self.broad_phase.as_query_pipeline_mut(
            self.narrow_phase.query_dispatcher(),
            &mut self.rigid_bodies,
            &mut self.colliders,
            filter,
        );
        self.controller.solve_character_collision_impulses(
            dt,
            &mut query_pipeline,
            &*character_shape,
            character_mass,
            collisions,
        );
    }

    // ── Raycasting ───────────────────────────────────

    pub fn cast_ray(
        &self,
        origin: [f32; 3],
        dir: [f32; 3],
        max_toi: f32,
        exclude_collider: Option<ColliderHandle>,
    ) -> Option<f32> {
        let ray = Ray::new(
            nalgebra::point![origin[0], origin[1], origin[2]],
            vector![dir[0], dir[1], dir[2]],
        );
        let mut filter = QueryFilter::default();
        if let Some(handle) = exclude_collider {
            filter = filter.exclude_collider(handle);
        }
        let query_pipeline = self.broad_phase.as_query_pipeline(
            self.narrow_phase.query_dispatcher(),
            &self.rigid_bodies,
            &self.colliders,
            filter,
        );
        query_pipeline
            .cast_ray(&ray, max_toi, true)
            .map(|(_handle, toi)| toi)
    }

    /// Cast a ray and return both the time-of-impact and the surface normal.
    pub fn cast_ray_and_get_normal(
        &self,
        origin: [f32; 3],
        dir: [f32; 3],
        max_toi: f32,
        exclude_collider: Option<ColliderHandle>,
    ) -> Option<(f32, [f32; 3])> {
        let ray = Ray::new(
            nalgebra::point![origin[0], origin[1], origin[2]],
            vector![dir[0], dir[1], dir[2]],
        );
        let mut filter = QueryFilter::default();
        if let Some(handle) = exclude_collider {
            filter = filter.exclude_collider(handle);
        }
        let query_pipeline = self.broad_phase.as_query_pipeline(
            self.narrow_phase.query_dispatcher(),
            &self.rigid_bodies,
            &self.colliders,
            filter,
        );
        query_pipeline
            .cast_ray_and_get_normal(&ray, max_toi, true)
            .map(|(_handle, intersection)| {
                let n = intersection.normal;
                (intersection.time_of_impact, [n.x, n.y, n.z])
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nalgebra::DMatrix;

    fn sim_with_ground() -> SimWorld {
        let mut sim = SimWorld::new(MoveConfig::default());
        sim.add_static_cuboid(vector![0.0, -0.5, 0.0], vector![50.0, 0.5, 50.0], 0);
        sim.rebuild_broad_phase();
        sim
    }

    #[test]
    fn raycast_hits_ground() {
        let sim = sim_with_ground();
        let hit = sim.cast_ray([0.0, 5.0, 0.0], [0.0, -1.0, 0.0], 100.0, None);
        assert!(hit.is_some(), "ray should hit ground");
        let toi = hit.unwrap();
        assert!((toi - 5.0).abs() < 0.1, "toi should be ~5.0, got {}", toi);
    }

    #[test]
    fn raycast_misses_past_geometry() {
        let sim = sim_with_ground();
        // Ray pointing upward should miss the ground below
        let hit = sim.cast_ray([0.0, 1.0, 0.0], [0.0, 1.0, 0.0], 100.0, None);
        assert!(hit.is_none(), "upward ray should miss ground");
    }

    #[test]
    fn raycast_hits_heightfield_ground() {
        let mut sim = SimWorld::new(MoveConfig::default());
        let heights = DMatrix::from_element(4, 4, 0.0);
        sim.add_static_heightfield(vector![0.0, 0.0, 0.0], heights, vector![20.0, 1.0, 20.0], 0);
        sim.rebuild_broad_phase();

        let hit = sim.cast_ray([0.0, 5.0, 0.0], [0.0, -1.0, 0.0], 100.0, None);
        assert!(hit.is_some(), "ray should hit heightfield");
        let toi = hit.unwrap();
        assert!((toi - 5.0).abs() < 0.2, "toi should be ~5.0, got {}", toi);
    }
}
