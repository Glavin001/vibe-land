# Matter materials

Procedural WebGPU materials (oak, concrete, brushed steel, marble, clear glass)
ported from the Matter lab into `client/src/graphics/matter/`. The lab is at
`/materials`; `client/e2e/matter-parity.ts` compares it against a reference
build of the original. Differences from the original:

- One WGSL field function per kind (`fields.ts`), sharing one noise library.
- `createMaterial(recipe, { space })`: the field can be evaluated in any frame
  (the city evaluates it in each chunk's rest frame).
- `tint` on every recipe (wood species and stains from one oak shader).
- Concrete's rough diffuse (EON) is our own TSL (`roughDiffuse.ts`): exact
  directional albedo instead of a polynomial fit, view terms once per pixel,
  and EON applied to indirect light as well. Tests: `roughDiffuse.test.ts`.
- three r182: the studio environment is written bottom-up and prefiltered
  explicitly (`specimens.ts`); on that three the port matches the original to
  ΔE 0.00 (concrete 0.14, the EON change).

The original author's notes follow.

---

# Matter — procedural material research edition 01

This implementation is a working WebGPU research platform, not a completed demonstration of scan-equivalent realism. It includes five continuous material models, 80 specimens, two furnished scenes, live recipes, proof studies, optical experiments, component ablations, and a reusable renderer. The distinction matters: a plausible mathematical model and fast execution do not establish photographic accuracy.

## Running and integration

The library archive contains `lib/materials`, the complete `lib/renderer` integration, default generated data, generators, numerical tests, and `examples/minimal`. Use Node 24, run `npm install`, then `npm run dev`. The minimal app uses the exact same renderer and shaders as the gallery. `npm run build` builds that example.

For a direct material integration:

```ts
import { createMaterial, updateMaterial, disposeMaterial, freshRecipe } from './lib/materials';
const handle = createMaterial(freshRecipe('oak'));
mesh.material = handle.material;
updateMaterial(handle, { seed: 104 });
// Before removing the material permanently:
disposeMaterial(handle);
```

Use `three/webgpu` and `three/tsl` from Three.js 0.185.0. The example aliases addon imports of `three` to `three/webgpu` to keep one consistent Three.js instance. Do not mix material nodes from different Three versions. Geometry must have positions and normals; brushed objects also need manufacturing tangents (`setManufacturingTangents`). All geometry positions are in meters.

`MaterialEngine` owns cameras, generated lighting, geometry, the marble diffuse filter, opaque scene captures, glass boundary acceleration structures, and the caustic worker. `createMaterial` alone returns the surface material. Full glass requires `attachGlassBoundary` plus `GlassScenePass`; full marble requires `ScatteringPass`. The engine demonstrates ownership and disposal of those resources. Its `setSample`, `updateRecipe`, and `setOptions` methods are the easiest complete integration.

`MaterialRecipe` contains material identity, an integer seed, material-coordinate scale, structural and finishing vectors, and optional oak knot position in meters. Named control definitions and bounds are exported in `MATERIALS`; `validateRecipe` rejects invalid identities, vector sizes, nonfinite numbers and out-of-range controls. `updateMaterial` changes uniforms immediately. Glass wall edits rebuild closed geometry and the boundary cache; the worker produces a coarse caustic followed by a refined version. Other fields are evaluated directly and need no spatial cache regeneration. Arbitrary topology edits require a new boundary cache.

## Implemented models and provenance

### Oak

A continuous trunk field is smoothly joined to an inclined branch field. Uneven growth time, earlywood vessel concentration, longitudinal vessel cells, and radial ray masks share those coordinates. Changing cut angle rotates the internal anatomy and the fiber direction together. The cutting-plane study constructs a closed section at the same material coordinates, so the newly exposed face samples the existing volume. Rays respond to the cut normal. The fiber axis is kept separate from the radial growth direction.

A generated inclination-response table adds a colored directional fiber response beneath a separate dielectric clearcoat. Sanding reduces pore relief and finish roughness; coating attenuates the fiber contribution. The table is an engineering integration of a proposed fiber distribution, not a fit to measured oak BRDF data. The growth field is inspired by the following papers, not an implementation of their complete knot simulation or an inferred tree history.

- [Procedural Texturing of Solid Wood with Knots, 2022](https://www.ma-la.com/procedural_knots/Procedural_Knots_2022.pdf)
- [Annual-ring inference research, 2024](https://onlinelibrary.wiley.com/doi/10.1111/cgf.15074)
- [Measured finished-wood appearance, 2005](https://www.cs.cornell.edu/~srm/publications/SG05-wood-lr.pdf)

Current limitations: one branch system, stylized vessel distributions, no measured species-specific ray/vessel statistics, no multiple scattering through the finish, and incomplete subpixel filtering of the broad growth bands. Plastic-looking highlights and overly regular grain remain human-review failure categories.

### Cast concrete

Mortar, coarse aggregate, smaller aggregate, fine pores and a sparse variable-radius cavity population have separate fields. A paste skin hides aggregate until grinding depth reaches it. Grinding and polishing alter exposure, relief and roughness together. Vertex relief carries larger cavities; two residual parallax steps and derivative normals carry smaller relief. An approximate cavity horizon attenuates direct illumination at grazing angles.

Direct rough body reflection uses EON with Three.js' energy-partitioned dielectric body contribution. The numerical report integrates the standalone EON BRDF over the hemisphere and checks reciprocity. Indirect diffuse illumination remains Three.js' irradiance approximation: this is not a complete EON environment integral. The cavity horizon is a bounded local occlusion approximation, not a resolved ray-traced cavity shadow.

- [NIST cement-paste structure](https://www.nist.gov/publications/characterization-and-modeling-pores-and-surfaces-cement-paste-correlations-processing)
- [PCI architectural finishing reference](https://www.pci.org/PCI/PCI/Design_Resources/Architectural_Resources/Finishes_-_Colors__Forms__and_Textures.aspx)
- [EON paper, 2025, revised 2026](https://jcgt.org/published/0014/01/06/), [MIT reference implementation](https://github.com/portsmouth/EON-diffuse)

The two aggregate populations approximate a grading distribution; they are not a packed-particle simulation. Finite mesh tessellation limits silhouette relief. Grazing parallax is bounded for stability and cannot reveal an undercut.

### Brushed stainless steel

Finite, interrupted, directionally correlated grooves are combined with optional cross-brushing and sparse handling scratches. Manufacturing tangents are attached to each shape; compound parts have their own local frame. An offline 4 × 12 mm patch of 96 finite grooves generates a slope distribution. The runtime uses its RMS slope to broaden unresolved roughness while reducing the resolved normal contribution with footprint.

Direct reflection uses anisotropic GGX. Environment reflection uses a normalized five-point quadrature along the major axis with PMREM treatment of the remaining width. This is a bounded approximation inspired by the 2024 major-axis method, not a reproduction of every configuration in its reference implementation.

The shipped optical data is Karlsson & Ribbing's documented Avesta 832 MV austenitic stainless-steel sample, similar to 316. The CC0 table retains provenance. `generate_steel.py` interpolates n and k at 650, 550 and 450 nm and computes normal-incidence conductor Fresnel: approximately `[0.667145, 0.640751, 0.602571]`. This three-band approximation supplies GGX F0. It is not a spectral RGB integration or an exact complex-IOR angular Fresnel evaluation, and it does not describe every alloy.

- [Microgeometry and metal appearance](https://www.cs.cornell.edu/Projects/metalappearance/)
- [Major-axis environment lighting, 2024](https://diglib.eg.org/items/1941bb58-90d5-40cb-92bc-2e987b4897da)
- [Optical properties of stainless steel, Karlsson & Ribbing, 1982](https://doi.org/10.1063/1.331503)
- [Optical constants database](https://refractiveindex.info/?book=metals&page=stainless_steel&shelf=3d)
- [Recent stainless optical research, 2023](https://www.sciencedirect.com/science/article/pii/S2352492823015568)

RMS fitting captures a central width, not the full measured tail, polarization, diffraction or groove masking. The microgeometry generator and runtime groove fields belong to the same statistical family but are not identical topographies. A moving narrow light is necessary to assess the remaining streak regularity.

### Pale calcitic marble

A three-dimensional folded band field, fine veins and cellular grains generate coherent mineral identity. Polishing suppresses relief across color boundaries. The separate diffuse contribution is filtered in two nine-tap passes using depth, surface normal and material identity, while surface reflection remains sharp. The projected filter radius derives from offline diffusion-profile moments. A bounded thickness-dependent backlight term supports the thin-slab study.

`fields.py` mirrors the runtime mineral field in float32 and feeds the same structural realization into a Mitsuba 3 heterogeneous-volume reference. Independent random walks generate three heterogeneous half-space diffusion profiles. These are useful offline optical experiments; the filter has not been fitted to minimize image error against that Mitsuba scene. The random-walk integration omits a dielectric boundary; the Mitsuba reference includes it. The filter's material boundary is aware of marble versus other materials, but does not reproduce lateral transport across every mineral inclusion. The model remains an approximation to heterogeneous transport, with possible waxiness and thin-edge errors.

- [Marble geological description](https://www.dws.gov.za/Groundwater/Groundwater_Dictionary/marble.htm)
- [Separable subsurface scattering](https://www.iryoku.com/separable-sss/)
- [Heterogeneous scattering research](https://www.cs.cornell.edu/~kb/projects/heterogeneousSS/)
- [Mitsuba participating-media documentation](https://mitsuba.readthedocs.io/en/stable/src/generated/plugins_media.html)

The optical coefficients and color are proposed controls for a pale calcitic family, not measured values for a named quarry sample. The constant-time [Glinty research](https://research.adobe.com/publication/glinty/) was considered; discrete glints are not enabled in this polished default family because uncalibrated sparkle would make the surface less plausible.

### Clear soda-lime / low-iron glass

The primary renderer starts at an actual rasterized entry boundary and traverses triangle BVHs to subsequent boundaries. Hollow vessels and pipes have explicit inner and outer walls. Exact dielectric Fresnel, Snell refraction, total internal reflection, and Beer attenuation use the traversed path length. The traversal is bounded to eight interfaces, 384 node visits per search, and six triangles per leaf. Smooth shading normals interpolate across triangles. The opaque scene is captured separately and queried by a bounded screen-space ray march; misses use the generated environment. The grid, backing board and floor behind inspection samples are actual geometry. The proof renderer intersects these reference surfaces explicitly and retrieves their shading from the opaque capture; the general architectural path retains the bounded screen-space query.

A worker emits photons from one dominant directional light, traces glass boundaries, and deposits transmitted flux onto a bounded floor receiver. Coarse 40² and refined 112² emission grids produce a 128² irradiance cache. An opaque shadow removes the unrefracted direct beam; the additive receiving pass restores the estimated transmitted contribution. This is a limited one-light caustic, not general light transport. The scene's other illumination remains separate.

- [Fresnel, refraction and total internal reflection](https://www.pbr-book.org/4ed/Reflection_Models/Specular_Reflection_and_Transmission)
- [Pilkington heat-treated-glass manufacturing reference](https://www.pilkington.com/-/media/pilkington/site-content/usa/window-manufacturers/technical-bulletins/ats186installingheattreatedglass20130116.pdf)

Limits: non-TIR internal reflection branches are discarded after conserving their lost weight; only the transmitted/TIR path is followed. The first visible surface assumes the camera starts outside. Intersecting compound glass solids are independent boundaries, not a Boolean union. Reflection fallback uses the analytic environment; off-screen opaque geometry and hidden surfaces are missing. Screen-space hits can miss fine lines and produce discontinuities. Dispersion offsets three color directions around one geometric path rather than tracing wavelengths independently. Absorption controls interpolate proposed low-iron and green-edge coefficients, not measured spectra. The current smooth waviness field is generic; pane and vessel shape-error statistics still need manufacturing-specific calibration. No claim of global energy correctness is made for the composed glass/caustic pipeline.

## Scale, filtering and performance

Positions are evaluated continuously in object material coordinates; there are no UV images, repeating atlas tiles or texture wrapping boundaries. Reusing one recipe on separately manufactured parts intentionally reuses its blank; changing seeds produces different realizations. Large features use geometry where implemented, smaller resolved features use derivative normals and local relief, and selected subpixel populations fade into distributional roughness. This is not universal analytic antialiasing: rings, veins, scratch tails and specular motion still need review at extreme distance and scale. Material-coordinate scaling changes feature size; it does not change physical glass wall thickness.

Gallery thumbnails are generated on demand, retained in memory, and cached for the browser session. Only the inspector or architectural scene renders continuously. The marble filter exits cheaply on non-marble pixels; glass boundary work runs on glass fragments. The caustic integration runs off the main thread. Quality mode increases the pixel-ratio ceiling to 2; Balanced uses 1.5. An adaptive controller lowers pixel ratio before changing the defining optical behavior. Quality targets 30 fps and Balanced targets 60; neither is a frame-rate cap.

Generated studio environment panels, the direct key and a hemispherical fill are distinct emitters. Architectural reflection probes capture actual scene geometry with environment illumination temporarily removed, avoiding recursive probe capture. Moving architectural light periodically regenerates the probe. This is a local low-resolution probe approximation, not complete global illumination. Environment-only emitters do not cast geometric soft shadows. High-contrast direct shadows and missing contact/indirect effects can limit photographic appearance.

The on-page 1080p measurement fixes the drawing buffer to 1920 × 1080, warms up 45 frames and records 150 requestAnimationFrame intervals during object rotation. It includes presentation pacing, CPU activity and GPU stalls. It does not measure isolated GPU execution time and does not average repeated statistical trials. Inspect `browser-validation.json` for actual observed conditions and results. RTX 3060 and RX 6600 are intended targets, not tested hardware.

## Reproduction and evidence

```
python -m venv .venv
.venv/bin/pip install -r scripts/requirements.txt
.venv/bin/python scripts/generate_optics.py --references
.venv/bin/python scripts/generate_steel.py
node --import tsx tests/physics.test.ts
node --import tsx scripts/export_recipes.ts
.venv/bin/python scripts/generation_manifest.py
```

Mitsuba uses the CPU `scalar_rgb` variant; generation does not require GPU compute. Random streams have fixed seeds. The numerical data and images are reproducible under the pinned versions; floating-point/backend differences and run-time metadata can change checksums across platforms. The manifest records recipes, units, generator versions and per-file SHA-256 values. No downloaded photographs, environment scans or scanned texture maps are shipped. A published numerical optical-constant table is included as measurement provenance.

Current passing physical checks cover standalone EON nonnegativity, hemisphere energy and reciprocity; dielectric Fresnel/Snell/TIR/Beer identities; valid bounded recipes; all 16 finite shape geometries; BVH sphere intersections; and measured slab path length. They do not establish whole-material energy conservation, full GPU/CPU bit agreement, BRDF agreement with measured samples, or perceived realism. The BVH test found and fixed a nearly parallel ray/bounding-box tolerance bug in both the GPU and worker implementations.

The gallery's comparison-kit generator exports 45 randomized stills across five materials, three illuminations, and full/detail-removed/baseline-optics configurations. It embeds a configuration key behind a disclosure. Review scores are left blank. There is no completed human study, no external-photograph matching score, and no scan-versus-procedural accuracy claim. Review stills and then use the inspector for continuous orbit, moving light, grazing views, near/far inspection, multiple seeds and parameter extremes. Record plastic wood, uniform concrete dots, uninterrupted steel highlights, waxy marble, false glass thickness, swimming and sparkle explicitly.

Before calling this scan-quality, the next acceptance work is matched runtime/offline image fitting, measurement-backed calibration per material family, manufacturing-specific glass statistics, temporally filtered screen-space glass visibility, fuller projected-footprint filtering, and an actual blinded photographic comparison with independent reviewers.
