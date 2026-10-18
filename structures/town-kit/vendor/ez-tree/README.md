# EZ-Tree source adaptation

Source: https://github.com/dgreenheck/ez-tree/tree/dcf309bd86bd521083d9c70f01f2de45fdc7c457

MIT license retained in LICENSE. The offline skeleton and meshing routines are extracted from src/lib/tree.js. Browser material/texture loading and trellis support are removed; branch IDs, parent IDs and leaf ownership are added. Math imports reuse the application Three.js dependency. No network or browser is needed to generate assets. Tree options are supplied by Bayline. Upstream mesh detail sampling is retained.
