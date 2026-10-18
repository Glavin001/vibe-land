# Optional sound audition palette

Fourteen independent alternatives: seven categories, each with a **natural** and
**designed** choice. The original runtime palette stays separate. These are
48 kHz, mono, 16-bit PCM WAV files, suited to spatial playback.

## Sources and permission

The following creator pages were checked on 2026-09-26. Each explicitly uses
[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).
No purchase, account, or additional terms were accepted.

| Source | Creator | What is in this bank |
| --- | --- | --- |
| [Bricks.wav](https://freesound.org/people/cejordi84/sounds/232396/) | cejordi84 | Actual bricks smashed together; creator layered two recordings made with an AKG 414 |
| [rock slide.wav](https://freesound.org/people/21100495/sounds/655368/) | 21100495 | A source arrangement of rocks falling down a hill |
| [rockfall2a.wav](https://freesound.org/people/AlanCat/sounds/389303/) | AlanCat | Cliff rockfall field recording made with an Olympus LS-14; creator removed background noise |
| [Swishes Sound Pack](https://opengameart.org/content/swishes-sound-pack) | artisticdude | Hanger and wood swung past a camcorder microphone, as explained by the creator |
| [100 CC0 metal and wood SFX](https://opengameart.org/content/100-cc0-metal-and-wood-sfx) | rubberduck | Metal strikes, slams, springs, falling pieces and sheet motion |

The three Freesound downloads are the **public HQ MP3 previews**, not their
original WAV masters. Their compression remains part of the source quality.
The metal pack uses its supplied OGG files; the swish pack uses original WAVs.
Exporting as WAV avoids a second lossy encoding stage.

`catalog.json` preserves each source page, creator, license, download URL,
download hash and source format. `source-files.json` hashes each input file
actually used. Clip hashes and the generator hash are also in the catalog.

## Choice matrix

| Category | Natural | Designed |
| --- | --- | --- |
| Masonry impact | Close brick-on-brick crack at original pitch | Brick crack plus independently recorded stone chunks and filtered brick body |
| Masonry collapse | One rock-slide timeline, retaining real gaps | Several cliff-rockfall layers with distinct brick accents |
| Metal impact | Original metal strike and its short resonance | Slower slam, plate flex and a compact filtered metal body |
| Metal collapse | Original-pitch falling pieces arranged into a loop | Denser second falling-metal recording plus lower plate motion |
| Projectile flyby | Very short recorded swish | Swish plus a brief metallic spring zing |
| Debris flyby | Rougher, broader recorded sweep | Sweep, granular brick texture and a vibrating metal fragment |
| Massive flyby | Slower heavy recorded sweep | Broad sweep, low-mid motion, plate flex and rock texture |

“Natural” means source-style editing, with trim, mono conversion, edge fades,
DC cleanup and level matching. Flyby rate changes and the metal-loop arrangement
are explicitly documented in `recipes.json`. Some creators already assembled
recordings before publishing them. Natural does not mean untouched raw capture.

“Designed” is catalogued as `hybrid`: layered and filtered recordings. No option
adds synthetic noise, oscillators, convolution, artificial room echo, or delay.
Any room/landscape coloration already in a source remains; no claim is made
that these are anechoic recordings. `recipes.json` documents every choice's
sources, timing, playback rates and filters. The generator is the exact recipe.

Flybys are recorded-object **Foley proxies**, not live cannonball, bullet or
meteor recordings. Their three characters use different sweeps and layer recipes.
`passAtSeconds` marks the measured strongest 20 ms frame: projectile **0.23 s**,
debris **0.27 s**, massive **0.31 s**, for both choices. Center the spatial pass
on this point. Natural and designed should be heard both alone and in action.

Loops are 6.4 seconds long. A 250 ms crossfade joins the period, then the finished
period is rotated by at most 125 ms to a quiet, low-slope boundary. This changes
the starting point without deleting internal activity or adding a silent gap.

## Matching and measured limits

Each pair is matched by **active RMS**: 20 ms frames above one-eighth of the
loudest frame's RMS, with a 0.003 absolute gate. Both alternatives share the
highest feasible target up to −17.99 dBFS while preserving a 0.88 peak ceiling.
Natural clips retain their transients; compression is not added to force a
level target. Sparse natural rubble therefore retains gaps, and its full-duration
RMS differs from the continuously layered choice. Active RMS is a comparison aid,
not a guarantee of equal perceived loudness.

`quality-report.json` contains decoded peak, whole-file RMS, active RMS, activity
duration, DC, join jump and bank sizes. Automated checks cover all 14 IDs, hashes,
unique files, provenance references, peak/headroom, silence, DC, edge clicks,
duration, loop flags, pass alignment, pair level difference and memory limits.
Human listening approval is still needed. No subjective hearing assessment or
physical multichannel speaker test is claimed here.

## Rebuild and verify

Requires Node.js, ffmpeg and unzip. From the repository root:

```sh
node client/scripts/build-audio-options.mjs --fetch
node client/scripts/verify-audio-options.mjs --report
```

Downloads are checksum-pinned and cached in the system temporary directory at
`vibe-audio-options-sources`. An extracted/cache directory can also be passed as
the first argument. The output is only `client/public/audio/options/`.
Budget: under 10 MiB transfer and 32 MiB decoded float32 audio at 48 kHz.

## Considered source that was excluded

[iwanPlays' rubble mix](https://freesound.org/people/iwanPlays/sounds/567249/)
is CC0, but one upstream component
[explicitly added Gverb](https://freesound.org/people/ALLANZ10D/sounds/155934/).
It is not included in this bank. The direct AlanCat recording was chosen to
avoid inheriting that added echo. This is a source-provenance decision, not a
claim that the excluded mix is unsuitable for every project.
