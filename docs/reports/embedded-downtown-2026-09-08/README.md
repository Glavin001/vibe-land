# Playable embedded downtown

The deployed demo now uses the original fractured downtown asset: **27 connected building groups, 24,105 chunks and 74,543 bonds**, with low-rise buildings, towers up to approximately 85 metres, authored mixed geometry and streets. No scene material, fracture or physics parameter was altered for this expansion.

[Open the live city](https://209.121.195.117:40617/city?portal=true&match=city-default). Reload after the scene change.

The 108-group / 96,420-chunk / 298,172-bond four-district variant also passed the browser checks. It was not retained as the default because its server ticks were already about 50–60 ms outside major destruction during this browser session. The single district is still a substantial expansion from the previous 444-chunk / 896-bond building. Impact pauses remain in both sizes; neither is a certified 60 Hz workload.

## Checks actually run

Both city sizes passed browser join, physical projectile shooting (four 750 ms trigger holds), native fracture correction, player movement, render ownership consistency, 30 one-second settling observations, and reset. The single district finished with zero awake fragment bodies and eleven sleeping fragment bodies; reset restored zero broken bonds and zero fragment groups. I inspected the settled screenshots.

Direct GPU API is disabled, native sleeping enabled, artificial freezing disabled, and each tick permits at most one correction / two stress evaluations. The deployed runtime retains the qualified 45ae3488 behavior. The structured inverse experiment is not deployed.

The browser uses local WebTransport host/port routing while preserving `/game`; this is not an independent external-client connectivity test. The user separately confirmed that the public demo worked. Known missing-resource/COEP console errors remain and are retained in the artifacts. Software-rendered headless browser FPS does not measure the player's GPU rendering speed.

[Machine-readable receipt](receipt.json) includes the counts, runtime/asset hashes, errors and rolling server timing summaries. Those summaries are browser-session observations, not isolated complete-step performance qualification; the raw rolling tick window is retained inside each compressed result.

## Reproduce

```bash
bash scripts/run-embedded-city.sh
cd client
E2E_EMBEDDED_ASSET=../destruction/assets/scenes/fractured-downtown.json \
E2E_EMBEDDED_GRID=1 E2E_EMBEDDED_HOLD_MS=750 \
E2E_EMBEDDED_OUTPUT=/tmp/fresh-downtown-browser node e2e/embedded-playable.mjs
```

`VIBE_CITY_GRID=2` selects the larger four-district variant. Use `VIBE_CITY_SCENE=embedded-penetration.json VIBE_CITY_GRID=1` to reproduce the original single-building demo. The launcher does not stop existing services; restart only the owned server after verifying it is safe.
