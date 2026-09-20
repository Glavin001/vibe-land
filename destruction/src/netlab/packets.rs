//! The client-bound byte log a replay writes and the shipping TS client
//! reads back.
//!
//! One line per packet: `{"tick":N,"chan":"r"|"d","hex":"..."}`. The tick is
//! the tick the packet became available to the client (send tick offline;
//! arrival tick from a bot on a real link), `r` is the ordered reliable
//! stream and `d` a droppable datagram. `client/tools/replay-city-client.mts`
//! feeds these bytes through `CityClient` unchanged, which is what makes the
//! offline view path the product's own code rather than a model of it.

use std::path::Path;

pub const PACKETS_FILE: &str = "packets.jsonl";

pub struct PacketLog {
    writer: std::io::BufWriter<std::fs::File>,
    pub bytes: u64,
    pub reliable_bytes: u64,
    pub datagrams: u64,
    pub reliable_packets: u64,
    hex: String,
}

impl PacketLog {
    pub fn create(dir: &Path) -> std::io::Result<Self> {
        std::fs::create_dir_all(dir)?;
        Ok(Self {
            writer: std::io::BufWriter::new(std::fs::File::create(dir.join(PACKETS_FILE))?),
            bytes: 0,
            reliable_bytes: 0,
            datagrams: 0,
            reliable_packets: 0,
            hex: String::new(),
        })
    }

    /// `chan`: 'r' = reliable stream, 'd' = droppable datagram.
    pub fn push(&mut self, tick: u32, chan: char, bytes: &[u8]) -> std::io::Result<()> {
        use std::fmt::Write as _;
        use std::io::Write as _;
        self.hex.clear();
        for byte in bytes {
            write!(self.hex, "{byte:02x}").expect("hex write");
        }
        writeln!(
            self.writer,
            "{{\"tick\":{tick},\"chan\":\"{chan}\",\"hex\":\"{}\"}}",
            self.hex
        )?;
        self.bytes += bytes.len() as u64;
        if chan == 'r' {
            self.reliable_bytes += bytes.len() as u64;
            self.reliable_packets += 1;
        } else {
            self.datagrams += 1;
        }
        Ok(())
    }

    pub fn finish(mut self) -> std::io::Result<(u64, u64)> {
        use std::io::Write as _;
        self.writer.flush()?;
        Ok((self.bytes, self.reliable_bytes))
    }
}

/// One logged packet, read back.
#[derive(Clone, Debug, PartialEq)]
pub struct LoggedPacket {
    pub tick: u32,
    pub reliable: bool,
    pub bytes: Vec<u8>,
}

/// Read a log back, in file order.
pub fn read_log(path: &Path) -> std::io::Result<Vec<LoggedPacket>> {
    let text = std::fs::read_to_string(path)?;
    let mut out = Vec::new();
    for (index, line) in text.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let value: serde_json::Value = serde_json::from_str(line).map_err(|error| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("{}:{}: {error}", path.display(), index + 1),
            )
        })?;
        let tick = value["tick"].as_u64().unwrap_or(0) as u32;
        let reliable = value["chan"].as_str() == Some("r");
        let hex = value["hex"].as_str().unwrap_or("");
        let mut bytes = Vec::with_capacity(hex.len() / 2);
        for pair in 0..hex.len() / 2 {
            bytes.push(u8::from_str_radix(&hex[pair * 2..pair * 2 + 2], 16).map_err(|error| {
                std::io::Error::new(std::io::ErrorKind::InvalidData, format!("bad hex: {error}"))
            })?);
        }
        out.push(LoggedPacket { tick, reliable, bytes });
    }
    Ok(out)
}
