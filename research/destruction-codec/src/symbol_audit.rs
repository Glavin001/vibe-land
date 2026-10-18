//! Symbol-stream entropy audit.
//!
//! Measures how many bits the hierarchy wire's own symbols are actually worth,
//! order-0 and under decoder-available conditioning. This is the ceiling test
//! for replacing a stream's coder — hand-context or learned — without building
//! the coder first: a conditional entropy that sits near the shipped byte count
//! means there is nothing for a better coder to find.
//!
//! Every context used here is reconstructible by the decoder. Nothing is
//! conditioned on simulation truth (velocities, contacts, flags), because a
//! coder cannot condition on data the receiver does not have.

use std::collections::HashMap;

use serde::Serialize;

/// One residual record's symbols plus the context a decoder could condition on.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct ResidualSymbol {
    pub(crate) actor_gap: u32,
    pub(crate) tag: u8,
    pub(crate) delta: [i16; 3],
    /// Decoder-available context.
    pub(crate) island_size_bucket: u8,
    pub(crate) since_last_bucket: u8,
    pub(crate) position_model: u8,
    pub(crate) emitted_previous_tick: bool,
    /// Temporal holdout fold: alternating one-second blocks of the trace.
    pub(crate) fold: u8,
}

/// One root-segment record's symbols, logged in `(root, start_tick)` sorted
/// order so `root_gap` and the continuity fields measure what a wire that
/// actually sorts segments would pay -- not the fitter's emission order.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct RootSymbol {
    pub(crate) root_gap: u32,
    pub(crate) duration: u32,
    pub(crate) position_model: u8,
    pub(crate) rotation_model: u8,
    pub(crate) full_precision: bool,
    pub(crate) island_size_bucket: u8,
    pub(crate) duration_bucket: u8,
    /// Whether a same-root record precedes this one in sorted order. Every
    /// field below this line is meaningful only when true; entropy is
    /// measured over the `had_prev` subset only.
    pub(crate) had_prev: bool,
    /// Quantized start position in wire units, for delta-vs-previous analysis.
    pub(crate) start_cell: [i32; 3],
    pub(crate) start_local: [u16; 3],
    /// tick gap from the previous same-root segment's end, when `had_prev`;
    /// otherwise the GOP-relative absolute start tick as coded today.
    pub(crate) start_tick_symbol: u32,
    /// Start position vs `prev.pose_at(start_tick)`, decomposed the same way
    /// as the absolute cell/local pair so a lossless delta is measurable.
    pub(crate) start_dcell: [i32; 3],
    pub(crate) start_dlocal: [i32; 3],
    /// True when this segment's start rotation is exactly the previous
    /// segment's end rotation -- the zero-payload inherit case.
    pub(crate) start_rot_pred_exact: bool,
    /// smallest-three code of `prev.end_pose.rotation.inverse() * start_pose.rotation`.
    pub(crate) start_rot_delta_q32: u32,
    /// Slerp only: smallest-three code of `start.inverse() * end` rotation.
    pub(crate) end_rot_delta_q32: u32,
    /// Linear/Hermite only: end position vs a same-family prediction (see
    /// `predict_end_position` in hierarchy.rs) decomposed as cell/local deltas.
    pub(crate) end_dcell: [i32; 3],
    pub(crate) end_dlocal: [i32; 3],
    /// Ballistic/Hermite start velocity vs the previous segment's boundary
    /// derivative, on the existing i16 velocity grid.
    pub(crate) dvel_start: [i32; 3],
    /// Hermite end velocity vs `start_velocity + gravity * duration`.
    pub(crate) dvel_end: [i32; 3],
}

#[derive(Default)]
pub(crate) struct SymbolLog {
    pub(crate) residuals: Vec<ResidualSymbol>,
    pub(crate) roots: Vec<RootSymbol>,
}

pub(crate) fn bucket_log2(value: u32) -> u8 {
    (32 - value.leading_zeros()).min(15) as u8
}

/// Order-0 entropy of a symbol column, in total bits, plus a model-table charge
/// so a large alphabet cannot look free.
fn entropy_bits<T: std::hash::Hash + Eq>(values: impl Iterator<Item = T>) -> (f64, usize, usize) {
    let mut histogram = HashMap::<T, u64>::new();
    let mut count = 0_u64;
    for value in values {
        *histogram.entry(value).or_default() += 1;
        count += 1;
    }
    if count == 0 {
        return (0.0, 0, 0);
    }
    let total = count as f64;
    let bits = histogram
        .values()
        .map(|&n| {
            let p = n as f64 / total;
            -(n as f64) * p.log2()
        })
        .sum();
    (bits, histogram.len(), count as usize)
}

/// Conditional entropy H(symbol | context), in total bits. The table charge
/// grows with the number of occupied contexts, which is what keeps a
/// pathologically fine context from scoring zero.
fn conditional_entropy_bits<C, T>(pairs: impl Iterator<Item = (C, T)>) -> (f64, usize)
where
    C: std::hash::Hash + Eq,
    T: std::hash::Hash + Eq,
{
    let mut by_context = HashMap::<C, HashMap<T, u64>>::new();
    for (context, value) in pairs {
        *by_context
            .entry(context)
            .or_default()
            .entry(value)
            .or_default() += 1;
    }
    let mut bits = 0.0;
    let mut alphabet = 0;
    for histogram in by_context.values() {
        let total: u64 = histogram.values().sum();
        alphabet += histogram.len();
        for &n in histogram.values() {
            let p = n as f64 / total as f64;
            bits += -(n as f64) * p.log2();
        }
    }
    (bits, alphabet)
}

/// Out-of-sample cost of a context model, in total bits.
///
/// In-sample conditional entropy is biased downward: with a large alphabet and
/// many contexts the histogram partly memorizes its own data, so it flatters
/// any conditioning scheme. This trains on alternating one-second blocks and
/// scores the other blocks, so every record is priced by a model that never saw
/// it. Probabilities use interpolated backoff (context -> global -> uniform),
/// which is what an adaptive coder with context mixing actually achieves and
/// guarantees no symbol is ever assigned zero probability.
fn held_out_bits<C, T>(
    values: &[T],
    contexts: &[C],
    folds: &[u8],
    alphabet_cap: f64,
) -> (f64, f64)
where
    C: std::hash::Hash + Eq + Clone,
    T: std::hash::Hash + Eq + Clone,
{
    const CONTEXT_ALPHA: f64 = 8.0;
    const GLOBAL_BETA: f64 = 1.0;
    let uniform = 1.0 / alphabet_cap.max(1.0);
    let mut conditional_bits = 0.0;
    let mut order0_bits = 0.0;

    for train_fold in [0_u8, 1_u8] {
        let mut by_context = HashMap::<C, (HashMap<T, u64>, u64)>::new();
        let mut global = HashMap::<T, u64>::new();
        let mut global_total = 0_u64;
        for index in 0..values.len() {
            if folds[index] != train_fold {
                continue;
            }
            let entry = by_context.entry(contexts[index].clone()).or_default();
            *entry.0.entry(values[index].clone()).or_default() += 1;
            entry.1 += 1;
            *global.entry(values[index].clone()).or_default() += 1;
            global_total += 1;
        }
        if global_total == 0 {
            continue;
        }
        for index in 0..values.len() {
            if folds[index] == train_fold {
                continue;
            }
            let count = global.get(&values[index]).copied().unwrap_or(0) as f64;
            let p_global =
                (count + GLOBAL_BETA * uniform) / (global_total as f64 + GLOBAL_BETA);
            order0_bits -= p_global.log2();
            let p = match by_context.get(&contexts[index]) {
                Some((histogram, total)) => {
                    let n = histogram.get(&values[index]).copied().unwrap_or(0) as f64;
                    (n + CONTEXT_ALPHA * p_global) / (*total as f64 + CONTEXT_ALPHA)
                }
                None => p_global,
            };
            conditional_bits -= p.log2();
        }
    }
    (order0_bits, conditional_bits)
}

#[derive(Clone, Debug, Serialize)]
pub struct FieldEntropy {
    pub field: &'static str,
    pub samples: usize,
    pub alphabet: usize,
    pub order0_bits: f64,
    pub order0_bits_per_sample: f64,
    pub conditional_bits: f64,
    pub conditional_bits_per_sample: f64,
    pub context: &'static str,
    pub table_bytes: u64,
    /// Out-of-sample: trained on alternating one-second blocks, scored on the rest.
    pub held_out_order0_bits: f64,
    pub held_out_conditional_bits: f64,
    pub held_out_order0_bits_per_sample: f64,
    pub held_out_conditional_bits_per_sample: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct SymbolAuditReport {
    pub residual_records: usize,
    pub root_records: usize,
    pub residual_fields: Vec<FieldEntropy>,
    pub root_fields: Vec<FieldEntropy>,
    /// Sum over residual fields of the conditional model, including tables.
    pub residual_conditional_total_bytes: u64,
    pub residual_order0_total_bytes: u64,
    /// What the shipped container actually spends on each stream.
    pub residual_wire_uncompressed_bytes: u64,
    pub residual_wire_zstd_bytes: u64,
    pub root_conditional_total_bytes: u64,
    pub root_order0_total_bytes: u64,
    pub root_wire_uncompressed_bytes: u64,
    pub root_wire_zstd_bytes: u64,
    /// R1: fields measuring predicted-relative coding of root segments,
    /// restricted to the (root, start_tick)-sorted subset each applies to.
    pub root_continuity_fields: Vec<FieldEntropy>,
    /// Fraction of segments with a same-root predecessor in sorted order --
    /// the ceiling on how much of the stream continuity coding can reach.
    pub had_prev_fraction_pct: f64,
    /// Fraction of `had_prev` records whose start rotation exactly equals
    /// the previous segment's end rotation -- the zero-payload inherit rate.
    pub start_rot_inherit_pct: f64,
    /// Projected root bytes if every continuity field is adopted at its
    /// held-out conditional cost and non-continuous records keep today's
    /// absolute coding: sum of held-out conditional bytes (continuity
    /// fields) + order-0 bytes (non-continuity fields), each field costed
    /// only over the record subset it actually applies to.
    pub projected_root_bytes_v7: u64,
}

/// Table charge: 10 bytes per distinct (context, symbol) entry, matching the
/// existing `ResidualReport` convention in `archive.rs` so the numbers compare.
const TABLE_BYTES_PER_ENTRY: u64 = 10;

fn field<C, T>(
    name: &'static str,
    context_name: &'static str,
    values: Vec<T>,
    contexts: Vec<C>,
    folds: &[u8],
    alphabet_cap: f64,
) -> FieldEntropy
where
    C: std::hash::Hash + Eq + Clone,
    T: std::hash::Hash + Eq + Clone,
{
    let (order0, alphabet, samples) = entropy_bits(values.iter().cloned());
    let (held_out_order0, held_out_conditional) =
        held_out_bits(&values, &contexts, folds, alphabet_cap);
    let (conditional, entries) =
        conditional_entropy_bits(contexts.into_iter().zip(values.into_iter()));
    FieldEntropy {
        field: name,
        samples,
        alphabet,
        order0_bits: order0,
        order0_bits_per_sample: if samples == 0 {
            0.0
        } else {
            order0 / samples as f64
        },
        conditional_bits: conditional,
        conditional_bits_per_sample: if samples == 0 {
            0.0
        } else {
            conditional / samples as f64
        },
        context: context_name,
        table_bytes: entries as u64 * TABLE_BYTES_PER_ENTRY,
        held_out_order0_bits: held_out_order0,
        held_out_conditional_bits: held_out_conditional,
        held_out_order0_bits_per_sample: if samples == 0 {
            0.0
        } else {
            held_out_order0 / samples as f64
        },
        held_out_conditional_bits_per_sample: if samples == 0 {
            0.0
        } else {
            held_out_conditional / samples as f64
        },
    }
}

pub(crate) fn audit(
    log: &SymbolLog,
    residual_wire_uncompressed_bytes: u64,
    residual_wire_zstd_bytes: u64,
    root_wire_uncompressed_bytes: u64,
    root_wire_zstd_bytes: u64,
) -> SymbolAuditReport {
    let r = &log.residuals;

    // Context for residual fields: what the decoder knows before reading the
    // symbol -- island size, recency of this actor's last repair, the root
    // segment's motion model, and whether it repaired on the previous tick.
    let residual_context: Vec<(u8, u8, u8, bool)> = r
        .iter()
        .map(|s| {
            (
                s.island_size_bucket,
                s.since_last_bucket,
                s.position_model,
                s.emitted_previous_tick,
            )
        })
        .collect();

    let residual_folds: Vec<u8> = r.iter().map(|s| s.fold).collect();
    let mut residual_fields = vec![
        field(
            "actor_gap",
            "island_size,since_last,pos_model,prev_tick",
            r.iter().map(|s| s.actor_gap).collect(),
            residual_context.clone(),
            &residual_folds,
            8192.0,
        ),
        field(
            "tag",
            "island_size,since_last,pos_model,prev_tick",
            r.iter().map(|s| s.tag).collect(),
            residual_context.clone(),
            &residual_folds,
            8.0,
        ),
    ];
    // Position deltas are coded per axis; axis 0 conditions the later axes,
    // matching the autoregressive head a learned coder would use.
    for (axis, name) in ["delta_x", "delta_y", "delta_z"].into_iter().enumerate() {
        let contexts: Vec<_> = r
            .iter()
            .enumerate()
            .map(|(i, s)| {
                let (a, b, c, d) = residual_context[i];
                // Condition later axes on the sign/magnitude bucket of axis 0.
                let previous = if axis == 0 {
                    0
                } else {
                    let v = s.delta[0];
                    (v.signum() as i32 * bucket_log2(v.unsigned_abs() as u32) as i32) as i8
                };
                (a, b, c, d, previous)
            })
            .collect();
        residual_fields.push(field(
            name,
            "island_size,since_last,pos_model,prev_tick,axis0",
            r.iter().map(|s| s.delta[axis]).collect(),
            contexts,
            &residual_folds,
            65536.0,
        ));
    }

    let root = &log.roots;
    let root_folds: Vec<u8> = (0..root.len()).map(|i| (i % 2) as u8).collect();
    let root_context: Vec<(u8, u8)> = root
        .iter()
        .map(|s| (s.island_size_bucket, s.position_model))
        .collect();
    let root_fields = vec![
        field(
            "root_gap",
            "island_size,pos_model",
            root.iter().map(|s| s.root_gap).collect(),
            root_context.clone(),
            &root_folds,
            8192.0,
        ),
        field(
            "duration",
            "island_size,pos_model",
            root.iter().map(|s| s.duration).collect(),
            root_context.clone(),
            &root_folds,
            256.0,
        ),
        field(
            "position_model",
            "island_size",
            root.iter().map(|s| s.position_model).collect(),
            root.iter().map(|s| s.island_size_bucket).collect(),
            &root_folds,
            8.0,
        ),
        field(
            "rotation_model",
            "island_size,pos_model",
            root.iter().map(|s| s.rotation_model).collect(),
            root_context.clone(),
            &root_folds,
            4.0,
        ),
        field(
            "full_precision",
            "island_size,pos_model",
            root.iter().map(|s| s.full_precision).collect(),
            root_context.clone(),
            &root_folds,
            4.0,
        ),
        field(
            "start_local_x",
            "island_size,pos_model",
            root.iter().map(|s| s.start_local[0]).collect(),
            root_context.clone(),
            &root_folds,
            65536.0,
        ),
        field(
            "start_local_y",
            "island_size,pos_model",
            root.iter().map(|s| s.start_local[1]).collect(),
            root_context.clone(),
            &root_folds,
            65536.0,
        ),
        field(
            "start_local_z",
            "island_size,pos_model",
            root.iter().map(|s| s.start_local[2]).collect(),
            root_context.clone(),
            &root_folds,
            65536.0,
        ),
        field(
            "start_cell",
            "island_size,pos_model",
            root.iter().map(|s| s.start_cell).collect(),
            root_context,
            &root_folds,
            4096.0,
        ),
    ];

    // Continuity fields (R1): meaningful only where a same-root predecessor
    // exists in (root, start_tick) sorted order. Filtered to that subset so
    // the entropy reflects what these fields would actually cost on the wire,
    // not diluted by first-of-root records that have no prediction to use.
    let prev_indices: Vec<usize> = (0..root.len()).filter(|&i| root[i].had_prev).collect();
    let had_prev_fraction = if root.is_empty() {
        0.0
    } else {
        prev_indices.len() as f64 / root.len() as f64
    };
    let prev_context: Vec<(u8, u8, u8)> = prev_indices
        .iter()
        .map(|&i| {
            (
                root[i].island_size_bucket,
                root[i].position_model,
                root[i].duration_bucket,
            )
        })
        .collect();
    let prev_folds: Vec<u8> = prev_indices.iter().map(|&i| root_folds[i]).collect();
    // Rotation-inherit is evaluated over every record with a predecessor,
    // regardless of position model; the delta/end-position/velocity fields
    // are further restricted below to the position models that carry them.
    let start_rot_inherit_pct = if prev_indices.is_empty() {
        0.0
    } else {
        100.0
            * prev_indices
                .iter()
                .filter(|&&i| root[i].start_rot_pred_exact)
                .count() as f64
            / prev_indices.len() as f64
    };
    let mut root_continuity_fields = vec![
        field(
            "start_tick_continuation",
            "island_size,pos_model,duration",
            prev_indices.iter().map(|&i| root[i].start_tick_symbol).collect(),
            prev_context.clone(),
            &prev_folds,
            8192.0,
        ),
    ];
    // Rotation-delta entropy only over records that actually need a payload
    // (exact-inherit records cost zero and are excluded by construction).
    let rot_needs_payload: Vec<usize> = prev_indices
        .iter()
        .copied()
        .filter(|&i| !root[i].start_rot_pred_exact)
        .collect();
    let rot_payload_context: Vec<(u8, u8, u8)> = rot_needs_payload
        .iter()
        .map(|&i| (root[i].island_size_bucket, root[i].position_model, root[i].duration_bucket))
        .collect();
    let rot_payload_folds: Vec<u8> = rot_needs_payload.iter().map(|&i| root_folds[i]).collect();
    root_continuity_fields.push(field(
        "start_rot_delta_q32",
        "island_size,pos_model,duration",
        rot_needs_payload.iter().map(|&i| root[i].start_rot_delta_q32).collect(),
        rot_payload_context,
        &rot_payload_folds,
        u32::from(u16::MAX) as f64 + 1.0,
    ));
    for (axis, name) in ["start_dcell_x", "start_dcell_y", "start_dcell_z"]
        .into_iter()
        .enumerate()
    {
        root_continuity_fields.push(field(
            name,
            "island_size,pos_model,duration",
            prev_indices.iter().map(|&i| root[i].start_dcell[axis]).collect(),
            prev_context.clone(),
            &prev_folds,
            4096.0,
        ));
    }
    for (axis, name) in ["start_dlocal_x", "start_dlocal_y", "start_dlocal_z"]
        .into_iter()
        .enumerate()
    {
        root_continuity_fields.push(field(
            name,
            "island_size,pos_model,duration",
            prev_indices.iter().map(|&i| root[i].start_dlocal[axis]).collect(),
            prev_context.clone(),
            &prev_folds,
            131072.0,
        ));
    }
    // Linear/Hermite end-position deltas and Ballistic/Hermite velocity
    // deltas are further restricted to the position models that carry the
    // corresponding wire field, matching R2's layout exactly.
    let has_end_position = |model: u8| model == 1 || model == 3; // Linear, Hermite
    let has_start_velocity = |model: u8| model == 2 || model == 3; // Ballistic, Hermite
    let has_end_velocity = |model: u8| model == 3; // Hermite
    let filtered = |pred: fn(u8) -> bool| -> Vec<usize> {
        prev_indices
            .iter()
            .copied()
            .filter(|&i| pred(root[i].position_model))
            .collect()
    };
    let end_idx = filtered(has_end_position);
    let end_context: Vec<(u8, u8, u8)> = end_idx
        .iter()
        .map(|&i| (root[i].island_size_bucket, root[i].position_model, root[i].duration_bucket))
        .collect();
    let end_folds: Vec<u8> = end_idx.iter().map(|&i| root_folds[i]).collect();
    for (axis, name) in ["end_dcell_x", "end_dcell_y", "end_dcell_z"]
        .into_iter()
        .enumerate()
    {
        root_continuity_fields.push(field(
            name,
            "island_size,pos_model,duration",
            end_idx.iter().map(|&i| root[i].end_dcell[axis]).collect(),
            end_context.clone(),
            &end_folds,
            4096.0,
        ));
    }
    for (axis, name) in ["end_dlocal_x", "end_dlocal_y", "end_dlocal_z"]
        .into_iter()
        .enumerate()
    {
        root_continuity_fields.push(field(
            name,
            "island_size,pos_model,duration",
            end_idx.iter().map(|&i| root[i].end_dlocal[axis]).collect(),
            end_context.clone(),
            &end_folds,
            131072.0,
        ));
    }
    let vel_start_idx = filtered(has_start_velocity);
    let vel_start_context: Vec<(u8, u8, u8)> = vel_start_idx
        .iter()
        .map(|&i| (root[i].island_size_bucket, root[i].position_model, root[i].duration_bucket))
        .collect();
    let vel_start_folds: Vec<u8> = vel_start_idx.iter().map(|&i| root_folds[i]).collect();
    for (axis, name) in ["dvel_start_x", "dvel_start_y", "dvel_start_z"]
        .into_iter()
        .enumerate()
    {
        root_continuity_fields.push(field(
            name,
            "island_size,pos_model,duration",
            vel_start_idx.iter().map(|&i| root[i].dvel_start[axis]).collect(),
            vel_start_context.clone(),
            &vel_start_folds,
            131072.0,
        ));
    }
    let vel_end_idx = filtered(has_end_velocity);
    let vel_end_context: Vec<(u8, u8, u8)> = vel_end_idx
        .iter()
        .map(|&i| (root[i].island_size_bucket, root[i].position_model, root[i].duration_bucket))
        .collect();
    let vel_end_folds: Vec<u8> = vel_end_idx.iter().map(|&i| root_folds[i]).collect();
    for (axis, name) in ["dvel_end_x", "dvel_end_y", "dvel_end_z"]
        .into_iter()
        .enumerate()
    {
        root_continuity_fields.push(field(
            name,
            "island_size,pos_model,duration",
            vel_end_idx.iter().map(|&i| root[i].dvel_end[axis]).collect(),
            vel_end_context.clone(),
            &vel_end_folds,
            131072.0,
        ));
    }

    let sum = |fields: &[FieldEntropy], conditional: bool| -> u64 {
        fields
            .iter()
            .map(|f| {
                let bits = if conditional {
                    f.conditional_bits
                } else {
                    f.order0_bits
                };
                (bits / 8.0).ceil() as u64 + if conditional { f.table_bytes } else { 0 }
            })
            .sum()
    };

    // Rough planning estimate, not a byte-exact projection: sums held-out
    // (out-of-sample) costs, so it does not inherit the in-sample
    // memorization bias documented on the residual side of this file. Two
    // known approximations: (1) the absolute start-position fallback for
    // non-continuous records is `start_cell`/`start_local`'s order-0 cost
    // measured over ALL records, not just the non-prev subset -- continuity
    // is not expected to correlate with position, so this is a fair
    // estimate, not a biased one; (2) rotation/model tags are folded into
    // one 8-bit flags-byte charge rather than measured separately, since
    // their combined audited entropy is under one byte already. The actual
    // adoption decision is the real v7 measurement (R2), not this number.
    let find = |fields: &[FieldEntropy], name: &str, conditional: bool| -> f64 {
        fields
            .iter()
            .find(|f| f.field == name)
            .map_or(0.0, |f| {
                if conditional {
                    f.held_out_conditional_bits
                } else {
                    f.held_out_order0_bits
                }
            })
    };
    let sum_axes = |fields: &[FieldEntropy], names: [&str; 3]| -> f64 {
        names.iter().map(|&n| find(fields, n, true)).sum()
    };
    let prev_count = prev_indices.len() as f64;
    let non_prev_count = (root.len() - prev_indices.len()) as f64;
    let flags_byte_bits = root.len() as f64 * 8.0;
    let non_continuity_bits =
        find(&root_fields, "root_gap", false) + find(&root_fields, "duration", false);
    let continuity_bits = find(&root_continuity_fields, "start_tick_continuation", true)
        + sum_axes(&root_continuity_fields, ["start_dcell_x", "start_dcell_y", "start_dcell_z"])
        + sum_axes(&root_continuity_fields, ["start_dlocal_x", "start_dlocal_y", "start_dlocal_z"])
        + find(&root_continuity_fields, "start_rot_delta_q32", true)
        + sum_axes(&root_continuity_fields, ["end_dcell_x", "end_dcell_y", "end_dcell_z"])
        + sum_axes(&root_continuity_fields, ["end_dlocal_x", "end_dlocal_y", "end_dlocal_z"])
        + sum_axes(&root_continuity_fields, ["dvel_start_x", "dvel_start_y", "dvel_start_z"])
        + sum_axes(&root_continuity_fields, ["dvel_end_x", "dvel_end_y", "dvel_end_z"]);
    let absolute_start_pos_bits_per_record = (find(&root_fields, "start_cell", false)
        + find(&root_fields, "start_local_x", false)
        + find(&root_fields, "start_local_y", false)
        + find(&root_fields, "start_local_z", false))
        / root.len().max(1) as f64;
    let absolute_fallback_bits = absolute_start_pos_bits_per_record * non_prev_count;
    let _ = prev_count; // documents intent; folded into continuity_bits already
    let projected_root_bytes_v7 =
        ((flags_byte_bits + non_continuity_bits + continuity_bits + absolute_fallback_bits) / 8.0)
            .ceil() as u64;

    SymbolAuditReport {
        residual_records: r.len(),
        root_records: root.len(),
        residual_conditional_total_bytes: sum(&residual_fields, true),
        residual_order0_total_bytes: sum(&residual_fields, false),
        root_conditional_total_bytes: sum(&root_fields, true),
        root_order0_total_bytes: sum(&root_fields, false),
        residual_wire_uncompressed_bytes,
        residual_wire_zstd_bytes,
        root_wire_uncompressed_bytes,
        root_wire_zstd_bytes,
        had_prev_fraction_pct: had_prev_fraction * 100.0,
        start_rot_inherit_pct,
        projected_root_bytes_v7,
        root_continuity_fields,
        residual_fields,
        root_fields,
    }
}
