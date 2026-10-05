// Real player input in the native app (scripts/native-mac.sh input): the
// keyboard and mouse events mystral delivers from SDL, injected through its
// own dispatcher (__mystralDispatchEvent), the same path a key press or a
// mouse move takes. The QA and capture scripts drive the player through the
// scripted bridge (window.__VIBE_DRIVE__), which never touches this path.
//
//   click     a left click on the canvas (captures the pointer)
//   look      mouse movement turns the camera
//   move      holding W walks the player
//   escape    Escape releases the pointer, held Escape (key repeat) too, and
//             leaving with Cmd+Tab does not capture it again
//   recapture after Escape, a click captures the pointer again
//   weapon    2 picks the cannon, the scroll wheel steps to the meteor and
//             back, 1 picks the rifle
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
function key(type, code, keyName, modifiers = {}) {
  const event = { type, key: keyName, code, keyCode: keyName.toUpperCase().charCodeAt(0), repeat: false,
    ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...modifiers, preventDefault: noop, stopPropagation: noop };
  for (const target of ['document', 'window', 'canvas']) __mystralDispatchEvent(target, type, event);
}
/** As mystral's dispatchWheelEvent: one notch is 120 px. */
function wheel(deltaY) {
  const event = { type: 'wheel', deltaX: 0, deltaY, deltaZ: 0, deltaMode: 0, clientX: 800, clientY: 450,
    ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, preventDefault: noop, stopPropagation: noop };
  for (const target of ['document', 'window', 'canvas']) __mystralDispatchEvent(target, 'wheel', event);
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

  // escape: release, a held Escape's repeats, then Cmd+Tab to leave the app.
  const isLocked = () => globalThis.document?.pointerLockElement != null;
  // Who takes or releases the pointer around Escape (diagnostics on failure).
  const calls = [];
  const lockTarget = globalThis.canvas;
  const request = lockTarget.requestPointerLock;
  lockTarget.requestPointerLock = function (...args) { calls.push(`request\n${new Error().stack?.split('\n').slice(2, 5).join('\n')}`); return request.apply(this, args); };
  const exit = document.exitPointerLock;
  document.exitPointerLock = function (...args) { calls.push('exit'); return exit.apply(this, args); };
  key('keydown', 'Escape', 'Escape');
  for (let i = 0; i < 3; i += 1) key('keydown', 'Escape', 'Escape', { repeat: true });
  key('keyup', 'Escape', 'Escape');
  await sleep(100);
  const afterEscape = isLocked();
  key('keydown', 'MetaLeft', 'Meta', { metaKey: true });
  key('keydown', 'Tab', 'Tab', { metaKey: true });
  key('keyup', 'Tab', 'Tab', { metaKey: true });
  key('keyup', 'MetaLeft', 'Meta');
  await sleep(100);
  const afterCmdTab = isLocked();
  record('escape', !afterEscape && !afterCmdTab, `pointer captured after Escape: ${afterEscape}, after Cmd+Tab: ${afterCmdTab}`);
  if (afterEscape || afterCmdTab) log(`pointer calls: ${calls.join(' | ') || 'none'}`);
  lockTarget.requestPointerLock = request;
  document.exitPointerLock = exit;

  // recapture: a click on the window takes the pointer back.
  mouse('mousedown', { buttons: 1 });
  mouse('pointerdown', { buttons: 1 });
  mouse('mouseup');
  mouse('pointerup');
  await sleep(100);
  record('recapture', isLocked(), `pointer captured after a click: ${isLocked()}`);

  // weapon: keys pick, the wheel steps (down = next), as in Call of Duty.
  const seen = [];
  const press = async (code, name) => { key('keydown', code, name); await sleep(80); key('keyup', code, name); await sleep(120); seen.push(e2e.shotMode()); };
  const scroll = async (deltaY) => { wheel(deltaY); await sleep(220); seen.push(e2e.shotMode()); };
  await press('Digit2', '2');
  await scroll(120);
  await scroll(-120);
  await press('Digit1', '1');
  await press('Digit3', '3');
  const want = ['cannonball', 'meteor', 'cannonball', 'rifle', 'meteor'];
  record('weapon', seen.join(',') === want.join(','), `2, wheel down, wheel up, 1, 3 -> ${seen.join(', ')} (want ${want.join(', ')})`);

  // A frame for the eye: the HUD (crosshair, FPS panel, weapon) as the player sees it.
  if (typeof __mystralSaveScreenshot === 'function') {
    await sleep(600);
    log(`screenshot ${__mystralSaveScreenshot('../../target/native-input.png') ? 'saved' : 'failed'}: target/native-input.png`);
  }

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
