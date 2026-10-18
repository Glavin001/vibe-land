//! Bodies that go through the ground: when they first do, and where they stop
//! existing.
//!
//! Two jobs, both keyed by a body's entity id and its centre height:
//!
//! - **Forensics.** The first tick a body's centre is below the ground surface
//!   is the moment to look at it: its velocity, the tick before, whether it
//!   still had support. After that it is only falling. `observe` says when that
//!   first tick is, once per body.
//! - **A retire floor.** A body that has gone through the ground is never
//!   coming back up. Without a floor it simulates, streams and is drawn in free
//!   fall until it reaches the 1 km world bound fourteen seconds later -- which
//!   is what the 2026-09-24 session showed, fourteen times. The floor sits a few
//!   metres under the lowest ground surface, so nothing resting on or bouncing
//!   off the ground can reach it, and a body that crosses it is retired through
//!   the caller's ordinary removal path, once.
//!
//! The floor is not the fix for bodies going through the ground; it bounds the
//! damage one does. With no ground known (a scene without static geometry) the
//! floor is disabled rather than guessed.

use std::collections::HashSet;

/// How far below the ground surface a body's centre must be before it counts as
/// through the ground rather than resting on it with some penetration.
///
/// Half a metre: a resting chunk or ball sits with its centre above the surface,
/// and a hard landing penetrates centimetres, not decimetres.
pub const BELOW_GROUND_MARGIN_M: f32 = 0.5;

/// Default depth of the retire floor below the lowest ground surface, metres.
pub const DEFAULT_RETIRE_DEPTH_M: f32 = 5.0;

/// `VIBE_RETIRE_FLOOR_DEPTH_M`, else [`DEFAULT_RETIRE_DEPTH_M`]. Must be at
/// least [`BELOW_GROUND_MARGIN_M`]; anything smaller would retire bodies that
/// are merely resting with some penetration.
pub fn retire_depth_m() -> f32 {
    std::env::var("VIBE_RETIRE_FLOOR_DEPTH_M")
        .ok()
        .and_then(|v| v.parse::<f32>().ok())
        .filter(|v| v.is_finite())
        .map(|v| v.max(BELOW_GROUND_MARGIN_M))
        .unwrap_or(DEFAULT_RETIRE_DEPTH_M)
}

/// What `observe` decided about a body this tick.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GroundVerdict {
    /// On or above the ground (or no ground is known).
    Above,
    /// Through the ground but above the floor. `first` is true on the first
    /// such tick of this body's life.
    BelowGround { first: bool },
    /// Crossed the retire floor this tick: retire it now. Reported once per
    /// body; afterwards the body is [`GroundWatch::is_retired`].
    Retire,
}

#[derive(Debug, Default)]
pub struct GroundWatch {
    /// Top of the lowest ground surface in the scene, if there is one.
    ground_y: Option<f32>,
    /// Depth of the floor below `ground_y`.
    depth_m: f32,
    /// Bodies whose first below-ground tick has been reported.
    reported: HashSet<u32>,
    /// Bodies retired at the floor. Never streamed again.
    retired: HashSet<u32>,
    /// Distinct bodies seen below the ground, cumulative.
    pub below_ground_total: u64,
    /// Distinct bodies retired at the floor, cumulative.
    pub retired_total: u64,
}

impl GroundWatch {
    pub fn new(ground_y: Option<f32>, depth_m: f32) -> Self {
        Self {
            ground_y: ground_y.filter(|y| y.is_finite()),
            depth_m: depth_m.max(BELOW_GROUND_MARGIN_M),
            ..Self::default()
        }
    }

    /// Set or change the ground reference. Bodies already reported or retired
    /// stay so.
    pub fn set_ground(&mut self, ground_y: Option<f32>, depth_m: f32) {
        self.ground_y = ground_y.filter(|y| y.is_finite());
        self.depth_m = depth_m.max(BELOW_GROUND_MARGIN_M);
    }

    pub fn ground_y(&self) -> Option<f32> {
        self.ground_y
    }

    /// The retire floor, or negative infinity when no ground is known.
    pub fn floor_y(&self) -> f32 {
        self.ground_y
            .map_or(f32::NEG_INFINITY, |ground| ground - self.depth_m)
    }

    /// Classify one body's centre height this tick.
    ///
    /// A non-finite height is treated as having crossed the floor: it is not a
    /// place anything can be drawn.
    pub fn observe(&mut self, entity: u32, y: f32) -> GroundVerdict {
        let Some(ground) = self.ground_y else {
            return GroundVerdict::Above;
        };
        if self.retired.contains(&entity) {
            return GroundVerdict::Above;
        }
        if !y.is_finite() || y < ground - self.depth_m {
            if self.reported.insert(entity) {
                self.below_ground_total += 1;
            }
            self.retired.insert(entity);
            self.retired_total += 1;
            return GroundVerdict::Retire;
        }
        if y < ground - BELOW_GROUND_MARGIN_M {
            let first = self.reported.insert(entity);
            if first {
                self.below_ground_total += 1;
            }
            return GroundVerdict::BelowGround { first };
        }
        GroundVerdict::Above
    }

    pub fn is_retired(&self, entity: u32) -> bool {
        self.retired.contains(&entity)
    }

    /// Forget a body: its id now names something else (a pool reuse, or a new
    /// promotion under the same id), which starts with a clean record.
    pub fn forget(&mut self, entity: u32) {
        self.reported.remove(&entity);
        self.retired.remove(&entity);
    }

    /// Drop every record, keeping the ground reference and the totals. For a
    /// rebuilt scene whose ids start over.
    pub fn clear_bodies(&mut self) {
        self.reported.clear();
        self.retired.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_body_on_or_just_into_the_ground_is_not_retired() {
        let mut watch = GroundWatch::new(Some(0.0), 5.0);
        // Resting on the slab, a hard landing's penetration, and a body half a
        // metre in: none of these are through the ground, none retire.
        for y in [2.0, 0.69, 0.0, -0.2, -0.49] {
            assert_eq!(watch.observe(1, y), GroundVerdict::Above, "y = {y}");
        }
        assert!(!watch.is_retired(1));
        assert_eq!(watch.retired_total, 0);
        assert_eq!(watch.below_ground_total, 0);
    }

    #[test]
    fn a_body_through_the_ground_is_reported_once_and_kept_until_the_floor() {
        let mut watch = GroundWatch::new(Some(0.0), 5.0);
        assert_eq!(watch.observe(7, -0.6), GroundVerdict::BelowGround { first: true });
        assert_eq!(watch.observe(7, -2.0), GroundVerdict::BelowGround { first: false });
        // Just above the floor: still kept. The floor is a bound on damage, not
        // a second ground; a body above it is still the caller's to publish.
        assert_eq!(watch.observe(7, -4.99), GroundVerdict::BelowGround { first: false });
        assert!(!watch.is_retired(7));
        assert_eq!(watch.retired_total, 0);
        assert_eq!(watch.below_ground_total, 1);
    }

    #[test]
    fn crossing_the_floor_retires_exactly_once() {
        let mut watch = GroundWatch::new(Some(0.0), 5.0);
        assert_eq!(watch.floor_y(), -5.0);
        assert_eq!(watch.observe(3, -5.01), GroundVerdict::Retire);
        assert!(watch.is_retired(3));
        // Still falling, still in the scene if the caller cannot remove it: it
        // must not be retired twice, or the client is told twice.
        assert_eq!(watch.observe(3, -50.0), GroundVerdict::Above);
        assert_eq!(watch.retired_total, 1);
        assert_eq!(watch.below_ground_total, 1);
    }

    #[test]
    fn a_non_finite_position_is_retired() {
        let mut watch = GroundWatch::new(Some(0.0), 5.0);
        assert_eq!(watch.observe(9, f32::NAN), GroundVerdict::Retire);
    }

    #[test]
    fn the_floor_follows_the_lowest_ground_not_zero() {
        let mut watch = GroundWatch::new(Some(-12.0), 3.0);
        assert_eq!(watch.floor_y(), -15.0);
        // Below y = 0, above this scene's floor: kept.
        assert_eq!(watch.observe(4, -11.0), GroundVerdict::Above);
        assert_eq!(watch.observe(4, -14.0), GroundVerdict::BelowGround { first: true });
        assert_eq!(watch.observe(4, -15.5), GroundVerdict::Retire);
    }

    #[test]
    fn without_a_known_ground_nothing_is_retired() {
        let mut watch = GroundWatch::new(None, 5.0);
        assert_eq!(watch.floor_y(), f32::NEG_INFINITY);
        assert_eq!(watch.observe(1, -900.0), GroundVerdict::Above);
        assert_eq!(watch.retired_total, 0);
    }

    #[test]
    fn a_depth_shallower_than_the_margin_is_clamped() {
        // A floor above the below-ground margin would retire resting bodies.
        let mut watch = GroundWatch::new(Some(0.0), 0.1);
        assert_eq!(watch.floor_y(), -BELOW_GROUND_MARGIN_M);
        assert_eq!(watch.observe(1, -0.3), GroundVerdict::Above);
    }

    #[test]
    fn a_forgotten_id_starts_clean() {
        let mut watch = GroundWatch::new(Some(0.0), 5.0);
        assert_eq!(watch.observe(2, -6.0), GroundVerdict::Retire);
        watch.forget(2);
        assert!(!watch.is_retired(2));
        assert_eq!(watch.observe(2, 1.0), GroundVerdict::Above);
        assert_eq!(watch.observe(2, -6.0), GroundVerdict::Retire);
        assert_eq!(watch.retired_total, 2);
    }
}
