# Palette verification

Verified 2026-09-26 with delivered MP3/PCM decoded through FFmpeg 7.1.1.
Detailed results for every clip are in `quality-report.json`.

| Check | Result |
| --- | --- |
| Required clips | 100 / 100 present and decoded |
| Runtime sound download | 14,492,000 bytes / 13.82 MiB; limit 16 MiB |
| Decoded mono Float32 PCM at 48 kHz | 54,867,072 bytes / 52.33 MiB; limit 64 MiB |
| Largest decoded peak | -1.86 dBFS |
| Whole-clip RMS range | -34.03 to -16.77 dBFS |
| Largest absolute DC offset | 0.0001184 |
| Clipped / silent files | 0 / 0 |
| Repeated variation hashes | 0 |
| One-shot fades / buffer edges | Pass |
| Lossless loop boundary continuity | Pass |
| Rolling spectrally softer than scraping | Pass, all seven materials |
| Rifle/cannon duration and spectrum distinction | Pass, all three variants |
| Heavy-body spectrum and active RMS | Pass, all six materials |
| Sustained debris spectrum and window RMS floors | Pass, all seven materials |

## Heavy-body revision

The earlier bank made large falls too dependent on small, bright contacts and
quiet decaying tails. This revision adds separately controllable weight and
sustained destruction layers; small material impacts retain their original role.

| Layer | Measured level | Measured spectral/body properties |
| --- | --- | --- |
| Six `heavy-<material>` impacts | About -16.96 dBFS full RMS; -12.8 dBFS first 750 ms RMS | 76–80% energy at 80–1000 Hz; 1–3% above 2 kHz; 11–12 dB crest factor |
| Six non-glass `debris-<material>` loops | -16.77 dBFS RMS | 70–74% energy at 80–1000 Hz; continuous 6.4-second regions |
| `debris-glass` loop | -17.77 dBFS RMS | 63% energy above 2 kHz retains bright fragment character |
| Four existing collapse one-shots | -17.85 dBFS RMS | 7.19–10.44 dB more RMS than the earlier bank; peaks -5.42 to -5.80 dBFS |

The quietest 200 ms window across all new debris loops is -21.01 dBFS. They stay
active throughout the loop instead of repeating an impact followed by near
silence. Their output level and lifetime must still follow destruction activity
in the renderer; these are layers, not sounds to run continuously without cause.
No `heavy-glass` layer is supplied: glass uses its existing contact/fracture
sounds plus the material-specific debris bed.

Heavy layers use broad filtered pressure, pitched CC0 material breakage and
contacts, restrained modes and smooth saturation. This increases body without
relying on inaudible sub-bass or simply turning up sharp ringing. The existing
collapse clips were similarly rebalanced. None of these measurements establishes
subjective realism or physical loudness on a particular playback system.

## Checks and iterations

- Verifier first rejected the 13 missing heavy/debris IDs before generation.
- The first heavy pass failed the spectral guard: five layers had about 31%
  energy above 2 kHz. Additional filtering concentrated weight in the low mids.
- Two collapse variations then failed the sustained RMS requirement. Density
  processing after spectral shaping raised body while leaving transient contrast.
- Final decoded tests verify peak headroom, DC, tails, loop joins, band energy,
  active/window RMS, source/output hashes and the 16 MiB/64 MiB budgets.
- Same-encoder regeneration produces identical catalog and delivered clip hashes.

Band energy uses a Hann-windowed 2,048-sample FFT excluding DC. Synthetic 40 Hz,
440 Hz and 4.4 kHz calibration tones must place over 98% of energy in the expected
bands. Rolling/scraping comparison also uses normalized derivative energy as a
regression check, not a perceptual score. Whole-clip RMS includes deliberate
quiet tails; the heavy checks separately measure the first 750 ms.

Earlier verification fixed MP3 buffer-edge discontinuities with an 8 ms guard
and switched continuous loops to lossless PCM with crossfaded joins and warmed
DC filtering. Source archives and used recordings remain checksum-pinned. The
generator uses scratch PCM files and bounded FFmpeg calls to avoid synchronous
pipe hangs on the development host.

## Quick listening review

Keep the same scene/seed and change one control at a time. Compare Small/Heavy
material auditions, then the sustained inside-collapse scene and nearby flybys.
Check ordinary speakers as well as headphones: the new weight should remain
present without a subwoofer. Judge how much sustained debris masks danger,
whether metal still feels metallic without dominating with ringing, and how
quickly the scene recovers after destruction settles.

No new human/model listening assessment or physical surround approval is claimed.
The signal, reproducibility and resource checks pass; artistic balance belongs
in the planned short listening session.
