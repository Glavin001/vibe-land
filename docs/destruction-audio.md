# Destruction audio and review guide

The browser sound system combines recorded material Foley, designed procedural layers, bounded physics summaries, and a listener-specific mix. `/audio` is a
server-independent listening lab; `/city` and the game use the same renderer and
saved settings. The prepared production build runs locally at
`http://127.0.0.1:5568/audio`; development uses port 5567. No remote deployment
is claimed.

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
  `intensity` and `occlusion` are 0–1. `size` is an acoustic scale proxy, used
  for pitch; streamed contacts derive it from mass rather than geometry.
- Events: `impact`, `fracture`, `collapse`, `flyby`, `shot`. Give each occurrence
  a unique ID and a stable seed. `protected: true` reserves priority for threats.
  Shots currently select rifle when `size <= .2`, otherwise cannon.
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
| Audio director | 256 pending; 12 selected events/frame; groups by material/kind, 5 m cell, 65 ms bucket |
| Playback | Default 64 voices; configurable 24–96; 12 slots reserved from ordinary voices |
| Headphone HRTF | Up to 22 ordinary / 28 total spatial voices; overflow uses stereo panning |
| Continuous playback | Up to 10 loops; release after 220 ms without refresh |
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

The director prioritizes danger, removes stale input, and bounds node creation.
Protected arrivals can replace quiet unprotected voices. Large events reduce the
world bus briefly while protecting threats. Distance attenuates and filters
sounds; far events gain a capped travel delay.
Near misses can also replace occupied impact voices; approaching air can replace
a quieter friction loop. Lowering the voice budget trims existing playback.
Pausing and A/B restarts clear the previous reflection tail.
Acoustics use cached obstruction rays and a shared designed reflection response,
not geometric room reverberation, diffraction, or per-fragment propagation.
A linked 256-sample lookahead limiter preserves multichannel balance; unsupported
worklet environments report a soft-saturation fallback explicitly.

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

The bank contains 87 mono clips: 35 impacts, 21 fractures, seven scrapes, seven rolls, four collapses, four flybys, six rifle/cannon reports, and three textures.
Kenney Impact Sounds and rubberduck's breaking/falling pack are verified CC0;
original synthesis supplies resonance, pressure, friction and air layers.
[Sources and hashes](../client/public/audio/destruction/SOURCES.md) and the
[quality report](../client/public/audio/destruction/QUALITY.md) document recipes.
One-shots use MP3; lossless WAV loops preserve joins. Measured bank size is
**9.51 MiB transfer / 41.69 MiB decoded Float32 PCM**, with a largest decoded
peak of **−1.86 dBFS** and no clipped/silent files. Same-encoder rebuilds matched
all delivered hashes.

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

### Recorded validation, September 26, 2026

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

### What remains unverified or approximate

Native GPU destruction chunks intentionally suppress CPU contact callbacks. Those pairs retain semantic destruction and rendered-motion impact/flyby
fallbacks; they do **not** currently supply true contact-driven scraping.
Fallback motion cannot identify a contacted surface or infer friction reliably.
The live stream classifies impact/scrape; dedicated rolling is available through the API and lab but is not a separate physics contact classification yet.

No artistic listening approval, physical surround approval, or production
GPU-scale performance result is claimed. The local native GPU test aborts during
Metal startup before its Rust harness, including with `--list`. The lab measures
main-thread scheduling time, not full audio-thread or game-frame cost. Finish
with listening and actual `/city` load tests on the intended GPU/output hardware.
