//! Where a structure is actually overloaded.
//!
//! `bond_utilisation_max` answers "is anything past its limit" and nothing
//! about which joint, in which mode, between what. That is the difference
//! between reinforcing a wall and reaching for a global dial — and a global
//! dial is a blunt instrument here, because the structures in one city do not
//! share a weakness: dropping every material to 0.5x left one building
//! untouched and had another shed 94 bonds standing still.
//!
//! This joins three things the system already knows but never puts together:
//! the solver's per-bond stress, the manifest's bond geometry, and the pack's
//! authored roles. The result is sentences like "the worst joint is a
//! wall-to-wall seam at y=41 m carrying 3.2x its tension limit", which names
//! something you can go and change.
//!
//! It reads the last solve; it does not solve. Step the rig, then ask.

use std::collections::BTreeMap;

use glam::Vec3;

use crate::scene_pack::ScenePack;

/// One bond, with everything needed to find it and to know why it is hot.
#[derive(Clone, Copy, Debug)]
pub struct BondStress {
    pub bond_index: u32,
    pub node0: u32,
    pub node1: u32,
    /// Stress over this bond's own material's elastic limit. Damage accrues
    /// above 1.0 and never below, so this is the number that decides whether a
    /// joint is merely working hard or actually failing.
    pub utilisation: f32,
    pub compression: f32,
    pub tension: f32,
    pub shear: f32,
    pub area: f32,
    /// Midpoint of the two chunks, in structure-local space: where to look.
    pub position: Vec3,
}

impl BondStress {
    /// Which mode is the one that would break it.
    pub fn governing_mode(&self) -> &'static str {
        if self.tension >= self.compression && self.tension >= self.shear {
            "tension"
        } else if self.compression >= self.shear {
            "compression"
        } else {
            "shear"
        }
    }
}

/// Bonds grouped by what they join, which is the unit reinforcement happens in.
#[derive(Clone, Debug, Default)]
pub struct ClassStats {
    pub count: usize,
    pub max_utilisation: f32,
    pub mean_utilisation: f32,
    pub over_limit: usize,
    pub over_half: usize,
    /// The single worst bond in this class, to go and look at.
    pub worst: Option<BondStress>,
}

/// A structure's stress state, sliced the ways a person reasons about it.
#[derive(Clone, Debug, Default)]
pub struct StressReport {
    pub bonds: Vec<BondStress>,
    /// Keyed "roleA->roleB" with the pair sorted, so wall->slab and slab->wall
    /// are one class.
    pub by_role_pair: BTreeMap<String, ClassStats>,
    pub by_material: BTreeMap<String, ClassStats>,
    /// Utilisation against height, in 10 m bands: what "it sags up there"
    /// looks like as a number.
    pub by_height_band: BTreeMap<i32, ClassStats>,
    /// Utilisation against CONTACT AREA, in decades.
    ///
    /// Stress is force over area, so a joint the fracturer left as a sliver
    /// carries the same load through less section and reads hotter for reasons
    /// that are about the mesh rather than the building. If the hot tail
    /// lives in the smallest band, the fix is the authoring floor on bond
    /// area, not the material.
    pub by_area_decade: BTreeMap<i32, ClassStats>,
}

fn accumulate(stats: &mut ClassStats, bond: &BondStress) {
    stats.count += 1;
    stats.mean_utilisation += bond.utilisation;
    if bond.utilisation > stats.max_utilisation {
        stats.max_utilisation = bond.utilisation;
        stats.worst = Some(*bond);
    }
    if bond.utilisation >= 1.0 {
        stats.over_limit += 1;
    }
    if bond.utilisation >= 0.5 {
        stats.over_half += 1;
    }
}

fn finish(stats: &mut ClassStats) {
    if stats.count > 0 {
        stats.mean_utilisation /= stats.count as f32;
    }
}

fn push(report: &mut StressReport, pack: &ScenePack, bond: BondStress, material: &str) {
    let mut roles = [
        pack.node_role(bond.node0 as usize),
        pack.node_role(bond.node1 as usize),
    ];
    roles.sort_unstable();
    let key = if roles[0].is_empty() && roles[1].is_empty() {
        "untagged".to_string()
    } else {
        format!("{}->{}", roles[0], roles[1])
    };
    accumulate(report.by_role_pair.entry(key).or_default(), &bond);
    accumulate(
        report.by_material.entry(material.to_string()).or_default(),
        &bond,
    );
    let band = (bond.position.y / 10.0).floor() as i32 * 10;
    accumulate(report.by_height_band.entry(band).or_default(), &bond);
    let decade = if bond.area > 0.0 {
        bond.area.log10().floor() as i32
    } else {
        -9
    };
    accumulate(report.by_area_decade.entry(decade).or_default(), &bond);
    report.bonds.push(bond);
}

fn finish_all(report: &mut StressReport) {
    for stats in report.by_role_pair.values_mut() {
        finish(stats);
    }
    for stats in report.by_material.values_mut() {
        finish(stats);
    }
    for stats in report.by_height_band.values_mut() {
        finish(stats);
    }
    for stats in report.by_area_decade.values_mut() {
        finish(stats);
    }
    report
        .bonds
        .sort_by(|a, b| b.utilisation.partial_cmp(&a.utilisation).unwrap_or(std::cmp::Ordering::Equal));
}

impl StressReport {
    /// Assemble from typed rows. This is the production entry point.
    pub fn from_rows(pack: &ScenePack, rows: &[BondStress], material_of: impl Fn(u32) -> String) -> Self {
        let mut report = StressReport::default();
        for bond in rows {
            let material = material_of(bond.bond_index);
            push(&mut report, pack, *bond, &material);
        }
        finish_all(&mut report);
        report
    }

    /// The hottest bonds, worst first.
    pub fn hottest(&self, count: usize) -> &[BondStress] {
        &self.bonds[..count.min(self.bonds.len())]
    }

    pub fn over_limit(&self) -> usize {
        self.bonds.iter().filter(|b| b.utilisation >= 1.0).count()
    }

    /// A human-readable card: what is loaded, where, and in what mode.
    pub fn card(&self, pack: &ScenePack, title: &str) -> String {
        let mut out = format!(
            "\n== {title} ==\n  {} bonds, {} over their elastic limit\n",
            self.bonds.len(),
            self.over_limit(),
        );
        out.push_str("\n  by joint class            n      max    mean   over\n");
        let mut classes: Vec<_> = self.by_role_pair.iter().collect();
        classes.sort_by(|a, b| {
            b.1.max_utilisation
                .partial_cmp(&a.1.max_utilisation)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        for (name, stats) in classes.iter().take(12) {
            out.push_str(&format!(
                "  {name:<24} {:>6} {:>8.2} {:>7.2} {:>6}\n",
                stats.count, stats.max_utilisation, stats.mean_utilisation, stats.over_limit
            ));
        }
        out.push_str("\n  by height band            n      max    mean   over\n");
        for (band, stats) in self.by_height_band.iter() {
            if stats.max_utilisation < 0.05 {
                continue;
            }
            out.push_str(&format!(
                "  {:<24} {:>6} {:>8.2} {:>7.2} {:>6}\n",
                format!("{band}..{} m", band + 10),
                stats.count,
                stats.max_utilisation,
                stats.mean_utilisation,
                stats.over_limit
            ));
        }
        out.push_str("\n  by contact area           n      max    mean   over\n");
        for (decade, stats) in self.by_area_decade.iter() {
            out.push_str(&format!(
                "  {:<24} {:>6} {:>8.2} {:>7.2} {:>6}\n",
                format!("1e{decade}..1e{} m2", decade + 1),
                stats.count,
                stats.max_utilisation,
                stats.mean_utilisation,
                stats.over_limit
            ));
        }
        out.push_str("\n  hottest joints\n");
        for bond in self.hottest(10) {
            out.push_str(&format!(
                "  {:>6.2}x {:<11} {:>8} <-> {:<8} {:<10} <-> {:<10} at ({:.0}, {:.0}, {:.0}) over {:.3} m2\n",
                bond.utilisation,
                bond.governing_mode(),
                bond.node0,
                bond.node1,
                pack.node_role(bond.node0 as usize),
                pack.node_role(bond.node1 as usize),
                bond.position.x,
                bond.position.y,
                bond.position.z,
                bond.area,
            ));
        }
        out
    }
}
