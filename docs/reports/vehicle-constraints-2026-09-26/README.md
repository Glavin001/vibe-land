# Vehicle constraint integration — work in progress

The car still does not fracture. Bombardment and functional corner disablement
are present, but impact-driven connectivity does not yet control those corners.

## Implemented and locally tested

The isolated PhysX source now gives each Vehicle2 corner its own constraint
identity. Each calls the existing Vehicle2 solver-preparation function with
one active wheel in its padded constant block. The rows request force writeback;
their physical equations are unchanged. This makes a corner's real solved
suspension-limit and sticky-tire wrench available for attribution to its parts.

The test caught stale CPU writeback after a constraint loses its last row.
Both CPU PGS and TGS preparation now clear the linear/angular output in that
case, preserving the broken flag. GPU empty-row writeback already clears it.

`native_vehicle_constraints_test` drops a car onto suspension limits, removes
one corner, then removes all corners. Chassis contacts are disabled only in this
accounting fixture so its momentum equation isolates suspension/constraint
loads. Stabilization and damping are also disabled only in this accounting
fixture: stabilization introduces a separate velocity projection. An initial
GPU PGS run with stabilization enabled correctly failed the simplified momentum
oracle at frame 39 (0.0373 m/s residual); production settings are unchanged, and
the independent heightfield/driving reference retains stabilization.
It compares measured velocity with Vehicle2 commands plus actual solved
constraint impulses, requires nonzero loaded constraints, and rejects force
or torque on disabled corners. CPU and local CuMetal GPU both pass for PGS and
TGS. Each case observes 256 nonzero corner loads, including a peak around
69.2 kN. Maximum velocity-accounting residuals are recorded in `corner-loads.log`.

The independent heightfield/driving reference passes with four constraints:
CPU/GPU minimum chassis height is 0.5547 m; maximum jounce is 0.2000 m.
The command observer still conserves the Vehicle2 command integration.

Files: `native-wheel-constraints.wip.patch`, `command-loads.log`,
`heightfield-driving.log`, and `corner-loads.log`.
The foundation is now checkpointed in PhysX commit `ab88dd85`.

## Native-engine continuation approved

The user approved continuation on 2026-09-26 and required checkpoints before
changes. Vibeland was committed as `352f9221`; PhysX as `ab88dd85`.
Subsequent constraint routing and transactional ownership work is isolated.

The proposed continuation is confined initially to the sibling PhysX source and
its existing isolated `out/build/garage-multihull` build:

1. Register stable per-corner constraint identities against authored chunks;
   consume native GPU solved writebacks in the stress pass. Validate duplicates,
   scene ownership, force/torque conventions and missing/stale inputs.
2. Extend the correction transaction to select new constraint owners from actual
   GPU connectivity. Remap surviving constraints, adjust COM-dependent rows and
   disable constraints whose required attachment chunks have separated before
   the corrected solve. Preserve the unsupported-constraint guard for anything
   not covered by this contract.
3. Rebuild the public/private ABI consumers together and prove localized breaks,
   retained bonds, corrected fragment motion and absence of force from detached
   wheels with native impact fixtures. Include normal-driving non-break tests.
4. Integrate the qualified engine with the server's authored vehicle graph,
   functional state, authoritative fragment stream, visual groups and reset.

The installed ABI-18 SDK and running garage
have not been replaced by this isolated work. No remote/Vast/CUDA run is proposed.
Local CuMetal results are functional evidence, not CUDA or isolated performance
qualification. Complete-step idle/impact performance and actual vehicle fracture
remain unqualified.
