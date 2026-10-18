# Small native ground-contact reproduction

`bathtub-ground-contact.json` is an eight-chunk freestanding bathtub, with its original metadata and impact. It first reaches observed, converged rest at 9.81 m/s² and remains intact for a further 30 simulated seconds. The impact then breaks 12 bonds. In the recorded diagnostic, one bottom panel continued falling through the ground; the remaining assembly converged, but the escaped body prevented physical rest.

The recorded final escaped-body position was approximately `[0, -2167, 101]` metres and vertical velocity `-39.08 m/s`. That observation came from the SDK reference contact/island paths with a 10 km ground box. The standard contact path and a separate 17 × 17 grid of touching 32 m ground tiles also failed the settling gate. The latter has a 544 × 544 m footprint and a 4 m ground depth; these changes did not resolve the issue.

Reproduce through the kit's sequential-review lock:

```sh
cp repros/bathtub-ground-contact.json out/repro-bathtub.json
cp repros/bathtub-ground-contact.meta.json out/repro-bathtub.meta.json
TOWN_KIT_TILED_GROUND=1 node scripts/review.mjs repro-bathtub furniture
```

Inspect `out/reviews/repro-bathtub-furniture/report.json` and `recording.json.gz`. A successful repair should pass the existing gate without forcing sleep, freezing bodies, changing gravity or suppressing destruction. The report's failed exit code is intentional when the body does not settle. The kit does not edit bridge or SDK source.

This is an observed collision/settling failure, not a proven diagnosis of a particular SDK function. The snapshot allows investigation independently of the café's thousands of pieces. A counter using the original box representation showed the same continued fall for a released handle; the paired snapshots below preserve that case. All native commands use their own kit build directory and record the exact SDK/hardware/settings used.

## Equivalent-collider comparison

The current counter and bathtub use eight-corner convex hulls with exactly the same surfaces, masses, materials and bonds as their former box primitives. Both now pass intact stability and impact settling. The counter impact breaks 25 bonds and the bathtub impact breaks 7 bonds in the recorded comparison. No gravity, sleep, strength or destruction setting was changed.

`collider-contact/` preserves both representations of each small prop. To reproduce the bathtub comparison (replace `bathtub` with `counter` for the second case):

```sh
for profile in box hull; do
  cp repros/collider-contact/bathtub-$profile.json out/repro-bathtub-$profile.json
  cp repros/collider-contact/bathtub-$profile.meta.json out/repro-bathtub-$profile.meta.json
  node scripts/review.mjs repro-bathtub-$profile stability
  node scripts/review.mjs repro-bathtub-$profile furniture
done
```

Review files include `report.json`, `provenance.json`, `asset.json.gz`, and `recording.json.gz`. The preview reads compressed recordings transparently. Hashes refer to the decompressed JSON bytes. The failed box result remains useful evidence; it must not be replaced with the passing hull result when investigating the engine.

This representation change is deliberately limited to those two props. A broad building conversion fixed a wall-impact case but regressed other prop impacts and produced native topology rejections in several two-storey checks. Extremely slender hulls also exceeded the SDK's GPU cooking limit. Those experiments are retained under `out/reviews/diag-*` and `out/reviews/convex-global-matrix.json`; they are not accepted kit variants. The observed difference identifies a useful asset representation, not a proven root cause in the native backend.
