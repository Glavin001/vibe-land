//! The client tape (`VLCTAPE2`, `client/src/city/cityTape.ts`): read the
//! recorded one, write the lab's.
//!
//! The lab writes what reached its simulated client in the very format the
//! live client records, so the TS client stage replays the lab's stream and
//! the recorded stream through identical code (`cityTape.ts` decode +
//! `cityReplay.ts` dispatch). Layout, little-endian: magic; u32 header
//! length; JSON header; `frames` x `frameBytes` frame records; then packets
//! as `[f64 tMs][u32 len][u8 channel][bytes]`.

use std::io::Write;
use std::path::Path;

pub const MAGIC_V2: &[u8; 8] = b"VLCTAPE2";
pub const MAGIC_V2_LEGACY: &[u8; 8] = b"VLTAPE02";
pub const CHANNEL_CITY: u8 = 0;
pub const CHANNEL_WT_RELIABLE: u8 = 1;
pub const CHANNEL_WT_DATAGRAM: u8 = 2;
pub const CHANNEL_WEBSOCKET: u8 = 3;
pub const CHANNEL_RTT: u8 = 4;
pub const CHANNEL_PRELUDE: u8 = 0x80;

#[derive(Clone, Debug)]
pub struct TapePacket {
    pub t_ms: f64,
    pub channel: u8,
    pub bytes: Vec<u8>,
}

impl TapePacket {
    pub fn is_prelude(&self) -> bool {
        self.channel & CHANNEL_PRELUDE != 0
    }

    pub fn base_channel(&self) -> u8 {
        self.channel & !CHANNEL_PRELUDE
    }

    pub fn kind(&self) -> u8 {
        self.bytes.first().copied().unwrap_or(0)
    }
}

/// One recorded frame: when it was drawn and the clock it was drawn at.
#[derive(Clone, Copy, Debug, Default)]
pub struct Frame {
    pub t_ms: f32,
    pub frame_ms: f32,
    /// Server-clock offset on the recording PAGE's clock (add the header's
    /// `clockOriginMs` x 1000 for the tape clock), us.
    pub offset_us: f64,
    pub interp_delay_ms: f32,
    pub dyn_delay_ms: f32,
}

#[derive(Clone, Debug)]
pub struct ClientTape {
    pub header: serde_json::Value,
    pub frame_bytes: usize,
    /// The frame block exactly as read, so the lab's tape carries the
    /// recorded frames (render cadence and live clock state) unchanged.
    pub frames_raw: Vec<u8>,
    pub frames: Vec<Frame>,
    pub packets: Vec<TapePacket>,
}

impl ClientTape {
    pub fn read(path: &Path) -> std::io::Result<Self> {
        let bytes = std::fs::read(path)?;
        Self::parse(&bytes)
    }

    pub fn parse(bytes: &[u8]) -> std::io::Result<Self> {
        let bad = |what: &str| std::io::Error::new(std::io::ErrorKind::InvalidData, what.to_string());
        if bytes.len() < 12 {
            return Err(bad("short client tape"));
        }
        let magic: &[u8] = &bytes[..8];
        if magic != MAGIC_V2 && !(magic == MAGIC_V2_LEGACY && bytes.get(12) == Some(&b'{')) {
            return Err(bad("not a VLCTAPE2 client tape"));
        }
        let header_len = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
        let mut at = 12 + header_len;
        let header: serde_json::Value =
            serde_json::from_slice(bytes.get(12..at).ok_or_else(|| bad("short header"))?)?;
        let frame_count = header["frames"].as_u64().unwrap_or(0) as usize;
        let frame_bytes = header["frameBytes"].as_u64().unwrap_or(16) as usize;
        let frames_end = at + frame_count * frame_bytes;
        let frames_raw = bytes.get(at..frames_end).ok_or_else(|| bad("short frames"))?.to_vec();
        let mut frames = Vec::with_capacity(frame_count);
        for index in 0..frame_count {
            let f = &frames_raw[index * frame_bytes..(index + 1) * frame_bytes];
            let f32_at = |o: usize| f32::from_le_bytes(f[o..o + 4].try_into().unwrap());
            let mut frame = Frame { t_ms: f32_at(0), frame_ms: f32_at(4), ..Default::default() };
            if frame_bytes >= 60 {
                frame.offset_us = f64::from_le_bytes(f[44..52].try_into().unwrap());
                frame.interp_delay_ms = f32_at(52);
                frame.dyn_delay_ms = f32_at(56);
            } else {
                frame.offset_us = f64::NAN;
                frame.interp_delay_ms = f32::NAN;
                frame.dyn_delay_ms = f32::NAN;
            }
            frames.push(frame);
        }
        at = frames_end;
        let mut packets = Vec::new();
        while at + 13 <= bytes.len() {
            let t_ms = f64::from_le_bytes(bytes[at..at + 8].try_into().unwrap());
            let len = u32::from_le_bytes(bytes[at + 8..at + 12].try_into().unwrap()) as usize;
            let channel = bytes[at + 12];
            at += 13;
            let Some(body) = bytes.get(at..at + len) else {
                break;
            };
            packets.push(TapePacket { t_ms, channel, bytes: body.to_vec() });
            at += len;
        }
        Ok(Self { header, frame_bytes, frames_raw, frames, packets })
    }

    /// `clockOriginMs`: the recording page's `performance.now()` at tape 0.
    pub fn clock_origin_ms(&self) -> f64 {
        self.header["clockOriginMs"].as_f64().unwrap_or(0.0)
    }

    pub fn local_player_id(&self) -> Option<u32> {
        self.header["localPlayerId"].as_u64().map(|id| id as u32)
    }

    /// Writes a tape with this tape's header and frames and `packets`.
    pub fn write_with_packets(
        &self,
        path: &Path,
        packets: &[TapePacket],
        header_patch: serde_json::Value,
    ) -> std::io::Result<()> {
        let mut header = self.header.clone();
        let total_bytes: usize = packets.iter().map(|p| p.bytes.len()).sum();
        header["packets"] = serde_json::json!(packets.len());
        header["bytes"] = serde_json::json!(total_bytes);
        header["prelude"] = serde_json::json!(packets.iter().filter(|p| p.is_prelude()).count());
        let mut channels = serde_json::Map::new();
        for packet in packets {
            let name = channel_name(packet.channel);
            let entry = channels.entry(name).or_insert_with(|| serde_json::json!({"packets": 0, "bytes": 0}));
            entry["packets"] = serde_json::json!(entry["packets"].as_u64().unwrap_or(0) + 1);
            entry["bytes"] =
                serde_json::json!(entry["bytes"].as_u64().unwrap_or(0) + packet.bytes.len() as u64);
        }
        header["channels"] = serde_json::Value::Object(channels);
        if let serde_json::Value::Object(patch) = header_patch {
            for (key, value) in patch {
                header[key] = value;
            }
        }
        let header_bytes = serde_json::to_vec(&header)?;
        let mut out = std::io::BufWriter::new(std::fs::File::create(path)?);
        out.write_all(MAGIC_V2)?;
        out.write_all(&(header_bytes.len() as u32).to_le_bytes())?;
        out.write_all(&header_bytes)?;
        out.write_all(&self.frames_raw)?;
        for packet in packets {
            out.write_all(&packet.t_ms.to_le_bytes())?;
            out.write_all(&(packet.bytes.len() as u32).to_le_bytes())?;
            out.write_all(&[packet.channel])?;
            out.write_all(&packet.bytes)?;
        }
        out.flush()
    }
}

pub fn channel_name(channel: u8) -> String {
    let base = match channel & !CHANNEL_PRELUDE {
        CHANNEL_CITY => "city".to_string(),
        CHANNEL_WT_RELIABLE => "wt-reliable".to_string(),
        CHANNEL_WT_DATAGRAM => "wt-datagram".to_string(),
        CHANNEL_WEBSOCKET => "websocket".to_string(),
        CHANNEL_RTT => "rtt".to_string(),
        other => format!("channel-{other}"),
    };
    if channel & CHANNEL_PRELUDE != 0 {
        format!("{base}+prelude")
    } else {
        base
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tape_round_trips() {
        let tape = ClientTape {
            header: serde_json::json!({"version": 2, "frames": 1, "frameBytes": 60, "clockOriginMs": 12.5}),
            frame_bytes: 60,
            frames_raw: {
                let mut raw = vec![0u8; 60];
                raw[0..4].copy_from_slice(&16.5f32.to_le_bytes());
                raw[44..52].copy_from_slice(&(-1234.5f64).to_le_bytes());
                raw
            },
            frames: Vec::new(),
            packets: Vec::new(),
        };
        let dir = std::env::temp_dir().join(format!("netlab2-tape-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.vltape");
        let packets = vec![
            TapePacket { t_ms: 0.0, channel: CHANNEL_WT_RELIABLE | CHANNEL_PRELUDE, bytes: vec![101, 1] },
            TapePacket { t_ms: 3.25, channel: CHANNEL_WT_DATAGRAM, bytes: vec![112, 2, 3] },
        ];
        tape.write_with_packets(&path, &packets, serde_json::json!({"netlab": {"profile": "x"}}))
            .unwrap();
        let back = ClientTape::read(&path).unwrap();
        assert_eq!(back.packets.len(), 2);
        assert_eq!(back.packets[1].t_ms, 3.25);
        assert_eq!(back.packets[1].bytes, vec![112, 2, 3]);
        assert!(back.packets[0].is_prelude());
        assert_eq!(back.frames.len(), 1);
        assert_eq!(back.frames[0].t_ms, 16.5);
        assert_eq!(back.frames[0].offset_us, -1234.5);
        assert_eq!(back.header["netlab"]["profile"], "x");
        assert_eq!(back.header["prelude"], 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
