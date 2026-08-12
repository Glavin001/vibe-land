//! Deterministic carve apply pipeline.

use crate::protocol::CarveEventPacket;

use super::materials::SheetMaterial;
use super::mask::SheetMask;
use super::stamp::{bullet_flux_at, generate_stamp_mask};

/// Replicated carve unit (bullet disc for MVP).
#[derive(Clone, Debug)]
pub struct CarveEvent {
    pub sheet_id: u32,
    pub seq: u32,
    /// Impact center in sheet UV meters (already quantized by sender).
    pub uv: [f32; 2],
    /// In-plane direction component (unused for isotropic bullet, kept for future).
    pub dir_uv: [f32; 2],
    pub normal_speed: f32,
    /// Projectile mass (kg) for bullets; charge energy for explosions.
    pub mass_or_energy: f32,
    pub footprint_radius: f32,
    pub seed: u32,
}

impl CarveEvent {
    pub fn to_hash_bytes(&self) -> [u8; 28] {
        let mut out = [0u8; 28];
        out[0..4].copy_from_slice(&self.sheet_id.to_le_bytes());
        out[4..8].copy_from_slice(&self.seq.to_le_bytes());
        out[8..10].copy_from_slice(&quantize_uv(self.uv[0]).to_le_bytes());
        out[10..12].copy_from_slice(&quantize_uv(self.uv[1]).to_le_bytes());
        out[12..16].copy_from_slice(&self.seed.to_le_bytes());
        out[16..20].copy_from_slice(&self.normal_speed.to_bits().to_le_bytes());
        out[20..24].copy_from_slice(&self.mass_or_energy.to_bits().to_le_bytes());
        out[24..28].copy_from_slice(&self.footprint_radius.to_bits().to_le_bytes());
        out
    }
}

/// Quantize UV to 16-bit fixed (0.5 mm resolution over ±16 m).
pub fn quantize_uv(v: f32) -> u16 {
    let clamped = v.clamp(-16.0, 16.0);
    let q = ((clamped + 16.0) * 2048.0).round() as i32;
    q.clamp(0, 65535) as u16
}

pub fn dequantize_uv(q: u16) -> f32 {
    (q as f32) / 2048.0 - 16.0
}

pub fn carve_event_to_packet(event: &CarveEvent) -> CarveEventPacket {
    CarveEventPacket {
        sheet_id: event.sheet_id,
        seq: event.seq,
        uv_u: quantize_uv(event.uv[0]),
        uv_v: quantize_uv(event.uv[1]),
        dir_u: (event.dir_uv[0].clamp(-1.0, 1.0) * 32767.0).round() as i16,
        dir_v: (event.dir_uv[1].clamp(-1.0, 1.0) * 32767.0).round() as i16,
        normal_speed_cms: (event.normal_speed.max(0.0) * 100.0)
            .round()
            .clamp(0.0, u16::MAX as f32) as u16,
        mass_or_energy_grams: (event.mass_or_energy.max(0.0) * 1000.0)
            .round()
            .clamp(0.0, u16::MAX as f32) as u16,
        footprint_radius_mm: (event.footprint_radius.max(0.0) * 1000.0)
            .round()
            .clamp(0.0, u16::MAX as f32) as u16,
        seed: event.seed,
    }
}

pub fn carve_event_from_packet(pkt: &CarveEventPacket) -> CarveEvent {
    CarveEvent {
        sheet_id: pkt.sheet_id,
        seq: pkt.seq,
        uv: [dequantize_uv(pkt.uv_u), dequantize_uv(pkt.uv_v)],
        dir_uv: [
            pkt.dir_u as f32 / 32767.0,
            pkt.dir_v as f32 / 32767.0,
        ],
        normal_speed: pkt.normal_speed_cms as f32 / 100.0,
        mass_or_energy: pkt.mass_or_energy_grams as f32 / 1000.0,
        footprint_radius: pkt.footprint_radius_mm as f32 / 1000.0,
        seed: pkt.seed,
    }
}

/// Wire encode for reliable channel (server + local practice).
pub fn encode_carve_event_packet(pkt: &CarveEventPacket) -> Vec<u8> {
    let mut out = Vec::with_capacity(29);
    out.push(crate::constants::PKT_CARVE_EVENT);
    out.extend_from_slice(&pkt.sheet_id.to_le_bytes());
    out.extend_from_slice(&pkt.seq.to_le_bytes());
    out.extend_from_slice(&pkt.uv_u.to_le_bytes());
    out.extend_from_slice(&pkt.uv_v.to_le_bytes());
    out.extend_from_slice(&pkt.dir_u.to_le_bytes());
    out.extend_from_slice(&pkt.dir_v.to_le_bytes());
    out.extend_from_slice(&pkt.normal_speed_cms.to_le_bytes());
    out.extend_from_slice(&pkt.mass_or_energy_grams.to_le_bytes());
    out.extend_from_slice(&pkt.footprint_radius_mm.to_le_bytes());
    out.extend_from_slice(&pkt.seed.to_le_bytes());
    out
}

#[derive(Clone, Debug)]
pub struct CarveApplyResult {
    pub carved_cells: u32,
    pub damaged_cells: u32,
    pub applied: bool,
}

/// Apply a carve event to a mask. Idempotent for seq ≤ mask.seq.
pub fn apply_carve(
    mask: &mut SheetMask,
    mat: &SheetMaterial,
    event: &CarveEvent,
) -> CarveApplyResult {
    if event.seq <= mask.seq {
        return CarveApplyResult {
            carved_cells: 0,
            damaged_cells: 0,
            applied: false,
        };
    }

    // Quantize UV for determinism across peers.
    let mut event = event.clone();
    event.uv[0] = dequantize_uv(quantize_uv(event.uv[0]));
    event.uv[1] = dequantize_uv(quantize_uv(event.uv[1]));

    let stamp = generate_stamp_mask(&event, mat, mask);

    let mut max_flux = 0.0_f32;
    let mut carved = 0u32;
    let mut damaged = 0u32;

    // First pass: find max flux for early-out.
    for y in 0..mask.height {
        for x in 0..mask.width {
            if !stamp.get(x, y) {
                continue;
            }
            let flux = bullet_flux_at(&event, mat, x, y, mask.cell_size);
            if flux > max_flux {
                max_flux = flux;
            }
        }
    }

    if max_flux < mat.damage_flux_min {
        mask.seq = event.seq;
        mask.mix_event_hash(&event.to_hash_bytes());
        // No geometry change, but seq advances so peers stay ordered.
        return CarveApplyResult {
            carved_cells: 0,
            damaged_cells: 0,
            applied: true,
        };
    }

    for y in 0..mask.height {
        for x in 0..mask.width {
            if !stamp.get(x, y) || !mask.occupied(x, y) {
                continue;
            }
            let flux = bullet_flux_at(&event, mat, x, y, mask.cell_size);
            if flux < mat.damage_flux_min {
                continue;
            }
            let break_thresh = if mask.reinforced(x, y) {
                mat.break_flux_reinforced
            } else {
                mat.break_flux
            };
            let idx = y as usize * mask.width as usize + x as usize;
            if flux >= break_thresh {
                mask.set_occupied(x, y, false);
                carved += 1;
            } else {
                let add = (flux * mat.damage_to_break_ratio).round() as u16;
                let next = (mask.damage[idx] as u16).saturating_add(add).min(255) as u8;
                mask.damage[idx] = next;
                let dent_add = (flux * mat.dent_flux_to_depth).round() as u16;
                mask.dent_depth[idx] = (mask.dent_depth[idx] as u16)
                    .saturating_add(dent_add)
                    .min(255) as u8;
                damaged += 1;
                if next >= 255 {
                    mask.set_occupied(x, y, false);
                    carved += 1;
                }
            }
        }
    }

    // Auto-collapse near-empty sheets.
    if mask.occupancy_ratio() < 0.05 {
        for y in 0..mask.height {
            for x in 0..mask.width {
                if mask.occupied(x, y) {
                    mask.set_occupied(x, y, false);
                    carved += 1;
                }
            }
        }
    }

    mask.seq = event.seq;
    mask.rev = mask.rev.wrapping_add(1);
    mask.mix_event_hash(&event.to_hash_bytes());

    CarveApplyResult {
        carved_cells: carved,
        damaged_cells: damaged,
        applied: true,
    }
}
