//! Native stress-problem capture for GPU tests. With the diagnostic SDK
//! (scripts/perf/build-stress-capture-sdk.sh, selected by PHYSX_ROOT) the
//! stress solver writes, for each solve ordinal in PHYSX_STRESS_PROBLEM_SOLVES,
//! the exact system it solved, its final iterate and per-iteration history;
//! scripts/stress/oracle.py reads them. Recording is process-global and
//! write-once: each scene gets its own prefix, and the caller's environment is
//! restored when the scene ends, including on assertion failure. Callers hold
//! the shared GPU test lock. With the production SDK the variables are inert.

pub(crate) struct EquationCapture(pub(crate) Vec<(&'static str, Option<std::ffi::OsString>)>);

impl EquationCapture {
    /// Record solves `solves` ("first:last", inclusive) of one scene under
    /// `directory/prefix`. No directory: record nothing.
    pub(crate) fn new(directory: Option<std::path::PathBuf>, prefix: &str, solves: &str) -> Self {
        let Some(directory) = directory else { return Self(Vec::new()) };
        std::fs::create_dir_all(&directory).unwrap();
        let values = [
            ("PHYSX_COMPONENT_WORK_OUTPUT", directory.join(format!("{prefix}.components.jsonl")).into_os_string()),
            ("PHYSX_STRESS_PROBLEM_PREFIX", directory.join(prefix).into_os_string()),
            ("PHYSX_STRESS_PROBLEM_SOLVES", solves.into()),
        ];
        let saved = values.iter().map(|(key, _)| (*key, std::env::var_os(key))).collect();
        for (key, value) in values { std::env::set_var(key, value); }
        Self(saved)
    }

    /// The fracture fixtures' capture: VIBE_VEHICLE_CAPTURE_DIR, solves 0-200.
    pub(crate) fn for_scene(model: &str, scenario: &str) -> Self {
        Self::new(std::env::var_os("VIBE_VEHICLE_CAPTURE_DIR").map(Into::into), &format!("{scenario}-{model}"), "0:200")
    }

    /// Stage chunk i is solver node i: write each node's structure, authored
    /// node and name beside the capture, so offline results name chunks.
    pub(crate) fn write_node_map(directory: &std::path::Path, prefix: &str, report: &vibe_land_physx_bridge::FfiStressSolveReport,
        name: impl Fn(u32, u32) -> String) {
        let rows: Vec<_> = report.chunks.iter().map(|c| serde_json::json!({"structure": c.structure_id, "node": c.node, "name": name(c.structure_id, c.node)})).collect();
        std::fs::write(directory.join(format!("{prefix}.chunks.json")), serde_json::to_vec_pretty(&rows).unwrap()).unwrap();
    }
}

impl Drop for EquationCapture {
    fn drop(&mut self) {
        for (key, value) in self.0.drain(..) {
            if let Some(value) = value { std::env::set_var(key, value); } else { std::env::remove_var(key); }
        }
    }
}
