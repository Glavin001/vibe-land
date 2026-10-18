//! City body poses for an in-process client (the native app's single-player
//! session, `local_session`): every awake body's pose each tick, exactly as
//! the destruction backend produced it, read from memory instead of the pose
//! stream.
//!
//! The stream is built for a network: a byte budget shared out by priority
//! sends each moving body every few ticks, quantised, and the client renders
//! a playout delay behind to interpolate between them. In-process none of
//! that is needed: the client takes every body every tick at full precision.
//! Topology (fractures, settles, wakes) still travels on the reliable
//! packets; each frame carries the encoder's topology sequence as of its tick,
//! so the client applies a frame only once its ledger holds that topology
//! (body poses are in a centre-of-mass frame that fractures move).
//!
//! A feed exists only for a match a local session registered; servers serving
//! the network never create one.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, OnceLock, RwLock};

use vibe_land_destruction::encoder::BodySnapshotInput;

/// Words per body: entity, position xyz, rotation xyzw, linear velocity xyz
/// (f32 as bits).
pub const WORDS_PER_BODY: usize = 11;
/// Words before a frame's bodies: tick, topology sequence, body count.
pub const FRAME_HEADER_WORDS: usize = 3;
/// Recent frames kept, for a reader a few ticks behind.
const FRAMES_KEPT: usize = 8;

struct PoseFrame {
    tick: u32,
    topo_seq: u32,
    words: Vec<u32>,
}

#[derive(Default)]
pub struct PoseFeed {
    frames: Mutex<VecDeque<PoseFrame>>,
}

impl PoseFeed {
    /// The poses after one tick's step (the encoder's input), with the
    /// topology sequence the encoder reached that tick.
    pub fn publish(&self, tick: u32, topo_seq: u32, snapshots: &[BodySnapshotInput]) {
        let mut words = Vec::with_capacity(snapshots.len() * WORDS_PER_BODY);
        for body in snapshots {
            words.push(body.body_entity);
            words.extend(body.position.iter().map(|v| v.to_bits()));
            words.extend(body.rotation.iter().map(|v| v.to_bits()));
            words.extend(body.linear_velocity.iter().map(|v| v.to_bits()));
        }
        let mut frames = self.frames.lock().expect("pose feed lock");
        if frames.len() == FRAMES_KEPT {
            frames.pop_front();
        }
        frames.push_back(PoseFrame { tick, topo_seq, words });
    }

    /// Frames with a tick after `since`, oldest first, packed back to back:
    /// `[tick, topo_seq, count, count * WORDS_PER_BODY words]`.
    pub fn since(&self, since: u32) -> Vec<u32> {
        let frames = self.frames.lock().expect("pose feed lock");
        let mut out = Vec::new();
        for frame in frames.iter().filter(|frame| frame.tick > since) {
            out.push(frame.tick);
            out.push(frame.topo_seq);
            out.push((frame.words.len() / WORDS_PER_BODY) as u32);
            out.extend_from_slice(&frame.words);
        }
        out
    }
}

fn registry() -> &'static RwLock<HashMap<String, Arc<PoseFeed>>> {
    static REGISTRY: OnceLock<RwLock<HashMap<String, Arc<PoseFeed>>>> = OnceLock::new();
    REGISTRY.get_or_init(Default::default)
}

/// A feed for `match_id`, which its city runtime will publish into.
pub fn register(match_id: &str) -> Arc<PoseFeed> {
    let feed = Arc::new(PoseFeed::default());
    registry().write().expect("pose feed registry").insert(match_id.to_string(), feed.clone());
    feed
}

pub fn lookup(match_id: &str) -> Option<Arc<PoseFeed>> {
    registry().read().expect("pose feed registry").get(match_id).cloned()
}

pub fn unregister(match_id: &str) {
    registry().write().expect("pose feed registry").remove(match_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(entity: u32, x: f32) -> BodySnapshotInput {
        BodySnapshotInput {
            body_entity: entity,
            position: [x, 2.0, 3.0],
            rotation: [0.0, 0.0, 0.0, 1.0],
            linear_velocity: [0.0; 3],
            angular_velocity: [0.0; 3],
            contacts: 0,
            flags: 0,
        }
    }

    #[test]
    fn frames_since_a_tick_are_packed_oldest_first() {
        let feed = PoseFeed::default();
        feed.publish(10, 4, &[body(0x8000_0001, 1.0)]);
        feed.publish(11, 5, &[body(0x8000_0001, 1.5), body(0x8000_0002, 9.0)]);
        let words = feed.since(10);
        assert_eq!(&words[..3], &[11, 5, 2]);
        assert_eq!(words[3], 0x8000_0001);
        assert_eq!(f32::from_bits(words[4]), 1.5);
        assert_eq!(words[3 + WORDS_PER_BODY], 0x8000_0002);
        assert_eq!(f32::from_bits(words[4 + WORDS_PER_BODY]), 9.0);
        assert_eq!(feed.since(9).len(), (FRAME_HEADER_WORDS + WORDS_PER_BODY) + (FRAME_HEADER_WORDS + 2 * WORDS_PER_BODY));
        assert!(feed.since(11).is_empty());
    }

    #[test]
    fn keeps_only_recent_frames() {
        let feed = PoseFeed::default();
        for tick in 0..20 {
            feed.publish(tick, 0, &[]);
        }
        let ticks: Vec<u32> = feed.since(0).chunks(FRAME_HEADER_WORDS).map(|frame| frame[0]).collect();
        assert_eq!(ticks, (12..20).collect::<Vec<u32>>());
    }
}
