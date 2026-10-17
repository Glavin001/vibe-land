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
```

Generated content (`unreal/VibeCity/Content/VibeCity/`) is not committed. The inputs are the web's
texture sheets and audio clips, `shared/assets/materials/catalog.json`, and the scripts.

## Features

| `/city` feature | Unreal | Shared code | Evidence |
|---|---|---|---|
| Join a `citypp` match over WebTransport, session config, cert pinning, manifest | done | `client-transport-wt`, `client-core` | `vl-headless` gate: every snapshot the server produced arrived, 0 decode errors |
| Wire 4 destruction stream (keyframes, events, acks, resync on hash mismatch) | done | `perplayer` client inside `client-core/src/city.rs` | 0 hash mismatches in every run; `vl-headless --gate` |
| Other players (interpolated, roster) | done: the web's UAL mannequin, tinted per player | `client-core/src/players.rs` | `VibeCity.Play.LookAtRemote`, `ShootRemote` |
| First-person walking, sprint, jump, crouch (server-authoritative, thin predictor) | done | `client-core/src/input.rs`, `predictor.rs` | `VibeCity.Play.WalkAndShoot`: 6.0 m/s per applied input frame |
| Rifle, cannon, meteor (1/2/3), fire interval, tracers, hit results, damage | done | `net_client` encoders/decoders | `WalkAndShoot`, `CannonAndMeteor`, `ShootRemote` (Unreal shot took a browser player 100 to 86 HP) |
| Aim (RMB, web FOV), melee (V), aerial camera (N), city reset (R) | done | core `melee`, `camera_drop` | `AimAndReset`, `AerialAndMelee` |
| Cars: assets, enter/exit (E), drive, chase camera, wheels, detached parts | done | `client-core/src/vehicles.rs` | `Drive`, `WreckCar` |
| Cannonballs and meteors (flight, landing) | done | core dynamic bodies, meteor records | `CannonAndMeteor` |
| HUD: crosshair, HP, energy, weapon, spawn protection, car hints | done | frame `local` | screenshots |
| City geometry: convex hulls and boxes, standing cells, debris bodies | done | `client-core/src/geometry.rs` | every mesh closed and equal to its authored volume (24105 chunks of `fractured-downtown`); `VibeCity.Render.CityAndEffects`: all vertices drawn before and after a fracture |
| Per-building textures (the web's building hash, texture keys) | done, at 2K (the web: 1K/512) | `client-core/src/materials.rs`, `shared/assets/materials/catalog.json` | layer codes equal to the TypeScript (tsx fixtures) |
| Unreal materials for known materials | done: PBR from 2K Poly Haven sources (albedo, DirectX normal, AO/roughness/metal); real sets for the web's procedural limestone, slate and timber | catalog `hd` sources | `CityAndEffects` checks the material |
| Glass | material built (`M_VibeCityGlass`); the stock city has none | catalog `glass` | not yet seen on screen |
| Sun, sky, fog, ground | done (physical sky, real-time sky light) | sun direction from `sunSky.ts` constants | screenshots |
| Meadow (the web's default grass) | done: blades per patch, distance LOD, wind | `client-core/src/grass.rs` | blade counts and first blades equal to the TypeScript; `CityAndEffects`: 130 patches |
| Destruction audio (fractures, impacts, shots, server contacts) | done | `client-core/src/audio.rs`, `effects.rs` | mix, intensity, attenuation, random equal to the TypeScript (tsx fixtures); `CityAndEffects`: sounds after a meteor |
| Dust where things break | done, as soft billboards | `client-core/src/effects.rs` | `CityAndEffects`: puffs after a meteor |
| Cursor (Esc frees, click captures, focus loss frees) | done | (Unreal only) | `VibeCity.Cursor` |
| Session drops | rejoin | `client-core` | (fork commit dd5c0765) |

## Known gaps

- **Dust and audio sources.** Fracture, crush and impact sources are ported. The web's entry
  (first break of a shot), shed (moving island's birth) and collapse-wave kinds are not. Bonds
  broken between two moving bodies are placed at rest. Scrape loops, debris "activity" beds and
  fly-bys are not ported, and there is no dust budget in the core (Unreal caps 96 live puffs).
- **Dust look.** The web's dust is volumetric (fluid parcels). Unreal draws billboards; a Niagara
  system is the native upgrade.
- **Lumen.** Procedural meshes have no distance fields, so Lumen's software tracing does not see
  the city. Lighting is the sky light plus shadows.
- **Grass paint.** The shared grass layout (`/match-stats/<id>/grass`, painted grass) is not
  synced; the default meadow is drawn.
- **Weather presets.** Only the clear-weather fog colour is used.
- **Web adoption of the core.** The web still runs its TypeScript copies; migrating module by
  module behind flags is the next step for code sharing.
