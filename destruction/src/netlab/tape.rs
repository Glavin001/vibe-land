//! A recording of exactly what the physics half handed the encoder, tick by
//! tick, so the encoder can be re-run against it any number of times.
//!
//! Why this exists: the GPU destruction sim is not bit-deterministic. Two runs
//! of the identical scripted collapse, driven from the identical shot tape,
//! produced 6,740 and 7,052 broken bonds, and fall-notification p99 of 42 and
//! 34 ticks. That noise is larger than most scheduling changes worth making,
//! so comparing two recorded runs cannot establish that a change helped.
//!
//! Replaying a tape removes the variable entirely: the motion is byte-identical
//! across configurations, so a difference in the send audit is caused by the
//! configuration and nothing else. It is also far faster than the sim and needs
//! no GPU, which is what makes sweeping a parameter affordable.
//!
//! What it is NOT: a substitute for recording. A tape is only as representative
//! as the run that produced it, and a scheduling change that would have altered
//! the physics (it cannot -- the stream is read-only) or the player's camera
//! (it can, via interest) is outside what a tape can answer on its own.

use std::io::{BufReader, BufWriter, Read, Write};
use std::path::Path;

use vibe_netcode::destruction_backend::{
    DestructionTickOutput, FractureBatch, IslandPromotion, SettleEvent, ShapeMigration,
};

use crate::encoder::BodySnapshotInput;

const MAGIC: &[u8; 8] = b"VLTAPE02";

/// The camera interest was evaluated from when the tape was recorded.
///
/// Carried in the tape rather than passed on the replay command line: interest
/// and the pixel error budget are both camera-dependent, so a replay from a
/// different viewpoint is measuring a different question while looking like a
/// comparison. The recorder derives this from the scene extent and then
/// overrides the field of view, which is not something a replay can re-derive.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TapeCamera {
    pub eye: [f32; 3],
    pub direction: [f32; 3],
    pub fov_degrees: f32,
}

/// One tick of encoder input.
#[derive(Clone, Debug, Default)]
pub struct TapeTick {
    pub tick: u32,
    pub snapshots: Vec<BodySnapshotInput>,
    pub output: DestructionTickOutput,
}

// --- little-endian primitives -------------------------------------------

struct Writer<W: Write> {
    inner: W,
}

impl<W: Write> Writer<W> {
    fn u32(&mut self, value: u32) -> std::io::Result<()> {
        self.inner.write_all(&value.to_le_bytes())
    }
    fn u16(&mut self, value: u16) -> std::io::Result<()> {
        self.inner.write_all(&value.to_le_bytes())
    }
    fn u8(&mut self, value: u8) -> std::io::Result<()> {
        self.inner.write_all(&[value])
    }
    fn f32(&mut self, value: f32) -> std::io::Result<()> {
        self.inner.write_all(&value.to_le_bytes())
    }
    fn f32s(&mut self, values: &[f32]) -> std::io::Result<()> {
        for value in values {
            self.f32(*value)?;
        }
        Ok(())
    }
    fn len(&mut self, value: usize) -> std::io::Result<()> {
        self.u32(u32::try_from(value).map_err(|_| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, "tape count exceeds u32")
        })?)
    }
}

struct Reader<R: Read> {
    inner: R,
}

impl<R: Read> Reader<R> {
    fn exact<const N: usize>(&mut self) -> std::io::Result<[u8; N]> {
        let mut buffer = [0u8; N];
        self.inner.read_exact(&mut buffer)?;
        Ok(buffer)
    }
    fn u32(&mut self) -> std::io::Result<u32> {
        Ok(u32::from_le_bytes(self.exact::<4>()?))
    }
    fn u16(&mut self) -> std::io::Result<u16> {
        Ok(u16::from_le_bytes(self.exact::<2>()?))
    }
    fn u8(&mut self) -> std::io::Result<u8> {
        Ok(self.exact::<1>()?[0])
    }
    fn f32(&mut self) -> std::io::Result<f32> {
        Ok(f32::from_le_bytes(self.exact::<4>()?))
    }
    fn f32x3(&mut self) -> std::io::Result<[f32; 3]> {
        Ok([self.f32()?, self.f32()?, self.f32()?])
    }
    fn f32x4(&mut self) -> std::io::Result<[f32; 4]> {
        Ok([self.f32()?, self.f32()?, self.f32()?, self.f32()?])
    }
    /// Bounded, so a corrupt length cannot make the reader allocate a
    /// gigabyte before it discovers the file is short.
    fn len(&mut self, limit: usize, what: &str) -> std::io::Result<usize> {
        let value = self.u32()? as usize;
        if value > limit {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("tape declares {value} {what}, over the {limit} limit"),
            ));
        }
        Ok(value)
    }
}

/// Generous but finite caps: a downtown collapse peaks around 1,500 bodies
/// and a fracture tick around a few thousand bonds.
const MAX_PER_TICK: usize = 4_000_000;

// --- writing -------------------------------------------------------------

pub struct TapeWriter {
    out: Writer<BufWriter<std::fs::File>>,
    ticks: u32,
}

impl TapeWriter {
    pub fn create(
        path: &Path,
        hz: u32,
        manifest_hash: [u8; 32],
        camera: TapeCamera,
    ) -> std::io::Result<Self> {
        let file = std::fs::File::create(path)?;
        let mut out = Writer { inner: BufWriter::new(file) };
        out.inner.write_all(MAGIC)?;
        out.u32(hz)?;
        out.inner.write_all(&manifest_hash)?;
        out.f32s(&camera.eye)?;
        out.f32s(&camera.direction)?;
        out.f32(camera.fov_degrees)?;
        Ok(Self { out, ticks: 0 })
    }

    pub fn push(
        &mut self,
        tick: u32,
        snapshots: &[BodySnapshotInput],
        output: &DestructionTickOutput,
    ) -> std::io::Result<()> {
        self.out.u32(tick)?;
        self.out.len(snapshots.len())?;
        for snapshot in snapshots {
            self.out.u32(snapshot.body_entity)?;
            self.out.f32s(&snapshot.position)?;
            self.out.f32s(&snapshot.rotation)?;
            self.out.f32s(&snapshot.linear_velocity)?;
            self.out.f32s(&snapshot.angular_velocity)?;
            self.out.u16(snapshot.contacts)?;
            self.out.u8(snapshot.flags)?;
        }
        self.out.len(output.batches.len())?;
        for batch in &output.batches {
            self.out.u32(batch.structure_id)?;
            self.out.len(batch.broken_bond_ids.len())?;
            for id in &batch.broken_bond_ids {
                self.out.u32(*id)?;
            }
            self.out.len(batch.migrations.len())?;
            for migration in &batch.migrations {
                self.out.u32(migration.chunk_id)?;
                self.out.u32(migration.from_island_id)?;
                self.out.u32(migration.to_island_id)?;
            }
            self.out.len(batch.promoted_islands.len())?;
            for island in &batch.promoted_islands {
                self.out.u32(island.structure_id)?;
                self.out.u32(island.island_id)?;
                self.out.len(island.chunks.len())?;
                for chunk in &island.chunks {
                    self.out.u32(*chunk)?;
                }
                self.out.f32(island.mass)?;
                self.out.f32s(&island.center_of_mass)?;
                self.out.f32s(&island.inertia_diagonal)?;
                self.out.f32s(&island.position)?;
                self.out.f32s(&island.rotation)?;
                self.out.f32s(&island.linear_velocity)?;
                self.out.f32s(&island.angular_velocity)?;
                self.out.f32s(&island.split_impulse)?;
            }
            self.out.len(batch.retired_island_ids.len())?;
            for id in &batch.retired_island_ids {
                self.out.u32(*id)?;
            }
        }
        self.out.len(output.settled.len())?;
        for settle in &output.settled {
            self.out.u32(settle.structure_id)?;
            self.out.u32(settle.island_id)?;
            self.out.f32s(&settle.position)?;
            self.out.f32s(&settle.rotation)?;
        }
        self.out.len(output.wakes.len())?;
        for (structure, island) in &output.wakes {
            self.out.u32(*structure)?;
            self.out.u32(*island)?;
        }
        self.ticks += 1;
        Ok(())
    }

    pub fn finish(mut self) -> std::io::Result<u32> {
        self.out.inner.flush()?;
        Ok(self.ticks)
    }
}

// --- reading -------------------------------------------------------------

pub struct TapeReader {
    input: Reader<BufReader<std::fs::File>>,
    pub hz: u32,
    pub manifest_hash: [u8; 32],
    pub camera: TapeCamera,
}

impl TapeReader {
    pub fn open(path: &Path) -> std::io::Result<Self> {
        let file = std::fs::File::open(path)?;
        let mut input = Reader { inner: BufReader::new(file) };
        let magic = input.exact::<8>()?;
        if &magic != MAGIC {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "not a VLTAPE02 encoder tape",
            ));
        }
        let hz = input.u32()?;
        let manifest_hash = input.exact::<32>()?;
        let camera = TapeCamera {
            eye: input.f32x3()?,
            direction: input.f32x3()?,
            fov_degrees: input.f32()?,
        };
        Ok(Self { input, hz, manifest_hash, camera })
    }

    /// Next tick, or `None` at a clean end of file.
    pub fn next_tick(&mut self) -> std::io::Result<Option<TapeTick>> {
        let tick = match self.input.u32() {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
            Err(error) => return Err(error),
        };
        let count = self.input.len(MAX_PER_TICK, "snapshots")?;
        let mut snapshots = Vec::with_capacity(count);
        for _ in 0..count {
            snapshots.push(BodySnapshotInput {
                body_entity: self.input.u32()?,
                position: self.input.f32x3()?,
                rotation: self.input.f32x4()?,
                linear_velocity: self.input.f32x3()?,
                angular_velocity: self.input.f32x3()?,
                contacts: self.input.u16()?,
                flags: self.input.u8()?,
            });
        }
        let batch_count = self.input.len(MAX_PER_TICK, "batches")?;
        let mut batches = Vec::with_capacity(batch_count);
        for _ in 0..batch_count {
            let structure_id = self.input.u32()?;
            let broken = self.input.len(MAX_PER_TICK, "broken bonds")?;
            let mut broken_bond_ids = Vec::with_capacity(broken);
            for _ in 0..broken {
                broken_bond_ids.push(self.input.u32()?);
            }
            let migration_count = self.input.len(MAX_PER_TICK, "migrations")?;
            let mut migrations = Vec::with_capacity(migration_count);
            for _ in 0..migration_count {
                migrations.push(ShapeMigration {
                    chunk_id: self.input.u32()?,
                    from_island_id: self.input.u32()?,
                    to_island_id: self.input.u32()?,
                });
            }
            let promoted_count = self.input.len(MAX_PER_TICK, "promotions")?;
            let mut promoted_islands = Vec::with_capacity(promoted_count);
            for _ in 0..promoted_count {
                let structure_id = self.input.u32()?;
                let island_id = self.input.u32()?;
                let chunk_count = self.input.len(MAX_PER_TICK, "island chunks")?;
                let mut chunks = Vec::with_capacity(chunk_count);
                for _ in 0..chunk_count {
                    chunks.push(self.input.u32()?);
                }
                promoted_islands.push(IslandPromotion {
                    structure_id,
                    island_id,
                    chunks,
                    mass: self.input.f32()?,
                    center_of_mass: self.input.f32x3()?,
                    inertia_diagonal: self.input.f32x3()?,
                    position: self.input.f32x3()?,
                    rotation: self.input.f32x4()?,
                    linear_velocity: self.input.f32x3()?,
                    angular_velocity: self.input.f32x3()?,
                    split_impulse: self.input.f32x3()?,
                });
            }
            let retired_count = self.input.len(MAX_PER_TICK, "retirements")?;
            let mut retired_island_ids = Vec::with_capacity(retired_count);
            for _ in 0..retired_count {
                retired_island_ids.push(self.input.u32()?);
            }
            batches.push(FractureBatch {
                structure_id,
                broken_bond_ids,
                migrations,
                promoted_islands,
                retired_island_ids,
            });
        }
        let settle_count = self.input.len(MAX_PER_TICK, "settles")?;
        let mut settled = Vec::with_capacity(settle_count);
        for _ in 0..settle_count {
            settled.push(SettleEvent {
                structure_id: self.input.u32()?,
                island_id: self.input.u32()?,
                position: self.input.f32x3()?,
                rotation: self.input.f32x4()?,
            });
        }
        let wake_count = self.input.len(MAX_PER_TICK, "wakes")?;
        let mut wakes = Vec::with_capacity(wake_count);
        for _ in 0..wake_count {
            wakes.push((self.input.u32()?, self.input.u32()?));
        }
        Ok(Some(TapeTick {
            tick,
            snapshots,
            output: DestructionTickOutput { batches, settled, wakes },
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> TapeTick {
        TapeTick {
            tick: 42,
            snapshots: vec![
                BodySnapshotInput {
                    body_entity: 0x8000_0001,
                    position: [1.5, -2.25, 3.0],
                    rotation: [0.0, 0.7071, 0.0, 0.7071],
                    linear_velocity: [0.0, -9.8, 0.25],
                    angular_velocity: [0.1, 0.0, -0.2],
                    contacts: 3,
                    flags: 5,
                },
                BodySnapshotInput {
                    body_entity: 0x8000_0002,
                    position: [-100.0, 0.0, 12.5],
                    rotation: [0.0, 0.0, 0.0, 1.0],
                    linear_velocity: [0.0; 3],
                    angular_velocity: [0.0; 3],
                    contacts: 0,
                    flags: 0,
                },
            ],
            output: DestructionTickOutput {
                batches: vec![FractureBatch {
                    structure_id: 7,
                    broken_bond_ids: vec![11, 12, 13],
                    migrations: vec![ShapeMigration {
                        chunk_id: 900,
                        from_island_id: 1,
                        to_island_id: 2,
                    }],
                    promoted_islands: vec![IslandPromotion {
                        structure_id: 7,
                        island_id: 2,
                        chunks: vec![900, 901],
                        mass: 1250.5,
                        center_of_mass: [1.0, 2.0, 3.0],
                        inertia_diagonal: [4.0, 5.0, 6.0],
                        position: [7.0, 8.0, 9.0],
                        rotation: [0.1, 0.2, 0.3, 0.927],
                        linear_velocity: [-1.0, -2.0, -3.0],
                        angular_velocity: [0.5, 0.0, -0.5],
                        split_impulse: [10.0, 0.0, 0.0],
                    }],
                    retired_island_ids: vec![1],
                }],
                settled: vec![SettleEvent {
                    structure_id: 7,
                    island_id: 3,
                    position: [0.0, 0.5, 0.0],
                    rotation: [0.0, 0.0, 0.0, 1.0],
                }],
                wakes: vec![(7, 4)],
            },
        }
    }

    /// A tape that does not reproduce its input exactly is worse than no tape:
    /// every ablation run on it would be measuring the format's losses.
    #[test]
    fn a_tape_round_trips_a_tick_exactly() {
        let dir = std::env::temp_dir().join("vl-tape-roundtrip");
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("one.tape");
        let original = sample();

        let camera = TapeCamera {
            eye: [0.0, 40.0, 130.0],
            direction: [0.0, -0.3, -0.95],
            fov_degrees: 80.0,
        };
        let mut writer = TapeWriter::create(&path, 60, [7u8; 32], camera).expect("create");
        writer.push(original.tick, &original.snapshots, &original.output).expect("push");
        assert_eq!(writer.finish().expect("finish"), 1);

        let mut reader = TapeReader::open(&path).expect("open");
        assert_eq!(reader.hz, 60);
        assert_eq!(reader.manifest_hash, [7u8; 32]);
        assert_eq!(reader.camera, camera, "the replay must see the recorded viewpoint");
        let read = reader.next_tick().expect("read").expect("one tick");
        assert_eq!(read.tick, original.tick);
        assert_eq!(read.output, original.output);
        assert_eq!(read.snapshots.len(), original.snapshots.len());
        for (got, want) in read.snapshots.iter().zip(&original.snapshots) {
            assert_eq!(got.body_entity, want.body_entity);
            assert_eq!(got.position, want.position);
            assert_eq!(got.rotation, want.rotation);
            assert_eq!(got.linear_velocity, want.linear_velocity);
            assert_eq!(got.angular_velocity, want.angular_velocity);
            assert_eq!(got.contacts, want.contacts);
            assert_eq!(got.flags, want.flags);
        }
        assert!(reader.next_tick().expect("eof").is_none());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_foreign_file_is_refused_rather_than_misread() {
        let dir = std::env::temp_dir().join("vl-tape-roundtrip");
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("not-a-tape.bin");
        std::fs::write(&path, b"TWTRACE1 and then some bytes").expect("write");
        let error = match TapeReader::open(&path) {
            Ok(_) => panic!("a TWTRACE1 file must not open as an encoder tape"),
            Err(error) => error,
        };
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
        let _ = std::fs::remove_file(&path);
    }

    /// A truncated tape must stop, not hand back a half-read tick that would
    /// silently become a gap in the middle of an ablation.
    #[test]
    fn a_truncated_tape_errors_instead_of_returning_a_partial_tick() {
        let dir = std::env::temp_dir().join("vl-tape-roundtrip");
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("short.tape");
        let original = sample();
        let mut writer = TapeWriter::create(
            &path,
            60,
            [0u8; 32],
            TapeCamera { eye: [0.0; 3], direction: [0.0, 0.0, -1.0], fov_degrees: 60.0 },
        )
        .expect("create");
        writer.push(original.tick, &original.snapshots, &original.output).expect("push");
        writer.finish().expect("finish");

        let full = std::fs::read(&path).expect("read back");
        std::fs::write(&path, &full[..full.len() - 9]).expect("truncate");
        let mut reader = TapeReader::open(&path).expect("open");
        assert!(
            reader.next_tick().is_err(),
            "a short tick must not read as complete"
        );
        let _ = std::fs::remove_file(&path);
    }
}
