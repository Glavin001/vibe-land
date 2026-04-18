# Credits & Attributions

vibe-land incorporates third-party assets and code. This file tracks
licenses and attribution requirements.

## Upstream Code: Kinema (MIT)

Portions of `client/src/feedback/`, `client/src/audio/`,
`client/src/scene/renderer/`, `client/src/interaction/`, and the
Playwright test harness derive from or are inspired by
[Kinema](https://github.com/2600th/Kinema) by Pranshul Chandhok,
licensed under the MIT License:

```
MIT License

Copyright (c) 2026 Pranshul Chandhok

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Assets

### HDR Environments — `client/public/assets/env/*.hdr`
Six 1K HDRI maps from [Poly Haven](https://polyhaven.com) —
CC0 1.0 Universal (Public Domain).
- `blouberg_sunrise_2_1k.hdr`
- `kloofendal_48d_partly_cloudy_1k.hdr`
- `moonless_golf_1k.hdr`
- `royal_esplanade_1k.hdr`
- `studio_small_09_1k.hdr`
- `venice_sunset_1k.hdr`

### Color Grading LUTs — `client/public/assets/postfx/`
- `Bourbon 64.CUBE`, `Chemical 168.CUBE`, `Clayton 33.CUBE`,
  `Cubicle 99.CUBE`, `Remy 24.CUBE` — courtesy of
  [RocketStock](https://www.rocketstock.com/free-after-effects-templates/35-free-luts-for-color-grading-videos/)
  (free for commercial use per RocketStock terms).
- `Presetpro-Cinematic.3dl` — from
  [Presetpro](https://www.presetpro.com/freebies/) free LUT collection.
- `lut.3dl`, `lut_v2.3dl` — generic neutral LUT variants.
- `NeutralLUT.png`, `NightLUT.png`, `B&WLUT.png` — generated
  identity/tone-mapped LUT textures.

### Smoke Sprites — `client/public/assets/sprites/`
`smoke_black.png`, `smoke_white.png` from the
[Kenney Smoke Particle Pack](https://kenney.nl/assets/smoke-particles)
by Kenney Vleugels (www.kenney.nl) — CC0 1.0 Universal (Public Domain).
License text preserved at `client/public/assets/sprites/kenney_smoke_license.txt`.

### Cloud Lightning VFX — `client/public/assets/models/cloud_lightning.glb`
Model **"cloud_lightning"** by **Kyyy_24**, downloaded from Sketchfab.
Licensed under **CC BY 4.0** — https://creativecommons.org/licenses/by/4.0/ .
Attribution required: "Cloud Lightning" by Kyyy_24,
licensed under CC BY 4.0.

### Animation Libraries — `client/public/assets/models/animations/`
- `UAL1_Standard.glb` — Universal Animation Library [Standard] by
  [Quaternius](https://quaternius.com) — CC0 1.0 Universal.
- `UAL2_Standard.glb` — Universal Animation Library 2 [Standard] by
  Quaternius — CC0 1.0 Universal.

License texts preserved at
`client/public/assets/models/animations/UAL{1,2}_License.txt`.

## Runtime Dependencies

New dependencies introduced alongside the extraction:
- [`tone`](https://tonejs.github.io) — MIT — audio stack.
- [`postprocessing`](https://github.com/pmndrs/postprocessing) — Zlib —
  LUT / bloom / tonemapping passes.
- [`@playwright/test`](https://playwright.dev) — Apache-2.0 — smoke tests.
