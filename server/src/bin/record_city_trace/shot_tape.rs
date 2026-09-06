//! Exact external shot inputs for repeatable simulation comparisons.
//! This does not promise deterministic physics: later contacts may still diverge.
use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use std::{fs, io::Write, path::Path};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Metadata {
    pub manifest_hash: String,
    pub hz: u32,
    pub ticks: u32,
    pub gravity_bits: [u32; 3],
    /// stress impulse, push speed, blast radius, push radius, blast depth, range.
    pub shot_profile_bits: [u32; 6],
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Shot {
    pub tick: u32,
    pub origin_bits: [u32; 3],
    pub direction_bits: [u32; 3],
}

impl Shot {
    pub fn new(tick: u32, origin: [f32; 3], direction: [f32; 3]) -> Self {
        Self {
            tick,
            origin_bits: origin.map(f32::to_bits),
            direction_bits: direction.map(f32::to_bits),
        }
    }
    pub fn origin(&self) -> [f32; 3] {
        self.origin_bits.map(f32::from_bits)
    }
    pub fn direction(&self) -> [f32; 3] {
        self.direction_bits.map(f32::from_bits)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Tape {
    version: u32,
    pub metadata: Metadata,
    pub shots: Vec<Shot>,
}

impl Tape {
    pub fn new(metadata: Metadata) -> Self {
        Self {
            version: 1,
            metadata,
            shots: Vec::new(),
        }
    }

    pub fn read(path: &Path, expected: &Metadata) -> Result<Self> {
        let tape: Self = serde_json::from_slice(&fs::read(path).context("read shot tape")?)
            .context("decode shot tape")?;
        tape.validate(expected)?;
        Ok(tape)
    }

    pub fn validate(&self, expected: &Metadata) -> Result<()> {
        ensure!(
            self.version == 1,
            "unsupported shot tape version {}",
            self.version
        );
        ensure!(
            &self.metadata == expected,
            "shot tape scene/timing/gravity/weapon metadata differs from this run"
        );
        ensure!(
            self.metadata.hz > 0 && self.metadata.ticks > 0,
            "shot tape needs positive timing"
        );
        ensure!(
            self.metadata
                .gravity_bits
                .iter()
                .all(|&bits| f32::from_bits(bits).is_finite()),
            "nonfinite tape gravity"
        );
        ensure!(
            self.metadata.shot_profile_bits.iter().all(|&bits| {
                let value = f32::from_bits(bits);
                value.is_finite() && value > 0.0
            }),
            "invalid tape weapon settings"
        );
        let mut previous_tick = None;
        for (index, shot) in self.shots.iter().enumerate() {
            ensure!(
                shot.tick < self.metadata.ticks,
                "shot {index} lies outside the recorded run"
            );
            ensure!(
                previous_tick.is_none_or(|tick| shot.tick >= tick),
                "shot {index} is out of order"
            );
            ensure!(
                shot.origin()
                    .iter()
                    .chain(shot.direction().iter())
                    .all(|v| v.is_finite()),
                "shot {index} has nonfinite coordinates"
            );
            let norm: f64 = shot.direction().iter().map(|&v| f64::from(v).powi(2)).sum();
            ensure!(
                (norm - 1.0).abs() < 1e-4,
                "shot {index} direction is not a unit vector"
            );
            previous_tick = Some(shot.tick);
        }
        Ok(())
    }

    /// Called once per simulation tick, before the physics step. Validation
    /// guarantees that every input is within the run and ordered by tick.
    pub fn take_tick(&self, cursor: &mut usize, tick: u32) -> &[Shot] {
        let start = *cursor;
        while self
            .shots
            .get(*cursor)
            .is_some_and(|shot| shot.tick == tick)
        {
            *cursor += 1;
        }
        &self.shots[start..*cursor]
    }

    /// Completed runs write a new artifact; never replace an earlier measurement.
    pub fn write_new(&self, path: &Path) -> Result<()> {
        self.validate(&self.metadata)?;
        let mut bytes = serde_json::to_vec_pretty(self)?;
        bytes.push(b'\n');
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .with_context(|| format!("create new shot tape {}", path.display()))?;
        file.write_all(&bytes).context("write completed shot tape")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn metadata() -> Metadata {
        Metadata {
            manifest_hash: "scene-identity".into(),
            hz: 60,
            ticks: 1200,
            gravity_bits: [0.0f32, -9.81, 0.0].map(f32::to_bits),
            shot_profile_bits: [1.2e7f32, 12.0, 2.5, 4.0, 0.5, 400.0].map(f32::to_bits),
        }
    }
    fn tape() -> Tape {
        let mut tape = Tape::new(metadata());
        // Include signed zero and a subnormal origin; JSON stores integer bits.
        tape.shots.push(Shot::new(
            60,
            [-0.0, f32::from_bits(1), 16777218.0],
            [0.0, 0.0, -1.0],
        ));
        tape.shots
            .push(Shot::new(60, [1.0, 2.0, 3.0], [1.0, 0.0, 0.0]));
        tape.shots
            .push(Shot::new(90, [4.0, 5.0, 6.0], [0.0, 1.0, 0.0]));
        tape
    }
    #[test]
    fn json_round_trip_preserves_input_bits_and_multiple_shots_in_a_tick() {
        let original = tape();
        let decoded: Tape =
            serde_json::from_slice(&serde_json::to_vec(&original).unwrap()).unwrap();
        decoded.validate(&metadata()).unwrap();
        assert_eq!(original, decoded);
        assert_eq!(
            decoded.shots[0].origin().map(f32::to_bits),
            original.shots[0].origin_bits
        );
        assert_eq!(
            decoded.shots[0].direction().map(f32::to_bits),
            original.shots[0].direction_bits
        );
    }
    #[test]
    fn metadata_mismatch_is_rejected() {
        for which in 0..6 {
            let mut other = metadata();
            match which {
                0 => other.manifest_hash.push('x'),
                1 => other.hz += 1,
                2 => other.ticks += 1,
                3 => other.gravity_bits[1] += 1,
                4 => other.shot_profile_bits[0] += 1,
                _ => other.shot_profile_bits[5] += 1,
            }
            assert!(tape().validate(&other).is_err());
        }
    }
    #[test]
    fn invalid_or_unsupported_inputs_are_rejected() {
        for which in 0..6 {
            let mut tape = tape();
            match which {
                0 => tape.version += 1,
                1 => tape.shots[1].tick = 59,
                2 => tape.shots[2].tick = metadata().ticks,
                3 => tape.shots[0].origin_bits[0] = f32::NAN.to_bits(),
                4 => tape.shots[0].direction_bits = [0; 3],
                _ => tape.shots[0].direction_bits[0] = f32::INFINITY.to_bits(),
            }
            assert!(tape.validate(&metadata()).is_err());
        }
        let mut json = serde_json::to_value(tape()).unwrap();
        json.as_object_mut()
            .unwrap()
            .insert("unknown".into(), true.into());
        assert!(serde_json::from_value::<Tape>(json).is_err());
    }
    #[test]
    fn replay_dispatch_preserves_every_input_in_tick_order() {
        let tape = tape();
        let mut cursor = 0;
        let mut observed = Vec::new();
        for tick in 0..tape.metadata.ticks {
            let shots = tape.take_tick(&mut cursor, tick);
            assert!(shots.iter().all(|shot| shot.tick == tick));
            if tick == 60 {
                assert_eq!(shots.len(), 2);
            }
            observed.extend_from_slice(shots);
        }
        assert_eq!(cursor, tape.shots.len());
        assert_eq!(observed, tape.shots);
    }
    #[test]
    fn completed_artifact_cannot_overwrite_an_earlier_run() {
        let path = std::env::temp_dir().join(format!("shot-tape-{}.json", std::process::id()));
        let original = tape();
        original.write_new(&path).unwrap();
        let before = fs::read(&path).unwrap();
        assert_eq!(Tape::read(&path, &metadata()).unwrap(), original);
        assert!(original.write_new(&path).is_err());
        assert_eq!(fs::read(&path).unwrap(), before);
        fs::remove_file(path).unwrap();
    }
    #[test]
    fn a_quiet_run_can_have_no_shots() {
        Tape::new(metadata()).validate(&metadata()).unwrap();
    }
}
