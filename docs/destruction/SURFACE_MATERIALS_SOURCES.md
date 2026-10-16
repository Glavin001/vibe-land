# Surface materials: sourced friction and restitution

This is the evidence base for `VIBE_SURFACE_MATERIALS`, which gives each surface its own `PxMaterial` (AGENTS.md). A research agent compiled it on 2026-10-08.

- **Rules for the packs:** a value goes into a pack only together with its citation. A row marked **gap** stays on the world material until someone measures it or finds a source.
- **Terms:**
  - μs is static friction and μk is kinetic friction, both dry.
  - COR is the normal coefficient of restitution, which is what PhysX's `restitution` acts on.
  - Design-code values are design values (lower bounds or shear-friction values), not measured means.
- **Status:** the plumbing and its test are done (`physx-bridge/tests/surface_materials.rs`). The values and the combine modes are waiting on the owner's decision; see the end of this document.

## Friction

| Class | Self pair | Partners | Source | Confidence |
|---|---|---|---|---|
| Concrete | Interface μ: 0.5 very smooth (formed against steel), 0.6 smooth, 0.7 rough, 0.9 indented | Steel: μs 0.57 dry, 0.65 wet (0.57–0.70). Timber: 0.40 | EN 1992-1-1:2004 §6.2.5(2). ACI 318-19 Table 22.9.4.2. Rabbat & Russell, *J. Struct. Eng.* 111(3):505 (1985). EN 1995-2 | Medium. Use 0.6 for formed faces, 0.7 for fractured faces |
| Masonry, brick and mortar | Bed joint μ 0.64–0.75. EN 1996 design slope 0.4 | — | Atkinson et al., *J. Struct. Eng.* 115(9):2276 (1989). EN 1996-1-1 §3.6.2. *Materials* 8:5489 (doi 10.3390/ma8125489) | Medium |
| Natural stone | Basic friction angle on sawn faces: 27–34° (μ 0.51–0.67) for sandstone and slate, 34–40° (μ 0.67–0.84) for granite and limestone. Rough rock peak ≈ 0.85 | — | Barton & Choubey, *Rock Mech.* 10:1 (1977). Byerlee, *PAGEOPH* 116 (1978) | High |
| Timber (softwood) | Sawn on sawn: 0.30 (≤12% MC) / 0.45 (≥16%). Planed: 0.20 / 0.40. Parallel to grain: 0.23 / 0.35 | Timber on concrete: 0.40 | EN 1995-2:2004 friction table (lower bound) | High as a lower bound |
| Timber, measured | μs 0.42–0.63; one study μs 0.47 / μk 0.36 | Steel: 0.19–0.5 | preprints.org 202404.0050. *Forests* 13:1078 | Medium (wide scatter) |
| Structural steel | Slip factors: Class A 0.50 (blasted), B 0.40, C 0.30, D 0.20. AISC: 0.30 for clean mill scale. Clean lab steel: 0.74 / 0.57 (secondary source) | Concrete: 0.57–0.70 | EN 1090-2 (EN 1993-1-8 Table 3.7). AISC 360 §J3.8 | High for slip factors. Use 0.3 for a painted or mill-scale surface |
| Glass (clean) | μs 0.9–1.0, μk 0.4. Under impact: 0.44 ± 0.07 | — | Textbook tables (secondary). Foerster et al., *Phys. Fluids* 6:1108 (1994) | Medium |
| Gypsum / drywall | **gap** | — | — | Needs a tilt test |
| Asphalt with tyre | Dry: peak 0.8–0.9, sliding 0.75 | Rubber on concrete: 1.0 / 0.8 | Wong, *Theory of Ground Vehicles* Table 1.3 (secondary). SAE 2010-01-0054 | Medium-high. Tyres belong in the PhysX Vehicle friction table, not `PxMaterial` |
| Hard plastic | Impact friction: LDPE 0.40, PP 0.44, nylon 0.34 | HDPE on steel: **gap** | Cornell impact table (Louge group) | Thin |
| Ceramic, slate | Ceramic spheres 0.42. Slate in the 27–34° band | Porcelain and slate on slate: **gap** | Cornell table. Barton & Choubey | Thin |

## Restitution (COR)

| Class | Low speed (<5 m/s) | Block scale, 5–30 m/s | Source | Confidence |
|---|---|---|---|---|
| Concrete / rock | mm spheres 0.97–0.98 (not representative of blocks) | Rock on concrete Rn 0.48 ± 0.19. Shotcrete 0.45. Hard bedrock 0.53. Strongly dependent on impact angle | Rocscience RocFall COR table (Pfeiffer & Bowen 1989; Giani 1992; Hoek). Wang et al., *NHESS* 18:3045 (2018) | Medium |
| Asphalt | — | Rock on asphalt Rn 0.40 ± 0.04. Hard paving 0.37–0.42 | Pfeiffer & Bowen 1989 (via Rocscience) | Medium |
| Steel | Steel sphere on steel plate 0.84 | Falls as V^-1/4 once plastic (Johnson, *Contact Mechanics* ch. 11). Vehicles 0.1–0.2 at crash speed, but that is a whole-structure value | Cornell table. Antonetti, SAE 980552 | High for the trend |
| Glass | Spheres 0.97; on aluminium 0.83 | The pane fractures: the solver's job | Foerster et al. 1994 | High at low speed |
| Timber | — | Rock on wood Rn 0.38 ± 0.13 | Wu 1985 (via Rocscience) | Thin |
| Plastics | PP 0.87, nylon 0.83, LDPE 0.71 ± 0.22 | Weak speed dependence | Cornell table. *Comp. Part. Mech.* 2022 | Medium |
| Ceramic, slate | Ceramic on steel 0.80 | Slate: use the rock values | Cornell. Rocscience | Thin |
| Tyre rubber, gypsum | **gap**: a tyre's bounce is its suspension, and gypsum crushes | — | — | — |

**Speed.** PhysX uses one constant COR per contact. Debris impacts in the game happen at block scale and at 5–30 m/s, so the rockfall values match that regime. Small-sphere values overstate COR for rough blocks by about 2×.

## Combine modes (PhysX 5.4.1, `PxCombineMode`)

- **What PhysX does:**
  - It offers `eAVERAGE`, `eMIN`, `eMULTIPLY` and `eMAX`.
  - When two materials disagree, the larger enum value wins.
  - The default is average.
  - PhysX deliberately uses no pair table, because the coefficients are empirical.
- **Other engines:** PhysX, Unity, Unreal and Rapier average both friction and restitution. Box2D and Jolt use the geometric mean for friction and max for restitution; max is a gameplay convention. Bullet multiplies.
- **The agent's recommendation:**
  - **Restitution: `eMIN`.** The softer or weaker body dominates the energy loss. For example, glass on glass is 0.97 but glass on aluminium is 0.83.
  - **Friction: the average** (the PhysX default). `eMULTIPLY` squares a self pair. No combine rule matches every measured cross pair. For example, steel 0.3 with concrete 0.6 averages to 0.45, against a measured 0.57–0.70.
- **Pair-specific values:**
  - PhysX's only per-pair mechanism is contact modification. It falls back to the CPU narrowphase on the GPU, and under AGENTS.md it probably counts as modifying the contact solver, so it is out unless the owner decides otherwise.
  - Tyres use the PhysX Vehicle tyre friction table.
- **Compliant contact** (negative restitution) gives a linear spring with a speed-independent COR that allows penetration. It is not for rigid structural chunks.

## Decisions for the owner

1. **Combine modes:** the PhysX default (average for both), or `eMIN` for restitution as recommended above.
2. **Gaps:** gypsum, porcelain, HDPE and tyre restitution. Either measure them, or keep the world material for them, which is itself uncited.
3. **The world material** (friction 0.5, restitution 0.1, `VIBE_WORLD_*`). It needs a cited value or a named surface, such as the static ground's.
