/**
 * Reusable Playwright E2E toolkit for vibe-land gameplay testing.
 *
 * All gameplay actions go through real browser input only (click, keyboard, mouse).
 * The bridge (window.__VIBE_E2E__) is used only for reading state and assertions.
 */
import type { Page } from '@playwright/test';
import type { GameE2ESnapshot } from './types';
import { Controls, codeToKey } from './controls';

// ---------------------------------------------------------------------------
// Snapshot helpers (read-only bridge)
// ---------------------------------------------------------------------------

/** Read the current E2E snapshot from the page. */
export async function snapshot(page: Page): Promise<GameE2ESnapshot> {
  return page.evaluate(() => {
    const bridge = (window as any).__VIBE_E2E__;
    if (!bridge) {
      throw new Error('__VIBE_E2E__ bridge not found. Is the game loaded?');
    }
    return bridge.snapshot();
  });
}

/**
 * Wait until the snapshot satisfies a predicate, polling at ~200ms intervals.
 * Returns the matching snapshot.
 */
export async function waitForSnapshot(
  page: Page,
  predicate: (s: GameE2ESnapshot) => boolean,
  options?: { timeout?: number; pollInterval?: number; label?: string },
): Promise<GameE2ESnapshot> {
  const timeout = options?.timeout ?? 30_000;
  const pollInterval = options?.pollInterval ?? 200;
  const label = options?.label ?? 'waitForSnapshot';
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    try {
      const s = await snapshot(page);
      if (predicate(s)) return s;
    } catch {
      // Bridge may not be ready yet — keep polling
    }
    await page.waitForTimeout(pollInterval);
  }
  // One last attempt to produce a useful error
  const lastSnap = await snapshot(page).catch(() => null);
  throw new Error(
    `${label}: timed out after ${timeout}ms. Last snapshot: ${JSON.stringify(lastSnap, null, 2)}`,
  );
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

/** Open /practice and wait for the page to load. */
export async function openPractice(page: Page): Promise<void> {
  // Pre-seed localStorage to dismiss the first-run calibration prompt so it
  // doesn't appear over the canvas and block pointer-lock acquisition.
  await page.addInitScript(() => {
    try {
      const key = 'vibe-land/input-settings';
      const raw = localStorage.getItem(key);
      const settings: Record<string, unknown> = raw ? JSON.parse(raw) : {};
      if (!settings.meta || typeof settings.meta !== 'object') {
        settings.meta = {};
      }
      (settings.meta as Record<string, unknown>).firstRunPromptDismissed = true;
      localStorage.setItem(key, JSON.stringify(settings));
    } catch {
      // ignore — best-effort
    }
  });
  await page.goto('/practice', { waitUntil: 'domcontentloaded' });
  // Wait for the E2E bridge to become available
  await page.waitForFunction(() => !!(window as any).__VIBE_E2E__, { timeout: 30_000 });
}

/** Open /play with a specific match ID and wait for the page to load. */
export async function openPlay(page: Page, matchId: string): Promise<void> {
  await page.goto(`/play?match=${encodeURIComponent(matchId)}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(() => !!(window as any).__VIBE_E2E__, { timeout: 30_000 });
}

// ---------------------------------------------------------------------------
// Join / connect
// ---------------------------------------------------------------------------

/** Click the join overlay to connect. Waits for a non-zero playerId. */
export async function join(page: Page, options?: { timeout?: number }): Promise<GameE2ESnapshot> {
  const timeout = options?.timeout ?? 30_000;
  // Click the join overlay
  const overlay = page.locator('[data-testid="join-overlay"]');
  if (await overlay.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await overlay.click();
  } else {
    // Fallback: click the center of the page
    const viewport = page.viewportSize() ?? { width: 800, height: 600 };
    await page.mouse.click(viewport.width / 2, viewport.height / 2);
  }

  // Wait for connection to complete (playerId > 0)
  return waitForSnapshot(page, (s) => s.playerId > 0 || s.mode === 'practice', {
    timeout,
    label: 'join',
  });
}

// ---------------------------------------------------------------------------
// Pointer lock
// ---------------------------------------------------------------------------

/**
 * Acquire pointer lock by clicking the game canvas.
 * In headless Chromium, real pointer lock may not be granted; falls back to
 * patching document.pointerLockElement so the input handler accepts events.
 */
export async function acquirePointerLock(page: Page): Promise<void> {
  // Click the canvas to trigger requestPointerLock
  const canvas = page.locator('canvas').first();
  await canvas.click();
  await page.waitForTimeout(300);

  // Check if real pointer lock was granted
  const locked = await page.evaluate(() => document.pointerLockElement != null);
  if (locked) return;

  // Headless fallback: patch document.pointerLockElement so the game's input
  // handler (which guards on pointerLockElement != null) accepts mousemove events.
  await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    Object.defineProperty(document, 'pointerLockElement', {
      get: () => canvas,
      configurable: true,
    });
  });
}

// ---------------------------------------------------------------------------
// Debug overlay
// ---------------------------------------------------------------------------

/** Toggle the debug overlay with F3. */
export async function toggleDebugOverlay(page: Page): Promise<void> {
  await page.keyboard.press(codeToKey(Controls.debugOverlayToggle));
  await page.waitForTimeout(150);
}

// ---------------------------------------------------------------------------
// Movement (real keyboard input)
// ---------------------------------------------------------------------------

/**
 * Hold a movement key for a given duration.
 * Uses real keydown/keyup events.
 */
export async function holdMove(
  page: Page,
  direction: 'forward' | 'backward' | 'left' | 'right',
  durationMs: number,
): Promise<void> {
  const codeMap: Record<string, string> = {
    forward: Controls.moveForward,
    backward: Controls.moveBackward,
    left: Controls.moveLeft,
    right: Controls.moveRight,
  };
  const key = codeToKey(codeMap[direction]);
  await page.keyboard.down(key);
  await page.waitForTimeout(durationMs);
  await page.keyboard.up(key);
}

/** Press jump using the real jump key. */
export async function jump(page: Page): Promise<void> {
  await page.keyboard.press(codeToKey(Controls.jump));
}

// ---------------------------------------------------------------------------
// Look / aim (real mouse input via dispatchEvent for movementX/Y)
// ---------------------------------------------------------------------------

/**
 * Simulate a mouse look delta.
 * Because Playwright cannot produce real movementX/Y through pointer lock,
 * we dispatch synthetic mousemove events with movementX/Y set.
 */
export async function lookDelta(page: Page, dx: number, dy: number): Promise<void> {
  await page.evaluate(
    ([deltaX, deltaY]) => {
      const event = new MouseEvent('mousemove', {
        movementX: deltaX,
        movementY: deltaY,
        bubbles: true,
      });
      document.dispatchEvent(event);
    },
    [dx, dy] as [number, number],
  );
  await page.waitForTimeout(50);
}

// ---------------------------------------------------------------------------
// Shooting (real mouse input)
// ---------------------------------------------------------------------------

/** Fire a single shot using a mouse click. */
export async function shootOnce(page: Page): Promise<void> {
  await page.mouse.down({ button: 'left' });
  await page.waitForTimeout(50);
  await page.mouse.up({ button: 'left' });
  await page.waitForTimeout(120); // Allow fire cooldown
}

/** Fire a burst of shots using mouse hold. */
export async function shootBurst(page: Page, count: number = 3): Promise<void> {
  await page.mouse.down({ button: 'left' });
  // Each shot ~100ms interval (LOCAL_RIFLE_INTERVAL_MS)
  await page.waitForTimeout(count * 110);
  await page.mouse.up({ button: 'left' });
  await page.waitForTimeout(100);
}

// ---------------------------------------------------------------------------
// Vehicle interaction (real keyboard input)
// ---------------------------------------------------------------------------

/** Press the interact key to enter the nearest vehicle. */
export async function enterNearestVehicle(page: Page): Promise<GameE2ESnapshot> {
  await page.keyboard.press(codeToKey(Controls.interact));
  return waitForSnapshot(page, (s) => s.inVehicle, {
    timeout: 5_000,
    label: 'enterNearestVehicle',
  });
}

/** Drive forward using the forward key for a given duration. */
export async function driveForward(page: Page, durationMs: number): Promise<void> {
  await holdMove(page, 'forward', durationMs);
}

/** Press the interact key to exit the current vehicle. */
export async function exitVehicle(page: Page): Promise<GameE2ESnapshot> {
  await page.keyboard.press(codeToKey(Controls.interact));
  return waitForSnapshot(page, (s) => !s.inVehicle, {
    timeout: 5_000,
    label: 'exitVehicle',
  });
}
