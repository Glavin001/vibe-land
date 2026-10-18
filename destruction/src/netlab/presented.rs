//! Reader for the VLPRES01 stream the TS replay writes: what the shipping
//! client displayed, per body, per render frame.
//!
//! Header: `VLPRES01`, u32 hz, u32 frame_hz, u32 first_tick. Frame: u32 sim
//! tick the frame was sampled at, f32 render tick, f32 playout delay ticks,
//! u32 changed count, then (u32 key, f32 pos x3, f32 quat x4) per changed
//! body, u32 retired count, u32 keys. Only bodies whose ledger pose changed
//! are listed; a reader holds the rest forward.

use std::io::{BufReader, Read};
use std::path::Path;

use glam::{Quat, Vec3};

use crate::types::Pose;

pub struct PresentedFrame {
    pub sim_tick: u32,
    pub render_tick: f32,
    pub playout_delay_ticks: f32,
    pub changed: Vec<(u32, Pose)>,
    pub retired: Vec<u32>,
}

pub struct PresentedReader {
    input: Box<dyn Read>,
    pub hz: u32,
    pub frame_hz: u32,
    pub first_tick: u32,
}

impl PresentedReader {
    pub fn open(path: &Path) -> std::io::Result<Self> {
        use std::io::{Seek, SeekFrom};
        let mut file = std::fs::File::open(path)?;
        let mut head = [0u8; 4];
        let sniffed = file.read(&mut head)?;
        file.seek(SeekFrom::Start(0))?;
        let mut input: Box<dyn Read> = if sniffed == 4 && head == [0x28, 0xB5, 0x2F, 0xFD] {
            Box::new(BufReader::new(zstd::stream::read::Decoder::new(file)?))
        } else {
            Box::new(BufReader::new(file))
        };
        let mut magic = [0u8; 8];
        input.read_exact(&mut magic)?;
        if &magic != b"VLPRES01" {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "not a VLPRES01 presented stream",
            ));
        }
        let hz = read_u32(&mut input)?;
        let frame_hz = read_u32(&mut input)?;
        let first_tick = read_u32(&mut input)?;
        Ok(Self { input, hz, frame_hz, first_tick })
    }

    pub fn next_frame(&mut self) -> std::io::Result<Option<PresentedFrame>> {
        let sim_tick = match read_u32(&mut self.input) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
            Err(error) => return Err(error),
        };
        let render_tick = read_f32(&mut self.input)?;
        let playout_delay_ticks = read_f32(&mut self.input)?;
        let count = read_u32(&mut self.input)? as usize;
        if count > 4_000_000 {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "frame too large"));
        }
        let mut changed = Vec::with_capacity(count);
        let mut record = [0u8; 32];
        for _ in 0..count {
            self.input.read_exact(&mut record)?;
            let key = u32::from_le_bytes([record[0], record[1], record[2], record[3]]);
            let f = |at: usize| f32::from_le_bytes([record[at], record[at + 1], record[at + 2], record[at + 3]]);
            changed.push((
                key,
                Pose {
                    position: Vec3::new(f(4), f(8), f(12)),
                    rotation: Quat::from_xyzw(f(16), f(20), f(24), f(28)),
                },
            ));
        }
        let retired_count = read_u32(&mut self.input)? as usize;
        if retired_count > 4_000_000 {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "frame too large"));
        }
        let mut retired = Vec::with_capacity(retired_count);
        for _ in 0..retired_count {
            retired.push(read_u32(&mut self.input)?);
        }
        Ok(Some(PresentedFrame { sim_tick, render_tick, playout_delay_ticks, changed, retired }))
    }
}

fn read_u32<R: Read>(input: &mut R) -> std::io::Result<u32> {
    let mut buffer = [0u8; 4];
    input.read_exact(&mut buffer)?;
    Ok(u32::from_le_bytes(buffer))
}

fn read_f32<R: Read>(input: &mut R) -> std::io::Result<f32> {
    let mut buffer = [0u8; 4];
    input.read_exact(&mut buffer)?;
    Ok(f32::from_le_bytes(buffer))
}
