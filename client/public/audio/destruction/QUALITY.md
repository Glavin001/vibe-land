# Palette verification

Verified 2026-09-26 with the delivered compressed/PCM files decoded through
FFmpeg 7.1.1. Detailed per-file results are in `quality-report.json`.

| Check | Result |
| --- | --- |
| Required clips | 87 / 87 present and decoded |
| Runtime sound download | 9,971,510 bytes / 9.51 MiB; limit 10 MiB |
| Decoded mono Float32 PCM | 43,712,640 bytes / 41.69 MiB; limit 64 MiB |
| Largest decoded peak | -1.86 dBFS |
| Whole-clip RMS range | -34.03 to -21.52 dBFS |
| Crest factor range | 10.45 to 31.24 dB |
| Largest absolute DC offset | 0.0001184 |
| Clipped / silent files | 0 / 0 |
| Repeated variation hashes | 0 |
| One-shot end fades / buffer edges | Pass |
| Lossless loop boundary continuity | Pass |
| Rolling is spectrally softer than scraping | Pass, all seven materials |
| Rifle vs cannon duration and spectrum | Pass, all three variants |

RMS includes deliberate quiet tails. It is not a target for loudness matching
between short hits and continuous textures. A short contact can have low average
energy and still retain a clear attack; voice gain is controlled by the runtime.
The spectral comparison uses normalized sample-to-sample derivative energy,
which is a regression guard, not a perceptual brightness score.

## Iterations completed

1. The initial verifier failed on the missing catalog, confirming the expected
   bank was required before it could pass.
2. Decoded MP3 measurements exposed small edge discontinuities. One-shots gained
   an 8 ms guard; continuous loops moved to lossless PCM with periodic filtering
   and crossfaded joins. This removed the codec edge issue without loop fade dips.
3. Added specifically recorded CC0 glass, wood and rock breakage to the initial
   Foley/procedural palette. Source archives and every used recording are hashed.
4. Extended the bank with dedicated rifle/cannon reports and rolling textures.
   The verifier first rejected the 13 missing IDs, then passed the expanded bank.
5. Rebuilt with the same recipe and encoder to compare the complete catalog and
   clip hashes for deterministic output.

The creation process uses bounded subprocess calls and scratch PCM files; this
avoids the synchronous FFmpeg input-pipe hangs observed on the development host.

## Efficient listening review

Use the Sound Lab's fixed seed/scenario and change one control at a time. Start
with balanced dynamics, headphones, and moderate volume. A useful order is:

1. Compare material impacts, then fractures; confirm wood/glass/metal identity.
2. Compare roll and scrape for the same material; assess looping and fatigue.
3. Compare rifle and cannon; check that quick repeated reports remain readable.
4. Run the nearby collapse and near miss; check threat detail through the low end.
5. Repeat at night dynamics and on small speakers; verify weight survives.

No listening or physical surround-hardware approval has been claimed. The tests
verify signal integrity, reproducibility and resource limits; artistic balance
still benefits from the planned short listening session.
