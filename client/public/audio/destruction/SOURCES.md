# Destruction sound palette

100 mono sounds at 48 kHz. Designed for spatial playback: 35 material impacts,
21 fractures, seven friction loops, seven rolling loops, four large collapses,
four near misses, six weapon reports, three air/rumble/wind loops, six heavy-body
impact layers and seven sustained material debris beds. The runtime controls scale and loudness independently.

## Source recordings and permission

| Source | Creator | Permission | Use |
| --- | --- | --- | --- |
| [Impact Sounds 1.0](https://kenney.nl/assets/impact-sounds) | Kenney | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | Contact attacks, footsteps, metal/plate/tin resonance and grains |
| [75 CC0 breaking / falling / hit SFX](https://opengameart.org/content/75-cc0-breaking-falling-hit-sfx) | rubberduck | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | Rock, glass and wood breakage; metal and rock falling |

Both source pages were checked on 2026-09-26. No login, payment, or additional
terms were required. `KENNEY-LICENSE.txt` preserves the original pack's notice.
The rubberduck ZIP contains audio files; its CC0 declaration is on the source
page above. Keeping creator credits is encouraged even though CC0 does not
require attribution.

### Immutable source archives

- Kenney: `https://kenney.nl/media/pages/assets/impact-sounds/87b4ddecda-1677589768/kenney_impact-sounds.zip`
  SHA-256: `029d734af1582474edf3a694d1b0cebc97c1c152f2f39fa34d4c2bafc5de77f8`
- rubberduck: `https://opengameart.org/sites/default/files/sfx_breaking_and_falling.zip`
  SHA-256: `e6ee04d91c5f4d30cfda1260d2c9d1faf96fda36319287215fbd07bcb1a80451`

`source-files.json` records every recording actually used and its SHA-256.
`catalog.json` records delivered clip hashes and the generator's own source hash.
The synthesized resonances, noise layers, friction assembly, timing and envelopes
are original project work created by `client/scripts/build-destruction-audio.mjs`;
they do not depend on another sample library or generation service.

## Rebuild and verify

From the repository root, with Node.js 22+, FFmpeg with libmp3lame, and unzip:

```sh
node client/scripts/build-destruction-audio.mjs --fetch
node client/scripts/verify-destruction-audio.mjs --report
```

The downloader checks both archive hashes before extracting into the operating
system's temporary directory. Source archives are never shipped to players.
Alternatively, pass already extracted folders as two arguments:

```sh
node client/scripts/build-destruction-audio.mjs /path/to/Kenney/Audio /path/to/Breaking
```

The checked build used FFmpeg 7.1.1 and Node.js 22.1.0. Per-clip seeds make source
assembly repeatable. Bit-identical encoded results require the same encoder
build. The script uses temporary PCM files rather than large synchronous pipes
and imposes a 20-second timeout on each FFmpeg process.

## Sound design

- Concrete emphasizes coarse breakage and low body; stone is harder and brighter.
- Metal has narrow, long resonances; sheet metal has a lower hollow rattle.
- Wood has short resonances and recorded fiber-like cracking.
- Glass layers sharp breakage and small, bright fragments.
- Earth uses a soft attack, subdued resonance and granular movement.
- Collapses combine a firm opening, audible low-mid pressure, rock breakage and
  irregular falling fragments. Broad body and smooth compression retain 7–10 dB
  more whole-clip RMS than the first palette without raising their output peaks.
- `heavy-concrete`, `heavy-stone`, `heavy-metal`, `heavy-sheet`, `heavy-wood`,
  and `heavy-earth` add slab/chassis-sized weight behind the varied main impact.
  Most energy is in 80–1000 Hz, so the body survives playback without a subwoofer.
  Glass keeps its existing sharp contact/fracture layers.
- `debris-<material>` provides a separate 6.4-second seamless regional bed for
  each of the seven materials. Dense recorded grains and continuous irregular
  pressure sustain a collapse; the runtime controls its density and lifetime.
- Flybys use a short moving-air envelope with a restrained downward tonal sweep.
- Rifle reports have short, bright muzzle attacks and a small mechanical layer.
  Cannon reports use a broader attack, deeper pressure and longer decaying body.
  These are original synthesis with Foley mechanism layers, not firearm recordings.
- Rolling loops use irregular, slower contact grains and low-frequency motion.
  They remain distinct from the sustained, brighter friction textures.
- Friction uses band-limited noise plus windowed Foley grains and occasional
  contacts. It is a designed approximation, not recorded sustained sliding.

One-shots are 128 kb/s mono MP3. An 8 ms guard prevents MP3 pre-echo from reaching
the buffer edge. Loops are 16-bit PCM WAV to retain continuous boundaries without
codec priming or a repeated fade to silence. A crossfade joins each loop and the
DC filter is warmed through one period before writing it.

Peak and RMS constraints are applied independently. Transients retain their
crest factor; sustained textures do not get impact-level gain. Every sound is
assembled without added reverb; the shared runtime acoustics supplies the
environment response.

## Verification and listening status

`quality-report.json` contains decoded measurements for every shipped clip,
including peak, RMS, crest factor, DC, duration, boundary continuity and checksum.
The heavy-body revision adds calibrated FFT band-energy checks, first-750 ms
active RMS, and 200 ms window RMS floors for sustained debris. Heavy layers are
required to carry audible low-mid energy with restrained sub-bass/treble; glass
debris retains a bright fragment spectrum.
The verifier checks all 100 required IDs, decode success, distinct variation
hashes, no clipped/silent clips, quiet one-shot tails, loop joins, and bounded
file and decoded-memory sizes. Loop joins are compared with the texture's normal
sample-to-sample change, rather than requiring a naturally nonzero waveform to
start at zero.

These are signal-integrity checks. No human or model listening assessment has
been claimed. The final mix should be auditioned in the Sound Lab and actual
city scenes, especially metal ringing, repeated friction, glass brightness, and
large-impact low frequencies. They remain easy to tune in the deterministic
recipe and runtime controls.
