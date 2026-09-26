# Bayline Town with Gardens & Market

A separate fork of `bayline-town`, preserving its six furnished buildings and
crossroads. The generated scene is
`out/bayline-town-with-gardens-and-market.json`; the original scene is unchanged.

The 48 outdoor placements include all 20 outdoor prop types. Juniper has a
carport, shaded garden seat, planted containers, bins, mailbox and brick garden
wall. The southwest pocket market has striped stalls, produce, outdoor tables,
chairs and a bus stop. The grocery has cycle parking and a hydrant. The foundry
yard has scaffolding, pallets, crates, dumpster, barrier and roadside billboard.
The three natively qualified tree variants supply shade and flowering crowns.
Conifer/sapling variants remain in the authoring collection pending qualification.

Canopies, awnings, produce and planted-container detail are attached to their
owning physical chunks. Decorative ground textures in the atelier are visual
surfaces; the playable scene uses the city's existing ground renderer.

## Build and play

From this directory:

```sh
npm run build:bayline-gardens
npm run play:bayline-gardens
```

The live town opens at `http://127.0.0.1:6180/city?portal=true`, using the normal
city game page with this separate furnished scene. The launcher pairs the client
scene preset with the server pack so foliage, attached details, cannon controls
and reset are available on `/city`. Other city deployments keep their settings.
The live town uses the dedicated playground ports 6180/6181/6182. Stop the old
playground first; the launcher refuses occupied ports. `--no-build` reuses an
already-built native city server. The original exhibit layout remains available
with `npm run play`. The furnished town equips the heavy 2,000 kg / 35 m/s
demolition cannon so the tougher fixtures can also be broken during free play.

## Cannon film

Build the native harness using the SDK configuration documented in README.md,
then stop the live playground to release its GPU lock:

```sh
npm run record:bayline-gardens
npm run preview
```

Open the new asset in the atelier and click **Record cannon tour**. The film is
recorded from rendered native simulation playback, with captions identifying
each target. It is a controlled cannon demonstration, not a recording of manual
first-person input. Most shots use the exhibit playground’s 500 kg / 25 m/s cannon. The shelter,
dumpster and road barrier use a heavier 2,000 kg / 35 m/s round. Firing positions are checked for obstructions from other objects.
No bonds are scripted to break.

The 26 chapters cover the 20 outdoor prop types, three tree variants, cafe
table and chair, and house brickwork. Every chapter must produce broken target bonds and visible movement
before the video export is enabled. Per-target evidence, native status and the
30-fps chunk-pose recording are in
`out/reviews/bayline-town-with-gardens-and-market-cannon/`.

The video recorder saves a captioned 1280×720 WebM under `out/films/`. It uses
only the local preview server, and never uploads to an external host. The
chapter timeline and baked scene/visual sidecars make the demonstration
repeatable. Existing houses, interior furniture and repeated props remain
independently destructible in the playable scene; the film targets one example
of each outdoor type rather than every repeated placement.

## Verified film (2026-09-26)

The full-town native run passed intact settling with zero broken bonds, then
completed 54 cannon shots. All 26 featured targets fractured and moved; the
scene recorded 399 broken bonds with valid native chunk mappings. The nine
scene/outdoor tests and preview TypeScript check passed.

The reviewed export is `out/films/bayline-gardens-market-cannon-tour.mp4`
(1280×720 H.264, 161.6 seconds, about 30 fps). Its source capture is
`out/films/gardens-market-cannon-tour-1790408084410.webm`; the checked contact
sheet is `out/films/tour-contact-sheet-final.jpg`. Recording dimensions stay
fixed when the app is resized. The fork's cafe tables use weaker wood seams;
concrete barriers now split at their authored segment seams.
