# Mac/Metal demo recordings

Headless Chromium (ANGLE on Metal) joins a running server, an automated player
walks, drives and fires through `window.__VIBE_DRIVE__`, and Playwright records
the page. A caption banner shows the server's live `/match-stats` numbers.

```sh
# server running on 127.0.0.1:4001, client dev server on :3003
node client/e2e/mac-demo/trail.mjs target/demo-videos/rec-trail   # heightfield, car, balls
node client/e2e/mac-demo/city.mjs  target/demo-videos/rec-city    # cannonballs, demolition, car
client/e2e/mac-demo/assemble.sh target/demo-videos/rec-trail/*.webm target/demo-videos/rec-city/*.webm
```

`city.mjs` takes a second argument, `destroy` or `car`, to run one half.
The demolition goes through the server's `/city-demolish` debug endpoint.
