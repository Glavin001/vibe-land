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
scripts/unreal/demo.sh                         # PhysX server + web client + Unreal on citypp-demo
scripts/unreal/play-tests.sh                   # the automated suite against the live server
node scripts/unreal/compare-web.mjs            # the web /city from the comparison pose (headless Chromium)
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
| Other players (interpolated, roster) | done: the web's UAL mannequin, tinted per player; locomotion, jump phases, melee (Melee_Hook), death clip | `client-core/src/players.rs` | `VibeCity.Play.LookAtRemote` (jumping player in jump phases), `ShootRemote`, `KillRemote` |
| First-person walking, sprint, jump, crouch (server-authoritative, thin predictor) | done | `client-core/src/input.rs`, `predictor.rs` | `VibeCity.Play.WalkAndShoot`: 6.0 m/s per applied input frame |
| Rifle, cannon, meteor (1/2/3), fire interval, tracers, hit results, damage | done | `net_client` encoders/decoders | `WalkAndShoot`, `CannonAndMeteor`, `ShootRemote` (Unreal shot took a browser player 100 to 86 HP) |
| Aim (RMB, web FOV), melee (V), aerial camera (N), city reset (R) | done | core `melee`, `camera_drop` | `AimAndReset`, `AerialAndMelee` |
| Cars: assets, enter/exit (E), drive, chase camera, wheels, detached parts, suspension rig (wishbones, springs, steering), driven-car presentation predictor | done | `client-core/src/vehicles.rs` (ports of `vehicle-rig.mjs`, `visual-rig.mjs`, `vehiclePresentation.ts`) | `Drive` (56 of 58 rig parts off rest after 60 ticks), `WreckCar` |
| Cannonballs and meteors (flight, landing) | done | core dynamic bodies, meteor records | `CannonAndMeteor` |
| HUD: crosshair, HP, energy, weapon, spawn protection, car hints | done | frame `local` | screenshots |
| City geometry: convex hulls and boxes, standing cells, debris bodies | done | `client-core/src/geometry.rs` | every mesh closed and equal to its authored volume (24105 chunks of `fractured-downtown`); `VibeCity.Render.CityAndEffects`: all vertices drawn before and after a fracture |
| Per-building textures (the web's building hash, texture keys) | done, at 2K (the web: 1K/512) | `client-core/src/materials.rs`, `shared/assets/materials/catalog.json` | layer codes equal to the TypeScript (tsx fixtures) |
| Unreal materials for known materials | done: PBR from 2K Poly Haven sources (albedo, DirectX normal, AO/roughness/metal); real sets for the web's procedural limestone, slate and timber | catalog `hd` sources | `CityAndEffects` checks the material |
| Glass | material built (`M_VibeCityGlass`); the stock city has none | catalog `glass` | not yet seen on screen |
| Sun, sky, fog, ground | done: physical sky, real-time sky light; fog matched to the web's FogExp2 (value and slope at the 80 m AOI); ground tinted by the grass paint's canopy colour as the web's | sun from `sunSky.ts`; fog from `weather.rs`; tint from `grass.rs` `ground_tint` | `VibeCity.Render.Compare` against `compare-web.mjs` (below) |
| Weather presets (clear, dust storm, snow storm): fog colour and thickness, camera-wrapped particles drifting with the wind | done | `client-core/src/weather.rs` (port of `weatherPresets.ts`, `fogSettings.ts`); the particle shader is `WeatherParticles.tsx`'s, as HLSL | `VibeCity.Render.WeatherAndGrass`: 5000 snow particles and the preset fog, then clear |
| Meadow and shared painted grass (`/match-stats/<id>/grass`, polled every 2 s with If-None-Match) | done: blades per patch, species (grass, reed, wheat, corn, fern), crop rows, distance LOD, wind | `client-core/src/grass.rs` (ports of `grassPlacement.ts`, `GrassPaint.ts`, `foliageProfiles.ts`) | default patches and a painted patch (count, species split, first and last blades) equal to the TypeScript; `WeatherAndGrass`: the stored 84-tile layout loads and every patch regenerates |
| Destruction audio (fractures, entry, sheds, collapse waves, impacts, shots, server contacts, scrape loops, air, fly-bys) | done | `client-core/src/audio.rs`, `effects.rs` (ports of `model.ts`, `director.ts`, `destructionMix.ts`, `engine.ts`, `motion.ts`, `destructionSources.ts`) | mix, intensity, attenuation, random, closest pass, Doppler equal to the TypeScript; `CityAndEffects`: sounds and loops after a meteor |
| Dust where things break | done, as clusters of soft lit sprites | `client-core/src/effects.rs` | `CityAndEffects`: puffs after a meteor |
| Cursor (Esc frees, click captures, focus loss frees) | done | (Unreal only) | `VibeCity.Cursor` |
| Session drops | rejoin | `client-core` | (fork commit dd5c0765) |

## Side by side

`VibeCity.Render.Compare` and `scripts/unreal/compare-web.mjs` render the same match from the same
pose (the web replay's rig: (0, 14, 140) looking at (0, 6, 0), 75° vertical, 1280×720). The first
comparison found three differences, since fixed: Unreal's fog was about a hundredth as dense as
the web's, its ground was the untinted ochre photograph, and its capture FOV was horizontal. What
remains is look, not content: Unreal's auto-exposure renders brighter with a paler sky, the web's
ground has dirt patches (its splat map), and the web's fog curve (Gaussian) is thinner under 40 m.

## Known gaps

- **Audio beds.** The web's debris "activity" beds, vehicle engine loops and occlusion are not
  ported. Bonds broken between two moving bodies are placed at rest. There is no dust budget in
  the core (Unreal recycles the faintest of 64 live puffs).
- **Dust look.** The web's dust is volumetric (fluid parcels). Unreal draws clusters of lit
  sprites; local fog volumes did not render in this configuration, and a Niagara system is the
  native upgrade.
- **Remote players.** No crouch clip; death is the web's death clip, not its cosmetic ragdoll.
- **Ground splat map.** The web's ground blends dirt by a splat map and a macro field; Unreal's
  draws the grass photograph with the canopy tint only.
- **Lumen.** Procedural meshes have no distance fields, so Lumen's software tracing does not see
  the city. Lighting is the sky light plus shadows.
- **Species meshes.** Painted reeds, wheat, corn and ferns are placed as the web places them, but
  drawn as blades of their profile's width (the web draws its foliage canopies).
- **Web adoption of the core.** Under way module by module behind flags (the shared SnapshotV2
  decoder through WASM is in progress); audio, effects, grass and weather still run as
  TypeScript on the web, pinned to the Rust ports by fixtures.
