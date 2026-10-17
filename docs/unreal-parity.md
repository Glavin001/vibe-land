# Unreal `/city` client: parity with the web

The Unreal client (`unreal/VibeCity`) is a second renderer for the web's `/city` on city wire 4
(`citypp*` matches). It joins the same Rust server as the browser, and players on either client
play together. Everything below the renderer is shared Rust code: the protocol codecs
(`shared/src/net_client.rs`), and the sans-IO client core (`client-core/`, linked into Unreal
through `client-core-ffi/`). The web is meant to move onto the same core through WASM.

This page lists what the web `/city` does (from the client inventory of 2026-10-17), where the
Unreal client stands, which shared code does it, and the evidence.

## Run it

```bash
scripts/unreal/import-city-materials.sh --hd   # city, glass, dust and grass materials (2K Poly Haven), once
scripts/unreal/import-city-audio.sh            # the web's destruction clips, once
scripts/unreal/import-city.sh --match citypp-demo  # the match's city as Nanite cells (per manifest hash)
scripts/unreal/demo.sh                         # PhysX server + web client + Unreal on citypp-demo
scripts/unreal/play-tests.sh                   # the automated suite against the live server
node scripts/unreal/compare-web.mjs            # the web /city from the comparison pose (headless Chromium)
node scripts/unreal/cross-client.mjs           # a web player and an Unreal player in one match, checked from both sides
```

`-VibeWeather=clear|dust_storm|snow_storm` (and `vibe.weather` in game) picks the web's weather;
`vibe.capture px py pz tx ty tz [fov]` parks the camera at a server-space pose, as the web's
`window.__VIBE_E2E__.setCapturePose` does.

Generated content (`unreal/VibeCity/Content/VibeCity/`) is not committed. The inputs are the web's
texture sheets and audio clips, `shared/assets/materials/catalog.json`, and the scripts.

## Features

| `/city` feature | Unreal | Shared code | Evidence |
|---|---|---|---|
| Join a `citypp` match over WebTransport, session config, cert pinning, manifest | done | `client-transport-wt`, `client-core` | `vl-headless` gate: every snapshot the server produced arrived, 0 decode errors |
| Wire 4 destruction stream (keyframes, events, acks, resync on hash mismatch) | done | `perplayer` client inside `client-core/src/city.rs` | 0 hash mismatches in every run; `vl-headless --gate` |
| Other players (interpolated, roster) | done: the web's UAL mannequin, tinted per player; locomotion, jump phases, melee (Melee_Hook), the web's cosmetic ragdoll on death (13 bodies, 12 joints) | `client-core/src/players.rs` | `VibeCity.Play.LookAtRemote` (jumping player in jump phases), `ShootRemote`, `KillRemote`, `VibeCity.Render.Ragdoll` (the body lies down: pelvis about 16 cm over the ground) |
| First-person walking, sprint, jump, crouch (server-authoritative, thin predictor) | done | `client-core/src/input.rs`, `predictor.rs` | `VibeCity.Play.WalkAndShoot`: 6.0 m/s between two snapshots (per server tick), server velocity exact |
| Rifle, cannon, meteor (1/2/3), fire interval, tracers, hit results, damage | done | `net_client` encoders/decoders | `WalkAndShoot`, `CannonAndMeteor`, `ShootRemote` (Unreal shot took a browser player 100 to 86 HP) |
| Aim (RMB, web FOV), melee (V), aerial camera (N), city reset (R) | done | core `melee`, `camera_drop` | `AimAndReset`, `AerialAndMelee` |
| Cars: assets, enter/exit (E), drive, chase camera, wheels, detached parts, suspension rig (wishbones, springs, steering), driven-car presentation predictor | done | `client-core/src/vehicles.rs` (ports of `vehicle-rig.mjs`, `visual-rig.mjs`, `vehiclePresentation.ts`) | `Drive` (56 of 58 rig parts off rest after 60 ticks), `WreckCar` |
| Cannonballs and meteors (flight, landing) | done | core dynamic bodies, meteor records | `CannonAndMeteor` |
| HUD: crosshair, HP, energy, weapon, spawn protection, car hints, flight panel | done | frame `local` | screenshots |
| HUD feedback: directional damage, crosshair red on a player (body or head), scope, melee cooldown, invulnerability countdown, "city reset" note | done | core `aim_target` (the server's hitscan capsule and head ball) | `aim_tests`; `KillRemote`: the crosshair marked the target |
| Performance pill (fps, server Hz, ping, Mbps) and the connecting / connection-lost banner | done | core `net_stats` | screenshots |
| Controls panel (every command, its binding and how hard it is held; keyboard or gamepad, on foot or driving; F1 folds) and the shared-grass status line | done | (Unreal HUD over the settings' bindings; the grass actor's poll) | `VibeCity.Play.Hud`: 12 rows, folds and unfolds, "Shared grass · <revision>" of the loaded layout (hud.png) |
| Batteries (energy dropped where players die) | done: glowing cells sized by energy | `net_client` `BatterySync` decoder, frame `batteries` | round trip against the server encoder; `KillRemote`: the dead player's battery listed and drawn |
| Settings: mouse, gamepad, key bindings, sound mix presets and dynamic range; gamepad play | done, as an Unreal panel | core audio mix | `VibeCity.Settings` |
| City geometry: convex hulls and boxes, standing cells, debris bodies | done | `client-core/src/geometry.rs` | every mesh closed and equal to its authored volume (24105 chunks of `fractured-downtown`); `VibeCity.Render.CityAndEffects`: all vertices drawn before and after a fracture |
| Imported city (an Unreal upgrade): one Nanite static mesh per 32 m cell, with a mesh distance field so Lumen sees it, baked per manifest hash; intact cells draw them, a cell swaps to its runtime mesh on its first change and back when intact again (a reset) | done | `client-core` `CityModel` (`vl_city_build`: the chunk table and meshes from the manifest alone, equal to a session's); `VibeCityCells` (one cell mesher for the game and the importer) | `city_model_matches_the_client`; `VibeCity.Render.ImportedCity`: 16 of 16 cells Nanite, each with its cell's triangles and a distance field; a meteor swaps the 2 it breaks, a reset brings them back |
| Per-building textures (the web's building hash, texture keys) | done, at 2K (the web: 1K/512) | `client-core/src/materials.rs`, `shared/assets/materials/catalog.json` | layer codes equal to the TypeScript (tsx fixtures) |
| Unreal materials for known materials | done: PBR from 2K Poly Haven sources (albedo, DirectX normal, AO/roughness/metal); real sets for the web's procedural limestone, slate and timber; weathering on top (colour variation, a splash band to 1.2 m, rain streaks), keyed to each surface's height in the intact city so it stays on a chunk that breaks away | catalog `hd` sources | `CityAndEffects` checks the material |
| Broken faces (an Unreal upgrade) | done: a face its bonded neighbours hide in the standing structure (sampled: corners, edge midpoints, centroids inside a neighbour's solid, not flush with its outside, not behind glass) wears its material's fracture surface (catalog `fracture`: concrete shows broken concrete) and no weathering | `client-core/src/geometry.rs` (`interior_triangles`), `VlMeshView::interior` | `geometry` unit tests (stacked cubes, a post on a slab, a panel under a narrower slab, an open joint, a flush slab edge); `geometry_manifest` (interior area at most twice the bonded area; glazing lowers it) |
| Meteor and cannonball look (an Unreal upgrade) | done: glowing basalt with ember cracks and a fire trail as long as 1/8 s of its flight, its light and glow fading after impact; forged-iron cannonballs | (Unreal only) | showcase frames |
| Glass | done (`M_VibeCityGlass`); the stock city has none, Vibe Town's windows use it | catalog `glass` | Vibe Town showcase (below) |
| Sun, sky, fog, ground | done: physical sky, real-time sky light; fog matched to the web's FogExp2 (value and slope at the 80 m AOI); the web's hero ground per pixel (grass and mud layers, dirt patches from its macro noise and thin cover, canopy tint, macro albedo and warmth) | sun from `sunSky.ts`; fog from `weather.rs`; noise from `ground.rs` (`cityMacroNoise`, byte for byte); cover from `grass.rs` | `VibeCity.Render.Compare` against `compare-web.mjs` (below): dirt patches in the same places |
| Texture scale | done: every texture tiles at the catalog size × the web's `cityTexScale` (2) | core tile UVs (`drawn_metres_per_tile`) | `geometry_manifest`: tile UVs = metres / (catalog tile × 2) on every chunk vertex |
| Weather presets (clear, dust storm, snow storm): fog colour and thickness, camera-wrapped particles drifting with the wind | done | `client-core/src/weather.rs` (port of `weatherPresets.ts`, `fogSettings.ts`); the particle shader is `WeatherParticles.tsx`'s, as HLSL | `VibeCity.Render.WeatherAndGrass`: 5000 snow particles and the preset fog, then clear |
| Meadow and shared painted grass (`/match-stats/<id>/grass`, polled every 2 s with If-None-Match) | done: blades per patch, species placed and shaped as the web's (seed heads on reeds and wheat, leaves on corn, fronds on ferns), crop rows, distance LOD, wind, the distant canopy over tall painted stands | `client-core/src/grass.rs` (ports of `grassPlacement.ts`, `GrassPaint.ts`, `foliageProfiles.ts`); shapes from `grassMaterial.ts` | default patches and a painted patch (count, species split, first and last blades) equal to the TypeScript; `WeatherAndGrass`: the stored 84-tile layout loads and every patch regenerates; `VibeCity.Render.Species`: every species drawn (species.png) |
| Destruction audio (fractures, entry, sheds, collapse waves, impacts, shots, server contacts, scrape loops, air, fly-bys, debris beds, car engines), heard from the camera, occluded by standing buildings, low-passed with distance | done | `client-core/src/audio.rs`, `effects.rs` (ports of `model.ts`, `director.ts`, `destructionMix.ts`, `engine.ts`, `motion.ts`, `destructionSources.ts`, `destructionActivity.ts`, `occlusion.ts`) | mix, intensity, attenuation, random, closest pass, Doppler, debris beds equal to the TypeScript; occlusion through a building and not over it; `CityAndEffects`: sounds and loops heard 35 m from a meteor |
| Dust where things break | done: the web's dust policy (parcels per source, the per-tick cap, smouldering cells, palettes), drawn on the web's curves as instanced volumes; the web sprite's opacity (`1 - exp(-0.9 dens D)`, its disc and erosion) and the web volumetric renderer's selection (in view, at least 3 px, distant parcels thinned by serial, the nearest 1024) | `client-core/src/dust.rs` (port of `dustPolicy.ts` and `dustParcelStore.ts`'s curves), `vl_dust_eval` | `dust_parity` (every parcel the same as the TypeScript); `VibeCity.Render.Dust` (growth, rise, lifetimes; 1500 clouds draw the nearest 1024, none behind the camera); `CityAndEffects`: 336 live parcels after a meteor |
| City stats (F9) | done: the server's match stats (`/match-stats/<match>`, once a second while open: physics step, tick, players, bodies, cars, batteries, city step p95, server traffic) beside the client's stream counters (fps and frame p95, chunks, bodies, snapshots, keyframes, events, fractures, hash checks, bootstraps, decode errors) | frame `stats` | `VibeCity.Play.Hud`: 7 server rows, 9 client rows (stats.png) |
| Cursor (Esc frees, click captures, focus loss frees) | done | (Unreal only) | `VibeCity.Cursor` |
| Session drops | rejoin | `client-core` | (fork commit dd5c0765) |

## Gates (2026-10-17, the PhysX server on this Mac)

| Gate | Run | Result |
|---|---|---|
| M1: `vl-headless` 60 s | `--seconds 60 --meteor-after 10 --gate` | 3579 of 3578 snapshots, 0 decode errors, 0 hash mismatches, 16 fractures, a freed body fell at −9.810 m/s² |
| M4: 5 minutes, ≥ 20 fractures | `--seconds 300 --meteor-after 10 --meteor-every 12 --gate --min-fractures 20` | 261 fractures, 0 hash mismatches, 0 decode errors, 17857 of 17856 snapshots, server at 0.993 of real time |
| Web on the shared core: 5 minutes, every core flag on | `node scripts/web-core-soak.mjs` (headless Chromium, a meteor every 12 s) | 25 meteors, up to 1634 live bodies presented, 496 hash checks, 0 mismatches, 0 decode errors, no render stalls, no page errors |
| Walk displacement | `VibeCity.Play.WalkAndShoot`; `vl-headless --walk` | 6.000 m/s, the server's walk speed, on both (the server's foot input fix, on by default since 2026-10-17; 6.53 m/s before) |
| Web and Unreal in one match | `node scripts/unreal/cross-client.mjs` (headless Chromium /city + Unreal MeetAndWalk, KillRemote, CannonAndMeteor, Drive) | Unreal 4 of 4; the web saw the Unreal player walk, was shot dead by it (its battery listed and drawn in Unreal), applied 353 destruction events from its meteor, and saw the car it drove move; 0 mismatches, 0 decode errors |
| Big city (`fractured-downtown`, 24 105 chunks) | a second server on side ports; `import-city.sh`; `VibeCity.Perf.Meteor` (8 s after a meteor) | imported as 30 Nanite cells (306 232 triangles, 14 s); city built in 12 ms; game thread: core poll under 0.5 ms, applying frames ~0 ms (p95 0.01, worst 8.8 ms when a struck cell swaps to its runtime mesh), dust 0.1 ms; frames p50 14 ms, p95 57 ms, one 400 ms hitch. The server ran this city at 0.24-0.36 of real time beside the main one on this Mac's GPU, so a meteor freed under 100 bodies: the plan's GPU pose path rule (4 ms at 4000 live bodies) was not reached |
| Unreal suite | `scripts/unreal/play-tests.sh` (one match on the server) | 17 of 17, and `KillRemote` with a stand-in; `CityAndEffects`: a meteor makes 10 fractures, 291 sounds and 336 live dust parcels from the web's policy |

## Other scenes

`VibeCity.Render.Showcase -VibeShowcase=eye_x,eye_y,eye_z,target_x,target_y,target_z,fov` (server
metres) films any scene: it parks the camera, drops a meteor on the highest chunk within 15 m of
the target and a cannonball from the player, and saves a frame every 0.5 s. Vibe Town
(`structures/vibe-town`, the server started with `scripts/native-mac.sh town`'s environment on side
ports) from Main Street toward the Market Quarter towers: `-VibeShowcase=50,9,10,90,14,-15,60`;
Elm Park's houses: `-VibeShowcase=-90,4,-44,-107,3,-63,60`. A scene without an import draws its
cells at runtime.

## Side by side

`VibeCity.Render.Compare` and `scripts/unreal/compare-web.mjs` render the same match from the same
pose (the web replay's rig: (0, 14, 140) looking at (0, 6, 0), 75° vertical, 1280×720). The
comparisons found, and fixed:

- Unreal's fog was about a hundredth as dense as the web's;
- the ground was the untinted ochre photograph, without the web's dirt patches;
- the capture FOV was horizontal;
- every texture tiled twice as densely (the core missed `cityTexScale`).

What remains is look, not content: Unreal's auto-exposure renders brighter with a paler sky, and
the web's fog curve (Gaussian) is thinner under 40 m.

## Deliberate differences

Side by side at the same poses on the same city (`compare-web.mjs` and `VibeCity.Render.Compare
-VibeCapture=...`, 2026-10-17): from (-18, 5, -16) toward (-42, 4, -42), Unreal draws the catalog's
brick, concrete and timber from its 2K sets with the sun's shadows; the web draws its 1K array
textures under its environment light.

The owner's direction (2026-10-17): Unreal need not match the web's look; it should use what Unreal
does better and match /city's function.

- **Lighting.** The web lights with its sky gradient's environment map and ACES tone mapping;
  Unreal uses its physical sky, sky light, Lumen global illumination and reflections, and virtual
  shadow maps, over 2K PBR materials (above), so it renders brighter and more physically.
- **Dust.** Both clients make the same parcels (the web's policy, in the shared core) and draw the
  same ones (in view, within the fog's cull distance, at least 3 px, distant ones thinned by serial,
  the nearest 1024). The web raymarches them as fluid volumes under a per-frame sample budget;
  Unreal draws each as a translucent, volume-lit ellipsoid with the web sprite's opacity, so its
  clouds read thicker. Filmed together in one match (`compare-web.mjs --frames` beside
  `VibeCity.Render.Showcase`, 2026-10-17), the headless web showed no dust at all in either mode
  (sprites: 410 live, 0 drawn; volumetric: 72 drawn, none visible), so a headless capture is not a
  reference for the web's dust; the shared parcels and the selection are what the tests compare.

## The plan, milestone by milestone

| Milestone | Status | Evidence |
|---|---|---|
| M0 link spike: the Rust core in Unreal, wtransport on this Mac | done | the editor logs the core's ABI and build; `city_bots` streams a `citypp` match |
| M1 the bike: both clients in one match, the city in Unreal, browser shots breaking it | done | M1 gate above; cross-client |
| M2 playable: walk, look, shoot, destruction from Unreal | done | `WalkAndShoot` (6.000 m/s), `CannonAndMeteor`, `ShootRemote`, `KillRemote` |
| M3 real geometry; the web on the core's decoders and geometry | done | `geometry_manifest`; the web's core flags (on by default), web soak |
| M4 the shared wire 4 presentation, destruction at scale | done | M4 gate (261 fractures, 0 mismatches); web soak with every core flag on |
| M5 high fidelity: catalog, import, Nanite, Lumen, mapped materials, fracture faces | done | `ImportedCity`, `Materials`; broken faces (catalog `fracture`); weathering |
| M6 players and input in the core; vehicles, VFX, HUD | done | `Drive`, `WreckCar`, `Dust`, `Hud` (with the stats panel), `Settings`, `Gamepad`, `Ragdoll` |
| Web and Unreal together | done | `cross-client.mjs`: Unreal 4/4; the web saw it walk, was shot dead by it, applied 1052 destruction events, saw the car it drove move; 0 mismatches |

What follows are differences from the web that come from the platform or from wire 4 itself,
shared by the web's /city, not features Unreal lacks.

## Known gaps

- **Moving debris.** Bonds broken between two moving bodies are placed at rest for dust and
  sound. Their dust starts with no velocity of its own, as on the web's /city: wire 4 carries no
  body velocities into its sources (`perPlayerCityClient.ts` builds each promotion with
  `linearVelocity: [0, 0, 0]`). Both clients behave the same.
- **Debug and admin tools** stay web-only: the stats overlay's renderer tools (cost sweeps, quality
  toggles) and RECORD TAPE (a capture of the web client's stream for `/cityreplay`), `/server-stats`,
  the world builder. Unreal has the overlay's readout (F9, above).
- **One machine, one GPU.** With the server on the same Mac, Lumen and virtual shadows slow the
  server's PhysX tick (about 49 Hz instead of 60). The tests that time the server's input run with
  standard lighting (`play-tests.sh`); for local play, `-dpcvars=r.DynamicGlobalIlluminationMethod=0,r.ReflectionMethod=2,r.Shadow.Virtual.Enable=0`
  does the same. A server on its own machine is unaffected.
- **Big-city frame tail.** On `fractured-downtown` the frame's 95th percentile was 57 ms and one
  frame took 400 ms while the game thread's own work (poll, apply, dust) stayed under 9 ms: the
  rest is the renderer, on a GPU two servers were also using. The 4000-body pose measurement needs
  a server that runs that city in real time.
- **Lumen on broken cells.** Lumen global illumination and reflections and virtual shadow maps are
  on, and imported cells carry distance fields. A cell drawing its runtime (procedural) mesh, after
  its first fracture or with no import for the manifest, has none, so Lumen's software tracing
  misses it until a reset. Hardware ray tracing would see those meshes too
  (`r.RayTracing.Geometry.ProceduralMeshes`), but Unreal 5.8 offers it on the Mac only on the SM6
  shader platform, and SM6 needs macOS 15: on this Mac (macOS 14.4) a launch with `-sm6` stops on
  "-sm6 is selected but Mac requires OS 15 to support SM6". Distance fields cannot be built at
  runtime outside the editor, so on macOS 14 this stays.
- **The web on the core (on by default since 2026-10-17).** Each module has its own flag, on by
  default (`client/src/core/coreFlags.ts` `coreFlag`); `?name=0` on the page URL, or its `VITE_`
  variable set to 0, puts that module back on its TypeScript. Every one is held equal to the
  TypeScript it replaces by a test, and all of them on ran the 5-minute soak below (and a 2-minute
  one on the defaults: 10 meteors, 530 live bodies, 0 mismatches; all off: 0 mismatches):
  - packet decoders and encoders: `sharedDecode`;
  - chunk hulls: `coreGeometry`;
  - the 60 Hz input frames: `coreInput`;
  - grass placement over the shared paint: `coreGrass` (`coreGrass.test.ts`; the core's patch
    (0, 0) in the browser has the TypeScript's 8917 blades);
  - each sound's voices and debris beds: `coreAudio` (`voicePlan.core.test.ts`, 2000 random
    events);
  - remote players: `corePlayers`;
  - the city manifest: `coreManifest`;
  - the local player's presentation lead: `corePredictor` (`thinAuthoritativePredictor.core.test.ts`:
    20,000 seeded frames, the same position every frame with both at 6 and 9 m/s; by default the
    core leads sprint at the server's 8.5 m/s, not the TypeScript's 9);
  - the wire 4 city stream, built by the core from the manifest's bytes (the server's
    `structure_defs`) instead of flattened in TypeScript: `coreStream`
    (`perPlayerWasm.core.test.ts`, on a recorded session in `client-core/tests/corpus/citypp-meteor`:
    1031 packets, up to 290 bodies, every pose, change and ack identical). Both clients already
    reconstruct the stream with the same Rust (`perplayer`); what stays TypeScript on the web is
    the adapter into its renderer's ledger.

  The weather table is one file both clients read (`shared/assets/weather/presets.json`). Still
  TypeScript on the web, pinned to their Rust ports by fixtures: the destruction sources and dust
  queue, motion, debris beds and occlusion.
