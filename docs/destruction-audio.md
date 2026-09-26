# Destruction audio and review guide

The browser sound system combines recorded material Foley, designed procedural layers, bounded physics summaries, and a listener-specific mix. `/audio` is a
server-independent listening lab; `/city` and the game use the same renderer and
saved settings. The prepared production build runs locally at
`http://127.0.0.1:5568/audio`; development uses port 5567. No remote deployment
is claimed.

## Choose source sounds first

**Sound casting** at the top of `/audio` offers seven roles: masonry impact,
masonry collapse, metal impact, metal collapse, fast projectile, flying debris,
and massive flyby. Each role has three takes.
Masonry impact controls heavy individual hits and breaks; masonry collapse
controls the sustained surrounding rubble bed.

1. Start with **Dry**. Choose a role, then **Preview** each take. A preview plays
   one isolated source with a fixed reference setup and leaves the selected mix
   unchanged. Level matching uses the loudest 400 ms RMS window, subject to peak
   headroom; it does not guarantee equal perceived loudness.
2. Select **Use in mix** for the preferred take. **In your mix** marks the chosen
   take, while the role's checkmark indicates that the current choice has been
   previewed in this session. **Stop preview** immediately clears playback.
3. Choose **Play current scene** to hear the selection in context. Source choices
   save with the other settings, including A/B snapshots and exported mixes.
   Impact/collapse choices initially retain the original palette. The three
   flyby roles initially use their distinct designed recordings.
4. Compare **Dry** and **With reflections** after choosing the sources. The
   setting also applies to the game. **Room sound** in the mix controls exposes
   the same setting; **Reflections amount** is available when reflections are on.

**Original layer** previews a single representative layer from the existing bank;
selecting it restores the full original recipe for that role in the scene.
That bank uses Kenney and
rubberduck recordings plus synthesized body and air. It contains no recording
of a full building collapse. The new **Recording focus** / **Clean pass** takes
use recordings; **Designed weight** / **Shaped motion** layer and process those
recordings without adding synthesized noise or baked room echo. Flybys use
recorded swish Foley, not recordings of actual cannonballs or meteors. Cards show
source links, creators and licenses. See the [optional-bank source notes](../client/public/audio/options/SOURCES.md).

## Fast review session

On a prepared checkout, run Vite from `client/` and open `/audio` at its printed origin. The lab needs no physics server. For example:

```sh
cd client
npx vite --host 127.0.0.1 --port 5567
```

Use the scheme Vite prints; configured TLS certificates can make it HTTPS.

1. Select **Headphones**, **Balanced** dynamic range, and a moderate master
   volume. Ringing starts off. The default scene is **Inside the collapse**.
   Press **Listen** or **Play scene** and check that all catalog clips load,
   with no unavailable assets.
2. First compare **Inside the collapse** at **Close** and **Distant**, pressing
   **R** to restart after changing position. Heavy events continue around and
   above the listener for roughly ten seconds, followed by a quieter settling
   tail. **Sustained level** is the current output RMS window in dBFS;
   **Debris beds** counts the activity-driven textures. These are diagnostics,
   not calibrated sound-pressure or loudness measurements.
3. Use **Small object** / **Heavy object** and the material buttons to compare
   scale at the same intensity, seed and position. Selecting a scale replays
   the last material. Then play **Material palette**, **Small things matter**,
   and **Weight in motion** for surface identity, sheet-metal character,
   continuous friction and lighter settling sounds.
4. Keep seed **2026**, listener position and heading fixed. Save a baseline to
   **A**, change one mix control, save to **B**, then alternate **A / B**.
   Each recall and preset choice restarts identical event inputs. Slider edits
   apply live. Comparisons are not automatically loudness-normalized.
5. Compare **The close call**, **Missed by inches**, and **The buggy**. Check that
   nearby danger remains legible through heavy impacts. Try **Close**, **Street**,
   **Distant**, **Above**, and the heading control to inspect placement.
6. Run **Ten thousand contacts**. This is a scripted 10,000-event workload,
   not 10,000 simulated rigid bodies. Verify that voice count stays within the
   selected budget and the controls remain responsive.
7. Use **Record clip**, then **Stop recording**. Download the playable stereo
   review recording; it is captured after peak control. Surround is explicitly
   downmixed for this file, so it does not verify physical speaker routing.
8. Write a specific note such as “close slab needs more air, less ringing” and
   **Export review**. JSON includes scenario/seed, listener, current settings,
   both comparison slots, diagnostics, browser, and notes. **Import mix** restores
   settings only; use the report's scene/seed/listener to reproduce the session.

Shortcuts: **Space** play/pause, **R** restart, **1–3** presets, **A/B** recall,
**Escape** pause. Cues seek just before a beat; seeking clears old decays. Hidden
tabs pause without queuing a burst. Settings and A/B slots persist in this browser.
Mix changes also update another open game tab on the same origin immediately.

## Gameplay interface

`client/src/audio/model.ts` defines `SoundEvent`, `ContinuousSound`, `Vec3`, and
seven `AcousticMaterial` values. `destructionAudio()` in `engine.ts` owns the
shared renderer. Gameplay provides world coordinates, never speaker channels.

```ts
import { destructionAudio } from './audio/engine';
const audio = destructionAudio();
await audio.start(); // Call from a user gesture; lifecycle helper also unlocks.

const now = performance.now();
audio.setListener([0, 1.7, 0], [0, 0, -1], [0, 1, 0]);
audio.emit({
  id: 'mailbox-42:impact:8', kind: 'impact', material: 'sheet',
  position: [3, 1, -4], intensity: .65, size: .8,
  seed: 42, atMs: now,
});
// Refresh a stable emitter ID while its interaction continues.
audio.continuous({
  id: 'slab-17:slide', kind: 'scrape', material: 'concrete',
  position: [4, .2, -3], intensity: .5, speed: 3, occlusion: 0,
}, now);
audio.update(now); // Once per presentation frame, after submitting inputs.
```

- Positions are metres; velocity/speed are metres per second. `atMs` shares the
  `performance.now()` clock and follows presented action, not packet arrival.
  `intensity` and `occlusion` are 0–1. `size` is an acoustic scale proxy that
  controls pitch, heavy-body layering, source extent and voice priority.
  Streamed contacts derive it from mass rather than geometry.
- Events: `impact`, `fracture`, `collapse`, `flyby`, `shot`. Give each occurrence
  a unique ID and a stable seed. `protected: true` reserves priority for threats.
  Shots currently select rifle when `size <= .2`, otherwise cannon.
- Flyby `position` and `atMs` describe the closest pass; optional `velocity`
  drives a moving source and approach/departure pitch. The motion tracker emits
  world velocity and `missDistance` from the swept path. A late pass seeks into
  the clip rather than starting a new approach. Reference previews retain the
  full approach. Playback timing accounts for Doppler; frame updates and 12 ms
  smoothing still make this an approximation. Three source roles distinguish
  compact metal projectiles, tumbling debris, and objects of acoustic size 2.8+
  such as meteors. This is a size/material heuristic, not aerodynamic simulation.
- Continuous kinds: `scrape`, `roll`, `air`, `engine`, `wind`. Stop refreshing
  to release a loop; no stop packet is required. Optional air `velocity` drives
  radial Doppler. `setOcclusion(id, amount)` updates an active loop explicitly.
- `stop()` clears playback/queues; `suspend()` and `resume()` support lifecycle.
  `diagnostics()` reports counters, requested/active output and asset failures.
  Start must complete before emitting events.

`GameAudioLayer` updates the camera listener, consumes destruction events at presentation time, follows rendered bodies/projectiles and vehicles, samples
occlusion, and submits bounded contacts. Tape replay uses the same presentation
path and resets contact/motion history when seeking or looping.

### Material selection

`acousticMaterial(name, metalness)` checks names in this order:

| Material | Recognized examples |
| --- | --- |
| glass | glass, window |
| wood | wood, timber, plank, bark, tree |
| sheet | sheet, tin, mailbox, panel |
| metal | metal, steel, iron, aluminum, vehicle, car; metalness > .6 |
| earth | soil, dirt, sand, grass, earth |
| stone | stone, rock, granite, marble |
| concrete | fallback |

City bodies use a representative chunk's manifest appearance, rather than both
materials at every contact point. Other contacts use vehicle/meteor identity or
fall back to concrete. Explicit gameplay emitters supply their intended material.

## Selection, transport and rendering budgets

| Stage | Current bound / behavior |
| --- | --- |
| Server extraction | At most 8,192 existing reported contacts per tick; no extra GPU readback |
| Server reduction | 512 hashed 6 m regions; bounded 2,048-pair cooldown history |
| Listener contact packet | 20 Hz, up to 16 records / 840 bytes; interest radius 200 m |
| Client contact storage | 128 pending; 512 recent entity IDs; 300 ms expiry |
| City velocity impacts | Reuses all observed city body histories; up to 512 queued audio sources/evidence; independent 300 ms body cooldown |
| City near misses | Up to 256 nearby bodies sampled per frame; this cap does not govern city impact audio |
| Audio director | 256 pending; 12 selected events/frame; groups by material/kind, 5 m cell, 65 ms bucket |
| Playback | Default 64 voices; configurable 24–96; 12 slots reserved from ordinary one-shots for threats and up to four activity beds |
| Voice replacement | At most eight retiring node chains; 5 ms fade finishes before replacement starts at ≥6 ms; disconnected on completion |
| Headphone HRTF | Up to 22 ordinary / 28 total spatial voices; overflow uses stereo panning |
| Continuous playback | Up to 10 explicit loops plus four destruction-activity beds; release after 220 ms without refresh |
| Destruction activity | 64 spatial/material regions; 32 time bins per region; 2,048 recent IDs; at most four selected beds |
| Occlusion | Up to six rays/100 ms; 250 ms cache, at most 128 entries |

Contact packet `PKT_AUDIO_CONTACTS = 131`, version 1, is loss-tolerant datagram
traffic and never falls back to the reliable state stream. It carries namespaced
PhysX IDs, position, normal, contact speeds, intensity and size. Dynamic snapshot
IDs map to namespace `0x2…`, vehicles to `0x6…`, and city topology uses `0x8…`.
`contactEntityId` and `contactEntityParts` prevent unrelated IDs from suppressing
one another's fallback. Resting support impulse alone is silent. The classifier
requires normal speed >= 0.7 m/s for an impact or tangent speed >= 0.25 m/s for a
scrape. It uses contact-point linear/angular motion and reduced translational
mass, not a full rotational effective-mass solution.

City audio also reuses the existing velocity detector across all observed bodies,
before the visual dust and near-miss budgets. An audio-only evidence record keeps
the exact city entity, representative chunk material, mass and radius. Bodies of
at least 250 kg can qualify at 1.5 m/s with a 1.2 m/s velocity discontinuity;
lighter bodies retain the dust detector's 3 m/s speed and 4 m/s discontinuity
thresholds. Every candidate must lose at least 15% of its speed, pass gravity,
sample-gap and teleport checks, and respect a separate 300 ms audio cooldown.
The visual detector's thresholds, cooldown and source ordinals are unchanged.
A five-tonne body stopping at 2 m/s therefore sounds even without a visible puff.

Validated impacts use the kinetic energy lost to set intensity: a tonne stopping
at 6 m/s maps to about 0.87, versus about 0.20 for a 2 kg piece at that speed.
Individual chunks retain their material `impact` identity and geometric size;
large nearby stops receive protected priority. Structural fracture strength uses
a separate broken-bond-area curve. Release alone remains silent. Visual collapse
waves are excluded because their aggregation can include unvalidated motion;
the regional debris beds accumulate validated impacts and structural breaks.
Only a recent authoritative contact for the same namespaced entity suppresses
its fallback impact. Other bodies keep sounding, and the city near-miss tracker
does not emit duplicate impacts.

The director prioritizes danger, removes stale input, and bounds node creation.
A separate activity accumulator consumes the original impact, fracture and
collapse events before reduction, retaining their energy in up to four spatial
material textures. It decays after contact activity stops and clears on seek or
restart. These textures share the total playback budget. When a dense stream of
nearby heavy impacts has protected priority, the four surrounding beds retain
their slots instead of disappearing from the mix.

Large objects gain a separate broad heavy-body layer. Transient attacks begin
without the previous slow gain ramp. Voice selection accounts for distance,
source size, layer role and the age of one-shot tails, so quiet tails can yield
to new impacts. Protected arrivals can replace older impact voices. Replaced
sources fade for 5 ms before their replacements begin, with at most eight
retiring node chains pending cleanup. Loop gain ramps start at the scheduled
playback time, so a random loop offset does not introduce an onset click. Nearby
flybys briefly reduce bright detail only; a collapse no longer turns down its
own heavy layers. Distance attenuates and filters sounds with a wider near
region for larger sources; far events and their debris beds share a capped
travel delay. The four bed positions refresh obstruction through the existing
ray budget as the listener or the surrounding geometry changes.
Near misses can also replace occupied impact voices; approaching air can replace
a quieter friction loop. Lowering the voice budget trims existing playback.
Pausing and A/B restarts clear the previous reflection tail.
Acoustics use cached obstruction rays and a shared designed reflection response,
not geometric room reverberation, diffraction, or per-fragment propagation.
A linked 256-sample lookahead limiter preserves multichannel balance; unsupported
worklet environments report a soft-saturation fallback explicitly. The limiter
recovers after a large transient even when sustained rubble still needs mild
limiting; it no longer holds the deepest reduction indefinitely.

### Listening outputs

- **Headphones:** stereo HRTF spatialization for the priority voices, including
  elevation. Direction quality depends on the listener and generic HRTF.
- **Stereo speakers:** equal-power horizontal panning; no binaural processing.
- **5.1:** discrete FL, FR, center, LFE, surround-left, surround-right channels.
- **7.1:** discrete FL, FR, center, LFE, back-left, back-right, side-left,
  side-right channels. No overhead speakers are implied.

If the browser exposes fewer channels than requested, playback falls back to
stereo and displays the active mode. Channel capacity does not prove the HDMI/OS
speaker mapping. Use **Check speaker routing** on the physical system. Ordinary
sources keep bass in the main channels and leave LFE silent; receiver bass
management may send low frequencies to the subwoofer. The subwoofer test emits
an isolated LFE tone. Output selection and dynamic range are independent.

## Assets and verification

The bank contains 100 mono clips: 35 impacts, 21 fractures, seven scrapes, seven
rolls, four collapses, four flybys, six rifle/cannon reports, three textures, six
heavy-body layers, and seven sustained material-debris beds.
Kenney Impact Sounds and rubberduck's breaking/falling pack are verified CC0;
original synthesis supplies resonance, pressure, friction and air layers.
[Sources and hashes](../client/public/audio/destruction/SOURCES.md) and the
[quality report](../client/public/audio/destruction/QUALITY.md) document recipes.
One-shots use MP3; lossless WAV loops preserve joins. Measured bank size is
**13.82 MiB transfer / 52.33 MiB decoded Float32 PCM at the requested 48 kHz**, with a largest decoded
peak of **−1.86 dBFS** and no clipped/silent files. Same-encoder rebuilds matched
all delivered hashes. New debris loops remain active through their 6.4-second
length; playback follows actual accumulated contact activity. Heavy layers
concentrate energy in the low mids, and glass retains a brighter debris texture.
The four existing collapse clips also received more sustained body. Full
spectral and RMS measurements are in the quality report, not inferred from
filenames or nominal gain settings.

The optional casting bank adds **14 mono 48 kHz WAV clips**, two for each role,
at **3.17 MiB transfer / 6.34 MiB decoded Float32 PCM**. It is loaded as needed
for chosen takes and previews. Its catalog records provenance and hashes
separately from the 100-clip original bank.

From the repository root:

```sh
node client/scripts/build-destruction-audio.mjs --fetch
node client/scripts/verify-destruction-audio.mjs --report
cargo test -p web-fps-server contact_audio
cargo test -p web-fps-server audio_contacts_never_block_the_reliable_state_stream
cd client
npm test -- src/audio
npm run lint
E2E_BASE_URL=http://127.0.0.1:5567 E2E_SKIP_WEB_SERVER=1 npm run e2e -- audio-review.spec.ts
```

Rebuild requirements: Node.js, FFmpeg/libmp3lame, unzip, network access. Shipped
assets need no rebuild. The supplied browser suite covers playback, A/B,
recording/reports, 10,000 events, narrow layout, game settings, cross-tab settings,
the sustained interior-collapse scene, and small/heavy comparison. Verification
results below identify which revision was exercised; adding a test does not
claim that it was run.
With a configured PhysX toolchain, also run
`cargo check -p web-fps-server --features native-destruction`.

### Earlier 87-clip validation, September 26, 2026

- 107 focused TypeScript tests pass, including the shipping limiter processor,
  renderer lifecycle, real contact decoding, gameplay/replay adapters, city
  replay regressions, and routing. TypeScript checking and the Vite production
  bundle pass. The review build omits the unrelated large scene-pack copy step.
- Six automated Chromium checks passed; final in-app browser checks also cover
  the optimized 10,000-event scene, 87 decoded assets, no console errors, and
  live settings synchronization between two tabs. The added seventh automated
  test for tab synchronization is supplied; that case was verified manually
  because shell-based browser execution was rejected by the session policy.
  A development hot-reload check caught old React effects continuing to play;
  the entry point now unmounts its previous root. A repeated hot-reload check
  confirmed zero voices and a stopped event count afterward.
- Five Rust reducer tests, the datagram-only routing test, and compilation with
  `native-destruction` pass. The real GPU test remains unverified below.
- Both WASM packages were rebuilt. This Mac needed the installed LLVM 21 C
  compiler for the codec; its final package used `wasm-pack --no-opt --mode
  no-install` after the local optimizer/install path failed. The normal combined
  `npm run build` command did not complete; the separate WASM, TypeScript, and
  Vite stages did. No toolchain configuration or Cargo metadata was changed.
- [CPU benchmark and scope](destruction-audio-performance.md): after replacing
  overload scans with an indexed heap, the worst 10,000-event queue workload
  fell from 111.61 to 2.67 ms median on this Apple M3 Max. Use `npm run
  audio:bench` from `client/` to reproduce; this excludes audio rendering.

### Heavy-collapse revision checks

- **213 focused tests pass** across the audio modules, real city packet/impact
  integration, dust compatibility, city wire/tape and routes. TypeScript and
  the production client build pass (`VIBE_SKIP_SCENE_PACKS=1` skips the unrelated
  scene-pack copy; the existing WASM outputs were reused).
- The revised asset verifier passes all 100 decoded clips, including heavy-body
  spectrum, sustained window RMS, loop boundaries and transfer/decoded budgets.
- Twenty focused review-fixture and route checks pass. The new tests verify
  heavy events above and around the listener through ten seconds, a quieter
  tail, deterministic replay, equal-input small/heavy audition and emitter
  velocity. The previous seven fixtures remain available.
- Six activity tests also pass. A public-API regression confirms that quiet
  continuing contacts cannot keep an old loud region's storage priority forever
  and block a new audible region; reverting the priority decay reproduces the
  failure.
- Two new browser cases cover the default interior scene and small/heavy
  comparison. The palette assertion reads the served catalog rather than
  hardcoding a count. These added browser cases have not been run from the
  shell in this revision; browser verification uses the in-app Browser.
- In-app Browser verification of the rebuilt preview loaded 100/100 clips,
  exercised the new interior and small/heavy auditions, and showed four debris
  beds within the default 64-voice budget. One dense interior sample measured
  −1.2 dBFS peak; sustained levels vary with the scene. Playback returned to zero
  voices/beds and silence after settling, with no browser console errors.
- The production crowded-scene check showed 53/64 voices, four beds and
  22 HRTF voices at a sampled peak of −8.4 dBFS. Recording produced an in-page
  review clip; stopping playback cleared voices and beds. The studio was left
  paused on **Inside the collapse**, Close, Cinematic, Balanced, master 65%.
- The activity accumulator measured 0.110 ms median / 0.353 ms p95 per frame
  at 10,020 events/second in the CPU-only workload. A single 10,000-event burst
  took 5.273 ms median, plus separate director/renderer costs. See
  [performance scope and measurements](destruction-audio-performance.md).

### Source-choice and moving-flyby revision

The optional bank adds 14 files across seven roles: 3.17 MiB encoded and
6.34 MiB decoded at 48 kHz if every alternative is loaded. It loads only chosen
or previewed takes. Source hashes, processing recipes, measured pass centers,
peak limits and loop boundaries are checked by `npm run audio:verify`.

The September 26 follow-up passed 193 focused checks across 19 test files,
TypeScript and a production client build using the existing WASM outputs.
Regression cases cover material replacement, moving flyby timing, late events,
voice protection, asynchronous preview cancellation and room-mode changes.
The in-app browser loaded all 14 alternatives, preserved choices across reload,
restored all four material roles through A/B, completed the 830-event interior
and 10,000-event fixtures, and produced a stereo review recording without console
errors. The authored Playwright cases were not executed from the shell.

The prepared browser comparison uses **A** for the original material recipes
and **B** for the designed recorded-material choices. Both use the new flybys
and dry acoustics so the material comparison has the same room treatment.
These are audition candidates; the three Freesound inputs are HQ MP3 previews,
not original WAV masters. See the source notes before final asset selection.

### What remains unverified or approximate

Native GPU destruction chunks intentionally suppress CPU contact callbacks. Those pairs retain semantic destruction, validated all-body velocity impacts and rendered-motion flyby
fallbacks; they do **not** currently supply true contact-driven scraping.
Fallback motion cannot identify a contacted surface or infer friction reliably.
The live stream classifies impact/scrape; dedicated rolling is available through the API and lab but is not a separate physics contact classification yet.

No artistic listening approval, physical surround approval, or production
GPU-scale performance result is claimed. The local native GPU test aborts during
Metal startup before its Rust harness, including with `--list`. The lab measures
main-thread scheduling time, not full audio-thread or game-frame cost. Finish
with listening and actual `/city` load tests on the intended GPU/output hardware.
