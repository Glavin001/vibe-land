# Decisions for the owner (2026-10-08)

Every item below is blocked on a decision under AGENTS.md: "If any answer is 'no' or 'unsure', stop and ask the owner".

- The **four questions** are: Standard? Correct? Architecture (loads in, broken joints out)? City scale?
- Each item has my recommendation. Reply with yes or no per item, or another choice.
- Everything is measured on the clean baseline: PhysX and vibe-land `clean/high-fidelity`, SDK `garage-clean`.

## Blocking the known gaps

**1. Load over the impact duration, with inertia.** This is the stress solver's input model: solve (K + M/h²) Δu = f for the impact's part of the load, with f = the PhysX-reported impulse / h.

- **Four questions:**
  - Standard: implicit Newmark / backward Euler (Chopra; Bathe), with the impact force over its duration (EN 1991-1-7 Annex C).
  - Correct: yes.
  - Architecture: inside the solve; nothing is written to PhysX.
  - Scale: one diagonal term in the same PCG, plus a second solve only for impacted components.
- **The open choice is h:**
  - (a) the tick, dt. Standard backward Euler over the step in which PhysX delivered the impulse; nothing invented.
  - (b) the contact duration from a cited contact law. Hertz for hard impactors; EN 1991-1-7 Annex C for vehicles.
- **Recommendation: (a)** first. It needs no new constant. Measure it on the four gaps, then decide whether (b) is needed.
- **Targets:**
  - balls stop dead at the brick and stone house faces;
  - damage spreads beyond the impact zone;
  - `meteor-on-a-foundation`: thrown up at 42.1 m/s, where 9.5 m/s is allowed;
  - `vehicle-contact-load`: graded at 1.55× the momentum change.
- **Test first:** single-degree-of-freedom and chain closed forms; the scenario matrix's gates are the acceptance.

**2. Static ductility re-port** (steel joints that yield instead of snapping). The impact-capacity material fields it read are gone.

- **Choice:**
  - (a) Return mapping only. Slip = excess / k with k = EA/L, rupture at the ultimate slip (A·L0, EN 1993-1-1 3.2.2). Standard plasticity (Simo & Hughes).
  - (b) Also the necking section loss, in proportion to slip over ultimate slip. An invented damage form, which fails "Standard".
- **Recommendation: (a)**, with its own material fields: E per material, and ductile slip.

**3. Surfaces** (`VIBE_SURFACE_MATERIALS`, built and tested, off). Sources in `SURFACE_MATERIALS_SOURCES.md`.

- **a. Combine mode:**
  - Friction: PhysX's default average, eAVERAGE. Recommended.
  - Restitution: eMIN (the softer surface dominates the energy loss) or the default eAVERAGE. **Recommendation: eMIN.** It is evidence-backed, but the evidence is thin.
- **b. Unsourced** gypsum, porcelain, HDPE and tyre bounce. **Recommendation:**
  - keep these on the world material for now, and say so in the pack;
  - tyres belong in the PhysX Vehicle tyre table anyway.
- **c. The world material** (friction 0.5, restitution 0.1) is itself uncited. **Recommendation:** make it the static ground's named surface (asphalt or soil, cited), not a global value.

**4. Vibe Town hangs the desktop.** It happened three times, about a minute after launch, at rest. Details are in `docs/perf/NATIVE_APP_FINDINGS.md`.

- **Proposal:** a 40 s headless measurement, stopping before the ~55 s hang point. It records GPU time per command buffer and its kernels (`CUMETAL_TRACE_COMMITS`, `gpu-submission-summary.py`), plus the app's footprint once a second.
- **Recommendation: yes.** The fix that follows is responsible GPU use: bounded submissions and a per-frame physics budget, with no kill switch.

## Model choices in the fidelity audit (`docs/verification/FIDELITY_AUDIT.md`)

| Item | Today | Standard alternative | Four questions | Recommendation |
|---|---|---|---|---|
| B8 | Shear graded as the average V/A | Peak V/A times the section's shear coefficient: 1.5 for a rectangle, 2 for a thin tube (Gere & Goodno 5.8) | Standard yes, correct yes, architecture yes, scale yes | Yes, behind a flag, with a textbook test. Today understates shear utilisation by up to 1/3. |
| C3 | Linear interaction: max(axial) + shear | Per material: von Mises σ² + 3τ² ≤ f² for steel; EN 1995-1-1 6.2.4 for timber | Yes on all four | Yes, behind a flag, one material family at a time, with textbook tests. Today is conservative by up to 2×. |
| C1 | Damage-arrest ceiling (residual area at the concrete's limits) | None needed: it is already off in the high profile (`VIBE_STRENGTH_SHORT_TERM`) | — | Keep it off in high. For the runtime profile, decide when runtime adopts the high model. |
| D6 | Round-number joints (fatal = 2 × elastic) with no source: glazing, plastered timber wall, timber joint, furniture joinery, cladding fastener, appliance panel | Fastener and connection capacities as the veneer houses do them (EN 1995) | Authoring with citations, which AGENTS.md already lists as valid | Yes: author them with citations. Qualify each structure at rest after. |
| E10 | Terrain is an infinite static box | Poncelet soil penetration resistance, F = A (c0 + c2 ρ v²) | Architecture: **no**. It needs a contact force law of our own, outside PhysX. | No, unless PhysX offers a standard representation. A known gap. |
| A4, A5 | Midpoint springs; equal-mass weighting | Already fixed in the high profile (section rotation; real masses on the native path) | — | Nothing to do on the high profile. |
