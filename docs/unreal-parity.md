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
| Other players (interpolated, roster) | done: the web's UAL mannequin, tinted per player; locomotion, jump phases, melee (Melee_Hook), the web's cosmetic ragdoll on death (13 bodies, 12 joints) | `client-core/src/players.rs` | `VibeCity.Play.LookAtRemote` (jumping player in jump phases), `ShootRemote`, `KillRemote` (pelvis falls to the ground) |
| First-person walking, sprint, jump, crouch (server-authoritative, thin predictor) | done | `client-core/src/input.rs`, `predictor.rs` | `VibeCity.Play.WalkAndShoot`: 6.0 m/s between two snapshots (per server tick), server velocity exact |
| Rifle, cannon, meteor (1/2/3), fire interval, tracers, hit results, damage | done | `net_client` encoders/decoders | `WalkAndShoot`, `CannonAndMeteor`, `ShootRemote` (Unreal shot took a browser player 100 to 86 HP) |
| Aim (RMB, web FOV), melee (V), aerial camera (N), city reset (R) | done | core `melee`, `camera_drop` | `AimAndReset`, `AerialAndMelee` |
| Cars: assets, enter/exit (E), drive, chase camera, wheels, detached parts, suspension rig (wishbones, springs, steering), driven-car presentation predictor | done | `client-core/src/vehicles.rs` (ports of `vehicle-rig.mjs`, `visual-rig.mjs`, `vehiclePresentation.ts`) | `Drive` (56 of 58 rig parts off rest after 60 ticks), `WreckCar` |
| Cannonballs and meteors (flight, landing) | done | core dynamic bodies, meteor records | `CannonAndMeteor` |
| HUD: crosshair, HP, energy, weapon, spawn protection, car hints, flight panel | done | frame `local` | screenshots |
| HUD feedback: directional damage, crosshair red on a player (body or head), scope, melee cooldown, invulnerability countdown, "city reset" note | done | core `aim_target` (the server's hitscan capsule and head ball) | `aim_tests`; `KillRemote`: the crosshair marked the target |
| Performance pill (fps, server Hz, ping, Mbps) and the connecting / connection-lost banner | done | core `net_stats` | screenshots |
| Batteries (energy dropped where players die) | done: glowing cells sized by energy | `net_client` `BatterySync` decoder, frame `batteries` | round trip against the server encoder; `KillRemote`: the dead player's battery listed and drawn |
| Settings: mouse, gamepad, key bindings, sound mix presets and dynamic range; gamepad play | done, as an Unreal panel | core audio mix | `VibeCity.Settings` |
| City geometry: convex hulls and boxes, standing cells, debris bodies | done | `client-core/src/geometry.rs` | every mesh closed and equal to its authored volume (24105 chunks of `fractured-downtown`); `VibeCity.Render.CityAndEffects`: all vertices drawn before and after a fracture |
| Per-building textures (the web's building hash, texture keys) | done, at 2K (the web: 1K/512) | `client-core/src/materials.rs`, `shared/assets/materials/catalog.json` | layer codes equal to the TypeScript (tsx fixtures) |
| Unreal materials for known materials | done: PBR from 2K Poly Haven sources (albedo, DirectX normal, AO/roughness/metal); real sets for the web's procedural limestone, slate and timber | catalog `hd` sources | `CityAndEffects` checks the material |
| Glass | material built (`M_VibeCityGlass`); the stock city has none | catalog `glass` | not yet seen on screen |
| Sun, sky, fog, ground | done: physical sky, real-time sky light; fog matched to the web's FogExp2 (value and slope at the 80 m AOI); the web's hero ground per pixel (grass and mud layers, dirt patches from its macro noise and thin cover, canopy tint, macro albedo and warmth) | sun from `sunSky.ts`; fog from `weather.rs`; noise from `ground.rs` (`cityMacroNoise`, byte for byte); cover from `grass.rs` | `VibeCity.Render.Compare` against `compare-web.mjs` (below): dirt patches in the same places |
| Texture scale | done: every texture tiles at the catalog size × the web's `cityTexScale` (2) | core tile UVs (`drawn_metres_per_tile`) | `geometry_manifest`: tile UVs = metres / (catalog tile × 2) on every chunk vertex |
| Weather presets (clear, dust storm, snow storm): fog colour and thickness, camera-wrapped particles drifting with the wind | done | `client-core/src/weather.rs` (port of `weatherPresets.ts`, `fogSettings.ts`); the particle shader is `WeatherParticles.tsx`'s, as HLSL | `VibeCity.Render.WeatherAndGrass`: 5000 snow particles and the preset fog, then clear |
| Meadow and shared painted grass (`/match-stats/<id>/grass`, polled every 2 s with If-None-Match) | done: blades per patch, species placed and shaped as the web's (seed heads on reeds and wheat, leaves on corn, fronds on ferns), crop rows, distance LOD, wind, the distant canopy over tall painted stands | `client-core/src/grass.rs` (ports of `grassPlacement.ts`, `GrassPaint.ts`, `foliageProfiles.ts`); shapes from `grassMaterial.ts` | default patches and a painted patch (count, species split, first and last blades) equal to the TypeScript; `WeatherAndGrass`: the stored 84-tile layout loads and every patch regenerates; `VibeCity.Render.Species`: every species drawn (species.png) |
| Destruction audio (fractures, entry, sheds, collapse waves, impacts, shots, server contacts, scrape loops, air, fly-bys, debris beds, car engines), heard from the camera, occluded by standing buildings, low-passed with distance | done | `client-core/src/audio.rs`, `effects.rs` (ports of `model.ts`, `director.ts`, `destructionMix.ts`, `engine.ts`, `motion.ts`, `destructionSources.ts`, `destructionActivity.ts`, `occlusion.ts`) | mix, intensity, attenuation, random, closest pass, Doppler, debris beds equal to the TypeScript; occlusion through a building and not over it; `CityAndEffects`: sounds and loops heard 35 m from a meteor |
| Dust where things break | done, as clusters of soft lit sprites | `client-core/src/effects.rs` | `CityAndEffects`: puffs after a meteor |
| Cursor (Esc frees, click captures, focus loss frees) | done | (Unreal only) | `VibeCity.Cursor` |
| Session drops | rejoin | `client-core` | (fork commit dd5c0765) |

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

## Known gaps

- **Lighting look.** The web lights with its sky gradient's environment map and ACES tone mapping;
  Unreal uses its physical sky, sky light and auto-exposure, so it renders brighter. Matching
  exposure exactly means porting the web's IBL, not tuning.
- **Dust look.** The web's dust is volumetric (fluid parcels). Unreal draws clusters of lit
  sprites; local fog volumes did not render in this configuration, and a Niagara system is the
  native upgrade.
- **Remote players.** No crouch clips (the web's `Crouch_Idle_Loop` and crouch locomotion).
- **Moving debris.** Bonds broken between two moving bodies are placed at rest for dust and
  sound. There is no dust budget in the core (Unreal recycles the faintest of 64 live puffs).
- **Match stats and toasts.** No player count or match stats panel (`PKT_MATCH_STATS`), no
  grass-sync toast, no controls-hints overlay. The web's debug and admin tools stay web-only.
- **Server walk speed.** The server's on-foot input policy repeats a held input when a frame is
  late and then applies the late frame too, so players on either client walk about 14.5% fast;
  the fix is behind `VIBE_FOOT_INPUT_DEBT=1` (off by default).
- **Lumen** (an Unreal upgrade, not a web feature). Procedural meshes have no distance fields, so
  Lumen's software tracing does not see the city.
- **Web adoption of the core.** Module by module behind flags, off by default until each has run
  in live sessions, every one held equal to the TypeScript it replaces by a test:
  - packet decoders and encoders: `?sharedDecode=1`;
  - chunk hulls: `?coreGeometry=1`;
  - the 60 Hz input frames: `?coreInput=1`;
  - grass placement over the shared paint: `?coreGrass=1` (`coreGrass.test.ts`; the core's patch
    (0, 0) in the browser has the TypeScript's 8917 blades);
  - each sound's voices and debris beds: `?coreAudio=1` (`voicePlan.core.test.ts`, 2000 random
    events);
  - remote players: `?corePlayers=1`;
  - the city manifest: `?coreManifest=1`.

  The weather table is one file both clients read (`shared/assets/weather/presets.json`). Still
  TypeScript on the web, pinned to their Rust ports by fixtures: the destruction sources and dust
  queue, motion, debris beds and occlusion.
