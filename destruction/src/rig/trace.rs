//! What the structure did, second by second.
//!
//! The interesting claims about a collapse are claims about its *shape* in
//! time: it held for three seconds and then went; it kept breaking after the
//! shot stopped; it went quiet and stayed quiet. An end-state number cannot
//! distinguish "stood, then fell" from "fell immediately", and on a
//! nondeterministic simulator the number itself is not reproducible anyway —
//! but the shape is.

use vibe_netcode::destruction_backend::DestructionStats;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Sample {
    pub secs: f32,
    pub broken_bonds: u32,
    pub chunk_bodies: u32,
    pub awake_chunk_bodies: u32,
    /// Bonds over their own elastic limit in the last solve: the population
    /// that is accumulating damage right now. Non-zero and steady is a
    /// structure straining; zero is a structure at rest whatever else moved.
    pub overstressed_bonds: u32,
    /// Worst stress / elastic-limit ratio anywhere. 1.0 is at the limit.
    pub bond_utilisation_max: f32,
    pub min_body_y: f32,
}

impl Sample {
    pub fn capture(secs: f32, stats: &DestructionStats) -> Self {
        Self {
            secs,
            broken_bonds: stats.broken_bonds,
            chunk_bodies: stats.chunk_bodies,
            awake_chunk_bodies: stats.awake_chunk_bodies,
            overstressed_bonds: stats.overstressed_bonds,
            bond_utilisation_max: stats.bond_utilisation_max,
            min_body_y: stats.min_body_y,
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct StatsTrace {
    pub samples: Vec<Sample>,
}

impl StatsTrace {
    pub fn push(&mut self, sample: Sample) {
        self.samples.push(sample);
    }

    pub fn last(&self) -> Option<&Sample> {
        self.samples.last()
    }

    /// The sample nearest a moment in time.
    pub fn at(&self, secs: f32) -> Option<&Sample> {
        self.samples.iter().min_by(|a, b| {
            (a.secs - secs)
                .abs()
                .partial_cmp(&(b.secs - secs).abs())
                .unwrap_or(std::cmp::Ordering::Equal)
        })
    }

    /// Bonds broken between two moments.
    pub fn broken_between(&self, from: f32, to: f32) -> u32 {
        let start = self.at(from).map(|s| s.broken_bonds).unwrap_or(0);
        let end = self.at(to).map(|s| s.broken_bonds).unwrap_or(start);
        end.saturating_sub(start)
    }

    /// Was anything still over its elastic limit at this moment — i.e. was the
    /// structure straining rather than merely standing?
    pub fn straining_at(&self, secs: f32) -> bool {
        self.at(secs).map(|s| s.overstressed_bonds > 0).unwrap_or(false)
    }

    /// Render as a table, for a test that wants to show its work when it fails.
    pub fn report(&self) -> String {
        let mut out = String::from("  t     broken  bodies  awake  overstressed  util_max\n");
        for sample in &self.samples {
            out.push_str(&format!(
                "  {:>5.1}  {:>6}  {:>6}  {:>5}  {:>12}  {:>8.2}\n",
                sample.secs,
                sample.broken_bonds,
                sample.chunk_bodies,
                sample.awake_chunk_bodies,
                sample.overstressed_bonds,
                sample.bond_utilisation_max,
            ));
        }
        out
    }
}

/// When a tracked set of chunks first counts as having collapsed.
///
/// Takes the per-second drop series a scenario recorded, not the trace, because
/// "did the roof come down" is a question about specific chunks rather than
/// about global counters.
pub fn collapse_time(drops: &[(f32, f32)], threshold_m: f32) -> Option<f32> {
    drops
        .iter()
        .find(|(_, drop)| *drop >= threshold_m)
        .map(|(secs, _)| *secs)
}
