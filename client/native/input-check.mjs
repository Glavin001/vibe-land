// Real player input in the native app (scripts/native-mac.sh input): the
// keyboard and mouse events mystral delivers from SDL, injected through its
// own dispatcher (__mystralDispatchEvent), the same path a key press or a
// mouse move takes. The QA and capture scripts drive the player through the
// scripted bridge (window.__VIBE_DRIVE__), which never touches this path.
//
//   click     a left click on the canvas (captures the pointer)
//   look      mouse movement turns the camera
//   move      holding W walks the player
//
// Prints one PASS/FAIL line per check and a VERDICT.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (text) => console.log(`[input] ${text}`);

async function waitFor(what, predicate, timeoutMs = 120_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = predicate();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const noop = () => {};
/** As mystral's dispatchKeyboardEvent: document, window, then canvas. */
function key(type, code, keyName) {
  const event = { type, key: keyName, code, keyCode: keyName.toUpperCase().charCodeAt(0), repeat: false,
    ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, preventDefault: noop, stopPropagation: noop };
  for (const target of ['document', 'window', 'canvas']) __mystralDispatchEvent(target, type, event);
}
/** As mystral's dispatchMouseEvent. */
function mouse(type, { button = 0, buttons = 0, movementX = 0, movementY = 0, x = 800, y = 450 } = {}) {
  const event = { type, clientX: x, clientY: y, pageX: x, pageY: y, offsetX: x, offsetY: y, movementX, movementY,
    button, buttons, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false,
    target: globalThis.canvas, preventDefault: noop, stopPropagation: noop };
  for (const target of ['document', 'window', 'canvas']) __mystralDispatchEvent(target, type, event);
}

async function run() {
  const source = await (await fetch('file://./game-iife.js')).text();
  (0, eval)(source);
  const e2e = await waitFor('the test bridge', () => globalThis.__VIBE_E2E__);
  await waitFor('the city', () => (e2e.snapshot()?.city?.chunksTotal ?? 0) > 0);
  await waitFor('the shader warmup', () => e2e.shaderBuilds().playing, 90_000);
  // The player is placed by its first snapshots (the native shell has no App
  // to publish a player id): settle on the spawn first.
  await sleep(2500);
  const results = [];
  const record = (name, pass, detail) => {
    results.push(pass);
    log(`${pass ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
  };

  // click: as a player starts, a click on the window.
  mouse('mousedown', { buttons: 1 });
  mouse('pointerdown', { buttons: 1 });
  await sleep(50);
  mouse('mouseup');
  mouse('pointerup');
  await sleep(300);
  const locked = globalThis.document?.pointerLockElement != null;
  log(`pointer captured: ${locked}`);

  // look: relative mouse motion (a captured pointer); dragging if not captured.
  const before = e2e.snapshot();
  for (let i = 0; i < 20; i += 1) {
    mouse('mousemove', { movementX: 15, movementY: 4, buttons: locked ? 0 : 1 });
    await sleep(16);
  }
  await sleep(300);
  const afterLook = e2e.snapshot();
  const turned = Math.abs(afterLook.cameraYaw - before.cameraYaw) + Math.abs(afterLook.cameraPitch - before.cameraPitch);
  record('look', turned > 0.05, `camera yaw ${before.cameraYaw.toFixed(3)} -> ${afterLook.cameraYaw.toFixed(3)}, pitch ${before.cameraPitch.toFixed(3)} -> ${afterLook.cameraPitch.toFixed(3)}`);

  // move: hold W for two seconds.
  const from = e2e.snapshot().position;
  key('keydown', 'KeyW', 'w');
  for (let i = 0; i < 20; i += 1) await sleep(100);
  key('keyup', 'KeyW', 'w');
  await sleep(500);
  const to = e2e.snapshot().position;
  const moved = Math.hypot(to[0] - from[0], to[2] - from[2]);
  record('move', moved > 2, `${moved.toFixed(2)} m holding W for 2 s (from ${from.map((v) => v.toFixed(1))} to ${to.map((v) => v.toFixed(1))})`);

  const passed = results.filter(Boolean).length;
  log(`${passed}/${results.length} checks passed`);
  log(`VERDICT ${passed === results.length ? 'PASS' : 'FAIL'}`);
  setTimeout(() => process.exit(0), 300);
}

run().catch((error) => {
  log(`FAIL  harness: ${error?.stack ?? error}`);
  log('VERDICT FAIL');
  setTimeout(() => process.exit(1), 300);
});
