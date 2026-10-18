//! The compact match-stats frame pushed to every player once a second.
//!
//! It used to be the whole `/match-stats` snapshot as JSON: ~15 kB a second
//! per player on the ordered reliable stream, 29-34% of all bytes in the city
//! bench and 10.8% in a real session, queued in front of topology. The one
//! thing that reads it in game is the stats overlay, which shows about fifty
//! numbers; the tape analysis reads a few more. This frame carries exactly
//! those (`shared/match-stats-frame.json`, read by the client too) in ~250
//! bytes, and goes as a datagram: it is state, the next second replaces a
//! lost one, and it never waits in front of -- or makes wait -- the ordered
//! stream. The full snapshot stays on `GET /match-stats/:id`.
//!
//! Layout (little endian):
//!
//! ```text
//! u8  PKT_MATCH_STATS
//! u8  format (1)            -- a legacy JSON packet has b'{' here
//! u32 server_tick
//! u16 field count N         -- the first N entries of the field table
//! N × field, by type:  f  f32, NaN = absent
//!                      u  u32, u32::MAX = absent, saturates below it
//!                      b  u8 0/1, 0xFF = absent
//!                      s  u8 length (0xFF = absent) + UTF-8
//! ```
use std::sync::OnceLock;

use serde_json::Value;
use vibe_land_shared::constants::PKT_MATCH_STATS;

/// The field table, shared with the client.
const FIELDS_JSON: &str = include_str!("../../shared/match-stats-frame.json");

pub(crate) const FORMAT: u8 = 1;
const ABSENT_U32: u32 = u32::MAX;
const ABSENT_BYTE: u8 = 0xFF;
const MAX_STRING_BYTES: usize = 254;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FieldType {
    F32,
    U32,
    Bool,
    Str,
}

struct Field {
    path: Vec<String>,
    kind: FieldType,
}

fn fields() -> &'static [Field] {
    static FIELDS: OnceLock<Vec<Field>> = OnceLock::new();
    FIELDS.get_or_init(|| {
        let table: Value =
            serde_json::from_str(FIELDS_JSON).expect("shared/match-stats-frame.json is valid JSON");
        assert_eq!(
            table["format"].as_u64(),
            Some(u64::from(FORMAT)),
            "match-stats-frame.json format does not match the encoder"
        );
        table["fields"]
            .as_array()
            .expect("match-stats-frame.json has a fields array")
            .iter()
            .map(|entry| {
                let path = entry[0]
                    .as_array()
                    .expect("field path is an array")
                    .iter()
                    .map(|key| key.as_str().expect("path keys are strings").to_owned())
                    .collect();
                let kind = match entry[1].as_str() {
                    Some("f") => FieldType::F32,
                    Some("u") => FieldType::U32,
                    Some("b") => FieldType::Bool,
                    Some("s") => FieldType::Str,
                    other => panic!("unknown match-stats field type {other:?}"),
                };
                Field { path, kind }
            })
            .collect()
    })
}

fn lookup<'a>(root: &'a Value, path: &[String]) -> Option<&'a Value> {
    path.iter()
        .try_fold(root, |value, key| value.get(key.as_str()))
        .filter(|value| !value.is_null())
}

/// Encode `stats` (the serialized `/match-stats` snapshot) as one frame.
pub(crate) fn encode(server_tick: u32, stats: &Value) -> Vec<u8> {
    let fields = fields();
    let mut out = Vec::with_capacity(8 + fields.len() * 4 + 48);
    out.push(PKT_MATCH_STATS);
    out.push(FORMAT);
    out.extend_from_slice(&server_tick.to_le_bytes());
    out.extend_from_slice(&(fields.len() as u16).to_le_bytes());
    for field in fields {
        let value = lookup(stats, &field.path);
        match field.kind {
            FieldType::F32 => {
                let v = value.and_then(Value::as_f64).map_or(f32::NAN, |v| v as f32);
                out.extend_from_slice(&v.to_le_bytes());
            }
            FieldType::U32 => {
                let v = value
                    .and_then(|v| v.as_u64().or_else(|| v.as_f64().map(|f| f.max(0.0) as u64)))
                    .map_or(ABSENT_U32, |v| v.min(u64::from(ABSENT_U32 - 1)) as u32);
                out.extend_from_slice(&v.to_le_bytes());
            }
            FieldType::Bool => {
                out.push(value.and_then(Value::as_bool).map_or(ABSENT_BYTE, u8::from));
            }
            FieldType::Str => match value.and_then(Value::as_str) {
                Some(s) => {
                    let mut end = s.len().min(MAX_STRING_BYTES);
                    while !s.is_char_boundary(end) {
                        end -= 1;
                    }
                    out.push(end as u8);
                    out.extend_from_slice(&s.as_bytes()[..end]);
                }
                None => out.push(ABSENT_BYTE),
            },
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Value {
        serde_json::json!({
            "server_build": "10:59:11",
            "server_started": "11:19:40",
            "physics_backend": "physx_gpu",
            "physics_gpu_active": true,
            "player_count": 3,
            "physics_last_step_ms": 11.5,
            "server_tick": 999,
            "timings": { "total_ms": { "avg": 12.25, "p95": 27.5, "max": 52.0 } },
            "spans": { "destruction/native_escaped_bodies": { "v": 2.0, "k": "gauge" } },
            "city": { "structures": 16, "freeze_flips": 5_000_000_000u64, "degraded": false, "step_ms": 0.5 },
            // Not in the table: must not reach the wire.
            "players": [{ "id": 1, "name": "x" }],
            "network": { "snapshot_bytes_per_client": { "avg": 100.0 } }
        })
    }

    /// Byte-level walk of the frame, mirroring the client's decoder.
    fn decode(frame: &[u8]) -> (u32, Vec<Option<String>>) {
        assert_eq!(frame[0], PKT_MATCH_STATS);
        assert_eq!(frame[1], FORMAT);
        let tick = u32::from_le_bytes(frame[2..6].try_into().unwrap());
        let n = u16::from_le_bytes(frame[6..8].try_into().unwrap()) as usize;
        let mut o = 8;
        let mut values = Vec::new();
        for field in &fields()[..n] {
            values.push(match field.kind {
                FieldType::F32 => {
                    let v = f32::from_le_bytes(frame[o..o + 4].try_into().unwrap());
                    o += 4;
                    (!v.is_nan()).then(|| v.to_string())
                }
                FieldType::U32 => {
                    let v = u32::from_le_bytes(frame[o..o + 4].try_into().unwrap());
                    o += 4;
                    (v != ABSENT_U32).then(|| v.to_string())
                }
                FieldType::Bool => {
                    let v = frame[o];
                    o += 1;
                    (v != ABSENT_BYTE).then(|| (v == 1).to_string())
                }
                FieldType::Str => {
                    let len = frame[o] as usize;
                    o += 1;
                    if len == ABSENT_BYTE as usize {
                        None
                    } else {
                        o += len;
                        Some(String::from_utf8(frame[o - len..o].to_vec()).unwrap())
                    }
                }
            });
        }
        assert_eq!(o, frame.len(), "no trailing bytes");
        (tick, values)
    }

    fn value_of(values: &[Option<String>], path: &[&str]) -> Option<String> {
        let index = fields()
            .iter()
            .position(|f| f.path.iter().map(String::as_str).eq(path.iter().copied()))
            .unwrap_or_else(|| panic!("{path:?} not in the table"));
        values[index].clone()
    }

    #[test]
    fn frame_carries_the_table_fields_and_marks_the_rest_absent() {
        let frame = encode(4321, &sample());
        let (tick, values) = decode(&frame);
        assert_eq!(tick, 4321);
        assert_eq!(values.len(), fields().len());
        assert_eq!(value_of(&values, &["server_build"]).as_deref(), Some("10:59:11"));
        assert_eq!(value_of(&values, &["physics_gpu_active"]).as_deref(), Some("true"));
        assert_eq!(value_of(&values, &["player_count"]).as_deref(), Some("3"));
        assert_eq!(value_of(&values, &["timings", "total_ms", "p95"]).as_deref(), Some("27.5"));
        assert_eq!(
            value_of(&values, &["spans", "destruction/native_escaped_bodies", "v"]).as_deref(),
            Some("2")
        );
        assert_eq!(value_of(&values, &["city", "degraded"]).as_deref(), Some("false"));
        // u64 counters saturate instead of wrapping.
        assert_eq!(
            value_of(&values, &["city", "freeze_flips"]).as_deref(),
            Some((u32::MAX - 1).to_string().as_str())
        );
        // Missing on the server -> absent on the wire, never a fake zero.
        assert_eq!(value_of(&values, &["city", "awake_bodies"]), None);
        assert_eq!(value_of(&values, &["physics_gpu_wait_ms"]), None);
    }

    #[test]
    fn frame_is_small_and_fits_a_datagram() {
        // A full city match: every table field present.
        let mut stats = sample();
        for field in fields() {
            let mut node = &mut stats;
            for key in &field.path[..field.path.len() - 1] {
                node = node
                    .as_object_mut()
                    .unwrap()
                    .entry(key.clone())
                    .or_insert_with(|| serde_json::json!({}));
            }
            let leaf = field.path.last().unwrap().clone();
            let obj = node.as_object_mut().unwrap();
            if !obj.contains_key(&leaf) {
                obj.insert(
                    leaf,
                    match field.kind {
                        FieldType::Str => serde_json::json!("some-string"),
                        FieldType::Bool => serde_json::json!(true),
                        _ => serde_json::json!(123.0),
                    },
                );
            }
        }
        let frame = encode(1, &stats);
        let (_, values) = decode(&frame);
        assert!(values.iter().all(Option::is_some));
        // The JSON packet this replaces was ~15 kB; a QUIC datagram is ~1200 B.
        assert!(frame.len() < 400, "frame is {} bytes", frame.len());
    }

    #[test]
    fn long_strings_are_cut_at_a_char_boundary() {
        let long = "é".repeat(200); // 400 bytes
        let frame = encode(1, &serde_json::json!({ "server_build": long }));
        let (_, values) = decode(&frame);
        let got = values[0].clone().unwrap();
        assert!(got.len() <= MAX_STRING_BYTES);
        assert!(got.chars().all(|c| c == 'é'));
    }

    /// The fixture the client's decoder test reads: same bytes on both sides.
    #[test]
    fn frame_matches_the_shared_fixture() {
        let fixture: Value =
            serde_json::from_str(include_str!("../../shared/fixtures/match-stats-frame-v1.json"))
                .unwrap();
        let tick = fixture["server_tick"].as_u64().unwrap() as u32;
        let frame = encode(tick, &fixture["stats"]);
        let hex: String = frame.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(hex, fixture["hex"].as_str().unwrap(), "update the fixture's hex if the table changed");
    }

    #[test]
    fn frame_is_never_mistaken_for_legacy_json() {
        let frame = encode(1, &sample());
        assert_ne!(frame[1], b'{');
    }
}
